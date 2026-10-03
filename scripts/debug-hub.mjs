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
import { getSetting } from './settings.mjs';
import { SOCKET_CHANNEL, getStashSync } from './stash-sync.mjs';
import { isAnsweringGM, PendingRequests } from './_stash-relay.mjs';
import { normalizeView } from './_stash-model.mjs';
import { relationMeta, HAS_ITEM } from './_inventory-plan.mjs';
import { getNestedValue } from './adapters/generic-adapter.mjs';
import { getLogBuffer, log } from './logger.mjs';
import { compareSideBySide, findMoneyField } from './_debug-compare.mjs';
import { buildModuleInfo, buildSyncLog, sanitizeSnapshot } from './_debug-snapshot.mjs';
import {
  ACK_TIMEOUT_MS, DEBUG_MSG, acceptReport, appendReport, intakeReport, isDebugMessage,
  markDone, normalizeReports, pruneReports, unreadCount,
} from './_debug-reports.mjs';
import { decryptReply, encryptReply, generateRequestKeys, isPublicJwk } from './_stash-crypto.mjs';

/** Fired (all clients) when the stored reports change, so open windows redraw. */
export const REPORTS_CHANGED_HOOK = 'chronicleDebugReportsChanged';

/** @type {(() => import('./sync-manager.mjs').SyncManager|null)|null} */
let getSyncManager = null;

/** Accept times of recent reports by sender (memory only; a reload resets it). */
let stamps = {};

/** Serializes storage writes so two reports in a burst both land. */
let writeChain = Promise.resolve();

const acks = new PendingRequests({ timeoutMs: ACK_TIMEOUT_MS });
/** Player side: waiting for the GM's one-off public key. */
const keyWaits = new PendingRequests({ timeoutMs: ACK_TIMEOUT_MS });

