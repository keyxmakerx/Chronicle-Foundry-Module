/**
 * What a problem report carries besides the player's words, and the rules that
 * keep secrets out of it. The GM client builds every snapshot itself; this
 * module only shapes and scrubs what it was handed, so a snapshot that was
 * stored (or later copied into an issue) holds nothing it should not.
 *
 * Pure — see tools/test-debug-snapshot.mjs.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_PARAM = /([?&;](?:token|key|api[_-]?key|secret|sig|signature|access[_-]?token|auth|password|pwd)=)[^&\s"')]+/gi;

/** Longest single line kept from the sync log or a table cell. */
export const MAX_LINE = 300;

/**
 * Remove what must never leave the GM's browser inside a report: bearer
 * tokens, token-like query values, email addresses, long opaque strings and
 * the path/query of any full URL (the host stays so the report still says
 * where). Entity UUIDs are kept; they are ids, not secrets.
 * @param {*} value
 * @returns {string}
 */
export function redactText(value) {
  let s = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  s = s.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  s = s.replace(/\bhttps?:\/\/([^\s/?#]*@)?([^\s/?#]+)[^\s]*/gi, (_m, _u, host) => `https://${host}`);
  s = s.replace(SECRET_PARAM, '$1[redacted]');
  s = s.replace(/[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[^\s@<>()"',;]+/g, '[email]');
  s = s.replace(/[A-Za-z0-9_\-+/=]{32,}/g, (m) => (UUID.test(m) ? m : '[redacted]'));
  return s;
}

/** Redact, collapse to one line and clamp. */
export function cleanLine(value, max = MAX_LINE) {
  const s = redactText(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The host of a URL and nothing else (no scheme, path, query or userinfo).
 * @param {*} url
 * @returns {string}
 */
export function hostOnly(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}

/**
 * Module and system facts for a report.
 * @param {object} p
 * @returns {{moduleVersion: string, foundryVersion: string, systemId: string, systemVersion: string, chronicleHost: string, moneyField: string}}
 */
export function buildModuleInfo(p = {}) {
  return {
    moduleVersion: cleanLine(p.moduleVersion, 40),
    foundryVersion: cleanLine(p.foundryVersion, 40),
    systemId: cleanLine(p.systemId, 80),
    systemVersion: cleanLine(p.systemVersion, 40),
    chronicleHost: hostOnly(p.chronicleUrl),
    moneyField: cleanLine(p.moneyField, 200),
  };
}

/**
 * Merge the API error log and the logger's warnings/errors into one list,
 * newest first. Paths lose their query string.
 * @param {object} p
 * @param {Array<{time?: number, method?: string, path?: string, status?: number, message?: string, count?: number}>} [p.apiErrors]
 * @param {Array<{t: number, level: string, msg: string}>} [p.logRing]
 * @param {number} [p.limit]
 * @returns {Array<{at: number, level: string, text: string}>}
 */
export function buildSyncLog({ apiErrors = [], logRing = [], limit = 50 } = {}) {
  const out = [];
  for (const e of apiErrors) {
    const path = String(e.path ?? '').split('?')[0];
    const where = [e.method, path].filter(Boolean).join(' ');
    const status = e.status ? ` (${e.status})` : '';
    const times = e.count > 1 ? ` ×${e.count}` : '';
    out.push({ at: Number(e.time) || 0, level: 'error', text: cleanLine(`${where}${status}: ${e.message ?? ''}${times}`) });
  }
  for (const e of logRing) {
    if (e?.level !== 'warn' && e?.level !== 'error') continue;
    out.push({ at: Number(e.t) || 0, level: e.level, text: cleanLine(e.msg) });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, limit);
}

/**
 * The stored shape of a snapshot: a fixed set of fields, every string
 * scrubbed, sizes capped. Anything else in `raw` is dropped.
 * @param {*} raw
 */
export function sanitizeSnapshot(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const rows = Array.isArray(r.compare?.rows) ? r.compare.rows.slice(0, 200) : [];
  const log = Array.isArray(r.log) ? r.log.slice(0, 50) : [];
  const info = r.info && typeof r.info === 'object' ? r.info : {};
  return {
    characterName: cleanLine(r.characterName, 120),
    compare: {
      moneyLine: cleanLine(r.compare?.moneyLine, 400),
      rows: rows.map((x) => ({
        kind: x?.kind === 'money' ? 'money' : 'item',
        thing: cleanLine(x?.thing, 120),
        chronicle: cleanLine(x?.chronicle, 40),
        foundry: cleanLine(x?.foundry, 40),
        status: cleanLine(x?.status, 20),
      })),
    },
    log: log.map((x) => ({
      at: Number(x?.at) || 0,
      level: x?.level === 'warn' ? 'warn' : 'error',
      text: cleanLine(x?.text),
    })),
    info: {
      moduleVersion: cleanLine(info.moduleVersion, 40),
      foundryVersion: cleanLine(info.foundryVersion, 40),
      systemId: cleanLine(info.systemId, 80),
      systemVersion: cleanLine(info.systemVersion, 40),
      chronicleHost: cleanLine(info.chronicleHost, 120),
      moneyField: cleanLine(info.moneyField, 200),
    },
  };
}
