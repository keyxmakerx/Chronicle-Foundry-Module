#!/usr/bin/env node
/**
 * Every relay where a player's client asks the GM's client to call Chronicle
 * limits how often each player may ask: each request spends the GM's API key
 * and rate budget. The limiter itself is pinned in tools/test-quest-relay.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('stash, crafting and shop requests are limited per player before Chronicle is called', () => {
  const stash = read('scripts/stash-sync.mjs');
  const handle = stash.slice(stash.indexOf('async handleRequest('));
  assert.ok(handle.indexOf('this._askLimit(senderId)') > 0);
  assert.ok(handle.indexOf('this._askLimit(senderId)') < handle.indexOf('this.execute(plan.call)'));

  const craft = read('scripts/crafting-relay.mjs');
  const run = craft.slice(craft.indexOf('async handleRequest('), craft.indexOf('async run('));
  assert.ok(run.indexOf('askLimit(senderId)') > 0 && run.indexOf('askLimit(senderId)') < run.indexOf('this.run('));

  const shop = read('scripts/shop-room-window.mjs');
  const buy = shop.slice(shop.indexOf('async function onBuyRequest('));
  assert.ok(buy.indexOf('buyLimit(senderId)') > 0 && buy.indexOf('buyLimit(senderId)') < buy.indexOf('buyRelay(user, req)'));
});
