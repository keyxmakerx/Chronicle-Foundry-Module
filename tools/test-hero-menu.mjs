#!/usr/bin/env node
/**
 * Pins the hero sheet's menus (scripts/hero-menu.mjs): their roles and
 * keyboard, how they close, where they sit, and what the look picker and the
 * portrait menu do when a row is picked. Run against a small stand-in DOM,
 * since the module's tests have no browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeHeroMenu, openHeroMenu } from '../scripts/hero-menu.mjs';
import { DRAW_STEEL_PLUS_SHEET, DRAW_STEEL_SHEET } from '../scripts/_hero-looks.mjs';
import { makeChronicleHeroSheet } from '../scripts/hero-looks.mjs';

/** A stand-in element: attributes, children, listeners that bubble, focus and a box. */
class El {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attrs = new Map();
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.text = '';
    this.className = '';
    this.rect = { top: 0, left: 0, width: 0, height: 0 };
    const el = this;
    this.classList = {
      add: (...c) => { el.className = [...new Set([...el.className.split(' ').filter(Boolean), ...c])].join(' '); },
      remove: (...c) => { el.className = el.className.split(' ').filter((x) => x && !c.includes(x)).join(' '); },
      contains: (c) => el.className.split(' ').includes(c),
      toggle: (c, on) => (on ? el.classList.add(c) : el.classList.remove(c)),
    };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? { text: n, isText: true } : n;
      node.parentElement = this;
      this.children.push(node);
    }
  }
  remove() {
    const p = this.parentElement;
    if (p) p.children = p.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  set textContent(t) { this.text = String(t); this.children = []; }
  get textContent() { return this.text + this.children.map((c) => (c.isText ? c.text : c.textContent)).join(''); }
  addEventListener(type, fn, opts) { (this.listeners[type] ??= []).push({ fn, once: !!opts?.once }); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l.fn !== fn); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) { for (let n = node; n; n = n.parentElement) if (n === this) return true; return false; }
  getBoundingClientRect() {
    const { top, left, width, height } = this.rect;
    return { top, left, width, height, bottom: top + height, right: left + width };
  }
  /** Every element below this one. */
  *all() { for (const c of this.children) if (!c.isText) { yield c; yield* c.all(); } }
  querySelector(sel) { return [...this.all()].find((e) => matches(e, sel)) ?? null; }
  querySelectorAll(sel) { return [...this.all()].filter((e) => matches(e, sel)); }
}

function matches(el, sel) {
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  const m = sel.match(/^\[([\w-]+)="([^"]*)"\]$/);
  if (m) return el.getAttribute(m[1]) === m[2] || (m[1] === 'data-action' && el.dataset.action === m[2]);
  return el.tagName === sel.toUpperCase();
}

