/**
 * The Pages list's rows: where each Chronicle page stands against its
 * journal, what is wrong with it if anything, and which controls it gets.
 * Pure and Foundry-free, so the list's rules are unit-tested; pinned by
 * tools/test-page-rows.mjs. Text is returned as lang keys under
 * CHRONICLE.Dashboard.Pages and localized by the caller.
 */

/** A page list never fixes more than this many pages in one pass. */
export const CATCH_UP_LIMIT = 25;

const SKEW_MS = 5000;
/** Chronicle's versions are whole seconds, so less than one apart is the same version. */
const VERSION_STEP_MS = 1000;

/**
 * Where a page stands. A journal records the Chronicle version it holds
 * (`recordedVersion`), and that is compared first: both stamps come from
 * Chronicle's clock. Journals from before versions were recorded fall back to
 * the time of their last sync, which is this computer's clock and so needs slack.
 *
 * @param {object} p
 * @param {boolean} p.linked - a journal carries this page's id
 * @param {boolean} [p.isActor] - an actor carries it instead
 * @param {string} [p.recordedVersion] - the journal's `chronicleUpdatedAt` flag
 * @param {string} [p.lastSync] - the journal's `lastSync` flag
 * @param {string} [p.updatedAt] - the page's `updated_at` in Chronicle
 * @returns {'synced'|'modified'|'chronicle-only'|'actor'}
 */
export function pageStatus({ linked, isActor = false, recordedVersion, lastSync, updatedAt }) {
  if (!linked) return isActor ? 'actor' : 'chronicle-only';
  const remote = Date.parse(updatedAt || '');
  if (!Number.isFinite(remote)) return 'synced';
  if (recordedVersion) {
    if (recordedVersion === updatedAt) return 'synced';
    const held = Date.parse(recordedVersion);
    return Number.isFinite(held) && remote - held >= VERSION_STEP_MS ? 'modified' : 'synced';
  }
  const synced = Date.parse(lastSync || '');
  if (!Number.isFinite(synced)) return 'synced';
  return remote - synced > SKEW_MS ? 'modified' : 'synced';
}

/** Whether an API path is this page's own or one of its sub-resources. */
function isPagePath(path, entityId) {
  const own = `/entities/${entityId}`;
  return path === own || String(path || '').startsWith(`${own}/`);
}

/**
 * What is wrong with a page's sync, if anything. A change still queued is
 * "waiting": it is sent again without the GM. A failure only counts while it
 * is newer than the journal's last good sync and than the last queued change
 * that went through, so an old error never sticks to a page that has synced
 * since.
 *
 * @param {object} p
 * @param {string} p.entityId
 * @param {string} [p.lastSync]
 * @param {number} [p.sentAt] - when a queued change for this page last went through (ms)
 * @param {Array<{method: string, path: string}>} [p.waiting] - the retry queue
 * @param {Array<{level: string, method: string, path: string, time: number, message: string}>} [p.errors]
 * @param {{message: string, at: number}|null} [p.local] - a failed fix made from the list itself
 * @returns {null|{kind: 'waiting'}|{kind: 'failed', direction: 'in'|'out', message: string, at: number}}
 */
export function pageTrouble({ entityId, lastSync, sentAt = 0, waiting = [], errors = [], local = null }) {
  if (waiting.some((item) => isPagePath(item.path, entityId))) return { kind: 'waiting' };
  if (local) return { kind: 'failed', direction: 'in', message: local.message, at: local.at };
  const synced = Date.parse(lastSync || '');
  const since = Math.max(Number.isFinite(synced) ? synced : 0, sentAt || 0);
  const hit = errors.find((e) => e.level === 'error' && isPagePath(e.path, entityId) && e.time > since);
  if (!hit) return null;
  return { kind: 'failed', direction: hit.method === 'GET' ? 'in' : 'out', message: hit.message, at: hit.time };
}

/**
 * The one state a row shows. Trouble outranks standing; "sync off" only
 * describes a page that has a journal, since a page with none still offers
 * Bring in.
 *
 * @param {string} status - from pageStatus
 * @param {object} p
 * @param {boolean} [p.excluded] - the page or its type has sync turned off
 * @param {object|null} [p.trouble] - from pageTrouble
 * @param {boolean} [p.catchingUp] - the list is fixing this page right now
 */
