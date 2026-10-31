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

import { flagRemoval } from './_flag-removal.mjs';
import { noticeText } from './_escape-html.mjs';
import { getSetting, setSetting, getSyncExclusions } from './settings.mjs';
import { ConflictError } from './api-client.mjs';
import { FLAG_SCOPE, syncOptions } from './constants.mjs';
import { TYPE_SLUG_FLAG } from './_shop-journal.mjs';
import { _sanitizeIncomingHTML } from './_html-sanitizer.mjs';
import {
  toFoundrySecrets, toChronicleSecrets, secretBlockRanges, PART_ATTR,
  hideSecrets, restoreSecrets, secretKeyer, hasClearSecrets, DEFAULT_PLACEHOLDER_TEXT,
  applyReveals, carryReveals, revealableSecrets,
} from './_gm-secrets.mjs';
import { watchGMSecrets } from './gm-secret-view.mjs';
import { newJournalSheetFlags } from './chronicle-sheet.mjs';
import { playerSafeFacts } from './_chronicle-sheet-model.mjs';
import { defaultLevelForVisibility } from './_ownership.mjs';
import { isCalendarNoteJournal } from './calendar-sync.mjs';
import { _isAllowedImageHost, _describeRejection } from './_url-validation.mjs';
import { walkEntityPages, unwrapEntityList } from './_entity-page-walk.mjs';
import { folderChain, layoutFingerprint } from './_folder-tree.mjs';
import { KeyedQueue } from './_keyed-queue.mjs';
import { isMapJournal } from './_journal-ownership.mjs';
import { pickJournalCreateType, buildEntityCreateBody } from './_journal-create.mjs';
import { JournalPushDebouncer } from './_journal-push-debounce.mjs';
import { mergeJournalChange, changedJournalFields } from './_journal-push-fields.mjs';
import { setAside } from './_set-aside.mjs';
import { isOldNotesJournal } from './_notes-folder.mjs';
import { queueRemoteDelete } from './_remote-deletes.mjs';
import { collapseChanges } from './_change-feed.mjs';
import { sharedPictureIds, toFoundryPictures, toChroniclePictures } from './_inline-pictures.mjs';
import { PictureStore, watchGMPictures } from './picture-store.mjs';


/** The facts flag write for a journal update; nothing when facts are unknown. */
function factsUpdate(facts) {
  return facts ? { [`flags.${FLAG_SCOPE}.facts`]: facts } : {};
}

/**
 * Validate and resolve a Chronicle entity's `image_path` to a safe src
 * string. Mirrors map-sync._mapImageSrc's host allowlist: a full http(s)
 * URL is allowed only if scheme+hostname match apiUrl (any mismatch drops
 * to "" and is logged); a relative path is prefixed with the apiUrl base.
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
/**
 * Where a page that breaks at heading match `m` starts: at the heading, or
 * earlier at the GM-only start of that same heading, which pull split into
 * a secret block just before it.
 * @param {string} html
 * @param {RegExpMatchArray} m
 * @param {Array<[number, number]>} secret - secretBlockRanges(html)
 * @returns {number}
 */
function headingStart(html, m, secret) {
  const part = getPart(m[0]);
  let start = m.index;
  if (!part) return start;
  for (;;) {
    const before = secret.find(([, end]) => end <= start && !html.slice(end, start).trim());
    if (!before || getPart(html.slice(before[0], before[1])) !== part) return start;
    start = before[0];
  }
}

function getPart(html) {
  const tag = /^<[^>]*>/.exec(html);
  const m = tag && new RegExp(`\\s${PART_ATTR}=(["'])([^"']*)\\1`, 'i').exec(tag[0]);
  return m ? m[2] : null;
}

/** True when page text begins with an h1/h2, after any GM-only start of it. */
function startsWithHeading(content) {
  const text = content.trim();
  if (/^<h[12][^>]*>/i.test(text)) return true;
  const at = secretBlockRanges(text);
  let pos = 0;
  for (const [start, end] of at) {
    if (start !== pos) break;
    pos = end;
    while (/\s/.test(text[pos] || '')) pos++;
  }
  return pos > 0 && /^<h[12][^>]*>/i.test(text.slice(pos));
}

/**
 * Text a saved page shows where GM-only content was. Owners of a page see
 * it; the GM's client shows the content over it.
 * @returns {string}
 */
/** Journals re-pulled per connect to hide GM-only text an older version stored. */
const STORED_SECRET_PULLS_PER_CONNECT = 20;

function secretPlaceholderText() {
  const key = 'CHRONICLE.Secrets.Placeholder';
  const text = globalThis.game?.i18n?.localize?.(key);
  return text && text !== key ? text : DEFAULT_PLACEHOLDER_TEXT;
}

