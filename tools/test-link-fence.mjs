#!/usr/bin/env node
/**
 * A document is fenced from sync writes while its player-set link is undone,
 * and a write needs the document still linked to the page it carries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import LinkFence from '../scripts/_link-fence.mjs';

test('holds only for the linked page and while no unlink is in flight', async () => {
  const f = new LinkFence();
  assert.equal(f.holds('d', 'e1', 'e1'), true);
  assert.equal(f.holds('d', 'e2', 'e1'), false, 'linked elsewhere');
  assert.equal(f.holds('d', undefined, 'e1'), false, 'unlinked');
  assert.equal(f.holds('d', undefined, undefined), false, 'no page named');
  let land;
  const p = f.undo('d', () => new Promise((r) => { land = r; }));
  assert.equal(f.holds('d', 'e1', 'e1'), false, 'fenced as soon as undo is called');
  assert.equal(f.holds('other', 'e1', 'e1'), true, 'other documents unaffected');
  land();
  await p;
  assert.equal(f.holds('d', 'e1', 'e1'), true, 'released once the unlink settles');
});

test('overlapping unlinks keep the fence until the last lands', async () => {
  const f = new LinkFence();
  let first, second;
  const a = f.undo('d', () => new Promise((r) => { first = r; }));
  const b = f.undo('d', () => new Promise((r) => { second = r; }));
  second();
  await b;
  assert.equal(f.holds('d', 'e1', 'e1'), false, 'still fenced by the first');
  first();
  await a;
  assert.equal(f.holds('d', 'e1', 'e1'), true);
});

test('a failed unlink, thrown or rejected, leaves the document fenced', async () => {
  const f = new LinkFence();
  await assert.rejects(f.undo('d', () => Promise.reject(new Error('refused'))));
  assert.equal(f.holds('d', 'e1', 'e1'), false);
  await assert.rejects(f.undo('t', () => { throw new Error('sync throw'); }));
  assert.equal(f.holds('t', 'e1', 'e1'), false);
  assert.equal(f.holds('other', 'e1', 'e1'), true);
  await f.undo('d', async () => {});
  assert.equal(f.holds('d', 'e1', 'e1'), true, 'a later unlink that lands lifts it');
});

test('the actor apply asks the fence before its first write and between its steps', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/actor-sync.mjs', import.meta.url), 'utf8');
  const apply = src.slice(src.indexOf('async _updateActorFromEntity'), src.indexOf('async _onCharacterDeleted'));
  const firstWrite = apply.indexOf('await actor.update(changes');
  assert.ok(apply.indexOf('if (!holds()) return true;') > apply.indexOf('await this._picturePlan'));
  assert.ok(apply.indexOf('if (!holds()) return true;') < firstWrite);
  for (const step of ['_applyIdentityItems', '_recordClassPick', '_replanLayers', "'prototypeToken.hidden'"]) {
    const at = apply.indexOf(step);
    assert.ok(at > 0, step);
    const check = apply.lastIndexOf('if (!holds()) return true;', at);
    assert.ok(check > 0, `${step} has a check before it`);
    const between = apply.slice(check, apply.lastIndexOf('\n', at));
    assert.doesNotMatch(between, /await /, `nothing is awaited between the check and ${step}`);
  }
  // Both actor guards fence the actor while they unlink it.
  assert.equal((src.match(/this\._fence\.undo\(actor\.id, \(\) => this\._unlinkCopy\(actor\)\)/g) || []).length, 2);
});