/** How long a GM-side one-off private key waits for its report. */
const HELLO_KEY_TTL_MS = 60000;
/** GM side: `senderId:helloId` -> private key and expiry. Used once. */
const helloKeys = new Map();

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
 * name). Its default ownership is NONE, which is meant to keep Foundry from
 * sending it, or its flags, to a player's client; the live check in
 * TESTING.md (module #94) is what confirms that on each Foundry version.
 * @returns {JournalEntry|null}
 */
export function findStore() {
  return game.journal?.find((j) => j.getFlag(FLAG_SCOPE, REPORT_STORE_FLAG) === true) ?? null;
}

let storeChain = Promise.resolve();

/**
 * Make sure the store exists. Only the active GM creates it; any other client
 * gets what exists.
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
    return store;
  });
  return storeChain;
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
      const next = pruneReports(update(getReports()), Date.now());
      await store.update({ [`flags.${FLAG_SCOPE}.${REPORTS_FLAG}`]: next }, { ...SYNC_OPTIONS });
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
  const money = findMoneyField(fieldDefs, view?.character.moneyKey || '', !!view);

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
 * Take in one report on the GM client: validate, acknowledge, snapshot, store,
 * tell the GM. The acknowledgement goes out before the snapshot work (see
 * `intakeReport`).
 * @param {object} msg - `{characterId, text}`.
 * @param {string} senderId - Foundry user id from the socket layer (or the GM's own id).
 * @param {(r: {ok: boolean, code?: string}) => void} [ack]
 * @returns {Promise<{ok: boolean, code?: string}>}
 */
export async function receiveReport(msg, senderId, ack = () => {}) {
  if (!game.user.isGM) {
    ack({ ok: false, code: 'no_gm' });
    return { ok: false, code: 'no_gm' };
  }
  const user = game.users.get(senderId);
  const res = await intakeReport({
    accept: () => {
      const accepted = acceptReport(msg, {
        senderId,
        senderName: user?.name,
        senderOwns: (characterId) => senderOwns(senderId, characterId),
        stamps,
        now: Date.now(),
        makeId: () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      });
      if (accepted.ok) stamps = accepted.stamps;
      return accepted;
    },
    ack,
    // Built here from live data; whatever the sender attached is never read.
    buildSnapshot: async (report) => {
      const actor = game.actors.find((a) => a.getFlag(FLAG_SCOPE, 'entityId') === report.characterId);
      const sbs = actor ? await gatherSideBySide(actor) : { ok: false };
      return snapshotFrom(sbs.ok ? sbs : { characterName: actor?.name });
    },
    store: (report) => writeReports((list) => appendReport(list, report)),
  });
  if (!res.ok) {
    if (res.code === 'store_failed') log.error('Debug: could not store a problem report');
    return { ok: false, code: res.code };
  }
  ui.notifications.info(game.i18n.format('CHRONICLE.Debug.ReportedNotice', { name: esc(res.report.fromName) }));
  return { ok: true };
}

// --- Sending (any client) -------------------------------------------------

/**
 * File a report about a character. A player's text never travels in the clear:
 * the active GM answers a `debug:hello` with a one-off public key, and the
 * text is encrypted to it, so another client on the module channel sees only
 * ciphertext.
 * @param {{characterId: string, text: string}} p
 * @returns {Promise<{ok: boolean, code?: string}>} `code`: no_gm, rate_limited, bad_request, not_owner, store_failed.
 */
export async function submitReport({ characterId, text }) {
  const msg = { characterId: String(characterId ?? ''), text: String(text ?? '') };
  if (game.user.isGM) return receiveReport(msg, game.user.id);
  const gm = game.users.activeGM;
  if (!gm) return { ok: false, code: 'no_gm' };
  const to = { recipients: [gm.id] };

  const hello = keyWaits.create(null);
  game.socket.emit(SOCKET_CHANNEL, { type: DEBUG_MSG.HELLO, requestId: hello.id }, to);
  const key = await hello.promise;
  if (!key?.ok) return { ok: false, code: 'no_gm' };

  let envelope;
  try {
    envelope = await encryptReply(key.publicKey, msg);
  } catch {
    return { ok: false, code: 'store_failed' };
  }
  const { id, promise } = acks.create(null);
  game.socket.emit(SOCKET_CHANNEL, { type: DEBUG_MSG.REPORT, requestId: id, helloId: hello.id, envelope }, to);
  const res = await promise;
  if (res?.error?.code === 'timeout') return { ok: false, code: 'no_gm' };
  return res?.ok ? { ok: true } : { ok: false, code: res?.error?.code || 'store_failed' };
}

const reply = (userId, body) => game.socket.emit(SOCKET_CHANNEL, { toUserId: userId, ...body }, { recipients: [userId] });

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
    if (!isDebugMessage(data) || typeof data.requestId !== 'string') return;
    const fromGM = game.users.get(senderId)?.isGM === true;
    switch (data.type) {
      case DEBUG_MSG.HELLO:
        if (isAnsweringGM(game.user, game.users.activeGM)) answerHello(data.requestId, senderId);
        break;
      case DEBUG_MSG.KEY:
        // Only a GM's key counts, so a player cannot swap in their own.
        if (fromGM && data.toUserId === game.user.id && isPublicJwk(data.publicKey)) {
          keyWaits.settle(data.requestId, { ok: true, publicKey: data.publicKey });
        }
        break;
      case DEBUG_MSG.REPORT:
        if (isAnsweringGM(game.user, game.users.activeGM)) takeEncryptedReport(data, senderId);
        break;
      case DEBUG_MSG.ACK:
        // Only a GM's word counts, and only for the user it names.
        if (!fromGM || data.toUserId !== game.user.id) return;
        acks.settle(data.requestId, data.ok === true ? { ok: true } : { ok: false, error: { code: String(data.code || 'store_failed') } });
        break;
    }
  });
}

/** GM: hand out a one-off public key for one report. */
async function answerHello(helloId, senderId) {
  const now = Date.now();
  for (const [k, v] of helloKeys) if (v.expires < now) helloKeys.delete(k);
  try {
    const pair = await generateRequestKeys();
    helloKeys.set(`${senderId}:${helloId}`, { privateKey: pair.privateKey, expires: now + HELLO_KEY_TTL_MS });
    reply(senderId, { type: DEBUG_MSG.KEY, requestId: helloId, publicKey: pair.publicJwk });
  } catch (err) {
    log.warn('Debug: could not make a report key', err);
  }
}

/** GM: open a report with the key handed out for it (once), then take it in. */
async function takeEncryptedReport(data, senderId) {
  const ack = (r) => reply(senderId, { type: DEBUG_MSG.ACK, requestId: data.requestId, ok: r.ok, code: r.code ?? null });
  const keyId = `${senderId}:${data.helloId}`;
  const entry = helloKeys.get(keyId);
  helloKeys.delete(keyId);
  if (!entry || entry.expires < Date.now()) return ack({ ok: false, code: 'bad_request' });
  let msg;
  try {
    msg = await decryptReply(entry.privateKey, data.envelope);
  } catch {
    return ack({ ok: false, code: 'bad_request' });
  }
  await receiveReport(msg, senderId, ack);
}

/** Remove the store's row from a rendered Journal directory (v12 jQuery or v13 element). */
function hideStoreFromDirectory(_app, html) {
  const store = findStore();
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!store || !root?.querySelector) return;
  root.querySelector(`[data-entry-id="${store.id}"], [data-document-id="${store.id}"]`)?.remove();
}