export function rowState(status, { excluded = false, trouble = null, catchingUp = false } = {}) {
  if (status === 'actor') return 'actor';
  if (catchingUp) return 'catching-up';
  if (status === 'chronicle-only') return 'chronicle-only';
  if (excluded) return 'off';
  if (trouble) return trouble.kind;
  return status;
}

const STATE_LABEL = {
  synced: 'InSync',
  modified: 'Changed',
  'chronicle-only': 'OnlyChronicle',
  actor: 'Actor',
  off: 'SyncOff',
  'catching-up': 'CatchingUp',
  waiting: 'Waiting',
  failed: 'Failed',
};

/** The lang key (under CHRONICLE.Dashboard.Pages) for a row state's word. */
export function stateLabelKey(state) {
  return STATE_LABEL[state] ?? 'InSync';
}

/**
 * The single button a row carries beside its state, if any.
 * @returns {null|{action: string, labelKey: string}}
 */
export function rowAction(state) {
  if (state === 'chronicle-only') return { action: 'pull-entity', labelKey: 'BringIn' };
  if (state === 'failed') return { action: 'pages-retry', labelKey: 'TryAgain' };
  if (state === 'waiting') return { action: 'pages-send-waiting', labelKey: 'SendNow' };
  return null;
}

/** Rows whose page has a journal get the menu; the rest have nothing to put in it. */
export function rowHasMenu(state) {
  return state !== 'chronicle-only' && state !== 'actor' && state !== 'catching-up';
}

/**
 * A page row's menu. A page whose whole type is off has no switch of its
 * own: the type's menu owns it.
 *
 * @param {object} row
 * @param {string} row.state
 * @param {boolean} row.isPrivate
 * @param {boolean} row.pageExcluded - sync is off for this page itself
 * @param {boolean} row.typeExcluded
 * @returns {Array<{action: string, labelKey: string, data?: Record<string, string>}>}
 */
export function pageMenu({ state, isPrivate, pageExcluded, typeExcluded }) {
  const items = [];
  if (state !== 'off') items.push({ action: 'pages-sync-one', labelKey: 'MenuSyncAgain' });
  items.push({
    action: 'toggle-visibility',
    labelKey: isPrivate ? 'MenuShow' : 'MenuHide',
    data: { isPrivate: String(!!isPrivate) },
  });
  if (!typeExcluded) {
    items.push({
      action: 'pages-toggle-sync',
      labelKey: pageExcluded ? 'MenuSyncOn' : 'MenuSyncOff',
      data: { enable: String(!!pageExcluded) },
    });
  }
  items.push({ action: 'pages-copy-details', labelKey: 'MenuCopyDetails' });
  return items;
}

/** A type heading's menu. */
export function typeMenu({ typeExcluded, collapsed }) {
  return [
    { action: 'pages-toggle-type', labelKey: typeExcluded ? 'MenuTypeOn' : 'MenuTypeOff' },
    { action: 'pages-fold', labelKey: collapsed ? 'MenuUnfold' : 'MenuFold' },
  ];
}

/**
 * The small print beside a type's name, as ordered `{ key, count }` parts.
 * Empty parts are left out so a tidy type reads "3 in sync" and nothing else.
 *
 * @param {Array<{state: string}>} rows
 * @param {{typeExcluded?: boolean}} [opts]
 */
export function groupStats(rows, { typeExcluded = false } = {}) {
  if (typeExcluded) return [{ key: rows.length === 1 ? 'StatTypeOffOne' : 'StatTypeOff', count: rows.length }];
  const count = (...states) => rows.filter((r) => states.includes(r.state)).length;
  return [
    { key: 'StatInSync', count: count('synced', 'actor') },
    { key: 'StatOnlyChronicle', count: count('chronicle-only') },
    { key: 'StatChanged', count: count('modified', 'catching-up') },
    { key: 'StatTrouble', count: count('waiting', 'failed') },
    { key: 'StatOff', count: count('off') },
  ].filter((part) => part.count > 0);
}

