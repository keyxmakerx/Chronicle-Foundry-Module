import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptReply, encryptReply, generateRequestKeys } from '../scripts/_stash-crypto.mjs';

// The report path: the GM hands out a public key, the player encrypts to it.
test('only the GM key holder can read a report; a third party cannot', async () => {
  const gm = await generateRequestKeys();
  const thirdParty = await generateRequestKeys();
  const secret = { characterId: 'c1', text: 'my gold is wrong, ask Ari' };
  const envelope = await encryptReply(gm.publicJwk, secret);
  assert.ok(!JSON.stringify(envelope).includes('my gold'));
  assert.deepEqual(await decryptReply(gm.privateKey, envelope), secret);
  await assert.rejects(decryptReply(thirdParty.privateKey, envelope));
});
