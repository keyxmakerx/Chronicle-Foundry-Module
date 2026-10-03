/**
 * Chronicle Sync - Debug hub
 *
 * Everything the Debug tab and the "Report a problem" box share:
 *  - the read-only side-by-side of a linked character (Chronicle vs Foundry);
 *  - the stored player reports (flags of one journal entry nobody but GMs can
 *    see, written by the GM only);
 *  - the module socket traffic that carries a report from a player to the
 *    active GM and the small acknowledgement back.
 *
 * The GM client builds every snapshot itself. A player sends words and a
 * character id; who sent it comes only from the socket layer. Nothing here
 * writes to Chronicle or to an actor.
 */

import { FLAG_SCOPE, MODULE_ID, REPORT_STORE_FLAG, SYNC_OPTIONS } from './constants.mjs';
import { getSetting, setSetting } from './settings.mjs';
import { SOCKET_CHANNEL, getStashSync } from './stash-sync.mjs';
import { isAnsweringGM, PendingRequests } from './_stash-relay.mjs';
import { normalizeView } from './_stash-model.mjs';
import { relationMeta, HAS_ITEM } from './_inventory-plan.mjs';
import { getNestedValue } from './adapters/generic-adapter.mjs';
import { getLogBuffer, log } from './logger.mjs';
import { compareSideBySide, findMoneyField } from './_debug-compare.mjs';
import { buildModuleInfo, buildSyncLog, sanitizeSnapshot } from './_debug-snapshot.mjs';
import {
  ACK_TIMEOUT_MS, DEBUG_MSG, acceptReport, appendReport, isDebugMessage,
  markDone, mergeLegacyReports, normalizeReports, unreadCount,
} from './_debug-reports.mjs';

/** Fired (all clients) when the stored reports change, so open windows redraw. */
export const REPORTS_CHANGED_HOOK = 'chronicleDebugReportsChanged';

/** @type {(() => import('./sync-manager.mjs').SyncManager|null)|null} */
let getSyncManager = null;

/** Accept times of recent reports by sender (memory only; a reload resets it). */
let stamps = {};

/** Serializes storage writes so two reports in a burst both land. */
let writeChain = Promise.resolve();

const acks = new PendingRequests({ timeoutMs: ACK_TIMEOUT_MS });

/** @param {() => any} syncManagerGetter */
export function bindDebugHub(syncManagerGetter) {
  getSyncManager = syncManagerGetter;
}

const manager = () => getSyncManager?.() ?? null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- Stored reports -------------------------------------------------------

const STORE_NAME = 'Chronicle: problem reports';
const REPORTS_FLAG = 'reports';

/**
 * The entry that holds the reports, found by its module flag (never by
 * name). Its default ownership is NONE, so Foundry does not send it, or its
 * flags, to a player's client at all.
 * @returns {JournalEntry|null}
 */
export function findStore() {
  return game.journal?.find((j) => j.getFlag(FLAG_SCOPE, REPORT_STORE_FLAG) === true) ?? null;
}

let storeChain = Promise.resolve();

/**
 * Make sure the store exists and fold in reports left in the old world
 * setting. Only the active GM creates it; any other client gets what exists.
 * @returns {Promise<JournalEntry|null>}
 */
export function ensureStore() {
  storeChain = storeChain.catch(() => {}).then(async () => {
    let store = findStore();
    if (!store) {
      if (!isAnsweringGM(game.user, game.users.activeGM)) return null;
      store = await JournalEntry.create({
        name: STORE_NAME,
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
        flags: { [FLAG_SCOPE]: { [REPORT_STORE_FLAG]: true, [REPORTS_FLAG]: [] } },
      }, { ...SYNC_OPTIONS });
    }
    if (game.user.isGM) await migrateLegacy(store);
    return store;
  });
  return storeChain;
}

/** Move reports from the old world setting into the store, then clear it. */
async function migrateLegacy(store) {
  let legacy;
  try { legacy = getSetting('problemReports'); } catch { return; }
  if (!Array.isArray(legacy) || !legacy.length) return;
  const merged = mergeLegacyReports(normalizeReports(store.getFlag(FLAG_SCOPE, REPORTS_FLAG)), legacy);
  await store.update({ [`flags.${FLAG_SCOPE}.${REPORTS_FLAG}`]: merged }, { ...SYNC_OPTIONS });
  await setSetting('problemReports', []);
}

/** @returns {object[]} the stored reports (oldest first); empty on a client that cannot see the store. */
export function getReports() {
  try {
    return normalizeReports(findStore()?.getFlag(FLAG_SCOPE, REPORTS_FLAG));
  } catch {
    return [];
  }
}

/** @returns {number} how many stored reports are new. */
export function getUnreadCount() {
  return unreadCount(getReports());
}

function writeReports(update) {
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      const store = findStore() ?? await ensureStore();
      if (!store) throw new Error('no report store');
      await store.update({ [`flags.${FLAG_SCOPE}.${REPORTS_FLAG}`]: update(getReports()) }, { ...SYNC_OPTIONS });
    });
  return writeChain;
}

