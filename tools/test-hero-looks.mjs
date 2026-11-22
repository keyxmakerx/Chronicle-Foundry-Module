#!/usr/bin/env node
/** Pins the Chronicle hero sheet's rules (scripts/_hero-looks.mjs) and its class (scripts/hero-looks.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_LOOK, DRAW_STEEL_PLUS_SHEET, DRAW_STEEL_SHEET, FOLD_KEEP, HERO_LOOKS, LOOK_FLAG, MIN_DRAW_STEEL, allLookTemplates,
  chronicleParts, chroniclePageUrl, chronicleTabs, conditionList, drawSteelSupported, fitRenderParts, menuFocus,
  pickerRows, portraitRows, recoveryDots, resolveLook, staminaView, withFold,
  countDiamonds, lookTemplate, plaqueMetal, ringSegments, sheetChanges, skillNames,
} from '../scripts/_hero-looks.mjs';
import {
  FOLD_SETTING, HERO_SHEET_CLASS, LOOK_DEFAULT_SETTING, LOOK_LOCK_SETTING, forceDarkTheme, makeChronicleHeroSheet, registerHeroLooks,
} from '../scripts/hero-looks.mjs';
import { registerMotion } from '../scripts/motion.mjs';

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
    constructor(document) {
      this.document = document;
      this.element = null;
      this.options = { position: { width: 820, height: 780 }, actions: {} };
      this.position = { left: 100, top: 50, width: 820, height: 780 };
      this.renders = [];
      this.positions = [];
    }
    render(options) {
      this.renders.push(options);
      if (this.failRender?.(options)) throw new Error('Failed to render: card template');
      return this;
    }
    _configureRenderOptions(options) { options.isFirstRender ??= false; }
    _configureRenderParts() { return structuredClone(this.constructor.PARTS); }
    setPosition(p) { this.positions.push(p); Object.assign(this.position, p); }
    async _preparePartContext(partId, context) { context.base = partId; return context; }
    async _renderFrame() { return { dataset: {}, classList: fakeClassList() }; }
    async _preRender() {}
    async _onRender() {}
  };
}

function fakeClassList() {
  const set = new Set();
  return {
    toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    contains: (c) => set.has(c),
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
  };
}

/** A sheet window whose title bar holds the two frame buttons. */
function fakeWindow() {
  const button = (action) => {
    const attrs = {};
    return {
      hidden: false, dataset: { action }, classList: fakeClassList(),
      setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => attrs[k] ?? null, hasAttribute: (k) => k in attrs,
      querySelector: () => null,
    };
  };
  const fold = button('csFold');
  const look = button('csLookPicker');
  const header = { querySelector: (sel) => (sel.includes('csFold') ? fold : sel.includes('csLookPicker') ? look : null) };
  const removed = [];
  const element = {
    dataset: {}, classList: fakeClassList(),
    querySelector: (sel) => (sel === '.window-header' ? header : null),
    querySelectorAll: () => [{ remove: () => removed.push(1) }],
  };
  return { element, fold, look, removed };
}

function fakeHero({ value = 40, max = 60, statuses = [], level = 3, flag, limited = false } = {}) {
  return {
    uuid: 'Actor.hero1',
    limited,
    isOwner: true,
    system: {
      level,
      stamina: { value, max, temporary: 0, winded: Math.floor(max / 2), min: -Math.floor(max / 2) },
      recoveries: { value: 5, max: 8, recoveryValue: 20 },
      _getCharacteristics: () => ({ might: { value: 2 } }),
    },
    statuses: new Set(statuses),
    getFlag: (scope, key) => (scope === 'chronicle-sync' && key === LOOK_FLAG ? flag : undefined),
  };
}

/** A stand-in for game.settings holding the module's values. */
function withSettings(values, fn) {
  const saved = globalThis.game;
  const store = { ...values };
  globalThis.game = {
    ...(saved ?? {}),
    settings: {
      get: (scope, key) => { if (!(key in store)) throw new Error(`not registered: ${key}`); return store[key]; },
      set: async (scope, key, v) => { store[key] = v; return v; },
    },
  };
  return Promise.resolve().then(() => fn(store)).finally(() => { globalThis.game = saved; });
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
  sheet.element = { dataset: {}, classList: fakeClassList(), querySelector: (sel) => (sel === '.window-content' ? content : null) };
  await sheet._onRender({}, { isFirstRender: true });
  assert.equal(sheet.element.dataset.csLook, 'chronicle');
});

