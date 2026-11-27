/**
 * Chronicle Sync - Actor/Character Sync
 *
 * Bidirectional sync between Chronicle character entities and Foundry Actors.
 * Only active when a matching game system is detected and the
 * syncCharacters setting is enabled.
 *
 * Sync flow:
 * - Chronicle → Foundry: Entity changes arrive via WebSocket, create/update Actor.
 * - Foundry → Chronicle: Actor changes detected via Hooks, push to Chronicle API.
 *
 * System-specific field mapping is delegated to adapter modules. The adapter's
 * actorType property (e.g., "character" for D&D 5e, "hero" for Draw Steel)
 * determines which Foundry actor type to sync. Under a system with its own
 * NPC actor type (Draw Steel) an NPC's page becomes that type instead, and
 * shares only its name, pictures and visibility (_npc-character.mjs).
 */

import { noticeText } from './_escape-html.mjs';
import { getSetting, setSetting, getUserMappings, getSyncExclusions } from './settings.mjs';
import { ConflictError } from './api-client.mjs';
import { conflictEvent } from './_history-report.mjs';
import { createGenericAdapter, buildChronicleFields } from './adapters/generic-adapter.mjs';
import { FLAG_SCOPE, syncOptions, APPLY_OPTION } from './constants.mjs';
import { flagRemoval } from './_flag-removal.mjs';
import { touchesLinkFlags } from './_set-aside.mjs';
import { planClaimOwnership } from './_claim-ownership-plan.mjs';
import { queueRemoteDelete } from './_remote-deletes.mjs';
import { walkEntityPages, unwrapEntityList } from './_entity-page-walk.mjs';
import { JournalPushDebouncer } from './_journal-push-debounce.mjs';
import { mergeChanges, changeTouchesPath, ITEMS_CHANGED } from './_actor-field-diff.mjs';
import { collapseChanges } from './_change-feed.mjs';
import { planActorApply } from './_actor-apply-plan.mjs';
import { planIdentityItems, identityFieldTypes, identityPicks } from './_identity-item-plan.mjs';
import { applyIdentityPlan, applyEntryRefresh, journalMentions } from './_identity-item-apply.mjs';
import { planEntryRefresh } from './_campaign-entry-item.mjs';
import { sendsChangeHere, memberOf, ownsCharacter } from './_change-author.mjs';
import { ASK, askModel, sameName } from './_player-asks.mjs';
import { actingMemberOf, heldKeysOf, describeHeld, HeldNotices } from './_player-picks-held.mjs';
import { getPlayerAsks, playerName } from './player-asks.mjs';
import { planLayerEffects, layeredFieldKeys, storedLayers, LAYER_FLAG } from './_layer-effects.mjs';
import { bringsInActor } from './_actor-catch-up.mjs';
import { planGmFieldClear, holdsGmFieldText } from './_gm-field-clear.mjs';
import { usersWithHero, planPlayerHeroes, memberClaims, assignsCharacter } from './_player-hero.mjs';
import { memberKey } from './_member-mapping.mjs';
import { isAnsweringGM } from './_stash-relay.mjs';
import { PictureStore, MAX_PICTURE_BYTES } from './picture-store.mjs';
import { heroChoice, heroPictureIds, heroPicturePlan, HERO_PICTURES_FLAG } from './_hero-pictures.mjs';
import { TOKEN_FIELD } from './_creature-pictures.mjs';
import { PICTURES_CHANGED, changesPictures, picturesToPush, sendablePicture, pictureName, sentFlag, isWorldFile, sameOriginUrl } from './_hero-picture-push.mjs';
import { folderKindFor, needsPlacing, FOLDER_PLACED_FLAG, ACTOR_FOLDER_FLAG, HEROES } from './_actor-folder.mjs';
import { CLASS_PICK_FLAG, classPick, pickToFinish, pickChanged, SUBCLASS_PICK_FLAG, subclassPicks, subclassesToFinish, subclassPickChanged } from './_finish-hero.mjs';
import { npcActorTypeFor, actorTypeForPage, switchTarget } from './_npc-character.mjs';
import { ActorTypeSwitch, switchActorType } from './actor-type-switch.mjs';

/** How long a read of the campaign's pick-list entries is reused. */
const ENTRY_CACHE_MS = 30_000;

/** Actor flag: the identity picks (ancestry, kit, …) Chronicle last had when applied. */
const IDENTITY_APPLIED_FLAG = 'identityApplied';

/**
 * Making a hero for a player is left to the active GM's client: each GM's
 * client queues its own creates, so two GMs would each make one.
 */
function isActiveGM() {
  return isAnsweringGM(game.user, game.users?.activeGM);
}

/**
 * ActorSync handles character entity ↔ Actor synchronization.
 */
