/**
 * Chronicle Sync - Link to Chronicle (every client)
 *
 * A player sync could not match links themselves: Chronicle shows them a
 * short code on the hero they claimed, and they type it here once. A
 * player's client holds no API key, so the code goes to the active GM's
 * client, which redeems it (`POST /sync/link-code`) and links the Foundry
 * user who sent it, taken from the socket layer, never from the message.
 * Every client hears the module socket, so the code travels encrypted to a
 * key the GM's client made for this session: another player cannot read it
 * and use it first. `_link-code.mjs` holds the pure rules.
 */

import { MODULE_ID } from './constants.mjs';
import { getSetting, setSetting, getUserMappings, setUserMappings } from './settings.mjs';
import { escapeHtml, noticeText } from './_escape-html.mjs';
import { choiceDialog } from './_dialogs.mjs';
import { decryptReply, encryptReply, generateRequestKeys, isPublicJwk } from './_stash-crypto.mjs';
import { PendingRequests, isAnsweringGM } from './_stash-relay.mjs';
import { makeAskLimiter } from './_quest-relay.mjs';
import { LINK_MESSAGE, cleanCode, linkMappings, isLinked, offersLink, outcomeKey } from './_link-code.mjs';

const SOCKET_CHANNEL = `module.${MODULE_ID}`;

/** Wrong codes are also counted by Chronicle; this keeps a looping client off the GM's key. */
const askLimit = makeAskLimiter({ max: 5, windowMs: 60000 });
const pending = new PendingRequests({ timeoutMs: 10000 });

/** GM side: this session's key pair, made on the first request. */
let gmKeys = null;
let getApi = () => null;
let offered = false;

const t = (key, data) => (data
  ? game.i18n.format(`CHRONICLE.PlayerLink.${key}`, data)
  : game.i18n.localize(`CHRONICLE.PlayerLink.${key}`));

/** Whether this world is connected to Chronicle (the same test players' tools use). */
function connected() {
  try {
    return !!getSetting('apiUrl') && !!getSetting('campaignId');
  } catch {
    return false;
  }
}

/** Whether the scene controls should offer this player "Link to Chronicle". */
export function linkToolWanted() {
  return !game.user?.isGM && connected() && !isLinked(getUserMappings(), game.user?.id);
}

/**
 * Listen on the module socket and offer the window to an unlinked player.
 * Called once at ready on every client.
 * @param {() => import('./api-client.mjs').ChronicleAPI|null} apiGetter - the GM's API.
 */
export function registerPlayerLink(apiGetter) {
  getApi = apiGetter;
  game.socket.on(SOCKET_CHANNEL, (data, senderId) => {
    if (data?.type !== LINK_MESSAGE) return;
    if (data.action === 'key-reply' || data.action === 'result') {
      // Answers count only from a GM, and only for the asking client.
      if (game.users.get(senderId)?.isGM === true && data.toUserId === game.user.id) {
        pending.settle(data.requestId, data);
      }
      return;
    }
    if (isAnsweringGM(game.user, game.users.activeGM)) answer(data, senderId);
  });
  Hooks.on('chronicleUserMappingsChanged', () => ui.controls?.render?.({ reset: true }));
  if (game.user.isGM) return;
  maybeOffer();
  // A GM who joins later can answer, so the window may open then.
  Hooks.on('userConnected', (user, isConnected) => { if (isConnected && user?.isGM) maybeOffer(); });
}

function maybeOffer() {
  if (offered || !game.users.activeGM) return;
  let dismissed = false;
  try {
    dismissed = getSetting('linkPromptDismissed') === true;
  } catch { /* treat as not dismissed */ }
  if (!offersLink({ isGM: game.user.isGM, connected: connected(), linked: isLinked(getUserMappings(), game.user.id), dismissed })) return;
  offered = true;
  openLinkWindow({ fromJoin: true });
}

/**
 * The window: one box for the code. Shows the last try's problem when the
 * code was wrong, so the player can fix it in place.
 * @param {{fromJoin?: boolean, problem?: string}} [opts]
 */