export class JournalSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;

    /** @type {import('./sync-manager.mjs').SyncManager|null} */
    this._syncManager = null;

    // Incoming Chronicle changes apply per entity, in arrival order. Writes
    // sync makes carry syncOptions(), which the Foundry hooks use to ignore
    // only sync's own echoes (a GM edit made meanwhile still pushes).
    /** @type {KeyedQueue} */
    this._queue = new KeyedQueue();

    // Chronicle's categories, sidebar folders and the parents of pages seen,
    // for placing journals in matching Foundry folders (_folder-tree.mjs).
    this._tree = { types: new Map(), folders: new Map(), parents: new Map() };
    /** Folder creates in flight by level key, so a burst makes one folder. */
    this._folderMaking = new Map();

    /**
     * Journals whose create POST is in flight (journal id -> name). The
     * `entity.created` broadcast can arrive before the POST returns and the
     * journal is flagged; without this it would spawn a second journal.
     * @type {Map<string, string>}
     */
    this._inFlightCreates = new Map();

    /** Entity ids seen / completeness of the last full walk, for reconcile. */
    this._lastWalk = null;

    /**
     * GM-only content behind each placeholder in a journal page (placeholder
     * id -> Chronicle HTML). Memory only, on the GM's client: a saved page
     * never holds it (scripts/_gm-secrets.mjs).
     * @type {Map<string, string>}
     */
    this._secretPieces = new Map();
    /** @type {Map<string, Promise<void>>} entity id -> read in flight */
    this._secretLoads = new Map();
    /** Journals already warned about this session, by id. */
    this._warnedUnrestored = new Set();
    /** Entities whose GM-only content the view has read this session. */
    this._secretViewLoaded = new Set();
    this._stopGMSecrets = null;

    // Bound hook handlers for cleanup.
    this._onCreateJournal = this._handleCreateJournal.bind(this);
    this._onUpdateJournal = this._handleUpdateJournal.bind(this);
    this._onDeleteJournal = this._handleDeleteJournal.bind(this);
    this._onPageChange = this._handlePageChange.bind(this);
    this._onPageUpdate = (page, change, options, userId) => this._handlePageChange(page, options, userId);
    this._onPreUpdatePage = this._fillReveals.bind(this);
    this._onCloseJournalSheet = this._handleCloseJournalSheet.bind(this);
    this._onBeforeUnload = () => this._journalPushDebouncer.flushAll();

    // Debounce Foundry -> Chronicle pushes per journal: a GM typing fires
    // updateJournalEntry repeatedly, and a PUT per edit would run into the
    // API key's 60 requests/minute limit (API-CONTRACT.md). A pending push
    // is flushed on journal close and world unload, so the last edit is
    // never left behind a timer that doesn't get to fire.
    /** Name/ownership changes seen since a journal's last push, by journal id. */
    this._pendingJournalChanges = new Map();
    this._journalPushDebouncer = new JournalPushDebouncer(
      (journal, entityId) => { this._pushJournalUpdate(journal, entityId); }
    );
  }

  /**
   * Initialize the journal sync module.
   * @param {import('./api-client.mjs').ChronicleAPI} api
   */
  async init(api) {
    this._api = api;

    if (!getSetting('syncJournals')) return;

    this._pictures = new PictureStore({ api });
    if (game.user?.isGM) this._stopGMPictures = watchGMPictures(this._pictures);

    // Register Foundry hooks for JournalEntry changes.
    Hooks.on('createJournalEntry', this._onCreateJournal);
    Hooks.on('updateJournalEntry', this._onUpdateJournal);
    Hooks.on('deleteJournalEntry', this._onDeleteJournal);
    // Page text lives in embedded pages, whose edits fire their own hooks
    // and never updateJournalEntry.
    Hooks.on('createJournalEntryPage', this._onPageChange);
    Hooks.on('updateJournalEntryPage', this._onPageUpdate);
    Hooks.on('deleteJournalEntryPage', this._onPageChange);
    if (game.user?.isGM) Hooks.on('preUpdateJournalEntryPage', this._onPreUpdatePage);
    // v12's sheet fires closeJournalSheet; v13+ (ApplicationV2) fires
    // closeJournalEntrySheet.
    Hooks.on('closeJournalSheet', this._onCloseJournalSheet);
    Hooks.on('closeJournalEntrySheet', this._onCloseJournalSheet);
    globalThis.window?.addEventListener?.('beforeunload', this._onBeforeUnload);
    if (game.user?.isGM) this._stopGMSecrets = watchGMSecrets((id) => this._secretFor(id));

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

    // No journal: a mapping is only ever written by this module after it
    // made the journal, so the journal was deleted here. Recreating it would
    // undo the GM's delete on every connect; the dashboard Resync is the
    // way to bring it back on purpose.
    if (!journal) {
      console.debug(`Chronicle: mapping for entity ${mapping.chronicle_id} has no journal here; not recreating`);
    }
  }

  /**
   * Catch up on connect: apply what changed in Chronicle while Foundry was
   * closed or disconnected. Chronicle does not touch a sync mapping when a
   * page changes, so the mapping pull misses page edits, deletions and new
   * pages; this walks the entity list instead, with the dashboard Resync's
   * logic (update changed pages, create missing ones), then sets aside
   * journals whose page is gone. Runs on every connect and reconnect.
   */
  /** Change-feed area this module reads at connect (see SyncManager). */
  get feedArea() { return 'journals'; }

  /** Journals use the feed only while journal sync is on. */
  feedActive() { return !!getSetting('syncJournals'); }

  /**
   * Connect-time catch-up. With the change feed, only the pages Chronicle
   * says changed are refetched; without it (first connect, an older server,
   * a feed gap) every page is walked.
   *
   * @param {{feed?: {mode: 'delta', changes: object[]}|{mode: 'full'}}} [opts]
   */
  async onInitialSync({ feed } = {}) {
    if (!game.user.isGM || !this._api || !getSetting('syncJournals')) return;
    // lastSyncTime is still the previous sync's here (SyncManager writes the
    // new one after every module's onInitialSync). None yet → no creates:
    // a first connect leaves importing to the import wizard.
    const createdAfter = getSetting('lastSyncTime') || null;
    let relayout = false;
    try {
      relayout = await this._loadTree();
    } catch (err) {
      console.warn('Chronicle: could not read categories and folders; journals stay where they are', err);
    }
    if (feed?.mode === 'delta') {
      await this._catchUpFromFeed(feed.changes, feed.createdAfter ?? createdAfter);
      if (relayout) {
        const walked = await walkEntityPages(
          (page, perPage) => this._api.get(`/entities?per_page=${perPage}&page=${page}`),
          unwrapEntityList,
        );
        if (!walked.truncated) await this._placeAll(walked.entities);
      }
      await this._hideStoredSecrets();
      return;
    }
    const summary = await this.resyncAll({ verbose: false, onlyChanged: true, createdAfter });
    // A failed or partial walk proves nothing about deletions.
    if (summary.errors > 0 && !this._lastWalk) throw new Error('journal reconcile: entity list failed');
    if (relayout && this._lastWalk && !this._lastWalk.truncated) await this._placeAll(this._lastWalkEntities);
    await this._setAsideMissing();
    await this._hideStoredSecrets();
  }

  /**
   * Apply the pages the change feed lists. Same rules as the full walk: a
   * journal already at the page's version is left alone, a new journal is
   * made only for a page created since the cursor (an older page with no
   * journal is one the GM deleted here), and a removed page sets its journal
   * aside only on a definite 404. "Created since" is the page's own
   * `created_at` against the cursor's `createdAfter`, not the feed's
   * `created` entry: the feed replays entries a previous connect already
   * applied. Throws when any page failed, so the cursor is not advanced past
   * it.
   *
   * @param {object[]} changes
   * @param {string|null} createdAfter - Saved with the cursor.
   * @private
   */
  async _catchUpFromFeed(changes, createdAfter) {
    const outcomes = collapseChanges(changes, 'entity');
    let errors = 0;
    for (const [entityId, op] of outcomes) {
      const journal = this._findJournal(entityId);
      try {
        if (op === 'deleted') {
          if (journal) await this._setAsideIfGone(journal, entityId);
          continue;
        }
        let entity;
        try {
          entity = await this._api.get(`/entities/${entityId}`);
        } catch (err) {
          // Removed after this change was recorded: its own delete entry may
          // be later in the feed, but check rather than rely on it.
          if ((err?.status ?? err?.statusCode) === 404) {
            this._expectedGone(entityId);
            if (journal) await this._setAsideIfGone(journal, entityId, { knownGone: true });
            continue;
          }
          throw err;
        }
        if (!entity?.id || this._isExcluded(entity) || this._isHandledByActorSync(entity)) continue;
        if (journal) {
          if (entity.updated_at && journal.getFlag(FLAG_SCOPE, 'chronicleUpdatedAt') === entity.updated_at) continue;
          await this._onEntityUpdated(entity);
        } else if (op === 'created' && createdAfter && entity.created_at
            && Date.parse(entity.created_at) > Date.parse(createdAfter)) {
          await this._createJournalFromEntity(entity);
        }
      } catch (err) {
        errors++;
        console.warn(`Chronicle: catch-up failed for entity ${entityId}:`, err);
      }
    }
    if (errors > 0) throw new Error(`journal catch-up: ${errors} page(s) failed`);
  }

  /**
   * Set aside journals linked to a page Chronicle no longer has. Only after
   * a complete walk, and only on a definite 404 for that page, so a flaky
   * request or a page the key cannot see never unlinks a healthy journal.
   * @private
   */
  async _setAsideMissing() {
    const walk = this._lastWalk;
    if (!walk || walk.truncated) return;
    for (const journal of [...game.journal.contents]) {
      const eid = journal.getFlag(FLAG_SCOPE, 'entityId');
      if (!eid || walk.ids.has(eid)) continue;
      await this._setAsideIfGone(journal, eid);
    }
  }

  /**
   * Set a linked journal aside when its Chronicle page is definitely gone
   * (a 404, or `knownGone` from a 404 the caller just saw). Journals owned by
   * another area (calendar notes, notes, maps, actor-linked) are left alone.
   * @private
   */
  async _setAsideIfGone(journal, eid, { knownGone = false } = {}) {
    if (isCalendarNoteJournal(journal) || isOldNotesJournal(journal, FLAG_SCOPE) || isMapJournal(journal, FLAG_SCOPE)) return;
    if (this._isActorLinked(eid)) return;
    let gone = knownGone;
    if (!gone) {
      try {
        await this._api.get(`/entities/${eid}`);
      } catch (err) {
        gone = (err?.status ?? err?.statusCode) === 404;
        if (gone) this._expectedGone(eid);
      }
    }
    if (!gone) return;
    await this._queue.run(eid, async () => {
      this._journalPushDebouncer.cancel(journal.id);
      this._pendingJournalChanges.delete(journal.id);
      await setAside(journal, FLAG_SCOPE, syncOptions());
      ui.notifications?.info?.(game.i18n.format('CHRONICLE.Removed.Entity', { name: noticeText(journal.name) }));
      this._syncManager?.logActivity?.('unlink', `"${journal.name}" is gone from Chronicle; its journal was set aside`);
    });
  }

  /**
   * A 404 that answered "is this page still there?" is the answer, not a
   * failure, so it leaves the error log; the outcome goes in the activity log.
   * @private
   */
  _expectedGone(entityId) {
    this._api?.dropLastErrorLogEntry?.({ path: `/entities/${entityId}`, status: 404 });
  }

  /** True when a synced actor already carries this entity id. @private */
  _isActorLinked(entityId) {
    return game.actors?.contents?.some((a) => a.getFlag(FLAG_SCOPE, 'entityId') === entityId) ?? false;
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
   * Re-fetch every Chronicle entity and apply it to Foundry. Unlike
   * `_onPullAll` (which only creates journals for chronicle-only entities),
   * this also updates existing journals (content, name, ownership), so it
   * repairs journals that synced before a permission change.
   *
   * Paginated fetch of all entities; for each, update if a journal exists
   * (re-running `_buildOwnership`) or create it otherwise. Sequential, not
   * parallelized, so a large campaign doesn't hammer the API.
   *
   * `onlyChanged` skips journals already at the entity's `updated_at` (the
   * connect-time catch-up); the dashboard button refreshes everything.
   *
   * @param {{verbose?: boolean, onlyChanged?: boolean}} [opts]
   * @returns {Promise<{updated: number, created: number, skipped: number, errors: number}>}
   */
  async resyncAll({ verbose = true, onlyChanged = false, createdAfter } = {}) {
    if (!game.user.isGM || !this._api) {
      return { updated: 0, created: 0, skipped: 0, errors: 0 };
    }
    if (!getSetting('syncJournals')) {
      return { updated: 0, created: 0, skipped: 0, errors: 0 };
    }

    if (verbose) ui.notifications.info('Chronicle: fetching entities for resync…');

    // A resync started from the dashboard runs before any connect has read
    // the folder layout; without it every new journal would land loose.
    let relayout = false;
    if (!this._treeLoaded) {
      try {
        relayout = await this._loadTree();
      } catch (err) {
        console.warn('Chronicle: could not read categories and folders; journals stay where they are', err);
      }
    }

    // Shares the walk with the dashboard's _buildEntityGroups
    // (_entity-page-walk.mjs). A walk cut short must report `truncated`, not
    // a clean finish.
    let allEntities = [];
    let truncated = false;
    this._lastWalk = null;
    try {
      const walked = await walkEntityPages(
        (page, perPage) => this._api.get(`/entities?per_page=${perPage}&page=${page}`),
        unwrapEntityList,
      );
      allEntities = walked.entities;
      truncated = walked.truncated;
      this._lastWalkEntities = walked.entities;
      for (const e of walked.entities) this._rememberEntity(e);
      this._lastWalk = { ids: new Set(walked.entities.map((e) => e?.id).filter(Boolean)), truncated };
    } catch (err) {
      const status = err?.status || null;
      console.warn(`Chronicle JournalSync.resyncAll: GET /entities failed (${status || 'network'})`, err);
      ui.notifications.error(
        `Chronicle: could not fetch entities from Chronicle${status ? ` (HTTP ${status})` : ''}. Check the connection in Chronicle settings.`
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
        if (journal && onlyChanged && entity.updated_at
            && journal.getFlag(FLAG_SCOPE, 'chronicleUpdatedAt') === entity.updated_at) {
          skipped++;
          continue;
        }
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
          // Connect-time pass: only pages made in Chronicle since the last
          // sync get a new journal. An older page with no journal is one the
          // GM deleted here (and chose to keep in Chronicle) or never
          // imported, and must not keep coming back on every reconnect.
          if (createdAfter !== undefined
              && !(createdAfter && entity.created_at && Date.parse(entity.created_at) > Date.parse(createdAfter))) {
            skipped++;
            continue;
          }
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
        this._syncManager?.recordWorldOutcome?.(false);
      }
    }

    if (relayout && !truncated) await this._placeAll(allEntities);

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
    Hooks.off('createJournalEntryPage', this._onPageChange);
    Hooks.off('updateJournalEntryPage', this._onPageUpdate);
    Hooks.off('deleteJournalEntryPage', this._onPageChange);
    Hooks.off('preUpdateJournalEntryPage', this._onPreUpdatePage);
    Hooks.off('closeJournalSheet', this._onCloseJournalSheet);
    Hooks.off('closeJournalEntrySheet', this._onCloseJournalSheet);
    globalThis.window?.removeEventListener?.('beforeunload', this._onBeforeUnload);
    this._stopGMPictures?.();
    this._stopGMPictures = null;
    this._stopGMSecrets?.();
    this._stopGMSecrets = null;
    // Module stop is itself a form of "unload" — never drop the last edit.
    this._journalPushDebouncer.flushAll();
  }

  // --- Chronicle → Foundry ---

  /**
   * Create a new JournalEntry from a Chronicle entity.
   * Fetches full entity data from the API since WebSocket payloads may
   * not include content fields (entry_html, fields_data, tags). Queued per
   * entity so it cannot interleave with an update for the same entity.
   * @param {object} entity - Chronicle entity data (possibly partial).
   * @private
   */
  _onEntityCreated(entity) {
    if (!entity?.id) return Promise.resolve();
    return this._queue.run(entity.id, () => this._applyEntityCreated(entity));
  }

  /** @private */
  async _applyEntityCreated(entity) {
    // Skip if entity or its type is excluded from sync.
    if (this._isExcluded(entity)) return;
    if (this._findJournal(entity.id)) return;
    if (this._isOwnCreateInFlight(entity)) return;

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

    // Re-checked inside _createJournalLocked: nothing else can have created
    // it, because every creator for this entity runs through the same queue.
    await this._createJournalLocked(fullEntity);
  }

  /** @private */
  _findJournal(entityId) {
    return game.journal.find((j) => j.getFlag(FLAG_SCOPE, 'entityId') === entityId) || null;
  }

  /**
   * True when this entity is the page our own in-flight journal POST is
   * creating (same name), so the broadcast must not create a second journal.
   * @private
   */
  _isOwnCreateInFlight(entity) {
    for (const name of this._inFlightCreates.values()) {
      if (name === entity.name) return true;
    }
    return false;
  }

  /**
   * Update an existing JournalEntry from a Chronicle entity change.
   * @param {object} entity
   * @private
   */
  _onEntityUpdated(entity) {
    if (!entity?.id) return Promise.resolve();
    return this._queue.run(entity.id, () => this._applyEntityUpdated(entity));
  }

  /** @private */
  async _applyEntityUpdated(entity) {
    // Skip if entity or its type is excluded from sync.
    if (this._isExcluded(entity)) return;

    const journal = this._findJournal(entity.id);
    if (!journal) {
      // Entity was updated but we don't have a journal for it yet — create
      // one, unless it's a character handled by ActorSync or our own POST.
      if (this._isHandledByActorSync(entity)) return;
      if (this._isOwnCreateInFlight(entity)) return;
      await this._createJournalLocked(entity);
      return;
    }

    // A copy older than the version this journal already has is stale (an
    // echo built before a later save), and applying it would roll the
    // journal and its recorded version back. Equal versions still apply:
    // versions have one-second precision, so equal is not proof of same.
    if (this._olderThanRecorded(journal, entity.updated_at)) {
      console.debug(`Chronicle: ignored a stale copy of "${journal.name}"`);
      return;
    }

    // A local edit still waiting to be sent wins over this incoming change:
    // applying it would silently erase what the GM just typed. The edit is
    // pushed shortly (Chronicle updates are partial), so move the expected
    // version forward to this change's, otherwise that push would be
    // rejected as a conflict, and tell the GM.
    if (this._journalPushDebouncer.has(journal.id)) {
      if (entity.updated_at && !this._olderThanRecorded(journal, entity.updated_at)) {
        await journal.update(
          { [`flags.${FLAG_SCOPE}.chronicleUpdatedAt`]: entity.updated_at },
          syncOptions(),
        );
      }
      console.warn(`Chronicle: kept unsent Foundry edit of "${journal.name}" over an incoming Chronicle change`);
      this._syncManager?.logActivity?.('update', `Kept your Foundry edit of "${journal.name}" over a Chronicle change`);
      return;
    }

    // One write for name, ownership and link flags; pages follow.
    // With "Follow Chronicle's visibility" off, ownership stays as the GM set it.
    const ownership = this._followsVisibility() ? await this._buildOwnership(entity) : undefined;
    await journal.update({
      name: entity.name,
      ...(ownership && { ownership }),
      [`flags.${FLAG_SCOPE}.entityType`]: entity.type_name || '',
      [`flags.${FLAG_SCOPE}.${TYPE_SLUG_FLAG}`]: entity.type_slug || '',
      // Field values are not kept on the journal: every client receives its
      // flags, and the Owner key's copy includes GM-only fields. Removes the
      // copy older versions stored.
      ...flagRemoval(FLAG_SCOPE, 'fields'),
      [`flags.${FLAG_SCOPE}.tags`]: entity.tags || [],
      ...factsUpdate(this._factsFor(entity)),
      [`flags.${FLAG_SCOPE}.lastSync`]: new Date().toISOString(),
      [`flags.${FLAG_SCOPE}.chronicleUpdatedAt`]: entity.updated_at || '',
    }, syncOptions());

    // A page moved in Chronicle's sidebar moves here too.
    try {
      await this._placeJournal(journal, entity);
    } catch (err) {
      console.warn(`Chronicle: could not move "${journal.name}" to its folder`, err);
    }

    // Split entity content into pages and sync them.
    await this._syncPagesToJournal(journal, await this._pullHtml(entity.id, entity.entry_html));

    // Sync player notes page.
    await this._syncPlayerNotesPage(journal, await this._pullHtml(entity.id, entity.player_notes_html));

    console.debug(`Chronicle: Updated journal "${journal.name}" from entity`);
  }

  /**
   * Set aside the JournalEntry of an entity deleted in Chronicle: unlinked,
   * in the "Chronicle: removed" folder, never deleted (_set-aside.mjs).
   * @param {object} data - { id: entityId }
   * @private
   */
  _onEntityDeleted(data) {
    if (!data?.id) return Promise.resolve();
    return this._queue.run(data.id, () => this._applyEntityDeleted(data));
  }

  /** @private */
  async _applyEntityDeleted(data) {
    const journal = this._findJournal(data.id);
    if (!journal) return;

    // The journal is going away from sync; an edit still pending for it
    // would only push at a page that no longer exists.
    this._journalPushDebouncer.cancel(journal.id);
    this._pendingJournalChanges.delete(journal.id);
    await setAside(journal, FLAG_SCOPE, syncOptions());
    ui.notifications?.info?.(game.i18n.format('CHRONICLE.Removed.Entity', { name: noticeText(journal.name) }));
    console.debug(`Chronicle: Set aside journal for deleted entity ${data.id}`);
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

    const updates = {};
    if (folder.name !== entityType.name) updates.name = entityType.name;
    if (entityType.color && folder.color !== entityType.color) updates.color = entityType.color;
    if (Object.keys(updates).length > 0) {
      await folder.update(updates, syncOptions());
      console.debug(`Chronicle: Updated folder "${entityType.name}" from entity type`);
    }
  }

  /**
   * The Foundry folder a page's journal belongs in: its category inside any
   * parent category, then its Chronicle folders. Made as needed.
   * @param {object} entity
   * @returns {Promise<Folder|null>}
   * @private
   */
  async _getOrCreateEntityFolder(entity) {
    this._rememberEntity(entity);
    // Without Chronicle's categories the page lands by its own category
    // only; forget the recorded layout so the next connect that reads them
    // nests it properly.
    if (!this._treeLoaded && !this._layoutForgotten) {
      this._layoutForgotten = true;
      await setSetting('folderLayout', '');
    }
    const depth = globalThis.CONST?.FOLDER_MAX_DEPTH ?? 4;
    let parent = null;
    for (const level of folderChain(entity, this._tree, depth)) {
      parent = await this._folderForLevel(level, parent);
      if (!parent) break;
    }
    return parent;
  }

  /** Whether sync made this folder, so it may move or rename it. @private */
  _isSyncFolder(folder) {
    return !!(folder?.getFlag(FLAG_SCOPE, 'entityTypeId') || folder?.getFlag(FLAG_SCOPE, 'folderNodeId'));
  }

  /**
   * One level of the chain: found by its flag (a category folder from older
   * versions also by name), else made. A folder sync made follows Chronicle's
   * nesting and names unless the GM filed it inside a folder of their own.
   * Categories that share a name and a place share one folder: its own
   * category is `entityTypeId`, the others are listed in `entityTypeIds`.
   * @private
   */
  async _folderForLevel(level, parent) {
    const flag = level.kind === 'type' ? 'entityTypeId' : 'folderNodeId';
    const parentId = parent?.id ?? null;
    let folder = game.folders.find((f) => f.type === 'JournalEntry' && f.getFlag(FLAG_SCOPE, flag) === level.id);
    if (!folder && level.kind === 'type') {
      folder = this._typeTwin(level, parentId);
      if (folder) {
        await this._addTwinType(folder, level.id);
        return folder;
      }
      folder = game.folders.find((f) => f.type === 'JournalEntry' && f.name === level.name
        && !this._isSyncFolder(f) && (f.folder?.id ?? null) === parentId);
      if (folder) await folder.setFlag(FLAG_SCOPE, 'entityTypeId', level.id);
    }
    if (folder) {
      const updates = {};
      const current = folder.folder ?? null;
      if ((current?.id ?? null) !== (parent?.id ?? null) && (!current || this._isSyncFolder(current))) {
        updates.folder = parent?.id ?? null;
      }
      if (level.kind === 'node' && folder.name !== level.name) updates.name = level.name;
      if (level.color && !folder.color) updates.color = level.color;
      if (Object.keys(updates).length) await folder.update(updates, syncOptions());
      return folder;
    }
    // Same-named categories in one place wait on one create.
    const makingKey = level.kind === 'type' ? `type:${parentId}:${level.name}` : level.key;
    const making = this._folderMaking.get(makingKey);
    if (making) {
      const made = await making;
      if (level.kind === 'type' && made && made.getFlag(FLAG_SCOPE, 'entityTypeId') !== level.id) await this._addTwinType(made, level.id);
      return made;
    }
    const data = {
      name: level.name,
      type: 'JournalEntry',
      folder: parent?.id ?? null,
      flags: { [FLAG_SCOPE]: { [flag]: level.id } },
    };
    if (level.color) data.color = level.color;
    const run = Folder.create(data, syncOptions()).finally(() => this._folderMaking.delete(makingKey));
    this._folderMaking.set(makingKey, run);
    return run;
  }

  /**
   * A category folder sync made for another category with this one's name,
   * in the same place: the folder this category shares.
   * @private
   */
  _typeTwin(level, parentId) {
    return game.folders.find((f) => f.type === 'JournalEntry' && f.name === level.name
      && f.getFlag(FLAG_SCOPE, 'entityTypeId') != null
      && (f.folder?.id ?? null) === parentId) ?? null;
  }

  /** Record that a category shares this folder. @private */
  async _addTwinType(folder, typeId) {
    const ids = folder.getFlag(FLAG_SCOPE, 'entityTypeIds') ?? [];
    if (folder.getFlag(FLAG_SCOPE, 'entityTypeId') === typeId || ids.includes(typeId)) return;
    await folder.update({ [`flags.${FLAG_SCOPE}.entityTypeIds`]: [...ids, typeId] }, syncOptions());
  }

  /** Journal folders sync made (a category's or a Chronicle folder's). @private */
  _syncFolders() {
    return game.folders.filter((f) => f.type === 'JournalEntry' && this._isSyncFolder(f));
  }

  /**
   * Fold category folders that share a name and a place into one, so two
   * Chronicle categories with one name show as one folder. What a twin
   * held moves into the folder kept; no journal is deleted.
   * @private
   */
  async _mergeTwinFolders() {
    const groups = new Map();
    for (const f of this._syncFolders()) {
      if (f.getFlag(FLAG_SCOPE, 'entityTypeId') == null) continue;
      const key = `${f.folder?.id ?? ''}|${f.name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    for (const [keep, ...twins] of groups.values()) {
      for (const twin of twins) {
        for (const j of game.journal.filter((x) => x.folder?.id === twin.id)) {
          await j.update({ folder: keep.id }, syncOptions());
        }
        for (const child of game.folders.filter((x) => x.folder?.id === twin.id)) {
          await child.update({ folder: keep.id }, syncOptions());
        }
        await this._addTwinType(keep, twin.getFlag(FLAG_SCOPE, 'entityTypeId'));
        for (const id of twin.getFlag(FLAG_SCOPE, 'entityTypeIds') ?? []) await this._addTwinType(keep, id);
        await twin.delete(syncOptions());
      }
    }
  }

  /**
   * Remove folders sync made that hold nothing, innermost first: a category
   * or Chronicle folder with no journal here. A folder the GM made is never
   * touched, nor one holding anything.
   * @private
   */
  async _removeEmptySyncFolders() {
    for (;;) {
      const empty = this._syncFolders().filter((f) => !game.journal.some((j) => j.folder?.id === f.id)
        && !game.folders.some((c) => c.folder?.id === f.id));
      if (!empty.length) return;
      for (const f of empty) await f.delete(syncOptions());
    }
  }

  /** Note where a page sits, for its own place and its sub-pages'. @private */
  _rememberEntity(entity) {
    if (!entity?.id) return;
    this._tree.parents.set(entity.id, { parent_id: entity.parent_id ?? null, parent_node_id: entity.parent_node_id ?? null });
  }

  /**
   * Move a journal to its page's folder. A journal the GM filed in a folder
   * of their own stays there.
   * @private
   */
  async _placeJournal(journal, entity) {
    const current = journal.folder ?? null;
    if (current && !this._isSyncFolder(current)) return;
    const target = await this._getOrCreateEntityFolder(entity);
    if (target && current?.id !== target.id) await journal.update({ folder: target.id }, syncOptions());
  }

  /**
   * Read Chronicle's categories and folders. An older Chronicle without the
   * folder list files pages by category only.
   * @returns {Promise<boolean>} whether the layout changed since journals
   *   were last placed
   * @private
   */
  async _loadTree() {
    const types = unwrapEntityList(await this._api.get('/entity-types'), 'entity_types');
    let folders = [];
    try {
      folders = unwrapEntityList(await this._api.get('/folders'), 'folders');
    } catch (err) {
      if ((err?.status ?? err?.statusCode) !== 404) throw err;
      this._api.dropLastErrorLogEntry?.({ path: '/folders', status: 404 });
    }
    this._tree.types = new Map(types.filter((t) => t?.id != null).map((t) => [t.id, t]));
    this._tree.folders = new Map(folders.filter((f) => f?.id).map((f) => [f.id, f]));
    this._treeLoaded = true;
    const print = layoutFingerprint(this._tree);
    if (getSetting('folderLayout') === print) return false;
    this._pendingLayout = print;
    return true;
  }

  /**
   * Put every linked journal in its page's folder, then record the layout.
   * @param {object[]} entities - every page, as listed
   * @private
   */
  async _placeAll(entities) {
    for (const e of entities) this._rememberEntity(e);
    let failed = 0;
    try {
      await this._mergeTwinFolders();
    } catch (err) {
      failed++;
      console.warn('Chronicle: could not merge same-named category folders', err);
    }
    for (const entity of entities) {
      const journal = this._findJournal(entity?.id);
      if (!journal || this._isHandledByActorSync(entity)) continue;
      try {
        await this._placeJournal(journal, entity);
      } catch (err) {
        failed++;
        console.warn(`Chronicle: could not move "${journal.name}" to its folder`, err);
      }
    }
    if (failed) return;
    // Every journal is where its page is, so a folder sync made that holds
    // nothing now has no page here to hold.
    try {
      await this._removeEmptySyncFolders();
    } catch (err) {
      console.warn('Chronicle: could not remove empty folders', err);
    }
    if (this._pendingLayout) await setSetting('folderLayout', this._pendingLayout);
  }

  _createJournalFromEntity(entity, forceId) {
    if (!entity?.id) return Promise.resolve(null);
    return this._queue.run(entity.id, () => this._createJournalLocked(entity, forceId));
  }

  /**
   * The create itself. Callers already hold this entity's queue slot, and it
   * re-checks for an existing journal, so two creators for one entity (a
   * created and an updated event, the dashboard, a resync) make one journal.
   * @private
   */
  async _createJournalLocked(entity, forceId) {
    const existing = this._findJournal(entity.id);
    if (existing) return existing;
    const isMonksActive = game.modules.get('monks-enhanced-journal')?.active;

    // Build journal pages.
    const pages = [];

    // Image page (if entity has an image). Route through the same
    // host-allowlist map-sync uses (_mapImageSrc); a rejected host
    // drops to empty src + warn.
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
    // Sanitize at ingress before splitting (defense-in-depth).
    const sections = this._splitByHeadings(await this._pullHtml(entity.id, entity.entry_html));

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
        text: { content: await this._pullHtml(entity.id, entity.player_notes_html) },
        sort: sortIndex++,
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
        flags: { [FLAG_SCOPE]: { isPlayerNotes: true } },
      });
    }

    // Determine ownership from Chronicle permissions.
    // Off: a new journal takes Foundry's own default ownership.
    const ownership = this._followsVisibility() ? await this._buildOwnership(entity) : undefined;

    // Find or create a folder for this entity type.
    const folder = await this._getOrCreateEntityFolder(entity);

    const sheetFlags = newJournalSheetFlags();
    const facts = this._factsFor(entity);
    const journalData = {
      name: entity.name,
      pages,
      ...(ownership && { ownership }),
      folder: folder?.id || null,
      flags: {
        ...(sheetFlags.core && { core: sheetFlags.core }),
        [FLAG_SCOPE]: {
          ...sheetFlags[FLAG_SCOPE],
          ...(facts && { facts }),
          entityId: entity.id,
          entityType: entity.type_name || '',
          [TYPE_SLUG_FLAG]: entity.type_slug || '',
          tags: entity.tags || [],
          lastSync: new Date().toISOString(),
          chronicleUpdatedAt: entity.updated_at || '',
        },
      },
    };

    if (forceId) {
      journalData._id = forceId;
    }

    const journal = await JournalEntry.create(journalData, syncOptions());

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
    if (options?.chronicleSync) return;
    if (userId !== game.user.id) return;

    // Skip if this journal was created by Chronicle sync.
    if (journal.getFlag(FLAG_SCOPE, 'entityId')) return;

    // Skip journals owned by another sync domain: a journal already mirrored
    // to a calendar event and maps also persist as JournalEntries, and
    // CalendarSync / MapSync own them. Pushed as pages they would fail (maps)
    // or be filed under an arbitrary type. The old Chronicle Notes folder is
    // set aside and must never become pages either. Mirrors
    // _isHandledByActorSync.
    if (isCalendarNoteJournal(journal)) {
      console.debug(`Chronicle: Skipping journal "${journal.name}" — calendar event link (owned by CalendarSync).`);
      return;
    }
    if (isOldNotesJournal(journal, FLAG_SCOPE)) {
      console.debug(`Chronicle: Skipping journal "${journal.name}" — old Chronicle Notes folder (set aside).`);
      return;
    }
    if (isMapJournal(journal, FLAG_SCOPE)) {
      console.debug(`Chronicle: Skipping journal "${journal.name}" — Chronicle map (owned by MapSync).`);
      return;
    }

    // Marked before the first await so the entity.created broadcast, which
    // can beat our POST response, finds it and does not make a second journal.
    this._inFlightCreates.set(journal.id, journal.name);
    try {
      const entityTypeId = await this._resolveCreateTypeId();
      if (!entityTypeId) {
        console.warn(`Chronicle: "${journal.name}" not sent; the campaign has no page types`);
        this._syncManager?.logActivity?.('error', `"${journal.name}" not sent: the campaign has no page types`);
        return;
      }

      const isPrivate =
        (journal.ownership?.default ?? 0) < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;

      // Chronicle's create request has no text field, so the text follows in
      // an update (see _journal-create.mjs).
      const entity = await this._api.post('/entities', buildEntityCreateBody({
        name: journal.name,
        entityTypeId,
        isPrivate,
      }));

      if (entity) {
        // Linked before the text goes up, so a failed text push leaves a
        // linked journal whose next edit retries it, not an orphan page.
        await journal.update({
          [`flags.${FLAG_SCOPE}.entityId`]: entity.id,
          [`flags.${FLAG_SCOPE}.lastSync`]: new Date().toISOString(),
          [`flags.${FLAG_SCOPE}.chronicleUpdatedAt`]: entity.updated_at || '',
        }, syncOptions());

        const entryHtml = await this._entryForPush(journal, entity.id);
        if (entryHtml) {
          const updated = await this._api.put(`/entities/${entity.id}`, { entry: entryHtml });
          await this._recordPush(journal, updated);
          await this._hidePushedSecrets(journal, updated);
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
        await this._pushPermissions(entity.id, journal.ownership, isPrivate, journal.name, journal);

        console.debug(`Chronicle: Pushed new journal "${journal.name}" to Chronicle`);
        this._syncManager?.recordUserOutcome?.(userId);
      }
    } catch (err) {
      // Surface push failures to the GM instead of failing silently; the
      // REST error itself is already in the dashboard's error log.
      console.error('Chronicle: Failed to push journal to Chronicle', err);
      this._syncManager?.recordUserOutcome?.(userId, err);
      ui.notifications?.warn?.(`Chronicle: Failed to push journal "${noticeText(journal.name)}". Check the sync dashboard for details.`);
    } finally {
      this._inFlightCreates.delete(journal.id);
    }
  }

  /**
   * Page type for a journal made in Foundry: the dashboard's setting, else
   * the campaign's first page type from GET /entity-types.
   * @returns {Promise<number|null>}
   * @private
   */
  async _resolveCreateTypeId() {
    const configured = Number(getSetting('journalCreateTypeId')) || 0;
    const types = await this._api.get('/entity-types');
    return pickJournalCreateType(types, configured);
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
    if (options?.chronicleSync) return;
    if (userId !== game.user.id) return;

    const entityId = journal.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    // Defensive: a calendar note / old Chronicle Note may carry a stale entityId
    // from before the create-time guard existed. Don't keep pushing edits to
    // that bogus entity — the cleanup pass unlinks it.
    if (isCalendarNoteJournal(journal) || isOldNotesJournal(journal, FLAG_SCOPE)
        || isMapJournal(journal, FLAG_SCOPE)) return;

    // Debounced: collapse a typing burst into one push, ~2s after
    // the last edit. `journal` reflects the live document state by the
    // time the timer fires, so re-reading it at push time (not now)
    // captures whatever the GM last typed.
    this._pendingJournalChanges.set(
      journal.id, mergeJournalChange(this._pendingJournalChanges.get(journal.id), change)
    );
    this._journalPushDebouncer.schedule(journal.id, journal, entityId);
  }

  /**
   * A page was created, edited or deleted in Foundry: push its journal like
   * any other journal edit (same guards, same debounce). Page writes made by
   * sync itself carry syncOptions() and are skipped.
   * @param {JournalEntryPage} page
   * @param {object} options
   * @param {string} userId
   * @private
   */
  /**
   * Foundry's Reveal only flips a class on the block, which on a synced page
   * holds a placeholder. Before that save, put the GM-only content in a
   * revealed block (players then see it) and the label back in one hidden
   * again. Revealing stays in Foundry: Chronicle has no per-secret reveal,
   * and the text stays GM-only there.
   * @private
   */
  _fillReveals(page, change) {
    const content = change?.text?.content;
    if (typeof content !== 'string' || !page?.parent?.getFlag(FLAG_SCOPE, 'entityId')) return;
    const next = applyReveals(content, this._secretPieces, secretPlaceholderText(), _sanitizeIncomingHTML);
    if (next !== null) change.text.content = next;
  }

  _handlePageChange(page, options, userId) {
    const journal = page?.parent;
    if (!journal) return;
    return this._handleUpdateJournal(journal, {}, options, userId);
  }

  /**
   * Flush a debounced journal push on journal-sheet close, so the last
   * edit is never stranded behind a timer the GM won't wait out.
   * @param {Application} sheet
   * @private
   */
  _handleCloseJournalSheet(sheet) {
    const journalId = sheet?.document?.id;
    if (journalId) this._journalPushDebouncer.flush(journalId);
  }

  /**
   * Push a journal's current state to Chronicle. Called by the debouncer
   * after its window elapses, or immediately on flush (journal close /
   * world unload).
   * @param {JournalEntry} journal
   * @param {string} entityId
   * @private
   */
  async _pushJournalUpdate(journal, entityId) {
    const changed = this._pendingJournalChanges.get(journal.id);
    this._pendingJournalChanges.delete(journal.id);
    try {
      // Concatenate all text pages into a single entry for Chronicle.
      const entryHtml = await this._entryForPush(journal, entityId);
      const playerNotesHtml = await this._playerNotesForPush(journal, entityId);
      const isPrivate =
        (journal.ownership?.default ?? 0) < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;

      // Build the update body with optimistic concurrency. Text whose GM-only
      // content can't be put back (undefined) is left out, never sent
      // without it.
      const body = changedJournalFields({ name: journal.name, isPrivate }, changed);
      if (entryHtml !== undefined) body.entry = entryHtml;

      // Include player notes if present.
      if (playerNotesHtml !== null && playerNotesHtml !== undefined) {
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

      // An older failed push of this page must not be replayed over this one.
      this._api.clearRetry?.('PUT', `/entities/${entityId}`);

      // Push ownership changes as Chronicle permission updates.
      if (changed?.ownership) {
        await this._pushPermissions(entityId, journal.ownership, isPrivate, journal.name, journal);
      }

      await this._recordPush(journal, result);
      await this._hidePushedSecrets(journal, result);

      console.debug(`Chronicle: Pushed journal update "${journal.name}" to Chronicle`);
      // The debounce has no hook userId; the hooks only schedule this for the local user's own edits.
      this._syncManager?.recordUserOutcome?.(game.user.id);
    } catch (err) {
      // Surface the failure and queue the update for retry on reconnect.
      console.error('Chronicle: Failed to push journal update', err);
      this._syncManager?.recordUserOutcome?.(game.user.id, err);
      const retry = changedJournalFields({
        name: journal.name,
        isPrivate: (journal.ownership?.default ?? 0) < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
      }, changed);
      const entry = await this._entryForPush(journal, entityId, { fetch: false }).catch(() => undefined);
      if (entry !== undefined) retry.entry = entry;
      // Keep the conflict check, so a replay never overwrites a Chronicle
      // edit made while this push waited; a 409 then goes through the same
      // conflict setting a live push uses.
      const retryVersion = journal.getFlag(FLAG_SCOPE, 'chronicleUpdatedAt');
      if (retryVersion) retry.expected_updated_at = retryVersion;
      const journalId = journal.id;
      this._api.queueForRetry?.('PUT', `/entities/${entityId}`, retry, undefined, {
        onConflict: async (body) => {
          const current = game.journal.get(journalId);
          if (current?.getFlag(FLAG_SCOPE, 'entityId') !== entityId) return;
          await this._handleConflict(current, entityId, body);
        },
      });
      ui.notifications?.warn?.(`Chronicle: Failed to push update for "${noticeText(journal.name)}" — queued for retry. See the sync dashboard.`);
    }
  }

  /**
   * True when `ts` is older than the Chronicle version this journal has
   * recorded. A journal's recorded version only ever moves forward.
   * @private
   */
  _olderThanRecorded(journal, ts) {
    const seen = Date.parse(journal?.getFlag?.(FLAG_SCOPE, 'chronicleUpdatedAt') || '');
    const t = Date.parse(ts || '');
    return Number.isFinite(seen) && Number.isFinite(t) && t < seen;
  }

  /**
   * Record a successful push on the journal: when it synced and the version
   * the next push must expect. One marked write, so no hook echo.
   * @param {JournalEntry} journal
   * @param {{updated_at?: string}|null} result - The PUT response.
   * @private
   */
  async _recordPush(journal, result) {
    const update = { [`flags.${FLAG_SCOPE}.lastSync`]: new Date().toISOString() };
    if (result?.updated_at && !this._olderThanRecorded(journal, result.updated_at)) {
      update[`flags.${FLAG_SCOPE}.chronicleUpdatedAt`] = result.updated_at;
    }
    await journal.update(update, syncOptions());
  }

  /**
   * Handle Foundry JournalEntry deletion: the GM is asked before its
   * Chronicle page is deleted too (_remote-deletes.mjs).
   * @param {JournalEntry} journal
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleDeleteJournal(journal, options, userId) {
    if (options?.chronicleSync) return;
    if (userId !== game.user.id) return;

    // Drop any push still pending for this journal before deleting.
    // Otherwise it fires after the delete, and the queueForRetry in its
    // catch block can resurrect the deleted entity's data on Chronicle.
    this._journalPushDebouncer.cancel(journal.id);
    this._pendingJournalChanges.delete(journal.id);

    const entityId = journal.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId) return;

    queueRemoteDelete({ label: journal.name, run: () => this._api.delete(`/entities/${entityId}`) });
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
   * Set aside any JournalEntries that duplicate a synced Foundry Actor
   * (same `entityId` flag on both). Called after the initial sync pass
   * completes — by that point ActorSync has materialized its actors, so
   * this overlaps cleanly. They are unlinked and moved to the removed
   * folder, never deleted: a GM may have written in them.
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

    let moved = 0;
    for (const journal of [...game.journal.contents]) {
      const eid = journal.getFlag(FLAG_SCOPE, 'entityId');
      if (!eid || !actorEntityIds.has(eid)) continue;
      try {
        await setAside(journal, FLAG_SCOPE, syncOptions());
        moved++;
      } catch (err) {
        console.warn(`Chronicle: Failed to set aside duplicate journal ${journal.id}`, err);
      }
    }

    if (moved > 0) {
      console.debug(`Chronicle: Set aside ${moved} duplicate character journal(s)`);
      ui.notifications.info(game.i18n.format('CHRONICLE.Removed.Duplicates', { count: moved }));
    }
  }

  // --- Permission Mapping Helpers ---

  /**
   * Whether the "Follow Chronicle's visibility" setting is on (the default):
   * ownership is then pulled from and pushed to Chronicle permissions.
   * @returns {boolean}
   * @private
   */
  _followsVisibility() {
    return getSetting('syncPermissions') !== false;
  }

  /**
   * Build a Foundry ownership object from Chronicle entity permissions.
   *
   * Mapping: visibility "default" → `defaultLevelForVisibility(is_private)`,
   * honoring the operator's `dmOnlyHidden` + `defaultOwnership` settings.
   * Visibility "custom" → explicit Chronicle grants take precedence; role
   * "1" (Player) sets the `default` level, and per-user grants map to
   * specific Foundry users via the user-mapping table when known.
   *
   * Security: the custom-visibility error path fails closed to NONE — a
   * transient permissions-API error must never widen a GM-restricted
   * entity to player-visible.
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
      // A private entity that correctly lands hidden-from-players is not
      // "didn't sync" — count it so the dashboard can say so explicitly.
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
      // Fail closed: never fall open to OBSERVER on a transient error — a
      // GM-restricted custom entity stays GM-only (NONE). Surface it so the
      // operator knows why, instead of console-only.
      console.warn(
        'Chronicle: Failed to fetch entity permissions — failing closed (GM-only)',
        err
      );
      this._syncManager?.logActivity?.(
        'warning',
        `Permissions fetch failed for "${entity.name || entity.id}" — locked to GM-only (fail-closed) until it succeeds.`
      );
      ui.notifications?.warn?.(
        `Chronicle: Could not read permissions for "${noticeText(entity.name || entity.id)}" — kept GM-only. See the sync dashboard.`
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
        // A `public` grant means everyone can see it → raise the default to
        // at least OBSERVER (edit → OWNER). Only ever widens toward the
        // explicitly-public intent, never below an existing higher grant.
        const publicLevel = grant.permission === 'edit' ? L.OWNER : L.OBSERVER;
        if (publicLevel > ownership.default) ownership.default = publicLevel;
      } else if (grant.subject_type === 'user') {
        // Per-user grant → map to a specific Foundry user when known.
        // Unmapped users are dropped and surfaced to the operator: the
        // entity under-shares rather than leaking to the wrong player.
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

    // `tag_grants` apply a grant to whoever holds a Chronicle tag. Foundry
    // has no tag-membership concept, so keep the fail-closed posture: don't
    // widen the default off a tag grant, just note it can't be honored.
    if (Array.isArray(permsData.tag_grants) && permsData.tag_grants.length > 0) {
      this._syncManager?.logActivity?.(
        'warning',
        `"${entity.name || entity.id}" has ${permsData.tag_grants.length} tag-based permission grant(s) Foundry can't map to users — those players may not see it.`
      );
    }

    if (droppedUsers.length > 0) {
      this._syncManager?.logActivity?.(
        'warning',
        `"${entity.name || entity.id}": ${droppedUsers.length} per-user grant(s) dropped — no Foundry mapping for those Chronicle members. Link them in Chronicle Sync, under Settings, Players.`
      );
    }

    return ownership;
  }

  /**
   * Build the Chronicle permission grants for a Foundry ownership object.
   *
   * Pure / side-effect-free (apart from the injected reverse-map fn) so it
   * can be unit-tested. Translates each Foundry per-user ownership entry
   * into a Chronicle `{subject_type:'user', subject_id, permission}` grant
   * via `reverseMap`. Level ≥ OWNER → `'edit'`, otherwise `'view'`.
   *
   * Fails closed on the share axis: a Foundry user that cannot be
   * reverse-mapped is not pushed (dropped and reported in `unmapped`), so
   * an unknown user never silently widens Chronicle access.
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
   * The default level drives `is_private` plus the broad Player-role grant.
   * Each per-user Foundry ownership entry reverse-maps to a Chronicle user
   * grant (`subject_type:'user'`); `visibility:'custom'` is sent only when
   * real user grants exist, else `'default'`. Foundry users that can't be
   * reverse-mapped are skipped and surfaced (notification + dashboard
   * warning), never silently dropped.
   *
   * Best-effort: a transport error is surfaced but never fails the journal
   * sync, mirroring the journal-content push posture.
   *
   * With `journal`, a push identical to the last one sent for it is skipped:
   * Chronicle stamps a new version on every permissions save, so a repeat
   * would leave the journal's recorded version stale and make the next
   * catch-up re-apply the module's own push.
   *
   * @param {string} entityId - Chronicle entity ID.
   * @param {object} ownership - Foundry ownership object.
   * @param {boolean} isPrivate - Derived privacy flag from default ownership.
   * @param {string} [label] - Human-readable entity name for notifications.
   * @param {JournalEntry} [journal] - Remembers what was last pushed.
   * @private
   */
  async _pushPermissions(entityId, ownership, isPrivate, label, journal) {
    if (!this._followsVisibility()) return;
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
        `Permission push${who}: ${unmapped.length} player grant(s) not sent — no Chronicle mapping for ${named}. Link them in Chronicle Sync, under Settings, Players.`
      );
      ui.notifications?.warn?.(
        `Chronicle: ${unmapped.length} player permission grant(s)${label ? ` on "${noticeText(label)}"` : ''} were not sent — unmapped Foundry user(s): ${noticeText(named)}. Link them in Chronicle Sync, under Settings, Players.`
      );
    }

    try {
      // Only push when there is something meaningful to say.
      if (hasUserGrants || permissions.length > 0) {
        const body = { visibility: hasUserGrants ? 'custom' : 'default', is_private: isPrivate, permissions };
        const key = JSON.stringify(body);
        if (journal && journal.getFlag(FLAG_SCOPE, 'pushedPermissions') === key) return;
        await this._api.put(`/entities/${entityId}/permissions`, body);
        if (journal) {
          // The save stamps a new page version but does not return it (and
          // its broadcast can carry an older one), so read it back.
          const update = { [`flags.${FLAG_SCOPE}.pushedPermissions`]: key };
          const fresh = await this._api.get(`/entities/${entityId}`).catch(() => null);
          if (fresh?.updated_at && !this._olderThanRecorded(journal, fresh.updated_at)) {
            update[`flags.${FLAG_SCOPE}.chronicleUpdatedAt`] = fresh.updated_at;
          }
          await journal.update(update, syncOptions());
        }
      }
    } catch (err) {
      // Best-effort — don't fail the sync, but don't fail silently either.
      console.warn('Chronicle: Failed to push permissions update', err);
      this._syncManager?.logActivity?.(
        'error',
        `Failed to push permissions${label ? ` for "${label}"` : ''} — ${err?.message || 'unknown error'}`
      );
      ui.notifications?.warn?.(
        `Chronicle: Failed to push permissions${label ? ` for "${noticeText(label)}"` : ''}. See the sync dashboard for details.`
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
    // A heading inside a GM secret block is not a break: its text would
    // become a page name players can read.
    const headingRegex = /<h[12][^>]*>(.*?)<\/h[12]>/gi;
    const secret = secretBlockRanges(html);
    const matches = [...html.matchAll(headingRegex)]
      .filter((m) => !secret.some(([start, end]) => m.index >= start && m.index < end))
      .map((m) => ({ m, start: headingStart(html, m, secret) }));

    // No headings found — return as single page.
    if (matches.length === 0) {
      return [{ title: 'Content', content: html }];
    }

    const sections = [];

    // Content before the first heading (if any).
    const preContent = html.substring(0, matches[0].start).trim();
    if (preContent) {
      sections.push({ title: 'Overview', content: preContent });
    }

    // Each heading starts a new section, ending at the next heading or end of string.
    for (let i = 0; i < matches.length; i++) {
      const { m: match, start } = matches[i];
      const endIndex = i + 1 < matches.length ? matches[i + 1].start : html.length;

      // Strip HTML tags from heading text for the page title.
      const title = match[1].replace(/<[^>]*>/g, '').trim() || `Section ${i + 1}`;

      // Include the heading in the page content for context.
      sections.push({
        title,
        content: html.substring(start, endIndex).trim(),
      });
    }

    return sections;
  }

  /**
   * Concatenate a journal's text pages, in sort order, into one HTML string
   * as Foundry holds it (placeholders and all).
   * @param {JournalEntry} journal
   * @returns {string}
   * @private
   */
  _joinTextPages(journal) {
    const textPages = journal.pages
      .filter((p) => p.type === 'text' && !p.getFlag(FLAG_SCOPE, 'isPlayerNotes'))
      .sort((a, b) => a.sort - b.sort);

    if (textPages.length === 0) return '';
    if (textPages.length === 1) return textPages[0].text?.content || '';

    // Multiple pages: concatenate with the page name as a heading separator.
    return textPages
      .map((page) => {
        const content = page.text?.content || '';
        // If the page content already starts with a heading, use it as-is
        // (a GM-only start of that heading may come first).
        if (startsWithHeading(content)) return content;
        // Otherwise, wrap the page name as an h2 heading.
        return `<h2>${page.name}</h2>\n${content}`;
      })
      .join('\n');
  }

  /**
   * The Player Notes page's HTML as Foundry holds it, or null when the
   * journal has none.
   * @param {JournalEntry} journal
   * @returns {string|null}
   * @private
   */
  _playerNotesPageHtml(journal) {
    const playerNotesPage = journal.pages.find(
      (p) => p.getFlag(FLAG_SCOPE, 'isPlayerNotes')
    );
    if (!playerNotesPage) return null;
    return playerNotesPage.text?.content || '';
  }

  /**
   * The journal's page text for Chronicle: placeholders get their GM-only
   * content back and secret blocks become GM-only text. Undefined when a
   * placeholder's content can't be found, so the caller leaves the text out
   * rather than sending it without that content.
   * @param {JournalEntry} journal
   * @param {string} entityId
   * @param {{fetch?: boolean}} [opts] - false: never ask Chronicle
   * @returns {Promise<string|undefined>}
   * @private
   */
  async _entryForPush(journal, entityId, opts) {
    return this._forPush(journal, this._joinTextPages(journal), entityId, opts);
  }

  /**
   * As _entryForPush, for the Player Notes page; null when there is none.
   * @returns {Promise<string|null|undefined>}
   * @private
   */
  async _playerNotesForPush(journal, entityId, opts) {
    const html = this._playerNotesPageHtml(journal);
    return html === null ? null : this._forPush(journal, html, entityId, opts);
  }

  /** @private */
  async _forPush(journal, html, entityId, { fetch = true } = {}) {
    const label = secretPlaceholderText();
    let r = restoreSecrets(html, this._secretPieces, label, _sanitizeIncomingHTML);
    if (r.missing.length && fetch && entityId) {
      await this._loadSecretPieces(entityId);
      r = restoreSecrets(html, this._secretPieces, label, _sanitizeIncomingHTML);
    }
    if (r.missing.length) {
      if (!this._warnedUnrestored.has(journal.id)) {
        this._warnedUnrestored.add(journal.id);
        ui.notifications?.warn?.(game.i18n.format('CHRONICLE.Secrets.NotSent', { name: noticeText(journal.name) }));
      }
      console.warn(`Chronicle: did not send the text of "${journal.name}": its GM-only parts changed in Chronicle`);
      return undefined;
    }
    // Pictures after the restore, so a GM-only one in restored content or
    // in a block the GM typed leaves marked GM-only.
    return toChronicleSecrets(toChroniclePictures(r.html, getSetting('apiUrl')));
  }

  /**
   * The page's facts for the Chronicle sheet: only field values every reader
   * of the journal may see (playerSafeFacts). Null when they can't be worked
   * out (no field values in this copy, or the category's fields not loaded),
   * so the journal keeps what it has.
   * @param {object} entity
   * @returns {Array<{label: string, value: string}>|null}
   * @private
   */
  _factsFor(entity) {
    if (!entity?.fields_data || typeof entity.fields_data !== 'object') return null;
    const defs = this._tree.types.get(entity.entity_type_id)?.fields;
    if (!Array.isArray(defs)) return null;
    return playerSafeFacts(entity.fields_data, defs);
  }

  /**
   * Chronicle HTML -> what a journal page stores: GM-only content as
   * placeholders (scripts/_gm-secrets.mjs), the content itself kept in
   * memory for the GM's view and the next push.
   * @param {string} entityId
   * @param {string|null|undefined} html
   * @returns {Promise<string>}
   * @private
   */
  async _pullHtml(entityId, html) {
    if (!html) return '';
    // Pictures before hiding: shared ones point at their local copy, and
    // GM-only ones go in a secret block, so they are hidden like GM text.
    const { html: hidden, pieces } = await hideSecrets(
      await this._withPictures(toFoundrySecrets(html)), secretPlaceholderText(), secretKeyer(getSetting('apiKey'), entityId),
    );
    for (const [id, content] of pieces) this._secretPieces.set(id, content);
    return _sanitizeIncomingHTML(hidden);
  }

  /**
   * Read an entity's GM-only content from Chronicle into memory. One read
   * per entity at a time.
   * @param {string} entityId
   * @returns {Promise<void>}
   * @private
   */
  _loadSecretPieces(entityId) {
    if (!this._api) return Promise.resolve();
    const pending = this._secretLoads.get(entityId);
    if (pending) return pending;
    const load = (async () => {
      const entity = await this._api.get(`/entities/${entityId}`);
      for (const html of [entity?.entry_html, entity?.player_notes_html]) {
        if (!html) continue;
        // Same blocks as the pull, so the placeholder ids match; no copies.
        const { pieces } = await hideSecrets(
          toFoundryPictures(toFoundrySecrets(html), () => undefined), secretPlaceholderText(), secretKeyer(getSetting('apiKey'), entityId),
        );
        for (const [id, content] of pieces) this._secretPieces.set(id, content);
      }
    })().finally(() => this._secretLoads.delete(entityId));
    this._secretLoads.set(entityId, load);
    return load;
  }

  /**
   * GM-only content for one placeholder, for the GM's view: from memory,
   * else read from Chronicle for the journal that holds the placeholder.
   * @param {string} id - placeholder id
   * @returns {Promise<string|null>}
   * @private
   */
  async _secretFor(id) {
    if (this._secretPieces.has(id)) return this._secretPieces.get(id);
    const journal = game.journal?.find?.((j) => j.pages?.some?.((p) => (p.text?.content || '').includes(id)));
    const entityId = journal?.getFlag(FLAG_SCOPE, 'entityId');
    // Read each page at most once a session for the view; a placeholder
    // still unknown after that stays a placeholder until the next pull.
    if (!entityId || this._secretViewLoaded.has(entityId)) return null;
    this._secretViewLoaded.add(entityId);
    try {
      await this._loadSecretPieces(entityId);
    } catch (err) {
      console.warn('Chronicle: could not read GM-only text from Chronicle', err);
      return null;
    }
    return this._secretPieces.get(id) ?? null;
  }

  /**
   * After a push, replace secret blocks the GM typed in Foundry with
   * placeholders, from the copy Chronicle answered with, so their text
   * leaves the saved page.
   * @param {JournalEntry} journal
   * @param {object} result - Chronicle's answer to the PUT
   * @private
   */
  async _hidePushedSecrets(journal, result) {
    if (!result?.id) return;
    // A newer edit still waiting to be sent is never overwritten with this
    // older answer; its own push hides it.
    if (this._journalPushDebouncer.has(journal.id)) return;
    const placeholderText = secretPlaceholderText();
    const clear = (p) => hasClearSecrets(p.text?.content || '', { placeholderText });
    const textPages = journal.pages.filter((p) => p.type === 'text');
    if (typeof result.entry_html === 'string'
      && textPages.some((p) => !p.getFlag(FLAG_SCOPE, 'isPlayerNotes') && clear(p))) {
      await this._syncPagesToJournal(journal, await this._pullHtml(result.id, result.entry_html));
    }
    if (typeof result.player_notes_html === 'string'
      && textPages.some((p) => p.getFlag(FLAG_SCOPE, 'isPlayerNotes') && clear(p))) {
      await this._syncPlayerNotesPage(journal, await this._pullHtml(result.id, result.player_notes_html));
    }
  }

  /**
   * Clean up what an older module version left in saved journals: field
   * values in flags are removed in place, and journals holding GM-only text
   * in the clear (Chronicle secret spans, or sync's own secret blocks without
   * placeholders) are pulled again, a few per connect so other sync requests
   * stay inside the API key's rate limit. Idempotent: a clean journal is
   * skipped.
   * @private
   */
  async _hideStoredSecrets() {
    let pulls = 0;
    for (const journal of game.journal?.contents ?? []) {
      const entityId = journal.getFlag(FLAG_SCOPE, 'entityId');
      if (!entityId) continue;
      try {
        if (journal.flags?.[FLAG_SCOPE]?.fields !== undefined) {
          await journal.update(flagRemoval(FLAG_SCOPE, 'fields'), syncOptions());
        }
        for (const p of journal.pages) {
          const fixed = p.type === 'text' ? revealableSecrets(p.text?.content) : null;
          if (fixed !== null) await p.update({ 'text.content': fixed }, syncOptions());
        }
        const clear = journal.pages.some((p) => p.type === 'text'
          && hasClearSecrets(p.text?.content || '', { chronicleOnly: true }));
        if (!clear || pulls >= STORED_SECRET_PULLS_PER_CONNECT) continue;
        pulls++;
        const entity = await this._api.get(`/entities/${entityId}`);
        if (entity?.id) await this._onEntityUpdated(entity);
      } catch (err) {
        console.warn(`Chronicle: could not refresh "${journal.name}" to hide its GM-only text`, err);
      }
    }
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
        await existingPage.update({ 'text.content': playerNotesHtml }, syncOptions());
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
        ], syncOptions());
      }
    } else if (existingPage) {
      // Remove player notes page if entity no longer has player notes.
      await journal.deleteEmbeddedDocuments('JournalEntryPage', [existingPage.id], syncOptions());
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
        ui.notifications.warn(`Chronicle: Conflict on "${noticeText(journal.name)}" — kept Chronicle version.`);
        break;
      }
      case 'foundry': {
        // Force push without expected_updated_at.
        delete body.expected_updated_at;
        const result = await this._api.put(`/entities/${entityId}`, body);
        await this._recordPush(journal, result);
        await this._hidePushedSecrets(journal, result);
        ui.notifications.warn(`Chronicle: Conflict on "${noticeText(journal.name)}" — kept Foundry version.`);
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
          await this._recordPush(journal, result);
          await this._hidePushedSecrets(journal, result);
          ui.notifications.info(`Chronicle: Conflict on "${noticeText(journal.name)}" — Foundry version was newer.`);
        } else if (remote) {
          // Remote is newer — re-pull.
          await this._onEntityUpdated(remote);
          ui.notifications.info(`Chronicle: Conflict on "${noticeText(journal.name)}" — Chronicle version was newer.`);
        }
        break;
      }
    }
  }

  /**
   * Chronicle HTML with its pictures made showable in Foundry: shared ones
   * copied into the world's files, GM-only ones inside a secret block
   * (scripts/_inline-pictures.mjs). A picture that can't be copied keeps
   * its Chronicle path and is retried on the next pull.
   * @param {string} html
   * @returns {Promise<string>}
   * @private
   */
  async _withPictures(html) {
    if (!html) return html;
    const ids = sharedPictureIds(html);
    const local = ids.length && this._pictures ? await this._pictures.ensure(ids) : new Map();
    return toFoundryPictures(html, (id) => local.get(id));
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
        // A pull keeps what the GM revealed at the table.
        const kept = carryReveals(page.text?.content, section.content);
        const updates = { 'text.content': applyReveals(kept, this._secretPieces, secretPlaceholderText(), _sanitizeIncomingHTML) ?? kept };
        if (page.name !== section.title) {
          updates.name = section.title;
        }
        await page.update(updates, syncOptions());
      } else {
        // Create new page.
        await journal.createEmbeddedDocuments('JournalEntryPage', [
          {
            name: section.title,
            type: 'text',
            text: { content: section.content },
            sort: (existingTextPages.length + i) * 100,
          },
        ], syncOptions());
      }
    }

    // Remove excess pages if entity has fewer sections than journal has pages.
    if (sections.length < existingTextPages.length) {
      const pagesToDelete = existingTextPages
        .slice(sections.length)
        .map((p) => p.id);
      if (pagesToDelete.length > 0) {
        await journal.deleteEmbeddedDocuments('JournalEntryPage', pagesToDelete, syncOptions());
      }
    }
  }
}