test('a redraw keeps the place the page was scrolled to', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  const sheet = new Sheet(fakeHero());
  const content = { scrollTop: 340 };
  sheet.element = { dataset: {}, classList: fakeClassList(), querySelector: (sel) => (sel === '.window-content' ? content : null) };
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

test('the GM\'s world default stands in for a hero with no look, and a lock overrides every choice', () => {
  // One look today, so a stand-in id shows the rule without a second look.
  assert.equal(resolveLook(undefined, { worldDefault: 'chronicle' }), 'chronicle');
  assert.equal(resolveLook(undefined, { worldDefault: 'retired' }), DEFAULT_LOOK);
  assert.equal(resolveLook('chronicle', { worldDefault: 'retired', locked: true }), DEFAULT_LOOK);
  assert.equal(resolveLook('retired', { worldDefault: 'chronicle', locked: false }), 'chronicle');
});

test('the look picker: the looks, then Draw Steel Plus when it is on, then Draw Steel\'s own sheet, always', () => {
  const ids = (rows) => rows.map((r) => r.id);
  const plain = pickerRows({ current: 'chronicle' });
  assert.deepEqual(ids(plain), ['chronicle', 'hall', DRAW_STEEL_SHEET]);
  assert.deepEqual(plain[0], {
    kind: 'look', id: 'chronicle', label: 'CHRONICLE.HeroSheet.Looks.chronicle', note: null,
    tag: 'CHRONICLE.HeroSheet.Picker.Now', checked: true, disabled: false,
  });
  assert.deepEqual(plain[1], {
    kind: 'look', id: 'hall', label: 'CHRONICLE.HeroSheet.Looks.hall', note: null,
    tag: null, checked: false, disabled: false,
  });
  assert.equal(plain[2].kind, 'sheet');
  assert.equal(plain[2].checked, false);
  assert.equal(pickerRows({ current: 'hall' }).find((r) => r.checked).id, 'hall');
  const plus = pickerRows({ current: 'chronicle', plusActive: true, registered: () => true });
  assert.deepEqual(ids(plus), ['chronicle', 'hall', DRAW_STEEL_PLUS_SHEET, DRAW_STEEL_SHEET]);
  assert.equal(plus[2].tag, 'CHRONICLE.HeroSheet.Picker.Found');
  // Installed but its sheet not registered (an older Draw Steel Plus): not offered.
  assert.deepEqual(ids(pickerRows({ current: 'chronicle', plusActive: true, registered: (id) => id !== DRAW_STEEL_PLUS_SHEET })), ['chronicle', 'hall', DRAW_STEEL_SHEET]);
  assert.deepEqual(ids(pickerRows({ current: 'chronicle', plusActive: false })), ['chronicle', 'hall', DRAW_STEEL_SHEET]);
});

test('a locked look: nobody picks another look, each is told why, and the way back to Draw Steel stays open', () => {
  const player = pickerRows({ current: 'chronicle', locked: true, isGM: false, plusActive: true });
  assert.equal(player[0].note, 'CHRONICLE.HeroSheet.Picker.Locked');
  // The current look stays open, so its row can still be read and focused; the other look can't be picked.
  assert.equal(player[0].disabled, false);
  assert.equal(player[1].disabled, true);
  assert.equal(player[1].note, 'CHRONICLE.HeroSheet.Picker.Locked');
  assert.ok(player.filter((r) => r.kind === 'sheet').every((r) => !r.disabled));
  // The lock means every hero uses the world's default, which resolveLook
  // draws whatever the hero's flag says, so a GM's pick would change nothing.
  const gm = pickerRows({ current: 'chronicle', locked: true, isGM: true, plusActive: true });
  assert.equal(gm[0].note, 'CHRONICLE.HeroSheet.Picker.LockedGM');
  assert.equal(gm[0].disabled, false);
  assert.equal(gm[1].disabled, true);
  assert.ok(gm.filter((r) => r.kind === 'sheet').every((r) => !r.disabled));
  const open = pickerRows({ current: 'chronicle', locked: false, isGM: true });
  assert.ok(open.every((r) => !r.disabled && (r.kind === 'sheet' || r.note === null)));
});

test('the portrait menu offers what each viewer may do', () => {
  const base = { isPlay: true, editable: true, limited: false, isOwner: true, isGM: false, mapped: true, hasTokenArt: true, chronicleUrl: 'https://c.example/campaigns/1/entities/2' };
  const actions = (over) => portraitRows({ ...base, ...over }).map((r) => r.action);
  assert.deepEqual(actions({}), ['showPortraitArtwork', 'showTokenArtwork', 'csOpenChronicle']);
  // Edit mode puts Foundry's file picker first, as Draw Steel's portrait does.
  assert.deepEqual(actions({ isPlay: false }), ['editImage', 'showPortraitArtwork', 'showTokenArtwork', 'csOpenChronicle']);
  // An Observer: the picture only, as Draw Steel offers the token to owners.
  assert.deepEqual(actions({ isPlay: false, editable: false, isOwner: false }), ['showPortraitArtwork']);
  // A Limited viewer sees the picture, as on Draw Steel's sheet, and nothing else.
  assert.deepEqual(actions({ limited: true, isOwner: false, editable: false }), ['showPortraitArtwork']);
  assert.deepEqual(actions({ hasTokenArt: false }), ['showPortraitArtwork', 'csOpenChronicle']);
  // The Chronicle page needs an owner with a Chronicle account, on a linked hero.
  assert.deepEqual(actions({ mapped: false }), ['showPortraitArtwork', 'showTokenArtwork']);
  assert.deepEqual(actions({ mapped: false, isGM: true }), ['showPortraitArtwork', 'showTokenArtwork', 'csOpenChronicle']);
  assert.deepEqual(actions({ isOwner: false }), ['showPortraitArtwork']);
  assert.deepEqual(actions({ chronicleUrl: null, isGM: true }), ['showPortraitArtwork', 'showTokenArtwork']);
  assert.equal(portraitRows({ ...base, isGM: true })[0].note, 'CHRONICLE.HeroSheet.Portrait.FullNoteGM');
  assert.equal(portraitRows(base)[0].note, 'CHRONICLE.HeroSheet.Portrait.FullNote');
});

test('menu keys: arrows step past disabled rows and wrap, Home and End jump, other keys stay', () => {
  const d = [false, true, false, false];
  assert.equal(menuFocus(0, 'ArrowDown', d), 2);
  assert.equal(menuFocus(3, 'ArrowDown', d), 0);
  assert.equal(menuFocus(2, 'ArrowUp', d), 0);
  assert.equal(menuFocus(0, 'ArrowUp', d), 3);
  assert.equal(menuFocus(2, 'Home', [true, false, false]), 1);
  assert.equal(menuFocus(0, 'End', [false, false, true]), 1);
  assert.equal(menuFocus(-1, 'ArrowDown', d), 0);
  assert.equal(menuFocus(-1, 'ArrowUp', d), 3);
  assert.equal(menuFocus(2, 'a', d), 2);
  assert.equal(menuFocus(1, 'ArrowDown', [true, true]), 1);
});

test('the hero\'s Chronicle page: the hero page on the configured site, or nothing', () => {
  assert.equal(chroniclePageUrl({ apiUrl: 'https://chronicle.example/', campaignId: 'c1', entityId: 'e 2' }), 'https://chronicle.example/campaigns/c1/entities/e%202');
  assert.equal(chroniclePageUrl({ apiUrl: 'http://10.0.0.5:8080', campaignId: 7, entityId: 9 }), 'http://10.0.0.5:8080/campaigns/7/entities/9');
  for (const where of [
    { apiUrl: '', campaignId: 'c', entityId: 'e' },
    { apiUrl: 'javascript:alert(1)//', campaignId: 'c', entityId: 'e' },
    { apiUrl: 'https://c.example', campaignId: '', entityId: 'e' },
    { apiUrl: 'https://c.example', campaignId: 'c', entityId: undefined },
  ]) assert.equal(chroniclePageUrl(where), null, JSON.stringify(where));
  assert.equal(chroniclePageUrl({ apiUrl: 'https://c.example', campaignId: '../x', entityId: 'e/../y' }), 'https://c.example/campaigns/..%2Fx/entities/e%2F..%2Fy');
});

test('a folded sheet draws the card alone; an open one never draws it', () => {
  const known = ['header', 'stats', 'tabs', 'abilities', 'card'];
  assert.deepEqual(fitRenderParts(['stats'], { folded: true, known }), ['card']);
  assert.deepEqual(fitRenderParts(undefined, { folded: true, known }), ['card']);
  assert.deepEqual(fitRenderParts(['stats', 'card', 'body'], { folded: false, known }), ['stats']);
  assert.equal(fitRenderParts(undefined, { folded: false, known }), undefined);
});

test('fold states: merged, newest first, rounded, an unfolded hero with no place removed, at most FOLD_KEEP', () => {
  let map = withFold({}, 'a', { folded: true, left: 10.6, top: 20.2 });
  assert.deepEqual(map, { a: { folded: true, left: 11, top: 20 } });
  map = withFold(map, 'b', { folded: true });
  assert.deepEqual(Object.keys(map), ['b', 'a']);
  map = withFold(map, 'a', { folded: false });
  // Unfolded, but its card place is kept for the next fold.
  assert.deepEqual(map.a, { folded: false, left: 11, top: 20 });
  assert.deepEqual(withFold({ b: { folded: true } }, 'b', { folded: false }), {});
  assert.deepEqual(withFold(null, 'x', { folded: true, left: Infinity }), { x: { folded: true } });
  let big = {};
  for (let i = 0; i < FOLD_KEEP + 5; i++) big = withFold(big, `h${i}`, { folded: true });
  assert.equal(Object.keys(big).length, FOLD_KEEP);
  assert.ok(`h${FOLD_KEEP + 4}` in big);
  assert.ok(!('h0' in big));
});

test('the sheet has its own four actions and the card part, which is not a tab', () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  for (const name of ['csPortraitMenu', 'csLookPicker', 'csFold', 'csUnfold']) {
    assert.equal(typeof Sheet.DEFAULT_OPTIONS.actions[name], 'function', name);
  }
  assert.equal(Sheet.PARTS.card.template, 'modules/chronicle-sync/templates/hero-looks/chronicle/card.hbs');
  assert.ok(!Sheet.TABS.primary.tabs.some((t) => t.id === 'card'));
});

