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
 * The one state a row shows. Trouble outranks standing. A page with no
 * journal is brought in by the list itself, so its row says why when it is
 * not: sync is off for it, a journal of the same name is waiting to be
 * linked, it is a character, or the last try failed.
 *
 * @param {string} status - from pageStatus
 * @param {object} p
 * @param {boolean} [p.excluded] - the page or its type has sync turned off
 * @param {object|null} [p.trouble] - from pageTrouble
 * @param {boolean} [p.catchingUp] - the list is fixing this page right now
 * @param {boolean} [p.clash] - a journal with no page has this page's name
 * @param {boolean} [p.character] - a character, which syncs as an actor
 */
export function rowState(status, { excluded = false, trouble = null, catchingUp = false, clash = false, character = false } = {}) {
  if (status === 'actor') return 'actor';
  if (status === 'chronicle-only') {
    if (catchingUp) return 'bringing-in';
    if (character) return 'character';
    if (excluded) return 'chronicle-only-off';
    if (clash) return 'clash';
    if (trouble) return 'failed';
    return 'chronicle-only';
  }
  if (catchingUp) return 'catching-up';
  if (excluded) return 'off';
  if (trouble) return trouble.kind;
  return status;
}

const STATE_LABEL = {
  synced: 'InSync',
  modified: 'Changed',
  'chronicle-only': 'OnlyChronicle',
  'chronicle-only-off': 'OnlyChronicleOff',
  'bringing-in': 'BringingIn',
  clash: 'SameNameFoundry',
  character: 'Character',
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
 * The single button a row carries beside its state, if any. A same-name
 * clash with exactly one journal offers to link the two; any other clash
 * leaves bringing the page in to the GM.
 * @param {string} state
 * @param {{paired?: boolean}} [opts]
 * @returns {null|{action: string, labelKey: string}}
 */
export function rowAction(state, { paired = false } = {}) {
  if (state === 'chronicle-only' || state === 'chronicle-only-off') return { action: 'pull-entity', labelKey: 'BringIn' };
  if (state === 'clash') return paired ? { action: 'pages-link', labelKey: 'Link' } : { action: 'pull-entity', labelKey: 'BringIn' };
  if (state === 'failed') return { action: 'pages-retry', labelKey: 'TryAgain' };
  if (state === 'waiting') return { action: 'pages-send-waiting', labelKey: 'SendNow' };
  return null;
}

/** Every row gets the menu except one that is being worked on or is an actor's. */
export function rowHasMenu(state) {
  return !['actor', 'character', 'catching-up', 'bringing-in'].includes(state);
}

/**
 * A page row's menu. A page whose whole type is off has no switch of its
 * own: the type's menu owns it. A page with no journal has nothing to sync
 * again or to hide here, so it gets only the switch and the details.
 *
 * @param {object} row
 * @param {string} row.state
 * @param {boolean} row.isPrivate
 * @param {boolean} row.pageExcluded - sync is off for this page itself
 * @param {boolean} row.typeExcluded
 * @param {string|null} [row.journalId]
 * @returns {Array<{action: string, labelKey: string, data?: Record<string, string>}>}
 */
export function pageMenu({ state, isPrivate, pageExcluded, typeExcluded, journalId = 'linked' }) {
  const items = [];
  if (journalId) {
    if (state !== 'off') items.push({ action: 'pages-sync-one', labelKey: 'MenuSyncAgain' });
    items.push({
      action: 'toggle-visibility',
      labelKey: isPrivate ? 'MenuShow' : 'MenuHide',
      data: { isPrivate: String(!!isPrivate) },
    });
  }
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
    { key: 'StatOnlyChronicle', count: count('chronicle-only', 'clash', 'character') },
    { key: 'StatBringingIn', count: count('bringing-in') },
    { key: 'StatChanged', count: count('modified', 'catching-up') },
    { key: 'StatTrouble', count: count('waiting', 'failed') },
    { key: 'StatOff', count: count('off', 'chronicle-only-off') },
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
 * Pages with no journal that the list brings in by itself. Only a row in the
 * plain "only in Chronicle" state: sync off, a same-name journal, a
 * character and a failed try all wait for the GM. Each page is tried once.
 *
 * @param {object} p
 * @param {Array<{id: string, state: string}>} p.rows
 * @param {Set<string>} p.tried
 * @param {number} [p.limit]
 * @returns {string[]} page ids, in list order
 */
export function bringInPlan({ rows, tried, limit = CATCH_UP_LIMIT }) {
  const ids = [];
  for (const row of rows) {
    if (ids.length >= limit) break;
    if (row.state === 'chronicle-only' && !tried.has(row.id)) ids.push(row.id);
  }
  return ids;
}

/** A name as a GM reads it: case and spacing do not make two names different. */
export function nameKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Same-name clashes between Chronicle pages and journals that have no page.
 * Sending such a journal, or bringing in such a page, would leave two things
 * of one name on each side, so both wait. Exactly one unlinked page and one
 * unlinked journal sharing a name are a pair, which the GM can link. Any
 * other match (a page that already has a journal, several of the same name,
 * a page with sync off) is held without a pair.
 *
 * @param {object} p
 * @param {Array<{id: string, name: string, status: string, excluded?: boolean}>} p.rows - every Chronicle page
 * @param {Array<{id: string, name: string}>} p.journals - journals with no page that could be sent
 * @param {string[]} [p.linkedNames] - names of journals that already have a page
 * @returns {{pages: Map<string, string|null>, journals: Map<string, {entityId: string|null}>}}
 *   page id to its paired journal (or null), journal id to its paired page (or null)
 */
export function nameClashes({ rows, journals, linkedNames = [] }) {
  const unlinked = new Map();
  const taken = new Set(linkedNames.map(nameKey));
  for (const row of rows) {
    const key = nameKey(row.name);
    if (!key) continue;
    if (row.status === 'chronicle-only') unlinked.set(key, [...(unlinked.get(key) ?? []), row]);
    else taken.add(key);
  }
  const byName = new Map();
  for (const journal of journals) {
    const key = nameKey(journal.name);
    if (key) byName.set(key, [...(byName.get(key) ?? []), journal]);
  }
  const out = { pages: new Map(), journals: new Map() };
  for (const [key, same] of byName) {
    const pages = unlinked.get(key) ?? [];
    if (!pages.length && !taken.has(key)) continue;
    const pair = pages.length === 1 && same.length === 1 && !pages[0].excluded && !taken.has(key);
    for (const journal of same) out.journals.set(journal.id, { entityId: pair ? pages[0].id : null });
    for (const page of pages) out.pages.set(page.id, pair ? same[0].id : null);
  }
  return out;
}

/**
 * Where a journal with no page stands. One that is set aside (its page was
 * removed in Chronicle) or has sync turned off is never sent by the list.
 *
 * @param {object} p
 * @param {boolean} [p.setAside]
 * @param {boolean} [p.keepLocal] - the GM turned sync off for this journal
 * @param {object|null} [p.clash] - from nameClashes
 * @param {boolean} [p.sending]
 * @param {object|null} [p.failure] - the last send from the list failed
 * @returns {'sending'|'set-aside'|'off'|'clash'|'failed'|'foundry-only'}
 */
export function journalState({ setAside = false, keepLocal = false, clash = null, sending = false, failure = null } = {}) {
  if (sending) return 'sending';
  if (setAside) return 'set-aside';
  if (keepLocal) return 'off';
  if (clash) return 'clash';
  if (failure) return 'failed';
  return 'foundry-only';
}

const JOURNAL_LABEL = {
  sending: 'Sending',
  'set-aside': 'SetAside',
  off: 'SyncOff',
  clash: 'SameNameChronicle',
  failed: 'FailedSend',
  'foundry-only': 'OnlyFoundry',
};

/** The lang key (under CHRONICLE.Dashboard.Pages) for a journal row's word. */
export function journalLabelKey(state) {
  return JOURNAL_LABEL[state] ?? 'OnlyFoundry';
}

/**
 * The single button a journal row carries. Sending stays possible by hand
 * for a journal the list holds back, except one with sync off.
 * @returns {null|{action: string, labelKey: string}}
 */
export function journalAction(state, { paired = false } = {}) {
  if (state === 'sending' || state === 'off') return null;
  if (state === 'clash' && paired) return { action: 'pages-link', labelKey: 'Link' };
  return { action: 'push-journal', labelKey: state === 'failed' ? 'TryAgain' : 'Send' };
}

/**
 * A journal row's menu. A set-aside journal has no switch: it is never sent
 * by itself anyway. Half of a same-name pair can still be sent as a page of
 * its own.
 */
export function journalMenu({ state, keepLocal = false, paired = false }) {
  const items = [];
  if (state === 'clash' && paired) items.push({ action: 'push-journal', labelKey: 'MenuSendAsNew' });
  if (state !== 'set-aside' && state !== 'sending') {
    items.push({
      action: 'pages-journal-sync',
      labelKey: keepLocal ? 'MenuJournalOn' : 'MenuJournalOff',
      data: { enable: String(!!keepLocal) },
    });
  }
  items.push({ action: 'pages-copy-journal', labelKey: 'MenuCopyDetails' });
  return items;
}

/**
 * Journals with no page that the list sends by itself: only those in the
 * plain "only in Foundry" state, each tried once.
 *
 * @param {object} p
 * @param {Array<{id: string, state: string}>} p.journals
 * @param {Set<string>} p.tried
 * @param {number} [p.limit]
 * @returns {string[]} journal ids, in list order
 */
export function sendPlan({ journals, tried, limit = CATCH_UP_LIMIT }) {
  const ids = [];
  for (const journal of journals) {
    if (ids.length >= limit) break;
    if (journal.state === 'foundry-only' && !tried.has(journal.id)) ids.push(journal.id);
  }
  return ids;
}

/**
 * Whose text is kept when a journal and a page of the same name are linked:
 * what the GM's conflict setting says. "Newest" compares when each was last
 * changed, and keeps Chronicle's when that cannot be told.
 *
 * @param {object} p
 * @param {string} p.strategy - 'chronicle', 'foundry' or 'newest'
 * @param {number} [p.journalChangedAt] - ms
 * @param {string} [p.pageUpdatedAt] - the page's `updated_at`
 * @returns {'chronicle'|'foundry'}
 */
export function linkKeeps({ strategy, journalChangedAt = 0, pageUpdatedAt = '' }) {
  if (strategy === 'foundry') return 'foundry';
  if (strategy !== 'newest') return 'chronicle';
  const page = Date.parse(pageUpdatedAt || '');
  return Number.isFinite(page) && journalChangedAt > page ? 'foundry' : 'chronicle';
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

/**
 * "Copy details for help" for a journal that has no page. The same rule:
 * never the journal's text, the key or the connect line.
 *
 * @param {object} p
 * @param {{id: string, name: string, state: string, setAside?: boolean, keepLocal?: boolean, pageCount?: number}} p.journal
 * @param {{entityId: string|null}|null} [p.clash]
 * @param {{message: string, at: number}|null} [p.failure]
 * @param {Record<string, string>} [p.versions]
 * @returns {string}
 */
export function journalDetails({ journal, clash = null, failure = null, versions = {} }) {
  const lines = [
    `Journal: ${journal.name}`,
    `Foundry journal id: ${journal.id}`,
    'Chronicle page id: none',
    `State: ${journal.state}`,
    `Pages in the journal: ${journal.pageCount ?? 0}`,
    `Set aside after a removal in Chronicle: ${journal.setAside ? 'yes' : 'no'}`,
    `Sync off for this journal: ${journal.keepLocal ? 'yes' : 'no'}`,
  ];
  if (clash) lines.push(`Same name as a Chronicle page: ${clash.entityId ? `yes, page ${clash.entityId}, not linked` : 'yes'}`);
  if (failure) lines.push(`Trouble: ${failure.message}`);
  for (const [name, value] of Object.entries(versions)) {
    if (value) lines.push(`${name}: ${value}`);
  }
  return lines.join('\n');
}