/** Mark one report done. GM only. */
export async function markReportDone(id) {
  if (!game.user.isGM) return;
  await writeReports((list) => markDone(list, id));
}

// --- Side by side ---------------------------------------------------------

/** Foundry items worth comparing: those linked to Chronicle, or with a count. */
function foundryItemsOf(actor) {
  return actor.items.contents
    .map((i) => ({
      id: i.id,
      name: i.name,
      entityId: i.getFlag(FLAG_SCOPE, 'entityId') ?? null,
      quantity: i.system?.quantity,
    }))
    .filter((i) => i.entityId || Number.isFinite(Number(i.quantity)));
}

/** Chronicle's items from the "Has Item" relations, for when Stashes is off. */
async function itemsFromRelations(api, entityId) {
  const raw = await api.get(`/entities/${entityId}/relations`);
  const list = Array.isArray(raw) ? raw : (raw?.data || []);
  return list
    .filter((r) => r?.relationType === HAS_ITEM)
    .map((r) => ({ itemId: String(r.targetEntityId ?? ''), name: r.targetEntityName || '', quantity: relationMeta(r).quantity ?? 1 }));
}

/**
 * Compare one linked character against Chronicle. Reads only.
 * @param {Actor} actor
 * @returns {Promise<{ok: true, characterId: string, characterName: string, rows: object[], differences: number, moneyLine: string, moneyField: string} | {ok: false, reason: string}>}
 */
export async function gatherSideBySide(actor) {
  const sm = manager();
  const api = sm?.api;
  const characterId = actor?.getFlag?.(FLAG_SCOPE, 'entityId');
  if (!api || !characterId) return { ok: false, reason: 'unlinked' };

  // Chronicle's own view of the money and items, when Stashes answers.
  let view = null;
  const stash = getStashSync();
  if (stash?.isAvailable()) {
    const res = await stash.runDirect({ action: 'view', characterId: String(characterId) });
    if (res.ok) view = normalizeView(res.data);
  }

  let fieldDefs = [];
  const system = sm.getMatchedSystem?.();
  if (system) {
    try {
      const resp = await api.get(`/systems/${system}/character-fields`);
      if (Array.isArray(resp?.fields)) fieldDefs = resp.fields;
    } catch (err) {
      log.warn('Debug: could not read character fields', err);
    }
  }
  const money = findMoneyField(fieldDefs, view?.character.moneyKey || '');

  let chronicle;
  try {
    if (view) {
      chronicle = { moneyLabel: money?.label || '', money: view.character.money, items: view.character.items };
    } else {
      const entity = await api.get(`/entities/${characterId}`);
      chronicle = {
        moneyLabel: money?.label || '',
        money: money ? entity?.fields_data?.[money.key] : null,
        items: await itemsFromRelations(api, characterId),
      };
    }
  } catch (err) {
    log.warn('Debug: could not read the character from Chronicle', err);
    return { ok: false, reason: 'chronicle' };
  }

  const foundryMoney = money?.foundryPath ? getNestedValue(actor, money.foundryPath) : undefined;
  const result = compareSideBySide({
    chronicle,
    foundry: { moneyPath: money?.foundryPath, money: foundryMoney, items: foundryItemsOf(actor) },
  });
  const path = money?.foundryPath || '';
  const moneyLine = money
    ? game.i18n.format('CHRONICLE.Debug.MoneyLine', { label: money.label, path: path || game.i18n.localize('CHRONICLE.Debug.NoPath') })
    : game.i18n.localize('CHRONICLE.Debug.NoMoneyField');
  return {
    ok: true,
    characterId: String(characterId),
    characterName: actor.name,
    rows: result.rows,
    differences: result.differences,
    moneyLine,
    moneyField: money ? `${money.label}${path ? ` (${path})` : ''}` : '',
  };
}

// --- Module and system info, sync log ------------------------------------

/** @param {string} [moneyField] */
export function collectModuleInfo(moneyField = '') {
  return buildModuleInfo({
    moduleVersion: game.modules.get(MODULE_ID)?.version,
    foundryVersion: game.version,
    systemId: game.system?.id,
    systemVersion: game.system?.version,
    chronicleUrl: (() => { try { return getSetting('apiUrl'); } catch { return ''; } })(),
    moneyField,
  });
}

/** Recent sync errors and skipped items the module already keeps. */
export function collectSyncLog(limit = 50) {
  return buildSyncLog({ apiErrors: manager()?.api?.getErrorLog?.() ?? [], logRing: getLogBuffer(), limit });
}

/** A scrubbed snapshot of one character for a report. */
export function snapshotFrom(sbs) {
  return sanitizeSnapshot({
    characterName: sbs?.characterName,
    compare: { moneyLine: sbs?.moneyLine, rows: sbs?.rows },
    log: collectSyncLog(20),
    info: collectModuleInfo(sbs?.moneyField),
  });
}