test('open, the sheet draws Draw Steel\'s parts without the card; folded, the card alone', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: { 'Actor~hero2': { folded: true } } }, async () => {
    const open = new Sheet(fakeHero());
    assert.equal(open.folded, false);
    assert.ok(!('card' in open._configureRenderParts({})));
    assert.ok('abilities' in open._configureRenderParts({}));
    const folded = new Sheet({ ...fakeHero(), uuid: 'Actor.hero2' });
    assert.equal(folded.folded, true);
    assert.deepEqual(Object.keys(folded._configureRenderParts({})), ['card']);
  });
});

test('a Limited viewer never gets the card, whatever was saved, since it shows Stamina', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: { 'Actor~hero1': { folded: true } } }, async () => {
    const sheet = new Sheet(fakeHero({ limited: true }));
    assert.equal(sheet.folded, false);
    assert.ok(!('card' in sheet._configureRenderParts({})));
    await Sheet.DEFAULT_OPTIONS.actions.csFold.call(sheet);
    assert.equal(sheet.folded, false);
    assert.equal(sheet.renders.length, 0);
  });
});

test('Draw Steel\'s stats refresh redraws the card while folded, and never the card while open', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: { 'Actor~hero1': { folded: true } } }, async () => {
    const sheet = new Sheet(fakeHero());
    sheet.render({ parts: ['stats'] });
    sheet.render();
    sheet.render(true);
    assert.deepEqual(sheet.renders.map((o) => o.parts), [['card'], ['card'], ['card']]);
    assert.equal(sheet.renders[2].force, true);
  });
  await withSettings({ heroSheetFolds: {} }, async () => {
    const sheet = new Sheet(fakeHero());
    sheet.render({ parts: ['stats', 'card', 'body'] });
    sheet.render();
    assert.deepEqual(sheet.renders.map((o) => o.parts), [['stats'], undefined]);
  });
});

test('a folded sheet opens straight into the card, at the player\'s saved place', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: { 'Actor~hero1': { folded: true, left: 300, top: 120 } } }, async () => {
    const sheet = new Sheet(fakeHero());
    const options = { isFirstRender: true, position: { width: 820 } };
    sheet._configureRenderOptions(options);
    assert.deepEqual(options.position, { width: 296, height: 'auto', left: 300, top: 120 });
    const later = { isFirstRender: false };
    sheet._configureRenderOptions(later);
    assert.equal(later.position, undefined);
  });
});

