/**
 * Pure builder for the Health pane's checklist: plain sentences, problems
 * first, each with at most one quiet action. No Foundry globals and no DOM,
 * so it is unit-testable headlessly. Text comes from an injected `t`; the
 * rows carry only counts, times and short messages, never request bodies or
 * keys.
 */

const PREFIX = 'CHRONICLE.Dashboard.HealthChecks.';

/** English fallback keyed like lang/en.json, for headless callers. */
export const DEFAULT_STRINGS = {
  ConnectedTitle: 'Connected to Chronicle',
  SinceAndReconnects: 'Since {since}, with {reconnects}.',
  SinceOnly: 'Since {since}.',
  ReconnectsOnly: 'With {reconnects}.',
  ReconnectsOne: '1 reconnect',
  ReconnectsMany: '{count} reconnects',
  ReconnectsNone: 'no reconnects',
  LastAnswer: 'Last answer at {time}.',
  ReconnectingTitle: 'Reconnecting to Chronicle',
  ReconnectingDetail: 'Sync carries on by itself once Chronicle answers.',
  ReconnectNow: 'Reconnect now',
  NotConnectedTitle: 'Not connected to Chronicle',
  NotConnectedDetail: 'Nothing syncs until it is back. Check the address and key in Settings.',
  Reconnect: 'Reconnect',
  WaitingOne: '1 change is waiting to be sent to Chronicle',
  WaitingMany: '{count} changes are waiting to be sent to Chronicle',
  WaitingDetail: 'They are sent again by themselves when Chronicle is reachable.',
  WaitingLast: 'The last one failed at {time}: {reason}.',
  ShowThem: 'Show them',
  ErrorsOne: '1 recent sync error',
  ErrorsMany: '{count} recent sync errors',
  ErrorsDetail: 'The latest, at {time}: {message}',
  DiceTitle: 'Dice: {text}',
  DiceFix: 'Fix: {fix}',
  CheckDice: 'Check dice files',
  SystemMatchedTitle: 'Game system matched: {name}',
  CharacterSyncOn: 'Character sync is on.',
  CharacterSyncOff: 'Character sync is off. Turn it on in Settings.',
  OpenSettings: 'Open settings',
  NoSystemTitle: 'No game system in Chronicle matches this world',
  NoSystemDetail: 'Pages, maps and the calendar still sync. Characters wait until the campaign has a system for {system}.',
  NoSystemDetailUnknown: 'Pages, maps and the calendar still sync. Characters wait until the campaign has a matching system.',
  FieldsTitle: '{synced} of {total} sheet fields come across',
  FieldsDetail: 'Checked on {actor}.',
  WhichDont: 'Which don’t?',
  WaitPage: 'A page’s changes',
  WaitNewPage: 'A new page',
  WaitPageRemoval: 'A page removal',
  WaitMap: 'A map change',
  WaitCalendar: 'A calendar change',
  WaitOther: 'A change',
  TriedOne: 'tried 1 time',
  TriedMany: 'tried {count} times',
};

const defaultT = (key, data = {}) => {
  const short = key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key;
  const s = DEFAULT_STRINGS[short] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in data ? String(data[k]) : m));
};

const ORDER = { bad: 0, warn: 1, ok: 2 };

const known = (v) => v !== null && v !== undefined && v !== '';

function connectionRow(p, tr) {
  const state = p.connectionState;
  if (state === 'connected') {
    const hasReconnects = Number.isFinite(p.reconnects);
    const reconnects = !hasReconnects ? '' : tr(
      p.reconnects === 0 ? 'ReconnectsNone' : p.reconnects === 1 ? 'ReconnectsOne' : 'ReconnectsMany',
      { count: p.reconnects },
    );
    const parts = [];
    if (known(p.since) && hasReconnects) parts.push(tr('SinceAndReconnects', { since: p.since, reconnects }));
    else if (known(p.since)) parts.push(tr('SinceOnly', { since: p.since }));
    else if (hasReconnects) parts.push(tr('ReconnectsOnly', { reconnects }));
    if (known(p.lastAnswer)) parts.push(tr('LastAnswer', { time: p.lastAnswer }));
    return { id: 'connection', level: 'ok', title: tr('ConnectedTitle'), detail: parts.join(' ') };
  }
  if (state === 'connecting' || state === 'reconnecting') {
    return {
      id: 'connection', level: 'warn', title: tr('ReconnectingTitle'), detail: tr('ReconnectingDetail'),
      action: { kind: 'reconnect', label: tr('ReconnectNow') },
    };
  }
  return {
    id: 'connection', level: 'bad', title: tr('NotConnectedTitle'), detail: tr('NotConnectedDetail'),
    action: { kind: 'reconnect', label: tr('Reconnect') },
  };
}

function waitingRow(p, tr) {
  const n = Number(p.waiting) || 0;
  if (n <= 0) return null;
  const last = p.newestError;
  const tail = last && known(last.time) && known(last.message)
    ? ` ${tr('WaitingLast', { time: last.time, reason: String(last.message).trim().replace(/\.+$/, '') })}`
    : '';
  return {
    id: 'waiting', level: 'warn',
    title: n === 1 ? tr('WaitingOne') : tr('WaitingMany', { count: n }),
    detail: `${tr('WaitingDetail')}${tail}`,
    action: { kind: 'toggle-waiting', label: tr('ShowThem') },
  };
}

