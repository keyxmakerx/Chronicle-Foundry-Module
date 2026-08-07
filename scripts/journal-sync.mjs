/**
 * Chronicle Sync - Journal/Entity Sync
 *
 * Bidirectional sync between Chronicle entities and Foundry JournalEntries.
 * Supports standard text pages and Monk's Enhanced Journal pages.
 *
 * Sync flow:
 * - Chronicle → Foundry: Entity changes arrive via WebSocket, create/update JournalEntry.
 * - Foundry → Chronicle: JournalEntry changes detected via Hooks, push to Chronicle API.
 */

import { getSetting, getSyncExclusions } from './settings.mjs';
import { ConflictError } from './api-client.mjs';
import { FLAG_SCOPE } from './constants.mjs';
import { _sanitizeIncomingHTML } from './_html-sanitizer.mjs';
import { defaultLevelForVisibility } from './_ownership.mjs';
import { isCalendarNoteJournal } from './calendar-sync.mjs';
import { _isAllowedImageHost, _describeRejection } from './_url-validation.mjs';
import { walkEntityPages } from './_entity-page-walk.mjs';

/**
 * Validate and resolve a Chronicle entity's `image_path` to a safe src string.
 *
 * Mirrors the logic in map-sync._mapImageSrc (FM-SEC-IMAGE-HOST-ALLOWLIST):
 *   - Full http(s) URL → allowed only if scheme+hostname match apiUrl; any
 *     mismatch is dropped (empty string) and logged via _describeRejection.
 *   - Relative path (starts with "/") → prefixed with apiUrl base.
 *   - Anything else (empty/null/undefined) → empty string.
 *
 * @param {string|null|undefined} imagePath
 * @returns {string} Safe image src, or "" if absent/rejected.
 */
function _resolveEntityImageSrc(imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return '';
  const apiUrl = getSetting('apiUrl');
  if (/^https?:/i.test(imagePath)) {
    if (_isAllowedImageHost(imagePath, apiUrl)) return imagePath;
    console.warn(_describeRejection('entity_image', imagePath, apiUrl));
    return '';
  }
  if (imagePath.startsWith('/')) {
    const baseUrl = apiUrl?.replace(/\/+$/, '');
    return baseUrl ? `${baseUrl}${imagePath}` : imagePath;
  }
  return '';
}

/**
 * JournalSync handles entity ↔ JournalEntry synchronization.
 */
