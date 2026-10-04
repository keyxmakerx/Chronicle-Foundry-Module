/**
 * Chronicle Sync - Built-in calendar
 *
 * Chronicle's own calendar inside Foundry: a thin strip with the date, time
 * and weather over a tiny live sky, which anyone can drag anywhere or shrink
 * to a round clock (the spot is kept per person). Clicking the date opens the
 * month, where each day up to today shows its sky and weather. The GM's strip
 * has small arrows that step an hour, and the month has Set date and Add
 * event; all of it writes to Chronicle through CalendarSync. Players draw
 * from the `calendarSnapshot` world setting the GM's client publishes
 * (players hold no key). Events stay Chronicle's own: nothing here creates a
 * Foundry document.
 */

import { getSetting, setSetting } from './settings.mjs';
import { promptDialog } from './_dialogs.mjs';
import {
  clampPlace, daySky, eventsOn, formatDate, formatTemperature, formatTime, isUsableSnapshot,
  monthGrid, monthName, moonIconClass, shiftMonth, skyGradient, skyParticles, weatherIconClass,
} from './_calendar-view-model.mjs';

const t = (key, data) => (data
  ? game.i18n.format(`CHRONICLE.CalendarBar.${key}`, data)
  : game.i18n.localize(`CHRONICLE.CalendarBar.${key}`));

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Time without a pointer or key before the mini sky comes to rest. */
const REST_AFTER_MS = 20000;

/** @type {import('./calendar-sync.mjs').CalendarSync|null} the GM's live source. */
let source = null;
/** @type {HTMLElement|null} */
let wid = null;
/** @type {HTMLElement|null} */
let popover = null;
/** Month the open month view shows. */
let shown = null;
/** GM: events and day weather fetched for months outside the nearby window, keyed "y-m". */
const extraMonths = new Map();

/**
 * What to draw: the GM's live view, or the players' snapshot. Null hides
 * the calendar (sync off, no calendar, or one players may not see).
 */
function currentView() {
  if (!getSetting('syncEnabled') || !getSetting('syncCalendar')) return null;
  if (game.user.isGM && source) {
    const v = source.gmView;
    if (v.calendar && v.date) {
      const info = v.dateInfo || {};
      const w = info.current_weather;
      return {
        gm: true,
        calendar: v.calendar,
        date: v.date,
        season: info.current_season || null,
        weather: w ? { label: w.preset_label || w.description, icon: w.icon, temperature_celsius: w.temperature_celsius } : null,
        moons: (info.current_moon_phases || []).map((m) => ({ name: m.moon_name, phase_name: m.phase_name, phase_icon: m.phase_icon })),
        events: v.events,
        dayWeather: v.dayWeather,
        readOnly: !!(info.tracks_real_time ?? v.calendar.tracks_real_time),
      };
    }
    // Not connected: fall back to the players' snapshot, without controls.
  }
  const snap = getSetting('calendarSnapshot');
  if (!isUsableSnapshot(snap)) return null;
  return { gm: false, ...snap, dayWeather: snap.dayWeather || [], readOnly: true };
}

function particlesHtml(kind) {
  if (kind === 'none') return '';
  const n = kind === 'stars' ? 14 : 16;
  let h = '';
  for (let i = 0; i < n; i++) {
    const left = (i * (kind === 'stars' ? 7 : 13) + 3) % 98;
    if (kind === 'stars') h += `<span class="ccal-star" style="left:${left}%;top:${(i * 37) % 90}%;animation-delay:${(i % 5) * 0.6}s"></span>`;
    else h += `<span class="ccal-${kind}" style="left:${left}%;animation-delay:${(i % 8) * 0.33}s"></span>`;
  }
  return h;
}

function moreText(v) {
  const unit = getSetting('calendarTemperatureUnit') || 'C';
  const parts = [];
  if (v.season?.name) parts.push(esc(v.season.name));
  const temp = formatTemperature(v.weather?.temperature_celsius, unit);
  if (temp) parts.push(esc(temp));
  for (const m of (v.moons || []).slice(0, 3)) {
    parts.push(`${esc(m.name || '')} ${esc(m.phase_name || '')} <i class="${moonIconClass(m.phase_icon)}" aria-hidden="true"></i>`);
  }
  return parts.join(' · ');
}