export async function openLinkWindow({ fromJoin = false, problem = '' } = {}) {
  const content = `<p>${t('Intro')}</p>`
    + (problem ? `<p class="chronicle-link-problem" role="alert">${escapeHtml(problem)}</p>` : '')
    + `<div class="form-group"><label for="chronicle-link-code">${escapeHtml(t('Label'))}</label>`
    + `<input id="chronicle-link-code" name="code" type="text" autocomplete="off" spellcheck="false"`
    + ` maxlength="9" placeholder="K7Q-2MX" class="chronicle-link-code"></div>`;
  const res = await choiceDialog({
    title: t('Title'),
    content,
    buttons: [
      { action: 'link', label: t('Link'), default: true },
      { action: 'later', label: t('NotNow') },
    ],
    read: (root) => root?.querySelector?.('input[name="code"]')?.value ?? '',
  });
  if (res?.action !== 'link') {
    if (fromJoin) await setSetting('linkPromptDismissed', true).catch(() => {});
    return;
  }
  const code = cleanCode(res.value);
  if (!code) return openLinkWindow({ problem: t('BadCode') });
  const outcome = await sendCode(code);
  const key = outcomeKey(outcome.status);
  if (key === 'Linked') {
    ui.notifications?.info(t('Linked', { name: noticeText(outcome.name || '') }));
    return undefined;
  }
  if (key === 'WrongCode') return openLinkWindow({ problem: t('WrongCode') });
  ui.notifications?.warn(t(key));
  return undefined;
}

/** Player side: fetch the GM's key, then send the code sealed to it. */
async function sendCode(code) {
  if (!game.users.activeGM) return { status: 504 };
  const ask = pending.create();
  game.socket.emit(SOCKET_CHANNEL, { type: LINK_MESSAGE, action: 'key', requestId: ask.id });
  const keyReply = await ask.promise;
  if (!isPublicJwk(keyReply?.publicKey)) return { status: keyReply?.error?.code === 'timeout' ? 504 : 502 };
  let envelope;
  try {
    envelope = await encryptReply(keyReply.publicKey, { code });
  } catch {
    return { status: 502 };
  }
  const send = pending.create();
  game.socket.emit(SOCKET_CHANNEL, { type: LINK_MESSAGE, action: 'redeem', requestId: send.id, envelope });
  const result = await send.promise;
  if (result?.error?.code === 'timeout') return { status: 504 };
  return { status: Number(result?.status) || 502, name: typeof result?.name === 'string' ? result.name : '' };
}

/** GM side: hand out the session key, or redeem a sealed code. */
async function answer(data, senderId) {
  const user = game.users.get(senderId);
  if (!user || user.isGM || typeof data.requestId !== 'string' || data.requestId.length > 64) return;
  const reply = (body) => game.socket.emit(SOCKET_CHANNEL, {
    type: LINK_MESSAGE, requestId: data.requestId, toUserId: senderId, ...body,
  });
  try {
    if (!gmKeys) gmKeys = await generateRequestKeys();
    if (data.action === 'key') {
      reply({ action: 'key-reply', publicKey: gmKeys.publicJwk });
      return;
    }
    if (data.action !== 'redeem') return;
    if (!askLimit(senderId)) {
      reply({ action: 'result', status: 429 });
      return;
    }
    let code = null;
    try {
      code = cleanCode((await decryptReply(gmKeys.privateKey, data.envelope))?.code);
    } catch { /* unreadable: a wrong code */ }
    const api = getApi();
    if (!code) {
      reply({ action: 'result', status: 404 });
      return;
    }
    if (!api) {
      reply({ action: 'result', status: 504 });
      return;
    }
    const member = await api.post('/sync/link-code', { code });
    if (!member?.userId) throw Object.assign(new Error('no member'), { status: 502 });
    await setUserMappings(linkMappings(getUserMappings(), String(member.userId), senderId));
    reply({ action: 'result', status: 200, name: String(member.displayName ?? '').slice(0, 100) });
    ui.notifications?.info(t('GMLinked', { user: noticeText(user.name), name: noticeText(member.displayName ?? '') }));
  } catch (err) {
    const s = Number(err?.status);
    reply({ action: 'result', status: s === 404 || s === 429 ? s : 502 });
  }
}
