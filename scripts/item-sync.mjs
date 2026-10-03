/**
 * Chronicle Sync - Item Sync
 *
 * Bidirectional sync between Chronicle item entities (via "Has Item" relations)
 * and Foundry Actor inventories. When an Actor gains/loses an item in Foundry,
 * the corresponding "Has Item" relation is created/deleted in Chronicle.
 * When a Chronicle relation is created/updated, the Foundry Actor inventory
 * is updated.
 *
 * System-specific field mapping for items uses the same adapter pattern as
 * actor-sync.mjs, loading item field definitions from the /item-fields API.
 *
 * Sync flow:
 * - Chronicle → Foundry: a relation event or a change-feed entry for a
 *   character reconciles that character's inventory with its relations.
 * - Foundry → Chronicle: Item hooks on Actors push to Chronicle API as relations.
 */

import { getSetting } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';
import { collapseChanges } from './_change-feed.mjs';
import { HAS_ITEM, planInventory, itemDataFor } from './_inventory-plan.mjs';

/** The actor linked to a Chronicle character, or null. */
function linkedActor(entityId) {
  if (!entityId) return null;
  return game.actors.find((a) => a.getFlag(FLAG_SCOPE, 'entityId') === entityId) || null;
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

    /** @type {boolean} Suppress hook processing during sync-initiated changes. */
    this._syncing = false;

    /** @type {object|null} Item field definitions from API. */
    this._itemFields = null;

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

    let actors;
    if (feed?.mode === 'delta') {
      const changed = collapseChanges(feed.changes, 'relation');
      actors = [...changed.keys()].map(linkedActor).filter(Boolean);
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
  }

  /**
   * Bring one actor's Chronicle-linked items in line with its "Has Item"
   * relations. Serialized per actor so two events never both add an item.
   * @param {Actor} actor
   * @private
   */
  _reconcileActor(actor) {
    const prev = this._reconciling.get(actor.id) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => this._reconcileNow(actor));
    this._reconciling.set(actor.id, run);
    run.finally(() => {
      if (this._reconciling.get(actor.id) === run) this._reconciling.delete(actor.id);
    }).catch(() => {});
    return run;
  }

  /** @private */
  async _reconcileNow(actor) {
    const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;
    const relations = await this._api.get(`/entities/${entityId}/relations`);
    const list = Array.isArray(relations) ? relations : (relations?.data || []);
    const plan = planInventory(list, actor.items.contents.map((i) => ({
      id: i.id,
      relationId: i.getFlag(FLAG_SCOPE, 'relationId') ?? null,
      entityId: i.getFlag(FLAG_SCOPE, 'entityId') ?? null,
      quantity: i.system?.quantity,
      equipped: i.system?.equipped,
    })));
    if (!plan.create.length && !plan.update.length && !plan.adopt.length && !plan.remove.length) return;

    this._syncing = true;
    try {
      for (const { id, relationId } of plan.adopt) {
        await actor.items.get(id)?.setFlag(FLAG_SCOPE, 'relationId', relationId);
      }
      for (const { id, change } of plan.update) {
        await actor.items.get(id)?.update(change);
      }
      if (plan.create.length) {
        await actor.createEmbeddedDocuments('Item', plan.create.map((r) => itemDataFor(r)));
      }
      if (plan.remove.length) {
        await actor.deleteEmbeddedDocuments('Item', plan.remove);
      }
    } finally {
      this._syncing = false;
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
    if (this._syncing) return;
    if (userId !== game.user.id) return;
    if (!item.parent || !(item.parent instanceof Actor)) return;

    // Skip if already linked (came from Chronicle).
    if (item.getFlag(FLAG_SCOPE, 'relationId')) return;

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
      // Create a "Has Item" relation in Chronicle. Body is snake_case — Chronicle
      // binds target_entity_id/relation_type/reverse_relation_type (the response
      // is camelCase, but the write binding is snake_case). Metadata is a raw
      // object (json.RawMessage), not a JSON-encoded string, so it round-trips as
      // structured JSON rather than a double-encoded string.
      const relation = await this._api.post(`/entities/${entityId}/relations`, {
        target_entity_id: targetEntityId,
        relation_type: HAS_ITEM,
        reverse_relation_type: 'In Inventory Of',
        metadata: {
          quantity: item.system?.quantity ?? 1,
          equipped: item.system?.equipped ?? false,
          foundry_item_name: item.name,
        },
      });

      if (relation) {
        this._syncing = true;
        try {
          await item.setFlag(FLAG_SCOPE, 'relationId', relation.id);
        } finally {
          this._syncing = false;
        }
        console.debug(`Chronicle: Pushed new item "${item.name}" from "${actor.name}" to Chronicle`);
      }
    } catch (err) {
      console.warn(`Chronicle: Failed to push new item "${item.name}" to Chronicle`, err);
    }
  }

  /**
   * Handle Foundry deleteItem hook (item removed from actor).
   * Deletes the corresponding "Has Item" relation in Chronicle.
   * @param {Item} item
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleDeleteItem(item, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;

    const relationId = item.getFlag(FLAG_SCOPE, 'relationId');
    if (!relationId) return;

    const actor = item.parent;
    const entityId = actor?.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    try {
      // Chronicle serves a flat relation route: DELETE /relations/:relationId.
      await this._api.delete(`/relations/${relationId}`);
      console.debug(`Chronicle: Removed item relation for "${item.name}" from Chronicle`);
    } catch (err) {
      console.warn(`Chronicle: Failed to remove item relation for "${item.name}"`, err);
    }
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
    if (this._syncing) return;
    if (userId !== game.user.id) return;
    if (!change.system) return; // Only system data changes matter.

    const relationId = item.getFlag(FLAG_SCOPE, 'relationId');
    if (!relationId) return;

    const actor = item.parent;
    const entityId = actor?.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    try {
      const meta = {
        quantity: item.system?.quantity ?? 1,
        equipped: item.system?.equipped ?? false,
      };

      // Flat route PUT /relations/:relationId. Chronicle's UpdateRelation
      // binds {metadata} as json.RawMessage, so pass a plain object rather
      // than a JSON string.
      await this._api.put(`/relations/${relationId}`, {
        metadata: meta,
      });
    } catch (err) {
      console.warn(`Chronicle: Failed to update item metadata for "${item.name}"`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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
