/**
 * Chronicle Sync - Stashes (every client)
 *
 * The one place a Stashes window gets answers from. On the GM client that is
 * the GM service directly; on a player client it is the active GM over the
 * module socket. Also owns the socket listener every client runs, which
 *  - hands replies to the window that asked,
 *  - turns the GM's downtime/refresh notices into a local hook,
 *  - on the active GM, answers players' requests.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { getSetting } from './settings.mjs';
import { SOCKET_CHANNEL, getStashSync } from './stash-sync.mjs';
import {
  PendingRequests,
  STASH_MSG,
  isAnsweringGM,
  isStashMessage,
} from './_stash-relay.mjs';
import { showStashButton } from './_stash-probe.mjs';

const pending = new PendingRequests();

/** Whether Chronicle offers Stashes in this world (shared by the GM client). */
export function stashesAvailable() {
  try {
    return getSetting('stashesAvailable') === true;
  } catch {
    return false;
  }
}

/**
 * Whether the current user gets a Stashes button on this actor.
 * @param {Actor} actor
 * @returns {boolean}
 */
export function canOpenStashes(actor) {
  if (!actor) return false;
  return showStashButton({
    available: stashesAvailable(),
    isGM: game.user.isGM,
    // Only characters synced from Chronicle carry an entity id.
    isCharacter: true,
    linked: !!actor.getFlag(FLAG_SCOPE, 'entityId'),
    owns: actor.testUserPermission(game.user, 'OWNER'),
  });
}

/**
 * Ask for a view, a history or a move.
 * @param {object} msg - `{action, characterId, move?, contextCharacterId?}`
 * @returns {Promise<{ok: boolean, data?: any, error?: {code: string, message: string}}>}
 */
export async function stashRequest(msg) {
  if (game.user.isGM) {
    const gm = getStashSync();
    if (!gm) return { ok: false, error: { code: 'gm_not_ready', message: game.i18n.localize('CHRONICLE.Stashes.Error.GMNotReady') } };
    return gm.runDirect(msg);
  }
  if (!game.users.activeGM) {
    return { ok: false, error: { code: 'no_gm', message: game.i18n.localize('CHRONICLE.Stashes.Error.NoGM') } };
  }
  const { id, promise } = pending.create();
  // No user id goes in the payload: the GM client takes the sender from the
  // socket layer.
  game.socket.emit(SOCKET_CHANNEL, { type: STASH_MSG.REQUEST, requestId: id, ...msg });
  return promise;
}

/** Turn a request error into the sentence the window shows. */
export function describeError(error) {
  const t = (key, data) => (data
    ? game.i18n.format(`CHRONICLE.Stashes.Error.${key}`, data)
    : game.i18n.localize(`CHRONICLE.Stashes.Error.${key}`));
  switch (error?.code) {
    case 'no_gm': return t('NoGM');
    case 'timeout': return t('Timeout');
    case 'no_mapping': return t('NoMapping');
    case 'not_owner': return t('NotOwner');
    case 'forbidden': return t('Forbidden');
    case 'not_found': return t('NotFound');
    case 'conflict': return t('Conflict', { message: error.message || '' });
    case 'bad_request': return t('BadRequest');
    case 'gm_not_ready': return t('GMNotReady');
    case 'cancelled': return t('Cancelled');
    default: return t('Generic');
  }
}

/** Cancel everything this client is waiting on (a window closing). */
export function cancelStashRequests() {
  pending.cancelAll();
}

/**
 * Start listening on the module socket. Called once at ready on every client.
 * The second argument Foundry gives a socket listener is the sender's user id.
 */
export function registerStashSocket() {
  game.socket.on(SOCKET_CHANNEL, (data, senderId) => {
    if (!isStashMessage(data)) return;
    // Answers and notices count only from a GM, so a player cannot forge them.
    const fromGM = game.users.get(senderId)?.isGM === true;
    switch (data.type) {
      case STASH_MSG.REQUEST:
        // Only the active GM answers; everyone else ignores requests.
        if (isAnsweringGM(game.user, game.users.activeGM)) {
          getStashSync()?.handleRequest(data, senderId);
        }
        break;
      case STASH_MSG.REPLY:
        // Replies are addressed with `recipients`; the id check is a second
        // filter for a client that still sees one.
        if (fromGM && data.toUserId === game.user.id && typeof data.requestId === 'string') {
          pending.settle(data.requestId, { ok: data.ok === true, data: data.data, error: data.error });
        }
        break;
      case STASH_MSG.DOWNTIME:
        if (fromGM) Hooks.callAll('chronicleStashChanged', { kind: 'downtime', open: data.open === true });
        break;
      case STASH_MSG.REFRESH:
        if (fromGM) {
          Hooks.callAll('chronicleStashChanged', {
            kind: 'refresh',
            characterIds: Array.isArray(data.characterIds) ? data.characterIds.map(String) : [],
          });
        }
        break;
    }
  });
}
