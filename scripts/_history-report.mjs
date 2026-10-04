/**
 * What this world reports to Chronicle's sync history (`POST /sync/history`).
 *
 * Chronicle records every call the module makes to it, so the module reports
 * only what Chronicle cannot see: changes it applied here, its connects, and
 * problems that never reached Chronicle. Reports are batched and kept in
 * memory until they send; the history is best effort and never blocks sync.
 * `tools/test-history-report.mjs`.
 */

/** At most this many events per report (Chronicle's limit). */
export const HISTORY_BATCH = 50;

/** Unsent events kept while Chronicle is unreachable; the oldest go first. */
export const HISTORY_QUEUE_MAX = 500;

/**
 * A change Chronicle announces within this long of this world writing the
 * same thing is this world's own write coming back, not a new change.
 */
export const ECHO_WINDOW_MS = 10_000;

// Messages that are changes worth a history row, and how they read. Token
// moves and the calendar's derived updates (moon, season, weather) are left
// out: they arrive in bursts and bury the changes people made.
const MESSAGE_ROWS = {
  'entity.created': ['page', 'page created'],
  'entity.updated': ['page', 'page updated'],
  'entity.deleted': ['page', 'page deleted'],
  'entity_type.created': ['page', 'page type created'],
  'entity_type.updated': ['page', 'page type updated'],
  'note.created': ['note', 'note created'],
  'note.updated': ['note', 'note updated'],
  'note.deleted': ['note', 'note deleted'],
  'map.created': ['map', 'map created'],
  'map.updated': ['map', 'map updated'],
  'map.deleted': ['map', 'map deleted'],
  'marker.created': ['map', 'pin added'],
  'marker.updated': ['map', 'pin updated'],
  'marker.deleted': ['map', 'pin removed'],
  'drawing.created': ['map', 'drawing added'],
  'drawing.updated': ['map', 'drawing updated'],
  'drawing.deleted': ['map', 'drawing removed'],
  'token.created': ['map', 'token added'],
  'token.deleted': ['map', 'token removed'],
  'fog.created': ['map', 'fog changed'],
  'fog.updated': ['map', 'fog changed'],
  'fog.deleted': ['map', 'fog changed'],
  'layer.created': ['map', 'layer added'],
  'layer.updated': ['map', 'layer updated'],
  'layer.deleted': ['map', 'layer removed'],
  'calendar.date.advanced': ['calendar', 'date moved'],
  'calendar.event.created': ['calendar', 'event created'],
  'calendar.event.updated': ['calendar', 'event updated'],
  'calendar.event.deleted': ['calendar', 'event deleted'],
  'stash.moved': ['stash', 'item moved'],
  'stash.money_changed': ['stash', 'money changed'],
  'stash.settled': ['stash', 'request settled'],
  'downtime.changed': ['stash', 'downtime changed'],
};

/**
 * How a Chronicle message reads in the history, or null when it isn't one.
 * @param {string} type
 * @returns {{kind: string, action: string}|null}
 */
export function describeMessage(type) {
  const row = MESSAGE_ROWS[type];
  return row ? { kind: row[0], action: row[1] } : null;
}

/** The id of what a message is about. */
export function resourceIdOf(msg) {
  const id = msg?.resourceId ?? msg?.payload?.id ?? '';
  return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
}

/** The name a message carries, if any; Chronicle names pages itself. */
export function resourceNameOf(msg) {
  const p = msg?.payload;
  const n = p?.name ?? p?.title ?? '';
  return typeof n === 'string' ? n : '';
}

/**
 * The ids in a REST path this world wrote to. Words like "entities" are
 * route names, not ids; anything with a digit is an id (Chronicle's ids are
 * UUIDs or numbers).
 * @param {string} path - e.g. `/entities/abc-123/fields`
 * @returns {string[]}
 */
export function idsInPath(path) {
  const clean = String(path || '').split('?')[0];
  return clean.split('/').filter((seg) => seg && /\d/.test(seg));
}

