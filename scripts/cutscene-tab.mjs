/**
 * Chronicle Sync - the Satchel's Cut scenes tab
 *
 * The cut scenes this player may watch again: Chronicle's list, asked
 * through the GM's client, together with the ones this client received this
 * session, so the tab still works while the GM is away. A row leaves the
 * list the moment its rewatch window closes. Built with DOM APIs, so every
 * name from Chronicle stays inert text.
 */

import { stateBlock } from './_state-block.mjs';
import { mergeShowings, nextExpiryDelay, untilLabel } from './_cutscene-relay.mjs';
import { CHANGED_HOOK, askWatchList, playShowing, rememberedShowings } from './cutscenes.mjs';

const t = (key, data) => (data
  ? game.i18n.format(`CHRONICLE.Cutscenes.${key}`, data)
  : game.i18n.localize(`CHRONICLE.Cutscenes.${key}`));

/** Errors that leave the list to what this client remembers, with a line saying why. */
const NOTICE = {
  no_gm: 'NoticeNoGM',
  timeout: 'NoticeUnreachable',
  unreachable: 'NoticeUnreachable',
  gm_not_ready: 'NoticeUnreachable',
  missing: 'NoticeUnreachable',
  off: 'NoticeOff',
  no_mapping: 'NoticeNoLink',
};

/** The block shown when there is nothing to list, per state. */
function emptyBlock(state) {
  switch (state) {
    case 'loading': return stateBlock('hourglass-half', t('LoadingTitle'), t('Loading'));
    case 'no_gm': return stateBlock('hourglass-half', t('NoGMTitle'), t('NoGM'));
    case 'off': return stateBlock('film', t('OffTitle'), t('Off'));
    case 'no_mapping': return stateBlock('user', t('NoLinkTitle'), t('NoLink'));
    case 'ok': return stateBlock('film', t('EmptyTitle'), t('Empty'));
    default: return null;
  }
}

/**
 * Draw the tab into `pane` and keep it current until destroyed.
 * @param {HTMLElement} pane
 * @returns {{destroy: () => void}}
 */
export function mountCutscenesTab(pane) {
  let alive = true;
  let state = 'loading';
  let fromChronicle = [];
  let timer = null;
  let seq = 0;

  const draw = () => {
    if (!alive) return;
    clearTimeout(timer);
    const now = Date.now();
    const rows = mergeShowings(fromChronicle, rememberedShowings(), now);
    const parts = [];
    if (game.user.isGM) parts.push(stateBlock('film', t('GMTitle'), t('GM')));

    if (rows.length) {
      if (NOTICE[state]) {
        const note = document.createElement('p');
        note.className = 'cs-cutscenes-note';
        note.setAttribute('role', 'status');
        note.textContent = t(NOTICE[state]);
        parts.push(note);
      }
      parts.push(list(rows, now));
    } else if (!game.user.isGM) {
      const block = emptyBlock(state);
      if (block) parts.push(block);
      else parts.push(failedBlock());
    }
    pane.replaceChildren(...parts);
    const wait = nextExpiryDelay(rows, now);
    if (wait !== null) timer = setTimeout(draw, wait);
  };

  const failedBlock = () => {
    const block = stateBlock('triangle-exclamation', t('FailedTitle'), t('Failed'), true);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = t('TryAgain');
    retry.addEventListener('click', () => load());
    block.append(retry);
    return block;
  };

  const load = async () => {
    const mine = ++seq;
    state = 'loading';
    draw();
    const reply = await askWatchList();
    if (!alive || mine !== seq) return;
    if (reply.ok) {
      state = 'ok';
      fromChronicle = reply.data;
    } else {
      state = reply.error?.code || 'unreachable';
      fromChronicle = Array.isArray(reply.data) ? reply.data : [];
    }
    draw();
  };

  const onChanged = () => draw();
  // A GM who comes back fills the list in.
  const onUser = (user, connected) => {
    if (connected && user?.isGM && state !== 'ok' && state !== 'loading') load();
  };
  Hooks.on(CHANGED_HOOK, onChanged);
  Hooks.on('userConnected', onUser);
  load();

  return {
    destroy() {
      alive = false;
      clearTimeout(timer);
      Hooks.off(CHANGED_HOOK, onChanged);
      Hooks.off('userConnected', onUser);
    },
  };
}

function list(rows, now) {
  const ul = document.createElement('ul');
  ul.className = 'cs-cutscenes';
  ul.setAttribute('aria-label', t('ListLabel'));
  for (const s of rows) {
    const li = document.createElement('li');
    li.className = 'cs-cutscene-row';
    const text = document.createElement('div');
    text.className = 'cs-cutscene-text';
    const name = document.createElement('b');
    name.textContent = s.name || t('Untitled');
    const until = document.createElement('span');
    until.className = 'cs-cutscene-until';
    const when = untilLabel(s.rewatchUntil, now, { locale: game.i18n.lang });
    until.textContent = t('Until', { time: when });
    text.append(name, until);
    const watch = document.createElement('button');
    watch.type = 'button';
    watch.className = 'cs-cutscene-watch';
    watch.innerHTML = '<i class="fa-solid fa-play" aria-hidden="true"></i>';
    watch.append(document.createTextNode(t('WatchAgain')));
    watch.setAttribute('aria-label', t('WatchAgainNamed', { name: s.name || t('Untitled') }));
    watch.addEventListener('click', () => {
      // The window may have closed while the list was open.
      if (s.rewatchUntil > Date.now()) playShowing(s);
    });
    li.append(text, watch);
    ul.append(li);
  }
  return ul;
}