function errorsRow(p, tr) {
  const n = Number(p.errorCount) || 0;
  if (n <= 0 || (Number(p.waiting) || 0) > 0) return null;
  const last = p.newestError;
  const detail = last && known(last.time) && known(last.message)
    ? tr('ErrorsDetail', { time: last.time, message: last.message })
    : '';
  return {
    id: 'errors', level: 'warn',
    title: n === 1 ? tr('ErrorsOne') : tr('ErrorsMany', { count: n }),
    detail,
    action: { kind: 'open-drawer', label: tr('ShowThem') },
  };
}

function diceRows(p, tr) {
  const dice = p.dice;
  if (!dice || dice.state === 'off') return [];
  const rows = [];
  const bad = (Array.isArray(dice.rows) ? dice.rows : []).filter((r) => r && (r.level === 'warn' || r.level === 'error'));
  bad.forEach((r, i) => {
    rows.push({
      id: `dice-${i}`,
      level: r.level === 'error' ? 'bad' : 'warn',
      title: tr('DiceTitle', { text: r.text }),
      detail: r.fix ? tr('DiceFix', { fix: r.fix }) : '',
      action: { kind: 'check-dice', label: tr('CheckDice') },
    });
  });
  if (!rows.length && dice.state === 'ok') {
    rows.push({ id: 'dice-ok', level: 'ok', title: dice.stateLabel ?? '', detail: '' });
  }
  return rows;
}

function systemRow(p, tr) {
  if (p.systemMatched) {
    const on = p.syncCharacters !== false;
    return {
      id: 'system', level: 'ok',
      title: tr('SystemMatchedTitle', { name: p.matchedSystem ?? '' }),
      detail: tr(on ? 'CharacterSyncOn' : 'CharacterSyncOff'),
      ...(on ? {} : { action: { kind: 'open-settings', label: tr('OpenSettings') } }),
    };
  }
  return {
    id: 'system', level: 'warn', title: tr('NoSystemTitle'),
    detail: known(p.foundrySystem) ? tr('NoSystemDetail', { system: p.foundrySystem }) : tr('NoSystemDetailUnknown'),
  };
}

function fieldsRow(p, tr) {
  const cap = p.capability;
  if (!cap || !cap.available || !cap.summary) return null;
  const synced = Number(cap.summary.synced);
  const total = Number(cap.summary.totalDeclared);
  if (!Number.isFinite(synced) || !Number.isFinite(total)) return null;
  const actor = cap.source?.actorName;
  const gap = synced < total;
  return {
    id: 'fields', level: gap ? 'warn' : 'ok',
    title: tr('FieldsTitle', { synced, total }),
    detail: known(actor) ? tr('FieldsDetail', { actor }) : '',
    ...(gap ? { action: { kind: 'open-drawer', label: tr('WhichDont') } } : {}),
  };
}

/**
 * The checklist rows, problems first (bad, then warn, then ok), keeping the
 * natural order within a level.
 * @param {object} p
 * @param {string} p.connectionState connected, connecting, reconnecting or other
 * @param {string} [p.since] when the current connection began, already formatted
 * @param {number} [p.reconnects]
 * @param {string} [p.lastAnswer] time of the last good answer, already formatted
 * @param {number} [p.waiting] changes in the retry queue
 * @param {number} [p.errorCount] entries in the error log
 * @param {{time: string, message: string}|null} [p.newestError]
 * @param {{state: string, stateLabel: string, rows: object[]}|null} [p.dice]
 * @param {boolean} [p.systemMatched]
 * @param {string} [p.matchedSystem]
 * @param {string} [p.foundrySystem]
 * @param {boolean} [p.syncCharacters]
 * @param {object|null} [p.capability] the dashboard's capability data
 * @param {Function} [p.t] (key, data) => string
 * @returns {{id: string, level: 'bad'|'warn'|'ok', title: string, detail: string,
 *   action?: {kind: string, label: string}}[]}
 */
export function buildHealthChecks(p = {}) {
  const t = p.t ?? defaultT;
  const tr = (k, d) => t(PREFIX + k, d);
  const rows = [
    connectionRow(p, tr),
    waitingRow(p, tr),
    errorsRow(p, tr),
    ...diceRows(p, tr),
    systemRow(p, tr),
    fieldsRow(p, tr),
  ].filter(Boolean);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ORDER[a.r.level] - ORDER[b.r.level] || a.i - b.i)
    .map(({ r }) => r);
}

/**
 * One waiting change in plain words. Only the method and path are read;
 * the body (which can hold page text) never reaches this function.
 * @param {{method?: string, path?: string, retries?: number}} item
 * @param {Function} [t]
 * @returns {{text: string, tried: string}}
 */
export function describeWaiting(item = {}, t = defaultT) {
  const tr = (k, d) => t(PREFIX + k, d);
  const method = String(item.method ?? '').toUpperCase();
  const path = String(item.path ?? '').split('?')[0];
  let key = 'WaitOther';
  if (/^\/entities(\/|$)/.test(path)) {
    if (method === 'DELETE') key = 'WaitPageRemoval';
    else if (method === 'POST' && path.replace(/\/+$/, '') === '/entities') key = 'WaitNewPage';
    else key = 'WaitPage';
  } else if (/^\/maps(\/|$)/.test(path)) key = 'WaitMap';
  else if (/^\/calendar(\/|$)/.test(path)) key = 'WaitCalendar';
  const retries = Number(item.retries) || 0;
  const tried = retries <= 0 ? '' : retries === 1 ? tr('TriedOne') : tr('TriedMany', { count: retries });
  return { text: tr(key), tried };
}