function fakeDoc() {
  const doc = {
    activeElement: null,
    listeners: {},
    made: [],
    createElement(tag) { doc.made.push(tag); return new El(doc, tag); },
    addEventListener(type, fn) { (doc.listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { doc.listeners[type] = (doc.listeners[type] ?? []).filter((f) => f !== fn); },
  };
  return doc;
}

/** Fire an event on an element: the document's capture listeners, then up the tree. */
function fire(target, type, init = {}) {
  const event = { type, target, defaultPrevented: false, stopped: false, ...init };
  event.preventDefault = () => { event.defaultPrevented = true; };
  event.stopPropagation = () => { event.stopped = true; };
  for (const fn of [...(target.ownerDocument.listeners[type] ?? [])]) fn(event);
  for (let n = target; n && !event.stopped; n = n.parentElement) {
    for (const l of [...(n.listeners?.[type] ?? [])]) {
      if (l.once) n.removeEventListener(type, l.fn);
      l.fn(event);
    }
  }
  return event;
}

/** A sheet window 400 by 600 with a button near its top left. */
function windowWithAnchor() {
  const doc = fakeDoc();
  const root = new El(doc, 'div');
  root.rect = { top: 100, left: 100, width: 400, height: 600 };
  const anchor = new El(doc, 'button');
  anchor.rect = { top: 140, left: 120, width: 40, height: 30 };
  root.append(anchor);
  return { doc, root, anchor };
}

const menuOf = (root) => root.querySelector('.cs-menu');
const items = (menu) => menu.querySelectorAll('.cs-menu-item');

test('a menu is a labelled list of buttons; a choice of one is radio rows', () => {
  const { root, anchor } = windowWithAnchor();
  openHeroMenu(root, anchor, {
    label: 'Sheet look',
    heading: 'Sheet look for Ash',
    rows: [
      { label: 'Chronicle', tag: 'Now', icon: 'fa-solid fa-check', checked: true },
      { label: 'Locked look', note: 'Your GM has set the look', checked: false, disabled: true },
      { label: 'Draw Steel', note: 'The system sheet', separatorBefore: true },
    ],
    onPick: () => {},
  });
  const menu = menuOf(root);
  assert.equal(menu.getAttribute('role'), 'menu');
  assert.equal(menu.getAttribute('aria-label'), 'Sheet look');
  assert.equal(menu.querySelector('.cs-menu-head').textContent, 'Sheet look for Ash');
  const [a, b, c] = items(menu);
  assert.equal(a.getAttribute('role'), 'menuitemradio');
  assert.equal(a.getAttribute('aria-checked'), 'true');
  assert.equal(b.getAttribute('aria-checked'), 'false');
  // A disabled row stays focusable, so its note is read out.
  assert.equal(b.getAttribute('aria-disabled'), 'true');
  assert.equal(b.tabIndex, -1);
  assert.equal(c.getAttribute('role'), 'menuitem');
  assert.equal(c.getAttribute('aria-checked'), null);
  assert.equal(menu.querySelectorAll('hr').length, 1);
  assert.equal(a.querySelector('.cs-menu-tag').textContent, 'Now');
  assert.equal(b.querySelector('small').textContent, 'Your GM has set the look');
  assert.ok(a.querySelector('.cs-menu-icon').hasAttribute('inert'));
  assert.equal(anchor.getAttribute('aria-expanded'), 'true');
});

test('names are text: a hero called <img onerror> makes no image', () => {
  const { doc, root, anchor } = windowWithAnchor();
  openHeroMenu(root, anchor, { label: 'x', heading: '<img src=x onerror=alert(1)>', rows: [{ label: '<b>bold</b>', note: '<script>' }], onPick: () => {} });
  assert.ok(!doc.made.includes('img') && !doc.made.includes('b') && !doc.made.includes('script'));
  assert.equal(menuOf(root).querySelector('.cs-menu-head').textContent, '<img src=x onerror=alert(1)>');
});

test('focus starts on the ticked row, or the first; arrows, Home and End move it', () => {
  const { doc, root, anchor } = windowWithAnchor();
  openHeroMenu(root, anchor, { label: 'x', rows: [{ label: 'a', checked: false }, { label: 'b', checked: true }, { label: 'c', checked: false }], onPick: () => {} });
  const [a, b, c] = items(menuOf(root));
  assert.equal(doc.activeElement, b);
  assert.ok(fire(b, 'keydown', { key: 'ArrowDown' }).defaultPrevented);
  assert.equal(doc.activeElement, c);
  fire(c, 'keydown', { key: 'ArrowDown' });
  assert.equal(doc.activeElement, a);
  fire(a, 'keydown', { key: 'End' });
  assert.equal(doc.activeElement, c);
  fire(c, 'keydown', { key: 'Home' });
  assert.equal(doc.activeElement, a);
  closeHeroMenu(root);
  fire(menuOf(root), 'animationend');
  openHeroMenu(root, anchor, { label: 'x', rows: [{ label: 'a' }, { label: 'b' }], onPick: () => {} });
  assert.equal(doc.activeElement, items(menuOf(root))[0]);
});

test('picking a row closes the menu, returns focus to the button, then runs the pick', () => {
  const { doc, root, anchor } = windowWithAnchor();
  const picks = [];
  openHeroMenu(root, anchor, {
    label: 'x',
    rows: [{ label: 'a' }, { label: 'b', disabled: true }, { label: 'c' }],
    onPick: (i) => picks.push([i, doc.activeElement === anchor, anchor.getAttribute('aria-expanded')]),
  });
  const menu = menuOf(root);
  fire(items(menu)[1], 'click');
  assert.deepEqual(picks, [], 'a disabled row does nothing');
  assert.ok(!menu.classList.contains('cs-menu-out'));
  fire(items(menu)[2], 'click');
  assert.deepEqual(picks, [[2, true, 'false']]);
  assert.ok(menu.classList.contains('cs-menu-out'));
  // It leaves once its closing animation ends.
  fire(menu, 'animationend');
  assert.equal(menuOf(root), null);
});

test('Escape closes and returns focus; Tab closes and lets focus move on', () => {
  const { doc, root, anchor } = windowWithAnchor();
  openHeroMenu(root, anchor, { label: 'x', rows: [{ label: 'a' }], onPick: () => {} });
  const esc = fire(items(menuOf(root))[0], 'keydown', { key: 'Escape' });
  assert.ok(esc.defaultPrevented && esc.stopped, 'Escape does not also close the sheet');
  assert.equal(doc.activeElement, anchor);
  fire(menuOf(root), 'animationend');
  openHeroMenu(root, anchor, { label: 'x', rows: [{ label: 'a' }], onPick: () => {} });
  const first = items(menuOf(root))[0];
  const tab = fire(first, 'keydown', { key: 'Tab' });
  // Focus is back on the button and Tab is left to move on from it, not out of the window.
  assert.equal(tab.defaultPrevented, false);
  assert.ok(menuOf(root).classList.contains('cs-menu-out'));
  assert.equal(doc.activeElement, anchor);
});

test('closing returns the button that had focus in the menu, and leaves focus alone otherwise', () => {
  const { doc, root, anchor } = windowWithAnchor();
  openHeroMenu(root, anchor, { label: 'x', rows: [{ label: 'a' }], onPick: () => {} });
  assert.equal(closeHeroMenu(root), anchor);
  assert.equal(doc.activeElement, anchor);
  fire(menuOf(root), 'animationend');
  const elsewhere = new El(doc, 'input');
  root.append(elsewhere);
  openHeroMenu(root, anchor, { label: 'x', rows: [{ label: 'a' }], onPick: () => {} });
  elsewhere.focus();
  assert.equal(closeHeroMenu(root), null);
  assert.equal(doc.activeElement, elsewhere);
});

test('a click outside closes it, a click inside does not, and the listener goes with it', () => {
  const { doc, root, anchor } = windowWithAnchor();
  const elsewhere = new El(doc, 'div');
  root.append(elsewhere);
  openHeroMenu(root, anchor, { label: 'x', rows: [{ label: 'a' }], onPick: () => {} });
  const menu = menuOf(root);
  fire(items(menu)[0], 'pointerdown');
  assert.ok(!menu.classList.contains('cs-menu-out'));
  assert.equal(doc.listeners.pointerdown.length, 1);
  fire(elsewhere, 'pointerdown');
  assert.ok(menu.classList.contains('cs-menu-out'));
  assert.equal(doc.listeners.pointerdown.length, 0);
});

test('the same button closes its menu; another button swaps it; one menu at a time', () => {
  const { doc, root, anchor } = windowWithAnchor();
  const other = new El(doc, 'button');
  root.append(other);
  openHeroMenu(root, anchor, { label: 'one', rows: [{ label: 'a' }], onPick: () => {} });
  openHeroMenu(root, other, { label: 'two', rows: [{ label: 'b' }], onPick: () => {} });
  const open = root.querySelectorAll('.cs-menu').filter((m) => !m.classList.contains('cs-menu-out'));
  assert.deepEqual(open.map((m) => m.getAttribute('aria-label')), ['two']);
  assert.equal(anchor.getAttribute('aria-expanded'), 'false');
  openHeroMenu(root, other, { label: 'two', rows: [{ label: 'b' }], onPick: () => {} });
  assert.ok(root.querySelectorAll('.cs-menu').every((m) => m.classList.contains('cs-menu-out')));
  assert.equal(doc.activeElement, other);
  closeHeroMenu(root);
  closeHeroMenu(null);
});

test('it sits under the button, inside the window, and above the button when there is no room below', () => {
  const { root, anchor } = windowWithAnchor();
  const spec = { label: 'x', rows: [{ label: 'a' }], onPick: () => {} };
  // The stand-in has no layout, so give the menu its size as it is placed.
  const sized = (w, h) => {
    const createElement = root.ownerDocument.createElement;
    root.ownerDocument.createElement = (tag) => {
      const el = createElement(tag);
      if (tag === 'div') el.rect = { top: 0, left: 0, width: w, height: h };
      return el;
    };
    return () => { root.ownerDocument.createElement = createElement; };
  };
  let undo = sized(240, 200);
  openHeroMenu(root, anchor, spec);
  let menu = menuOf(root);
  assert.equal(menu.style.top, '76px');
  assert.equal(menu.style.left, '20px');
  closeHeroMenu(root);
  fire(menu, 'animationend');
  // Lined up with the button's right edge, held inside the window's left edge.
  openHeroMenu(root, anchor, { ...spec, align: 'end' });
  menu = menuOf(root);
  assert.equal(menu.style.left, '6px');
  closeHeroMenu(root);
  fire(menu, 'animationend');
  undo();
  undo = sized(240, 200);
  anchor.rect = { top: 600, left: 120, width: 40, height: 30 };
  openHeroMenu(root, anchor, spec);
  menu = menuOf(root);
  assert.equal(menu.style.top, `${600 - 100 - 6 - 200}px`);
  undo();
});

/* ---------- The sheet's two menus ---------- */

class Base {
  async _preRender() {}
  async _onRender() {}
  static DEFAULT_OPTIONS = {};
  static PARTS = { header: { template: 'h' }, tabs: { template: 't' }, stats: { template: 's' }, biography: { template: 'b' } };
  static TABS = { primary: { tabs: [{ id: 'stats' }, { id: 'biography' }], initial: 'stats' } };
}

/** A sheet on a hero, with the portrait in its window, under a stand-in game. */
function sheetFor({ isGM = false, isOwner = true, limited = false, mapped = true, plus = false, locked = false, token = 'tokens/ash.webp', randomImg = false, folded = false, update } = {}) {
  const { doc, root, anchor } = windowWithAnchor();
  const portrait = new El(doc, 'img');
  portrait.className = 'cs-portrait';
  portrait.setAttribute('data-edit', 'img');
  root.append(portrait);
  const calls = [];
  const actor = {
    name: 'Ash',
    uuid: 'Actor.ash',
    isOwner,
    limited,
    prototypeToken: { randomImg, texture: { src: token } },
    getFlag: (scope, key) => (scope === 'chronicle-sync' && key === 'entityId' ? 'ent-1' : undefined),
    update: update ?? (async (data, options) => { calls.push(['update', data, options]); }),
  };
  const Sheet = makeChronicleHeroSheet(Base);
  const sheet = new Sheet();
  sheet.document = actor;
  sheet.element = root;
  sheet.isPlayMode = true;
  sheet.isEditable = isOwner;
  sheet.options = {
    actions: {
      showPortraitArtwork: function (event, target) { calls.push(['showPortraitArtwork', this === sheet, target]); },
      showTokenArtwork: { handler(event, target) { calls.push(['showTokenArtwork', target]); } },
    },
  };
  const settings = {
    apiUrl: 'https://chronicle.example', campaignId: 'camp-1', heroLookLocked: locked, heroLookDefault: 'chronicle',
    userMappings: JSON.stringify(mapped ? { 'chr-user': 'u1' } : {}),
    heroSheetFolds: folded ? { 'Actor~ash': { folded: true } } : {},
  };
  globalThis.game = {
    i18n: { localize: (k) => k, format: (k, d) => `${k} ${JSON.stringify(d)}` },
    settings: { get: (scope, key) => settings[key] },
    user: { id: 'u1', isGM },
    modules: new Map(plus ? [['draw-steel-plus', { active: true }]] : []),
  };
  globalThis.CONFIG = { Actor: { sheetClasses: { hero: { [DRAW_STEEL_SHEET]: {}, ...(plus ? { [DRAW_STEEL_PLUS_SHEET]: {} } : {}) } } } };
  globalThis.CONST = { DEFAULT_TOKEN: 'icons/svg/mystery-man.svg' };
  return { Sheet, sheet, root, anchor, portrait, calls, doc };
}

function withGlobals(fn) {
  const saved = { game: globalThis.game, CONFIG: globalThis.CONFIG, CONST: globalThis.CONST, ui: globalThis.ui, window: globalThis.window };
  return Promise.resolve().then(fn).finally(() => { Object.assign(globalThis, saved); });
}

/** Each row's name, without its tag. */
const labels = (root) => items(menuOf(root)).map((b) => b.querySelector('.cs-menu-label').text);

test('the look picker lists the look, Draw Steel Plus when it is on, and Draw Steel\'s sheet', () => withGlobals(async () => {
  const { Sheet, sheet, root, anchor } = sheetFor({ plus: true });
  Sheet.DEFAULT_OPTIONS.actions.csLookPicker.call(sheet, {}, anchor);
  assert.deepEqual(labels(root), [
    'CHRONICLE.HeroSheet.Looks.chronicle', 'CHRONICLE.HeroSheet.Picker.Plus', 'CHRONICLE.HeroSheet.Picker.DrawSteel',
  ]);
  assert.match(menuOf(root).querySelector('.cs-menu-head').textContent, /Picker\.Heading \{"name":"Ash"\}/);
  assert.equal(items(menuOf(root))[0].getAttribute('aria-checked'), 'true');
  // The other sheets are plain rows after a line, not choices of a look.
  assert.equal(items(menuOf(root))[2].getAttribute('role'), 'menuitem');
  assert.equal(menuOf(root).querySelectorAll('hr').length, 1);
}));

test('picking another sheet stores it as the hero\'s sheet; picking the current look writes nothing', () => withGlobals(async () => {
  const { Sheet, sheet, root, anchor, calls } = sheetFor();
  Sheet.DEFAULT_OPTIONS.actions.csLookPicker.call(sheet, {}, anchor);
  fire(items(menuOf(root))[0], 'click');
  fire(menuOf(root), 'animationend');
  Sheet.DEFAULT_OPTIONS.actions.csLookPicker.call(sheet, {}, anchor);
  fire(items(menuOf(root))[1], 'click');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [['update', { 'flags.core.sheetClass': DRAW_STEEL_SHEET }, { chronicleSync: true }]]);
}));

test('a picker write that fails tells the player and leaves the sheet as it was', () => withGlobals(async () => {
  const warned = [];
  const { Sheet, sheet, root, anchor } = sheetFor({ update: async () => { throw new Error('no permission'); } });
  globalThis.ui = { notifications: { warn: (m) => warned.push(m) } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    Sheet.DEFAULT_OPTIONS.actions.csLookPicker.call(sheet, {}, anchor);
    fire(items(menuOf(root))[1], 'click');
    await new Promise((r) => setImmediate(r));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warned, ['CHRONICLE.HeroSheet.Picker.Failed']);
}));

test('the portrait menu opens the full picture and the token through Draw Steel\'s own handlers', () => withGlobals(async () => {
  const { Sheet, sheet, root, portrait, calls } = sheetFor();
  Sheet.DEFAULT_OPTIONS.actions.csPortraitMenu.call(sheet, {}, portrait);
  assert.deepEqual(labels(root), ['CHRONICLE.HeroSheet.Portrait.Full', 'CHRONICLE.HeroSheet.Portrait.Token', 'CHRONICLE.HeroSheet.Portrait.Change']);
  fire(items(menuOf(root))[0], 'click');
  fire(menuOf(root), 'animationend');
  Sheet.DEFAULT_OPTIONS.actions.csPortraitMenu.call(sheet, {}, portrait);
  fire(items(menuOf(root))[1], 'click');
  assert.deepEqual(calls, [['showPortraitArtwork', true, portrait], ['showTokenArtwork', portrait]]);
}));

test('"Change picture or token" opens the hero\'s Chronicle page in its own window, without a link back', () => withGlobals(async () => {
  const opened = [];
  const { Sheet, sheet, root, portrait } = sheetFor();
  globalThis.window = { open: (...a) => opened.push(a) };
  Sheet.DEFAULT_OPTIONS.actions.csPortraitMenu.call(sheet, {}, portrait);
  fire(items(menuOf(root))[2], 'click');
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], 'https://chronicle.example/campaigns/camp-1/entities/ent-1');
  assert.match(opened[0][2], /\bnoopener\b/);
}));

