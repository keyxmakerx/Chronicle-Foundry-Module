#!/usr/bin/env node
/**
 * `_map-look.mjs` resolves how Chronicle draws a map (frame, pin shape,
 * size, names, icons) and `_map-motion-rest.mjs` rests the frame's looping
 * decoration. Both feed the DOM, so every value must come from a closed set.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  resolveMapLook, sanitizeLook, markerIconClass, parseMapLook,
  pinMetrics, pinShapeSvg, frameInitial, DEFAULT_FRAME, DEFAULT_MARKER_ICON,
} = await import('../scripts/_map-look.mjs');
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
    parseMapLook({ campaign_frame: 'old', icons: [{ id: 'fa-ship' }, { id: 'bad id' }, null] }),
    { campaignFrame: 'old', icons: ['fa-ship'] },
  );
  assert.equal(parseMapLook({ campaign_frame: 'zzz' }).campaignFrame, DEFAULT_FRAME);
  assert.equal(parseMapLook(null), null);
  assert.equal(parseMapLook([]), null);
});

test('pinMetrics: Chronicle\'s anchors per shape, scaled by size', () => {
  assert.deepEqual(pinMetrics('drop', 'm'), { w: 30, h: 38, ax: 15, ay: 37, icoX: 15, icoY: 15, icoSize: 12 });
  assert.equal(pinMetrics('dot', 'm').ay, 19, 'a dot sits on its middle');
  assert.equal(pinMetrics('flag', 'm').ax, 8, 'a flag sits on its pole');
  assert.equal(pinMetrics('drop', 'l').w, 30 * 1.35);
  assert.deepEqual(pinMetrics('nope', 'nope'), pinMetrics('drop', 'm'));
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