test('Fold saves the state for this player, draws the card, and Open goes back to the full size and tab', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: {} }, async (store) => {
    const sheet = new Sheet(fakeHero());
    const removed = [];
    sheet.element = { dataset: {}, classList: fakeClassList(), querySelectorAll: () => [{ remove: () => removed.push(1) }, { remove: () => removed.push(2) }], querySelector: () => null };
    sheet.tabGroups = { primary: 'features' };
    await sheet._onRender({}, { isFirstRender: true });
    await Sheet.DEFAULT_OPTIONS.actions.csFold.call(sheet);
    assert.equal(sheet.folded, true);
    assert.deepEqual(store.heroSheetFolds, { 'Actor~hero1': { folded: true } });
    // The full sheet's parts are cleared first, as Foundry leaves parts it doesn't draw.
    assert.equal(removed.length, 2);
    assert.equal(sheet.renders.length, 1);
    assert.deepEqual(sheet.positions.at(-1), { width: 296, height: 'auto' });
    await Sheet.DEFAULT_OPTIONS.actions.csUnfold.call(sheet, {}, { dataset: { tab: 'abilities' } });
    assert.equal(sheet.folded, false);
    assert.equal(sheet.tabGroups.primary, 'abilities');
    assert.deepEqual(store.heroSheetFolds, {});
    assert.deepEqual(sheet.positions.at(-1), { left: 100, top: 50, width: 820, height: 780 });
  });
});

test('the title bar shows Fold past Limited and Sheet look to owners, and follows a permission change', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: {} }, async () => {
    const hero = fakeHero({ limited: true });
    hero.isOwner = false;
    const sheet = new Sheet(hero);
    // Both are built with the window, whoever opens it, so either can appear later.
    const buttons = sheet._getFrameButtons({});
    assert.deepEqual(buttons.map((b) => b.action), ['csFold', 'csLookPicker']);
    assert.equal(buttons[0].label, 'CHRONICLE.HeroSheet.Fold');
    const { element, fold, look } = fakeWindow();
    sheet.element = element;
    await sheet._onRender({}, { isFirstRender: true });
    assert.deepEqual([fold.hidden, look.hidden], [true, true], 'Limited');
    hero.limited = false;
    await sheet._onRender({}, {});
    assert.deepEqual([fold.hidden, look.hidden], [false, true], 'raised to Observer');
    hero.isOwner = true;
    await sheet._onRender({}, {});
    assert.deepEqual([fold.hidden, look.hidden], [false, false], 'made an owner');
    assert.equal(look.getAttribute('aria-haspopup'), 'menu');
    hero.isOwner = false;
    hero.limited = true;
    await sheet._onRender({}, {});
    assert.deepEqual([fold.hidden, look.hidden], [true, true], 'lowered to Limited');
  });
});

test('the card gets the portrait and characteristics Draw Steel prepares only for its own parts', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  const sheet = new Sheet(fakeHero());
  sheet._prepareAvatarCSS = () => ({ objectFit: 'cover' });
  const card = await sheet._preparePartContext('card', {}, {});
  assert.deepEqual(card.avatarProperties, { objectFit: 'cover' });
  assert.deepEqual(card.characteristics, { might: { value: 2 } });
  assert.equal(card.chronicle.stamina.band, 'healthy');
});

test('the look and lock settings are the GM\'s, shown now there is a second look; fold states are each player\'s', () => {
  const saved = { game: globalThis.game, ds: globalThis.ds, foundry: globalThis.foundry };
  const registered = {};
  try {
    globalThis.foundry = { documents: { collections: { Actors: { registerSheet: () => {} } } } };
    globalThis.ds = { applications: { sheets: { DrawSteelHeroSheet: fakeBase() } } };
    globalThis.game = { system: { id: 'draw-steel', version: '1.1.2' }, settings: { register: (namespace, key, cfg) => { registered[key] = { namespace, ...cfg }; } } };
    assert.equal(registerHeroLooks(), true);
    assert.deepEqual(Object.keys(registered).sort(), [FOLD_SETTING, LOOK_DEFAULT_SETTING, LOOK_LOCK_SETTING].sort());
    for (const r of Object.values(registered)) assert.equal(r.namespace, 'chronicle-sync');
    assert.equal(registered[LOOK_DEFAULT_SETTING].scope, 'world');
    assert.equal(registered[LOOK_LOCK_SETTING].scope, 'world');
    assert.equal(registered[LOOK_DEFAULT_SETTING].default, DEFAULT_LOOK);
    assert.equal(registered[LOOK_LOCK_SETTING].default, false);
    for (const key of [LOOK_DEFAULT_SETTING, LOOK_LOCK_SETTING]) {
      assert.equal(HERO_LOOKS.length > 1, true);
      assert.equal(registered[key].config, true, key);
    }
    assert.deepEqual(Object.keys(registered[LOOK_DEFAULT_SETTING].choices), HERO_LOOKS.map((l) => l.id));
    const fold = registered[FOLD_SETTING];
    assert.equal(fold.scope, 'client');
    assert.equal(fold.config, false);
    assert.equal(fold.type, Object);
    const lang = JSON.parse(read('lang/en.json'));
    for (const key of [LOOK_DEFAULT_SETTING, LOOK_LOCK_SETTING]) {
      for (const f of ['name', 'hint']) {
        const v = registered[key][f].split('.').reduce((o, k) => o?.[k], lang);
        assert.equal(typeof v, 'string', `${key} ${f}`);
      }
    }
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('a permission change that swaps card and full sheet clears the window and draws the new state whole', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: { 'Actor~hero1': { folded: true } } }, async () => {
    const hero = fakeHero();
    const sheet = new Sheet(hero);
    let removed = 0;
    sheet.element = { dataset: {}, classList: fakeClassList(), querySelectorAll: () => [{ remove: () => removed++ }], querySelector: () => null };
    await sheet._onRender({}, { isFirstRender: true });
    sheet.render({ parts: ['stats'] });
    assert.equal(removed, 0, 'still the card: nothing cleared');
    assert.deepEqual(sheet.renders.at(-1).parts, ['card']);
    // Lowered to Limited while the card was out.
    hero.limited = true;
    sheet.render({ parts: ['stats'] });
    assert.equal(removed, 1);
    assert.equal(sheet.renders.at(-1).parts, undefined, 'every part Draw Steel allows, not just stats');
  });
});

