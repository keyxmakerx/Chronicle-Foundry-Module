#!/usr/bin/env node
/**
 * Tests for scripts/_stash-crypto.mjs: a reply is readable only by the window
 * whose key it was made for.
 *
 * Run: `node --test tools/test-stash-crypto.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { decryptReply, encryptReply, generateRequestKeys, isPublicJwk } from '../scripts/_stash-crypto.mjs';

const REPLY = { ok: true, data: { character: { id: 'c1', name: 'Aria', money: 3 } } };

test('round trip: the asking window decrypts what the GM sent', async () => {
  const asker = await generateRequestKeys();
  const envelope = await encryptReply(asker.publicJwk, REPLY);
  assert.deepEqual(await decryptReply(asker.privateKey, envelope), REPLY);
});

test('a third party with only public data cannot decrypt', async () => {
  const asker = await generateRequestKeys();
  const eavesdropper = await generateRequestKeys();
  const envelope = await encryptReply(asker.publicJwk, REPLY);
  // Everything on the wire: the request's public key and the whole envelope.
  await assert.rejects(decryptReply(eavesdropper.privateKey, envelope));
  assert.equal(JSON.stringify(envelope).includes('Aria'), false);
});

test('the request public key alone does not open the envelope', async () => {
  const asker = await generateRequestKeys();
  const envelope = await encryptReply(asker.publicJwk, REPLY);
  assert.equal(asker.publicJwk.d, undefined, 'the private part never leaves');
  assert.equal(JSON.stringify(envelope).includes(asker.publicJwk.x) && envelope.ciphertext.includes(asker.publicJwk.x), false);
});

test('a tampered ciphertext is rejected', async () => {
  const asker = await generateRequestKeys();
  const envelope = await encryptReply(asker.publicJwk, REPLY);
  const bytes = Buffer.from(envelope.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  await assert.rejects(decryptReply(asker.privateKey, { ...envelope, ciphertext: bytes.toString('base64') }));
});

test('each reply uses a fresh GM key and iv', async () => {
  const asker = await generateRequestKeys();
  const a = await encryptReply(asker.publicJwk, REPLY);
  const b = await encryptReply(asker.publicJwk, REPLY);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.gmPublicKey.x, b.gmPublicKey.x);
});

test('a missing or malformed envelope rejects', async () => {
  const asker = await generateRequestKeys();
  await assert.rejects(decryptReply(asker.privateKey, null));
  await assert.rejects(decryptReply(asker.privateKey, { gmPublicKey: {}, iv: '', ciphertext: '' }));
});

test('isPublicJwk accepts a P-256 public key and refuses private or foreign keys', async () => {
  const k = await generateRequestKeys();
  assert.equal(isPublicJwk(k.publicJwk), true);
  assert.equal(isPublicJwk({ ...k.publicJwk, d: 'secret' }), false);
  assert.equal(isPublicJwk({ ...k.publicJwk, crv: 'P-384' }), false);
  assert.equal(isPublicJwk(null), false);
  assert.equal(isPublicJwk('x'), false);
});
