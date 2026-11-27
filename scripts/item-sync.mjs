/**
 * Chronicle Sync - Item Sync
 *
 * Bidirectional sync between Chronicle item entities (via "Has Item" relations)
 * and Foundry Actor inventories. When an Actor gains/loses an item in Foundry,
 * the corresponding "Has Item" relation is created/deleted in Chronicle.
 * When a Chronicle relation is created/updated, the Foundry Actor inventory
 * is updated.
 *
 * When the system's item preset names a Foundry item type (Draw Steel's
 * `treasure`, served by /item-fields only once the campaign's Items have
 * switched to the system's fields), a carried item arrives as that type with
 * the page's treasure data (_treasure-item.mjs) and is rewritten when the page
 * changes. That data is Chronicle's alone: nothing of it is read back.
 *
 * Sync flow:
 * - Chronicle → Foundry: a relation event or a change-feed entry for a
 *   character reconciles that character's inventory with its relations.
 * - Foundry → Chronicle: Item hooks on Actors push to Chronicle API as relations.
 */

import { flagRemoval } from './_flag-removal.mjs';
import { getSetting, getUserMappings } from './settings.mjs';
import { FLAG_SCOPE, APPLY_OPTION } from './constants.mjs';
import { findLinked } from './_link-fence.mjs';
import { queueRemoteDelete } from './_remote-deletes.mjs';
import { collapseChanges } from './_change-feed.mjs';
import { HAS_ITEM, EQUIPPED_FLAG, planInventory, itemDataFor, hasItemBody, seenByPlayers, dmOnlyHeld } from './_inventory-plan.mjs';
import { noticeText } from './_escape-html.mjs';
import { treasureUpdate, treasureSignature, expandPaths } from './_treasure-item.mjs';
import { itemsToRemove } from './_stash-reconcile.mjs';
import { sendsChangeHere, memberOf, ownsCharacter } from './_change-author.mjs';
import { ASK, askModel, playersCanView } from './_player-asks.mjs';
import { getPlayerAsks, playerName } from './player-asks.mjs';

/**
 * An item's equipped state and where it keeps it: `system.equipped` when the
 * item type has one, else the flag a treasure keeps Chronicle's value in.
 * @param {Item} item
 */
function equippedOf(item) {
  if (item.system?.equipped !== undefined) return { equipped: item.system.equipped };
  return { equipped: item.getFlag(FLAG_SCOPE, 'equipped'), equippedPath: EQUIPPED_FLAG };
}

/** The actor linked to a Chronicle character, or null. */
function linkedActor(entityId) {
  if (!entityId) return null;
  return findLinked(game.actors, entityId, FLAG_SCOPE);
}

/**
 * ItemSync handles item inventory synchronization between Chronicle
 * "Has Item" relations and Foundry Actor item documents.
 */
