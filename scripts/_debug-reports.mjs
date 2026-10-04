/**
 * Player problem reports: what the GM client accepts over the module socket,
 * how often, how many it keeps, and how the list is kept. The reporter is
 * whoever the socket layer says sent the message; nothing in the payload can
 * name anyone else, and a player's own snapshot is never read.
 *
 * Pure — see tools/test-debug-reports.mjs.
 */

export const DEBUG_MSG = Object.freeze({
  HELLO: 'debug:hello',
  KEY: 'debug:key',
  REPORT: 'debug:report',
  ACK: 'debug:ack',
});

export const MAX_TEXT = 1000;
export const MAX_REPORTS = 100;
/** Done reports older than this are dropped whenever the list is written. */
export const DONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const RATE_LIMIT = Object.freeze({ max: 5, windowMs: 10 * 60 * 1000 });
/** How long a player's box waits for the GM client before saying no GM answered. */
export const ACK_TIMEOUT_MS = 5000;

export const REPORT_STATUS = Object.freeze({ NEW: 'new', DONE: 'done' });

/** @param {any} msg @returns {boolean} */
export function isDebugMessage(msg) {
  return !!msg && typeof msg === 'object' && typeof msg.type === 'string' && msg.type.startsWith('debug:');
}

/** The report text as stored: control characters out, trimmed, capped. */
export function cleanReportText(value) {
  // eslint-disable-next-line no-control-regex
  const s = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

/**
 * Decide whether to accept one relayed report.
 * @param {object} msg - the socket payload (only `requestId`, `characterId`, `text` are read).
 * @param {object} ctx
 * @param {string} ctx.senderId - Foundry user id from the socket layer.
 * @param {string} ctx.senderName - that user's name, looked up by the caller from the id.
 * @param {(characterId: string) => boolean} ctx.senderOwns - sender may report on this character.
 * @param {Object<string, number[]>} ctx.stamps - prior accept times by sender.
 * @param {number} ctx.now
 * @param {() => string} ctx.makeId
 * @returns {{ok: true, report: object, stamps: Object<string, number[]>} | {ok: false, code: string}}
 */
export function acceptReport(msg, { senderId, senderName, senderOwns, stamps = {}, now, makeId }) {
  if (!msg || typeof msg !== 'object') return { ok: false, code: 'bad_request' };
  if (!senderId || typeof senderId !== 'string') return { ok: false, code: 'no_sender' };
  const characterId = typeof msg.characterId === 'string' ? msg.characterId : '';
  const text = cleanReportText(typeof msg.text === 'string' ? msg.text : '');
  if (!characterId || !text) return { ok: false, code: 'bad_request' };
  if (!senderOwns(characterId)) return { ok: false, code: 'not_owner' };

  const limited = checkRateLimit(stamps[senderId], now);
  if (!limited.allowed) return { ok: false, code: 'rate_limited' };

  return {
    ok: true,
    stamps: { ...stamps, [senderId]: limited.stamps },
    report: {
      id: makeId(), fromUserId: senderId, fromName: String(senderName || '').slice(0, 80),
      characterId, text, at: now, status: REPORT_STATUS.NEW, snapshot: null, note: '',
    },
  };
}

/**
 * Sliding-window limit for one sender.
 * @param {number[]|undefined} stamps - times of that sender's accepted reports.
 * @param {number} now
 * @param {{max: number, windowMs: number}} [limit]
 * @returns {{allowed: boolean, stamps: number[]}} `stamps` is the pruned list, plus `now` when allowed.
 */
export function checkRateLimit(stamps, now, limit = RATE_LIMIT) {
  const recent = (stamps || []).filter((t) => now - t < limit.windowMs);
  if (recent.length >= limit.max) return { allowed: false, stamps: recent };
  return { allowed: true, stamps: [...recent, now] };
}

/**
 * Add a report, keeping at most `cap`: when over, the oldest done report goes
 * first, then the oldest of all.
 * @param {object[]} list
 * @param {object} report
 * @param {number} [cap]
 * @returns {object[]} a new list.
 */
export function appendReport(list, report, cap = MAX_REPORTS) {
  const next = [...(list || []), report];
  while (next.length > cap) {
    let drop = -1;
    for (let i = 0; i < next.length; i++) {
      if (next[i].status === REPORT_STATUS.DONE && (drop === -1 || next[i].at < next[drop].at)) drop = i;
    }
    if (drop === -1) {
      drop = 0;
      for (let i = 1; i < next.length; i++) if (next[i].at < next[drop].at) drop = i;
    }
    next.splice(drop, 1);
  }
  return next;
}

/** @returns {object[]} a new list with report `id` marked done. */
export function markDone(list, id) {
  return (list || []).map((r) => (r.id === id ? { ...r, status: REPORT_STATUS.DONE } : r));
}

/** @returns {number} how many reports are still new. */
export function unreadCount(list) {
  return (list || []).filter((r) => r?.status === REPORT_STATUS.NEW).length;
}

/**
 * Newest first, split into new and done.
 * @returns {{open: object[], done: object[]}}
 */
export function splitReports(list) {
  const sorted = [...(list || [])].sort((a, b) => b.at - a.at);
  return {
    open: sorted.filter((r) => r.status !== REPORT_STATUS.DONE),
    done: sorted.filter((r) => r.status === REPORT_STATUS.DONE),
  };
}

/** Load the stored array defensively: anything malformed is dropped. */
export function normalizeReports(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && typeof r.text === 'string')
    .map((r) => ({
      id: r.id,
      fromUserId: String(r.fromUserId ?? ''),
      fromName: String(r.fromName ?? ''),
      characterId: String(r.characterId ?? ''),
      text: String(r.text).slice(0, MAX_TEXT),
      at: Number(r.at) || 0,
      status: r.status === REPORT_STATUS.DONE ? REPORT_STATUS.DONE : REPORT_STATUS.NEW,
      snapshot: r.snapshot && typeof r.snapshot === 'object' ? r.snapshot : null,
      note: typeof r.note === 'string' ? r.note.slice(0, 100) : '',
    }));
}

