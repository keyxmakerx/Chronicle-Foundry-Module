#!/usr/bin/env node
/**
 * The Sky Clock (scripts/sky-clock.mjs) draws the calendar as a globe with
 * Chronicle's own sky inside. These pin its pure decisions (_sky-clock.mjs):
 * corners and the cradle, the calendar and weather handed to the sky, what
 * falls in front of the figure and the marks each weather leaves on its
 * stone, the frame rate, and where the figure's light comes from. They also run the vendored sky code on a calendar built here,
 * and, with CHRONICLE_DIR set, check the vendored copies match Chronicle's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import * as SC from '../scripts/_sky-clock.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(REPO_ROOT, 'vendor', 'chronicle');
const SKY_FILES = ['sky_world.js', 'sky_looks.js', 'sky_moon.js', 'sky_events.js', 'sky_2d.js', 'sky_shaders.js', 'sky_gl.js', 'sky_pane.js'];
const free = { left: 50, top: 0, right: 1000, bottom: 800 };

test('corners sit inside the free screen, clear of the sidebar and tool bar', () => {
  const s = SC.cornerSpots(free, SC.GLOBE);
  assert.deepEqual(s.tl, { x: 62, y: 12 });
  assert.deepEqual(s.tr, { x: 1000 - 116 - 12, y: 12 });
  assert.deepEqual(s.br, { x: 1000 - 116 - 12, y: 800 - 116 - 12 });
  assert.deepEqual(s.bl, { x: 62, y: 800 - 116 - 12 });
});

test('a dropped globe settles in the nearest corner', () => {
  assert.equal(SC.nearestCorner({ x: 900, y: 40 }, free, SC.GLOBE), 'tr');
  assert.equal(SC.nearestCorner({ x: 100, y: 700 }, free, SC.GLOBE), 'bl');
  assert.equal(SC.nearestCorner({ x: 700, y: 500 }, free, SC.GLOBE), 'br');
  assert.equal(SC.nearestCorner({ x: 200, y: 200 }, free, SC.GLOBE), 'tl');
});

test('a saved corner is checked, and arrow keys move to the corner that way', () => {
  assert.equal(SC.cornerOf('bl'), 'bl');
  assert.equal(SC.cornerOf('middle'), 'tr');
  assert.equal(SC.cornerOf(undefined), 'tr');
  assert.equal(SC.cornerByKey('tr', 'ArrowDown'), 'br');
  assert.equal(SC.cornerByKey('br', 'ArrowLeft'), 'bl');
  assert.equal(SC.cornerByKey('bl', 'ArrowUp'), 'tl');
  assert.equal(SC.cornerByKey('tl', 'Enter'), null);
});

test('a corner moves clear of a panel across it, not one beside it', () => {
  const players = { left: 50, top: 650, right: 250, bottom: 800 };
  const hotbar = { left: 400, top: 740, right: 700, bottom: 800 };
  assert.deepEqual(SC.clearOf({ x: 62, y: 672 }, SC.GLOBE, [players, hotbar], 'bl'), { x: 62, y: 650 - 116 - 12 });
  assert.deepEqual(SC.clearOf({ x: 872, y: 672 }, SC.GLOBE, [players, hotbar], 'br'), { x: 872, y: 672 });
  const nav = { left: 0, top: 0, right: 600, bottom: 40 };
  assert.deepEqual(SC.clearOf({ x: 62, y: 12 }, SC.GLOBE, [nav], 'tl'), { x: 62, y: 52 });
});

test('the cradle holds the globe from above in a bottom corner, and makes room at the sides', () => {
  const spots = SC.cornerSpots(free, SC.GLOBE);
  const tl = SC.cradleLayout('tl', spots.tl, free);
  assert.equal(tl.up, false);
  assert.ok(tl.nudge > 0, 'moves right, away from the left edge');
  assert.equal(spots.tl.x + tl.nudge - SC.CRADLE_SPARE, free.left + 6);
  const br = SC.cradleLayout('br', spots.br, free);
  assert.equal(br.up, true);
  assert.ok(br.nudge < 0, 'moves left, away from the sidebar');
  assert.equal(spots.br.x + SC.GLOBE + SC.CRADLE_SPARE + br.nudge, free.right - 6);
  assert.equal(SC.cradleLayout('tr', { x: 500, y: 12 }, free).nudge, 0, 'room enough, no nudge');
});

const view = {
  calendar: { mode: 'fantasy', hours_per_day: 24, minutes_per_hour: 60, months: [{ name: 'Harvestmoon', days: 30 }], moons: [{ id: 1, name: 'Selûne', cycle_days: 30 }], hemisphere: 'south' },
  date: { year: 1247, month: 1, day: 14, hour: 17, minute: 30 },
  weather: { label: 'Snow', icon: 'snow', preset_id: 'snow' },
  dayWeather: [],
  events: [
    { id: 'a', year: 1247, month: 1, day: 14, sky: { type: 'blood', moons: [1] } },
    { id: 'b', year: 1247, month: 1, day: 14, payload: '{"type":"eclipse","moons":[1]}' },
    { id: 'c', year: 1247, month: 1, day: 14 },
    { id: 'd', year: 1247, month: 1, day: 15, sky: { type: 'harvest', moons: [1] } },
  ],
};

test('the sky gets the calendar at the view\'s date, with the GM\'s moons or the players\' own', () => {
  const cal = SC.skyCalendar(view);
  assert.equal(cal.current_year, 1247);
  assert.equal(cal.current_day, 14);
  assert.equal(cal.current_hour, 17);
  assert.equal(cal.current_minute, 30);
  assert.equal(cal.hemisphere, 'south');
  assert.deepEqual(cal.moons.map((m) => m.id), [1]);
  assert.deepEqual(SC.skyCalendar({ ...view, skyMoons: [] }).moons, [], 'a players\' view draws only the moons it was sent');
  assert.equal(SC.skyCalendar({ ...view, calendar: { months: [] } }), null);
  assert.equal(SC.skyCalendar(null), null);
});

test('the day\'s own weather reading wins over the current weather', () => {
  assert.equal(SC.skyWeather(view).preset_label, 'Snow');
  const day = { year: 1247, month: 1, day: 14, icon: 'rain', preset_id: 'drizzle', label: 'Drizzle' };
  assert.deepEqual(SC.skyWeather({ ...view, dayWeather: [{ ...day, day: 13, icon: 'fog' }, day] }), { preset_id: 'drizzle', preset_label: 'Drizzle', icon: 'rain', precipitation: undefined });
  assert.equal(SC.skyWeather({ ...view, weather: null }), null);
});

test('only today\'s moon nights reach the sky, as the payload its code parses', () => {
  const ev = SC.skyEvents(view);
  assert.deepEqual(ev.map((e) => e.id), ['a', 'b']);
  assert.deepEqual(JSON.parse(ev[0].payload), { type: 'blood', moons: [1] });
});

test('what falls in front of the figure follows the weather', () => {
  assert.equal(SC.frontWeather({ icon: 'snow' }), 'snow');
  assert.equal(SC.frontWeather({ icon: 'cloud', precipitation: { type: 'snow' } }), 'snow');
  assert.equal(SC.frontWeather({ preset_id: 'blizzard' }), 'snow');
  assert.equal(SC.frontWeather({ icon: 'storm' }), 'storm');
  assert.equal(SC.frontWeather({ preset_id: 'thunderstorm', icon: 'cloud-rain' }), 'storm');
  assert.equal(SC.frontWeather({ icon: 'cloud-rain' }), 'rain');
  assert.equal(SC.frontWeather({ icon: 'fog' }), 'fog');
  assert.equal(SC.frontWeather({ icon: 'cloud' }), 'clear');
  assert.equal(SC.frontWeather(null), 'clear');
});

test('the frame rate: nothing when hidden, still or resting; most while something moves', () => {
  const base = { hidden: false, mini: false, still: false, resting: false, moving: false, falling: false, skyPace: 1 };
  assert.equal(SC.framesPerSecond(base), SC.FPS.idle);
  assert.equal(SC.framesPerSecond({ ...base, falling: true }), SC.FPS.falling);
  assert.equal(SC.framesPerSecond({ ...base, skyPace: 2 }), SC.FPS.falling);
  assert.equal(SC.framesPerSecond({ ...base, moving: true }), SC.FPS.moving);
  assert.equal(SC.framesPerSecond({ ...base, hidden: true, moving: true }), 0);
  assert.equal(SC.framesPerSecond({ ...base, still: true, moving: true }), 0);
  assert.equal(SC.framesPerSecond({ ...base, resting: true }), 0);
  assert.equal(SC.framesPerSecond({ ...base, mini: true }), 0, 'the small globe is a still picture');
  assert.equal(SC.framesPerSecond({ ...base, mini: true, moving: true }), SC.FPS.moving, 'until a day change finishes');
});

test('the figure is lit by the sun by day and the brightest moon by night', () => {
  const sun = SC.figureLight({ W: 100, H: 100, altEff: 30, sp: { x: 20, y: 30 }, wx: { light: 1 }, moons: [] });
  assert.deepEqual(sun, { x: 0.2, y: 0.3, k: 1, warm: true });
  const night = SC.figureLight({
    W: 100, H: 100, altEff: -30, sp: { x: 0, y: 0 },
    moons: [{ up: true, x: 70, y: 20, m: { alt: 0.5, lit: 0.2 }, mo: {} }, { up: true, x: 40, y: 10, m: { alt: 0.4, lit: 1 }, mo: {} }],
  });
  assert.equal(night.x, 0.4);
  assert.equal(night.warm, false);
  assert.ok(Math.abs(night.k - 0.55) < 1e-9);
  assert.equal(SC.figureLight(null).warm, false);
});

test('the vendored sky runs on the calendar the globe builds', () => {
  const win = {
    console, performance, devicePixelRatio: 1, matchMedia: () => ({ matches: false }),
    sessionStorage: { getItem: () => null, setItem() {} },
  };
  win.window = win;
  win.Chronicle = { register() {} };
  win.document = { documentElement: { classList: { contains: () => false } }, createElement: () => ({ getContext: () => null }), addEventListener() {}, hidden: false };
  const ctx = vm.createContext(win);
  for (const f of SKY_FILES) vm.runInContext(readFileSync(join(VENDOR, f), 'utf8'), ctx, { filename: f });
  const S = win.SkyPane.Scene;
  for (const k of ['state', 'paint', 'pace', 'seed']) assert.equal(typeof S[k], 'function', `Scene.${k}`);
  const cal = SC.skyCalendar(view);
  const st = S.state({ calendar: cal, todayEvents: SC.skyEvents(view), dayWeather: cal.weather, skym: win.SkyWorld.makeSkym(cal), landSeed: S.seed('x'), width: 110, height: 110, reduced: false }, 1, 0.05);
  assert.equal(st.weatherLabel, 'Snow');
  assert.equal(st.moons.length, 1);
  for (const k of ['zen', 'hor', 'h3']) assert.equal(st.P[k].length, 3, `palette ${k}`);
  const light = SC.figureLight(st);
  assert.ok(light.k > 0 && light.k <= 1);
});

function loadLooks() {
  const win = { console, performance, devicePixelRatio: 1, matchMedia: () => ({ matches: false }), sessionStorage: { getItem: () => null, setItem() {} } };
  win.window = win;
  win.Chronicle = { register() {} };
  win.document = { documentElement: { classList: { contains: () => false } }, createElement: () => ({ getContext: () => null }), addEventListener() {}, hidden: false };
  const ctx = vm.createContext(win);
  for (const f of ['sky_world.js', 'sky_looks.js']) vm.runInContext(readFileSync(join(VENDOR, f), 'utf8'), ctx, { filename: f });
  return win.SkyLooks;
}

test('every weather Chronicle\'s sky draws marks the stone in range, and none is left when it clears', () => {
  const L = loadLooks();
  const ids = Object.keys(L.PHYS);
  assert.ok(ids.length >= 40, 'the sky\'s built-in weathers');
  const marked = (S) => Object.entries(S).some(([, v]) => (typeof v === 'number' ? v > 0.02 : !!v));
  for (const id of ids) {
    const S = SC.stoneWeather(L.resolve(L.spec({ preset_id: id })));
    for (const [k, v] of Object.entries(S)) {
      if (typeof v === 'number') assert.ok(v >= 0 && v <= 1, `${id}.${k} = ${v}`);
      else if (v && v.k != null) assert.ok(v.k >= 0 && v.k <= 1 && v.c.every((c) => c >= 0 && c <= 255), `${id}.${k}`);
    }
    if (!['clear', 'partly-cloudy', 'cloudy', 'overcast'].includes(id)) assert.ok(marked(S), `${id} leaves no mark on the stone`);
  }
  assert.equal(marked(SC.stoneWeather(L.resolve(L.spec({ preset_id: 'clear' })))), false, 'clear stone is dry');
  // A campaign's own weather draws like the built-in its icon and precipitation are closest to.
  const own = SC.stoneWeather(L.resolve(L.spec({ preset_id: 'my-drizzle', icon: 'cloud-rain', precipitation: { type: 'rain', intensity: 0.4 } })));
  assert.ok(own.wet > 0.5);
});

test('each kind of weather leaves its own mark', () => {
  const L = loadLooks();
  const of = (id) => SC.stoneWeather(L.resolve(L.spec({ preset_id: id })));
  assert.ok(of('rain').wet > 0.7 && of('rain').snow === 0);
  assert.ok(of('snow').snow > 0.8 && of('snow').wet === 0);
  assert.ok(of('blizzard').rime > 0);
  assert.ok(of('hail').hail > 0.9);
  assert.ok(of('ice-storm').rime > 0.8);
  assert.ok(of('fog').dew > 0.5);
  assert.deepEqual(of('sandstorm').dust.c, [184, 137, 74]);
  assert.equal(of('sandstorm').dew, 0, 'dust leaves the stone dry');
  assert.equal(of('heat-wave').heat, 1);
  assert.equal(of('heat-wave').dew, 0);
  assert.ok(of('wildfire-smoke').soot > 0.5);
  assert.equal(of('autumn-leaves').litter.kind, 'leaf');
  assert.equal(of('sakura-bloom').litter.kind, 'petal');
  const acid = of('acid-rain').drip;
  assert.ok(acid[1] > acid[0] && acid[1] > acid[2], 'acid rain runs green');
  const blood = of('blood-rain').drip;
  assert.ok(blood[0] > blood[1] && blood[0] > blood[2], 'blood rain runs red');
  assert.ok(of('luminous-sky').glow.k > 0.5);
  assert.ok(of('divine-light').glow);
  assert.ok(of('nullfront').grey > 0.5);
  assert.equal(SC.frontOf(L.resolve(L.spec({ preset_id: 'hail' }))).hail > 0.9, true);
  assert.deepEqual(SC.frontOf(L.resolve(L.spec({ preset_id: 'acid-rain' }))).tint, [126, 224, 90]);
});

test('without Chronicle\'s sky, the plain weathers still mark the stone', () => {
  assert.ok(SC.stoneWeather(SC.plainRecipe('rain')).wet > 0.7);
  assert.ok(SC.stoneWeather(SC.plainRecipe('snow')).snow > 0.9);
  assert.ok(SC.stoneWeather(SC.plainRecipe('fog')).dew > 0.5);
  assert.equal(SC.frontOf(SC.plainRecipe('storm')).storm, 1);
  assert.equal(SC.stoneWeather(SC.plainRecipe('clear')).wet, 0);
  assert.equal(SC.stoneWeather(null).snow, 0);
});

test('a change of weather rolls across the stone', () => {
  const a = SC.stoneWeather(SC.plainRecipe('snow'));
  const b = { ...SC.stoneWeather(SC.plainRecipe('rain')), dust: { c: [1, 2, 3], k: 1 } };
  const half = SC.mixWeather(a, b, 0.5);
  assert.ok(Math.abs(half.snow - a.snow / 2) < 1e-9);
  assert.ok(Math.abs(half.wet - b.wet / 2) < 1e-9);
  assert.equal(half.dust.k, 0.5, 'a mark arriving comes in by degrees');
  assert.equal(SC.mixWeather(a, b, 0), a);
  assert.equal(SC.mixWeather(a, b, 1), b);
  assert.equal(SC.mixWeather(b, a, 1).dust, null, 'and is gone once the change is through');
});

const chronicle = process.env.CHRONICLE_DIR && join(process.env.CHRONICLE_DIR, 'static', 'js', 'widgets');
test('vendored sky files match Chronicle (needs CHRONICLE_DIR)', { skip: !(chronicle && existsSync(chronicle)) && 'CHRONICLE_DIR not set' }, () => {
  for (const f of SKY_FILES) {
    assert.ok(readFileSync(join(chronicle, f)).equals(readFileSync(join(VENDOR, f))),
      `vendor/chronicle/${f} differs from Chronicle's; copy it again from static/js/widgets/`);
  }
});
