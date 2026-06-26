#!/usr/bin/env node
/**
 * Unit tests for the leveled logger (`scripts/logger.mjs`).
 * Run: `node --test tools/test-logger.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { log, setLogLevel, getLogLevelName, getLogBuffer, clearLogBuffer, exportLogText, LOG_LEVELS } =
  await import('../scripts/logger.mjs');

function withConsoleSpy(fn) {
  const calls = { error: 0, warn: 0, info: 0, debug: 0, log: 0 };
  const orig = { error: console.error, warn: console.warn, info: console.info, debug: console.debug, log: console.log };
  console.error = () => { calls.error++; };
  console.warn = () => { calls.warn++; };
  console.info = () => { calls.info++; };
  console.debug = () => { calls.debug++; };
  console.log = () => { calls.log++; };
  try { fn(calls); } finally { Object.assign(console, orig); }
}

test('level set/get by name and number; unknown name ignored', () => {
  setLogLevel('warn');
  assert.equal(getLogLevelName(), 'warn');
  setLogLevel(LOG_LEVELS.debug);
  assert.equal(getLogLevelName(), 'debug');
  setLogLevel('bogus');
  assert.equal(getLogLevelName(), 'debug'); // unchanged
});

test('ring buffer ALWAYS captures, regardless of console level', () => {
  clearLogBuffer();
  setLogLevel('error'); // only errors print…
  withConsoleSpy(() => {
    log.debug('a debug line');
    log.error('an error line');
  });
  const buf = getLogBuffer();
  assert.equal(buf.length, 2); // both captured
  assert.deepEqual(buf.map((e) => e.level), ['debug', 'error']);
  assert.match(buf[0].msg, /a debug line/);
});

test('console output is gated by the active level', () => {
  clearLogBuffer();
  setLogLevel('warn');
  withConsoleSpy((calls) => {
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    assert.equal(calls.error, 1);
    assert.equal(calls.warn, 1);
    assert.equal(calls.info, 0); // below threshold → not printed
    assert.equal(calls.debug, 0);
  });
});

test('silent suppresses all console output but still captures', () => {
  clearLogBuffer();
  setLogLevel('silent');
  withConsoleSpy((calls) => {
    log.error('still recorded');
    assert.equal(calls.error, 0);
  });
  assert.equal(getLogBuffer().length, 1);
});

test('objects/errors are stringified; exportLogText renders lines', () => {
  clearLogBuffer();
  setLogLevel('trace');
  withConsoleSpy(() => {
    log.info('obj', { a: 1 });
    log.error(new Error('boom'));
  });
  const txt = exportLogText();
  assert.match(txt, /INFO obj \{"a":1\}/);
  assert.match(txt, /ERROR boom/);
});

test('ring buffer is capped (does not grow unbounded)', () => {
  clearLogBuffer();
  setLogLevel('silent');
  for (let i = 0; i < 600; i++) log.info('x' + i);
  assert.ok(getLogBuffer().length <= 500);
});