test('a card place still waiting to be saved does not fold the hero again after Open', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: {} }, async (store) => {
    const sheet = new Sheet(fakeHero());
    sheet.element = { dataset: {}, classList: fakeClassList(), querySelectorAll: () => [], querySelector: () => null };
    sheet.rendered = true;
    await Sheet.DEFAULT_OPTIONS.actions.csFold.call(sheet);
    sheet._onPosition({ left: 40, top: 60 });
    t.mock.timers.tick(500);
    assert.deepEqual(store.heroSheetFolds, { 'Actor~hero1': { folded: true, left: 40, top: 60 } });
    sheet._onPosition({ left: 90, top: 60 });
    await Sheet.DEFAULT_OPTIONS.actions.csUnfold.call(sheet, {}, { dataset: {} });
    t.mock.timers.tick(500);
    assert.equal(store.heroSheetFolds['Actor~hero1'].folded, false);
    assert.equal(store.heroSheetFolds['Actor~hero1'].left, 40);
  });
});

test('opened as the card, the full sheet\'s templates are loaded too, so Open has them', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  const saved = globalThis.foundry;
  const loaded = [];
  globalThis.foundry = { applications: { handlebars: { loadTemplates: async (list) => { loaded.push(...list); } } } };
  try {
    await withSettings({ heroSheetFolds: { 'Actor~hero1': { folded: true } } }, async () => {
      await new Sheet(fakeHero())._preFirstRender({}, {});
    });
    for (const t of ['systems/draw-steel/partials/characteristics.hbs', 'b.hbs', 'modules/chronicle-sync/templates/hero-looks/chronicle/card.hbs']) {
      assert.ok(loaded.includes(t), t);
    }
    loaded.length = 0;
    await withSettings({ heroSheetFolds: {} }, async () => {
      await new Sheet(fakeHero())._preFirstRender({}, {});
    });
    // Open, Foundry loads the sheet's own; every look's are loaded so a change of look draws at once.
    assert.deepEqual([...loaded].sort(), allLookTemplates().sort());
    assert.ok(loaded.includes('modules/chronicle-sync/templates/hero-looks/hall/stats.hbs'));
  } finally {
    globalThis.foundry = saved;
  }
});

test('a card that fails to draw when folding opens the full sheet, saved open, and tells the player once', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  const warned = [];
  const savedUi = globalThis.ui;
  globalThis.ui = { notifications: { warn: (m) => warned.push(m) } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withSettings({ heroSheetFolds: {} }, async (store) => {
      const sheet = new Sheet(fakeHero());
      sheet.failRender = (o) => o?.parts?.includes('card');
      const { element, removed } = fakeWindow();
      sheet.element = element;
      await sheet._onRender({}, { isFirstRender: true });
      await Sheet.DEFAULT_OPTIONS.actions.csFold.call(sheet);
      assert.equal(sheet.folded, false);
      assert.deepEqual(store.heroSheetFolds, {}, 'saved open, so the next open is the full sheet');
      assert.deepEqual(sheet.renders.map((o) => o.parts), [['card'], undefined]);
      assert.equal(sheet.renders[1].force, true);
      assert.ok(removed.length >= 1, 'the half-drawn card is cleared');
      assert.deepEqual(sheet.positions.at(-1), { left: 100, top: 50, width: 820, height: 780 });
      assert.deepEqual(warned, ['CHRONICLE.HeroSheet.CardFailed']);
      await Sheet.DEFAULT_OPTIONS.actions.csFold.call(sheet);
      assert.equal(warned.length, 1, 'told once');
    });
  } finally {
    globalThis.ui = savedUi;
    console.warn = warn;
  }
});

test('a hero saved folded whose card fails on opening opens as the full sheet instead', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  const warned = [];
  const savedUi = globalThis.ui;
  globalThis.ui = { notifications: { warn: (m) => warned.push(m) } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withSettings({ heroSheetFolds: { 'Actor~hero1': { folded: true, left: 30, top: 40 } } }, async (store) => {
      const sheet = new Sheet(fakeHero());
      sheet.failRender = (o) => o?.parts?.includes('card');
      await sheet.render({ force: true });
      assert.equal(sheet.folded, false);
      assert.deepEqual(sheet.renders.map((o) => o.parts), [['card'], undefined]);
      assert.equal(store.heroSheetFolds['Actor~hero1'].folded, false);
      assert.deepEqual(sheet.positions.at(-1), { width: 820, height: 780 });
      assert.equal(warned.length, 1);
    });
  } finally {
    globalThis.ui = savedUi;
    console.warn = warn;
  }
});

test('a failure drawing the full sheet is not swallowed', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: {} }, async () => {
    const sheet = new Sheet(fakeHero());
    sheet.failRender = () => true;
    await assert.rejects(sheet.render({ force: true }), /Failed to render/);
  });
});

/* ---- The portrait hall ---------------------------------------------- */

test('plaques: gold at +2 or more, bronze at +1, iron at 0 or below', () => {
  for (const [v, metal] of [[5, 'gold'], [2, 'gold'], [1, 'bronze'], [0, 'iron'], [-1, 'iron'], [undefined, 'iron'], ['2', 'iron']]) {
    assert.equal(plaqueMetal(v), metal, String(v));
  }
});

