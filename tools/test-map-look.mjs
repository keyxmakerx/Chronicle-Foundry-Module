#!/usr/bin/env node
/**
 * `_map-look.mjs` resolves how Chronicle draws a map (frame, pin shape,
 * size, names, icons) and `_map-motion-rest.mjs` rests the frame's looping
 * decoration. Both feed the DOM, so every value must come from a closed set.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  resolveMapLook, sanitizeLook, markerIconClass, parseMapLook,
  pinMetrics, pinShapeSvg, frameInitial, frameRest, DEFAULT_FRAME, DEFAULT_MARKER_ICON,
  groupIconCatalog, mapThumbSrc, FRAMES, PIN_STYLES,
} = await import('../scripts/_map-look.mjs');

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const { startMotionRest } = await import('../scripts/_map-motion-rest.mjs');

test('resolveMapLook: defaults follow Chronicle (campaign frame, drop, medium, hover, tint on)', () => {
  assert.deepEqual(resolveMapLook(null), {
    frame: DEFAULT_FRAME, tint: true, pinStyle: 'drop', pinSize: 'm', pinLabels: 'hover',
  });
  assert.equal(resolveMapLook(null, 'arcane').frame, 'arcane');
  assert.equal(resolveMapLook(null, 'neon').frame, DEFAULT_FRAME, 'unknown campaign frame');
});

test('resolveMapLook: a map\'s own choices win; JSON string accepted', () => {
  const ds = { frame: { style: 'old', tint: false }, pins: { style: 'seal', size: 'l', labels: 'always' } };
  const want = { frame: 'old', tint: false, pinStyle: 'seal', pinSize: 'l', pinLabels: 'always' };
  assert.deepEqual(resolveMapLook(ds, 'arcane'), want);
  assert.deepEqual(resolveMapLook(JSON.stringify(ds), 'arcane'), want);
});

test('resolveMapLook: every frame and pin shape Chronicle offers is accepted', () => {
  assert.deepEqual([...FRAMES], [
    'atlas', 'arcane', 'old', 'modern', 'futuristic', 'gilded',
    'blueprint', 'stone', 'verdant', 'illuminated', 'corkboard', 'terminal',
  ]);
  assert.deepEqual([...PIN_STYLES], ['drop', 'seal', 'flag', 'dot', 'shield', 'tack', 'diamond', 'plaque']);
  for (const frame of FRAMES) {
    assert.equal(resolveMapLook({ frame: { style: frame } }).frame, frame);
    assert.equal(resolveMapLook(null, frame).frame, frame, 'as the campaign frame');
    assert.equal(parseMapLook({ campaign_frame: frame }).campaignFrame, frame);
    assert.equal(sanitizeLook({ frame }).frame, frame);
  }
  for (const style of PIN_STYLES) {
    assert.equal(resolveMapLook({ pins: { style } }).pinStyle, style);
    assert.equal(sanitizeLook({ pinStyle: style }).pinStyle, style);
  }
});

test('every frame has its stylesheet rule and every ornament block can show', () => {
  const css = read('styles/map-frames.css');
  const ornaments = read('templates/map-frame-ornaments.hbs');
  for (const frame of FRAMES) {
    assert.ok(css.includes(`.cs-mp-frame[data-frame="${frame}"]`), `no frame rule for ${frame}`);
  }
  const blocks = [...ornaments.matchAll(/data-o="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(blocks.length > 0);
  for (const block of blocks) {
    assert.ok(FRAMES.includes(block), `ornament block for an unknown frame: ${block}`);
    assert.ok(
      css.includes(`.cs-mp-frame[data-frame="${block}"] .cs-mp-orn [data-o="${block}"]`),
      `ornament block ${block} is never shown`,
    );
  }
  for (const frame of ['blueprint', 'stone', 'verdant', 'illuminated', 'corkboard', 'terminal']) {
    assert.ok(blocks.includes(frame), `no ornament block for ${frame}`);
  }
});

test('resolveMapLook: unknown or hostile values fall back', () => {
  const ds = { frame: { style: '"><script>' }, pins: { style: 'star', size: 'xl', labels: 1 } };
  assert.deepEqual(resolveMapLook(ds, 'gilded'), {
    frame: 'gilded', tint: true, pinStyle: 'drop', pinSize: 'm', pinLabels: 'hover',
  });
  assert.deepEqual(resolveMapLook('not json'), resolveMapLook(null));
  assert.deepEqual(resolveMapLook([1, 2]), resolveMapLook(null));
});

test('sanitizeLook: re-checks a stored look', () => {
  assert.deepEqual(sanitizeLook({ frame: 'futuristic', tint: false, pinStyle: 'dot', pinSize: 's', pinLabels: 'never' }),
    { frame: 'futuristic', tint: false, pinStyle: 'dot', pinSize: 's', pinLabels: 'never' });
  assert.deepEqual(sanitizeLook({ frame: 'x', pinStyle: '<b>' }), sanitizeLook(null));
});

test('markerIconClass: well-formed fa- classes only; catalog narrows when given', () => {
  assert.equal(markerIconClass('fa-castle'), 'fa-castle');
  assert.equal(markerIconClass('fa-castle" onclick="x'), DEFAULT_MARKER_ICON);
  assert.equal(markerIconClass(''), DEFAULT_MARKER_ICON);
  assert.equal(markerIconClass(null), DEFAULT_MARKER_ICON);
  assert.equal(markerIconClass('fa-anchor', new Set(['fa-castle'])), DEFAULT_MARKER_ICON);
  assert.equal(markerIconClass('fa-castle', new Set(['fa-castle'])), 'fa-castle');
});

test('parseMapLook: reads GET /maps/look; anything else is null', () => {
  assert.deepEqual(
    parseMapLook({ campaign_frame: 'old', icons: [{ id: 'fa-ship', label: 'Ship', category: 'Maritime' }, { id: 'bad id' }, null] }),
    {
      campaignFrame: 'old',
      icons: ['fa-ship'],
      iconCatalog: [{ id: 'fa-ship', label: 'Ship', category: 'Maritime' }],
    },
  );
  const bare = parseMapLook({ icons: [{ id: 'fa-anchor', label: 7 }] }).iconCatalog[0];
  assert.deepEqual(bare, { id: 'fa-anchor', label: 'anchor', category: 'Other' }, 'missing label/category fall back');
  assert.equal(parseMapLook({ campaign_frame: 'zzz' }).campaignFrame, DEFAULT_FRAME);
  assert.equal(parseMapLook(null), null);
  assert.equal(parseMapLook([]), null);
});

test('groupIconCatalog: groups in Chronicle\'s order', () => {
  const cat = [
    { id: 'fa-map-pin', label: 'Pin', category: 'General' },
    { id: 'fa-anchor', label: 'Port', category: 'Maritime' },
    { id: 'fa-star', label: 'Star', category: 'General' },
  ];
  assert.deepEqual(groupIconCatalog(cat), [
    { category: 'General', icons: [{ id: 'fa-map-pin', label: 'Pin' }, { id: 'fa-star', label: 'Star' }] },
    { category: 'Maritime', icons: [{ id: 'fa-anchor', label: 'Port' }] },
  ]);
  assert.deepEqual(groupIconCatalog(null), []);
});

test('mapThumbSrc: stored copies and Chronicle-host URLs only', () => {
  const chronicleHost = (u) => u.startsWith('https://chronicle.example/');
  assert.equal(mapThumbSrc('chronicle-sync/maps/m1-abc.jpg', chronicleHost), 'chronicle-sync/maps/m1-abc.jpg');
  assert.equal(mapThumbSrc('https://chronicle.example/media/x.png?sig=1', chronicleHost), 'https://chronicle.example/media/x.png?sig=1');
  for (const bad of ['https://evil.example/x.png', 'javascript:alert(1)', 'data:image/png;base64,AA', '//evil/x', '../x.png', 'a/../../x', '', null, 5]) {
    assert.equal(mapThumbSrc(bad, chronicleHost), '', String(bad));
  }
});

test('pinMetrics: Chronicle\'s anchors per shape, scaled by size', () => {
  assert.deepEqual(pinMetrics('drop', 'm'), { w: 30, h: 38, ax: 15, ay: 37, icoX: 15, icoY: 15, icoSize: 12 });
  assert.equal(pinMetrics('dot', 'm').ay, 19, 'a dot sits on its middle');
  assert.equal(pinMetrics('flag', 'm').ax, 8, 'a flag sits on its pole');
  assert.equal(pinMetrics('drop', 'l').w, 30 * 1.35);
  assert.deepEqual(pinMetrics('nope', 'nope'), pinMetrics('drop', 'm'));
  assert.equal(pinMetrics('diamond', 'm').ay, 19, 'a diamond sits on its middle');
  assert.equal(pinMetrics('tack', 'm').icoY, 11, 'a tack carries its icon in its head');
  for (const style of ['shield', 'tack', 'plaque']) {
    assert.equal(pinMetrics(style, 'm').ay, 37, `${style} sits on its point`);
  }
});

test('pinShapeSvg: every pin shape has its own drawing', () => {
  const drawings = PIN_STYLES.map((style) => pinShapeSvg(style, '#ff0000', false));
  assert.equal(new Set(drawings).size, PIN_STYLES.length);
  for (const [i, svg] of drawings.entries()) {
    assert.match(svg, /^<svg viewBox="0 0 30 38" aria-hidden="true">.*<\/svg>$/, PIN_STYLES[i]);
    assert.match(svg, /fill="#ff0000"/, PIN_STYLES[i]);
    assert.match(pinShapeSvg(PIN_STYLES[i], '#ff0000', true), /stroke-dasharray/, `${PIN_STYLES[i]} hidden`);
    assert.doesNotMatch(pinShapeSvg(PIN_STYLES[i], 'red" onload="x', false), /onload/, PIN_STYLES[i]);
  }
});

test('pinShapeSvg: one shape per style, dashed when hidden, bad colour replaced', () => {
  assert.match(pinShapeSvg('drop', '#ff0000', false), /fill="#ff0000"/);
  assert.match(pinShapeSvg('seal', '#ff0000', false), /circle cx="15" cy="22"/);
  assert.match(pinShapeSvg('flag', '#ff0000', false), /M9 5h17/);
  assert.match(pinShapeSvg('dot', '#ff0000', true), /stroke-dasharray/);
  assert.doesNotMatch(pinShapeSvg('drop', 'red" onload="x', false), /onload/);
});

test('frameInitial: first letter, upper-cased, with a fallback', () => {
  assert.equal(frameInitial('vellmoor Isle'), 'V');
  assert.equal(frameInitial(''), 'M');
});

test('frameRest: the name after its first letter, whole characters only', () => {
  assert.equal(frameRest('Vellmoor Isle'), 'ellmoor Isle');
  assert.equal(frameRest('  Vellmoor'), 'ellmoor', 'leading space is not the first letter');
  assert.equal(frameRest('V'), '');
  assert.equal(frameRest(''), '');
  assert.equal(frameRest(null), '');
  assert.equal(frameInitial('𝔙ale') + frameRest('𝔙ale'), '𝔙ale', 'a letter outside the basic plane stays whole');
});

/** Minimal document/element stand-ins for the rest timer. */
function fakeEnv() {
  const listeners = {};
  const doc = {
    hidden: false,
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    removeEventListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    fire: (ev) => (listeners[ev] || []).forEach((f) => f()),
    listeners,
  };
  const classes = new Set();
  const el = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  let pending = null;
  const setTimer = (fn) => { pending = fn; return 1; };
  const clearTimer = () => { pending = null; };
  return { doc, el, classes, setTimer, clearTimer, runTimer: () => pending && pending() };
}

test('startMotionRest: rests after idle, wakes on input, rests when hidden', () => {
  const env = fakeEnv();
  const stop = startMotionRest(env.el, { doc: env.doc, setTimer: env.setTimer, clearTimer: env.clearTimer });
  assert.equal(env.classes.has('cs-motion-rest'), false);
  env.runTimer();
  assert.equal(env.classes.has('cs-motion-rest'), true, 'idle rests');
  env.doc.fire('pointermove');
  assert.equal(env.classes.has('cs-motion-rest'), false, 'input wakes');
  env.doc.hidden = true;
  env.doc.fire('visibilitychange');
  assert.equal(env.classes.has('cs-motion-rest'), true, 'hidden tab rests');
  env.doc.hidden = false;
  env.doc.fire('visibilitychange');
  assert.equal(env.classes.has('cs-motion-rest'), false, 'showing again wakes');
  stop();
  assert.equal(Object.values(env.doc.listeners).flat().length, 0, 'stop removes every listener');
});