export class ActorSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;

    /** @type {import('./sync-manager.mjs').SyncManager|null} */
    this._syncManager = null;

    /** @type {PictureStore|null} made on first use */
    this._pictures = null;

    /** Chronicle claimants already reported as having no Foundry user, so the GM hears once a session. */
    this._unmappedNoticed = new Set();
    /**
     * Who Chronicle says claimed each linked page (entity id -> member id),
     * as last read from Chronicle. The actor's own owner flag is only a
     * cache for the sheet: a player who owns the actor can rewrite it.
     * @type {Map<string, string|null>}
     */
    this._chronicleOwners = new Map();

    /**
     * Heroes claimed live by a member with no Foundry user yet (member key ->
     * page id). The members list read at connect predates the claim, so a
     * link made later in this session finds the hero here.
     */
    this._claimsWaiting = new Map();

    /**
     * Tracks Foundry-originated creates whose POST is in flight.
     * Maps actor.id → actor.name. Used to suppress the WS-driven
     * `_onCharacterCreated` from spawning a duplicate Foundry actor when
     * `entity.created` arrives before our POST returns.
     * @type {Map<string, string>}
     */
    this._inFlightCreates = new Map();

    /**
     * Chronicle work queued per character, so a create, an update and a
     * connect-time catch-up for one page run in turn: the second sees the
     * first's actor instead of making another or being dropped.
     * @type {Map<string, Promise<unknown>>}
     */
    this._entityTurns = new Map();

    /** @type {object|null} Loaded system adapter module. */
    this._adapter = null;

    /** @type {number|null} Cached Chronicle entity type ID for characters. */
    this._characterTypeId = null;

    /** @type {number|null} Cached "Player Characters" sub-type ID (child of character type). Null when addon off or sub-type not found. */
    this._pcSubtypeId = null;

    /** @type {string|null} The system's NPC actor type, when it has one apart from heroes. */
    this._npcType = null;

    /** @type {ActorTypeSwitch|null} Asks the GM before switching an actor's type. */
    this._typeSwitch = null;

    // Foundry -> Chronicle actor pushes are debounced per actor: a burst of
    // edits (a slider drag, an HP tick) is one request, not one per update,
    // against the API key's per-minute limit. The changes of the burst are
    // merged so the push knows every field it touched.
    /** @type {Map<string, object>} Merged update diffs awaiting a push. */
    this._pendingChanges = new Map();
    /** @type {Map<string, string>} Who made the last change of a pending burst, by actor id. */
    this._pendingAuthors = new Map();
    /** @type {Map<string, Set<string>>} Players with a change in a pending burst, by actor id. */
    this._pendingPlayers = new Map();
    /** @type {Set<string>} Actors the GM was already told hold a player's unsent change. */
    this._warnedPlayerChange = new Set();
    /** Picks Chronicle held from a player's change, told to the GM once per distinct refusal. */
    this._heldNotices = new HeldNotices();
    /** @type {Map<string, object>} Diffs whose push is in flight, by actor id. */
    this._pushingChanges = new Map();
    // Actors whose Foundry pictures are being sent: a pull meanwhile leaves their pictures alone.
    this._sendingPictures = new Set();
    this._actorPushDebouncer = new JournalPushDebouncer(
      (actor, entityId) => { this._pushActorUpdate(actor, entityId); }
    );
    this._onBeforeUnload = () => this._actorPushDebouncer.flushAll();

    // Bound hook handlers for cleanup.
    this._onCreateActor = this._handleCreateActor.bind(this);
    this._onUpdateActor = this._handleUpdateActor.bind(this);
    this._onDeleteActor = this._handleDeleteActor.bind(this);
    this._onCreateItem = (item, options, userId) => this._handleItemChange(item, 'changed', options, userId);
    this._onUpdateItem = (item, change, options, userId) => {
      // A flag-only write (an inventory link) changes nothing a field reads.
      if (change && !('name' in change) && !('system' in change) && !('type' in change)) return;
      this._handleItemChange(item, 'changed', options, userId);
    };
    this._onDeleteItem = (item, options, userId) => this._handleItemChange(item, 'deleted', options, userId);
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

    const actorTypes = game.documentTypes?.Actor ?? Object.keys(globalThis.CONFIG?.Actor?.dataModels ?? {});
    const npcType = npcActorTypeFor(game.system?.id, actorTypes);
    this._npcType = npcType && npcType !== this._actorType ? npcType : null;
    this._typeSwitch = this._npcType
      ? new ActorTypeSwitch({
        heroType: this._actorType,
        npcType: this._npcType,
        run: (actor, toType, entity) => this._runTypeSwitch(actor, toType, entity),
      })
      : null;

    // Register Foundry hooks for Actor changes (character type only).
    Hooks.on('createActor', this._onCreateActor);
    Hooks.on('updateActor', this._onUpdateActor);
    Hooks.on('deleteActor', this._onDeleteActor);
    Hooks.on('createItem', this._onCreateItem);
    Hooks.on('updateItem', this._onUpdateItem);
    Hooks.on('deleteItem', this._onDeleteItem);
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

    if (msg.type === 'hero_layers.changed') {
      await this._onLayersChanged(msg.resourceId);
      return;
    }

    // Only handle entity events.
    if (!msg.type?.startsWith('entity.')) return;

    const entity = msg.payload;
    if (!entity) return;

    // Filter: only process character-type entities.
    if (!this._isCharacterEntity(entity)) return;

    switch (msg.type) {
      case 'entity.created':
        await this._inTurn(entity.id, () => this._onCharacterCreated(entity));
        break;
      case 'entity.updated':
        await this._inTurn(entity.id, () => this._onCharacterUpdated(entity));
        break;
      case 'entity.deleted':
        await this._inTurn(entity.id, () => this._onCharacterDeleted(entity));
        break;
    }
  }

  /**
   * Run `fn` after the work already queued for this character.
   * @template T
   * @param {string} entityId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @private
   */
  _inTurn(entityId, fn) {
    if (!entityId) return fn();
    const prev = this._entityTurns.get(entityId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this._entityTurns.set(entityId, run);
    run.catch(() => {}).finally(() => {
      if (this._entityTurns.get(entityId) === run) this._entityTurns.delete(entityId);
    });
    return run;
  }

  /** Pages the GM turned sync off for (kept in Chronicle when deleted here). @private */
  _excludedIds() {
    return getSyncExclusions()?.excludedEntities || [];
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
    // An actor the GM deleted here, keeping the page, is not made again.
    if (this._excludedIds().includes(mapping.chronicle_id)) return;

    try {
      const entity = await this._api.get(`/entities/${mapping.chronicle_id}`);
      if (entity && this._isCharacterEntity(entity)) {
        await this._inTurn(entity.id, () => this._onCharacterCreated(entity));
      }
    } catch (err) {
      console.warn('Chronicle: Failed to sync actor mapping', err);
    }
  }

  /** Change-feed area this module reads at connect (see SyncManager). */
  get feedArea() { return 'actors'; }

  /** The settings part whose direction and live switch govern this module. */
  get syncPart() { return 'characters'; }

  /** Waiting changes this module sends on "Sync now". */
  get heldKinds() { return ['actor.create', 'actor.update', 'actor.delete']; }

  /** @returns {'send'|'hold'|'drop'} what to do with a Foundry actor change. @private */
  _pushGate() { return this._syncManager?.pushGate?.('characters') ?? 'send'; }

  /**
   * Send one waiting change. An actor that has gone, or whose link has
   * changed since, has nothing to send.
   * @param {{key: string, kind: string, label: string, data: object}} change
   */
  async sendHeld(change) {
    if (change.kind === 'actor.delete') {
      const entityId = change.data.entityId;
      if (!entityId) return;
      if (change.data.player) {
        const gone = { id: change.key.slice('actor:'.length), name: change.label };
        await this._handlePlayerDelete(gone, entityId, change.data.player);
        return;
      }
      queueRemoteDelete({ label: change.label, run: () => this._api.delete(`/entities/${entityId}`) });
      return;
    }
    const actor = game.actors.get(change.key.slice('actor:'.length));
    if (!actor) return;
    const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
    if (change.kind === 'actor.create') {
      if (!entityId) await this._pushNewActor(actor, game.user.id, { rethrow: true });
      return;
    }
    if (!entityId || entityId !== change.data.entityId) return;
    if (typeof change.data.hidden === 'boolean') await this._pushHidden(actor, entityId, change.data.hidden);
    if (!change.data.change) return;
    this._pendingChanges.set(actor.id, change.data.change);
    if (change.data.players?.length) this._pendingPlayers.set(actor.id, new Set(change.data.players));
    await this._pushActorUpdate(actor, entityId, { rethrow: true });
    // The push records Chronicle's newest version, so the catch-up would pass
    // this character by: take what Chronicle changed while the edit waited now.
    if (this._syncManager?.pullGate?.('characters') !== 'apply') return;
    const entity = await this._api.get(`/entities/${entityId}`);
    if (entity) await this._updateActorFromEntity(actor, entity);
  }

  /** Characters use the feed only while character sync is actually running. */
  feedActive() { return !!(getSetting('syncCharacters') && this._adapter && this._characterTypeId); }

  /**
   * Connect-time catch-up. With the change feed only the characters Chronicle
   * says changed are refetched; without it every character is listed. Either
   * way an actor already at the entity's version is left alone, and a
   * character made in Chronicle since the last sync, while this world was
   * closed, gets its actor now (see _actor-catch-up.mjs). Throws when
   * anything failed, so the feed cursor is not advanced past it.
   *
   * @param {{feed?: {mode: 'delta', changes: object[], createdAfter?: string|null}|{mode: 'full'}}} [opts]
   */
  async onInitialSync({ feed } = {}) {
    if (!this._adapter || !getSetting('syncCharacters')) return;
    if (!this._characterTypeId) return;

    // lastSyncTime is still the previous pass's here: SyncManager writes the
    // new one after every module's onInitialSync.
    const createdAfter = getSetting('lastSyncTime') || null;
    let errors = 0;
    let listed = null;
    if (feed?.mode === 'delta') {
      errors = await this._catchUpFromFeed(feed.changes, feed.createdAfter ?? createdAfter);
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
      listed = allEntities;

      const excluded = this._excludedIds();
      for (const entity of allEntities) {
        this._noteOwner(entity);
        const existingActor = this._findLinkedActor(entity.id);
        if (!existingActor) {
          if (bringsInActor({ entity, createdAfter, excludedIds: excluded })
              && !(await this._bringInActor(entity.id, createdAfter, excluded))) errors++;
          continue;
        }
        if (this._atVersion(existingActor, entity)) continue;
        if (!(await this._inTurn(entity.id, () => this._updateActorFromEntity(existingActor, entity)))) errors++;
      }
    }

    errors += await this._bringInPlayerHeroes();
    await this._clearGmFieldCopies();
    await this._reconcileClaimOwnership();
    await this._placeLooseActors();
    await this._syncAllLayers(feed?.mode === 'delta' ? feed.changes : null);
    try {
      await this._checkActorTypes(listed);
    } catch (err) {
      console.warn('Chronicle: could not check hero and NPC actor types', err);
    }

    // Surface unresolved character links (broken / missing) so the GM can
    // fix them in the dashboard's Characters section rather than silently desyncing.
    try {
      await this._notifySyncIssues({ quick: feed?.mode === 'delta' });
    } catch (err) {
      console.warn('Chronicle: could not check character links', err);
    }
    if (errors > 0) throw new Error(`actor catch-up: ${errors} character(s) failed`);
  }

  /**
   * Make the actor for a character made while this world was closed. The
   * full page is read first: a list row carries no fields, and a feed entry
   * only an id. "Made since" is the page's own created_at, not the feed's
   * `created` entry, which a replay repeats.
   * @param {string} entityId
   * @param {string|null} createdAfter
   * @param {string[]} excluded
   * @returns {Promise<boolean>} false when it failed
   * @private
   */
  async _bringInActor(entityId, createdAfter, excluded) {
    let entity;
    try {
      entity = await this._api.get(`/entities/${entityId}`);
    } catch (err) {
      // Removed again before this connect: nothing to bring in.
      if ((err?.status ?? err?.statusCode) === 404) {
        this._api.dropLastErrorLogEntry?.({ path: `/entities/${entityId}`, status: 404 });
        return true;
      }
      console.warn(`Chronicle: could not read new character ${entityId}`, err);
      return false;
    }
    if (!entity || !this._isCharacterEntity(entity)) return true;
    if (!bringsInActor({ entity, createdAfter, excludedIds: excluded })) return true;
    const made = await this._inTurn(entityId, () => this._onCharacterCreated(entity));
    if (made) this._syncManager?.logActivity?.('create', `"${entity.name}" was made in Chronicle while Foundry was closed; its actor was created`);
    return made !== false;
  }

  /**
   * Apply the characters the change feed lists to their linked actors, and
   * make the actor for one created since the last sync (`createdAfter`).
   * A removed character unlinks its actor (the actor is kept).
   * @param {object[]} changes
   * @param {string|null} createdAfter
   * @returns {Promise<number>} how many failed
   * @private
   */
  async _catchUpFromFeed(changes, createdAfter = null) {
    let errors = 0;
    const excluded = this._excludedIds();
    const created = new Set();
    for (const [entityId, op] of collapseChanges(changes, 'entity')) {
      const actor = this._findLinkedActor(entityId);
      if (!actor) {
        if (op === 'created' && createdAfter && !excluded.includes(entityId)) created.add(entityId);
        continue;
      }
      if (op === 'deleted') {
        await this._onCharacterDeleted({ id: entityId });
        continue;
      }
      let entity;
      try {
        entity = await this._api.get(`/entities/${entityId}`);
      } catch (err) {
        if ((err?.status ?? err?.statusCode) === 404) {
          this._api.dropLastErrorLogEntry?.({ path: `/entities/${entityId}`, status: 404 });
          this._syncManager?.logActivity?.('unlink', `"${actor.name}" is gone from Chronicle; the actor was unlinked`);
          await this._onCharacterDeleted({ id: entityId });
        } else {
          errors++;
          console.warn(`Chronicle: catch-up failed for character ${entityId}`, err);
        }
        continue;
      }
      if (!entity || !this._isCharacterEntity(entity) || this._atVersion(actor, entity)) continue;
      if (!(await this._inTurn(entityId, () => this._updateActorFromEntity(actor, entity)))) errors++;
    }
    if (created.size) {
      // The feed names pages of every kind; one list of the characters picks
      // out the new ones, instead of reading every new page here.
      const characters = await this._listCharacterEntities();
      if (this._characterListFailed) errors++;
      for (const row of characters) {
        if (!created.has(row.id) || !bringsInActor({ entity: row, createdAfter, excludedIds: excluded })) continue;
        if (!(await this._bringInActor(row.id, createdAfter, excluded))) errors++;
      }
    }
    return errors;
  }

  /**
   * Give the Foundry user mapped to a character's Chronicle owner OWNER on
   * the actor. Runs on the GM's client only; the write carries the apply
   * option so no hook reports it back. It
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
          syncOptions({ [APPLY_OPTION]: true })
        );
      }
      if (!plan.unmapped) await this._assignCharacter(actor, getUserMappings()[ownerId]);
      for (const staleId of plan.staleOwnerUserIds) {
        ui.notifications?.warn(game.i18n.format('CHRONICLE.ActorSync.PreviousOwnerKept', {
          actor: noticeText(actor.name),
          player: noticeText(game.users?.get?.(staleId)?.name ?? staleId),
        }));
      }
      if (plan.unmapped) {
        // They may have joined since connect: read the members again and
        // match. Not awaited, since that re-applies claims, this one included.
        this._syncManager?.refreshMembersForClaim?.()?.catch?.((err) => console.warn('Chronicle: could not read members again', err));
        if (!this._unmappedNoticed.has(ownerId)) {
          this._unmappedNoticed.add(ownerId);
          ui.notifications?.warn(game.i18n.format('CHRONICLE.ActorSync.ClaimantUnmapped', { actor: noticeText(actor.name) }));
        }
      }
    } catch (err) {
      console.error(`Chronicle: could not apply the owner of "${actor.name}"`, err);
    }
  }

  /**
   * Make the claimed actor the player's assigned character when they have
   * none, so Foundry's character tools find it. Never replaces one the GM
   * assigned, and never throws.
   * @param {Actor} actor
   * @param {string|null} userId - the claimant's Foundry user.
   * @private
   */
  async _assignCharacter(actor, userId) {
    try {
      const user = userId ? game.users?.get?.(userId) : null;
      if (typeof user?.update !== 'function') return;
      const actorIds = (game.actors?.contents ?? []).map((a) => a.id);
      if (!assignsCharacter({ user, actorId: actor?.id ?? null, actorIds })) return;
      await user.update({ character: actor.id });
    } catch (err) {
      console.warn(`Chronicle: could not make "${actor?.name}" the assigned character`, err);
    }
  }

  /**
   * Apply cached claims again after a member was linked to a Foundry user
   * (SyncManager calls this), so the player owns their actor at once.
   */
  async reconcileOwnership() {
    if (!this._adapter || !getSetting('syncCharacters')) return;
    // A newly linked player may have a claimed hero with no actor yet; making
    // one is a pull, so it waits while characters take nothing from Chronicle.
    if ((this._syncManager?.pullGate?.('characters') ?? 'apply') === 'apply') await this._bringInPlayerHeroes();
    await this._reconcileClaimOwnership();
  }

  /**
   * Make the actors `planPlayerHeroes` picks: a claimed hero whose player is
   * linked here and plays no hero in this world. Claims come from the members
   * list (each member's character) and from live claims that waited for a link.
   * @param {Array<{entityId: string, ownerKey: string}>} [extra] - claims to try first.
   * @returns {Promise<number>} how many failed
   * @private
   */
  async _bringInPlayerHeroes(extra = []) {
    if (!isActiveGM() || !this._adapter || !this._characterTypeId) return 0;
    const waiting = [...this._claimsWaiting].map(([ownerKey, entityId]) => ({ entityId, ownerKey }));
    const claims = [...extra, ...waiting, ...memberClaims(this._syncManager?.getMembers?.() ?? [], memberKey)];
    if (!claims.length) return 0;
    const actors = game.actors?.contents ?? [];
    const users = game.users?.contents ?? Array.from(game.users ?? []);
    const plan = planPlayerHeroes({
      claims,
      mappings: getUserMappings(),
      users: users.map((u) => ({ id: u.id, isGM: !!u.isGM })),
      linkedEntityIds: actors.map((a) => a.getFlag?.(FLAG_SCOPE, 'entityId')).filter(Boolean),
      excludedIds: this._excludedIds(),
      heroUserIds: usersWithHero({ actors, users, actorType: this._actorType, ownerLevel: CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3 }),
    });
    let errors = 0;
    for (const { entityId, ownerKey } of plan) {
      if (this._claimsWaiting.get(ownerKey) === entityId) this._claimsWaiting.delete(ownerKey);
      const made = await this._inTurn(entityId, () => this._bringInHero(entityId, ownerKey));
      if (made === false) errors++;
    }
    return errors;
  }

  /**
   * Read a claimed hero and make its actor, if it is still a character, still
   * that member's, and still has no actor.
   * @returns {Promise<boolean|null>} true when made, null when not needed, false on failure
   * @private
   */
  async _bringInHero(entityId, ownerKey) {
    if (this._findLinkedActor(entityId)) return null;
    let entity;
    try {
      entity = await this._api.get(`/entities/${entityId}`);
    } catch (err) {
      if ((err?.status ?? err?.statusCode) === 404) {
        this._api.dropLastErrorLogEntry?.({ path: `/entities/${entityId}`, status: 404 });
        return null;
      }
      console.warn(`Chronicle: could not read the claimed hero ${entityId}`, err);
      return false;
    }
    if (!entity || !this._isCharacterEntity(entity) || String(entity.owner_user_id ?? '') !== ownerKey) return null;
    return this._makeClaimedActor(entity);
  }

  /**
   * A hero was claimed (or changed) in Chronicle and has no actor here. Its
   * player gets it when they play no hero in this world; one whose claimant
   * has no Foundry user yet waits for the link.
   * Runs inside the page's turn already, so it must not queue another.
   * @param {object} entity
   * @private
   */
  async _bringInClaimed(entity) {
    const ownerKey = entity?.owner_user_id ? String(entity.owner_user_id) : '';
    if (!isActiveGM() || !entity?.id || !ownerKey) return;
    if (this._excludedIds().includes(entity.id)) return;
    const mappings = getUserMappings();
    if (!game.users?.get?.(mappings[ownerKey])) {
      this._claimsWaiting.set(ownerKey, entity.id);
      // They may have joined the campaign since connect.
      this._syncManager?.refreshMembersForClaim?.()?.catch?.((err) => console.warn('Chronicle: could not read members again', err));
      return;
    }
    const actors = game.actors?.contents ?? [];
    const users = game.users?.contents ?? Array.from(game.users ?? []);
    const plan = planPlayerHeroes({
      claims: [{ entityId: entity.id, ownerKey }],
      mappings,
      users: users.map((u) => ({ id: u.id, isGM: !!u.isGM })),
      linkedEntityIds: actors.map((a) => a.getFlag?.(FLAG_SCOPE, 'entityId')).filter(Boolean),
      excludedIds: this._excludedIds(),
      heroUserIds: usersWithHero({ actors, users, actorType: this._actorType, ownerLevel: CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3 }),
    });
    if (plan.length) await this._makeClaimedActor(entity);
  }

  /** Make a claimed hero's actor and say so in History. @private */
  async _makeClaimedActor(entity) {
    const made = await this._onCharacterCreated(entity);
    if (made) this._syncManager?.logActivity?.('create', `"${entity.name}" is claimed in Chronicle by a player with no hero here; its actor was created`);
    return made;
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
      if (!this._isCharacterActor(actor) || !actor.getFlag(FLAG_SCOPE, 'entityId')) continue;
      const owner = this._ownerFromChronicle(actor.getFlag(FLAG_SCOPE, 'entityId'));
      if (!owner) continue;
      await this._applyClaimOwnership(actor, owner, owner);
    }
  }

  /** Remember who Chronicle says claimed a page, when the copy says. @private */
  _noteOwner(entity) {
    if (entity?.id && Object.prototype.hasOwnProperty.call(entity, 'owner_user_id')) {
      this._chronicleOwners.set(entity.id, entity.owner_user_id == null ? null : String(entity.owner_user_id));
    }
  }

  /**
   * Who claimed a page, from what Chronicle sent: the page itself, else the
   * member list's characters. Null when Chronicle hasn't said.
   * @param {string} entityId
   * @returns {string|null}
   * @private
   */
  _ownerFromChronicle(entityId) {
    if (!entityId) return null;
    if (this._chronicleOwners.has(entityId)) return this._chronicleOwners.get(entityId);
    const member = (this._syncManager?.getMembers?.() ?? []).find((m) => m?.character_entity_id === entityId);
    return member ? memberKey(member) : null;
  }

  /** The adapter's field defs, identity ones included, which tell a hero page from an NPC's. @private */
  _heroFieldDefs() {
    return [...(this._adapter?.fieldDefs ?? []), ...(this._adapter?.identityFields ?? [])];
  }

  /** Whether this is an NPC actor made for a character page (an unlinked one is the GM's own). @private */
  _isLinkedNpc(actor) {
    return !!this._npcType && actor?.type === this._npcType && !!actor.getFlag?.(FLAG_SCOPE, 'entityId');
  }

  /** Whether this module syncs the actor: the hero type, or an NPC made for a character page. @private */
  _isCharacterActor(actor) {
    return actor?.type === this._actorType || this._isLinkedNpc(actor);
  }

  /**
   * Offer the GM a switch when a linked actor's type no longer fits its
   * page (see switchTarget). Never switches anything by itself.
   * @param {Actor} actor
   * @param {object} entity
   * @returns {boolean} whether the actor was offered
   * @private
   */
  _checkActorType(actor, entity) {
    if (!this._typeSwitch || !actor?.getFlag?.(FLAG_SCOPE, 'entityId')) return false;
    const items = (actor.items?.contents ?? Array.from(actor.items ?? [])).map((i) => ({ type: i.type }));
    const toType = switchTarget({
      actor: { type: actor.type, hasPlayerOwner: !!actor.hasPlayerOwner, items },
      entity,
      pcSubtypeId: this._pcSubtypeId,
      fieldDefs: this._heroFieldDefs(),
      heroType: this._actorType,
      npcType: this._npcType,
    });
    return !!toType && this._typeSwitch.offer(actor, toType, entity);
  }

  /**
   * Check every linked actor's type against its page. The actors made before
   * sync told heroes and NPCs apart are found once per world when the connect
   * reads no full character list; after that each page is checked as it is
   * applied.
   * @param {object[]|null} entities - the full character list, when this connect read it
   * @private
   */
  async _checkActorTypes(entities) {
    if (!this._typeSwitch || !isAnsweringGM(game.user, game.users?.activeGM)) return;
    let list = entities;
    if (!list) {
      if (getSetting('actorTypesChecked')) return;
      list = await this._listCharacterEntities();
      if (this._characterListFailed) return;
    }
    const byId = new Map(list.map((e) => [e.id, e]));
    let offered = false;
    for (const actor of game.actors?.contents ?? []) {
      if (!this._isCharacterActor(actor)) continue;
      const entity = byId.get(actor.getFlag(FLAG_SCOPE, 'entityId'));
      if (entity && this._checkActorType(actor, entity)) offered = true;
    }
    if (getSetting('actorTypesChecked')) return;
    if (!offered) {
      await setSetting('actorTypesChecked', true);
      return;
    }
    // Marked once the GM has answered (not awaited, so the connect does not
    // wait on the GM): a question Foundry closed on unanswered is asked again.
    this._typeSwitch.flush()
      .then(() => setSetting('actorTypesChecked', true))
      .catch((err) => console.warn('Chronicle: could not record the actor type check', err));
  }

  /**
   * Switch one actor the GM said yes to. A new hero then takes its page's
   * hero fields, choices and class pick, as a hero made from the page would.
   * @param {Actor} actor
   * @param {string} toType
   * @param {object} entity
   * @private
   */
  async _runTypeSwitch(actor, toType, entity) {
    await this._inTurn(entity.id, async () => {
      await switchActorType(actor, toType, { heroType: this._actorType });
      if (toType !== this._actorType) return;
      const page = await this._api.get(`/entities/${entity.id}`);
      if (page) await this._updateActorFromEntity(actor, page);
    });
  }

  /**
   * Empties GM-only text an earlier sync wrote onto linked characters, where
   * their players could read it (_gm-field-clear.mjs). Only a character still
   * holding text at such a path costs a fetch. Text that is not Chronicle's
   * stays, and the GM is told once which characters to check. A failed check
   * is retried on the next connect; it does not hold back the change feed.
   * @private
   */
  async _clearGmFieldCopies() {
    const fields = this._adapter?.gmClearFields;
    if (!fields?.length) return;
    const toCheck = game.actors.filter((a) => this._isCharacterActor(a)
      && !!a.getFlag(FLAG_SCOPE, 'entityId') && holdsGmFieldText(a, fields));
    const kept = [];
    const told = { ...(getSetting('gmTextTold') || {}) };
    for (const actor of toCheck) {
      const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
      try {
        await this._inTurn(entityId, async () => {
          const entity = await this._api.get(`/entities/${entityId}`);
          if (!entity) return;
          const plan = planGmFieldClear({ actor, entity, fields });
          if (Object.keys(plan.update).length > 0) {
            await actor.update(plan.update, syncOptions({ [APPLY_OPTION]: true }));
          }
          if (plan.keptMark && told[actor.id] !== plan.keptMark) {
            kept.push(actor.name);
            told[actor.id] = plan.keptMark;
          }
        });
      } catch (err) {
        console.warn(`Chronicle: could not check "${actor.name}" for GM-only text`, err);
      }
    }
    if (kept.length > 0) {
      await setSetting('gmTextTold', told);
      const notice = game.i18n.format('CHRONICLE.Notifications.GmFieldTextLeft', { names: noticeText(kept.join(', ')) });
      ui.notifications.warn(notice, { permanent: true });
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
   * The actor's effects that sync made for Chronicle layers.
   * @returns {{id: string, flag: object}[]}
   * @private
   */
  _layerEffects(actor) {
    const out = [];
    for (const e of actor?.effects?.contents ?? []) {
      const flag = e.getFlag?.(FLAG_SCOPE, LAYER_FLAG);
      if (flag) out.push({ id: e.id, flag });
    }
    return out;
  }

  /**
   * The hero's level for a layer's `"@level"`: the actor's own when the
   * adapter maps one (Foundry leads it), else Chronicle's.
   * @private
   */
  _heroLevel(actor, fields) {
    const def = (this._adapter?.fieldDefs ?? []).find((f) => f.key === 'level');
    const own = def ? Number(buildChronicleFields(actor, [def]).level) : NaN;
    if (Number.isFinite(own) && own > 0) return own;
    const chr = Number(fields?.level);
    return Number.isFinite(chr) ? chr : 0;
  }

  /**
   * Make the actor carry one effect per layer. The writes are marked as
   * sync's own, and only effects sync made are changed or removed.
   * @private
   */
  async _applyLayers(actor, layers, level) {
    const plan = planLayerEffects({
      layers, fieldDefs: this._adapter?.fieldDefs ?? [], level, existing: this._layerEffects(actor), scope: FLAG_SCOPE,
    });
    if (plan.remove.length) await actor.deleteEmbeddedDocuments('ActiveEffect', plan.remove, syncOptions({ [APPLY_OPTION]: true }));
    if (plan.update.length) await actor.updateEmbeddedDocuments('ActiveEffect', plan.update, syncOptions({ [APPLY_OPTION]: true }));
    if (plan.create.length) await actor.createEmbeddedDocuments('ActiveEffect', plan.create, syncOptions({ [APPLY_OPTION]: true }));
  }

  /**
   * Read a hero's layers from Chronicle and redraw its effects. A 403
   * `addon_disabled` means the add-on is off and a 404 that this Chronicle
   * has none (an owner key sees every page); either way reads stop until
   * Chronicle next says a layer changed, and the answer is kept out of the
   * dashboard's error log because it is expected.
   * @returns {Promise<boolean>} false when the read or a write failed
   * @private
   */
  async _syncLayers(actor, entityId) {
    if (this._layersOff) return true;
    let res;
    try {
      res = await this._api.get(`/entities/${entityId}/layers`);
    } catch (err) {
      if (err?.status === 404 || (err?.status === 403 && err?.code === 'addon_disabled')) {
        this._api.dropLastErrorLogEntry?.({ path: `/entities/${entityId}/layers`, status: [403, 404] });
        this._layersOff = true;
        return true;
      }
      console.warn(`Chronicle: could not read the transformations on "${actor.name}"`, err);
      return false;
    }
    try {
      await this._applyLayers(actor, Array.isArray(res?.layers) ? res.layers : [], this._heroLevel(actor, null));
      return true;
    } catch (err) {
      console.error(`Chronicle: could not update the transformation effects on "${actor.name}"`, err);
      return false;
    }
  }

  /** Chronicle put a layer on a page or took one off. @private */
  async _onLayersChanged(entityId) {
    if (!entityId) return;
    const actor = this._findLinkedActor(entityId);
    if (!actor || actor.type !== this._actorType) return;
    this._layersOff = false;
    await this._syncLayers(actor, entityId);
  }

  /**
   * Connect-time read of layers changed while Foundry was closed: with the
   * change feed, only the heroes it lists under `hero_layers`; without it,
   * every linked hero. A failure is logged and does not hold the feed
   * cursor back, because the next change or connect reads that hero again.
   * @param {object[]|null} changes - the feed's changes, or null for a full read
   * @private
   */
  async _syncAllLayers(changes) {
    this._layersOff = false;
    const listed = changes ? new Set(collapseChanges(changes, 'hero_layers').keys()) : null;
    for (const actor of game.actors?.contents ?? []) {
      if (this._layersOff) return;
      const entityId = actor.type === this._actorType && actor.getFlag(FLAG_SCOPE, 'entityId');
      if (entityId && (!listed || listed.has(entityId))) await this._syncLayers(actor, entityId);
    }
  }

  /**
   * Redraw the layer effects from the layers they were made from, after a
   * Chronicle copy is applied, so a `"@level"` follows the hero's level
   * without another read.
   * @private
   */
  async _replanLayers(actor, entity) {
    const existing = this._layerEffects(actor);
    if (existing.length === 0) return;
    await this._applyLayers(actor, storedLayers(existing), this._heroLevel(actor, entity?.fields_data));
  }

  /**
   * Fields with a layer effect on them are left out of a push (see
   * layeredFieldKeys).
   * @private
   */
  _withoutLayered(actor, fields) {
    if (!fields) return fields;
    const keys = layeredFieldKeys(this._layerEffects(actor));
    if (keys.size === 0) return fields;
    const out = {};
    for (const [k, v] of Object.entries(fields)) if (!keys.has(k)) out[k] = v;
    return out;
  }

  /**
   * Clean up hooks on destroy.
   */
  destroy() {
    Hooks.off('createActor', this._onCreateActor);
    Hooks.off('updateActor', this._onUpdateActor);
    Hooks.off('deleteActor', this._onDeleteActor);
    Hooks.off('createItem', this._onCreateItem);
    Hooks.off('updateItem', this._onUpdateItem);
    Hooks.off('deleteItem', this._onDeleteItem);
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
   * @returns {Promise<boolean|null>} true when an actor was made, null when
   *   none was needed, false when making it failed.
   * @private
   */
  async _onCharacterCreated(entity) {
    // Check if an actor is already linked.
    const existing = game.actors.find(
      (a) => a.getFlag(FLAG_SCOPE, 'entityId') === entity.id
    );
    if (existing) return null;

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
        return null;
      }
    }

    try {
      const type = actorTypeForPage({
        entity, pcSubtypeId: this._pcSubtypeId, fieldDefs: this._heroFieldDefs(), heroType: this._actorType, npcType: this._npcType,
      });
      const asNpc = type !== this._actorType;
      const actorData = {
        name: entity.name,
        type,
        flags: {
          [FLAG_SCOPE]: {
            entityId: entity.id,
            lastSync: new Date().toISOString(),
            chronicleOwnerUserId: entity.owner_user_id ?? null,
          },
        },
      };

      // Apply adapter field mapping. An NPC takes none: the hero fields are
      // not an NPC's, and its stat block is the GM's. A private page's NPC
      // starts hidden, as the visibility sync would make it.
      const fieldUpdate = asNpc ? null : this._adapter.fromChronicleFields(entity);
      if (asNpc) _setNestedValue(actorData, 'prototypeToken.hidden', entity.is_private === true);
      if (fieldUpdate) {
        // Merge dot-notation fields into nested structure for creation.
        for (const [key, value] of Object.entries(fieldUpdate)) {
          if (key === 'name') continue; // Already set above.
          _setNestedValue(actorData, key, value);
        }
      }

      for (const [path, value] of Object.entries(await this._picturePlan(entity, null))) {
        _setNestedValue(actorData, path, value);
      }

      const actor = await Actor.create(actorData, applyOptions());
      if (!asNpc) {
        await this._applyIdentityItems(actor, entity);
        await this._recordClassPick(actor, entity);
        await this._syncLayers(actor, entity.id);
      }
      await this._applyClaimOwnership(actor, entity.owner_user_id ?? null, null);
      await this._placeInFolder(actor, entity);

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
      return true;
    } catch (err) {
      console.error('Chronicle: Failed to create actor from entity', err);
      return false;
    }
  }

  /**
   * The portrait and token changes for a hero page, copying its pictures into
   * the world first. Never throws: a picture that can't be copied leaves the
   * actor as it is and is retried on the next pull.
   * @param {object} entity
   * @param {Actor|null} actor null for an actor not yet made
   * @returns {Promise<object>} dot-path changes, possibly empty
   * @private
   */
  async _picturePlan(entity, actor) {
    try {
      const choice = heroChoice(entity);
      const ids = heroPictureIds(choice);
      if (ids.length === 0) return {};
      const applied = actor?.getFlag(FLAG_SCOPE, HERO_PICTURES_FLAG) || null;
      if (applied && applied.img === choice.img && applied.token === choice.token) return {};
      const current = actor ? { img: actor.img, token: actor.prototypeToken?.texture?.src } : null;
      this._pictures ??= new PictureStore({ api: this._api });
      const local = await this._pictures.ensure(ids);
      return heroPicturePlan({ choice, local, applied, current });
    } catch (err) {
      console.warn(`Chronicle: could not bring in the pictures for "${entity?.name ?? entity?.id}"`, err);
      return {};
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
    if (!actor) {
      await this._bringInClaimed(entity);
      return;
    }
    await this._updateActorFromEntity(actor, entity);
  }

  /**
   * Note Chronicle's class pick on an actor whose sheet has no class item, so
   * its player is offered "Finish your hero" (finish-hero.mjs). Sync never
   * embeds the class itself: the system's level-up steps build it.
   * @param {Actor} actor
   * @param {object} entity
   * @private
   */
  async _recordClassPick(actor, entity) {
    if (!game.user?.isGM) return;
    try {
      const items = actor.items?.contents ?? Array.from(actor.items ?? []);
      const next = pickToFinish(items, classPick(this._adapter?.fieldDefs, entity?.fields_data));
      const current = actor.getFlag?.(FLAG_SCOPE, CLASS_PICK_FLAG) ?? null;
      if (pickChanged(current, next)) await this._setActorFlag(actor, CLASS_PICK_FLAG, next);
      // A subclass picked in Chronicle (a conduit's second domain) is noted
      // the same way and added through the system's own drop, never embedded.
      const subNext = subclassesToFinish(items, subclassPicks(this._adapter?.fieldDefs, entity?.fields_data));
      const subCurrent = actor.getFlag?.(FLAG_SCOPE, SUBCLASS_PICK_FLAG) ?? null;
      if (subclassPickChanged(subCurrent, subNext)) await this._setActorFlag(actor, SUBCLASS_PICK_FLAG, subNext);
    } catch (err) {
      console.warn(`Chronicle: could not note the class pick on "${actor.name}"`, err);
    }
  }

  /**
   * Swap the actor's ancestry/culture/career/kit items to the ones Chronicle
   * names. The writes carry the apply options so the item hooks do not push
   * them back. Only the GM's client does it, and a failure is one notice,
   * never a thrown error.
   * @param {Actor} actor
   * @param {object} entity
   * @private
   */
  async _applyIdentityItems(actor, entity) {
    if (!game.user?.isGM) return;
    try {
      const items = actor.items?.contents ?? Array.from(actor.items ?? []);
      const fieldDefs = this._adapter.identityFields ?? [];
      const applied = actor.getFlag?.(FLAG_SCOPE, IDENTITY_APPLIED_FLAG) ?? null;
      const plan = planIdentityItems({ items, fieldDefs, fieldsData: entity?.fields_data, applied });
      // Campaign entries are read only for a field that may make an item, or
      // whose item sync made earlier and may need its text refreshed.
      const planned = new Set(plan.map((step) => step.fieldKey));
      const madeFields = identityFieldTypes(fieldDefs).filter(({ fieldKey, itemType }) => {
        if (planned.has(fieldKey)) return false;
        const first = items.find((it) => it?.type === itemType);
        return !!first?.flags?.[FLAG_SCOPE]?.chronicleMade;
      });
      const picks = identityPicks(fieldDefs, entity?.fields_data);
      const recordPicks = async (failedKeys) => {
        // A failed swap keeps the older pick, so the next apply tries again.
        const next = { ...(applied ?? {}) };
        for (const [key, name] of Object.entries(picks)) if (!failedKeys.includes(key)) next[key] = name;
        // An empty record still counts: it ends the first apply, after which a
        // new pick is Chronicle's change and replaces the actor's item.
        if (applied == null || JSON.stringify(next) !== JSON.stringify(applied)) {
          await this._setActorFlag(actor, IDENTITY_APPLIED_FLAG, next);
        }
      };
      if (!plan.length && !madeFields.length) {
        await recordPicks([]);
        return;
      }
      const entriesByField = await this._campaignEntries([...planned, ...madeFields.map((f) => f.fieldKey)]);

      const failed = [];
      if (plan.length) {
        failed.push(...(await applyIdentityPlan(actor, plan, game, entriesByField)).failed);
      }
      await recordPicks(failed);
      const refresh = planEntryRefresh({
        items, fields: madeFields, fieldsData: entity?.fields_data, entriesByField, mentionId: journalMentions(game),
      });
      try {
        await applyEntryRefresh(actor, refresh);
      } catch (err) {
        console.error(`Chronicle: could not refresh campaign entries on "${actor.name}"`, err);
        failed.push(...refresh.map((r) => r.fieldKey));
      }
      if (failed.length) {
        ui.notifications?.warn(game.i18n.format('CHRONICLE.ActorSync.IdentityItemFailed', {
          actor: noticeText(actor.name),
          fields: noticeText(failed.join(', ')),
        }));
      }
    } catch (err) {
      console.error(`Chronicle: identity items failed for "${actor.name}"`, err);
      ui.notifications?.warn(game.i18n.format('CHRONICLE.ActorSync.IdentityItemFailed', {
        actor: noticeText(actor.name),
        fields: '',
      }));
    }
  }

  /**
   * The campaign's own pick-list entries for these fields, keyed by field.
   * Cached briefly so a full pull reads each field once, not once per actor.
   * An older Chronicle without the route (404) is remembered and never asked
   * again this session; any other failure leaves the items name-only.
   * @param {string[]} fieldKeys
   * @returns {Promise<Record<string, Array<object>>>}
   * @private
   */
  async _campaignEntries(fieldKeys) {
    const out = {};
    if (!this._api || this._entriesUnsupported) return out;
    this._entryCache ??= new Map();
    const now = Date.now();
    for (const key of new Set(fieldKeys)) {
      const hit = this._entryCache.get(key);
      if (hit && now - hit.at < ENTRY_CACHE_MS) {
        out[key] = hit.list;
        continue;
      }
      try {
        const raw = await this._api.get(`/system-entries?fieldKey=${encodeURIComponent(key)}`);
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
        this._entryCache.set(key, { at: now, list });
        out[key] = list;
      } catch (err) {
        if (err?.status === 404) {
          this._entriesUnsupported = true;
          return out;
        }
        console.warn(`Chronicle: could not read the campaign's ${key} entries`, err);
      }
    }
    return out;
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
      // Only values that differ are written, marked as ours so the update
      // hook does not push them back. An NPC takes only its name.
      const npc = this._isLinkedNpc(actor);
      const changes = planActorApply({
        update: npc ? (entity.name ? { name: entity.name } : {}) : this._adapter.fromChronicleFields(entity),
        actor,
      });
      // A field with a local edit still waiting in the push debounce, or
      // being pushed, keeps that edit: the incoming value predates it.
      for (const local of [this._pendingChanges.get(actor.id), this._pushingChanges.get(actor.id)]) {
        if (!local) continue;
        for (const path of Object.keys(changes)) {
          if (changeTouchesPath(local, path)) delete changes[path];
        }
      }
      if (!npc) Object.assign(changes, planGmFieldClear({ actor, entity, fields: this._adapter.gmClearFields }).update);
      // Likewise a picture chosen in Foundry and not yet sent, or being sent,
      // stays: Chronicle's pictures here predate it.
      const sendingPictures = this._sendingPictures.has(actor.id)
        || [this._pendingChanges, this._pushingChanges].some((m) => m.get(actor.id)?.[PICTURES_CHANGED]);
      if (!sendingPictures) Object.assign(changes, await this._picturePlan(entity, actor));
      if (Object.keys(changes).length > 0) {
        await actor.update(changes, syncOptions({ [APPLY_OPTION]: true }));
      }

      if (!npc) {
        await this._applyIdentityItems(actor, entity);
        await this._recordClassPick(actor, entity);
        await this._replanLayers(actor, entity);
      }

      // Sync visibility: Chronicle is_private → Foundry actor hidden.
      // A private entity means the NPC is hidden from players.
      const shouldBeHidden = entity.is_private === true;
      if (actor.hidden !== shouldBeHidden) {
        // Update the actor's default token hidden state and active tokens.
        await actor.update({ 'prototypeToken.hidden': shouldBeHidden }, applyOptions());
        console.debug(
          `Chronicle: ${shouldBeHidden ? 'Hid' : 'Revealed'} actor "${actor.name}" (visibility sync)`
        );
      }

      // Update sync timestamp and Chronicle updated_at for conflict detection.
      await this._setActorFlag(actor, 'lastSync', new Date().toISOString());
      if (entity.updated_at) {
        await this._setActorFlag(actor, 'chronicleUpdatedAt', entity.updated_at);
      }
      // Cache claim status for the actor-sheet indicator; falls through
      // `null` when unclaimed so the indicator shows "Unclaimed" rather
      // than stale data.
      if (Object.prototype.hasOwnProperty.call(entity, 'owner_user_id')) {
        this._noteOwner(entity);
        const previousOwner = actor.getFlag(FLAG_SCOPE, 'chronicleOwnerUserId') ?? null;
        const nextOwner = entity.owner_user_id ?? null;
        await this._setActorFlag(actor, 'chronicleOwnerUserId', nextOwner);
        await this._applyClaimOwnership(actor, nextOwner, previousOwner);
      }
      await this._placeInFolder(actor, entity);
      this._checkActorType(actor, entity);

      console.debug(`Chronicle: Updated actor "${actor.name}" from entity`);
      return true;
    } catch (err) {
      console.error(`Chronicle: Failed to update actor "${actor.name}"`, err);
      return false;
    }
  }

  /**
   * Put a Chronicle character's actor into the Heroes or NPCs folder, once,
   * and only while it sits outside every folder. A failure leaves it loose.
   * @param {Actor} actor
   * @param {object} entity
   * @private
   */
  async _placeInFolder(actor, entity) {
    try {
      if (!needsPlacing(actor, FLAG_SCOPE)) return;
      const kind = folderKindFor({ entity, actor, pcSubtypeId: this._pcSubtypeId });
      const folder = await this._actorFolder(kind);
      if (!folder) return;
      await actor.update({
        folder: folder.id,
        [`flags.${FLAG_SCOPE}.${FOLDER_PLACED_FLAG}`]: true,
      }, syncOptions({ [APPLY_OPTION]: true }));
    } catch (err) {
      console.warn(`Chronicle: could not place "${actor?.name}" in a folder`, err);
    }
  }

  /** Sort linked actors that were made before folders existed. */
  async _placeLooseActors() {
    for (const actor of game.actors.contents) {
      const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
      if (!entityId || !this._isCharacterActor(actor)) continue;
      await this._placeInFolder(actor, { owner_user_id: actor.getFlag(FLAG_SCOPE, 'chronicleOwnerUserId') ?? null });
    }
  }

  /** One folder per kind, even when two actors arrive at once. */
  _actorFolder(kind) {
    this._folderPromises ??= {};
    this._folderPromises[kind] ??= (async () => {
      const found = game.folders.find((f) => f.type === 'Actor' && f.getFlag(FLAG_SCOPE, ACTOR_FOLDER_FLAG) === kind);
      if (found) return found;
      return Folder.create({
        name: game.i18n.localize(kind === HEROES ? 'CHRONICLE.Actors.HeroesFolder' : 'CHRONICLE.Actors.NpcsFolder'),
        type: 'Actor',
        flags: { [FLAG_SCOPE]: { [ACTOR_FOLDER_FLAG]: kind } },
      }, syncOptions());
    })().finally(() => { delete this._folderPromises[kind]; });
    return this._folderPromises[kind];
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
      await actor.update(flagRemoval(FLAG_SCOPE, 'entityId', 'lastSync'), applyOptions());
      console.debug(`Chronicle: Unlinked actor "${actor.name}" (entity deleted)`);
    } catch (err) {
      console.error('Chronicle: Failed to unlink actor after entity deletion', err);
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
    // An actor a player makes never arrives linked: the link is theirs to
    // write and would aim their later pushes at someone else's character.
    // Checked before the apply skip, since their client can send that option.
    const byOther = userId !== game.user.id;
    if (byOther && sendsChangeHere(userId) && actor.getFlag(FLAG_SCOPE, 'entityId')) await this._unlinkCopy(actor);
    if (options?.[APPLY_OPTION]) return;

    // A copy (Duplicate, an import of an export) carries the original's link,
    // and its items the original's relations. Two actors on one character
    // would overwrite each other's pushes, so the copy starts unlinked.
    const linkedTo = actor.getFlag(FLAG_SCOPE, 'entityId');
    if (linkedTo && !byOther) {
      if (!game.actors.find((a) => a.id !== actor.id && a.getFlag(FLAG_SCOPE, 'entityId') === linkedTo)) return;
      await this._unlinkCopy(actor);
    }
    // A player's new character is theirs, so the active GM's client sends it.
    if (!sendsChangeHere(userId)) return;
    if (actor.type !== this._actorType) return;
    if (!this._adapter || !this._characterTypeId) return;

    const gate = this._pushGate();
    if (gate === 'drop') return;
    if (gate === 'hold') {
      this._syncManager.holdChange({ key: `actor:${actor.id}`, part: 'characters', kind: 'actor.create', label: actor.name });
      return;
    }
    await this._pushNewActor(actor, userId);
  }

  /**
   * Make a Chronicle character for an actor created in Foundry, and link them.
   * @param {Actor} actor
   * @param {string} userId - who made it, for the History row.
   * @param {{rethrow?: boolean}} [opts] - rethrow a failure after reporting it.
   * @private
   */
  async _pushNewActor(actor, userId, { rethrow = false } = {}) {
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
        // Cache owner for the claim-status indicator; prefer the server's
        // value if returned, else fall back to what we sent.
        const cachedOwner = entity.owner_user_id ?? ownerUserId ?? null;
        await actor.update({
          [`flags.${FLAG_SCOPE}.entityId`]: entity.id,
          [`flags.${FLAG_SCOPE}.lastSync`]: new Date().toISOString(),
          [`flags.${FLAG_SCOPE}.chronicleOwnerUserId`]: cachedOwner,
        }, applyOptions());

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

        if (await this._pushPictures(actor, entity.id)) await this._refreshChronicleVersion(actor, entity.id);
        console.debug(`Chronicle: Pushed new actor "${actor.name}" to Chronicle`);
        this._syncManager?.recordUserOutcome?.(userId);
      }
    } catch (err) {
      console.error('Chronicle: Failed to push new actor to Chronicle', err);
      this._syncManager?.recordUserOutcome?.(userId, err);
      if (rethrow) throw err;
    } finally {
      this._inFlightCreates.delete(actor.id);
    }
  }

  /**
   * Remove a copied actor's link to the original's character, and its
   * items' links to the original's inventory.
   * @param {Actor} actor
   * @private
   */
  async _unlinkCopy(actor) {
    await actor.update(
      flagRemoval(FLAG_SCOPE, 'entityId', 'lastSync', 'chronicleUpdatedAt', 'chronicleOwnerUserId', IDENTITY_APPLIED_FLAG, CLASS_PICK_FLAG, SUBCLASS_PICK_FLAG),
      applyOptions(),
    );
    const items = (actor.items?.contents ?? [])
      .filter((i) => i.getFlag(FLAG_SCOPE, 'relationId') || i.getFlag(FLAG_SCOPE, 'unlinkedRelationId'));
    for (const item of items) {
      await item.update(flagRemoval(FLAG_SCOPE, 'relationId', 'unlinkedRelationId'), applyOptions());
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
    // A player who owns an actor can rewrite its page link, which would have
    // this client pull another page's fields onto it. Only sync writes the
    // link, so a player's change to it unlinks the actor (as a copy is).
    // Checked before the sync-write option, which a player's client can send.
    if (userId !== game.user.id && sendsChangeHere(userId) && touchesLinkFlags(change, FLAG_SCOPE, ['entityId'])) {
      await this._unlinkCopy(actor);
      const notice = game.i18n.format('CHRONICLE.Notifications.PlayerLinkUndone', { name: noticeText(actor.name) });
      ui.notifications?.warn?.(notice, { permanent: true });
      return;
    }
    if (options?.[APPLY_OPTION]) return;
    if (!sendsChangeHere(userId)) return;
    if (!this._isCharacterActor(actor)) return;
    if (!this._adapter) return;

    const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    // An NPC sends only its name and visibility: its system data is the GM's
    // stat block, not the page's hero fields.
    // A hero's new portrait or token goes to Chronicle as its own kind of
    // change; an NPC's pictures are the GM's stat block art and stay.
    const npc = this._isLinkedNpc(actor);
    const sent = npc ? (change.name !== undefined ? { name: change.name } : {})
      : (changesPictures(change) ? { ...change, [PICTURES_CHANGED]: true } : change);
    const items = sent[ITEMS_CHANGED];
    const pictures = sent[PICTURES_CHANGED];

    // Sync visibility: Foundry prototypeToken.hidden → Chronicle is_private.
    // Await this before field sync to avoid inconsistent state. Who sees a
    // page is the GM's to say: a player's change is sent by this client
    // under the GM's key, and the page id comes from a flag the player can
    // write, so only this GM's own visibility change is sent (another GM's
    // change is sent by that GM's client).
    const byGM = userId === game.user.id;
    const hiddenChanged = byGM && (
      change.prototypeToken?.hidden !== undefined ||
      change.token?.hidden !== undefined);
    const isHidden = hiddenChanged ? (change.prototypeToken?.hidden ?? change.token?.hidden ?? false) : undefined;

    const gate = this._pushGate();
    if (gate === 'drop') return;
    if (gate === 'hold') {
      if (!hiddenChanged && !sent.system && !sent.name && !items && !pictures) return;
      const byPlayer = userId !== game.user.id;
      const diff = sent.system || sent.name !== undefined || items || pictures
        ? {
          ...(sent.system ? { system: sent.system } : {}),
          ...(sent.name !== undefined ? { name: sent.name } : {}),
          ...(items ? { [ITEMS_CHANGED]: items } : {}),
          ...(pictures ? { [PICTURES_CHANGED]: true } : {}),
        }
        : null;
      this._syncManager.holdChange({
        key: `actor:${actor.id}`, part: 'characters', kind: 'actor.update', label: actor.name,
        data: { entityId, change: diff, players: byPlayer ? [userId] : [], ...(hiddenChanged ? { hidden: isHidden } : {}) },
      }, (before, next) => (before.kind !== 'actor.update' ? before.data : {
        ...before.data,
        ...next.data,
        change: next.data.change ? mergeChanges(before.data.change ?? undefined, next.data.change) : (before.data.change ?? null),
        players: [...new Set([...(before.data.players ?? []), ...next.data.players])],
      }));
      return;
    }

    if (hiddenChanged) await this._pushHidden(actor, entityId, isHidden);

    // Only push field/name changes if system data or name changed. The diff
    // is kept (merged with the burst's earlier ones) so the push can send
    // just the mapped fields that changed.
    if (!sent.system && !sent.name && !items && !pictures) return;
    this._pendingChanges.set(actor.id, mergeChanges(this._pendingChanges.get(actor.id), sent));
    this._pendingAuthors.set(actor.id, userId);
    if (userId !== game.user.id) {
      this._pendingPlayers.set(actor.id, (this._pendingPlayers.get(actor.id) ?? new Set()).add(userId));
    }
    this._actorPushDebouncer.schedule(actor.id, actor, entityId);
  }

  /**
   * An embedded item that a single-item field reads (a complication, an
   * ancestry, the class) was made, edited or removed on a linked character.
   * Foundry fires no actor update for that, so it joins the actor's pending
   * push as its own kind of change, with the same gates and debounce.
   * @param {Item} item
   * @param {'changed'|'deleted'} how
   * @param {object} options
   * @param {string} userId
   * @private
   */
  _handleItemChange(item, how, options, userId) {
    if (options?.[APPLY_OPTION]) return;
    const actor = item?.parent;
    if (!actor || actor.documentName !== 'Actor') return;
    if (!this._adapter?.itemFieldTypes?.has(item.type)) return;
    this._handleUpdateActor(actor, { [ITEMS_CHANGED]: { [item.type]: how } }, {}, userId);
  }

  /**
   * Send the actor's hidden state as the Chronicle page's privacy. A failure
   * is logged and the field sync goes on.
   * @param {Actor} actor
   * @param {string} entityId
   * @param {boolean} isHidden
   * @private
   */
  async _pushHidden(actor, entityId, isHidden) {
    try {
      await this._api.post(`/entities/${entityId}/reveal`, { is_private: isHidden });
      console.debug(`Chronicle: ${isHidden ? 'Hid' : 'Revealed'} page for actor "${actor.name}" (Foundry → Chronicle)`);
    } catch (err) {
      console.error('Chronicle: Failed to sync visibility to Chronicle', err);
    }
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
  async _pushActorUpdate(actor, entityId, { rethrow = false } = {}) {
    const change = this._pendingChanges.get(actor.id) || {};
    this._pendingChanges.delete(actor.id);
    const author = this._pendingAuthors.get(actor.id) ?? game.user.id;
    this._pendingAuthors.delete(actor.id);
    const players = this._pendingPlayers.get(actor.id);
    this._pendingPlayers.delete(actor.id);
    // Until the push lands and the version is re-read, a Chronicle copy
    // arriving meanwhile still predates this edit (see _updateActorFromEntity).
    this._pushingChanges.set(actor.id, mergeChanges(this._pushingChanges.get(actor.id), change));

    try {
      if (players?.size && !(await this._playersOwn(actor, entityId, players))) return;
      if (change.name !== undefined) {
        const kept = await this._pushActorName(actor, entityId);
        if (!kept) return;
      }

      // Only the mapped fields this burst touched. Without an adapter helper
      // fall back to the full set, but only when system data changed.
      const fields = this._withoutLayered(actor, typeof this._adapter.toChronicleFieldsChanged === 'function'
        ? this._adapter.toChronicleFieldsChanged(actor, change)
        : (change.system || change[ITEMS_CHANGED] ? this._adapter.toChronicleFields(actor) : null));

      // A player's change is judged by Chronicle as that player: the keys
      // it will not take come back as `held` and stay as the player made
      // them in Foundry.
      const acting = actingMemberOf(players, (id) => memberOf(getUserMappings(), id));
      let wrote = false;
      if (fields && Object.keys(fields).length > 0) {
        const answer = await this._putFieldsMerged(entityId, fields, acting);
        this._tellHeld(actor, heldKeysOf(answer));
        wrote = true;
      }
      if (change[PICTURES_CHANGED] && (await this._pushPictures(actor, entityId, acting))) wrote = true;
      if (wrote) await this._refreshChronicleVersion(actor, entityId);

      await this._setActorFlag(actor, 'lastSync', new Date().toISOString());

      console.debug(`Chronicle: Pushed actor "${actor.name}" changes to Chronicle`);
      this._syncManager?.recordUserOutcome?.(author);
    } catch (err) {
      console.error('Chronicle: Failed to push actor update to Chronicle', err);
      this._syncManager?.recordUserOutcome?.(author, err);
      if (rethrow) throw err;
    } finally {
      this._pushingChanges.delete(actor.id);
    }
  }

  /**
   * Send a hero's own portrait and token to Chronicle: each world file is
   * uploaded as campaign media and becomes the page picture or `token_image`.
   * What was sent is recorded in the hero-pictures flag, so the pull that
   * follows sees Chronicle's new media as already applied and never copies it
   * back over the file. A picture that cannot be read or sent is skipped and
   * logged; it never fails the field push.
   * @param {Actor} actor
   * @param {string} entityId
   * @param {string|null} [actingUserId] - Chronicle member a player's change is for.
   * @returns {Promise<boolean>} whether anything was written to the page.
   * @private
   */
  async _pushPictures(actor, entityId, actingUserId = null) {
    if (this._isLinkedNpc(actor)) return false;
    let applied = actor.getFlag(FLAG_SCOPE, HERO_PICTURES_FLAG) ?? null;
    const wanted = picturesToPush({ img: actor.img, token: actor.prototypeToken?.texture?.src, applied });
    if (wanted.length === 0) return false;
    let wrote = false;
    const uploaded = new Map();
    this._sendingPictures.add(actor.id);
    try {
      for (const { role, path } of wanted) {
        try {
          if (!uploaded.has(path)) uploaded.set(path, await this._uploadWorldPicture(path));
          const id = uploaded.get(path);
          if (!id) {
            console.warn(`Chronicle: Not sending picture "${path}" for "${actor.name}": it is not a PNG, JPEG, WebP or GIF file within the size limit`);
            continue;
          }
          const acting = actingUserId ? { actingUserId } : {};
          if (role === 'img') await this._api.put(`/entities/${entityId}/image`, { image_path: id, ...acting });
          else {
            const answer = await this._putFieldsMerged(entityId, { [TOKEN_FIELD]: id }, actingUserId);
            // A token Chronicle held back is not sent; the next change tries again.
            if (heldKeysOf(answer).some((h) => h.key === TOKEN_FIELD)) continue;
          }
          wrote = true;
          const update = sentFlag(applied, role, id, path);
          applied = Object.values(update)[0];
          await actor.update(update, applyOptions());
        } catch (err) {
          // A page whose category has no token picture keeps only the portrait.
          if (role === 'token' && err?.status === 400) console.warn(`Chronicle: "${actor.name}"'s Chronicle page has no token picture field; only the portrait was sent`);
          else console.error(`Chronicle: Failed to send picture "${path}" for "${actor.name}"`, err);
        }
      }
    } finally {
      this._sendingPictures.delete(actor.id);
    }
    return wrote;
  }

  /**
   * Read a world file and upload it as campaign media.
   * @param {string} path
   * @returns {Promise<string>} the media id, or '' when the file is not a picture that may be sent.
   * @private
   */
  async _uploadWorldPicture(path) {
    if (!isWorldFile(path)) return '';
    const url = sameOriginUrl(globalThis.foundry?.utils?.getRoute?.(path) ?? path, globalThis.location?.origin ?? '');
    if (!url) return '';
    const response = await fetch(url);
    const blob = response.ok ? await response.blob() : null;
    if (!sendablePicture(blob, MAX_PICTURE_BYTES)) return '';
    return (await this._api.uploadMedia(blob, pictureName(path)))?.id || '';
  }

  /**
   * Whether Chronicle says the character belongs to every player whose
   * change is waiting. A player can rewrite their actor's link, so the link
   * alone never sends a player's change under the GM's key. When it does not,
   * the change stays in Foundry and the GM is told once per actor.
   * @param {Actor} actor
   * @param {string} entityId
   * @param {Set<string>} players - Foundry user ids.
   * @returns {Promise<boolean>}
   * @private
   */
  async _playersOwn(actor, entityId, players) {
    const entity = await this._api.get(`/entities/${entityId}`);
    const mappings = getUserMappings();
    const owned = [...players].every((id) => ownsCharacter(entity, memberOf(mappings, id)));
    if (!owned && !this._warnedPlayerChange.has(actor.id)) {
      this._warnedPlayerChange.add(actor.id);
      ui.notifications?.warn(game.i18n.format('CHRONICLE.ActorSync.PlayerChangeNotSent', { actor: noticeText(actor.name) }));
    }
    return owned;
  }

  /**
   * Write some fields without losing the rest. Older Chronicle servers
   * replace the whole field set on this PUT, so the current set is read and
   * the changes laid over it; newer ones merge, and sending the merged set
   * is the same result there. A failed read throws rather than risk a
   * partial set wiping the rest on an older server.
   * @param {string} entityId
   * @param {object} fields
   * @param {string|null} [actingUserId] - Chronicle member a player's change is for.
   * @returns {Promise<any>} Chronicle's answer, which names any `held` keys.
   * @private
   */
  async _putFieldsMerged(entityId, fields, actingUserId = null) {
    const current = (await this._api.get(`/entities/${entityId}`))?.fields_data;
    const merged = current && typeof current === 'object' && !Array.isArray(current)
      ? { ...current, ...fields }
      : fields;
    return this._api.put(`/entities/${entityId}/fields`, {
      fields_data: merged,
      ...(actingUserId ? { actingUserId } : {}),
    });
  }

  /**
   * Tell the GM which of a player's picks Chronicle did not take, and why.
   * The change stays in Foundry (sync never undoes a player's item), so
   * nothing is written back and nothing can loop. Told once per distinct
   * answer per actor.
   * @param {Actor} actor
   * @param {Array<{key: string, reason: string}>} held
   * @private
   */
  _tellHeld(actor, held) {
    if (!this._heldNotices.shouldTell(actor.id, held)) return;
    ui.notifications?.warn(game.i18n.format('CHRONICLE.ActorSync.PlayerPicksHeld', {
      actor: noticeText(actor.name),
      reasons: noticeText(describeHeld(held)),
    }));
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
      // A part set to "From Foundry" takes nothing from Chronicle, a conflict included.
      const forcedPart = this._syncManager?.pullGate?.('characters') === 'drop';
      const strategy = forcedPart ? 'foundry' : getSetting('conflictResolution');
      // Only the name carries a version check, so it is the field the edit sent.
      const settled = (kept, reason) => conflictEvent({ kind: 'character', resourceId: entityId, name: actor.name, kept, reason, fields: ['name'] });
      if (strategy === 'chronicle') {
        // Re-pull from Chronicle; this burst is dropped, so its paths no
        // longer hold Chronicle's values back.
        this._pushingChanges.delete(actor.id);
        const entity = await this._api.get(`/entities/${entityId}`);
        if (entity) await this._updateActorFromEntity(actor, entity);
        ui.notifications.warn(game.i18n.format('CHRONICLE.Notifications.ConflictKeptChronicle', { name: noticeText(actor.name) }));
        this._syncManager?.logActivity?.('update', `Conflict on "${actor.name}": kept the Chronicle version`, settled('chronicle', 'setting'));
        return false;
      }
      // Force push.
      delete nameBody.expected_updated_at;
      const forced = await this._api.put(`/entities/${entityId}`, nameBody);
      if (forced?.updated_at) {
        await this._setActorFlag(actor, 'chronicleUpdatedAt', forced.updated_at);
      }
      ui.notifications.warn(game.i18n.format('CHRONICLE.Notifications.ConflictKeptFoundry', { name: noticeText(actor.name) }));
      // "Newest" keeps Foundry here: the rename being pushed was just made,
      // after the Chronicle change that caused the conflict.
      const reason = forcedPart ? 'part' : (strategy === 'newest' ? 'newer' : 'setting');
      this._syncManager?.logActivity?.('update', `Conflict on "${actor.name}": kept the Foundry version`, settled('foundry', reason));
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

  /**
   * Set a sync flag, marked so the actor hooks do not treat it as a user
   * edit. Marked per write rather than behind a shared flag: a GM edit to
   * any actor while sync writes still pushes, and overlapping writes never
   * lift each other's guard. `null` removes the flag.
   * @private
   */
  async _setActorFlag(actor, key, value) {
    const data = value === null ? flagRemoval(FLAG_SCOPE, key) : { [`flags.${FLAG_SCOPE}.${key}`]: value };
    await actor.update(data, applyOptions());
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
    if (options?.[APPLY_OPTION]) return;
    // A push still pending would aim at an actor that is gone.
    this._actorPushDebouncer.cancel(actor.id);
    this._pendingChanges.delete(actor.id);
    this._pendingAuthors.delete(actor.id);
    this._pendingPlayers.delete(actor.id);
    if (!sendsChangeHere(userId)) return;

    // Whatever was waiting for this actor no longer has an actor to send.
    const key = `actor:${actor.id}`;
    this._syncManager?.dropHeld?.(key);
    const gate = this._pushGate();
    if (gate === 'drop') return;

    const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    if (gate === 'hold') {
      // A player's delete waits with its author, so "Sync now" checks it the
      // way a live one is checked instead of asking about a page they named.
      const player = userId !== game.user.id ? { player: userId } : {};
      this._syncManager.holdChange({ key, part: 'characters', kind: 'actor.delete', label: actor.name, data: { entityId, ...player } });
      return;
    }
    if (userId !== game.user.id) {
      await this._handlePlayerDelete(actor, entityId, userId);
      return;
    }
    // The GM is asked before the Chronicle page goes too (_remote-deletes.mjs).
    queueRemoteDelete({
      label: actor.name,
      run: () => this._api.delete(`/entities/${entityId}`),
      kept: () => this._syncOffAfterDelete(entityId),
    });
  }

  /**
   * The GM deleted an actor here and kept its character in Chronicle. Sync
   * is turned off for that page (the shared exclusion list the GM can undo in
   * Chronicle Sync), so no connect pass makes its actor again.
   * @param {string} entityId
   * @private
   */
  async _syncOffAfterDelete(entityId) {
    const exclusions = getSyncExclusions();
    const excludedEntities = exclusions.excludedEntities || [];
    if (excludedEntities.includes(entityId)) return;
    await setSetting('syncExclusions', JSON.stringify({
      ...exclusions,
      excludedTypes: exclusions.excludedTypes || [],
      excludedEntities: [...excludedEntities, entityId],
    }));
  }

  /**
   * A player deleted an actor. The link is a flag they can rewrite, so the
   * page it names must be claimed by them in Chronicle and carry the actor's
   * own name; then Chronicle moves it to its Trash. Anything else becomes a
   * GM card.
   * @private
   */
  async _handlePlayerDelete(actor, entityId, userId) {
    try {
      const page = await this._api.get(`/entities/${entityId}`);
      const own = ownsCharacter(page, memberOf(getUserMappings(), userId)) && sameName(page?.name, actor.name);
      if (own) {
        await this._api.delete(`/entities/${entityId}`);
        this._syncManager?.recordUserOutcome?.(userId);
        return;
      }
      await getPlayerAsks()?.ask(askModel({
        kind: ASK.ACTOR_REMOVE, docId: actor.id, who: playerName(userId), name: actor.name,
        link: { entityId },
      }));
    } catch (err) {
      console.warn(`Chronicle: Could not handle a player's delete of "${actor.name}"`, err);
      this._syncManager?.recordUserOutcome?.(userId, err);
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
   * Read the field definitions again. The adapter is built once when the
   * world loads, so a system package updated in Chronicle since then would
   * keep being pushed in its old shape (a newly mapped field never sent)
   * until a reload. A failed read keeps the adapter in hand, and a module
   * that started without one stays off: its hooks were never registered.
   * @returns {Promise<boolean>} true when the definitions changed.
   */
  async refreshAdapter() {
    if (!this._adapter) return false;
    const fresh = await this._loadAdapter();
    if (!fresh) return false;
    const before = this._adapter;
    this._adapter = fresh;
    if (fresh.characterTypeSlug !== before.characterTypeSlug) await this._resolveCharacterTypeId();
    return JSON.stringify(fresh.fieldDefs) !== JSON.stringify(before.fieldDefs);
  }

  /**
   * Resolve the character entity type ID and (when the PC-claiming addon is
   * active) the "Player Characters" sub-type ID in a single `/entity-types`
   * call.
   * @private
   */
  async _resolveCharacterTypeId() {
    if (!this._adapter?.characterTypeSlug) return;
    // A refreshed adapter may name another type; ids kept from the old one
    // would keep routing pushes and events to it.
    this._characterTypeId = null;
    this._pcSubtypeId = null;

    try {
      const result = await this._api.get('/entity-types');
      const types = result?.data || result || [];
      const match = _pickCharacterType(types, this._adapter.characterTypeSlug);
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
   * D&D 5e shows characters, etc., plus the NPCs made for character pages.
   * An unlinked NPC actor is the GM's own and never listed.
   * @returns {Array<{id: string, name: string, entityId: string|null, synced: boolean, lastSync: string|null}>}
   */
  getSyncedActors() {
    if (!this._adapter) return [];

    const targetType = this._actorType;
    return game.actors.contents
      .filter((a) => a.type === targetType || this._isLinkedNpc(a))
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
    this._characterListFailed = false;
    for (const typeId of typeIds) {
      try {
        out.push(...(await this._walkTypeEntities(typeId)));
      } catch (err) {
        this._characterListFailed = true;
        console.warn('Chronicle: failed to list character entities', err);
      }
    }
    return out;
  }

  /**
   * Every entity of one type, paged to the end.
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
      if (status === 404 || /\b404\b|not found/i.test(err?.message || '')) {
        // The answer to the question, not a failure; the broken link is
        // reported through the Characters section instead.
        this._api.dropLastErrorLogEntry?.({ path: `/entities/${entityId}`, status: 404 });
        return false;
      }
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
    // Without the list every linked actor would look missing and be checked
    // one GET at a time, which is the burst that trips the rate limit.
    if (this._characterListFailed) throw new Error('Could not list Chronicle characters');
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
   * links), nudge the GM toward the dashboard's Characters section. Quiet when all clear.
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
        `Chronicle Sync: ${n} character${n === 1 ? '' : 's'} need attention — open the Chronicle dashboard (Characters) to match or create.`
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
    // An NPC's system data is not the page's hero fields (see
    // _handleUpdateActor), so only its name is sent. Its visibility is not:
    // a token left visible must never make a GM-only page public.
    if (this._isLinkedNpc(actor)) {
      if (!(await this._pushActorName(actor, entityId))) return false;
      await this._setActorFlag(actor, 'lastSync', new Date().toISOString());
      return true;
    }
    await this._putFieldsMerged(entityId, this._withoutLayered(actor, this._adapter.toChronicleFields(actor)));
    if (await this._pushPictures(actor, entityId)) await this._refreshChronicleVersion(actor, entityId);
    await this._setActorFlag(actor, 'lastSync', new Date().toISOString());
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
    await this._setActorFlag(actor, 'entityId', entityId);
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
      await this._setActorFlag(actor, 'entityId', null);
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

/** Options marking an actor write as sync's own, a fresh object per write (Foundry writes into it). */
function applyOptions() {
  return syncOptions({ [APPLY_OPTION]: true });
}

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
/**
 * Pick the Chronicle entity type that holds this world's characters.
 *
 * The type carrying the system's "character" preset owns the sheet, so it wins;
 * Chronicle can move that preset from a system type onto "Characters" and turn
 * the old type off, so a disabled type is never picked while an enabled one
 * matches. Then the adapter's slug, then a name containing "character".
 *
 * Exported for unit tests.
 *
 * @param {object[]} types - Chronicle entity types (GET /entity-types).
 * @param {string} slug    - The adapter's character type slug.
 * @returns {object|null}
 */
export function _pickCharacterType(types, slug) {
  if (!Array.isArray(types)) return null;
  const enabled = types.filter((t) => t.enabled !== false);
  for (const pool of [enabled, types]) {
    const match = pool.find((t) => t.preset_category === 'character')
      || pool.find((t) => t.slug === slug)
      || pool.find((t) => t.name?.toLowerCase().includes('character'));
    if (match) return match;
  }
  return null;
}

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
