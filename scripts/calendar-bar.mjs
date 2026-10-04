/**
 * Chronicle Sync - Built-in calendar
 *
 * Chronicle's own calendar inside Foundry: a date bar at the top centre of
 * the screen (date, time, season, weather, moons, tinted by the hour) and a
 * month view that opens from it. The GM's bar has the step arrows, Set date
 * and Add event, all writing to Chronicle through CalendarSync; players see
 * the same bar without controls, drawn from the `calendarSnapshot` world
 * setting the GM's client publishes (players hold no key). Events stay
 * Chronicle's own: nothing here creates a Foundry document.
 */

import { getSetting } from './settings.mjs';
import { promptDialog } from './_dialogs.mjs';
import {
  STEP_UNITS, eventsOn, formatDate, formatTemperature, formatTime, isUsableSnapshot,
  monthGrid, monthName, moonIconClass, safeColor, shiftMonth, skyGradient, weatherIconClass, weekdayName,
} from './_calendar-view-model.mjs';

const t = (key, data) => (data
  ? game.i18n.format(`CHRONICLE.CalendarBar.${key}`, data)
  : game.i18n.localize(`CHRONICLE.CalendarBar.${key}`));

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** @type {import('./calendar-sync.mjs').CalendarSync|null} the GM's live source. */
let source = null;
/** @type {HTMLElement|null} */
let bar = null;
/** @type {HTMLElement|null} */
let popover = null;
/** Month the open month view shows. */
let shown = null;
/** GM: events fetched for months outside the nearby window, keyed "y-m". */
const extraMonths = new Map();
let step = 'hour';

/**
 * What to draw: the GM's live view, or the players' snapshot. Null hides
 * the bar (sync off, no calendar, or one players may not see).
 */
function currentView() {
  if (!getSetting('syncEnabled') || !getSetting('syncCalendar')) return null;
  if (game.user.isGM && source) {
    const v = source.gmView;
    if (v.calendar && v.date) {
      const info = v.dateInfo || {};
      return {
        gm: true,
        calendar: v.calendar,
        date: v.date,
        season: info.current_season || null,
        weather: info.current_weather
          ? { label: info.current_weather.preset_label || info.current_weather.description, icon: info.current_weather.icon,
            color: safeColor(info.current_weather.color), temperature_celsius: info.current_weather.temperature_celsius }
          : null,
        moons: (info.current_moon_phases || []).map((m) => ({ name: m.moon_name, phase_name: m.phase_name, phase_icon: m.phase_icon })),
        events: v.events,
        readOnly: !!(info.tracks_real_time ?? v.calendar.tracks_real_time),
      };
    }
    // Not connected: fall back to the players' snapshot, without controls.
  }
  const snap = getSetting('calendarSnapshot');
  if (!isUsableSnapshot(snap)) return null;
  return { gm: false, ...snap, readOnly: true };
}

function barHtml(v) {
  const unit = getSetting('calendarTemperatureUnit') || 'C';
  const wd = weekdayName(v.calendar, v.date);
  const season = v.season?.name
    ? `<span class="ccal-chip" style="--ccal-chip:${safeColor(v.season.color) || 'rgba(255,255,255,.25)'}">${esc(v.season.name)}</span>` : '';
  const weather = v.weather
    ? `<span class="ccal-weather" title="${esc(v.weather.label || '')}"><i class="fa-solid ${weatherIconClass(v.weather.icon)}"${v.weather.color ? ` style="color:${v.weather.color}"` : ''} aria-hidden="true"></i> ${esc(formatTemperature(v.weather.temperature_celsius, unit))}</span>` : '';
  const moons = (v.moons || []).slice(0, 3).map((m) =>
    `<i class="ccal-moon ${moonIconClass(m.phase_icon)}" title="${esc(`${m.name || ''}: ${m.phase_name || ''}`)}" aria-label="${esc(`${m.name || ''}: ${m.phase_name || ''}`)}"></i>`).join('');
  const arrows = (dir) => (v.gm
    ? `<button type="button" class="ccal-step" data-dir="${dir}" ${v.readOnly ? 'disabled' : ''} title="${esc(v.readOnly ? t('RealTime') : t(dir < 0 ? 'Back' : 'Forward', { step: t(`Step.${step}`) }))}" aria-label="${esc(t(dir < 0 ? 'Back' : 'Forward', { step: t(`Step.${step}`) }))}"><i class="fa-solid fa-chevron-${dir < 0 ? 'left' : 'right'}"></i></button>`
    : '');
  const select = v.gm && !v.readOnly
    ? `<select class="ccal-unit" aria-label="${esc(t('StepLabel'))}">${STEP_UNITS.map((u) => `<option value="${u}" ${u === step ? 'selected' : ''}>${esc(t(`Step.${u}`))}</option>`).join('')}</select>`
    : '';
  return `${arrows(-1)}
    <button type="button" class="ccal-face" aria-haspopup="dialog" aria-expanded="${popover ? 'true' : 'false'}" title="${esc(t('OpenMonth'))}">
      <span class="ccal-date">${wd ? `${esc(wd)}, ` : ''}${esc(formatDate(v.calendar, v.date))}</span>
      <span class="ccal-time">${esc(formatTime(v.calendar, v.date))}</span>
      ${season}${weather}${moons ? `<span class="ccal-moons">${moons}</span>` : ''}
    </button>
    ${arrows(1)}${select}`;
}

