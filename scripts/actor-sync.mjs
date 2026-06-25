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

import { getSetting } from './settings.mjs';
import { ConflictError } from './api-client.mjs';
import { createGenericAdapter } from './adapters/generic-adapter.mjs';
import { FLAG_SCOPE } from './constants.mjs';

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

  /**
   * Perform initial sync: pull all character entities and match to actors.
   */
  async onInitialSync() {
    if (!this._adapter || !getSetting('syncCharacters')) return;
    if (!this._characterTypeId) return;

    try {
      // Pull the parent character type and (when resolved) the PC sub-type so
      // existing actor–entity links are refreshed regardless of which Chronicle
      // type the entity lives under.
      const typeIds = [this._characterTypeId];
      if (this._pcSubtypeId) typeIds.push(this._pcSubtypeId);

      const allEntities = [];
      for (const typeId of typeIds) {
        const result = await this._api.get(`/entities?type_id=${typeId}&per_page=100`);
        allEntities.push(...(result?.data || []));
      }

      for (const entity of allEntities) {
        // Check if already linked to an actor.
        const existingActor = game.actors.find(
          (a) => a.getFlag(FLAG_SCOPE, 'entityId') === entity.id
        );

        if (existingActor) {
          // Update existing actor with latest data.
          await this._updateActorFromEntity(existingActor, entity);
        }
        // Don't auto-create actors during initial sync — only update existing links.
      }

      // Surface unresolved character links (broken / missing) so the GM can
      // fix them in the dashboard's Issues tab rather than silently desyncing.
      await this._notifySyncIssues();
    } catch (err) {
      console.warn('Chronicle: Actor initial sync failed', err);
    }
  }

  /**
   * Clean up hooks on destroy.
   */
  destroy() {
    Hooks.off('createActor', this._onCreateActor);
    Hooks.off('updateActor', this._onUpdateActor);
    Hooks.off('deleteActor', this._onDeleteActor);
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
   * Apply Chronicle entity data to a Foundry Actor.
   * @param {Actor} actor
   * @param {object} entity
   * @private
   */
  async _updateActorFromEntity(actor, entity) {
    try {
      this._syncing = true;

      const fieldUpdate = this._adapter.fromChronicleFields(entity);
      if (fieldUpdate && Object.keys(fieldUpdate).length > 0) {
        await actor.update(fieldUpdate);
      }

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
      // Cache claim status for the actor-sheet indicator (FM-CH2). Falls
      // through `null` when the entity is unclaimed so the indicator can
      // show "Unclaimed" rather than stale data.
      if (Object.prototype.hasOwnProperty.call(entity, 'owner_user_id')) {
        await actor.setFlag(FLAG_SCOPE, 'chronicleOwnerUserId', entity.owner_user_id ?? null);
      }

      console.debug(`Chronicle: Updated actor "${actor.name}" from entity`);
    } catch (err) {
      console.error(`Chronicle: Failed to update actor "${actor.name}"`, err);
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
      // in Chronicle. (FM-CH1 / PC-CLAIM-4)
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
          // Cache owner for the claim-status indicator (FM-CH2). Prefer the
          // server's value if returned; fall back to what we sent.
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
      }
    } catch (err) {
      console.error('Chronicle: Failed to push new actor to Chronicle', err);
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
    if (this._syncing) return;
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

    // Only push field/name changes if system data or name changed.
    if (!change.system && !change.name) return;

    try {
      const fields = this._adapter.toChronicleFields(actor);

      await this._api.put(`/entities/${entityId}/fields`, { fields_data: fields });

      // Update name separately if changed, with conflict detection.
      if (change.name) {
        const nameBody = { name: change.name };
        const chronicleUpdatedAt = actor.getFlag(FLAG_SCOPE, 'chronicleUpdatedAt');
        if (chronicleUpdatedAt) {
          nameBody.expected_updated_at = chronicleUpdatedAt;
        }

        try {
          const result = await this._api.put(`/entities/${entityId}`, nameBody);
          if (result?.updated_at) {
            this._syncing = true;
            try {
              await actor.setFlag(FLAG_SCOPE, 'chronicleUpdatedAt', result.updated_at);
            } finally {
              this._syncing = false;
            }
          }
        } catch (err) {
          if (err instanceof ConflictError) {
            const strategy = getSetting('conflictResolution');
            if (strategy === 'chronicle') {
              // Re-pull from Chronicle.
              const entity = await this._api.get(`/entities/${entityId}`);
              if (entity) await this._updateActorFromEntity(actor, entity);
              ui.notifications.warn(`Chronicle: Conflict on "${actor.name}" — kept Chronicle version.`);
            } else {
              // Force push.
              delete nameBody.expected_updated_at;
              await this._api.put(`/entities/${entityId}`, nameBody);
              ui.notifications.warn(`Chronicle: Conflict on "${actor.name}" — kept Foundry version.`);
            }
            return;
          }
          throw err;
        }
      }

      try {
        this._syncing = true;
        await actor.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString());
      } finally {
        this._syncing = false;
      }

      console.debug(`Chronicle: Pushed actor "${actor.name}" changes to Chronicle`);
    } catch (err) {
      console.error('Chronicle: Failed to push actor update to Chronicle', err);
    }
  }

  /**
   * Handle Foundry deleteActor hook.
   * Deletes the linked Chronicle entity if one exists.
   * @param {Actor} actor
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleDeleteActor(actor, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;

    const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    try {
      await this._api.delete(`/entities/${entityId}`);
      console.debug(`Chronicle: Deleted entity for actor "${actor.name}"`);
    } catch (err) {
      console.error('Chronicle: Failed to delete entity for deleted actor', err);
    }
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
        const result = await this._api.get(`/entities?type_id=${typeId}&per_page=100`);
        out.push(...(result?.data || []));
      } catch (err) {
        console.warn('Chronicle: failed to list character entities', err);
      }
    }
    return out;
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
   * @private
   */
  async _notifySyncIssues() {
    try {
      const { issues } = await this.getSyncIssues();
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
    await this._api.put(`/entities/${entityId}/fields`, { fields_data: this._adapter.toChronicleFields(actor) });
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