test('the recovery ring: one arc per recovery, round the whole circle, lit while unspent', () => {
  const segs = ringSegments(5, 8);
  assert.equal(segs.length, 8);
  assert.deepEqual(segs.map((s) => s.on), [true, true, true, true, true, false, false, false]);
  // Each arc plus its gap is an eighth of the circle; the arcs follow one another.
  const [len, rest] = segs[0].dash.split(' ').map(Number);
  assert.equal(Math.round((len + rest) * 100) / 100, 100);
  assert.equal(Math.round((segs[0].offset - segs[1].offset) * 100) / 100, 12.5);
  assert.equal(ringSegments(1, 1)[0].dash, '100 0');
  // Past the cap, or with no recoveries, the number stands alone.
  assert.equal(ringSegments(5, 20), null);
  assert.equal(ringSegments(0, 0), null);
});

test('a count with no maximum lights one diamond per point, up to ten', () => {
  assert.deepEqual(countDiamonds(3), [true, true, true]);
  assert.equal(countDiamonds(25).length, 10);
  assert.deepEqual(countDiamonds(0), []);
  assert.deepEqual(countDiamonds(-2), []);
  assert.deepEqual(countDiamonds(undefined), []);
});

test('skills by name, sorted, unknown keys left out', () => {
  const list = { alchemy: { label: 'Alchemy' }, climb: { label: 'Climb' }, sneak: { label: 'Sneak' } };
  assert.deepEqual(skillNames(new Set(['sneak', 'alchemy', 'retired', 'climb']), list, 'en'), ['Alchemy', 'Climb', 'Sneak']);
  assert.deepEqual(skillNames(undefined, list), []);
  assert.deepEqual(skillNames(['climb'], undefined), []);
});

test('what moved between two draws: a hit, a heal, a level, Edit mode', () => {
  assert.deepEqual(sheetChanges(null, { stamina: 3 }), []);
  assert.deepEqual(sheetChanges({ stamina: 30, level: 2, isPlay: true }, { stamina: 22, level: 2, isPlay: true }), ['hit']);
  assert.deepEqual(sheetChanges({ stamina: 22 }, { stamina: 30 }), ['heal']);
  assert.deepEqual(sheetChanges({ stamina: 22, level: 2 }, { stamina: 22, level: 3 }), ['level']);
  assert.deepEqual(sheetChanges({ isPlay: true }, { isPlay: false }), ['editin']);
  assert.deepEqual(sheetChanges({ isPlay: false }, { isPlay: true }), []);
  assert.deepEqual(sheetChanges({ stamina: null }, { stamina: 4 }), []);
});

test('the portrait hall draws its own header and boxes and borrows the Chronicle card', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: {}, heroLookDefault: 'chronicle', heroLookLocked: false }, async () => {
    const hall = new Sheet(fakeHero({ flag: 'hall' }));
    assert.equal(hall.look, 'hall');
    const parts = hall._configureRenderParts({});
    assert.equal(parts.header.template, lookTemplate('hall', 'header'));
    assert.equal(parts.stats.template, lookTemplate('hall', 'stats'));
    // Draw Steel's own parts and partials are untouched.
    assert.equal(parts.features.template, 'f.hbs');
    assert.deepEqual(parts.stats.templates, ['systems/draw-steel/partials/characteristics.hbs']);
    assert.equal(parts.card, undefined);
    const plain = new Sheet(fakeHero())._configureRenderParts({});
    assert.equal(plain.header.template, lookTemplate('chronicle', 'header'));
  });
  await withSettings({ heroSheetFolds: { 'Actor~hero1': { folded: true } }, heroLookDefault: 'chronicle', heroLookLocked: false }, async () => {
    const parts = new Sheet(fakeHero({ flag: 'hall' }))._configureRenderParts({});
    assert.deepEqual(Object.keys(parts), ['card']);
    assert.equal(parts.card.template, 'modules/chronicle-sync/templates/hero-looks/chronicle/card.hbs');
  });
});

test('a hero opening in the portrait hall opens at the hall\'s size; the card and the Chronicle look keep theirs', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: {}, heroLookDefault: 'hall', heroLookLocked: false }, async () => {
    const options = { isFirstRender: true };
    new Sheet(fakeHero())._configureRenderOptions(options);
    assert.deepEqual(options.position, { width: 1100, height: 760 });
    const again = { isFirstRender: false };
    new Sheet(fakeHero())._configureRenderOptions(again);
    assert.equal(again.position, undefined);
    const chronicle = { isFirstRender: true };
    new Sheet(fakeHero({ flag: 'chronicle' }))._configureRenderOptions(chronicle);
    assert.equal(chronicle.position, undefined);
  });
  await withSettings({ heroSheetFolds: { 'Actor~hero1': { folded: true } }, heroLookDefault: 'hall', heroLookLocked: false }, async () => {
    const options = { isFirstRender: true };
    new Sheet(fakeHero())._configureRenderOptions(options);
    assert.equal(options.position.width, 296);
  });
});

test('the portrait hall plays its opening, then a hit, a heal and a level; the Chronicle look and the card play none', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: {}, heroLookDefault: 'chronicle', heroLookLocked: false }, async () => {
    const hero = fakeHero({ flag: 'hall', value: 40 });
    const sheet = new Sheet(hero);
    const { element } = fakeWindow();
    sheet.element = element;
    await sheet._onRender({}, { isFirstRender: true });
    assert.ok(element.classList.contains('cs-move-open'));
    assert.ok(element.classList.contains('cs-own-opening'));
    hero.system.stamina.value = 31;
    await sheet._onRender({}, { isFirstRender: false });
    assert.ok(element.classList.contains('cs-move-hit'));
    hero.system.stamina.value = 36;
    hero.system.level = 4;
    await sheet._onRender({}, { isFirstRender: false });
    assert.ok(element.classList.contains('cs-move-heal'));
    assert.ok(element.classList.contains('cs-move-level'));

    const plainHero = fakeHero({ value: 40 });
    const plain = new Sheet(plainHero);
    const other = fakeWindow().element;
    plain.element = other;
    await plain._onRender({}, { isFirstRender: true });
    plainHero.system.stamina.value = 10;
    await plain._onRender({}, { isFirstRender: false });
    for (const move of ['open', 'hit']) assert.equal(other.classList.contains(`cs-move-${move}`), false, move);
    assert.equal(other.classList.contains('cs-own-opening'), false);
  });
  await withSettings({ heroSheetFolds: { 'Actor~hero1': { folded: true } }, heroLookDefault: 'chronicle', heroLookLocked: false }, async () => {
    const sheet = new Sheet(fakeHero({ flag: 'hall' }));
    const { element } = fakeWindow();
    sheet.element = element;
    await sheet._onRender({}, { isFirstRender: true });
    assert.equal(element.classList.contains('cs-move-open'), false);
    assert.equal(element.classList.contains('cs-own-opening'), false);
  });
});

