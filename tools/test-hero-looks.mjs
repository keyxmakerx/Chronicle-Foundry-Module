#!/usr/bin/env node
/** Pins the Chronicle hero sheet's rules (scripts/_hero-looks.mjs) and its class (scripts/hero-looks.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_LOOK, HERO_LOOKS, LOOK_FLAG, MIN_DRAW_STEEL,
  chronicleParts, chronicleTabs, conditionList, drawSteelSupported, recoveryDots, resolveLook, staminaView,
} from '../scripts/_hero-looks.mjs';
import { HERO_SHEET_CLASS, makeChronicleHeroSheet, registerHeroLooks } from '../scripts/hero-looks.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Draw Steel's hero sheet as far as the subclass touches it. */
function fakeBase() {
  return class DrawSteelHeroSheet {
    static DEFAULT_OPTIONS = { classes: ['hero'] };
    static PARTS = {
      header: { template: 'systems/draw-steel/header.hbs' },
      tabs: { template: 'templates/generic/tab-navigation.hbs' },
      stats: { template: 'systems/draw-steel/stats.hbs', templates: ['systems/draw-steel/partials/characteristics.hbs'], scrollable: [''] },
      features: { template: 'f.hbs', scrollable: [''] },
      equipment: { template: 'e.hbs' },
      projects: { template: 'p.hbs' },
      abilities: { template: 'a.hbs' },
      effects: { template: 'fx.hbs' },
      biography: { template: 'b.hbs' },
    };
    static TABS = {
      primary: {
        tabs: ['stats', 'features', 'equipment', 'projects', 'abilities', 'effects', 'biography'].map((id) => ({ id })),
        initial: 'stats',
        labelPrefix: 'DRAW_STEEL.Actor.Tabs',
      },
    };
    constructor(document) { this.document = document; this.element = null; }
    async _preparePartContext(partId, context) { context.base = partId; return context; }
    async _renderFrame() { return { dataset: {} }; }
    async _preRender() {}
    async _onRender() {}
  };
}

function fakeHero({ value = 40, max = 60, statuses = [], level = 3, flag } = {}) {
  return {
    system: {
      level,
      stamina: { value, max, temporary: 0, winded: Math.floor(max / 2), min: -Math.floor(max / 2) },
      recoveries: { value: 5, max: 8, recoveryValue: 20 },
    },
    statuses: new Set(statuses),
    getFlag: (scope, key) => (scope === 'chronicle-sync' && key === LOOK_FLAG ? flag : undefined),
  };
}

test('a hero with no look, or one this module no longer has, gets the default', () => {
  assert.equal(DEFAULT_LOOK, 'chronicle');
  assert.equal(HERO_LOOKS[0].id, DEFAULT_LOOK);
  assert.equal(resolveLook(undefined), DEFAULT_LOOK);
  assert.equal(resolveLook('retired-look'), DEFAULT_LOOK);
  assert.equal(resolveLook({}), DEFAULT_LOOK);
  assert.equal(resolveLook('chronicle'), 'chronicle');
});

test('every look has a label in the language file', () => {
  const lang = JSON.parse(read('lang/en.json'));
  for (const look of HERO_LOOKS) {
    const value = look.label.split('.').reduce((o, k) => o?.[k], lang);
    assert.equal(typeof value, 'string', look.label);
  }
});

test('the parts keep every Draw Steel id, header and boxes first, then the tabs', () => {
  const Base = fakeBase();
  const own = { header: { template: 'h' }, stats: { template: 's' } };
  const parts = chronicleParts(Base.PARTS, own);
  assert.deepEqual(Object.keys(parts), ['header', 'stats', 'tabs', 'features', 'equipment', 'projects', 'abilities', 'effects', 'biography']);
  assert.equal(parts.header, own.header);
  assert.equal(parts.stats, own.stats);
  assert.equal(parts.abilities, Base.PARTS.abilities);
});

test('the boxes leave the tab row, abilities come first, and a new Draw Steel tab still shows', () => {
  const Base = fakeBase();
  const tabs = chronicleTabs(Base.TABS);
  assert.deepEqual(tabs.primary.tabs.map((t) => t.id), ['abilities', 'features', 'equipment', 'projects', 'effects', 'biography']);
  assert.equal(tabs.primary.initial, 'abilities');
  assert.equal(tabs.primary.labelPrefix, 'DRAW_STEEL.Actor.Tabs');
  // Draw Steel's own TABS are left as they were.
  assert.equal(Base.TABS.primary.tabs.length, 7);
  const later = chronicleTabs({ primary: { tabs: [{ id: 'companions' }, { id: 'biography' }, { id: 'abilities' }] } });
  assert.deepEqual(later.primary.tabs.map((t) => t.id), ['abilities', 'biography', 'companions']);
  assert.deepEqual(chronicleTabs(undefined).primary.tabs, []);
});