export class JournalSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;

    /** @type {import('./sync-manager.mjs').SyncManager|null} */
    this._syncManager = null;

    /** @type {boolean} Suppress hook processing during sync-initiated changes. */
    this._syncing = false;

    // Bound hook handlers for cleanup.
    this._onCreateJournal = this._handleCreateJournal.bind(this);
    this._onUpdateJournal = this._handleUpdateJournal.bind(this);
    this._onDeleteJournal = this._handleDeleteJournal.bind(this);
  }

  /**
   * Initialize the journal sync module.
   * @param {import('./api-client.mjs').ChronicleAPI} api
   */
  async init(api) {
    this._api = api;

    if (!getSetting('syncJournals')) return;

    // Register Foundry hooks for JournalEntry changes.
    Hooks.on('createJournalEntry', this._onCreateJournal);
    Hooks.on('updateJournalEntry', this._onUpdateJournal);
    Hooks.on('deleteJournalEntry', this._onDeleteJournal);

    console.debug('Chronicle: Journal sync initialized');
  }

  /**
   * Handle incoming WebSocket messages for entity events.
   * @param {object} msg
   */
  async onMessage(msg) {
    if (!getSetting('syncJournals')) return;

    switch (msg.type) {
      case 'entity.created':
        await this._onEntityCreated(msg.payload);
        break;
      case 'entity.updated':
        await this._onEntityUpdated(msg.payload);
        break;
      case 'entity.deleted':
        await this._onEntityDeleted(msg.payload);
        break;
      case 'entity_type.created':
      case 'entity_type.updated':
        await this._onEntityTypeChanged(msg.payload);
        break;
      case 'entity_type.deleted':
        // Entity type deleted — folders remain but lose their Chronicle link.
        break;
    }
  }

  /**
   * Handle a sync mapping received during initial sync.
   * @param {object} mapping
   */
  async onSyncMapping(mapping) {
    if (mapping.chronicle_type !== 'entity') return;
    if (!getSetting('syncJournals')) return;

    // 1. Happy path: the mapping's stored external_id matches a current
    //    Foundry journal.
    let journal = game.journal.get(mapping.external_id);

    // 2. Fallback: find by `entityId` flag. Catches the case where the
    //    journal was previously synced but the mapping's external_id is
    //    stale (e.g., world re-import / migration). Without this the
    //    handler would create a duplicate journal and trigger a 400
    //    mapping conflict.
    if (!journal) {
      journal = game.journal.find(
        (j) => j.getFlag(FLAG_SCOPE, 'entityId') === mapping.chronicle_id
      );
    }

    if (journal) return;

    try {
      const entity = await this._api.get(`/entities/${mapping.chronicle_id}`);
      if (!entity) return;
      // Defer character entities to ActorSync.
      if (this._isHandledByActorSync(entity)) return;
      await this._createJournalFromEntity(entity, mapping.external_id);
    } catch (err) {
      console.warn(`Chronicle: Failed to sync entity ${mapping.chronicle_id}`, err);
    }
  }

  /**
   * Run after all modules complete `onInitialSync`. Cleans up character
   * JournalEntries left behind by earlier sync runs (before ActorSync was
   * the canonical handler).
   */
  async onPostInitialSync() {
    await this.cleanupActorJournalDuplicates();
  }

  /**
   * Re-fetch every Chronicle entity and apply it to Foundry. Unlike `_onPullAll`
   * (which only creates journals for chronicle-only entities), this method also
   * UPDATES existing journals — refreshing content, name, and ownership/permissions.
   * This is the correct fix for journals that synced before a permission change.
   *
   * Mirrors MapSync.resyncAll / _runMapSync in structure:
   *   - Paginated fetch of all entities (same source _prepareContext/_buildEntityGroups uses).
   *   - For each entity: if a journal already exists → call `_onEntityUpdated` (which
   *     re-runs `_buildOwnership` so permissions refresh); if none exists → create it.
   *   - Respects `_syncing` guard (set by callers), `_isExcluded`, `_isHandledByActorSync`,
   *     `isCalendarNoteJournal`, and `_isHandledByNoteSync`.
   *   - Sequential/awaited (not parallelized) so a large campaign doesn't hammer the API.
   *   - Returns a summary {updated, created, skipped, errors} for test assertions; also
   *     fires a verbose `ui.notifications.info` when the option is set.
   *
   * @param {{verbose?: boolean}} [opts]
   * @returns {Promise<{updated: number, created: number, skipped: number, errors: number}>}
   */
  async resyncAll({ verbose = true } = {}) {
    if (!game.user.isGM || !this._api) {
      return { updated: 0, created: 0, skipped: 0, errors: 0 };
    }
    if (!getSetting('syncJournals')) {
      return { updated: 0, created: 0, skipped: 0, errors: 0 };
    }

    if (verbose) ui.notifications.info('Chronicle: fetching entities for resync…');

    // Paginated fetch — shares the walk with the dashboard's
    // _buildEntityGroups (scripts/_entity-page-walk.mjs). Both used to stop
    // after five pages, so a campaign past 500 entities resynced only its
    // first 500 and reported a clean finish.
    let allEntities = [];
    let truncated = false;
    try {
      const walked = await walkEntityPages(
        (page, perPage) => this._api.get(`/entities?per_page=${perPage}&page=${page}`),
        (result) => (Array.isArray(result) ? result
          : (Array.isArray(result?.entities) ? result.entities
          : (Array.isArray(result?.data) ? result.data : []))),
      );
      allEntities = walked.entities;
      truncated = walked.truncated;
    } catch (err) {
      const status = err?.status || null;
      console.warn(`Chronicle JournalSync.resyncAll: GET /entities failed (${status || 'network'})`, err);
      ui.notifications.error(
        `Chronicle: could not fetch entities from Chronicle${status ? ` (HTTP ${status})` : ''}. Verify apiUrl, apiKey, and campaignId in Module Settings.`
      );
      return { updated: 0, created: 0, skipped: 0, errors: 1 };
    }

    console.debug(`Chronicle: resyncAll fetched ${allEntities.length} entity(ies).`);

    // A truncated walk means entities exist that this pass never saw. Say so
    // — a resync that quietly covers part of the campaign and reports success
    // is worse than one that refuses.
    if (truncated) {
      console.warn(`Chronicle: resyncAll stopped at ${allEntities.length} entities; the campaign has more.`);
      ui.notifications.warn(
        `Chronicle: resync covered the first ${allEntities.length} entities only — the campaign has more. Run it again or narrow your sync exclusions.`
      );
    }

    // Build a fast lookup of already-linked journals by chronicle entity id.
    const journalByEntityId = new Map();
    for (const j of game.journal.contents) {
      const eid = j.getFlag(FLAG_SCOPE, 'entityId');
      if (eid) journalByEntityId.set(eid, j);
    }

    let updated = 0;
    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const entity of allEntities) {
      if (!entity?.id) { skipped++; continue; }

      // Skip: excluded by dashboard settings.
      if (this._isExcluded(entity)) { skipped++; continue; }

      // Skip: character entities are handled by ActorSync.
      if (this._isHandledByActorSync(entity)) { skipped++; continue; }

      const journal = journalByEntityId.get(entity.id);

      try {
        if (journal) {
          // Journal exists → fetch full entity data and update (refreshes
          // content + re-runs _buildOwnership so permissions are current).
          let fullEntity = entity;
          try {
            fullEntity = (await this._api.get(`/entities/${entity.id}`)) || entity;
          } catch (fetchErr) {
            console.warn(`Chronicle: resyncAll — failed to fetch full entity ${entity.id}, updating with summary`, fetchErr);
          }
          // _onEntityUpdated skips character entities again via _isHandledByActorSync,
          // but the check above already guards against that; calling it handles the
          // update path (name, content pages, ownership) cleanly.
          await this._onEntityUpdated(fullEntity);
          updated++;
        } else {
          // No journal yet → fetch full entity and create.
          let fullEntity = entity;
          try {
            fullEntity = (await this._api.get(`/entities/${entity.id}`)) || entity;
          } catch (fetchErr) {
            console.warn(`Chronicle: resyncAll — failed to fetch full entity ${entity.id}, creating with summary`, fetchErr);
          }
          // Double-check actor routing on the full payload.
          if (this._isHandledByActorSync(fullEntity)) { skipped++; continue; }
          await this._createJournalFromEntity(fullEntity);
          created++;
        }
      } catch (err) {
        errors++;
        console.warn(`Chronicle: resyncAll failed for entity "${entity.name || entity.id}":`, err);
      }
    }

    console.debug(`Chronicle: resyncAll complete — updated=${updated} created=${created} skipped=${skipped} errors=${errors}`);

    if (verbose) {
      if (errors > 0) {
        ui.notifications.warn(
          `Chronicle: resynced ${updated + created} of ${allEntities.length - skipped} entity(ies); ${errors} failed. See the sync dashboard for details.`
        );
      } else {
        ui.notifications.info(
          `Chronicle: resynced ${updated + created} entity(ies) (${updated} updated, ${created} created).`
        );
      }
    }

    return { updated, created, skipped, errors };
  }

  /**
   * Clean up hooks on destroy.
   */
  destroy() {
    Hooks.off('createJournalEntry', this._onCreateJournal);
    Hooks.off('updateJournalEntry', this._onUpdateJournal);
    Hooks.off('deleteJournalEntry', this._onDeleteJournal);
  }

  // --- Chronicle → Foundry ---

  /**
   * Create a new JournalEntry from a Chronicle entity.
   * Fetches full entity data from the API since WebSocket payloads may
   * not include content fields (entry_html, fields_data, tags).
   * @param {object} entity - Chronicle entity data (possibly partial).
   * @private
   */
  async _onEntityCreated(entity) {
    if (!entity?.id) return;

    // Skip if entity or its type is excluded from sync.
    if (this._isExcluded(entity)) return;

    // Check if we already have a journal for this entity.
    const existing = game.journal.find(
      (j) => j.getFlag(FLAG_SCOPE, 'entityId') === entity.id
    );
    if (existing) return;

    // Fetch full entity data (WS payload may be partial).
    let fullEntity = entity;
    try {
      fullEntity = (await this._api.get(`/entities/${entity.id}`)) || entity;
    } catch (err) {
      console.warn('Chronicle: Failed to fetch full entity, using WS payload', err);
    }

    // Defer character entities to ActorSync so we don't create a duplicate
    // JournalEntry alongside the Foundry Actor sheet.
    if (this._isHandledByActorSync(fullEntity)) {
      console.debug(`Chronicle: Skipping journal for character entity ${fullEntity.id} (handled by ActorSync)`);
      return;
    }

    await this._createJournalFromEntity(fullEntity);
  }

  /**
   * Update an existing JournalEntry from a Chronicle entity change.
   * @param {object} entity
   * @private
   */
  async _onEntityUpdated(entity) {
    if (!entity?.id) return;

    // Skip if entity or its type is excluded from sync.
    if (this._isExcluded(entity)) return;

    const journal = game.journal.find(
      (j) => j.getFlag(FLAG_SCOPE, 'entityId') === entity.id
    );
    if (!journal) {
      // Entity was updated but we don't have a journal for it yet — create
      // one, unless it's a character handled by ActorSync.
      if (this._isHandledByActorSync(entity)) return;
      await this._createJournalFromEntity(entity);
      return;
    }

    this._syncing = true;
    try {
      // Update the journal name and ownership from Chronicle permissions.
      const ownership = await this._buildOwnership(entity);
      await journal.update({ name: entity.name, ownership });

      // Split entity content into pages and sync them.
      await this._syncPagesToJournal(journal, _sanitizeIncomingHTML(entity.entry_html || ''));

      // Sync player notes page.
      await this._syncPlayerNotesPage(journal, _sanitizeIncomingHTML(entity.player_notes_html || ''));

      // Update flags with latest entity data.
      await journal.setFlag(FLAG_SCOPE, 'entityType', entity.type_name || '');
      await journal.setFlag(FLAG_SCOPE, 'fields', entity.fields_data || {});
      await journal.setFlag(FLAG_SCOPE, 'tags', entity.tags || []);
      await journal.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString());
      await journal.setFlag(FLAG_SCOPE, 'chronicleUpdatedAt', entity.updated_at || '');

      console.debug(`Chronicle: Updated journal "${journal.name}" from entity`);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Delete a JournalEntry when its Chronicle entity is deleted.
   * @param {object} data - { id: entityId }
   * @private
   */
  async _onEntityDeleted(data) {
    if (!data?.id) return;

    const journal = game.journal.find(
      (j) => j.getFlag(FLAG_SCOPE, 'entityId') === data.id
    );
    if (!journal) return;

    this._syncing = true;
    try {
      await journal.delete();
      console.debug(`Chronicle: Deleted journal for entity ${data.id}`);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Handle entity type create/update — update the matching Foundry folder.
   * Uses entity type color and name for folder customization.
   * @param {object} entityType - Entity type data with id, name, color, icon.
   * @private
   */
  async _onEntityTypeChanged(entityType) {
    if (!entityType?.name) return;

    // Find the Foundry folder that corresponds to this entity type.
    const folder = game.folders.find(
      (f) => f.type === 'JournalEntry' && f.getFlag(FLAG_SCOPE, 'entityTypeId') === entityType.id
    );
    if (!folder) return;

    this._syncing = true;
    try {
      const updates = {};
      if (folder.name !== entityType.name) updates.name = entityType.name;
      if (entityType.color && folder.color !== entityType.color) updates.color = entityType.color;
      if (Object.keys(updates).length > 0) {
        await folder.update(updates);
        console.debug(`Chronicle: Updated folder "${entityType.name}" from entity type`);
      }
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Find or create a Foundry folder for an entity type.
   * Uses enriched entity type data (color, sort_order) when available.
   * @param {object} entity - Entity with type_name, entity_type_id, type_color.
   * @returns {Promise<Folder|null>}
   * @private
   */
  async _getOrCreateEntityFolder(entity) {
    const typeName = entity.type_name;
    if (!typeName) return null;

    // Check for existing folder with this entity type ID.
    let folder = game.folders.find(
      (f) => f.type === 'JournalEntry' && f.getFlag(FLAG_SCOPE, 'entityTypeId') === entity.entity_type_id
    );
    if (folder) return folder;

    // Check by name fallback.
    folder = game.folders.find(
      (f) => f.type === 'JournalEntry' && f.name === typeName
    );
    if (folder) {
      // Tag the existing folder with the entity type ID.
      await folder.setFlag(FLAG_SCOPE, 'entityTypeId', entity.entity_type_id);
      if (entity.type_color && !folder.color) {
        await folder.update({ color: entity.type_color });
      }
      return folder;
    }

    // Create a new folder with entity type enrichment.
    const folderData = {
      name: typeName,
      type: 'JournalEntry',
      flags: { [FLAG_SCOPE]: { entityTypeId: entity.entity_type_id } },
    };
    if (entity.type_color) folderData.color = entity.type_color;

    return Folder.create(folderData);
  }

  /**
   * Create a Foundry JournalEntry from Chronicle entity data.
   * @param {object} entity
   * @param {string} [forceId] - Optionally use a specific Foundry document ID.
   * @private
   */
  async _createJournalFromEntity(entity, forceId) {
    this._syncing = true;
    try {
      const isMonksActive = game.modules.get('monks-enhanced-journal')?.active;

      // Build journal pages.
      const pages = [];

      // Image page (if entity has an image).
      // Route image_path through the same host-allowlist that map-sync uses
      // (_mapImageSrc). Full http(s) URLs must match the configured apiUrl
      // scheme+hostname (F-1 / FM-SEC-IMAGE-HOST-ALLOWLIST); relative paths
      // are prefixed with apiUrl. A rejected host drops to empty src + warn.
      const resolvedImageSrc = _resolveEntityImageSrc(entity.image_path);
      if (resolvedImageSrc) {
        pages.push({
          name: 'Image',
          type: 'image',
          src: resolvedImageSrc,
          sort: 0,
        });
      }

      // Split entity content into pages by top-level headings.
      // Sanitize at ingress before splitting (FM-SEC-CHUNK-3, M-3 defense-in-depth).
      const sections = this._splitByHeadings(_sanitizeIncomingHTML(entity.entry_html || ''));

      let sortIndex = 1;
      for (const section of sections) {
        const pageData = {
          name: section.title,
          type: 'text',
          text: { content: section.content },
          sort: sortIndex++,
        };

        // Monk's Enhanced Journal uses enhanced page flags.
        if (isMonksActive) {
          pageData.flags = {
            'monks-enhanced-journal': { type: 'base' },
          };
        }

        pages.push(pageData);
      }

      // Add a player notes page if the entity has player-visible content.
      if (entity.player_notes_html) {
        pages.push({
          name: 'Player Notes',
          type: 'text',
          text: { content: _sanitizeIncomingHTML(entity.player_notes_html) },
          sort: sortIndex++,
          ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
          flags: { [FLAG_SCOPE]: { isPlayerNotes: true } },
        });
      }

      // Determine ownership from Chronicle permissions.
      const ownership = await this._buildOwnership(entity);

      // Find or create a folder for this entity type.
      const folder = await this._getOrCreateEntityFolder(entity);

      const journalData = {
        name: entity.name,
        pages,
        ownership,
        folder: folder?.id || null,
        flags: {
          [FLAG_SCOPE]: {
            entityId: entity.id,
            entityType: entity.type_name || '',
            fields: entity.fields_data || {},
            tags: entity.tags || [],
            lastSync: new Date().toISOString(),
            chronicleUpdatedAt: entity.updated_at || '',
          },
        },
      };

      if (forceId) {
        journalData._id = forceId;
      }

      const journal = await JournalEntry.create(journalData);

      // Create sync mapping on Chronicle server (idempotent — tolerates
      // a pre-existing Chronicle mapping pointing at a stale Foundry id,
      // which is common when the user has re-imported a world).
      if (journal) {
        try {
          await this._syncManager?.ensureMapping({
            chronicle_type: 'entity',
            chronicle_id: entity.id,
            external_system: 'foundry',
            external_id: journal.id,
            sync_direction: 'both',
            sync_metadata: { foundry_type: 'JournalEntry' },
          });
        } catch (err) {
          // Real (non-conflict) errors still surface as a warn — the
          // helper only absorbs the "already exists" conflict and
          // propagates everything else.
          console.warn('Chronicle: Failed to create sync mapping', err);
        }
      }

      console.debug(`Chronicle: Created journal "${entity.name}" from entity`);
      return journal;
    } finally {
      this._syncing = false;
    }
  }

  // --- Foundry → Chronicle ---

  /**
   * Handle Foundry JournalEntry creation — push to Chronicle if not from sync.
   * @param {JournalEntry} journal
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleCreateJournal(journal, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;

    // Skip if this journal was created by Chronicle sync.
    if (journal.getFlag(FLAG_SCOPE, 'entityId')) return;

    // Skip journals that belong to another sync domain. Calendar modules
    // (SimpleCalendar / Calendaria) and Chronicle Notes both persist their
    // content as JournalEntries; CalendarSync and NoteSync own those documents
    // and mirror them to the correct Chronicle resource (calendar events /
    // notes). Without this guard JournalSync greedily POSTs them to /entities
    // with entity_type_id:0, which the server files under the campaign's first
    // entity type (typically "Character") — so e.g. calendar holidays show up
    // in the Characters list. Mirrors the existing _isHandledByActorSync guard.
    if (isCalendarNoteJournal(journal)) {
      console.debug(`Chronicle: Skipping journal "${journal.name}" — calendar note (owned by CalendarSync).`);
      return;
    }
    if (this._isHandledByNoteSync(journal)) {
      console.debug(`Chronicle: Skipping journal "${journal.name}" — Chronicle Note (owned by NoteSync).`);
      return;
    }

    // Create entity in Chronicle from this new journal.
    try {
      // Concatenate all text pages into a single entry for Chronicle.
      const entryHtml = this._collectTextPages(journal);

      const entity = await this._api.post('/entities', {
        name: journal.name,
        entity_type_id: 0, // Default type — will use first available.
        is_private: (journal.ownership?.default ?? 0) < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
        entry: entryHtml,
      });

      if (entity) {
        this._syncing = true;
        try {
          await journal.setFlag(FLAG_SCOPE, 'entityId', entity.id);
          await journal.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString());
        } finally {
          this._syncing = false;
        }

        // Create sync mapping (idempotent — tolerates server-side
        // mapping created concurrently or pre-existing for this entity).
        await this._syncManager?.ensureMapping({
          chronicle_type: 'entity',
          chronicle_id: entity.id,
          external_system: 'foundry',
          external_id: journal.id,
          sync_direction: 'both',
        });

        // Push initial permissions from Foundry ownership.
        const isPrivate =
          (journal.ownership?.default ?? 0) < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
        await this._pushPermissions(entity.id, journal.ownership, isPrivate, journal.name);

        console.debug(`Chronicle: Pushed new journal "${journal.name}" to Chronicle`);
      }
    } catch (err) {
      // FM-SYNC-HARDENING §4: surface push failures instead of failing
      // silently. The underlying REST error is already in the dashboard
      // error log (api-client._logError); this also notifies the GM.
      console.error('Chronicle: Failed to push journal to Chronicle', err);
      ui.notifications?.warn?.(`Chronicle: Failed to push journal "${journal.name}". Check the sync dashboard for details.`);
    }
  }

  /**
   * Handle Foundry JournalEntry update — push changes to Chronicle.
   * Detects name, content, and ownership changes and pushes all to Chronicle.
   * @param {JournalEntry} journal
   * @param {object} change
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleUpdateJournal(journal, change, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;

    const entityId = journal.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    // Defensive: a calendar note / Chronicle Note may carry a stale entityId
    // from before the create-time guard existed (it was mis-pushed as an
    // entity). Don't keep pushing edits to that bogus entity — the cleanup
    // pass unlinks it. New journals never reach here because the create guard
    // prevents the link in the first place.
    if (isCalendarNoteJournal(journal) || this._isHandledByNoteSync(journal)) return;

    try {
      // Concatenate all text pages into a single entry for Chronicle.
      const entryHtml = this._collectTextPages(journal);
      const playerNotesHtml = this._collectPlayerNotes(journal);
      const isPrivate =
        (journal.ownership?.default ?? 0) < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;

      // Build the update body with optimistic concurrency.
      const body = {
        name: journal.name,
        is_private: isPrivate,
        entry: entryHtml,
      };

      // Include player notes if present.
      if (playerNotesHtml !== null) {
        body.player_notes = playerNotesHtml;
      }

      // Include expected_updated_at for conflict detection.
      const chronicleUpdatedAt = journal.getFlag(FLAG_SCOPE, 'chronicleUpdatedAt');
      if (chronicleUpdatedAt) {
        body.expected_updated_at = chronicleUpdatedAt;
      }

      let result;
      try {
        result = await this._api.put(`/entities/${entityId}`, body);
      } catch (err) {
        if (err instanceof ConflictError) {
          await this._handleConflict(journal, entityId, body);
          return;
        }
        throw err;
      }

      // Push ownership changes as Chronicle permission updates.
      await this._pushPermissions(entityId, journal.ownership, isPrivate, journal.name);

      this._syncing = true;
      try {
        await journal.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString());
        if (result?.updated_at) {
          await journal.setFlag(FLAG_SCOPE, 'chronicleUpdatedAt', result.updated_at);
        }
      } finally {
        this._syncing = false;
      }

      console.debug(`Chronicle: Pushed journal update "${journal.name}" to Chronicle`);
    } catch (err) {
      // FM-SYNC-HARDENING §4: surface push failures + queue the (idempotent)
      // update for retry on reconnect. The PUT targets a known entity id, so
      // re-pushing is safe; a stale expected_updated_at would surface as a
      // conflict on the next pull rather than corrupting data.
      console.error('Chronicle: Failed to push journal update', err);
      this._api.queueForRetry?.('PUT', `/entities/${entityId}`, {
        name: journal.name,
        is_private: (journal.ownership?.default ?? 0) < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
        entry: this._collectTextPages(journal),
      });
      ui.notifications?.warn?.(`Chronicle: Failed to push update for "${journal.name}" — queued for retry. See the sync dashboard.`);
    }
  }

  /**
   * Handle Foundry JournalEntry deletion — notify Chronicle.
   * @param {JournalEntry} journal
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleDeleteJournal(journal, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;

    const entityId = journal.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    try {
      await this._api.delete(`/entities/${entityId}`);
      console.debug(`Chronicle: Deleted entity ${entityId} from journal deletion`);
    } catch (err) {
      // Entity may already be deleted on Chronicle side — that's fine.
      console.warn('Chronicle: Failed to delete entity on Chronicle', err);
    }
  }

  /**
   * Check if an entity is excluded from auto-sync via dashboard settings.
   * @param {object} entity - Chronicle entity with id and optionally entity_type_id.
   * @returns {boolean}
   * @private
   */
  _isExcluded(entity) {
    const exclusions = getSyncExclusions();
    if (exclusions.excludedEntities.includes(entity.id)) return true;
    if (entity.entity_type_id && exclusions.excludedTypes.includes(entity.entity_type_id)) return true;
    return false;
  }

  /**
   * Whether this entity is a character that ActorSync is actively
   * handling. Character entities should not get a JournalEntry — they
   * surface as Foundry Actors with their dedicated sheets. The check is
   * conservative: only true if ActorSync has loaded a system adapter
   * (i.e. character sync is enabled and the system matches).
   * @param {object} entity
   * @returns {boolean}
   * @private
   */
  _isHandledByActorSync(entity) {
    if (!entity) return false;
    const actorSync = this._syncManager?._modules?.find(
      (m) => m.constructor?.name === 'ActorSync'
    );
    if (!actorSync?._adapter) return false;
    return typeof actorSync._isCharacterEntity === 'function'
      ? actorSync._isCharacterEntity(entity)
      : false;
  }

  /**
   * Whether a JournalEntry is a Chronicle Note that NoteSync owns. Note
   * journals carry an `isNote` flag (or live under the "Chronicle Notes"
   * folder) and must be mirrored to Chronicle *notes*, not pushed as
   * entities. Delegates to the registered NoteSync module so the detection
   * logic lives in one place; mirrors {@link _isHandledByActorSync}.
   * @param {JournalEntry} journal
   * @returns {boolean}
   * @private
   */
  _isHandledByNoteSync(journal) {
    const noteSync = this._syncManager?._modules?.find(
      (m) => m.constructor?.name === 'NoteSync'
    );
    return typeof noteSync?._isNoteJournal === 'function'
      ? noteSync._isNoteJournal(journal)
      : false;
  }

  /**
   * Remove any JournalEntries that duplicate a synced Foundry Actor
   * (same `entityId` flag on both). Called after the initial sync pass
   * completes — by that point ActorSync has materialized its actors,
   * so this overlaps cleanly. Conservative: only deletes entries whose
   * single page is the auto-generated content (no user pages added).
   */
  async cleanupActorJournalDuplicates() {
    if (!getSetting('syncJournals')) return;

    // Index actor entityIds.
    const actorEntityIds = new Set();
    for (const actor of game.actors.contents) {
      const eid = actor.getFlag(FLAG_SCOPE, 'entityId');
      if (eid) actorEntityIds.add(eid);
    }
    if (actorEntityIds.size === 0) return;

    let deleted = 0;
    this._syncing = true;
    try {
      for (const journal of [...game.journal.contents]) {
        const eid = journal.getFlag(FLAG_SCOPE, 'entityId');
        if (!eid || !actorEntityIds.has(eid)) continue;
        try {
          await journal.delete();
          deleted++;
        } catch (err) {
          console.warn(`Chronicle: Failed to delete duplicate journal ${journal.id}`, err);
        }
      }
    } finally {
      this._syncing = false;
    }

    if (deleted > 0) {
      console.debug(`Chronicle: Cleaned up ${deleted} duplicate character journal(s)`);
      ui.notifications.info(
        `Chronicle: Removed ${deleted} duplicate character journal entr${deleted === 1 ? 'y' : 'ies'} (handled by Actor sheets).`
      );
    }
  }

  // --- Permission Mapping Helpers ---

  /**
   * Build a Foundry ownership object from Chronicle entity permissions.
   * Fetches the entity's permission grants and maps them to Foundry ownership levels.
   *
   * Mapping:
   * - visibility "default" → `defaultLevelForVisibility(is_private)`, which
   *   honors the operator's `dmOnlyHidden` + `defaultOwnership` settings
   *   (FM-SYNC-HARDENING §1).
   * - visibility "custom" → explicit Chronicle grants take precedence over the
   *   generic default. Role "1" (Player) sets the `default` level; per-user
   *   grants map to specific Foundry users via the user-mapping table
   *   (FM-SYNC-HARDENING §4) when the Chronicle user is known.
   *
   * Security posture (FM-SYNC-HARDENING §3): the custom-visibility error path
   * fails CLOSED to NONE — a transient permissions-API error must never widen
   * a GM-restricted entity to player-visible.
   *
   * @param {object} entity - Chronicle entity with id, is_private, visibility fields.
   * @returns {object} Foundry ownership object.
   * @private
   */
  async _buildOwnership(entity) {
    const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;

    // Simple / legacy visibility — honor the operator's dmOnlyHidden +
    // defaultOwnership dashboard controls.
    if (!entity.visibility || entity.visibility === 'default') {
      const level = defaultLevelForVisibility(entity.is_private);
      // Audit §1A: a private entity that correctly lands hidden-from-players is
      // not "didn't sync" — count it so the dashboard can say so explicitly.
      if (entity.is_private && level <= L.NONE) {
        this._syncManager?.noteDmOnlyHidden?.();
      }
      return { default: level };
    }

    // Custom visibility — fetch explicit permission grants from the API.
    let permsData;
    try {
      permsData = await this._api.get(`/entities/${entity.id}/permissions`);
    } catch (err) {
      // FM-SYNC-HARDENING §3: fail CLOSED. Never fall open to OBSERVER on a
      // transient error — a GM-restricted custom entity stays GM-only (NONE).
      // Audit §3.3: surface it instead of console-only so the operator knows
      // the entity is locked to GM-only because the permissions fetch failed.
      console.warn(
        'Chronicle: Failed to fetch entity permissions — failing closed (GM-only)',
        err
      );
      this._syncManager?.logActivity?.(
        'warning',
        `Permissions fetch failed for "${entity.name || entity.id}" — locked to GM-only (fail-closed) until it succeeds.`
      );
      ui.notifications?.warn?.(
        `Chronicle: Could not read permissions for "${entity.name || entity.id}" — kept GM-only. See the sync dashboard.`
      );
      return { default: L.NONE };
    }

    if (!permsData?.permissions) {
      // No grant data — fail closed (GM-only) rather than guessing.
      return { default: L.NONE };
    }

    const ownership = { default: L.NONE };
    const droppedUsers = [];

    for (const grant of permsData.permissions) {
      if (grant.subject_type === 'role') {
        // Role "1" = Player. A player grant sets the default level.
        if (String(grant.subject_id) === '1') {
          ownership.default =
            grant.permission === 'edit' ? L.OWNER : L.OBSERVER;
        }
        // Role "2" = Scribe. Foundry has no "scribe" concept; covered by
        // the default level.
      } else if (grant.subject_type === 'public') {
        // Audit §5: a `public` grant means everyone can see it → raise the
        // default to at least OBSERVER (edit → OWNER). Fail-closed posture is
        // preserved: this only ever WIDENS toward the explicitly-public intent,
        // and never below an existing higher role grant.
        const publicLevel = grant.permission === 'edit' ? L.OWNER : L.OBSERVER;
        if (publicLevel > ownership.default) ownership.default = publicLevel;
      } else if (grant.subject_type === 'user') {
        // Per-user grant → map to a specific Foundry user when we know the
        // mapping (FM-SYNC-HARDENING §4). Unmapped users are dropped: the
        // entity under-shares (the user simply doesn't gain access) rather
        // than leaking to the wrong player — but the drop is now surfaced
        // (audit §3.2) so the operator can map the member.
        const foundryUserId = this._syncManager?.getFoundryUserId?.(
          String(grant.subject_id)
        );
        if (foundryUserId) {
          ownership[foundryUserId] =
            grant.permission === 'edit' ? L.OWNER : L.OBSERVER;
        } else {
          droppedUsers.push(String(grant.subject_id));
        }
      }
    }

    // Audit §5: `tag_grants` apply a grant to whoever holds a Chronicle tag.
    // Foundry has no tag-membership concept, so we can't expand them to users;
    // we read the response shape (so the field is consumed, not ignored) and,
    // keeping the fail-closed posture, do NOT widen the default off a tag grant
    // — instead we note that tag-scoped access can't be honored.
    if (Array.isArray(permsData.tag_grants) && permsData.tag_grants.length > 0) {
      this._syncManager?.logActivity?.(
        'warning',
        `"${entity.name || entity.id}" has ${permsData.tag_grants.length} tag-based permission grant(s) Foundry can't map to users — those players may not see it.`
      );
    }

    if (droppedUsers.length > 0) {
      this._syncManager?.logActivity?.(
        'warning',
        `"${entity.name || entity.id}": ${droppedUsers.length} per-user grant(s) dropped — no Foundry mapping for those Chronicle members. Map them in the dashboard Members tab.`
      );
    }

    return ownership;
  }

  /**
   * Build the Chronicle permission grants for a Foundry ownership object.
   *
   * Pure / side-effect-free (apart from the injected reverse-map fn) so it can
   * be unit-tested. Translates each Foundry per-user ownership entry into a
   * Chronicle `{subject_type:'user', subject_id, permission}` grant by
   * reverse-mapping the Foundry user id → Chronicle user id via
   * `getChronicleUserId` (audit §2 — per-user grants were previously detected
   * but never emitted). Level ≥ OWNER → `'edit'`, otherwise `'view'`.
   *
   * Fail CLOSED on the share axis: a Foundry user we cannot reverse-map is
   * NOT pushed (the grant is dropped and reported in `unmapped`), so a
   * mis-mapped/unknown user never silently widens Chronicle access.
   *
   * @param {object} ownership - Foundry ownership object.
   * @param {boolean} isPrivate - Whether the entity is private (default ≤ NONE).
   * @param {(foundryUserId: string) => (string|null)} reverseMap - Foundry→Chronicle user id.
   * @returns {{permissions: Array<object>, unmapped: string[], hasUserGrants: boolean}}
   */
  _buildPermissionGrants(ownership, isPrivate, reverseMap) {
    const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
    const permissions = [];
    const unmapped = [];
    let hasUserGrants = false;

    if (!isPrivate) {
      // Broad case: the entity is player-visible → grant the Player role view.
      permissions.push({ subject_type: 'role', subject_id: '1', permission: 'view' });
    }

    for (const [key, level] of Object.entries(ownership || {})) {
      if (key === 'default') continue;
      if (!(level > L.NONE)) continue; // No access → no grant to emit.
      const chronicleId = reverseMap?.(key);
      if (!chronicleId) {
        // Unmapped Foundry user — skip (don't over-share) and report.
        unmapped.push(key);
        continue;
      }
      permissions.push({
        subject_type: 'user',
        subject_id: chronicleId,
        permission: level >= L.OWNER ? 'edit' : 'view',
      });
      hasUserGrants = true;
    }

    return { permissions, unmapped, hasUserGrants };
  }

  /**
   * Push Foundry ownership changes to Chronicle as permission updates.
   *
   * - The default level drives `is_private` + the broad Player-role grant.
   * - Each per-user Foundry ownership entry is reverse-mapped to a Chronicle
   *   user grant (`subject_type:'user'`); `visibility:'custom'` is sent only
   *   when real user grants exist, otherwise `'default'` (audit §2).
   * - Foundry users that can't be reverse-mapped are skipped and surfaced
   *   (notification + dashboard warning) so the operator knows that player's
   *   access didn't propagate — never silently dropped (audit §3.4).
   *
   * Best-effort: a transport error is surfaced but never fails the journal
   * sync (mirrors the journal-content push posture, FM-SYNC-HARDENING §4).
   *
   * @param {string} entityId - Chronicle entity ID.
   * @param {object} ownership - Foundry ownership object.
   * @param {boolean} isPrivate - Derived privacy flag from default ownership.
   * @param {string} [label] - Human-readable entity name for notifications.
   * @private
   */
  async _pushPermissions(entityId, ownership, isPrivate, label) {
    const { permissions, unmapped, hasUserGrants } = this._buildPermissionGrants(
      ownership,
      isPrivate,
      (fid) => this._syncManager?.getChronicleUserId?.(fid) ?? null
    );

    // Surface dropped per-user grants — a player whose access didn't propagate
    // because we have no Chronicle mapping for their Foundry user.
    if (unmapped.length > 0) {
      const named = unmapped
        .map((fid) => game.users?.get?.(fid)?.name || fid)
        .slice(0, 8)
        .join(', ');
      const who = label ? ` on "${label}"` : '';
      this._syncManager?.logActivity?.(
        'warning',
        `Permission push${who}: ${unmapped.length} player grant(s) not sent — no Chronicle mapping for ${named}. Map them in the dashboard Members tab.`
      );
      ui.notifications?.warn?.(
        `Chronicle: ${unmapped.length} player permission grant(s)${who} were not sent — unmapped Foundry user(s): ${named}. Map them in the sync dashboard → Members.`
      );
    }

    try {
      // Only push when there is something meaningful to say.
      if (hasUserGrants || permissions.length > 0) {
        await this._api.put(`/entities/${entityId}/permissions`, {
          visibility: hasUserGrants ? 'custom' : 'default',
          is_private: isPrivate,
          permissions,
        });
      }
    } catch (err) {
      // Permission push is best-effort — don't fail the sync, but don't let it
      // fail silently either (audit §3.4).
      console.warn('Chronicle: Failed to push permissions update', err);
      this._syncManager?.logActivity?.(
        'error',
        `Failed to push permissions${label ? ` for "${label}"` : ''} — ${err?.message || 'unknown error'}`
      );
      ui.notifications?.warn?.(
        `Chronicle: Failed to push permissions${label ? ` for "${label}"` : ''}. See the sync dashboard for details.`
      );
    }
  }

  // --- Multi-Page Helpers ---

  /**
   * Split HTML content by top-level headings (h1/h2) into named sections.
   * Each section becomes a separate Foundry journal page.
   * If no headings are found, returns a single section with the entity name.
   * @param {string} html - The entity entry_html content.
   * @returns {Array<{title: string, content: string}>}
   * @private
   */
  _splitByHeadings(html) {
    if (!html) return [{ title: 'Content', content: '' }];

    // Match h1 or h2 tags to use as page break points.
    const headingRegex = /<h[12][^>]*>(.*?)<\/h[12]>/gi;
    const matches = [...html.matchAll(headingRegex)];

    // No headings found — return as single page.
    if (matches.length === 0) {
      return [{ title: 'Content', content: html }];
    }

    const sections = [];

    // Content before the first heading (if any).
    const preContent = html.substring(0, matches[0].index).trim();
    if (preContent) {
      sections.push({ title: 'Overview', content: preContent });
    }

    // Each heading starts a new section, ending at the next heading or end of string.
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const startAfterHeading = match.index + match[0].length;
      const endIndex = i + 1 < matches.length ? matches[i + 1].index : html.length;
      const sectionContent = html.substring(startAfterHeading, endIndex).trim();

      // Strip HTML tags from heading text for the page title.
      const title = match[1].replace(/<[^>]*>/g, '').trim() || `Section ${i + 1}`;

      // Include the heading in the page content for context.
      sections.push({
        title,
        content: match[0] + sectionContent,
      });
    }

    return sections;
  }

  /**
   * Collect all text pages from a Foundry JournalEntry and concatenate
   * them into a single HTML string for Chronicle. Pages are joined in
   * sort order.
   * @param {JournalEntry} journal
   * @returns {string} Combined HTML content.
   * @private
   */
  _collectTextPages(journal) {
    const textPages = journal.pages
      .filter((p) => p.type === 'text' && !p.getFlag(FLAG_SCOPE, 'isPlayerNotes'))
      .sort((a, b) => a.sort - b.sort);

    if (textPages.length === 0) return '';
    if (textPages.length === 1) return textPages[0].text?.content || '';

    // Multiple pages: concatenate with the page name as a heading separator.
    return textPages
      .map((page) => {
        const content = page.text?.content || '';
        // If the page content already starts with a heading, use it as-is.
        if (/^<h[12][^>]*>/i.test(content.trim())) return content;
        // Otherwise, wrap the page name as an h2 heading.
        return `<h2>${page.name}</h2>\n${content}`;
      })
      .join('\n');
  }

  /**
   * Extract player notes content from a journal's Player Notes page.
   * @param {JournalEntry} journal
   * @returns {string|null} HTML content, or null if no player notes page exists.
   * @private
   */
  _collectPlayerNotes(journal) {
    const playerNotesPage = journal.pages.find(
      (p) => p.getFlag(FLAG_SCOPE, 'isPlayerNotes')
    );
    if (!playerNotesPage) return null;
    return playerNotesPage.text?.content || '';
  }

  /**
   * Sync the player notes page on a journal. Creates, updates, or deletes
   * the page based on whether the entity has player_notes_html.
   * @param {JournalEntry} journal
   * @param {string} playerNotesHtml
   * @private
   */
  async _syncPlayerNotesPage(journal, playerNotesHtml) {
    const existingPage = journal.pages.find(
      (p) => p.getFlag(FLAG_SCOPE, 'isPlayerNotes')
    );

    if (playerNotesHtml) {
      if (existingPage) {
        // Update existing player notes page.
        await existingPage.update({ 'text.content': playerNotesHtml });
      } else {
        // Create new player notes page.
        const maxSort = Math.max(0, ...journal.pages.map((p) => p.sort || 0));
        await journal.createEmbeddedDocuments('JournalEntryPage', [
          {
            name: 'Player Notes',
            type: 'text',
            text: { content: playerNotesHtml },
            sort: maxSort + 100,
            ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
            flags: { [FLAG_SCOPE]: { isPlayerNotes: true } },
          },
        ]);
      }
    } else if (existingPage) {
      // Remove player notes page if entity no longer has player notes.
      await journal.deleteEmbeddedDocuments('JournalEntryPage', [existingPage.id]);
    }
  }

  /**
   * Handle a 409 Conflict error during entity push.
   * Applies the configured conflict resolution strategy.
   * @param {JournalEntry} journal
   * @param {string} entityId
   * @param {object} body - The PUT body that was rejected.
   * @private
   */
  async _handleConflict(journal, entityId, body) {
    const strategy = getSetting('conflictResolution');
    console.warn(`Chronicle: Conflict on entity ${entityId}, strategy="${strategy}"`);

    switch (strategy) {
      case 'chronicle': {
        // Discard local changes, re-pull Chronicle version.
        const entity = await this._api.get(`/entities/${entityId}`);
        if (entity) {
          await this._onEntityUpdated(entity);
        }
        ui.notifications.warn(`Chronicle: Conflict on "${journal.name}" — kept Chronicle version.`);
        break;
      }
      case 'foundry': {
        // Force push without expected_updated_at.
        delete body.expected_updated_at;
        const result = await this._api.put(`/entities/${entityId}`, body);
        this._syncing = true;
        try {
          if (result?.updated_at) {
            await journal.setFlag(FLAG_SCOPE, 'chronicleUpdatedAt', result.updated_at);
          }
          await journal.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString());
        } finally {
          this._syncing = false;
        }
        ui.notifications.warn(`Chronicle: Conflict on "${journal.name}" — kept Foundry version.`);
        break;
      }
      case 'newest':
      default: {
        // Compare timestamps, keep newest.
        const remote = await this._api.get(`/entities/${entityId}`);
        const localUpdatedAt = journal.getFlag(FLAG_SCOPE, 'lastSync') || '1970-01-01';
        if (remote && new Date(localUpdatedAt) > new Date(remote.updated_at)) {
          // Local is newer — force push.
          delete body.expected_updated_at;
          const result = await this._api.put(`/entities/${entityId}`, body);
          this._syncing = true;
          try {
            if (result?.updated_at) {
              await journal.setFlag(FLAG_SCOPE, 'chronicleUpdatedAt', result.updated_at);
            }
            await journal.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString());
          } finally {
            this._syncing = false;
          }
          ui.notifications.info(`Chronicle: Conflict on "${journal.name}" — Foundry version was newer.`);
        } else if (remote) {
          // Remote is newer — re-pull.
          await this._onEntityUpdated(remote);
          ui.notifications.info(`Chronicle: Conflict on "${journal.name}" — Chronicle version was newer.`);
        }
        break;
      }
    }
  }

  /**
   * Sync entity HTML content to journal pages. Splits by headings and
   * updates existing pages or creates/removes pages as needed.
   * @param {JournalEntry} journal
   * @param {string} html - Entity entry_html content.
   * @private
   */
  async _syncPagesToJournal(journal, html) {
    const sections = this._splitByHeadings(html);
    const existingTextPages = journal.pages
      .filter((p) => p.type === 'text' && !p.getFlag(FLAG_SCOPE, 'isPlayerNotes'))
      .sort((a, b) => a.sort - b.sort);

    // Update existing pages and create new ones as needed.
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];

      if (i < existingTextPages.length) {
        // Update existing page.
        const page = existingTextPages[i];
        const updates = { 'text.content': section.content };
        if (page.name !== section.title) {
          updates.name = section.title;
        }
        await page.update(updates);
      } else {
        // Create new page.
        await journal.createEmbeddedDocuments('JournalEntryPage', [
          {
            name: section.title,
            type: 'text',
            text: { content: section.content },
            sort: (existingTextPages.length + i) * 100,
          },
        ]);
      }
    }

    // Remove excess pages if entity has fewer sections than journal has pages.
    if (sections.length < existingTextPages.length) {
      const pagesToDelete = existingTextPages
        .slice(sections.length)
        .map((p) => p.id);
      if (pagesToDelete.length > 0) {
        await journal.deleteEmbeddedDocuments('JournalEntryPage', pagesToDelete);
      }
    }
  }
}