/** Draw (or remove) the bar for the current view. */
export function renderCalendarBar() {
  const v = currentView();
  if (!v) {
    bar?.remove(); bar = null; closeMonth();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'chronicle-calendar-bar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', t('Label'));
    document.body.appendChild(bar);
    bar.addEventListener('click', onBarClick);
    bar.addEventListener('change', (ev) => {
      if (ev.target.matches('.ccal-unit')) { step = ev.target.value; renderCalendarBar(); }
    });
  }
  bar.style.setProperty('--ccal-sky', skyGradient(v.calendar, v.date.hour));
  bar.classList.toggle('ccal-gm', v.gm);
  bar.innerHTML = barHtml(v);
  if (popover) renderMonth();
}

async function onBarClick(ev) {
  const stepBtn = ev.target.closest('.ccal-step');
  if (stepBtn && source) {
    stepBtn.disabled = true;
    const ok = await source.step(step, Number(stepBtn.dataset.dir));
    if (!ok) ui.notifications.warn(t('StepRefused'));
    renderCalendarBar();
    return;
  }
  if (ev.target.closest('.ccal-face')) {
    if (popover) closeMonth(); else openMonth();
  }
}

function openMonth() {
  const v = currentView();
  if (!v) return;
  shown = { y: v.date.year, m: v.date.month };
  popover = document.createElement('div');
  popover.id = 'chronicle-calendar-month';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', t('MonthLabel'));
  document.body.appendChild(popover);
  popover.addEventListener('click', onMonthClick);
  renderMonth();
  requestAnimationFrame(() => popover?.classList.add('open'));
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  document.addEventListener('keydown', onKey, true);
  bar?.querySelector('.ccal-face')?.setAttribute('aria-expanded', 'true');
}

function closeMonth() {
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  popover?.remove();
  popover = null;
  bar?.querySelector('.ccal-face')?.setAttribute('aria-expanded', 'false');
}

// Nothing in the month view is ever unsaved, so a click outside just closes it.
function onOutside(ev) {
  if (popover?.contains(ev.target) || bar?.contains(ev.target)) return;
  closeMonth();
}

function onKey(ev) {
  // Not stopped: an open Set date or Add event dialog still gets its Escape.
  if (ev.key === 'Escape' && popover) closeMonth();
}

function monthEvents(v, y, m) {
  const key = `${y}-${m}`;
  if (v.gm && extraMonths.has(key)) return extraMonths.get(key);
  return (v.events || []).filter((e) => e.year === y && e.month === m);
}

/** GM: load a month outside the nearby window once, then redraw. */
async function ensureMonth(v, y, m) {
  if (!v.gm || !source?._api) return;
  const key = `${y}-${m}`;
  if (extraMonths.has(key) || (v.events || []).some((e) => e.year === y && e.month === m)) return;
  extraMonths.set(key, []);
  try {
    const payload = await source._api.get(`/calendar/events?year=${y}&month=${m}`);
    extraMonths.set(key, Array.isArray(payload) ? payload : (payload?.data || []));
    renderMonth();
  } catch (err) {
    // Forget the month so reopening it tries again.
    extraMonths.delete(key);
    console.debug('Chronicle: month events read failed', err?.message);
  }
}

