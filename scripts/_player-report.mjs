/**
 * What the GM's client tells Chronicle about the world's Foundry players.
 *
 * Chronicle only sees the GM's API key, so it cannot tell which player made a
 * change; this snapshot (POST /sync/players) is how its "Players in Foundry"
 * table learns who is linked, who is online and who last changed or failed.
 * Pure: no Foundry globals, no network, so it is testable under Node.
 */

/** Server limits on the body. */
export const MAX_PLAYERS = 100;
export const MAX_NAME_CHARS = 100;
export const MAX_FAILURE_CHARS = 200;

/** Failures older than this stop counting. */
export const FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Bounds so a long session or a huge world cannot grow the tracker without limit. */
const MAX_TRACKED_USERS = 200;
const MAX_FAILURES_PER_USER = 200;

/** Minimum gap between periodic reports, and the debounce for event triggers. */
export const REPORT_INTERVAL_MS = 5 * 60 * 1000;
export const EVENT_DEBOUNCE_MS = 2000;

const STATUS_TEXT = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  409: 'Conflict', 413: 'Payload Too Large', 422: 'Unprocessable Entity',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
};

/** @param {unknown} text @param {number} max */
function cap(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * A short, content-free reason for a failed push: the HTTP status only.
 * Never the error message, which can carry a response page or page text.
 * @param {{status?: number}|null|undefined} err
 * @returns {string}
 */
export function reasonFromError(err) {
  const status = Number(err?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    const text = STATUS_TEXT[status];
    return text ? `HTTP ${status} ${text}` : `HTTP ${status}`;
  }
  return 'no response from Chronicle';
}

/**
 * Per-Foundry-user record of the last synced change and recent failures.
 * Memory only: it starts empty each session, and Chronicle keeps the history.
 */
export class PlayerActivity {
  /**
   * @param {{now?: () => number}} [opts]
   */
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    /** @type {Map<string, {lastChangeAt: number|null, lastFailedAt: number|null, lastFailure: string, failures: number[]}>} */
    this._users = new Map();
    /** Bumped on every record, so a caller can tell something changed. */
    this.revision = 0;
  }

  /** Get-or-create, moved to the newest position so eviction drops the stalest. */
  _touch(userId) {
    const key = String(userId);
    let rec = this._users.get(key);
    if (rec) {
      this._users.delete(key);
    } else {
      rec = { lastChangeAt: null, lastFailedAt: null, lastFailure: '', failures: [] };
    }
    this._users.set(key, rec);
    while (this._users.size > MAX_TRACKED_USERS) {
      this._users.delete(this._users.keys().next().value);
    }
    return rec;
  }

  /** A change by this Foundry user reached Chronicle. */
  recordChange(userId) {
    if (!userId) return;
    this._touch(userId).lastChangeAt = this._now();
    this.revision++;
  }

  /** A change by this Foundry user failed to reach Chronicle. */
  recordFailure(userId, reason) {
    if (!userId) return;
    const rec = this._touch(userId);
    const t = this._now();
    rec.lastFailedAt = t;
    rec.lastFailure = cap(reason, MAX_FAILURE_CHARS);
    rec.failures.push(t);
    if (rec.failures.length > MAX_FAILURES_PER_USER) {
      rec.failures.splice(0, rec.failures.length - MAX_FAILURES_PER_USER);
    }
    this.revision++;
  }

  /**
   * @param {string} userId
   * @returns {{lastChangeAt: number|null, lastFailedAt: number|null, lastFailure: string, failedCount: number}}
   */
  get(userId) {
    const rec = this._users.get(String(userId));
    if (!rec) return { lastChangeAt: null, lastFailedAt: null, lastFailure: '', failedCount: 0 };
    const cutoff = this._now() - FAILURE_WINDOW_MS;
    rec.failures = rec.failures.filter((t) => t >= cutoff);
    return {
      lastChangeAt: rec.lastChangeAt,
      lastFailedAt: rec.lastFailedAt,
      lastFailure: rec.lastFailure,
      failedCount: rec.failures.length,
    };
  }

  /** Number of users tracked (for tests). */
  get size() { return this._users.size; }
}

