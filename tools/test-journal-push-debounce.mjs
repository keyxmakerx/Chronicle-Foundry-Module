#!/usr/bin/env node
/**
 * Tests for the per-journal push debounce (scripts/_journal-push-debounce.mjs).
 *
 * Covers: a burst of schedule() calls for one key collapses to a single
 * push after the debounce window; different keys never debounce each
 * other; flush()/flushAll() run a pending push immediately (journal close,
 * world unload) and never lose the last-scheduled args; flush is a no-op
 * when nothing is pending; cancel() drops a pending push with no call.
 *
 * Run: `node --test tools/test-journal-push-debounce.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { JournalPushDebouncer, JOURNAL_PUSH_DEBOUNCE_MS } from '../scripts/_journal-push-debounce.mjs';

/** Build a debouncer whose pushFn records every call. */
function makeDebouncer(delayMs = JOURNAL_PUSH_DEBOUNCE_MS) {
  const calls = [];
  const debouncer = new JournalPushDebouncer((...args) => calls.push(args), delayMs);
  return { debouncer, calls };
}

test('a single schedule() pushes once after the debounce window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { debouncer, calls } = makeDebouncer();

  debouncer.schedule('journal-1', 'a');
  assert.equal(calls.length, 0, 'must not push before the window elapses');

  t.mock.timers.tick(JOURNAL_PUSH_DEBOUNCE_MS - 1);
  assert.equal(calls.length, 0, 'must not push a moment early');

  t.mock.timers.tick(1);
  assert.deepEqual(calls, [['a']]);
});

test('a burst of schedule() calls for the same key collapses to one push carrying the last args', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { debouncer, calls } = makeDebouncer();

  debouncer.schedule('journal-1', 'first edit');
  t.mock.timers.tick(JOURNAL_PUSH_DEBOUNCE_MS - 500);
  debouncer.schedule('journal-1', 'second edit');
  t.mock.timers.tick(JOURNAL_PUSH_DEBOUNCE_MS - 500);
  debouncer.schedule('journal-1', 'last edit');
  t.mock.timers.tick(JOURNAL_PUSH_DEBOUNCE_MS - 1);
  assert.equal(calls.length, 0, 'still within the window restarted by the last edit');

  t.mock.timers.tick(1);
  assert.deepEqual(calls, [['last edit']], 'only the final edit is pushed, exactly once');
});

test('different keys debounce independently', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { debouncer, calls } = makeDebouncer();

  debouncer.schedule('journal-1', 'j1');
  t.mock.timers.tick(JOURNAL_PUSH_DEBOUNCE_MS - 500);
  debouncer.schedule('journal-2', 'j2');

  t.mock.timers.tick(500);
  assert.deepEqual(calls, [['j1']], 'journal-1 fires on its own schedule');

  t.mock.timers.tick(JOURNAL_PUSH_DEBOUNCE_MS - 500);
  assert.deepEqual(calls, [['j1'], ['j2']], 'journal-2 fires on its own, later schedule');
});

test('flush() runs a pending push immediately and cancels the timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { debouncer, calls } = makeDebouncer();

  debouncer.schedule('journal-1', 'unsaved edit');
  const flushed = debouncer.flush('journal-1');
  assert.equal(flushed, true);
  assert.deepEqual(calls, [['unsaved edit']], 'the last edit must never be lost to a timer that never fires');

  // The timer must be gone — ticking past the original window pushes nothing more.
  t.mock.timers.tick(JOURNAL_PUSH_DEBOUNCE_MS + 100);
  assert.equal(calls.length, 1, 'flush must not leave a stale timer to double-push');
});

test('flush() on a key with nothing pending is a no-op', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { debouncer, calls } = makeDebouncer();

  const flushed = debouncer.flush('never-scheduled');
  assert.equal(flushed, false);
  assert.equal(calls.length, 0);
});

test('flushAll() flushes every pending key, each exactly once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { debouncer, calls } = makeDebouncer();

  debouncer.schedule('journal-1', 'a');
  debouncer.schedule('journal-2', 'b');
  debouncer.schedule('journal-3', 'c');

  debouncer.flushAll();
  assert.deepEqual(calls.sort(), [['a'], ['b'], ['c']]);

  t.mock.timers.tick(JOURNAL_PUSH_DEBOUNCE_MS + 100);
  assert.equal(calls.length, 3, 'no stale timers fire after flushAll');
});

test('cancel() drops a pending push with no call at all', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { debouncer, calls } = makeDebouncer();

  debouncer.schedule('journal-1', 'discard me');
  debouncer.cancel('journal-1');

  t.mock.timers.tick(JOURNAL_PUSH_DEBOUNCE_MS + 100);
  assert.equal(calls.length, 0);
});

test('a fresh schedule() after a flush starts a new, independent window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { debouncer, calls } = makeDebouncer();

  debouncer.schedule('journal-1', 'first');
  debouncer.flush('journal-1');

  debouncer.schedule('journal-1', 'second');
  t.mock.timers.tick(JOURNAL_PUSH_DEBOUNCE_MS);
  assert.deepEqual(calls, [['first'], ['second']]);
});
