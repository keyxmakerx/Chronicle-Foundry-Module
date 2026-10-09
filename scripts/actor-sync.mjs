/**
 * Chronicle Sync - Actor/Character Sync
 *
 * Bidirectional sync between Chronicle character entities and Foundry Actors.
 * Only active when a matching game system is detected (F-3) and the
 * syncCharacters setting is enabled.
 *
 * Sync flow:
 * - Chronicle → Foundry: Entity changes arrive via WebSocket, create/update Actor.
 * - Foundry → Chronicle: Actor changes detected via Hooks, push to Chronicle API.
 *
 * System-specific field mapping is delegated to adapter modules. The adapter's
 * actorType property (e.g., "character" for D&D 5e, "hero" for Draw Steel)
 * determines which Foundry actor type to sync.
 */

import { getSetting, getUserMappings } from './settings.mjs';
import { ConflictError } from './api-client.mjs';
import { createGenericAdapter } from './adapters/generic-adapter.mjs';
import { FLAG_SCOPE, SYNC_OPTIONS, APPLY_OPTION } from './constants.mjs';
import { planClaimOwnership } from './_claim-ownership-plan.mjs';
import { queueRemoteDelete } from './_remote-deletes.mjs';
import { walkEntityPages, unwrapEntityList } from './_entity-page-walk.mjs';
import { JournalPushDebouncer } from './_journal-push-debounce.mjs';
import { mergeChanges } from './_actor-field-diff.mjs';
import { collapseChanges } from './_change-feed.mjs';
import { planActorApply } from './_actor-apply-plan.mjs';
import { planIdentityItems } from './_identity-item-plan.mjs';
import { applyIdentityPlan } from './_identity-item-apply.mjs';

/**
 * ActorSync handles character entity ↔ Actor synchronization.
 */
