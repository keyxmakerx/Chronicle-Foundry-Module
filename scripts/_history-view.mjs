/**
 * The History tab's rows: Chronicle's sync history (`GET /sync/history`)
 * drawn in the same Trace look as Chronicle's Manage › Sync history page.
 * Built as plain node descriptions, so it is testable without a DOM.
 * `tools/test-history-view.mjs`.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A node description: `{tag, cls, attrs, text, children}`. Rows are built
 * as these and turned into DOM by `toDom`, which only ever sets text and
 * attributes, so nothing Chronicle sends is parsed as HTML.
 */
export function h(tag, cls, attrs, children) {
  const node = { tag, cls: cls || '', attrs: attrs || {}, children: [] };
  for (const c of [].concat(children ?? [])) {
    if (c == null || c === false || c === '') continue;
    node.children.push(typeof c === 'object' ? c : { text: String(c) });
  }
  return node;
}

/** Build DOM from node descriptions. */
export function toDom(nodes, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  for (const n of [].concat(nodes)) {
    if (n.text != null && !n.tag) {
      frag.appendChild(doc.createTextNode(n.text));
      continue;
    }
    const el = doc.createElement(n.tag);
    if (n.cls) el.className = n.cls;
    for (const [k, v] of Object.entries(n.attrs)) el.setAttribute(k, String(v));
    el.appendChild(toDom(n.children, doc));
    frag.appendChild(el);
  }
  return frag;
}

/** Plain text of a node tree, for tests and accessibility checks. */
export function textOf(nodes) {
  return [].concat(nodes).map((n) => (n.tag ? textOf(n.children) : n.text)).join('');
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** "19:42:07.114" in the reader's own time zone. */
export function clock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today", "Yesterday" or "Thu 1 Oct". */
export function dayLabel(date, now = new Date()) {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return 'Today';
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
  const s = `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? s : `${s} ${date.getFullYear()}`;
}

export function directionWord(dir) {
  if (dir === 'to_foundry') return '→ Foundry';
  if (dir === 'to_chronicle') return '→ Chronicle';
  return '· link';
}

export function duration(ms) {
  const n = Number(ms) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n} ms`;
}

const STAND_INS = { page: 'A page', character: 'A page', map: 'A map', calendar: 'Calendar', note: 'A note' };

function nameOf(ev) {
  return ev.name || STAND_INS[ev.kind] || 'Sync';
}

function row(ev, child) {
  const at = new Date(ev.at);
  const dirClass = ev.direction === 'to_foundry' ? 'to-fo' : ev.direction === 'to_chronicle' ? 'to-ch' : 'sys';
  const kids = Array.isArray(ev.children) ? ev.children : [];
  const who = ev.who ? `${ev.action} · ${ev.who}` : String(ev.action ?? '');
  const classes = ['sh-row', child ? 'sh-kid' : '', ev.ok === false ? 'sh-fail' : ''].filter(Boolean).join(' ');
  const det = [];
  if (ev.who) det.push(h('dt', '', null, 'Who'), h('dd', '', null, ev.who));
  det.push(h('dt', '', null, 'Call'), h('dd', 'sh-mono', null, `${ev.call ?? ''} · ${ev.status ?? ''} · ${duration(ev.durationMs)}`));
  det.push(h('dt', '', null, 'Recorded by'), h('dd', '', null, ev.reportedBy === 'client' ? 'Foundry' : 'Chronicle'));
  return h('details', classes, { 'data-id': ev.id ?? '' }, [
    h('summary', 'sh-line', null, [
      h('time', 'sh-t sh-mono', { datetime: ev.at ?? '' }, isNaN(at) ? '' : clock(at)),
      h('span', `sh-d ${dirClass}`, null, directionWord(ev.direction)),
      h('span', 'sh-e', null, [
        kids.length ? h('span', 'sh-caret', { 'aria-hidden': 'true' }, '▸') : null,
        `${nameOf(ev)} `,
        h('span', 'sh-who', null, who),
        ev.ok === false && ev.message ? h('span', 'sh-msg', null, ev.message) : null,
      ]),
      h('span', 'sh-c sh-mono', null, [h('b', '', null, ev.status ?? ''), ` ${duration(ev.durationMs)}`]),
    ]),
    kids.length ? h('div', 'sh-steps', null, kids.map((k) => row(k, true))) : null,
    h('dl', 'sh-det', null, det),
  ]);
}

/**
 * The rows, with a day heading above each day's first row, as node
 * descriptions for `toDom`.
 * @param {object[]} events - newest first, as the server sends them
 * @param {object} [opts]
 * @param {boolean} [opts.filtered] - a search or filter is on (changes the empty text)
 * @param {Date} [opts.now]
 * @returns {object[]}
 */
export function buildHistoryRows(events, { filtered = false, now = new Date() } = {}) {
  if (!events.length) {
    return [h('p', 'sh-empty', null, filtered
      ? 'Nothing matches. Clear the search or the filters to see everything.'
      : 'Nothing has synced yet. Changes appear here as soon as they sync.')];
  }
  let last = '';
  const out = [];
  for (const ev of events) {
    const d = new Date(ev.at);
    const label = isNaN(d) ? '' : dayLabel(d, now);
    if (label && label !== last) {
      last = label;
      out.push(h('div', 'sh-day', null, label));
    }
    out.push(row(ev, false));
  }
  return out;
}

/**
 * The query string for one page of history.
 * @param {{q?: string, direction?: string, failed?: boolean}} filter
 * @param {number} [before] - page backwards from this id
 */
export function historyQuery(filter, before) {
  const p = new URLSearchParams();
  p.set('limit', '50');
  if (before) p.set('before', String(before));
  if (filter.direction) p.set('direction', filter.direction);
  if (filter.failed) p.set('failed', '1');
  if (filter.q) p.set('q', filter.q.trim().slice(0, 100));
  return `/sync/history?${p.toString()}`;
}