function renderMonth() {
  const v = currentView();
  if (!popover || !v || !shown) { closeMonth(); return; }
  const g = monthGrid(v.calendar, shown.y, shown.m);
  const evs = monthEvents(v, shown.y, shown.m);
  ensureMonth(v, shown.y, shown.m);
  const isToday = (d) => shown.y === v.date.year && shown.m === v.date.month && d === v.date.day;
  const cell = (d) => {
    if (!d) return '<td class="ccal-pad"></td>';
    const list = eventsOn(evs, shown.y, shown.m, d);
    const dots = list.slice(0, 3).map((e) =>
      `<span class="ccal-ev${e.visibility === 'gm-only' ? ' ccal-ev-gm' : ''}" style="--ccal-ev:${safeColor(e.color) || 'var(--color-text-hyperlink, #6aa0ff)'}" title="${esc(e.name)}">${esc(e.name)}</span>`).join('');
    const more = list.length > 3 ? `<span class="ccal-more">${esc(t('More', { count: list.length - 3 }))}</span>` : '';
    return `<td class="${isToday(d) ? 'ccal-today' : ''}"><span class="ccal-n">${d}</span>${dots}${more}</td>`;
  };
  const head = g.headers.length ? `<thead><tr>${g.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : '';
  const body = g.rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('');
  const gmTools = v.gm
    ? `<footer><button type="button" data-act="set" ${v.readOnly ? 'disabled' : ''}><i class="fa-solid fa-calendar-day"></i> ${esc(t('SetDate'))}</button>
       <button type="button" data-act="add"><i class="fa-solid fa-plus"></i> ${esc(t('AddEvent'))}</button></footer>`
    : '';
  popover.innerHTML = `<header>
      <button type="button" data-act="prev" aria-label="${esc(t('PrevMonth'))}"><i class="fa-solid fa-chevron-left"></i></button>
      <h3>${esc(monthName(v.calendar, shown.m))} ${shown.y}</h3>
      <button type="button" data-act="next" aria-label="${esc(t('NextMonth'))}"><i class="fa-solid fa-chevron-right"></i></button>
    </header>
    <table class="ccal-grid${g.festival ? ' ccal-festival' : ''}">${head}<tbody>${body}</tbody></table>
    ${gmTools}`;
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
  } else if (act === 'set' && source) {
    await setDateDialog(v);
  } else if (act === 'add' && source) {
    await addEventDialog(v);
  }
}

function dateFields(v, d, withTime) {
  const months = v.calendar.months.map((m, i) =>
    `<option value="${i + 1}" ${i + 1 === d.month ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  const time = withTime
    ? `<div class="form-group"><label>${esc(t('Time'))}</label><div class="form-fields">
        <input type="number" name="hour" min="0" value="${d.hour ?? ''}" placeholder="${esc(t('AllDay'))}"> :
        <input type="number" name="minute" min="0" value="${d.minute ?? ''}"></div></div>`
    : '';
  return `<div class="form-group"><label>${esc(t('Day'))}</label><div class="form-fields">
      <input type="number" name="day" min="1" value="${d.day}" required>
      <select name="month">${months}</select>
      <input type="number" name="year" value="${d.year}" required></div></div>${time}`;
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
    content: `<form class="ccal-form">${dateFields(v, v.date, true)}</form>`,
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
      ${dateFields(v, day, true)}
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
 * Mount the built-in calendar. Every user calls this; the GM passes the live
 * CalendarSync, players draw from the shared snapshot.
 * @param {import('./calendar-sync.mjs').CalendarSync|null} calendarSync
 */
export function registerCalendarBar(calendarSync) {
  source = game.user.isGM ? calendarSync : null;
  source?.onChange(() => { extraMonths.clear(); renderCalendarBar(); });
  Hooks.on('chronicleSyncCalendarSnapshot', () => renderCalendarBar());
  renderCalendarBar();
}