function stripHtml(v) {
  const arrow = (dir) => (v.gm
    ? `<button type="button" class="ccal-step" data-dir="${dir}" ${v.readOnly ? 'disabled' : ''} title="${esc(v.readOnly ? t('RealTime') : t(dir < 0 ? 'BackHour' : 'ForwardHour'))}" aria-label="${esc(t(dir < 0 ? 'BackHour' : 'ForwardHour'))}">${dir < 0 ? '&#8249;' : '&#8250;'}</button>`
    : '');
  const weather = v.weather
    ? `<i class="fa-solid ${weatherIconClass(v.weather.icon)} ccal-wx" title="${esc(v.weather.label || '')}" aria-label="${esc(v.weather.label || '')}"></i>` : '';
  const more = moreText(v);
  return `<div class="ccal-sky"></div>
    <span class="ccal-grip" title="${esc(t('Drag'))}" aria-hidden="true">&#8942;&#8942;</span>
    ${arrow(-1)}
    <button type="button" class="ccal-open" aria-haspopup="dialog" aria-expanded="${popover ? 'true' : 'false'}" title="${esc(t('OpenMonth'))}">
      <b>${esc(formatDate(v.calendar, v.date))}</b> <span class="ccal-time">${esc(formatTime(v.calendar, v.date))}</span>
    </button>
    ${weather}${more ? `<span class="ccal-more">${more}</span>` : ''}
    ${arrow(1)}
    <button type="button" class="ccal-shrink" title="${esc(t('Shrink'))}" aria-label="${esc(t('Shrink'))}"><i class="fa-regular fa-clock"></i></button>`;
}

function dotHtml(v) {
  const label = t('Clock', { date: formatDate(v.calendar, v.date), time: formatTime(v.calendar, v.date) });
  return `<button type="button" class="ccal-dot" title="${esc(label)}" aria-label="${esc(label)}"><span class="ccal-sky"></span><i class="fa-regular fa-clock"></i></button>`;
}

/** The person's saved spot and size; per client so each player keeps their own. */
function savedPlace() {
  const p = getSetting('calendarBarPlace');
  return p && typeof p === 'object' ? p : {};
}

function applyPlace() {
  if (!wid) return;
  const p = savedPlace();
  const box = wid.getBoundingClientRect();
  const fallback = { x: (window.innerWidth - box.width) / 2, y: 8 };
  const at = clampPlace(Number.isFinite(p.x) ? p : fallback, box, { width: window.innerWidth, height: window.innerHeight });
  wid.style.left = `${at.x}px`;
  wid.style.top = `${at.y}px`;
}

function savePlace(patch) {
  setSetting('calendarBarPlace', { ...savedPlace(), ...patch }).catch((err) => {
    console.debug('Chronicle: saving the calendar spot failed', err?.message);
  });
}

/** Draw (or remove) the calendar for the current view. */
export function renderCalendarBar() {
  const v = currentView();
  if (!v) {
    wid?.remove(); wid = null; closeMonth();
    return;
  }
  if (!wid) {
    wid = document.createElement('div');
    wid.id = 'chronicle-calendar-bar';
    wid.setAttribute('role', 'group');
    wid.setAttribute('aria-label', t('Label'));
    document.body.appendChild(wid);
    wid.addEventListener('click', onClick);
    wid.addEventListener('pointerdown', onDragStart);
  }
  const mini = !!savedPlace().mini;
  wid.classList.toggle('ccal-mini', mini);
  wid.classList.toggle('ccal-gm', v.gm);
  wid.style.setProperty('--ccal-sky', skyGradient(v.calendar, v.date.hour));
  wid.innerHTML = mini ? dotHtml(v) : stripHtml(v);
  const sky = wid.querySelector('.ccal-sky');
  if (sky) sky.innerHTML = particlesHtml(skyParticles(v.calendar, v.date.hour, v.weather?.icon));
  applyPlace();
  if (popover) { renderMonth(); placeMonth(); }
}

let drag = null;