/**
 * How long ago, as a unit and a count for the caller to localize.
 * @returns {{unit: 'now'|'minutes'|'hours'|'days', n: number}}
 */
export function relativeAge(at, now) {
  const mins = Math.floor(Math.max(0, now - at) / 60000);
  if (mins < 1) return { unit: 'now', n: 0 };
  if (mins < 60) return { unit: 'minutes', n: mins };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { unit: 'hours', n: hours };
  return { unit: 'days', n: Math.floor(hours / 24) };
}

/**
 * Drop done reports older than `maxAgeMs`; new ones are never pruned by age.
 * @returns {object[]} a new list.
 */
export function pruneReports(list, now, maxAgeMs = DONE_MAX_AGE_MS) {
  return (list || []).filter((r) => !(r.status === REPORT_STATUS.DONE && now - r.at > maxAgeMs));
}

/** What a report carries when its snapshot could not be built in time. */
export const SNAPSHOT_TIMED_OUT = 'snapshot timed out';
/** Longest the GM client spends building a snapshot. */
export const SNAPSHOT_TIMEOUT_MS = 8000;

/**
 * Take in one report in the order that matters to the player: the
 * acknowledgement goes out as soon as the report passes validation (owner and
 * rate limit), before any snapshot work, so a slow Chronicle cannot make the
 * player's box think no GM answered. The snapshot then gets a time limit; past
 * it the report is stored without one and says why.
 *
 * @param {object} p
 * @param {() => ({ok: true, report: object} | {ok: false, code: string})} p.accept - runs `acceptReport`.
 * @param {(r: {ok: boolean, code?: string}) => void} p.ack - called once.
 * @param {(report: object) => Promise<object|null>} p.buildSnapshot
 * @param {(report: object) => Promise<void>} p.store
 * @param {number} [p.timeoutMs]
 * @param {typeof setTimeout} [p.setTimer]
 * @param {typeof clearTimeout} [p.clearTimer]
 * @returns {Promise<{ok: boolean, code?: string, report?: object}>}
 */
export async function intakeReport({ accept, ack, buildSnapshot, store, timeoutMs = SNAPSHOT_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const accepted = accept();
  if (!accepted.ok) {
    ack({ ok: false, code: accepted.code });
    return { ok: false, code: accepted.code };
  }
  ack({ ok: true });

  const TIMEOUT = Symbol('timeout');
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimer(() => resolve(TIMEOUT), timeoutMs); });
  let snapshot = null;
  let note = '';
  try {
    const built = await Promise.race([Promise.resolve().then(() => buildSnapshot(accepted.report)), timeout]);
    if (built === TIMEOUT) note = SNAPSHOT_TIMED_OUT;
    else snapshot = built ?? null;
  } catch {
    note = 'snapshot failed';
  } finally {
    clearTimer(timer);
  }
  const report = { ...accepted.report, snapshot, note };
  try {
    await store(report);
  } catch {
    return { ok: false, code: 'store_failed', report };
  }
  return { ok: true, report };
}