test('the Stamina box follows Draw Steel thresholds', () => {
  const at = (value) => staminaView({ value, max: 60, temporary: 5, winded: 30, min: -30 });
  assert.deepEqual(at(60), { value: 60, max: 60, temporary: 5, fill: 100, windedAt: 50, band: 'healthy' });
  assert.equal(at(31).band, 'healthy');
  assert.equal(at(30).band, 'winded');
  assert.equal(at(1).band, 'winded');
  assert.equal(at(0).band, 'dying');
  assert.equal(at(0).fill, 0);
  assert.equal(at(-29).band, 'dying');
  assert.equal(at(-30).band, 'dead');
  assert.equal(at(45).fill, 75);
  // Over the maximum the bar is full, not wider than the box.
  assert.equal(at(70).fill, 100);
});

test('a hero whose Stamina is not set yet draws an empty bar, not a wrong state', () => {
  const v = staminaView({ value: null, max: 0, winded: 0, min: 0 });
  assert.equal(v.band, 'unknown');
  assert.equal(v.fill, 0);
  assert.equal(v.windedAt, null);
  assert.deepEqual(staminaView(), { value: null, max: null, temporary: 0, fill: 0, windedAt: null, band: 'unknown' });
  assert.equal(staminaView({ value: 10, max: 20, temporary: -3 }).temporary, 0);
});

test('one dot per recovery, filled while unspent; too many to count shows the number alone', () => {
  assert.deepEqual(recoveryDots(2, 4), [true, true, false, false]);
  assert.deepEqual(recoveryDots(9, 4), [true, true, true, true]);
  assert.deepEqual(recoveryDots(-1, 2), [false, false]);
  assert.equal(recoveryDots(5, 13), null);
  assert.equal(recoveryDots(0, 0), null);
  assert.equal(recoveryDots(1, undefined), null);
});

test('conditions are named as the token HUD names them, without the stamina states', () => {
  const effects = [
    { id: 'prone', name: 'Prone', img: 'p.svg' },
    { id: 'dazed', name: 'Dazed', img: 'd.svg' },
    { id: 'winded', name: 'Winded' },
    { id: 'dead', name: 'Dead' },
  ];
  assert.deepEqual(conditionList(new Set(['prone', 'winded', 'dazed', 'homebrew']), effects, ['winded', 'dying']), [
    { id: 'dazed', name: 'Dazed', img: 'd.svg' },
    { id: 'prone', name: 'Prone', img: 'p.svg' },
  ]);
  // Defeated is not a stamina state, so it shows.
  assert.deepEqual(conditionList(['dead'], effects, ['winded', 'dying']).map((c) => c.id), ['dead']);
  assert.deepEqual(conditionList(undefined, undefined), []);
});

test('the sheet class keeps the name Foundry stores, and the id matches the module', () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  assert.equal(Sheet.name, 'ChronicleHeroSheet');
  const [scope, name] = HERO_SHEET_CLASS.split('.');
  assert.equal(scope, JSON.parse(read('module.json')).id);
  assert.equal(name, Sheet.name);
});

test('the sheet adds its class and size, swaps only header and stats, and keeps Draw Steel\'s stat partials', () => {
  const Base = fakeBase();
  const Sheet = makeChronicleHeroSheet(Base);
  assert.deepEqual(Sheet.DEFAULT_OPTIONS.classes, ['chronicle-hero-sheet']);
  assert.ok(Sheet.DEFAULT_OPTIONS.position.width >= 700);
  assert.match(Sheet.PARTS.header.template, /^modules\/chronicle-sync\/templates\/hero-looks\/chronicle\/header\.hbs$/);
  assert.match(Sheet.PARTS.stats.template, /^modules\/chronicle-sync\/templates\/hero-looks\/chronicle\/stats\.hbs$/);
  assert.deepEqual(Sheet.PARTS.stats.templates, Base.PARTS.stats.templates);
  assert.equal(Sheet.PARTS.biography, Base.PARTS.biography);
  assert.equal(Sheet.TABS.primary.initial, 'abilities');
});

