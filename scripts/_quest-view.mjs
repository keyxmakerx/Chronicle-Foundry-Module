/**
 * Pure view models for the Quest Board: Chronicle's board and quest answers
 * turned into what the windows draw, plus the reward split and the hand-out
 * plan. No Foundry globals, so tools/test-quest-view.mjs runs them in Node.
 *
 * Text is passed through as text; the Handlebars templates escape it.
 * Words shown to people come from `setQuestWords` (lang/en.json in Foundry);
 * the English here is only the fallback for Node.
 */

const WORDS = {
  DueToday: 'Due today', DayLeft: '{n} day left', DaysLeft: '{n} days left', DayLate: '{n} day late', DaysLate: '{n} days late',
  StatusNotStarted: 'Not started', StatusActive: 'Active', StatusDone: 'Done', StatusFailed: 'Failed',
  UntitledQuest: 'Untitled quest', UntitledPage: 'Untitled page', CategoryLabel: '{name} (category)', Category: 'Category',
  AMap: 'A map', Map: 'Map', Someone: 'Someone', NoticeHidden: 'A quest', Board: 'Board',
};
let say = (key, data) => fill(WORDS[key] ?? key, data);
function fill(text, data) {
  return data ? String(text).replace(/\{(\w+)\}/g, (m, k) => (k in data ? String(data[k]) : m)) : String(text);
}

/** Use the given lookup for every word shown; it gets the key and the values to fill in. */
export function setQuestWords(fn) {
  say = typeof fn === 'function' ? fn : (key, data) => fill(WORDS[key] ?? key, data);
}

/** A list answer, bare array or {data:[…]} envelope. */
export function unwrapList(x) {
  if (Array.isArray(x)) return x;
  if (Array.isArray(x?.data)) return x.data;
  return [];
}

/** "4 days left", "Due today", "2 days late", or '' without a due date. Chronicle's own wording. */
export function daysText(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  if (n === 0) return say('DueToday');
  if (n > 0) return say(n === 1 ? 'DayLeft' : 'DaysLeft', { n });
  return say(n === -1 ? 'DayLate' : 'DaysLate', { n: -n });
}

const STATUS = { not_started: 'StatusNotStarted', active: 'StatusActive', done: 'StatusDone', failed: 'StatusFailed' };
export const STATUSES = Object.keys(STATUS);
export function statusLabel(s) { return say(STATUS[s] || STATUS.active); }

/**
 * The places with boards, named. Categories take their plural name from
 * Chronicle's type list; one the list doesn't know keeps a plain label.
 * @param {Array<{kind:string,id:string,name?:string}>} homes
 * @param {Array<{id:number,name?:string,name_plural?:string}>} types
 * @returns {Array<{key:string,kind:string,id:string,label:string}>}
 */
export function homeOptions(homes, types) {
  const typeName = new Map(unwrapList(types).map((t) => [String(t.id), t.name_plural || t.name || '']));
  const out = [];
  for (const h of unwrapList(homes)) {
    if (!h || (h.kind !== 'category' && h.kind !== 'page') || typeof h.id !== 'string' || !h.id) continue;
    const label = h.kind === 'category'
      ? say('CategoryLabel', { name: typeName.get(h.id) || say('Category') })
      : (h.name || say('UntitledPage'));
    out.push({ key: `${h.kind}:${h.id}`, kind: h.kind, id: h.id, label });
  }
  return out;
}

/** Split a home key back into {kind, id}, or null. */
export function parseHomeKey(key) {
  const m = /^(category|page):([A-Za-z0-9_-]{1,64})$/.exec(String(key || ''));
  if (!m) return null;
  if (m[1] === 'category' && !/^\d+$/.test(m[2])) return null;
  return { kind: m[1], id: m[2] };
}

const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Position as a style string, in percentages of the cork like Chronicle's board. */
function placeStyle(it) {
  const x = num(it.x, -10, 100, 0);
  const y = num(it.y, -10, 100, 0);
  const w = num(it.w, 4, 60, 18);
  const r = num(it.r, -30, 30, 0);
  return `left:${x}%;top:${y}%;width:${w}%;--r:${r}deg`;
}

/**
 * One board, ready to draw. Strings are kept only when both ends are on the
 * board this viewer got, so a hidden end never shows where it was.
 * @param {object} board - a BoardView from Chronicle
 * @param {{isGM:boolean, apiUrl?:string}} opts
 */
export function boardModel(board, { isGM, apiUrl = '' } = {}) {
  const items = Array.isArray(board?.items) ? board.items : [];
  const pins = [];
  const ids = new Set();
  for (const it of items) {
    if (!it || typeof it.id !== 'string' || it.kind === 'string') continue;
    const base = { id: it.id, kind: it.kind, style: placeStyle(it), hidden: isGM && it.hidden === true };
    if (it.kind === 'notice') {
      const settled = it.status === 'done' || it.status === 'failed';
      pins.push({
        ...base, isNotice: true, questId: typeof it.questId === 'string' ? it.questId : '',
        kicker: it.kicker || '', title: it.title || say('UntitledQuest'), blurb: it.blurb || '', reward: it.reward || '',
        stamp: settled ? statusLabel(it.status) : '',
        days: settled ? '' : daysText(it.daysLeft),
        late: !settled && typeof it.daysLeft === 'number' && it.daysLeft < 0,
        soon: !settled && typeof it.daysLeft === 'number' && it.daysLeft >= 0 && it.daysLeft <= 2,
      });
    } else if (it.kind === 'note') {
      pins.push({ ...base, isNote: true, text: it.text || '', by: it.ownerName || '' });
    } else if (it.kind === 'page' || it.kind === 'map') {
      const name = it.concealed ? '' : (it.name || '');
      pins.push({
        ...base, isPage: true, name: name || say(it.kind === 'map' ? 'AMap' : 'Someone'),
        initial: (name.replace(/^(The|A|An) /i, '').trim()[0] || '?').toUpperCase(),
        image: imageURL(it.imageUrl, apiUrl), sub: it.kind === 'map' ? say('Map') : (it.typeName || ''),
      });
    } else {
      continue;
    }
    ids.add(it.id);
  }
  const strings = items
    .filter((it) => it?.kind === 'string' && ids.has(it.from) && ids.has(it.to))
    .map((it) => ({ from: it.from, to: it.to }));
  return { id: board?.id || '', name: board?.name || say('Board'), pins, strings, empty: pins.length === 0 };
}