/**
 * Pages the list brings up to date by itself: those Chronicle changed since
 * the journal last took them. A page whose last fetch failed is included,
 * since fetching again is the fix. A page whose own change could not be sent
 * is not: taking Chronicle's copy would erase that change, so it waits for
 * the GM. Pages with sync off and pages with a change still queued are left
 * alone. Each page is tried once, so one that will not catch up is shown as
 * failed, not retried in a loop.
 *
 * @param {object} p
 * @param {Array<{id: string, status: string, state: string, trouble?: object|null}>} p.rows
 * @param {Set<string>} p.tried
 * @param {number} [p.limit]
 * @returns {string[]} page ids, in list order
 */
export function catchUpPlan({ rows, tried, limit = CATCH_UP_LIMIT }) {
  const ids = [];
  for (const row of rows) {
    if (ids.length >= limit) break;
    if (row.status !== 'modified' || tried.has(row.id)) continue;
    if (row.state === 'modified' || (row.state === 'failed' && row.trouble?.direction === 'in')) ids.push(row.id);
  }
  return ids;
}

/**
 * Waiting changes the list sends again by itself, as `METHOD path` keys.
 * Only while Chronicle is connected, and each change only once: the queue
 * drops a change after a few failed tries, so trying on a timer could lose it.
 *
 * @param {object} p
 * @param {boolean} p.connected
 * @param {Array<{method: string, path: string}>} p.waiting
 * @param {Set<string>} p.tried
 * @returns {string[]}
 */
export function sendAgainPlan({ connected, waiting, tried }) {
  if (!connected) return [];
  return waiting.map((item) => `${item.method} ${item.path}`).filter((key) => !tried.has(key));
}

/** Whether a name matches the search box's text. An empty search matches everything. */
export function matchesSearch(name, search) {
  const needle = String(search || '').trim().toLowerCase();
  return !needle || String(name || '').toLowerCase().includes(needle);
}

/**
 * What "Copy details for help" puts on the clipboard: enough to ask for help
 * with one page, and nothing secret. The page's text, the API key and the
 * connect line are never part of it.
 *
 * @param {object} p
 * @param {object} p.row - a Pages list row
 * @param {string} [p.typeName]
 * @param {object|null} [p.trouble]
 * @param {Record<string, string>} [p.versions] - module, Foundry and Chronicle versions
 * @param {Array<{timeFormatted?: string, method: string, path: string, status?: number, message: string}>} [p.errors]
 * @returns {string}
 */
export function pageDetails({ row, typeName = '', trouble = null, versions = {}, errors = [] }) {
  const lines = [
    `Page: ${row.name}`,
    `Type: ${typeName || 'unknown'}`,
    `Chronicle page id: ${row.id}`,
    `Foundry journal id: ${row.journalId || 'none'}`,
    `State: ${row.state}`,
    `Changed in Chronicle: ${row.updatedAt || 'unknown'}`,
    `Version the journal holds: ${row.recordedVersion || 'not recorded'}`,
    `Last synced here: ${row.lastSync || 'never'}`,
    `Hidden from players: ${row.isPrivate ? 'yes' : 'no'}`,
    `Sync off: ${row.pageExcluded ? 'this page' : row.typeExcluded ? 'its type' : 'no'}`,
  ];
  if (trouble?.kind === 'waiting') lines.push('Trouble: a change is waiting to be sent again');
  if (trouble?.kind === 'failed') lines.push(`Trouble: ${trouble.message}`);
  for (const [name, value] of Object.entries(versions)) {
    if (value) lines.push(`${name}: ${value}`);
  }
  const own = errors.filter((e) => isPagePath(e.path, row.id)).slice(0, 5);
  if (own.length) {
    lines.push('Recent errors for this page:');
    for (const e of own) {
      lines.push(`- ${e.timeFormatted || ''} ${e.method} ${e.path}${e.status ? ` (${e.status})` : ''}: ${e.message}`.replace(/\s+/g, ' ').trim());
    }
  }
  return lines.join('\n');
}