test('a Limited viewer of the portrait hall sees no hit or heal, since Draw Steel shows them no Stamina', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  await withSettings({ heroSheetFolds: {}, heroLookDefault: 'chronicle', heroLookLocked: false }, async () => {
    const hero = fakeHero({ flag: 'hall', value: 40, limited: true });
    const sheet = new Sheet(hero);
    const { element } = fakeWindow();
    sheet.element = element;
    await sheet._onRender({}, { isFirstRender: true });
    assert.ok(element.classList.contains('cs-move-open'));
    hero.system.stamina.value = 20;
    await sheet._onRender({}, { isFirstRender: false });
    assert.equal(element.classList.contains('cs-move-hit'), false);
    hero.system.stamina.value = 50;
    hero.system.level = 4;
    await sheet._onRender({}, { isFirstRender: false });
    assert.equal(element.classList.contains('cs-move-heal'), false);
    // The level is in the header a Limited viewer gets.
    assert.ok(element.classList.contains('cs-move-level'));
  });
});

test('the card comes in when the sheet folds, in either look, and not on its redraws', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  for (const flag of ['chronicle', 'hall']) {
    await withSettings({ heroSheetFolds: {}, heroLookDefault: 'chronicle', heroLookLocked: false }, async () => {
      const sheet = new Sheet(fakeHero({ flag }));
      const { element } = fakeWindow();
      sheet.element = element;
      await Sheet.DEFAULT_OPTIONS.actions.csFold.call(sheet);
      assert.ok(element.classList.contains('cs-move-fold'), flag);
    });
  }
  const base = read('styles/hero-looks.css');
  const hall = read('styles/hero-look-hall.css');
  for (const css of [base, hall]) {
    for (const m of css.matchAll(/([^{}]*\.cs-card\s*)\{([^}]*)\}/g)) {
      if (/animation:/.test(m[2])) assert.match(m[1], /\.cs-move-fold/, m[1].trim());
    }
  }
  // Draw Steel redraws an open description on every change, so it doesn't animate in.
  for (const m of hall.matchAll(/([^{}]*\.document-description\.expanded[^{]*)\{([^}]*)\}/g)) assert.doesNotMatch(m[2], /animation/, m[1].trim());
});

test('the settings window\'s rules for the classes this sheet shares are reset on the sheet', () => {
  const heroClasses = new Set();
  for (const look of HERO_LOOKS) {
    for (const part of look.parts) {
      for (const m of read(lookTemplate(look.id, part).replace('modules/chronicle-sync/', '')).matchAll(/class="([^"]*)"/g)) {
        for (const c of m[1].split(/\s+/)) if (c.startsWith('cs-')) heroClasses.add(c);
      }
    }
  }
  const styles = JSON.parse(read('module.json')).styles.filter((f) => !f.includes('hero-look'));
  const leaks = new Map();
  for (const file of styles) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const sel of m[1].split(',').map((x) => x.trim())) {
        const compounds = sel.split(/[\s>+~]+/).filter(Boolean);
        // Scoped to another window when any part names something this sheet doesn't use.
        if (!compounds.length || !compounds.every((c) => /^\.cs-[a-z0-9-]+(:[a-z-]+(\([^)]*\))?)*$/.test(c) && heroClasses.has(c.slice(1).split(':')[0]))) continue;
        const cls = compounds.at(-1).slice(1).split(':')[0];
        const props = leaks.get(cls) ?? new Set();
        for (const d of m[2].split(';')) { const k = d.split(':')[0].trim(); if (k) props.add(k); }
        leaks.set(cls, props);
      }
    }
  }
  // A new shared class is a decision: reset it below and add it here.
  assert.deepEqual([...leaks.keys()].sort(), ['cs-field', 'cs-group', 'cs-lab', 'cs-state']);
  const base = read('styles/hero-looks.css');
  const LAYOUT = /^(padding|margin|border|display|grid-template-columns|font-size|font-weight|letter-spacing|text-transform|color|text-align)/;
  for (const [cls, props] of leaks) {
    const rule = base.match(new RegExp(`\\.chronicle-hero-sheet \\.${cls} \\{([^}]*)\\}`))?.[1] ?? '';
    const declared = new Set(rule.split(';').map((d) => d.split(':')[0].trim()));
    for (const prop of props) {
      if (!LAYOUT.test(prop)) continue;
      const short = prop.split('-')[0];
      assert.ok(declared.has(prop) || (['padding', 'margin', 'border'].includes(short) && declared.has(short) && prop !== 'border-radius'), `${cls}: ${prop} not reset`);
    }
  }
});