test('the boxes get their figures from Draw Steel\'s data, and only the stats part does', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  const prevConfig = globalThis.CONFIG;
  globalThis.CONFIG = { statusEffects: [{ id: 'prone', name: 'Prone' }, { id: 'winded', name: 'Winded' }] };
  try {
    const sheet = new Sheet(fakeHero({ value: 20, max: 60, statuses: ['prone', 'winded'], level: 10 }));
    const stats = await sheet._preparePartContext('stats', {}, {});
    assert.equal(stats.base, 'stats');
    assert.equal(stats.chronicle.stamina.band, 'winded');
    assert.equal(stats.chronicle.stamina.fill, 33.3);
    assert.equal(stats.chronicle.recoveryDots.filter(Boolean).length, 5);
    assert.deepEqual(stats.chronicle.conditions.map((c) => c.id), ['prone']);
    assert.equal(stats.chronicle.showEpic, true);
    const header = await sheet._preparePartContext('header', {}, {});
    assert.equal(header.chronicle, undefined);
  } finally {
    globalThis.CONFIG = prevConfig;
  }
});

test('a failure working out the boxes leaves them empty instead of breaking the sheet', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  const sheet = new Sheet({ get system() { throw new Error('boom'); }, getFlag: () => undefined });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const stats = await sheet._preparePartContext('stats', {}, {});
    assert.deepEqual(stats.chronicle, {});
  } finally {
    console.warn = warn;
  }
});

test('the look reaches the window frame and the rendered sheet', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  const sheet = new Sheet(fakeHero({ flag: 'not-a-look' }));
  const frame = await sheet._renderFrame({});
  assert.equal(frame.dataset.csLook, 'chronicle');
  const content = { scrollTop: 0 };
  sheet.element = { dataset: {}, querySelector: (sel) => (sel === '.window-content' ? content : null) };
  await sheet._onRender({}, { isFirstRender: true });
  assert.equal(sheet.element.dataset.csLook, 'chronicle');
});

test('a redraw keeps the place the page was scrolled to', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  const sheet = new Sheet(fakeHero());
  const content = { scrollTop: 340 };
  sheet.element = { dataset: {}, querySelector: () => content };
  await sheet._preRender({}, {});
  content.scrollTop = 0;
  await sheet._onRender({}, { isFirstRender: false });
  assert.equal(content.scrollTop, 340);
});

test('drawSteelSupported: Draw Steel 1.1.0 or later, plain versions only', () => {
  assert.equal(MIN_DRAW_STEEL, '1.1.0');
  for (const v of ['1.1.0', '1.1.2', '1.2', '1.2.3', '1.10.0', '2', '2.0.0', ' 1.1.2 ']) {
    assert.equal(drawSteelSupported(v), true, v);
  }
  for (const v of ['0.10.2', '0.9', '1.0.9', '1.0', '1', undefined, null, '', 'latest', '1.1.0-beta', 'v1.2', '1.2.3.4', '1..2', 1.2]) {
    assert.equal(drawSteelSupported(v), false, String(v));
  }
});

test('registration: Draw Steel heroes only, never the default sheet', () => {
  const saved = { game: globalThis.game, ds: globalThis.ds, foundry: globalThis.foundry };
  const calls = [];
  try {
    globalThis.foundry = { documents: { collections: { Actors: { registerSheet: (...a) => calls.push(a) } } } };
    globalThis.game = { system: { id: 'dnd5e' } };
    globalThis.ds = { applications: { sheets: { DrawSteelHeroSheet: fakeBase() } } };
    assert.equal(registerHeroLooks(), false);
    globalThis.game = { system: { id: 'draw-steel', version: '1.1.2' } };
    globalThis.ds = undefined;
    assert.equal(registerHeroLooks(), false);
    globalThis.ds = { applications: { sheets: { DrawSteelHeroSheet: fakeBase() } } };
    for (const version of ['0.10.2', undefined, 'odd']) {
      globalThis.game = { system: { id: 'draw-steel', version } };
      assert.equal(registerHeroLooks(), false, `Draw Steel ${version}`);
    }
    assert.equal(calls.length, 0);
    globalThis.game = { system: { id: 'draw-steel', version: '1.1.2' } };
    assert.equal(registerHeroLooks(), true);
    assert.equal(calls.length, 1);
    const [scope, Sheet, options] = calls[0];
    assert.equal(scope, 'chronicle-sync');
    assert.equal(Sheet.name, 'ChronicleHeroSheet');
    assert.deepEqual(options, { types: ['hero'], makeDefault: false, label: 'CHRONICLE.HeroSheet.Name' });
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('the stylesheet ships and is wired at init', () => {
  assert.ok(JSON.parse(read('module.json')).styles.includes('styles/hero-looks.css'));
  assert.match(read('scripts/module.mjs'), /registerHeroLooks\(\)/);
});