function onDragStart(ev) {
  if (!ev.target.closest('.ccal-grip, .ccal-dot') || ev.button !== 0) return;
  const box = wid.getBoundingClientRect();
  drag = { dx: ev.clientX - box.left, dy: ev.clientY - box.top, x0: ev.clientX, y0: ev.clientY, moved: false };
  wid.setPointerCapture(ev.pointerId);
  wid.addEventListener('pointermove', onDragMove);
  wid.addEventListener('pointerup', onDragEnd, { once: true });
  wid.addEventListener('pointercancel', onDragEnd, { once: true });
}

function onDragMove(ev) {
  if (!drag) return;
  // A few pixels of wobble is still a click, not a drag.
  if (!drag.moved && Math.abs(ev.clientX - drag.x0) + Math.abs(ev.clientY - drag.y0) < 4) return;
  drag.moved = true;
  const at = clampPlace({ x: ev.clientX - drag.dx, y: ev.clientY - drag.dy }, wid.getBoundingClientRect(),
    { width: window.innerWidth, height: window.innerHeight });
  wid.style.left = `${at.x}px`;
  wid.style.top = `${at.y}px`;
  if (popover) placeMonth();
}

function onDragEnd() {
  wid?.removeEventListener('pointermove', onDragMove);
  if (drag?.moved) {
    savePlace({ x: wid.offsetLeft, y: wid.offsetTop });
    // The click that ends a drag must not also open or restore anything.
    wid.addEventListener('click', (e) => e.stopPropagation(), { once: true, capture: true });
  }
  drag = null;
}

async function onClick(ev) {
  const stepBtn = ev.target.closest('.ccal-step');
  if (stepBtn && source) {
    stepBtn.disabled = true;
    const ok = await source.step('hour', Number(stepBtn.dataset.dir));
    if (!ok) ui.notifications.warn(t('StepRefused'));
    renderCalendarBar();
    return;
  }
  if (ev.target.closest('.ccal-shrink')) {
    closeMonth();
    savePlace({ mini: true });
    return;
  }
  if (ev.target.closest('.ccal-dot')) {
    // One click on the clock brings the strip back with the month open.
    savePlace({ mini: false });
    setTimeout(openMonth, 0);
    return;
  }
  if (ev.target.closest('.ccal-open')) {
    if (popover) closeMonth(); else openMonth();
  }
}

function placeMonth() {
  if (!popover || !wid) return;
  const box = wid.getBoundingClientRect();
  const w = popover.offsetWidth || 300;
  const h = popover.offsetHeight || 260;
  const below = box.bottom + 6 + h <= window.innerHeight;
  popover.style.left = `${Math.max(4, Math.min(box.left, window.innerWidth - w - 4))}px`;
  popover.style.top = `${below ? box.bottom + 6 : Math.max(4, box.top - h - 6)}px`;
}

function openMonth() {
  const v = currentView();
  if (!v || popover) return;
  shown = { y: v.date.year, m: v.date.month };
  popover = document.createElement('div');
  popover.id = 'chronicle-calendar-month';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', t('MonthLabel'));
  document.body.appendChild(popover);
  popover.addEventListener('click', onMonthClick);
  renderMonth();
  placeMonth();
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  wid?.querySelector('.ccal-open')?.setAttribute('aria-expanded', 'true');
}

function closeMonth() {
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  popover?.remove();
  popover = null;
  wid?.querySelector('.ccal-open')?.setAttribute('aria-expanded', 'false');
}

// Nothing in the month view is ever unsaved, so a click outside just closes it.
function onOutside(ev) {
  if (popover?.contains(ev.target) || wid?.contains(ev.target)) return;
  closeMonth();
}

function onKey(ev) {
  // Not stopped: an open Set date or Add event dialog still gets its Escape.
  if (ev.key === 'Escape' && popover) closeMonth();
}

function monthData(v, y, m) {
  const key = `${y}-${m}`;
  if (v.gm && extraMonths.has(key)) return extraMonths.get(key);
  const inMonth = (x) => x.year === y && x.month === m;
  return { events: (v.events || []).filter(inMonth), days: (v.dayWeather || []).filter(inMonth) };
}