/** @param {number|null|undefined} ms */
function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Build the POST /sync/players body.
 *
 * @param {object} p
 * @param {Array<{id: string, name: string, active?: boolean, isGM?: boolean}>} p.users - Foundry users.
 * @param {Object<string,string>} p.mappings - `userMappings` (Chronicle id → Foundry id).
 * @param {(foundryUserId: string) => object} p.activityFor - `PlayerActivity.get`.
 * @returns {{players: Array<object>}}
 */
export function buildPlayerReport({ users, mappings, activityFor }) {
  // Several Chronicle ids can point at one Foundry user; the lowest id wins so
  // the report is stable between runs.
  const memberByFoundry = new Map();
  for (const key of Object.keys(mappings || {}).sort()) {
    const fid = mappings[key];
    if (fid && !memberByFoundry.has(String(fid))) memberByFoundry.set(String(fid), key);
  }

  const list = (Array.isArray(users) ? users : []).filter((u) => u && u.id);
  // GMs first, so the 100 cap never drops the owner.
  const ordered = [...list.filter((u) => u.isGM), ...list.filter((u) => !u.isGM)];

  const players = ordered.slice(0, MAX_PLAYERS).map((u) => {
    const a = activityFor ? activityFor(u.id) : {};
    return {
      foundryUserId: String(u.id),
      name: cap(u.name, MAX_NAME_CHARS),
      memberId: memberByFoundry.get(String(u.id)) || '',
      online: !!u.active,
      lastChangeAt: iso(a?.lastChangeAt),
      lastFailedAt: iso(a?.lastFailedAt),
      lastFailure: cap(a?.lastFailure, MAX_FAILURE_CHARS),
      failedCount: Number(a?.failedCount) || 0,
    };
  });
  return { players };
}

/**
 * Sends the snapshot, only when it differs from the last one sent, and stops
 * for the session when Chronicle says the key may not report (403) or does
 * not know the route (404, an older Chronicle).
 */
export class PlayerReporter {
  /**
   * @param {object} p
   * @param {(body: object) => Promise<any>} p.send - POSTs the body.
   * @param {() => {players: Array<object>}} p.build - Builds the current body.
   * @param {(msg: string, err?: unknown) => void} [p.log] - Debug logger.
   */
  constructor({ send, build, log = () => {} }) {
    this._send = send;
    this._build = build;
    this._log = log;
    this._lastSent = null;
    this._stopped = false;
    this._warned400 = false;
    this._inFlight = false;
  }

  get stopped() { return this._stopped; }

  /**
   * @param {{force?: boolean}} [opts] - force sends even if nothing changed (connect).
   * @returns {Promise<'sent'|'unchanged'|'stopped'|'busy'|'failed'>}
   */
  async report({ force = false } = {}) {
    if (this._stopped) return 'stopped';
    if (this._inFlight) return 'busy';
    this._inFlight = true;
    try {
      const body = this._build();
      const print = JSON.stringify(body);
      if (!force && print === this._lastSent) return 'unchanged';
      try {
        await this._send(body);
        this._lastSent = print;
        return 'sent';
      } catch (err) {
        const status = Number(err?.status);
        if (status === 403 || status === 404) {
          this._stopped = true;
          this._log(`player report stopped for this session (HTTP ${status})`);
          return 'stopped';
        }
        if (status === 400 && !this._warned400) {
          this._warned400 = true;
          this._log('Chronicle rejected the player report (HTTP 400)');
        } else {
          this._log('player report failed', err);
        }
        return 'failed';
      }
    } catch (err) {
      this._log('player report could not be built', err);
      return 'failed';
    } finally {
      this._inFlight = false;
    }
  }
}