/**
 * Chronicle answers with site-relative picture links; Foundry runs on another
 * origin. Only http(s) or site-relative links are kept.
 */
export function imageURL(raw, apiUrl) {
  if (typeof raw !== 'string' || !raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!raw.startsWith('/') || raw.startsWith('//')) return '';
  const base = String(apiUrl || '').replace(/\/+$/, '');
  return base ? base + raw : '';
}

/**
 * A quest sheet, from the DM view or the player view. The player view has no
 * ledger and says when steps are hidden; the DM view carries every step with
 * whether players see it.
 * @param {object} v - DMQuestView or PlayerQuestView
 * @param {{isGM:boolean}} opts
 */
export function sheetModel(v, { isGM }) {
  const notice = v?.notice || {};
  const steps = Array.isArray(v?.steps) ? v.steps : [];
  const due = v?.due && typeof v.due === 'object' ? v.due : null;
  const settled = v?.status === 'done' || v?.status === 'failed';
  const model = {
    hasNotice: !!v?.notice,
    kicker: notice.kicker || '',
    title: v?.notice ? (notice.title || say('UntitledQuest')) : say('NoticeHidden'),
    blurb: notice.blurb || '',
    body: Array.isArray(notice.body) ? notice.body.filter((p) => typeof p === 'string' && p.trim()) : [],
    postedBy: notice.postedBy || '',
    reward: notice.reward || '',
    status: statusLabel(v?.status),
    handedOut: v?.handedOut === true,
    steps: steps.map((s, i) => ({ index: i, text: s?.text || '', done: s?.done === true, shown: s?.shown === true })),
    hiddenSteps: !isGM && v?.hiddenSteps === true,
    due: due ? { label: due.label || '', left: settled ? '' : daysText(due.daysLeft), late: !settled && due.daysLeft < 0 } : null,
  };
  if (isGM) {
    model.version = Number.isInteger(v?.version) ? v.version : 0;
    model.statusValue = STATUS[v?.status] ? v.status : 'active';
    model.rewards = (Array.isArray(v?.rewards) ? v.rewards : []).map((r) => ({
      id: r?.id || '', kind: r?.kind || 'other', text: r?.text || r?.name || '',
      amount: typeof r?.amount === 'number' ? r.amount : null, itemId: r?.kind === 'item' ? (r.entityId || '') : '',
    }));
  }
  return model;
}

/** A coin share in hundredths, floored like Chronicle's split. */
export function shareHundredths(amount, n) {
  if (!n || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return 0;
  return Math.floor(Math.round(amount * 100) / n);
}

/** 4000 → "40", 4050 → "40.50". */
export function fmtShare(h) {
  return h % 100 ? (h / 100).toFixed(2) : String(h / 100);
}

/**
 * The hand-out as steps, one call each, in Chronicle's order: every coin
 * share, then every item. Keys match the web widget's, so a step already in
 * `done` is never run twice.
 * @param {object} p
 * @param {Array} p.rewards - sheetModel(...).rewards
 * @param {Array<{id:string,name:string}>} p.party
 * @param {Set<string>|Array<string>} p.coinTo - character ids sharing every coin reward
 * @param {Object<string,string>} p.itemTo - reward id → character id ('' for nobody)
 * @param {Set<string>} [p.done]
 * @param {string} p.reason
 */
export function handOutPlan({ rewards, party, coinTo, itemTo = {}, done = new Set(), reason }) {
  const byId = new Map(party.map((c) => [c.id, c]));
  const picked = party.filter((c) => (coinTo instanceof Set ? coinTo.has(c.id) : (coinTo || []).includes(c.id)));
  const steps = [];
  for (const r of rewards) {
    if (r.kind !== 'money' || r.amount == null) continue;
    const h = shareHundredths(r.amount, picked.length);
    if (!h) continue;
    for (const c of picked) {
      steps.push({ key: `pay:${r.id}:${c.id}`, kind: 'pay', characterId: c.id, amount: h / 100, reason, label: `${fmtShare(h)} to ${c.name}` });
    }
  }
  for (const r of rewards) {
    if (r.kind !== 'item' || !r.itemId) continue;
    const c = byId.get(itemTo[r.id]);
    if (!c) continue;
    steps.push({ key: `give:${r.id}:${c.id}`, kind: 'give', characterId: c.id, itemId: r.itemId, label: `${r.text} to ${c.name}` });
  }
  return steps.map((s) => ({ ...s, done: done.has(s.key) }));
}

/** The money-history line a payment carries, as Chronicle's widget words it. */
export function payReason(title) {
  return title ? `as a reward for ${title}` : 'as a quest reward';
}

/**
 * The steps list with one step changed, for a quest PUT (steps go whole).
 * Only the wire fields are sent back.
 */
export function stepsWith(rawSteps, index, field, value) {
  return (Array.isArray(rawSteps) ? rawSteps : []).map((s, i) => {
    const out = { id: s.id, text: s.text, done: s.done === true, shown: s.shown === true };
    if (i === index && (field === 'done' || field === 'shown')) out[field] = value === true;
    return out;
  });
}