/** GM: load a month outside the nearby window once, then redraw. */
async function ensureMonth(v, y, m) {
  if (!v.gm || !source?._api) return;
  const key = `${y}-${m}`;
  const near = (v.events || []).some((e) => e.year === y && e.month === m)
    || (v.dayWeather || []).some((d) => d.year === y && d.month === m);
  if (extraMonths.has(key) || near) return;
  extraMonths.set(key, { events: [], days: [] });
  try {
    const unwrap = (p) => (Array.isArray(p) ? p : (p?.data || []));
    const [events, days] = await Promise.all([
      source._api.get(`/calendar/events?year=${y}&month=${m}`),
      source._api.get(`/calendar/weather/days?year=${y}&month=${m}`).catch(() => []),
    ]);
    extraMonths.set(key, { events: unwrap(events), days: unwrap(days) });
    renderMonth();
  } catch (err) {
    // Forget the month so reopening it tries again.
    extraMonths.delete(key);
    console.debug('Chronicle: month read failed', err?.message);
  }
}

function isPast(v, y, m, d) {
  const n = v.date;
  return y < n.year || (y === n.year && (m < n.month || (m === n.month && d <= n.day)));
}

function renderMonth() {
  const v = currentView();
  if (!popover || !v || !shown) { closeMonth(); return; }
  const g = monthGrid(v.calendar, shown.y, shown.m);
  const { events, days } = monthData(v, shown.y, shown.m);
  ensureMonth(v, shown.y, shown.m);
  const wxByDay = new Map(days.map((d) => [d.day, d]));
  const cell = (d) => {
    if (!d) return '<div class="ccal-pad"></div>';
    const list = eventsOn(events, shown.y, shown.m, d);
    const wx = isPast(v, shown.y, shown.m, d) ? wxByDay.get(d) : null;
    const today = shown.y === v.date.year && shown.m === v.date.month && d === v.date.day;
    const cls = [today ? 'ccal-today' : '', wx ? 'ccal-wxday' : '',
      list.length ? (list.every((e) => e.visibility === 'gm-only') ? 'ccal-gmev' : 'ccal-ev') : ''].filter(Boolean).join(' ');
    const style = wx ? ` style="background:${daySky(wx.icon)}"` : '';
    const title = [wx?.label, ...list.map((e) => e.name)].filter(Boolean).join(' · ');
    return `<div class="${cls}"${style}${title ? ` title="${esc(title)}"` : ''}>${d}${wx ? `<i class="fa-solid ${weatherIconClass(wx.icon)}" aria-hidden="true"></i>` : ''}</div>`;
  };
  const head = g.headers.length ? `<div class="ccal-head">${g.headers.map((h) => `<span>${esc(h)}</span>`).join('')}</div>` : '';
  const cols = g.festival ? Math.max(1, Math.min(g.rows[0].length, 7)) : g.headers.length;
  const body = `<div class="ccal-grid" style="grid-template-columns:repeat(${cols},1fr)">${g.rows.flat().map(cell).join('')}</div>`;
  const listed = [...events].sort((a, b) => (a.day - b.day)).slice(0, 8).map((e) =>
    `<div${e.visibility === 'gm-only' ? ' class="ccal-gmline"' : ''}><b>${Number(e.day) || ''}</b> ${esc(e.name)}${e.visibility === 'gm-only' ? ` (${esc(t('GmOnly'))})` : ''}</div>`).join('');
  const gmTools = v.gm
    ? `<div class="ccal-tools"><button type="button" data-act="set" ${v.readOnly ? 'disabled' : ''}>${esc(t('SetDate'))}&hellip;</button>
       <button type="button" data-act="add">${esc(t('AddEvent'))}</button></div>`
    : '';
  popover.innerHTML = `<header>
      <button type="button" data-act="prev" aria-label="${esc(t('PrevMonth'))}">&#8249;</button>
      <span>${esc(monthName(v.calendar, shown.m))} ${shown.y}</span>
      <button type="button" data-act="next" aria-label="${esc(t('NextMonth'))}">&#8250;</button>
    </header>${head}${body}
    ${listed || gmTools ? `<footer>${listed}${gmTools}</footer>` : ''}`;
}

async function onMonthClick(ev) {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const v = currentView();
  if (!v) return;
  const act = btn.dataset.act;
  if (act === 'prev' || act === 'next') {
    shown = shiftMonth(v.calendar, shown.y, shown.m, act === 'prev' ? -1 : 1);
    renderMonth();
    placeMonth();
  } else if (act === 'set' && source) {
    await setDateDialog(v);
  } else if (act === 'add' && source) {
    await addEventDialog(v);
  }
}

