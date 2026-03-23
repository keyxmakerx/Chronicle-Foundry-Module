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
 * - Chronicle → Foundry: Relation events arrive via WebSocket, add/remove Actor items.
 * - Foundry → Chronicle: Item hooks on Actors push to Chronicle API as relations.
 */

import { getSetting } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';

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
   * Handle incoming WebSocket messages for relation events.
   * Processes "Has Item" relations to sync inventory.
   * @param {object} msg
   */
  async onMessage(msg) {
    if (!this._api) return;

    // Handle relation events for item inventory.
    if (msg.type === 'relation.created') {
      await this._onRelationCreated(msg.payload);
    } else if (msg.type === 'relation.deleted') {
      await this._onRelationDeleted(msg.payload);
    } else if (msg.type === 'relation.metadata_updated') {
      await this._onRelationMetadataUpdated(msg.payload);
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

  /**
   * Perform initial sync: pull inventory relations for linked actors.
   */
  async onInitialSync() {
    if (!this._api) return;

    // For each synced actor, pull their "Has Item" relations.
    const syncedActors = game.actors.filter(
      (a) => a.getFlag(FLAG_SCOPE, 'entityId')
    );

    for (const actor of syncedActors) {
      const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
      if (!entityId) continue;

      try {
        const relations = await this._api.get(`/entities/${entityId}/relations`);
        const itemRelations = (relations || []).filter(
          (r) => r.relationType === 'Has Item'
        );

        // Reconcile Foundry inventory with Chronicle relations.
        for (const rel of itemRelations) {
          await this._ensureFoundryItem(actor, rel);
        }
      } catch (err) {
        console.warn(`Chronicle: Failed to sync inventory for "${actor.name}"`, err);
      }
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
  // Chronicle → Foundry
  // ---------------------------------------------------------------------------

  /**
   * Handle a new "Has Item" relation from Chronicle.
   * Adds the item to the Foundry actor's inventory.
   * @param {object} relation
   * @private
   */
  async _onRelationCreated(relation) {
    if (relation.relationType !== 'Has Item') return;

    // Find the linked Foundry actor for the source entity.
    const actor = game.actors.find(
      (a) => a.getFlag(FLAG_SCOPE, 'entityId') === relation.sourceEntityId
    );
    if (!actor) return;

    await this._ensureFoundryItem(actor, relation);
  }

  /**
   * Handle a deleted "Has Item" relation from Chronicle.
   * Removes the item from the Foundry actor's inventory.
   * @param {object} data
   * @private
   */
  async _onRelationDeleted(data) {
    if (data.relationType !== 'Has Item') return;

    const actor = game.actors.find(
      (a) => a.getFlag(FLAG_SCOPE, 'entityId') === data.sourceEntityId
    );
    if (!actor) return;

    // Find the Foundry item linked to this relation.
    const item = actor.items.find(
      (i) => i.getFlag(FLAG_SCOPE, 'relationId') === data.id
    );
    if (!item) return;

    try {
      this._syncing = true;
      await item.delete();
      console.debug(`Chronicle: Removed item "${item.name}" from "${actor.name}" inventory`);
    } catch (err) {
      console.error('Chronicle: Failed to remove inventory item', err);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Handle updated relation metadata (quantity, equipped, attuned).
   * @param {object} data
   * @private
   */
  async _onRelationMetadataUpdated(data) {
    if (data.relationType !== 'Has Item') return;

    const actor = game.actors.find(
      (a) => a.getFlag(FLAG_SCOPE, 'entityId') === data.sourceEntityId
    );
    if (!actor) return;

    const item = actor.items.find(
      (i) => i.getFlag(FLAG_SCOPE, 'relationId') === data.id
    );
    if (!item) return;

    try {
      this._syncing = true;
      const meta = typeof data.metadata === 'string'
        ? JSON.parse(data.metadata)
        : data.metadata || {};

      const updateData = {};
      if (meta.quantity !== undefined) {
        updateData['system.quantity'] = meta.quantity;
      }
      if (meta.equipped !== undefined) {
        updateData['system.equipped'] = meta.equipped;
      }

      if (Object.keys(updateData).length > 0) {
        await item.update(updateData);
      }
      console.debug(`Chronicle: Updated item "${item.name}" metadata in "${actor.name}" inventory`);
    } catch (err) {
      console.error('Chronicle: Failed to update inventory item metadata', err);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Ensure a Foundry item exists on the actor for a Chronicle relation.
   * @param {Actor} actor
   * @param {object} relation
   * @private
   */
  async _ensureFoundryItem(actor, relation) {
    // Check if already linked.
    const existing = actor.items.find(
      (i) => i.getFlag(FLAG_SCOPE, 'relationId') === relation.id
    );
    if (existing) return;

    try {
      this._syncing = true;
      const meta = typeof relation.metadata === 'string'
        ? JSON.parse(relation.metadata)
        : relation.metadata || {};

      const itemData = {
        name: relation.targetEntityName || 'Unknown Item',
        type: 'equipment', // Default Foundry item type.
        flags: {
          [FLAG_SCOPE]: {
            relationId: relation.id,
            entityId: relation.targetEntityId,
            lastSync: new Date().toISOString(),
          },
        },
        system: {
          quantity: meta.quantity ?? 1,
          equipped: meta.equipped ?? false,
        },
      };

      await actor.createEmbeddedDocuments('Item', [itemData]);
      console.debug(`Chronicle: Added "${itemData.name}" to "${actor.name}" inventory`);
    } catch (err) {
      console.error('Chronicle: Failed to add item to actor inventory', err);
    } finally {
      this._syncing = false;
    }
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

    try {
      // Create a "Has Item" relation in Chronicle.
      const relation = await this._api.post(`/entities/${entityId}/relations`, {
        targetEntityId: null, // No linked Chronicle item entity (custom item).
        relationType: 'Has Item',
        reverseRelationType: 'In Inventory Of',
        metadata: JSON.stringify({
          quantity: item.system?.quantity ?? 1,
          equipped: item.system?.equipped ?? false,
          foundry_item_name: item.name,
        }),
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
      await this._api.delete(`/entities/${entityId}/relations/${relationId}`);
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

      await this._api.put(`/entities/${entityId}/relations/${relationId}/metadata`, {
        metadata: JSON.stringify(meta),
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
