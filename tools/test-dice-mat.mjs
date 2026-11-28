#!/usr/bin/env node
/**
 * The Dice mat shows only public rolls. These pin the checks on a roll (both
 * the module's and the vendored tray's own), the person's choices, the socket
 * message from a GM only, and the panel's wiring. With CHRONICLE_DIR set the
 * vendored tray files are compared byte for byte with Chronicle's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import {
  MAT_FILES, MAT_MESSAGE, cleanChoices, isMatRoll, matMessage, matView, readMatMessage,
} from '../scripts/_dice-mat.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'chronicle');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const roll = (over = {}) => ({
  id: 'r1', origin: 'chronicle', rollerId: 'u1', rollerName: 'Mara', formula: '2d10+2',
  dice: [{ sides: 10, value: 7 }, { sides: 10, value: 9 }], modifier: 2, total: 18,
  mode: 'public', hidden: false, mine: false, rollerDice: { set: 'rune', colour: '#aabbcc' }, ...over,
});

// The vendored tray's own filter, run as Chronicle runs it.
function vendoredTray() {
  const ctx = { console, document: {}, Chronicle: {} };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of MAT_FILES) vm.runInContext(readFileSync(join(VENDOR, f), 'utf8'), ctx, { filename: f });
  return ctx.Chronicle.diceTray;
}

const NOT_DRAWN = {
  'gm roll': roll({ mode: 'gm' }),
  'blind roll': roll({ mode: 'blind' }),
  'self roll': roll({ mode: 'self' }),
  'blind stub': roll({ mode: 'blind', hidden: true, dice: [] }),
  'hidden public stub': roll({ hidden: true }),
  'no dice': roll({ dice: [] }),
  'odd die': roll({ dice: [{ sides: 7, value: 3 }] }),
  'value above sides': roll({ dice: [{ sides: 6, value: 7 }] }),
  'no id': roll({ id: '' }),
};

test('private, gm, blind, self and stub rolls are never drawn', () => {
  const tray = vendoredTray();
  for (const [name, r] of Object.entries(NOT_DRAWN)) {
    assert.equal(isMatRoll(r), false, name);
    assert.equal(matView(r), null, name);
    assert.equal(matMessage(r), null, name);
    // The tray's roll() refuses a roll with no id itself; its dice filter does not look at ids.
    if (name !== 'no id') assert.equal(tray.publicDice(r), null, `vendored tray: ${name}`);
  }
  assert.equal(isMatRoll(roll()), true);
  assert.equal(tray.publicDice(roll()).length, 2);
});

test('a view is rebuilt field by field and never carries extras', () => {
  const v = matView({ ...roll({ rollerName: '  Mara  ', modifier: 1e9, rollerDice: { set: 'Bad Set!', colour: 'red' } }), secret: 'x', why: 'gm note', mine: true });
  assert.equal(v.rollerName, 'Mara');
  assert.equal(v.modifier, 0);
  assert.deepEqual(v.rollerDice, { set: '', colour: '' });
  assert.equal(v.mine, false);
  assert.ok(!('secret' in v) && !('why' in v));
  assert.equal(matView(roll({ dice: Array.from({ length: 30 }, () => ({ sides: 6, value: 1 })) })).dice.length, 10);
});

test('cleanChoices falls back on bad input', () => {
  assert.deepEqual(cleanChoices(undefined), { level: 'detailed', finish: 'paper', others: true });
  assert.deepEqual(cleanChoices({ level: 'x', finish: 5, others: 'no' }), { level: 'detailed', finish: 'paper', others: true });
  assert.deepEqual(cleanChoices({ level: 'flat', finish: 'kit', others: false }), { level: 'flat', finish: 'kit', others: false });
});

test('a socket message from a non-GM is ignored; from a GM the receiver sets mine', () => {
  const msg = matMessage(roll(), 'fvtt-me');
  assert.equal(msg.type, MAT_MESSAGE);
  assert.equal(readMatMessage(msg, { senderIsGM: false, selfId: 'fvtt-me' }), null);
  assert.equal(readMatMessage(msg, { senderIsGM: true, selfId: 'fvtt-me' }).mine, true);
  assert.equal(readMatMessage(msg, { senderIsGM: true, selfId: 'fvtt-other' }).mine, false);
  assert.equal(readMatMessage({ ...msg, roll: { ...msg.roll, mine: true } }, { senderIsGM: true, selfId: 'fvtt-other' }).mine, false);
});

test('receipt judges the roll again', () => {
  const forged = { type: MAT_MESSAGE, roll: roll({ mode: 'gm' }), rollerFoundryId: null };
  assert.equal(readMatMessage(forged, { senderIsGM: true, selfId: 'a' }), null);
  assert.equal(readMatMessage({ type: 'other', roll: roll() }, { senderIsGM: true, selfId: 'a' }), null);
  assert.equal(readMatMessage(null, { senderIsGM: true, selfId: 'a' }), null);
});

test('module.json loads the stylesheet and the strings exist', () => {
  assert.ok(JSON.parse(read('module.json')).styles.includes('styles/dice-mat.css'));
  const lang = JSON.parse(read('lang/en.json')).CHRONICLE;
  for (const k of ['Title', 'LoadFailed']) assert.ok(lang.DiceMat[k], k);
  assert.ok(lang.SceneControl.DiceMat);
});

test('the relay sends only judged rolls, and only the active GM relays', () => {
  const src = read('scripts/dice-mat.mjs');
  assert.match(src, /matMessage\(payload, rollerFoundryId\)/);
  assert.match(src, /if \(relay\) game\.socket\.emit/);
  assert.match(src, /senderIsGM: !!game\.users\.get\(senderId\)\?\.isGM/);
  assert.match(read('scripts/roll-relay.mjs'), /relay: _isActiveGM\(\)/);
});

const chronicleDir = process.env.CHRONICLE_DIR;
const rolls = chronicleDir && join(resolve(chronicleDir), 'internal', 'plugins', 'rolls', 'static', 'js');
// Only an unset CHRONICLE_DIR skips: a moved source must fail, not go unchecked.
test('vendored files match Chronicle (needs CHRONICLE_DIR)', { skip: !rolls && 'CHRONICLE_DIR not set' }, () => {
  for (const f of MAT_FILES) {
    assert.ok(existsSync(join(rolls, f)),
      `Chronicle has no internal/plugins/rolls/static/js/${f}; it moved or was renamed, so update tools/refresh-vendor.mjs`);
    assert.equal(readFileSync(join(VENDOR, f), 'utf8'), readFileSync(join(rolls, f), 'utf8'),
      `vendor/chronicle/${f} differs from Chronicle's; copy it again from internal/plugins/rolls/static/js/`);
  }
});