// Activity-log entries that become history rows. Pushes are left out:
// Chronicle already records each push it receives, with its result.
const ACTIVITY_ROWS = {
  connect: { direction: 'link', kind: 'connection', action: 'connected', ok: true },
  disconnect: { direction: 'link', kind: 'connection', action: 'disconnected', ok: true },
  pull: { direction: 'to_foundry', kind: 'sync', action: 'pulled', ok: true },
  update: { direction: 'link', kind: 'sync', action: 'sync note', ok: true },
  link: { direction: 'link', kind: 'link', action: 'linked', ok: true },
  unlink: { direction: 'link', kind: 'link', action: 'unlinked', ok: true },
  warning: { direction: 'link', kind: 'sync', action: 'warning', ok: true },
  error: { direction: 'link', kind: 'sync', action: 'problem', ok: false },
};

/**
 * The history row for an activity-log entry, or null when Chronicle already
 * has it.
 * @param {string} type - activity type ('connect', 'pull', 'error', ...)
 * @param {string} message
 * @param {number} at - epoch ms
 */
export function activityToEvent(type, message, at) {
  const row = ACTIVITY_ROWS[type];
  if (!row) return null;
  const text = String(message || '');
  return {
    at: new Date(at).toISOString(),
    direction: row.direction,
    kind: row.kind,
    name: text.slice(0, 200),
    action: row.action,
    call: `foundry ${type}`,
    status: row.ok ? (type === 'warning' ? 'warning' : 'ok') : 'failed',
    ok: row.ok,
    durationMs: 0,
    message: row.ok ? '' : text.slice(0, 500),
  };
}

/**
 * Queues history events and sends them in batches.
 *
 * `send(body)` posts one batch; a rejection whose `status` is 403 or 404
 * means this key or server can't take reports (a non-owner key, or a
 * Chronicle without the history), so reporting stops for the session
 * rather than retrying forever. Any other failure keeps the batch for the
 * next flush.
 */
export class HistoryReporter {
  /**
   * @param {object} opts
   * @param {(body: {events: object[]}) => Promise<any>} opts.send
   * @param {() => number} [opts.now]
   */
  constructor({ send, now = Date.now }) {
    this._send = send;
    this._now = now;
    this._queue = [];
    this._sending = false;
    this._recentWrites = new Map();
    /** True once Chronicle has said it won't take reports. */
    this.disabled = false;
  }

  /** Remember a write this world made, to spot its echo. */
  noteWrite(path) {
    const t = this._now();
    for (const id of idsInPath(path)) this._recentWrites.set(id, t);
    if (this._recentWrites.size > 1000) this._pruneWrites(t);
  }

  /** True when Chronicle's message is this world's own write coming back. */
  isEcho(resourceId) {
    if (!resourceId) return false;
    const t = this._recentWrites.get(String(resourceId));
    return t != null && this._now() - t <= ECHO_WINDOW_MS;
  }

  _pruneWrites(now) {
    for (const [id, t] of this._recentWrites) {
      if (now - t > ECHO_WINDOW_MS) this._recentWrites.delete(id);
    }
  }

  /** Queue one event. */
  add(event) {
    if (this.disabled || !event) return;
    this._queue.push(event);
    if (this._queue.length > HISTORY_QUEUE_MAX) {
      this._queue.splice(0, this._queue.length - HISTORY_QUEUE_MAX);
    }
  }

  /** Events waiting to send. */
  get pending() {
    return this._queue.length;
  }

  /**
   * Send everything queued, a batch at a time. Stops at the first failure
   * and keeps the rest for next time.
   * @returns {Promise<number>} events sent
   */
  async flush() {
    if (this._sending || this.disabled) return 0;
    this._sending = true;
    let sent = 0;
    try {
      while (this._queue.length && !this.disabled) {
        const batch = this._queue.slice(0, HISTORY_BATCH);
        try {
          await this._send({ events: batch });
        } catch (err) {
          if (err?.status === 403 || err?.status === 404) {
            this.disabled = true;
            this._queue = [];
          }
          break;
        }
        this._queue.splice(0, batch.length);
        sent += batch.length;
      }
    } finally {
      this._sending = false;
    }
    return sent;
  }
}