// --- Receiving (GM client) ------------------------------------------------

const senderOwns = (senderId, characterId) => {
  const user = game.users.get(senderId);
  const actor = game.actors.find((a) => a.getFlag(FLAG_SCOPE, 'entityId') === characterId);
  if (!user || !actor) return false;
  return user.isGM || actor.testUserPermission(user, 'OWNER');
};

/**
 * Take in one report on the GM client: validate, snapshot, store, tell the GM.
 * @param {object} msg
 * @param {string} senderId - Foundry user id from the socket layer (or the GM's own id).
 * @returns {Promise<{ok: boolean, code?: string}>}
 */
export async function receiveReport(msg, senderId) {
  if (!game.user.isGM) return { ok: false, code: 'no_gm' };
  const user = game.users.get(senderId);
  const accepted = acceptReport(msg, {
    senderId,
    senderName: user?.name,
    senderOwns: (characterId) => senderOwns(senderId, characterId),
    stamps,
    now: Date.now(),
    makeId: () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  });
  if (!accepted.ok) return { ok: false, code: accepted.code };
  stamps = accepted.stamps;

  const report = accepted.report;
  const actor = game.actors.find((a) => a.getFlag(FLAG_SCOPE, 'entityId') === report.characterId);
  try {
    // Built here from live data; whatever the sender attached is never read.
    const sbs = actor ? await gatherSideBySide(actor) : { ok: false };
    report.snapshot = snapshotFrom(sbs.ok ? sbs : { characterName: actor?.name });
    await writeReports((list) => appendReport(list, report));
  } catch (err) {
    log.error('Debug: could not store a problem report', err);
    return { ok: false, code: 'store_failed' };
  }
  ui.notifications.info(game.i18n.format('CHRONICLE.Debug.ReportedNotice', { name: esc(report.fromName) }));
  return { ok: true };
}

// --- Sending (any client) -------------------------------------------------

/**
 * File a report about a character.
 * @param {{characterId: string, text: string}} p
 * @returns {Promise<{ok: boolean, code?: string}>} `code`: no_gm, rate_limited, bad_request, not_owner, store_failed.
 */
export async function submitReport({ characterId, text }) {
  const msg = { characterId: String(characterId ?? ''), text: String(text ?? '') };
  if (game.user.isGM) return receiveReport(msg, game.user.id);
  if (!game.users.activeGM) return { ok: false, code: 'no_gm' };
  const { id, promise } = acks.create(null);
  game.socket.emit(SOCKET_CHANNEL, { type: DEBUG_MSG.REPORT, requestId: id, ...msg });
  const res = await promise;
  if (res?.error?.code === 'timeout') return { ok: false, code: 'no_gm' };
  return res?.ok ? { ok: true } : { ok: false, code: res?.error?.code || 'store_failed' };
}

/** Listen on the module socket. Called once at ready on every client. */
export function registerDebugHub() {
  const changed = (doc) => { if (doc?.getFlag?.(FLAG_SCOPE, REPORT_STORE_FLAG) === true) Hooks.callAll(REPORTS_CHANGED_HOOK); };
  Hooks.on('createJournalEntry', changed);
  Hooks.on('updateJournalEntry', changed);
  Hooks.on('deleteJournalEntry', changed);
  // The entry is data, not a journal to browse: keep it out of the sidebar.
  Hooks.on('renderJournalDirectory', hideStoreFromDirectory);
  if (game.user.isGM) ensureStore().catch((err) => log.warn('Debug: could not prepare the report store', err));

  game.socket.on(SOCKET_CHANNEL, (data, senderId) => {
    if (!isDebugMessage(data)) return;
    if (data.type === DEBUG_MSG.REPORT) {
      if (!isAnsweringGM(game.user, game.users.activeGM) || typeof data.requestId !== 'string') return;
      receiveReport(data, senderId).then((res) => {
        game.socket.emit(SOCKET_CHANNEL, {
          type: DEBUG_MSG.ACK, requestId: data.requestId, toUserId: senderId, ok: res.ok, code: res.code ?? null,
        }, { recipients: [senderId] });
      });
    } else if (data.type === DEBUG_MSG.ACK) {
      // Only a GM's word counts, and only for the user it names.
      const fromGM = game.users.get(senderId)?.isGM === true;
      if (!fromGM || data.toUserId !== game.user.id || typeof data.requestId !== 'string') return;
      acks.settle(data.requestId, data.ok === true ? { ok: true } : { ok: false, error: { code: String(data.code || 'store_failed') } });
    }
  });
}

/** Remove the store's row from a rendered Journal directory (v12 jQuery or v13 element). */
function hideStoreFromDirectory(_app, html) {
  const store = findStore();
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!store || !root?.querySelector) return;
  root.querySelector(`[data-entry-id="${store.id}"], [data-document-id="${store.id}"]`)?.remove();
}