test('the portrait hall is drawn in Foundry\'s dark theme; another look gives the window its own theme back', () => {
  const el = { dataset: {}, classList: fakeClassList() };
  el.classList.add('themed', 'theme-light');
  forceDarkTheme(el, true);
  assert.ok(el.classList.contains('theme-dark') && el.classList.contains('themed'));
  assert.equal(el.classList.contains('theme-light'), false);
  forceDarkTheme(el, true);
  assert.equal(el.dataset.csTheme, 'themed theme-light');
  forceDarkTheme(el, false);
  assert.ok(el.classList.contains('theme-light') && el.classList.contains('themed'));
  assert.equal(el.classList.contains('theme-dark'), false);
  assert.equal(el.dataset.csTheme, undefined);
  // A window that followed the page's theme goes back to following it.
  const bare = { dataset: {}, classList: fakeClassList() };
  forceDarkTheme(bare, true);
  forceDarkTheme(bare, false);
  for (const c of ['themed', 'theme-dark', 'theme-light']) assert.equal(bare.classList.contains(c), false, c);
  forceDarkTheme(bare, false);
  assert.equal(bare.dataset.csTheme, undefined);
});

test('the boxes get the hall\'s plaques, ring, diamonds and skill names', async () => {
  const Sheet = makeChronicleHeroSheet(fakeBase());
  const hero = fakeHero();
  hero.system.characteristics = { might: { value: 2 }, agility: { value: 1 }, reason: { value: -1 } };
  hero.system.hero = { primary: { value: 3 }, surges: 1, epic: { value: 0 } };
  hero.system.skills = { value: new Set(['sneak', 'alchemy']) };
  const saved = globalThis.ds;
  globalThis.ds = { CONFIG: { skills: { list: { alchemy: { label: 'Alchemy' }, sneak: { label: 'Sneak' } } } } };
  try {
    const { chronicle } = await new Sheet(hero)._preparePartContext('stats', {}, {});
    assert.deepEqual(chronicle.metals, { might: 'gold', agility: 'bronze', reason: 'iron' });
    assert.equal(chronicle.ring.length, 8);
    assert.equal(chronicle.primaryDiamonds.length, 3);
    assert.equal(chronicle.surgeDiamonds.length, 1);
    assert.deepEqual(chronicle.epicDiamonds, []);
    assert.deepEqual(chronicle.skills, ['Alchemy', 'Sneak']);
  } finally {
    globalThis.ds = saved;
  }
});

test('the hall\'s opening replaces Chronicle\'s window grow', () => {
  const saved = { document: globalThis.document, Hooks: globalThis.Hooks, game: globalThis.game, HTMLElement: globalThis.HTMLElement };
  let onRender = null;
  try {
    globalThis.HTMLElement = class {};
    globalThis.document = { addEventListener: () => {}, documentElement: { dataset: {} } };
    globalThis.Hooks = { on: (name, fn) => { if (name === 'renderApplicationV2') onRender = fn; } };
    globalThis.game = { settings: { get: () => 'full' } };
    registerMotion();
    const win = (own) => {
      const el = { classList: fakeClassList(), style: { setProperty: () => {} }, addEventListener: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) };
      if (own) el.classList.add('cs-own-opening');
      return el;
    };
    const app = { options: { classes: ['chronicle-hero-sheet'] } };
    const hall = win(true);
    onRender({ ...app, element: hall }, hall, {}, { isFirstRender: true });
    assert.equal(hall.classList.contains('cs-grow'), false);
    const chronicle = win(false);
    onRender({ ...app, element: chronicle }, chronicle, {}, { isFirstRender: true });
    assert.equal(chronicle.classList.contains('cs-grow'), true);
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('the hall stylesheet gives every one of the sheet\'s tokens a value, so it is one set of values', () => {
  const base = read('styles/hero-looks.css');
  const hall = read('styles/hero-look-hall.css');
  const block = (css, sel) => {
    const at = css.indexOf(`${sel} {`);
    assert.ok(at >= 0, sel);
    return css.slice(at, css.indexOf('}', at));
  };
  const names = (css) => new Set([...css.matchAll(/(--cs-hero-[a-z-]+)\s*:/g)].map((m) => m[1]));
  const defaults = names(block(base, '.chronicle-hero-sheet'));
  const values = names(block(hall, '.chronicle-hero-sheet[data-cs-look="hall"]'));
  const read_ = new Set([...base.matchAll(/var\((--cs-hero-[a-z-]+)/g)].map((m) => m[1]));
  for (const t of read_) assert.ok(defaults.has(t), `${t} has no Chronicle value`);
  // The ease is shared; every colour, face and corner the sheet reads has a hall value.
  for (const t of read_) if (t !== '--cs-hero-ease') assert.ok(values.has(t), `${t} has no hall value`);
  // Corners are lengths, as the sheet's min() radii need.
  assert.match(block(hall, '.chronicle-hero-sheet[data-cs-look="hall"]'), /--cs-hero-radius: 0px;/);
  // The base reads no page token directly outside its defaults.
  assert.equal(base.replace(block(base, '.chronicle-hero-sheet'), '').match(/var\(--cs-page-/g), null);
});

test('the hall\'s moves: each has its Calm, and every font it uses ships with its licence', () => {
  const hall = read('styles/hero-look-hall.css');
  for (const move of ['open', 'hit', 'heal', 'level', 'editin']) assert.match(hall, new RegExp(`\\.cs-move-${move}\\b`), move);
  assert.match(hall, /html\[data-cs-motion="calm"\] \.chronicle-hero-sheet\[data-cs-look="hall"\]/);
  // Pseudo-elements inside :is() would void the whole selector.
  assert.doesNotMatch(hall, /:is\([^)]*::/);
  for (const m of hall.matchAll(/url\("\.\.\/fonts\/([^"]+)"\)/g)) {
    assert.doesNotThrow(() => read(`fonts/${m[1]}`), m[1]);
  }
  for (const f of ['Cinzel-OFL.txt', 'EBGaramond-OFL.txt']) assert.match(read(`fonts/${f}`), /SIL Open Font License/);
  assert.ok(JSON.parse(read('module.json')).styles.indexOf('styles/hero-look-hall.css') > JSON.parse(read('module.json')).styles.indexOf('styles/hero-looks.css'));
});