export class ItemSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;

    /** @type {import('./sync-manager.mjs').SyncManager|null} */
    this._syncManager = null;

    /** @type {object|null} Item field definitions from API. */
    this._itemFields = null;

    /** @type {string|null} Foundry item type the item preset makes (`treasure`), or null for plain items. */
    this._itemType = null;

    /** @type {number|null} Cached Chronicle entity type ID for items. */
    this._itemTypeId = null;

    /**
     * One-shot guard so the "custom item has no linked Chronicle entity to
     * relate to — skipping relation push" notice logs once per session,
     * not per item.
     * @type {boolean}
     */
    this._loggedSkipNoTarget = false;

    /** @type {Map<string, Promise>} Per-actor reconcile chain. */
    this._reconciling = new Map();

    // Bound hook handlers for cleanup.
    this._onCreateItem = this._handleCreateItem.bind(this);
    this._onDeleteItem = this._handleDeleteItem.bind(this);
    this._onUpdateItem = this._handleUpdateItem.bind(this);
  }

  /**
   * Initialize the item sync module.
   * Loads item field definitions and registers hooks.
   * @param {import('./api-client.mjs').ChronicleAPI} api
   */
  async init(api) {
    this._api = api;

    if (!getSetting('syncCharacters')) {
      // Item sync requires character sync to be enabled (items belong to actors).
      console.debug('Chronicle: Item sync inactive (character sync disabled)');
      return;
    }

    // Load item field definitions from the API.
    await this._loadItemFields();

    // Register Foundry hooks for Actor embedded item changes.
    Hooks.on('createItem', this._onCreateItem);
    Hooks.on('deleteItem', this._onDeleteItem);
    Hooks.on('updateItem', this._onUpdateItem);

    console.debug('Chronicle: Item sync initialized');
  }

  /**
   * Relation events from Chronicle, one per relation row, keyed on the
   * row's source entity. Any change to a character's relations reconciles
   * that character's whole inventory, so a missed, repeated or out-of-order
   * event cannot leave it wrong and the item's own echo cannot copy it.
   * @param {object} msg
   */
  async onMessage(msg) {
    if (!this._api || !getSetting('syncCharacters')) return;
    if (msg?.type === 'entity.updated') {
      await this._refreshTreasures([msg.payload?.id ?? msg.resourceId]);
      return;
    }
    if (!String(msg?.type || '').startsWith('relation.')) return;
    const p = msg.payload || {};
    if (p.relationType && p.relationType !== HAS_ITEM) return;
    const actor = linkedActor(p.sourceEntityId || msg.resourceId);
    if (!actor) return;
    try {
      await this._reconcileActor(actor);
    } catch (err) {
      console.warn(`Chronicle: Failed to refresh inventory for "${actor.name}"`, err);
    }
  }

  /**
   * Handle a sync mapping received during initial sync.
   * Item sync uses relations, not direct mappings, so this is mostly a no-op.
   * @param {object} mapping
   */
  async onSyncMapping(mapping) {
    // Items are synced via relations, not top-level mappings.
  }

  /** Change-feed area (see SyncManager._performInitialSync). */
  get feedArea() { return 'items'; }

  /** The settings part whose direction and live switch govern this module. */
  get syncPart() { return 'characters'; }

  /** Waiting changes this module sends on "Sync now". */
  get heldKinds() { return ['item.create', 'item.update', 'item.delete']; }

  /** @returns {'send'|'hold'|'drop'} what to do with a Foundry item change. @private */
  _pushGate() { return this._syncManager?.pushGate?.('characters') ?? 'send'; }

  /**
   * Send one waiting change. An item that has gone has nothing to send.
   * @param {{key: string, kind: string, label: string, data: object}} change
   */
  async sendHeld(change) {
    const { actorId, itemId, relationId, userId } = change.data;
    if (change.kind === 'item.delete') {
      if (relationId) this._queueRelationDelete(relationId, change.label, userId ?? game.user.id);
      return;
    }
    const item = game.actors.get(actorId)?.items?.get(itemId);
    if (!item) return;
    if (change.kind === 'item.create') {
      if (!item.getFlag(FLAG_SCOPE, 'relationId')) await this._pushNewItem(item, userId ?? game.user.id, { rethrow: true });
      return;
    }
    await this._pushItemMeta(item, userId ?? game.user.id, { rethrow: true });
  }

  /**
   * Inventory changes are recorded as `relation`; until a cursor was taken
   * while the server recorded them, every character is reconciled.
   */
  get feedType() { return 'relation'; }

  /** Inventories sync only alongside characters. */
  feedActive() {
    return !!this._api && !!getSetting('syncCharacters');
  }

  /**
   * Connect catch-up. With the change feed only characters whose relations
   * changed are reconciled; without it, every linked character. A failure
   * throws so the cursor stays and the next connect replays.
   * @param {{feed?: {mode: 'delta'|'full', changes?: object[]}}} [opts]
   */
  async onInitialSync({ feed } = {}) {
    if (!this._api || !getSetting('syncCharacters')) return;

    // A switch to the system's item fields may have happened since the last connect.
    await this._loadItemFields();

    let actors;
    let pages = null;
    if (feed?.mode === 'delta') {
      const changed = collapseChanges(feed.changes, 'relation');
      actors = [...changed.keys()].map(linkedActor).filter(Boolean);
      pages = [...collapseChanges(feed.changes, 'entity').keys()];
    } else {
      actors = game.actors.filter((a) => a.getFlag(FLAG_SCOPE, 'entityId'));
    }

    let errors = 0;
    for (const actor of actors) {
      try {
        await this._reconcileActor(actor);
      } catch (err) {
        errors++;
        console.warn(`Chronicle: Failed to sync inventory for "${actor.name}"`, err);
      }
    }
    if (errors) throw new Error(`inventory catch-up failed for ${errors} character(s)`);
    await this._refreshTreasures(pages);
  }

  /**
   * Pull one actor's inventory after a stash move: the same reconcile as a
   * relation event, plus the one removal a move the GM just applied calls
   * for (`removeItemIds`, see _stash-reconcile.mjs). A failure is logged and
   * changes nothing.
   * @param {Actor} actor
   * @param {{removeItemIds?: string[]}} [opts]
   */
  async refreshInventory(actor, { removeItemIds = [] } = {}) {
    if (!this._api || !actor?.getFlag(FLAG_SCOPE, 'entityId')) return;
    try {
      await this._reconcileActor(actor, { removeItemIds });
    } catch (err) {
      console.warn(`Chronicle: Failed to sync inventory for "${actor.name}"`, err);
    }
  }

  /**
   * Bring one actor's Chronicle-linked items in line with its "Has Item"
   * relations. Serialized per actor so two events never both add an item.
   * @param {Actor} actor
   * @param {{removeItemIds?: string[]}} [opts]
   * @private
   */
  _reconcileActor(actor, opts = {}) {
    const prev = this._reconciling.get(actor.id) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => this._reconcileNow(actor, opts));
    this._reconciling.set(actor.id, run);
    run.finally(() => {
      if (this._reconciling.get(actor.id) === run) this._reconciling.delete(actor.id);
    }).catch(() => {});
    return run;
  }

  /** @private */
  async _reconcileNow(actor, { removeItemIds = [] } = {}) {
    const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;
    const relations = await this._api.get(`/entities/${entityId}/relations`);
    const list = Array.isArray(relations) ? relations : (relations?.data || []);
    const items = actor.items.contents.map((i) => ({
      id: i.id,
      relationId: i.getFlag(FLAG_SCOPE, 'relationId') ?? null,
      entityId: i.getFlag(FLAG_SCOPE, 'entityId') ?? null,
      quantity: i.system?.quantity,
      ...equippedOf(i),
    }));
    // An item on an actor a player can see shows them its name, so a
    // Director-only link, or one to a page players cannot open, adds none.
    const L = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS;
    const playerEyes = seenByPlayers(actor.ownership, (id) => !!game.users?.get(id)?.isGM, L?.LIMITED ?? 1);
    const plan = planInventory(list, items, { playerEyes });
    if (playerEyes) this._tellHiddenHeld(actor, dmOnlyHeld(list, items));
    // The only delete: an item a stash move the GM just applied took off
    // this character. Every other gone relation is only unlinked. The move's
    // own relation event may have unlinked the item already, so its last
    // relation id still counts here.
    const live = list.filter((r) => r?.relationType === HAS_ITEM).map((r) => r.id);
    const lastLinked = actor.items.contents.map((i) => ({
      id: i.id,
      relationId: i.getFlag(FLAG_SCOPE, 'relationId') ?? i.getFlag(FLAG_SCOPE, 'unlinkedRelationId') ?? null,
      entityId: i.getFlag(FLAG_SCOPE, 'entityId') ?? null,
    }));
    const adopted = new Set(plan.adopt.map((a) => a.id));
    const moved = new Set(itemsToRemove(lastLinked, live, removeItemIds).map((g) => g.id).filter((id) => !adopted.has(id)));
    const unlink = plan.unlink.filter((id) => !moved.has(id));
    if (!plan.create.length && !plan.update.length && !plan.adopt.length && !unlink.length && !moved.size) return;

    // Tagged per write rather than behind `_syncing`: a GM edit to another
    // item while this runs must still push, and a reconcile on another
    // actor must not lift this one's guard.
    // A fresh options object per write: Foundry writes into the one it gets.
    const opts = () => ({ [APPLY_OPTION]: true });
    for (const { id, relationId } of plan.adopt) {
      await actor.items.get(id)?.update({ [`flags.${FLAG_SCOPE}.relationId`]: relationId, ...flagRemoval(FLAG_SCOPE, 'unlinkedRelationId') }, opts());
    }
    for (const { id, change } of plan.update) {
      await actor.items.get(id)?.update(change, opts());
    }
    if (plan.create.length) {
      const data = [];
      for (const r of plan.create) {
        const page = playerEyes || this._itemType ? await this._readItemPage(r.targetEntityId) : null;
        // Fails closed: an unread page adds nothing now; the next reconcile tries again.
        if (playerEyes && !(page && playersCanView(page.entity, page.perms))) {
          console.debug(`Chronicle: a Has Item link on "${actor.name}" points at a page players cannot view; no item added.`);
          continue;
        }
        data.push(itemDataFor(r, this._treasureFrom(page)));
      }
      if (data.length) await actor.createEmbeddedDocuments('Item', data, opts());
    }
    // Never deleted: the item stays in Foundry, only its link is dropped.
    for (const id of unlink) {
      const item = actor.items.get(id);
      await item?.update({
        ...flagRemoval(FLAG_SCOPE, 'relationId'),
        [`flags.${FLAG_SCOPE}.unlinkedRelationId`]: item.getFlag(FLAG_SCOPE, 'relationId'),
      }, opts());
    }
    if (moved.size) {
      await actor.deleteEmbeddedDocuments('Item', [...moved], opts());
    }
  }

  /**
   * Clean up hooks on destroy.
   */
  destroy() {
    Hooks.off('createItem', this._onCreateItem);
    Hooks.off('deleteItem', this._onDeleteItem);
    Hooks.off('updateItem', this._onUpdateItem);
  }

  // ---------------------------------------------------------------------------
  // Foundry → Chronicle
  // ---------------------------------------------------------------------------

  /**
   * Handle Foundry createItem hook (item added to actor).
   * Creates a "Has Item" relation in Chronicle.
   * @param {Item} item
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleCreateItem(item, options, userId) {
    if (options?.[APPLY_OPTION]) return;
    if (!sendsChangeHere(userId)) return;
    if (!item.parent || !(item.parent instanceof Actor)) return;

    // Items this module creates carry APPLY_OPTION, so a new item that already
    // has a relation flag is a copy (dragged from another actor, duplicated):
    // that relation belongs to the original. Drop it and push the copy as its
    // own item instead.
    if (item.getFlag(FLAG_SCOPE, 'relationId') || item.getFlag(FLAG_SCOPE, 'unlinkedRelationId')) {
      await item.update(flagRemoval(FLAG_SCOPE, 'relationId', 'unlinkedRelationId'), { [APPLY_OPTION]: true });
    }

    const gate = this._pushGate();
    if (gate === 'drop') return;
    if (gate === 'hold') {
      if (!item.parent.getFlag(FLAG_SCOPE, 'entityId') || !item.getFlag(FLAG_SCOPE, 'entityId')) return;
      // A player's item waits with its author, so "Sync now" checks it as a live one is.
      this._syncManager.holdChange({
        key: `item:${item.parent.id}:${item.id}`, part: 'characters', kind: 'item.create',
        label: `${item.name} (${item.parent.name})`, data: { actorId: item.parent.id, itemId: item.id, ...(userId !== game.user.id ? { userId } : {}) },
      });
      return;
    }
    await this._pushNewItem(item, userId);
  }

  /**
   * Add a "Has Item" relation in Chronicle for an item on a linked actor.
   * @param {Item} item
   * @param {string} userId - who added it, for the History row.
   * @param {{rethrow?: boolean}} [opts] - rethrow a failure after reporting it.
   * @private
   */
  async _pushNewItem(item, userId, { rethrow = false } = {}) {
    const actor = item.parent;
    const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return; // Actor not synced.

    // Chronicle relations require a target entity (CreateRelation 400s on
    // an empty target_entity_id). A custom Foundry item has no
    // corresponding Chronicle item entity to point at, so only an item
    // already linked to one (its own `entityId` flag) can carry a
    // relation. Logged once per session so bulk-adding custom items
    // doesn't spam the console.
    const targetEntityId = item.getFlag(FLAG_SCOPE, 'entityId');
    if (!targetEntityId) {
      if (!this._loggedSkipNoTarget) {
        this._loggedSkipNoTarget = true;
        console.debug(`Chronicle: Item "${item.name}" has no linked Chronicle entity — skipping relation push (custom items aren't stored as relations; further skips silenced this session).`);
      }
      return;
    }

    try {
      // A player's new item goes straight up on a character Chronicle says
      // is theirs; on anyone else's it becomes a card for the GM.
      if (userId !== game.user.id && !(await this._playerAdd(item, actor, entityId, targetEntityId, userId))) return;
      const relation = await this._api.post(`/entities/${entityId}/relations`, hasItemBody({
        targetEntityId,
        quantity: item.system?.quantity,
        equipped: item.system?.equipped,
        name: item.name,
      }));

      if (relation) {
        await item.update({ [`flags.${FLAG_SCOPE}.relationId`]: relation.id }, { [APPLY_OPTION]: true });
        console.debug(`Chronicle: Pushed new item "${item.name}" from "${actor.name}" to Chronicle`);
        this._syncManager?.recordUserOutcome?.(userId);
      }
    } catch (err) {
      console.warn(`Chronicle: Failed to push new item "${item.name}" to Chronicle`, err);
      this._syncManager?.recordUserOutcome?.(userId, err);
      if (rethrow) throw err;
    }
  }

  /**
   * Handle Foundry deleteItem hook (item removed from actor).
   * Deletes the corresponding "Has Item" relation in Chronicle once the GM agrees.
   * @param {Item} item
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleDeleteItem(item, options, userId) {
    if (options?.[APPLY_OPTION]) return;
    if (!sendsChangeHere(userId)) return;

    // Whatever was waiting for this item no longer has an item to send.
    const key = `item:${item.parent?.id}:${item.id}`;
    this._syncManager?.dropHeld?.(key);
    const gate = this._pushGate();
    if (gate === 'drop') return;

    const relationId = item.getFlag(FLAG_SCOPE, 'relationId');
    if (!relationId) return;

    const actor = item.parent;
    const entityId = actor?.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    if (userId !== game.user.id) {
      const held = await this._playerRelation(entityId, relationId, userId).catch(() => null);
      if (!held?.holds) return;
      if (!held.own) {
        // Not their character: the GM decides.
        await getPlayerAsks()?.ask(askModel({
          kind: ASK.ITEM_REMOVE, docId: item.id, who: playerName(userId), name: item.name, where: actor.name,
          link: { entityId, relationId },
        }));
        return;
      }
    }

    const label = `${item.name} (${actor.name})`;
    if (gate === 'hold') {
      this._syncManager.holdChange({ key, part: 'characters', kind: 'item.delete', label, data: { relationId, userId } });
      return;
    }
    this._queueRelationDelete(relationId, label, userId);
  }

  /**
   * Ask the GM whether the Chronicle relation goes too (_remote-deletes.mjs),
   * and remove it on a yes. Chronicle serves a flat relation route.
   * @param {string} relationId
   * @param {string} name - shown in the prompt.
   * @param {string} userId - who removed the item, for the History row.
   * @private
   */
  _queueRelationDelete(relationId, name, userId) {
    queueRemoteDelete({
      label: name,
      run: async () => {
        try {
          await this._api.delete(`/relations/${relationId}`);
          console.debug(`Chronicle: Removed item relation for "${name}" from Chronicle`);
          this._syncManager?.recordUserOutcome?.(userId);
        } catch (err) {
          this._syncManager?.recordUserOutcome?.(userId, err);
          throw err;
        }
      },
    });
  }

  /**
   * Handle Foundry updateItem hook (item properties changed).
   * Updates relation metadata (quantity, equipped) in Chronicle.
   * @param {Item} item
   * @param {object} change
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleUpdateItem(item, change, options, userId) {
    if (options?.[APPLY_OPTION]) return;
    if (!sendsChangeHere(userId)) return;
    // Only the two values sent below matter; a rest or a use that changes
    // charges on many items must not send one write per item.
    if (!change.system || !('quantity' in change.system || 'equipped' in change.system)) return;

    const gate = this._pushGate();
    if (gate === 'drop') return;
    if (gate === 'hold') {
      if (!item.getFlag(FLAG_SCOPE, 'relationId') || !item.parent?.getFlag(FLAG_SCOPE, 'entityId')) return;
      this._syncManager.holdChange({
        key: `item:${item.parent.id}:${item.id}`, part: 'characters', kind: 'item.update',
        label: `${item.name} (${item.parent.name})`, data: { actorId: item.parent.id, itemId: item.id, userId },
      }, (before, next) => (before.kind === 'item.create' ? before.data : next.data));
      return;
    }
    await this._pushItemMeta(item, userId);
  }

  /**
   * Send an item's quantity and equipped state to its Chronicle relation.
   * @param {Item} item
   * @param {string} userId - who changed it.
   * @param {{rethrow?: boolean}} [opts] - rethrow a failure after reporting it.
   * @private
   */
  async _pushItemMeta(item, userId, { rethrow = false } = {}) {
    const relationId = item.getFlag(FLAG_SCOPE, 'relationId');
    if (!relationId) return;

    const actor = item.parent;
    const entityId = actor?.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    try {
      if (userId !== game.user.id && !(await this._playerHolds(entityId, relationId, userId))) return;
      const meta = {
        quantity: item.system?.quantity ?? 1,
        equipped: equippedOf(item).equipped ?? false,
      };

      // Flat route PUT /relations/:relationId. Chronicle's UpdateRelation
      // binds {metadata} as json.RawMessage, so pass a plain object rather
      // than a JSON string.
      await this._api.put(`/relations/${relationId}`, {
        metadata: meta,
      });
      this._syncManager?.recordUserOutcome?.(userId);
    } catch (err) {
      console.warn(`Chronicle: Failed to update item metadata for "${item.name}"`, err);
      this._syncManager?.recordUserOutcome?.(userId, err);
      if (rethrow) throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Whether the character is the player's and whether the relation is in its
   * list. Both ids come from flags a player can rewrite, so neither is
   * trusted for a player's change sent under the GM's key.
   * @param {string} entityId
   * @param {string} relationId
   * @param {string} userId - Foundry user id.
   * @returns {Promise<{own: boolean, holds: boolean}>}
   * @private
   */
  async _playerRelation(entityId, relationId, userId) {
    const entity = await this._api.get(`/entities/${entityId}`);
    const own = ownsCharacter(entity, memberOf(getUserMappings(), userId));
    const relations = await this._api.get(`/entities/${entityId}/relations`);
    const list = Array.isArray(relations) ? relations : (relations?.data || []);
    return { own, holds: list.some((r) => String(r?.id) === String(relationId)) };
  }

  /** A player's change is sent only for a character and relation that are theirs. */
  async _playerHolds(entityId, relationId, userId) {
    const { own, holds } = await this._playerRelation(entityId, relationId, userId);
    return own && holds;
  }

  /**
   * A player's new item: may it be sent now?
   * The page it points at must be one players can already view, whoever
   * asks. A character that is theirs is sent now; any other character's
   * becomes a GM card.
   * @returns {Promise<boolean>} true when the caller sends it now.
   * @private
   */
  async _playerAdd(item, actor, entityId, targetEntityId, userId) {
    const [page, perms, character] = await Promise.all([
      this._api.get(`/entities/${targetEntityId}`),
      this._api.get(`/entities/${targetEntityId}/permissions`).catch(() => null),
      this._api.get(`/entities/${entityId}`),
    ]);
    if (!playersCanView(page, perms)) {
      console.debug(`Chronicle: Item "${item.name}" points at a page players cannot view — not sent.`);
      return false;
    }
    if (ownsCharacter(character, memberOf(getUserMappings(), userId))) return true;
    await getPlayerAsks()?.ask(askModel({
      kind: ASK.ITEM_ADD, docId: item.id, who: playerName(userId), name: item.name, where: actor.name,
      link: {
        entityId, targetEntityId, actorId: actor.id, itemId: item.id,
        quantity: item.system?.quantity ?? 1, equipped: item.system?.equipped ?? false,
      },
    }));
    return false;
  }

  /**
   * Tell the GM, once a session per item, of items on a hero players see
   * that are still linked to a Director-only link: they were added before
   * such links were kept off, and sync never deletes without asking.
   * @param {Actor} actor
   * @param {string[]} itemIds
   * @private
   */
  _tellHiddenHeld(actor, itemIds) {
    this._hiddenTold ??= new Set();
    const names = itemIds.filter((id) => !this._hiddenTold.has(id)).map((id) => {
      this._hiddenTold.add(id);
      return actor.items.get(id)?.name;
    }).filter(Boolean);
    if (!names.length) return;
    const notice = game.i18n.format('CHRONICLE.Notifications.DmOnlyItemHeld', {
      actor: noticeText(actor.name), items: noticeText(names.join(', ')),
    });
    ui.notifications?.warn?.(notice, { permanent: true });
  }

  /**
   * An item page and its permissions, or null when the page could not be
   * read. The permissions read may fail alone; players then cannot view a
   * custom page.
   * @param {string} entityId
   * @returns {Promise<{entity: object, perms: object|null}|null>}
   * @private
   */
  async _readItemPage(entityId) {
    if (!entityId) return null;
    try {
      const [entity, perms] = await Promise.all([
        this._api.get(`/entities/${entityId}`),
        this._api.get(`/entities/${entityId}/permissions`).catch(() => null),
      ]);
      return entity ? { entity, perms } : null;
    } catch (err) {
      console.warn(`Chronicle: Failed to read item page ${entityId}`, err);
      return null;
    }
  }

  /**
   * The treasure data for a new item of the preset's Foundry type, or null
   * for a plain item. A page players cannot open in Chronicle gives its name
   * only (that is only reached on an actor no player sees); an unread page
   * does too.
   * @param {{entity: object, perms: object|null}|null} page - from _readItemPage
   * @returns {{type: string, system: object, flags: object}|null}
   * @private
   */
  _treasureFrom(page) {
    if (!this._itemType) return null;
    const built = page ? this._treasureBuild(page) : null;
    if (!built) return { type: this._itemType, system: {}, flags: {} };
    return {
      type: this._itemType,
      system: expandPaths(built.update).system || {},
      flags: { treasureSig: built.sig },
    };
  }

  /**
   * An item page's treasure data as dot paths, with every mapped value it
   * lacks cleared, or null when the page could not be read.
   * @private
   */
  async _treasureUpdate(entityId) {
    if (!entityId || !this._itemType) return null;
    const page = await this._readItemPage(entityId);
    return page ? this._treasureBuild(page) : null;
  }

  /** @private */
  _treasureBuild({ entity, perms }) {
    try {
      const choicesFor = (path) => foundry.utils.getProperty(globalThis.CONFIG, path) ?? null;
      const { update, unknown } = treasureUpdate({
        entity, fields: this._itemFields, choicesFor, showWords: playersCanView(entity, perms), clear: true,
      });
      if (unknown.length) console.debug(`Chronicle: "${entity?.name}" values with no Draw Steel equivalent were left out: ${unknown.join('; ')}`);
      return { update, sig: treasureSignature(update) };
    } catch (err) {
      console.warn(`Chronicle: Failed to build the treasure data of item page ${entity?.id}`, err);
      return null;
    }
  }

  /**
   * Rewrite the sync-made treasures of the given item pages (every linked
   * one when `entityIds` is null) where the page's data changed. Only
   * Chronicle writes these values, so the write simply replaces them.
   * @param {string[]|null} entityIds
   * @private
   */
  async _refreshTreasures(entityIds) {
    if (!this._itemType) return;
    const wanted = entityIds ? new Set(entityIds.filter(Boolean).map(String)) : null;
    if (wanted && !wanted.size) return;
    const byPage = new Map();
    for (const actor of game.actors.contents) {
      if (!actor.getFlag(FLAG_SCOPE, 'entityId')) continue;
      for (const item of actor.items) {
        const page = item.getFlag(FLAG_SCOPE, 'entityId');
        if (!page || item.type !== this._itemType || !item.getFlag(FLAG_SCOPE, 'relationId')) continue;
        if (wanted && !wanted.has(String(page))) continue;
        if (!byPage.has(page)) byPage.set(page, []);
        byPage.get(page).push(item);
      }
    }
    for (const [page, items] of byPage) {
      const built = await this._treasureUpdate(page);
      if (!built) continue;
      for (const item of items) {
        if (item.getFlag(FLAG_SCOPE, 'treasureSig') === built.sig) continue;
        try {
          await item.update({ ...built.update, [`flags.${FLAG_SCOPE}.treasureSig`]: built.sig }, { [APPLY_OPTION]: true });
        } catch (err) {
          console.warn(`Chronicle: Failed to refresh treasure "${item.name}"`, err);
        }
      }
    }
  }

  /**
   * Load item field definitions from the Chronicle API.
   * @private
   */
  async _loadItemFields() {
    const matchedSystem = getSetting('detectedSystem');
    if (!matchedSystem) return;

    try {
      const result = await this._api.get(`/systems/${matchedSystem}/item-fields`);
      if (result?.fields) {
        this._itemFields = result.fields;
        this._itemType = result.fields.length && result.foundry_item_type ? result.foundry_item_type : null;
        console.debug(`Chronicle: Loaded ${result.fields.length} item field definitions`);
      }
    } catch (err) {
      console.warn('Chronicle: Failed to load item field definitions', err);
    }
  }

  /**
   * Get synced inventory stats for the dashboard.
   * @returns {object} Stats about inventory sync.
   */
  getSyncStats() {
    let totalItems = 0;
    let linkedItems = 0;

    for (const actor of game.actors.contents) {
      if (!actor.getFlag(FLAG_SCOPE, 'entityId')) continue;
      for (const item of actor.items) {
        totalItems++;
        if (item.getFlag(FLAG_SCOPE, 'relationId')) {
          linkedItems++;
        }
      }
    }

    return { totalItems, linkedItems };
  }
}
