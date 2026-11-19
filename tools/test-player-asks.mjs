#!/usr/bin/env node
/**
 * The GM card for a player's change to something that is not theirs: the
 * pure model (`_player-asks.mjs`) and the press (`player-asks.mjs`), which
 * re-reads the pages the player's flag ids name before sending.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from './_journal-test-env.mjs';
import {
  ASK, ASK_STATE, askModel, cardHtml, collectCardKeys, confirmModel, findCardMessage, modelFromFlag, askFlag,
  playersCanView, reviewAsk, sameName, settleModel, trustedCardKey,
} from '../scripts/_player-asks.mjs';

const { PlayerAsks, askFlagOf } = await import('../scripts/player-asks.mjs');

const LABELS = {
  ItemAdd: '{who} added {name} to {where}', ItemRemove: '{who} removed {name} from {where}',
  JournalRemove: '{who} deleted the journal {name}', ActorRemove: '{who} deleted the character {name}',
  RealPage: 'Page {page}', RealCharacter: 'Character {character}', Send: 'Send to Chronicle', NotNow: 'Not now',
};

const itemAdd = (over = {}) => askModel({
  kind: ASK.ITEM_ADD, docId: 'i1', who: 'Mira', name: 'Rope', where: 'Sela',
  link: { entityId: 'sela', targetEntityId: 'rope-page', actorId: 'a1', itemId: 'i1', quantity: 2, equipped: false }, ...over,
});

test('the card reads as one sentence and escapes every player-written string', () => {
  const html = cardHtml(itemAdd({ who: '<img src=x>', name: 'Ro"pe' }), LABELS);
  assert.match(html, /&lt;img src=x&gt; added <b>Ro&quot;pe<\/b>|<b>&lt;img src=x&gt;<\/b> added/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /data-ask-action="send"/);
  assert.match(html, /Not now/);
});

test('a settled card has no buttons', () => {
  const m = settleModel(itemAdd(), ASK_STATE.SENT, 'Gina', 'g1');
  const html = cardHtml(m, LABELS, '✓ Sent by Gina');
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /Sent by Gina/);
});

test('a second answer does not rewrite who answered', () => {
  const first = settleModel(itemAdd(), ASK_STATE.SENT, 'Gina', 'g1');
  assert.equal(settleModel(first, ASK_STATE.DECLINED, 'Bo', 'b1'), first);
  const open = itemAdd();
  assert.equal(settleModel(open, ASK_STATE.CONFIRM, 'x'), open, 'confirm is not an answer');
});

test('one card per change: the key is the kind plus the Foundry document id', () => {
  assert.equal(itemAdd().key, 'item-add:i1');
  assert.notEqual(itemAdd().key, askModel({ kind: ASK.ITEM_REMOVE, docId: 'i1', who: '', name: '' }).key);
});

test('names compare ignoring case and spacing, and an empty name matches nothing', () => {
  assert.ok(sameName('  Rope ', 'rope'));
  assert.ok(sameName('Old  Rope', 'old rope'));
  assert.ok(!sameName('', ''));
  assert.ok(!sameName('Rope', 'Crown of the Realm'));
});

test('matching names send; a mismatch asks for a second press that sends only the same names', () => {
  const m = itemAdd();
  assert.equal(reviewAsk(m, { page: 'rope', character: 'Sela' }).action, 'send');
  const real = { page: 'The Crown', character: 'Sela' };
  const first = reviewAsk(m, real);
  assert.equal(first.action, 'confirm');
  const shown = confirmModel(m, first.reals);
  assert.equal(reviewAsk(shown, real).action, 'send');
  assert.equal(reviewAsk(shown, { page: 'Something else', character: 'Sela' }).action, 'confirm', 'a name that changed since is shown again');
});

test('the confirm card shows the real names', () => {
  const html = cardHtml(confirmModel(itemAdd(), { page: 'The Crown' }), LABELS);
  assert.match(html, /Page <b>The Crown<\/b>/);
  assert.match(html, /data-ask-action="send"/);
});

test('players can view a default page, or a custom one with a public or all-players grant', () => {
  assert.ok(playersCanView({ is_private: false }, { visibility: 'default' }));
  assert.ok(playersCanView({ is_private: false }, null));
  assert.ok(!playersCanView({ is_private: true }, { visibility: 'default' }));
  assert.ok(!playersCanView(null, null));
  assert.ok(playersCanView({}, { visibility: 'custom', permissions: [{ subject_type: 'role', subject_id: '1', permission: 'view' }] }));
  assert.ok(playersCanView({}, { visibility: 'custom', permissions: [{ subject_type: 'public', permission: 'view' }] }));
  assert.ok(!playersCanView({}, { visibility: 'custom', permissions: [{ subject_type: 'user', subject_id: 'm1', permission: 'view' }] }));
  assert.ok(!playersCanView({}, { visibility: 'custom', permissions: [] }));
  assert.ok(!playersCanView({}, { visibility: 'dm_only' }));
});

const flagOf = (m) => m?.flags?.card;
const gm = { isGM: true };
const player = { isGM: false };

test('only a GM-written message is a card, and its key comes from the flag', () => {
  const flag = askFlag(itemAdd());
  assert.equal(trustedCardKey({ author: gm, flags: { card: flag } }, flagOf), 'item-add:i1');
  assert.equal(trustedCardKey({ user: gm, flags: { card: flag } }, flagOf), 'item-add:i1', 'Foundry 12 calls the field user');
  assert.equal(trustedCardKey({ author: player, flags: { card: flag } }, flagOf), null);
  const msgs = [{ author: player, flags: { card: flag } }, { author: gm, flags: { card: askFlag(itemAdd({ docId: 'i2' })) } }];
  assert.deepEqual(collectCardKeys(msgs, flagOf), ['item-add:i2']);
  assert.equal(findCardMessage(msgs, 'item-add:i1', flagOf), null);
});

test('a flag from a different build is not a card', () => {
  assert.equal(modelFromFlag({ model: { key: 'x', kind: 'something-else' } }), null);
  assert.equal(modelFromFlag(null), null);
  assert.equal(modelFromFlag(askFlag(itemAdd())).link.targetEntityId, 'rope-page');
});

// --- the press --------------------------------------------------------------

function world({ entities = {}, perms = {}, relations = [] } = {}) {
  const messages = [];
  const created = [];
  const message = (data) => {
    const msg = {
      author: gm, flags: data.flags, content: data.content,
      getFlag: (_s, k) => msg.flags['chronicle-sync']?.[k],
      update: async (d) => { Object.assign(msg, { content: d.content, flags: d.flags }); },
    };
    return msg;
  };
  globalThis.ChatMessage = {
    getWhisperRecipients: () => [{ id: 'gm' }],
    create: async (data) => { created.push(data); const m = message(data); messages.push(m); return m; },
  };
  globalThis.game.messages = { contents: messages };
  globalThis.game.user = { id: 'gm', name: 'Gina', isGM: true };
  globalThis.game.actors = { get: () => null };
  settings.userMappings = '{}';
  const calls = [];
  const asks = new PlayerAsks();
  asks._api = {
    get: async (p) => {
      calls.push(['GET', p]);
      if (p.endsWith('/permissions')) return perms[p.split('/')[2]] ?? { visibility: 'default' };
      if (p.endsWith('/relations')) return relations;
      const e = entities[p.split('/')[2]];
      if (!e) throw new Error('404');
      return e;
    },
    post: async (p, b) => { calls.push(['POST', p, b]); return { id: 'r9' }; },
    delete: async (p) => { calls.push(['DELETE', p]); },
  };
  return { asks, calls, messages, created };
}

const press = async (asks, key, action = 'send') => { await asks.answer(key, action); };
const stateOf = (messages) => askFlagOf(messages[0]).state;

test('a card is posted once, whispered to the GMs, with the model in a flag', async () => {
  const { asks, messages, created } = world();
  await asks.ask(itemAdd());
  await asks.ask(itemAdd());
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].whisper, ['gm']);
  assert.equal(messages.length, 1);
  assert.equal(askFlagOf(messages[0]).state, 'pending');
});

test('Send on an item the page agrees with makes the same relation the GM\'s own add would', async () => {
  const { asks, calls, messages } = world({ entities: { sela: { name: 'Sela' }, 'rope-page': { name: 'Rope', is_private: false } } });
  await asks.ask(itemAdd());
  await press(asks, 'item-add:i1');
  const post = calls.find((c) => c[0] === 'POST');
  assert.equal(post[1], '/entities/sela/relations');
  assert.deepEqual(post[2], {
    target_entity_id: 'rope-page', relation_type: 'Has Item', reverse_relation_type: 'In Inventory Of',
    metadata: { quantity: 2, equipped: false, foundry_item_name: 'Rope' },
  });
  assert.equal(stateOf(messages), 'sent');
});

test('Send on an item whose link names a different page shows the real name and sends nothing', async () => {
  const { asks, calls, messages } = world({ entities: { sela: { name: 'Sela' }, 'rope-page': { name: 'The Crown' } } });
  await asks.ask(itemAdd());
  await press(asks, 'item-add:i1');
  assert.equal(calls.some((c) => c[0] === 'POST'), false);
  assert.equal(stateOf(messages), 'confirm');
  assert.equal(askFlagOf(messages[0]).model.reals.page, 'The Crown');
  assert.match(messages[0].content, /The Crown/);
  await press(asks, 'item-add:i1');
  assert.equal(calls.filter((c) => c[0] === 'POST').length, 1, 'the second press, with the same names, sends');
  assert.equal(stateOf(messages), 'sent');
});

test('Send is refused for a page players cannot view, even after the GM presses', async () => {
  const { asks, calls, messages } = world({ entities: { sela: { name: 'Sela' }, 'rope-page': { name: 'Rope', is_private: true } } });
  await asks.ask(itemAdd());
  await press(asks, 'item-add:i1');
  assert.equal(calls.some((c) => c[0] === 'POST'), false);
  assert.equal(stateOf(messages), 'refused');
  assert.equal(askFlagOf(messages[0]).model.note, 'Hidden');
});

test('Not now sends nothing and settles the card', async () => {
  const { asks, calls, messages } = world();
  await asks.ask(itemAdd());
  await press(asks, 'item-add:i1', 'decline');
  assert.deepEqual(calls, []);
  assert.equal(stateOf(messages), 'declined');
});

test('a settled card ignores a second press', async () => {
  const { asks, calls, messages } = world({ entities: { sela: { name: 'Sela' }, 'rope-page': { name: 'Rope' } } });
  await asks.ask(itemAdd());
  await press(asks, 'item-add:i1');
  await press(asks, 'item-add:i1');
  assert.equal(calls.filter((c) => c[0] === 'POST').length, 1);
  assert.equal(stateOf(messages), 'sent');
});

test('a message a player wrote is never answered', async () => {
  const { asks, calls, messages } = world({ entities: { sela: { name: 'Sela' }, 'rope-page': { name: 'Rope' } } });
  await asks.ask(itemAdd());
  messages[0].author = player;
  await press(asks, 'item-add:i1');
  assert.equal(calls.length, 0);
});

test('removing a journal or character: Send deletes the page the id names once its name matches', async () => {
  for (const [kind, name] of [[ASK.JOURNAL_REMOVE, 'Notes'], [ASK.ACTOR_REMOVE, 'Sela']]) {
    const { asks, calls, messages } = world({ entities: { e1: { name } } });
    await asks.ask(askModel({ kind, docId: 'd1', who: 'Mira', name, link: { entityId: 'e1' } }));
    await press(asks, `${kind}:d1`);
    assert.deepEqual(calls.find((c) => c[0] === 'DELETE'), ['DELETE', '/entities/e1']);
    assert.equal(stateOf(messages), 'sent');
  }
});

test('removing a journal whose link names another page asks again instead of deleting it', async () => {
  const { asks, calls, messages } = world({ entities: { e1: { name: 'The Throne Room' } } });
  await asks.ask(askModel({ kind: ASK.JOURNAL_REMOVE, docId: 'd1', who: 'Mira', name: 'My notes', link: { entityId: 'e1' } }));
  await press(asks, 'journal-remove:d1');
  assert.equal(calls.some((c) => c[0] === 'DELETE'), false);
  assert.equal(stateOf(messages), 'confirm');
});

test('removing an item deletes only a relation that is on that character', async () => {
  const model = () => askModel({
    kind: ASK.ITEM_REMOVE, docId: 'i1', who: 'Mira', name: 'Rope', where: 'Sela', link: { entityId: 'sela', relationId: '12' },
  });
  const ok = world({ entities: { sela: { name: 'Sela' } }, relations: [{ id: 12, relationType: 'Has Item', targetEntityName: 'Rope' }] });
  await ok.asks.ask(model());
  await press(ok.asks, 'item-remove:i1');
  assert.deepEqual(ok.calls.find((c) => c[0] === 'DELETE'), ['DELETE', '/relations/12']);
  const bad = world({ entities: { sela: { name: 'Sela' } }, relations: [{ id: 99, relationType: 'Has Item', targetEntityName: 'Rope' }] });
  await bad.asks.ask(model());
  await press(bad.asks, 'item-remove:i1');
  assert.equal(bad.calls.some((c) => c[0] === 'DELETE'), false);
  assert.equal(askFlagOf(bad.messages[0]).state, 'refused');
});

test('a failed send leaves a failed card, not a thrown press', async () => {
  const { asks, messages } = world({ entities: { sela: { name: 'Sela' }, 'rope-page': { name: 'Rope' } } });
  asks._api.post = async () => { throw new Error('500'); };
  await asks.ask(itemAdd());
  await press(asks, 'item-add:i1');
  assert.equal(stateOf(messages), 'failed');
});