function dateFields(v, d) {
  const months = v.calendar.months.map((m, i) =>
    `<option value="${i + 1}" ${i + 1 === d.month ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  return `<div class="form-group"><label>${esc(t('Day'))}</label><div class="form-fields">
      <input type="number" name="day" min="1" value="${d.day}" required>
      <select name="month">${months}</select>
      <input type="number" name="year" value="${d.year}" required></div></div>
    <div class="form-group"><label>${esc(t('Time'))}</label><div class="form-fields">
      <input type="number" name="hour" min="0" value="${d.hour ?? ''}" placeholder="${esc(t('AllDay'))}"> :
      <input type="number" name="minute" min="0" value="${d.minute ?? ''}"></div></div>`;
}

function readDate(root) {
  const f = root?.querySelector('form') ?? root;
  const val = (n) => f?.querySelector(`[name="${n}"]`)?.value;
  const opt = (n) => (val(n) === '' || val(n) === undefined ? null : Number(val(n)));
  return {
    year: Number(val('year')), month: Number(val('month')), day: Number(val('day')),
    hour: opt('hour'), minute: opt('minute'),
    name: val('name') || '', gmOnly: !!f?.querySelector('[name="gmOnly"]')?.checked,
  };
}

async function setDateDialog(v) {
  const res = await promptDialog({
    title: t('SetDate'),
    content: `<form class="ccal-form">${dateFields(v, v.date)}</form>`,
    label: t('SetDate'),
    callback: readDate,
  });
  if (!res) return;
  const ok = await source.setDate({ ...res, hour: res.hour ?? 0, minute: res.minute ?? 0 });
  if (!ok) ui.notifications.warn(t('SetRefused'));
}

async function addEventDialog(v) {
  const day = shown && !(shown.y === v.date.year && shown.m === v.date.month)
    ? { year: shown.y, month: shown.m, day: 1 } : { ...v.date, hour: null, minute: null };
  const res = await promptDialog({
    title: t('AddEvent'),
    content: `<form class="ccal-form">
      <div class="form-group"><label>${esc(t('EventName'))}</label><div class="form-fields"><input type="text" name="name" maxlength="200" required autofocus></div></div>
      ${dateFields(v, day)}
      <div class="form-group"><label>${esc(t('GmOnly'))}</label><div class="form-fields"><input type="checkbox" name="gmOnly"></div></div>
    </form>`,
    label: t('AddEvent'),
    callback: readDate,
  });
  if (!res) return;
  if (!res.name.trim()) { ui.notifications.warn(t('NameNeeded')); return; }
  const ok = await source.addEvent({ ...res, hour: Number.isFinite(res.hour) ? res.hour : undefined });
  if (ok) ui.notifications.info(t('EventAdded', { name: res.name.trim() }));
  else ui.notifications.warn(t('AddRefused'));
}

/**
 * Like every looping animation in Chronicle, the mini sky slows to still
 * when the person steps away and starts again when they come back.
 */
function registerRest() {
  let timer = null;
  const rest = () => document.body.classList.add('ccal-rest');
  const wake = () => {
    document.body.classList.remove('ccal-rest');
    clearTimeout(timer);
    timer = setTimeout(rest, REST_AFTER_MS);
  };
  for (const ev of ['pointermove', 'keydown', 'wheel']) document.addEventListener(ev, wake, { passive: true });
  document.addEventListener('visibilitychange', () => (document.hidden ? rest() : wake()));
  wake();
}

/**
 * Mount the built-in calendar. Every user calls this; the GM passes the live
 * CalendarSync, players draw from the shared snapshot.
 * @param {import('./calendar-sync.mjs').CalendarSync|null} calendarSync
 */
export function registerCalendarBar(calendarSync) {
  source = game.user.isGM ? calendarSync : null;
  source?.onChange(() => { extraMonths.clear(); renderCalendarBar(); });
  Hooks.on('chronicleSyncCalendarSnapshot', () => renderCalendarBar());
  window.addEventListener('resize', () => applyPlace());
  registerRest();
  renderCalendarBar();
}