test('the portrait menu for a Limited viewer, a player without a Chronicle account, an Observer, and a hero with no token picture of its own', () => withGlobals(async () => {
  let s = sheetFor({ limited: true, isOwner: false });
  s.Sheet.DEFAULT_OPTIONS.actions.csPortraitMenu.call(s.sheet, {}, s.portrait);
  assert.deepEqual(labels(s.root), ['CHRONICLE.HeroSheet.Portrait.Full']);
  s = sheetFor({ mapped: false });
  s.Sheet.DEFAULT_OPTIONS.actions.csPortraitMenu.call(s.sheet, {}, s.portrait);
  assert.deepEqual(labels(s.root), ['CHRONICLE.HeroSheet.Portrait.Full', 'CHRONICLE.HeroSheet.Portrait.Token']);
  s = sheetFor({ token: 'icons/svg/mystery-man.svg', isGM: true, mapped: false });
  s.Sheet.DEFAULT_OPTIONS.actions.csPortraitMenu.call(s.sheet, {}, s.portrait);
  assert.deepEqual(labels(s.root), ['CHRONICLE.HeroSheet.Portrait.Full', 'CHRONICLE.HeroSheet.Portrait.Change']);
  // A random token image is a pattern, not a picture to show.
  s = sheetFor({ token: 'tokens/ash-*.webp', randomImg: true });
  s.Sheet.DEFAULT_OPTIONS.actions.csPortraitMenu.call(s.sheet, {}, s.portrait);
  assert.deepEqual(labels(s.root), ['CHRONICLE.HeroSheet.Portrait.Full', 'CHRONICLE.HeroSheet.Portrait.Change']);
  s = sheetFor({ isOwner: false, mapped: false });
  s.Sheet.DEFAULT_OPTIONS.actions.csPortraitMenu.call(s.sheet, {}, s.portrait);
  assert.deepEqual(labels(s.root), ['CHRONICLE.HeroSheet.Portrait.Full']);
}));