export class ActorSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;

    /** @type {import('./sync-manager.mjs').SyncManager|null} */
    this._syncManager = null;

    /** @type {boolean} Suppress hook processing during sync-initiated changes. */
    this._syncing = false;
    /** Chronicle claimants already reported as having no Foundry user, so the GM hears once a session. */
    this._unmappedNoticed = new Set();

    /**
     * Tracks Foundry-originated creates whose POST is in flight.
     * Maps actor.id → actor.name. Used to suppress the WS-driven
     * `_onCharacterCreated` from spawning a duplicate Foundry actor when
     * `entity.created` arrives before our POST returns.
     * @type {Map<string, string>}
     */
    this._inFlightCreates = new Map();

    /** @type {object|null} Loaded system adapter module. */
    this._adapter = null;

    /** @type {number|null} Cached Chronicle entity type ID for characters. */
    this._characterTypeId = null;

    /** @type {number|null} Cached "Player Characters" sub-type ID (child of character type). Null when addon off or sub-type not found. */
    this._pcSubtypeId = null;

    // Foundry -> Chronicle actor pushes are debounced per actor: a burst of
    // edits (a slider drag, an HP tick) is one request, not one per update,
    // against the API key's per-minute limit. The changes of the burst are
    // merged so the push knows every field it touched.
    /** @type {Map<string, object>} Merged update diffs awaiting a push. */
    this._pendingChanges = new Map();
    this._actorPushDebouncer = new JournalPushDebouncer(
      (actor, entityId) => { this._pushActorUpdate(actor, entityId); }
    );
    this._onBeforeUnload = () => this._actorPushDebouncer.flushAll();

    // Bound hook handlers for cleanup.
    this._onCreateActor = this._handleCreateActor.bind(this);
    this._onUpdateActor = this._handleUpdateActor.bind(this);
    this._onDeleteActor = this._handleDeleteActor.bind(this);
  }

  /**
   * Returns the Foundry actor type this sync handles (from the adapter).
   * Defaults to "character" if no adapter is loaded.
   * @returns {string}
   */
  get _actorType() {
    return this._adapter?.actorType || 'character';
  }

  /**
   * Initialize the actor sync module.
   * Loads the appropriate system adapter and registers hooks.
   * @param {import('./api-client.mjs').ChronicleAPI} api
   */
  async init(api) {
    this._api = api;

    if (!getSetting('syncCharacters')) {
      console.debug('Chronicle: Character sync disabled in settings');
      return;
    }

    // Load the system adapter based on matched system.
    this._adapter = await this._loadAdapter();
    if (!this._adapter) {
      console.debug('Chronicle: No system adapter available, character sync inactive');
      return;
    }

    // Resolve the character entity type ID from Chronicle.
    await this._resolveCharacterTypeId();

    // Register Foundry hooks for Actor changes (character type only).
    Hooks.on('createActor', this._onCreateActor);
    Hooks.on('updateActor', this._onUpdateActor);
    Hooks.on('deleteActor', this._onDeleteActor);
    globalThis.window?.addEventListener?.('beforeunload', this._onBeforeUnload);

    console.debug(`Chronicle: Actor sync initialized (adapter: ${this._adapter.systemId}, actorType: ${this._actorType})`);
  }

  /**
   * Handle incoming WebSocket messages for character entity events.
   * Filters to only process entities matching the character type.
   * @param {object} msg
   */
  async onMessage(msg) {
    if (!this._adapter || !getSetting('syncCharacters')) return;

    // Only handle entity events.
    if (!msg.type?.startsWith('entity.')) return;

    const entity = msg.payload;
    if (!entity) return;

    // Filter: only process character-type entities.
    if (!this._isCharacterEntity(entity)) return;

    switch (msg.type) {
      case 'entity.created':
        await this._onCharacterCreated(entity);
        break;
      case 'entity.updated':
        await this._onCharacterUpdated(entity);
        break;
      case 'entity.deleted':
        await this._onCharacterDeleted(entity);
        break;
    }
  }

  /**
   * Handle a sync mapping received during initial sync.
   * @param {object} mapping
   */
  async onSyncMapping(mapping) {
    if (mapping.chronicle_type !== 'entity') return;
    if (!this._adapter || !getSetting('syncCharacters')) return;

    // 1. Happy path: the mapping's stored external_id matches a current
    //    Foundry actor.
    let actor = game.actors.get(mapping.external_id);

    // 2. Fallback: find by `entityId` flag. Catches the
    //    "already synced but re-imported / migrated" case where the
    //    mapping's external_id is stale (points at a dead Foundry id)
    //    but the local actor still carries the correct entityId.
    //    Without this, the handler would fall through to a duplicate
    //    Actor.create and a 400 mapping conflict.
    if (!actor) {
      actor = game.actors.find(
        (a) => a.getFlag(FLAG_SCOPE, 'entityId') === mapping.chronicle_id
      );
    }

    if (actor) return; // Either path found it → nothing to do.

    try {
      const entity = await this._api.get(`/entities/${mapping.chronicle_id}`);
      if (entity && this._isCharacterEntity(entity)) {
        await this._onCharacterCreated(entity);
      }
    } catch (err) {
      console.warn('Chronicle: Failed to sync actor mapping', err);
    }
  }

  /** Change-feed area this module reads at connect (see SyncManager). */
  get feedArea() { return 'actors'; }

  /** Characters use the feed only while character sync is actually running. */
  feedActive() { return !!(getSetting('syncCharacters') && this._adapter && this._characterTypeId); }

  /**
   * Connect-time catch-up for linked actors. With the change feed only the
   * characters Chronicle says changed are refetched; without it every
   * character is listed. Either way an actor already at the entity's version
   * is left alone, and no actor is created here (live creates and the import
   * wizard do that). Throws when anything failed, so the feed cursor is not
   * advanced past it.
   *
   * @param {{feed?: {mode: 'delta', changes: object[]}|{mode: 'full'}}} [opts]
   */
  async onInitialSync({ feed } = {}) {
    if (!this._adapter || !getSetting('syncCharacters')) return;
    if (!this._characterTypeId) return;

    let errors = 0;
    if (feed?.mode === 'delta') {
      errors = await this._catchUpFromFeed(feed.changes);
    } else {
      // Pull the parent character type and (when resolved) the PC sub-type so
      // existing actor–entity links are refreshed regardless of which Chronicle
      // type the entity lives under.
      const typeIds = [this._characterTypeId];
      if (this._pcSubtypeId) typeIds.push(this._pcSubtypeId);

      const allEntities = [];
      for (const typeId of typeIds) {
        allEntities.push(...(await this._walkTypeEntities(typeId)));
      }

      for (const entity of allEntities) {
        const existingActor = this._findLinkedActor(entity.id);
        if (!existingActor || this._atVersion(existingActor, entity)) continue;
        if (!(await this._updateActorFromEntity(existingActor, entity))) errors++;
      }
    }

    await this._reconcileClaimOwnership();

    // Surface unresolved character links (broken / missing) so the GM can
    // fix them in the dashboard's Issues tab rather than silently desyncing.
    try {
      await this._notifySyncIssues({ quick: feed?.mode === 'delta' });
    } catch (err) {
      console.warn('Chronicle: could not check character links', err);
    }
    if (errors > 0) throw new Error(`actor catch-up: ${errors} character(s) failed`);
  }

  /**
   * Apply the characters the change feed lists to their linked actors.
   * A removed character unlinks its actor (the actor is kept).
   * @param {object[]} changes
   * @returns {Promise<number>} how many failed
   * @private
   */
  async _catchUpFromFeed(changes) {
    let errors = 0;
    for (const [entityId, op] of collapseChanges(changes, 'entity')) {
      const actor = this._findLinkedActor(entityId);
      if (!actor) continue;
      if (op === 'deleted') {
        await this._onCharacterDeleted({ id: entityId });
        continue;
      }
      let entity;
      try {
        entity = await this._api.get(`/entities/${entityId}`);
      } catch (err) {
        if ((err?.status ?? err?.statusCode) === 404) {
          await this._onCharacterDeleted({ id: entityId });
        } else {
          errors++;
          console.warn(`Chronicle: catch-up failed for character ${entityId}`, err);
        }
        continue;
      }
      if (!entity || !this._isCharacterEntity(entity) || this._atVersion(actor, entity)) continue;
      if (!(await this._updateActorFromEntity(actor, entity))) errors++;
    }
    return errors;
  }

  /**
   * Give the Foundry user mapped to a character's Chronicle owner OWNER on
   * the actor. Runs inside the caller's `_syncing` guard on the GM's client
   * only; the write carries the sync options so no hook reports it back. It
   * only ever adds access (see `planClaimOwnership`), and never throws.
   * @param {Actor} actor
   * @param {string|null} ownerId - Chronicle's owner_user_id now.
   * @param {string|null} previousOwnerId - the owner this client last applied.
   * @private
   */
  async _applyClaimOwnership(actor, ownerId, previousOwnerId) {
    if (!game.user?.isGM || !ownerId) return;
    try {
      const users = game.users?.contents ?? Array.from(game.users ?? []);
      const plan = planClaimOwnership({
        ownership: actor.ownership ?? {},
        chronicleOwnerId: ownerId,
        previousOwnerId,
        mappings: getUserMappings(),
        foundryUserIds: users.map((u) => u.id),
        gmUserIds: users.filter((u) => u.isGM).map((u) => u.id),
        ownerLevel: CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3,
      });
      if (plan.grantUserId) {
        await actor.update(
          { ownership: { [plan.grantUserId]: CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3 } },
          { ...SYNC_OPTIONS, [APPLY_OPTION]: true }
        );
      }
      for (const staleId of plan.staleOwnerUserIds) {
        ui.notifications?.warn(game.i18n.format('CHRONICLE.ActorSync.PreviousOwnerKept', {
          actor: actor.name,
          player: game.users?.get?.(staleId)?.name ?? staleId,
        }));
      }
      if (plan.unmapped && !this._unmappedNoticed.has(ownerId)) {
        this._unmappedNoticed.add(ownerId);
        ui.notifications?.warn(game.i18n.format('CHRONICLE.ActorSync.ClaimantUnmapped', { actor: actor.name }));
      }
    } catch (err) {
      console.error(`Chronicle: could not apply the owner of "${actor.name}"`, err);
    }
  }

  /**
   * Honour the claims already cached on linked actors (flag), so a claim made
   * before this client first ran, or while it was closed, takes effect once.
   * Idempotent: a user who already has OWNER is left alone.
   * @private
   */
  async _reconcileClaimOwnership() {
    if (!game.user?.isGM) return;
    for (const actor of game.actors?.contents ?? []) {
      if (actor.type !== this._actorType || !actor.getFlag(FLAG_SCOPE, 'entityId')) continue;
      const owner = actor.getFlag(FLAG_SCOPE, 'chronicleOwnerUserId') ?? null;
      if (!owner) continue;
      this._syncing = true;
      try { await this._applyClaimOwnership(actor, owner, owner); }
      finally { this._syncing = false; }
    }
  }

  /** The actor linked to a Chronicle entity, or undefined. @private */
  _findLinkedActor(entityId) {
    return game.actors.find((a) => a.getFlag(FLAG_SCOPE, 'entityId') === entityId);
  }

  /** True when the actor has already applied this entity version. @private */
  _atVersion(actor, entity) {
    return !!entity?.updated_at && actor.getFlag(FLAG_SCOPE, 'chronicleUpdatedAt') === entity.updated_at;
  }

  /**
   * True when `ts` is older than the version this actor has recorded: a
   * stale copy (an echo built before a later save) that must not roll the
   * actor back. Equal versions still apply (one-second precision).
   * @private
   */
  _olderThanRecorded(actor, ts) {
    const seen = Date.parse(actor?.getFlag?.(FLAG_SCOPE, 'chronicleUpdatedAt') || '');
    const t = Date.parse(ts || '');
    return Number.isFinite(seen) && Number.isFinite(t) && t < seen;
  }

  /**
   * Clean up hooks on destroy.
   */
  destroy() {
    Hooks.off('createActor', this._onCreateActor);
    Hooks.off('updateActor', this._onUpdateActor);
    Hooks.off('deleteActor', this._onDeleteActor);
    globalThis.window?.removeEventListener?.('beforeunload', this._onBeforeUnload);
    this._actorPushDebouncer.flushAll();
  }

  // ---------------------------------------------------------------------------
  // Chronicle → Foundry
  // ---------------------------------------------------------------------------

  /**
   * Handle a new character entity from Chronicle.
   * Creates a new Foundry Actor if one isn't already linked.
   * Uses the adapter's actorType to create the correct type (e.g., "hero").
   * @param {object} entity
   * @private
   */
  async _onCharacterCreated(entity) {
    // Check if an actor is already linked.
    const existing = game.actors.find(
      (a) => a.getFlag(FLAG_SCOPE, 'entityId') === entity.id
    );
    if (existing) return;

    // Race guard: a Foundry-originated POST for this name is in flight.
    // The originating handler will set the entityId flag once its POST
    // returns; creating another actor here would produce a duplicate
    // Foundry actor sharing the same chronicle entity. Match on name
    // because we don't yet know the new entity's ID on the Foundry side.
    for (const inFlightName of this._inFlightCreates.values()) {
      if (inFlightName === entity.name) {
        console.debug(
          `Chronicle: Skipping WS-driven actor create for "${entity.name}" — ` +
          `Foundry-originated POST is in flight; the originating handler will link it.`
        );
        return;
      }
    }

    try {
      this._syncing = true;

      const actorData = {
        name: entity.name,
        type: this._actorType,
        flags: {
          [FLAG_SCOPE]: {
            entityId: entity.id,
            lastSync: new Date().toISOString(),
            chronicleOwnerUserId: entity.owner_user_id ?? null,
          },
        },
      };

      // Apply adapter field mapping.
      const fieldUpdate = this._adapter.fromChronicleFields(entity);
      if (fieldUpdate) {
        // Merge dot-notation fields into nested structure for creation.
        for (const [key, value] of Object.entries(fieldUpdate)) {
          if (key === 'name') continue; // Already set above.
          _setNestedValue(actorData, key, value);
        }
      }

      const actor = await Actor.create(actorData);
      await this._applyIdentityItems(actor, entity);
      await this._applyClaimOwnership(actor, entity.owner_user_id ?? null, null);

      // Create sync mapping (idempotent — tolerates a pre-existing
      // Chronicle mapping pointing at a stale Foundry id, which is
      // common when the user has re-imported a world).
      await this._syncManager?.ensureMapping({
        chronicle_type: 'entity',
        chronicle_id: entity.id,
        external_system: 'foundry',
        external_id: actor.id,
        sync_direction: 'both',
      });

      console.debug(`Chronicle: Created actor "${entity.name}" from character entity`);
    } catch (err) {
      console.error('Chronicle: Failed to create actor from entity', err);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Handle an updated character entity from Chronicle.
   * @param {object} entity
   * @private
   */
  async _onCharacterUpdated(entity) {
    const actor = game.actors.find(
      (a) => a.getFlag(FLAG_SCOPE, 'entityId') === entity.id
    );
    if (!actor) return;
    await this._updateActorFromEntity(actor, entity);
  }

  /**
   * Swap the actor's ancestry/culture/career/kit items to the ones Chronicle
   * names. Runs inside the caller's `_syncing` guard; the writes also carry
   * the apply options so the item hooks do not push them back. Only the GM's
   * client does it, and a failure is one notice, never a thrown error.
   * @param {Actor} actor
   * @param {object} entity
   * @private
   */
  async _applyIdentityItems(actor, entity) {
    if (!game.user?.isGM) return;
    try {
      const plan = planIdentityItems({
        items: (actor.items?.contents ?? Array.from(actor.items ?? [])),
        fieldDefs: this._adapter.identityFields ?? [],
        fieldsData: entity?.fields_data,
      });
      if (!plan.length) return;
      const { failed } = await applyIdentityPlan(actor, plan, game);
      if (failed.length) {
        ui.notifications?.warn(game.i18n.format('CHRONICLE.ActorSync.IdentityItemFailed', {
          actor: actor.name,
          fields: failed.join(', '),
        }));
      }
    } catch (err) {
      console.error(`Chronicle: identity items failed for "${actor.name}"`, err);
      ui.notifications?.warn(game.i18n.format('CHRONICLE.ActorSync.IdentityItemFailed', {
        actor: actor.name,
        fields: '',
      }));
    }
  }

  /**
   * Re-read one linked character from Chronicle and apply it to its actor.
   * The same fetch-and-apply the entity.updated event does, for callers that
   * know a character changed without receiving the entity (stash moves).
   * @param {string} entityId
   * @returns {Promise<boolean>} whether an actor was refreshed.
   */
  async refreshFromChronicle(entityId) {
    if (!this._adapter || !this._api || !getSetting('syncCharacters')) return false;
    const entity = await this._api.get(`/entities/${entityId}`);
    if (!entity) return false;
    await this._onCharacterUpdated(entity);
    return true;
  }

  /**
   * Apply Chronicle entity data to a Foundry Actor. A copy older than the
   * actor's recorded version is ignored.
   * @param {Actor} actor
   * @param {object} entity
   * @returns {Promise<boolean>} false when the apply failed
   * @private
   */
  async _updateActorFromEntity(actor, entity) {
    if (this._olderThanRecorded(actor, entity?.updated_at)) {
      console.debug(`Chronicle: ignored a stale copy of "${actor.name}"`);
      return true;
    }
    try {
      this._syncing = true;

      // Only values that differ are written, marked as ours so the update
      // hook does not push them back.
      const changes = planActorApply({
        update: this._adapter.fromChronicleFields(entity),
        actor,
      });
      if (Object.keys(changes).length > 0) {
        await actor.update(changes, { ...SYNC_OPTIONS, [APPLY_OPTION]: true });
      }

      await this._applyIdentityItems(actor, entity);

      // Sync visibility: Chronicle is_private → Foundry actor hidden.
      // A private entity means the NPC is hidden from players.
      const shouldBeHidden = entity.is_private === true;
      if (actor.hidden !== shouldBeHidden) {
        // Update the actor's default token hidden state and active tokens.
        await actor.update({ 'prototypeToken.hidden': shouldBeHidden });
        console.debug(
          `Chronicle: ${shouldBeHidden ? 'Hid' : 'Revealed'} actor "${actor.name}" (visibility sync)`
        );
      }

      // Update sync timestamp and Chronicle updated_at for conflict detection.
      await actor.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString());
      if (entity.updated_at) {
        await actor.setFlag(FLAG_SCOPE, 'chronicleUpdatedAt', entity.updated_at);
      }
      // Cache claim status for the actor-sheet indicator; falls through
      // `null` when unclaimed so the indicator shows "Unclaimed" rather
      // than stale data.
      if (Object.prototype.hasOwnProperty.call(entity, 'owner_user_id')) {
        const previousOwner = actor.getFlag(FLAG_SCOPE, 'chronicleOwnerUserId') ?? null;
        const nextOwner = entity.owner_user_id ?? null;
        await actor.setFlag(FLAG_SCOPE, 'chronicleOwnerUserId', nextOwner);
        await this._applyClaimOwnership(actor, nextOwner, previousOwner);
      }

      console.debug(`Chronicle: Updated actor "${actor.name}" from entity`);
      return true;
    } catch (err) {
      console.error(`Chronicle: Failed to update actor "${actor.name}"`, err);
      return false;
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Handle a deleted character entity from Chronicle.
   * Removes the sync link but keeps the actor (to avoid data loss).
   * @param {object} data - Deletion event payload (may only contain id).
   * @private
   */
  async _onCharacterDeleted(data) {
    const entityId = data.id || data.resourceId;
    if (!entityId) return;

    const actor = game.actors.find(
      (a) => a.getFlag(FLAG_SCOPE, 'entityId') === entityId
    );
    if (!actor) return;

    try {
      this._syncing = true;
      await actor.unsetFlag(FLAG_SCOPE, 'entityId');
      await actor.unsetFlag(FLAG_SCOPE, 'lastSync');
      console.debug(`Chronicle: Unlinked actor "${actor.name}" (entity deleted)`);
    } catch (err) {
      console.error('Chronicle: Failed to unlink actor after entity deletion', err);
    } finally {
      this._syncing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Foundry → Chronicle
  // ---------------------------------------------------------------------------

  /**
   * Handle Foundry createActor hook.
   * Only processes actors matching the adapter's actorType.
   * @param {Actor} actor
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleCreateActor(actor, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;
    if (actor.type !== this._actorType) return;
    if (!this._adapter || !this._characterTypeId) return;

    // Skip if already linked (came from Chronicle).
    if (actor.getFlag(FLAG_SCOPE, 'entityId')) return;

    // Mark this Foundry-originated create as in-flight so the WS-driven
    // _onCharacterCreated can skip the matching `entity.created` broadcast
    // that arrives before our POST returns. The flag is set after the POST
    // succeeds; without this guard, the WS handler doesn't see the flag yet
    // and creates a duplicate Foundry actor.
    this._inFlightCreates.set(actor.id, actor.name);

    try {
      const fields = this._adapter.toChronicleFields(actor);

      // When the player-character-claiming addon is enabled, auto-resolve the
      // owner and route player-owned actors to the "Player Characters" sub-type.
      // When the addon is off, skip owner resolution — the player claims manually
      // in Chronicle.
      const addonOn = this._syncManager?.isPcClaimingEnabled() ?? false;
      const ownerUserId = addonOn ? this._resolveOwnerUserId(actor) : null;

      // Player-owned actors go under the PC sub-type when it has been resolved;
      // fall back to the parent character type if the sub-type wasn't found.
      const entityTypeId = _pickEntityTypeId(
        this._characterTypeId, this._pcSubtypeId, ownerUserId
      );

      const payload = {
        name: actor.name,
        entity_type_id: entityTypeId,
        is_private: false,
        fields_data: fields,
      };

      if (ownerUserId) payload.owner_user_id = ownerUserId;

      const entity = await this._api.post('/entities', payload);

      if (entity) {
        try {
          this._syncing = true;
          await actor.setFlag(FLAG_SCOPE, 'entityId', entity.id);
          await actor.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString());
          // Cache owner for the claim-status indicator; prefer the server's
          // value if returned, else fall back to what we sent.
          const cachedOwner = entity.owner_user_id ?? ownerUserId ?? null;
          await actor.setFlag(FLAG_SCOPE, 'chronicleOwnerUserId', cachedOwner);
        } finally {
          this._syncing = false;
        }

        // Create sync mapping (idempotent — handles the case where the
        // Foundry-originated POST raced a Chronicle-side mapping created
        // by another client or a server-side trigger).
        await this._syncManager?.ensureMapping({
          chronicle_type: 'entity',
          chronicle_id: entity.id,
          external_system: 'foundry',
          external_id: actor.id,
          sync_direction: 'both',
        });

        console.debug(`Chronicle: Pushed new actor "${actor.name}" to Chronicle`);
        this._syncManager?.recordUserOutcome?.(userId);
      }
    } catch (err) {
      console.error('Chronicle: Failed to push new actor to Chronicle', err);
      this._syncManager?.recordUserOutcome?.(userId, err);
    } finally {
      this._inFlightCreates.delete(actor.id);
    }
  }

  /**
   * Handle Foundry updateActor hook.
   * Pushes field changes to the linked Chronicle entity.
   * @param {Actor} actor
   * @param {object} change
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleUpdateActor(actor, change, options, userId) {
    if (this._syncing || options?.[APPLY_OPTION]) return;
    if (userId !== game.user.id) return;
    if (actor.type !== this._actorType) return;
    if (!this._adapter) return;

    const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    // Sync visibility: Foundry prototypeToken.hidden → Chronicle is_private.
    // Await this before field sync to avoid inconsistent state.
    const hiddenChanged =
      change.prototypeToken?.hidden !== undefined ||
      change.token?.hidden !== undefined;

    if (hiddenChanged) {
      try {
        const isHidden =
          change.prototypeToken?.hidden ?? change.token?.hidden ?? false;
        await this._api.post(`/entities/${entityId}/reveal`, {
          is_private: isHidden,
        });
        console.debug(
          `Chronicle: ${isHidden ? 'Hid' : 'Revealed'} entity for actor "${actor.name}" (Foundry → Chronicle)`
        );
      } catch (err) {
        console.error('Chronicle: Failed to sync visibility to Chronicle', err);
        // Continue to field sync even if visibility sync fails.
      }
    }

    // Only push field/name changes if system data or name changed. The diff
    // is kept (merged with the burst's earlier ones) so the push can send
    // just the mapped fields that changed.
    if (!change.system && !change.name) return;
    this._pendingChanges.set(actor.id, mergeChanges(this._pendingChanges.get(actor.id), change));
    this._actorPushDebouncer.schedule(actor.id, actor, entityId);
  }

  /**
   * Push an actor's pending name and field changes to Chronicle, after the
   * debounce window.
   *
   * Name goes first, with the stored `updated_at` as the conflict check, so a
   * rename is still compared against what Chronicle really had. The fields
   * PUT is a partial merge that bumps the entity's `updated_at` without
   * returning it, so the new value is re-read afterwards and carried forward;
   * otherwise the next rename would send a stale version and always 409.
   * (Name and fields cannot share one PUT: the entity PUT replaces
   * `fields_data` instead of merging it.)
   * @param {Actor} actor
   * @param {string} entityId
   * @private
   */
  async _pushActorUpdate(actor, entityId) {
    const change = this._pendingChanges.get(actor.id) || {};
    this._pendingChanges.delete(actor.id);

    try {
      if (change.name !== undefined) {
        const kept = await this._pushActorName(actor, entityId);
        if (!kept) return;
      }

      // Only the mapped fields this burst touched. Without an adapter helper
      // fall back to the full set, but only when system data changed.
      const fields = typeof this._adapter.toChronicleFieldsChanged === 'function'
        ? this._adapter.toChronicleFieldsChanged(actor, change)
        : (change.system ? this._adapter.toChronicleFields(actor) : null);

      if (fields && Object.keys(fields).length > 0) {
        await this._putFieldsMerged(entityId, fields);
        await this._refreshChronicleVersion(actor, entityId);
      }

      await this._setActorFlag(actor, 'lastSync', new Date().toISOString());

      console.debug(`Chronicle: Pushed actor "${actor.name}" changes to Chronicle`);
      // The debounce has no hook userId; the hooks only schedule this for the local user's own edits.
      this._syncManager?.recordUserOutcome?.(game.user.id);
    } catch (err) {
      console.error('Chronicle: Failed to push actor update to Chronicle', err);
      this._syncManager?.recordUserOutcome?.(game.user.id, err);
    }
  }

  /**
   * Write some fields without losing the rest. Older Chronicle servers
   * replace the whole field set on this PUT, so the current set is read and
   * the changes laid over it; newer ones merge, and sending the merged set
   * is the same result there. A failed read throws rather than risk a
   * partial set wiping the rest on an older server.
   * @param {string} entityId
   * @param {object} fields
   * @private
   */
  async _putFieldsMerged(entityId, fields) {
    const current = (await this._api.get(`/entities/${entityId}`))?.fields_data;
    const merged = current && typeof current === 'object' && !Array.isArray(current)
      ? { ...current, ...fields }
      : fields;
    await this._api.put(`/entities/${entityId}/fields`, { fields_data: merged });
  }

  /**
   * Rename the Chronicle entity. Chronicle's PUT /entities/:id is a partial
   * update (API-CONTRACT.md → "The partial-update contract"): send only
   * {name}, never echo is_private/type_label/parent_id back. Visibility has
   * its own route: POST /entities/:id/reveal.
   * @returns {Promise<boolean>} false when Chronicle's version was kept
   *   instead, so the caller must not push this burst's fields over it.
   * @private
   */
  async _pushActorName(actor, entityId) {
    const nameBody = { name: actor.name };
    const chronicleUpdatedAt = actor.getFlag(FLAG_SCOPE, 'chronicleUpdatedAt');
    if (chronicleUpdatedAt) {
      nameBody.expected_updated_at = chronicleUpdatedAt;
    }

    try {
      const result = await this._api.put(`/entities/${entityId}`, nameBody);
      if (result?.updated_at) {
        await this._setActorFlag(actor, 'chronicleUpdatedAt', result.updated_at);
      }
      return true;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      const strategy = getSetting('conflictResolution');
      if (strategy === 'chronicle') {
        // Re-pull from Chronicle.
        const entity = await this._api.get(`/entities/${entityId}`);
        if (entity) await this._updateActorFromEntity(actor, entity);
        ui.notifications.warn(`Chronicle: Conflict on "${actor.name}" — kept Chronicle version.`);
        return false;
      }
      // Force push.
      delete nameBody.expected_updated_at;
      const forced = await this._api.put(`/entities/${entityId}`, nameBody);
      if (forced?.updated_at) {
        await this._setActorFlag(actor, 'chronicleUpdatedAt', forced.updated_at);
      }
      ui.notifications.warn(`Chronicle: Conflict on "${actor.name}" — kept Foundry version.`);
      return true;
    }
  }

  /**
   * Re-read the entity's `updated_at` after a fields push and store it. If the
   * read fails the stored version is dropped, so the next rename sends no
   * version check rather than a stale one that would always conflict.
   * @private
   */
  async _refreshChronicleVersion(actor, entityId) {
    try {
      const entity = await this._api.get(`/entities/${entityId}`);
      if (entity?.updated_at) {
        await this._setActorFlag(actor, 'chronicleUpdatedAt', entity.updated_at);
        return;
      }
    } catch (err) {
      console.warn('Chronicle: Could not re-read the entity version after a fields push', err);
    }
    await this._setActorFlag(actor, 'chronicleUpdatedAt', null);
  }

  /** Set a sync flag without the update hook treating it as a user edit. @private */
  async _setActorFlag(actor, key, value) {
    this._syncing = true;
    try {
      if (value === null) await actor.unsetFlag(FLAG_SCOPE, key);
      else await actor.setFlag(FLAG_SCOPE, key, value);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Handle Foundry deleteActor hook: the GM is asked before the linked
   * Chronicle entity, if any, is deleted too.
   * @param {Actor} actor
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleDeleteActor(actor, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;

    // A push still pending would aim at an actor that is gone.
    this._actorPushDebouncer.cancel(actor.id);
    this._pendingChanges.delete(actor.id);

    const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    // The GM is asked before the Chronicle page goes too (_remote-deletes.mjs).
    queueRemoteDelete({ label: actor.name, run: () => this._api.delete(`/entities/${entityId}`) });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Load the system adapter based on the matched Chronicle system.
   * Uses the generic API-driven adapter which reads field definitions
   * (including foundry_path annotations) from the system manifest.
   * @returns {Promise<object|null>} Adapter module or null.
   * @private
   */
  async _loadAdapter() {
    const matchedSystem = getSetting('detectedSystem');
    if (!matchedSystem) return null;

    try {
      const generic = await createGenericAdapter(this._api, matchedSystem);
      if (generic) {
        console.debug(`Chronicle: Using generic adapter for "${matchedSystem}"`);
        return generic;
      }
    } catch (err) {
      console.error(`Chronicle: Failed to create generic adapter for "${matchedSystem}"`, err);
    }

    console.warn(`Chronicle: No adapter available for system "${matchedSystem}"`);
    return null;
  }

  /**
   * Resolve the character entity type ID and (when the PC-claiming addon is
   * active) the "Player Characters" sub-type ID in a single `/entity-types`
   * call.
   * @private
   */
  async _resolveCharacterTypeId() {
    if (!this._adapter?.characterTypeSlug) return;

    try {
      const result = await this._api.get('/entity-types');
      const types = result?.data || result || [];
      const match = types.find(
        (t) => t.slug === this._adapter.characterTypeSlug
          || t.name?.toLowerCase().includes('character')
      );
      if (match) {
        this._characterTypeId = match.id;
        console.debug(`Chronicle: Character type resolved — "${match.name}" (ID: ${match.id})`);

        // When the PC-claiming addon is on, also find the "Player Characters"
        // sub-type so player-owned actors are routed there automatically.
        if (this._syncManager?.isPcClaimingEnabled()) {
          this._pcSubtypeId = _findPcSubtypeId(types, match.id);
          if (this._pcSubtypeId) {
            console.debug(`Chronicle: Player Characters sub-type resolved (ID: ${this._pcSubtypeId})`);
          } else {
            console.debug(
              'Chronicle: No "Player Characters" sub-type found — ' +
              'player-owned actors will use the parent character type'
            );
          }
        }
      } else {
        console.warn('Chronicle: No character entity type found in campaign');
      }
    } catch (err) {
      console.warn('Chronicle: Failed to resolve character type ID', err);
    }
  }

  /**
   * Check if an entity is a character type (parent or PC sub-type).
   *
   * When type IDs are resolved (the common path after init), entity_type_id is
   * the authoritative check — it accepts both the parent character type and the
   * "Player Characters" sub-type so WS events for both land on this ActorSync.
   * Slug/name are fallbacks for minimal payloads or pre-init calls.
   *
   * @param {object} entity
   * @returns {boolean}
   * @private
   */
  _isCharacterEntity(entity) {
    // ID-based match is authoritative when we have resolved IDs. Accept both
    // the parent character type and the PC sub-type. Reject anything else
    // (NPC, monster, etc.) even if its name happens to contain "character".
    if (this._characterTypeId) {
      if (entity.entity_type_id) {
        return entity.entity_type_id === this._characterTypeId
          || (!!this._pcSubtypeId && entity.entity_type_id === this._pcSubtypeId);
      }
      // entity_type_id absent — fall through to slug/name checks.
    }
    // Slug check (adapter slug is campaign-independent).
    if (entity.type_slug && this._adapter?.characterTypeSlug) {
      return entity.type_slug === this._adapter.characterTypeSlug;
    }
    // Name fallback for minimal WS payloads (e.g. "Player Characters" → true).
    if (entity.type_name) {
      return entity.type_name.toLowerCase().includes('character');
    }
    return false;
  }

  /**
   * Resolve a Foundry actor's player owner to a Chronicle user ID.
   * Returns null when no non-GM owner is set or no Chronicle mapping exists.
   * If multiple non-GM owners exist (rare), picks the lowest user id
   * deterministically and logs a debug; the GM can reassign in chronicle.
   * @param {Actor} actor
   * @returns {string|null}
   * @private
   */
  _resolveOwnerUserId(actor) {
    if (!this._syncManager) return null;

    const ownership = actor.ownership ?? {};
    const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    const playerOwners = [];
    for (const [userId, level] of Object.entries(ownership)) {
      if (userId === 'default') continue;
      if (level !== ownerLevel) continue;
      const user = game.users?.get(userId);
      if (!user || user.isGM) continue;
      playerOwners.push(userId);
    }

    if (playerOwners.length === 0) return null;
    playerOwners.sort();
    if (playerOwners.length > 1) {
      console.debug(
        `Chronicle: Actor "${actor.name}" has ${playerOwners.length} non-GM owners; ` +
        `using "${playerOwners[0]}" for owner_user_id mapping. Reassign in chronicle if wrong.`
      );
    }

    return this._syncManager.getChronicleUserId(playerOwners[0]);
  }

  /**
   * Get all synced actors with their status for dashboard display.
   * Filters by the adapter's actor type so Draw Steel shows heroes,
   * D&D 5e shows characters, etc.
   * @returns {Array<{id: string, name: string, entityId: string|null, synced: boolean, lastSync: string|null}>}
   */
  getSyncedActors() {
    if (!this._adapter) return [];

    const targetType = this._actorType;
    return game.actors.contents
      .filter((a) => a.type === targetType)
      .map((a) => {
        const entityId = a.getFlag(FLAG_SCOPE, 'entityId') || null;
        const lastSync = a.getFlag(FLAG_SCOPE, 'lastSync') || null;
        return {
          id: a.id,
          name: a.name,
          entityId,
          synced: !!entityId,
          lastSync,
          img: a.img,
        };
      })
      .sort((a, b) => {
        // Synced actors first, then alphabetical.
        if (a.synced !== b.synced) return a.synced ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  // ---------------------------------------------------------------------------
  // Sync issue resolver — recover broken / missing character links and re-push
  // stranded data (Foundry → Chronicle). See sync-dashboard "Issues" tab.
  // ---------------------------------------------------------------------------

  /**
   * The candidate pool for matching: every Chronicle character entity (the
   * system character type plus the PC sub-type, the same set onInitialSync walks).
   * @returns {Promise<Array<{id:string,name:string,entity_type_id?:number}>>}
   * @private
   */
  async _listCharacterEntities() {
    if (!this._characterTypeId) return [];
    const typeIds = [this._characterTypeId];
    if (this._pcSubtypeId) typeIds.push(this._pcSubtypeId);
    const out = [];
    for (const typeId of typeIds) {
      try {
        out.push(...(await this._walkTypeEntities(typeId)));
      } catch (err) {
        console.warn('Chronicle: failed to list character entities', err);
      }
    }
    return out;
  }

  /**
   * Every entity of one type, paged to the end (a campaign with more than
   * one page of characters used to be cut off at the first).
   * @param {number} typeId
   * @returns {Promise<Array<object>>}
   * @private
   */
  async _walkTypeEntities(typeId) {
    const walked = await walkEntityPages(
      (page, perPage) => this._api.get(`/entities?type_id=${typeId}&per_page=${perPage}&page=${page}`),
      unwrapEntityList,
    );
    if (walked.truncated) {
      console.warn(`Chronicle: character list for type ${typeId} stopped at ${walked.entities.length}; there are more.`);
    }
    return walked.entities;
  }

  /**
   * Whether a Chronicle entity still exists. Only a definite 404 counts as
   * "gone"; ambiguous/transient errors return true so a flaky network never
   * mislabels a healthy link as broken.
   * @param {string} entityId
   * @returns {Promise<boolean>}
   * @private
   */
  async _entityExists(entityId) {
    try {
      await this._api.get(`/entities/${entityId}`);
      return true;
    } catch (err) {
      const status = err?.status ?? err?.statusCode ?? err?.response?.status;
      if (status === 404 || /\b404\b|not found/i.test(err?.message || '')) return false;
      return true;
    }
  }

  /**
   * Best name match for an actor among candidate entities: exact
   * (case-insensitive), then prefix, then substring. Null when nothing is a
   * confident match (the resolver then defaults to "Create new").
   * @param {string} actorName
   * @param {Array<{id:string,name:string}>} entities
   * @returns {{id:string,name:string}|null}
   * @private
   */
  _suggestMatch(actorName, entities) {
    const n = (actorName || '').trim().toLowerCase();
    if (!n) return null;
    const norm = (e) => (e.name || '').trim().toLowerCase();
    let m = entities.find((e) => norm(e) === n);
    if (m) return m;
    m = entities.find((e) => { const en = norm(e); return en && (en.startsWith(n) || n.startsWith(en)); });
    if (m) return m;
    m = entities.find((e) => { const en = norm(e); return en && (en.includes(n) || n.includes(en)); });
    return m || null;
  }

  /**
   * Scan character actors for issues the resolver can fix:
   *   - 'unlinked': no entityId flag (never linked)
   *   - 'broken':   entityId flag points at an entity that 404s — "failed to
   *                 find existing character" (linked once, now gone)
   * Linked + valid actors aren't issues (re-pushing their data is the explicit
   * repushActor action). Each issue carries a name-matched suggestion, and the
   * result includes the full candidate list so the UI can prefill + offer a pick.
   * @returns {Promise<{issues:Array, candidates:Array<{id:string,name:string}>}>}
   */
  async getSyncIssues() {
    if (!this._adapter || !this._characterTypeId) return { issues: [], candidates: [] };
    const entities = await this._listCharacterEntities();
    const ids = new Set(entities.map((e) => e.id));
    const issues = [];
    for (const actor of game.actors.contents) {
      if (actor.type !== this._actorType) continue;
      const entityId = actor.getFlag(FLAG_SCOPE, 'entityId') || null;
      let kind = null;
      if (!entityId) {
        kind = 'unlinked';
      } else if (!ids.has(entityId) && !(await this._entityExists(entityId))) {
        kind = 'broken';
      }
      if (!kind) continue;
      const suggestion = this._suggestMatch(actor.name, entities);
      issues.push({ actorId: actor.id, name: actor.name, img: actor.img, kind, suggestionId: suggestion?.id || null });
    }
    return {
      issues,
      candidates: entities.map((e) => ({ id: e.id, name: e.name }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    };
  }

  /**
   * If any character actors can't be matched to Chronicle (broken / missing
   * links), nudge the GM toward the dashboard's Issues tab. Quiet when all clear.
   *
   * `quick` (after a change-feed catch-up) counts unlinked character actors
   * without listing Chronicle: the catch-up has just unlinked any actor whose
   * character was removed, so no broken link can be left to find.
   * @param {{quick?: boolean}} [opts]
   * @private
   */
  async _notifySyncIssues({ quick = false } = {}) {
    try {
      const { issues } = quick
        ? { issues: game.actors.contents.filter((a) => a.type === this._actorType && !a.getFlag(FLAG_SCOPE, 'entityId')) }
        : await this.getSyncIssues();
      if (!issues.length) return;
      const n = issues.length;
      ui.notifications?.warn(
        `Chronicle Sync: ${n} character${n === 1 ? '' : 's'} need attention — open the Chronicle dashboard (Issues) to match or create.`
      );
      console.warn(`Chronicle: ${n} character sync issue(s) detected`, issues);
    } catch (err) {
      console.warn('Chronicle: issue check failed', err);
    }
  }

  /**
   * Push a LINKED actor's current fields to its Chronicle entity. Fixes the
   * "stranded data on a valid link" case (actor edited while the module was
   * offline, so updateActor never fired).
   * @param {string} actorId
   * @returns {Promise<boolean>}
   */
  async repushActor(actorId) {
    const actor = game.actors.get(actorId);
    const entityId = actor?.getFlag(FLAG_SCOPE, 'entityId');
    if (!actor || !entityId || !this._adapter) return false;
    await this._putFieldsMerged(entityId, this._adapter.toChronicleFields(actor));
    this._syncing = true;
    try { await actor.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString()); }
    finally { this._syncing = false; }
    console.debug(`Chronicle: Re-pushed actor "${actor.name}" → entity ${entityId}`);
    return true;
  }

  /**
   * Link an orphaned actor to an EXISTING Chronicle entity, then push the
   * actor's current data up (Foundry is source of truth for characters).
   * @param {string} actorId
   * @param {string} entityId
   * @returns {Promise<boolean>}
   */
  async matchActorToEntity(actorId, entityId) {
    const actor = game.actors.get(actorId);
    if (!actor || !entityId || !this._adapter) return false;
    this._syncing = true;
    try { await actor.setFlag(FLAG_SCOPE, 'entityId', entityId); }
    finally { this._syncing = false; }
    return this.repushActor(actorId);
  }

  /**
   * Create a NEW Chronicle entity of the SYSTEM'S character type for an orphaned
   * actor and link it. Clears any stale/broken link first so _handleCreateActor
   * creates fresh instead of skipping an "already linked" actor.
   * @param {string} actorId
   * @returns {Promise<boolean>}
   */
  async createEntityForActor(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return false;
    if (actor.getFlag(FLAG_SCOPE, 'entityId')) {
      this._syncing = true;
      try { await actor.unsetFlag(FLAG_SCOPE, 'entityId'); }
      finally { this._syncing = false; }
    }
    await this._handleCreateActor(actor, {}, game.user.id);
    return !!actor.getFlag(FLAG_SCOPE, 'entityId');
  }

  /**
   * Return true when any actor of the character type has a non-GM Foundry
   * owner. Used by the dashboard to surface the PC-claiming hint when the
   * addon is off.
   * @returns {boolean}
   */
  hasPlayerOwnedPcs() {
    if (!this._adapter) return false;
    const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    return game.actors.contents.some((a) => {
      if (a.type !== this._actorType) return false;
      return Object.entries(a.ownership ?? {}).some(([uid, lvl]) => {
        if (uid === 'default' || lvl !== ownerLevel) return false;
        const user = game.users?.get(uid);
        return user != null && !user.isGM;
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Prototype-pollution guard for _setNestedValue path segments. */
const PROTO_BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Set a nested value on an object using dot-notation key.
 * e.g., _setNestedValue(obj, 'system.abilities.str.value', 10)
 *
 * Rejects any path segment that is a known prototype-pollution vector
 * (__proto__, prototype, constructor). Chronicle manifests are
 * operator-controlled, but an accidental or tampered manifest path
 * writing through these keys could corrupt the JS prototype chain.
 *
 * @param {object} obj
 * @param {string} path
 * @param {*} value
 */
function _setNestedValue(obj, path, value) {
  const keys = path.split('.');
  // Reject any prototype-pollution segment before touching the object.
  if (keys.some((k) => PROTO_BLOCKED.has(k))) {
    console.warn(`Chronicle: _setNestedValue rejected unsafe path segment in "${path}"`);
    return;
  }
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!(keys[i] in current) || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Find the "Player Characters" sub-type ID within a flat entity-type list.
 *
 * Accepts a child type whose `parent_id` (or `parent_type_id`) equals
 * `parentTypeId` AND whose slug or name identifies it as the PC sub-type.
 * Slug matching normalises underscores/spaces → hyphens before comparing.
 *
 * Exported for unit tests.
 *
 * @param {Array<object>} types  - Flat list from GET /entity-types.
 * @param {number|string} parentTypeId
 * @returns {number|string|null}
 */
export function _findPcSubtypeId(types, parentTypeId) {
  if (!parentTypeId || !Array.isArray(types)) return null;
  const match = types.find((t) => {
    if (t.parent_id !== parentTypeId && t.parent_type_id !== parentTypeId) return false;
    const slug = (t.slug || '').toLowerCase().replace(/[\s_]+/g, '-');
    const name = (t.name || '').toLowerCase();
    return slug === 'player-characters'
      || name === 'player characters'
      || name.startsWith('player character');
  });
  return match?.id ?? null;
}

/**
 * Decide which entity_type_id to use when pushing a new actor to Chronicle.
 *
 * Player-owned actors route to the PC sub-type (when resolved) so they land
 * in the claimable sub-type bucket. All other actors use the parent character
 * type. When the addon is off the caller passes `ownerUserId = null`, which
 * ensures the parent type is always used — the ownership decision and the
 * type-routing decision stay in one place.
 *
 * Exported for unit tests.
 *
 * @param {number|string|null} characterTypeId - Parent character type ID.
 * @param {number|string|null} pcSubtypeId     - "Player Characters" sub-type ID (null when not resolved).
 * @param {string|null}        ownerUserId     - Chronicle user ID of the actor's player owner (null when addon off or no owner).
 * @returns {number|string|null}
 */
export function _pickEntityTypeId(characterTypeId, pcSubtypeId, ownerUserId) {
  return (ownerUserId && pcSubtypeId) ? pcSubtypeId : characterTypeId;
}