test('Edit mode puts the file picker first on the full sheet, but not on the card, which has no portrait field', () => withGlobals(async () => {
  let s = sheetFor();
  s.sheet.isPlayMode = false;
  s.Sheet.DEFAULT_OPTIONS.actions.csPortraitMenu.call(s.sheet, {}, s.portrait);
  assert.equal(labels(s.root)[0], 'CHRONICLE.HeroSheet.Portrait.Choose');
  fire(items(menuOf(s.root))[0], 'click');
  s = sheetFor({ folded: true });
  s.sheet.isPlayMode = false;
  s.Sheet.DEFAULT_OPTIONS.actions.csPortraitMenu.call(s.sheet, {}, s.portrait);
  assert.ok(!labels(s.root).includes('CHRONICLE.HeroSheet.Portrait.Choose'));
}));

test('a redraw with the portrait menu open closes it and puts focus on the new portrait button', () => withGlobals(async () => {
  const { Sheet, sheet, root, doc } = sheetFor();
  const button = new El(doc, 'button');
  button.dataset.action = 'csPortraitMenu';
  root.append(button);
  Sheet.DEFAULT_OPTIONS.actions.csPortraitMenu.call(sheet, {}, button);
  assert.ok(menuOf(root).contains(doc.activeElement));
  await sheet._preRender({}, {});
  // Draw Steel's refresh replaces the header, button and all.
  button.remove();
  const fresh = new El(doc, 'button');
  fresh.dataset.action = 'csPortraitMenu';
  root.append(fresh);
  await sheet._onRender({}, {});
  assert.equal(doc.activeElement, fresh);
}));
