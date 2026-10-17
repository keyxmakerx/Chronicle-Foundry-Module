/**
 * Chronicle Sync - change a creature's form from its token
 *
 * A Chronicle creature with other forms gets a Change form button on its
 * token HUD (GM only). The GM picks the form and, each time, Quiet (the sheet
 * and token just change) or Reveal (the new art grows out of the token on
 * every screen that can see it, holds, and shrinks back before the token
 * changes). The change itself is CreatureSync.changeForm; rules live in
 * _creature-forms.mjs.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { escapeHtml } from './_escape-html.mjs';
import { promptDialog } from './_dialogs.mjs';
import { currentMotion } from './motion.mjs';
import { FORM_FLAG, formChoices } from './_creature-forms.mjs';

const CHANNEL = `module.${MODULE_ID}`;
const MSG_TYPE = 'creature-form';
const REVEAL_MS = 1900;
const STILL_MS = 1400;

const state = { getSync: () => null, busy: new Set() };

/**
 * Hooks for every client: players need the socket to see a reveal.
 * @param {() => import('./creature-sync.mjs').CreatureSync|null} getSync
 */
export function registerCreatureForms(getSync) {
  state.getSync = getSync;
  game.socket.on(CHANNEL, _onSocket);
  Hooks.on('renderTokenHUD', _onRenderHud);
}

function _t(key, data) {
  return data ? game.i18n.format(`CHRONICLE.Forms.${key}`, data) : game.i18n.localize(`CHRONICLE.Forms.${key}`);
}

function _onSocket(data, senderId) {
  if (data?.type !== MSG_TYPE || data.action !== 'reveal') return;
  // Only a GM's reveal plays; senderId comes from Foundry's server.
  if (!game.users?.get(senderId)?.isGM) return;
  playReveal(data).catch(() => {});
}

/* ---------------- Token HUD ---------------- */

function _onRenderHud(hud, html) {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const col = root?.querySelector('.col.right');
  const token = hud?.object;
  const sync = state.getSync();
  if (!col || !token || !sync) return;
  col.querySelectorAll('.chronicle-form-hud').forEach((el) => el.remove());
  const found = sync.creatureFor(token.document);
  if (!found) return;
  // The button appears once the page's forms are known, and only if it has some.
  sync.formsFor(found.entityId).then(({ forms }) => {
    if (!forms.length || !col.isConnected || col.querySelector('.chronicle-form-hud')) return;
    const tag = col.querySelector('.control-icon')?.tagName === 'BUTTON' ? 'button' : 'div';
    const el = document.createElement(tag);
    if (tag === 'button') el.type = 'button';
    el.className = 'control-icon chronicle-form-hud';
    el.dataset.tooltip = _t('Hud');
    el.setAttribute('aria-label', _t('Hud'));
    el.innerHTML = '<i class="fa-solid fa-masks-theater"></i>';
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hud.close?.();
      openPicker(token.document);
    });
    col.appendChild(el);
  }).catch((err) => console.warn('Chronicle Sync | Could not read this creature\'s forms', err));
}

/* ---------------- Picker ---------------- */

/** Ask which form and how, then change. Quiet or Reveal is asked every time. */
export async function openPicker(tokenDoc) {
  const sync = state.getSync();
  const found = sync?.creatureFor(tokenDoc);
  if (!found || state.busy.has(found.entityId)) return;
  let forms;
  try {
    ({ forms } = await sync.formsFor(found.entityId));
  } catch (err) {
    console.warn('Chronicle Sync | Could not read this creature\'s forms', err);
    ui.notifications?.warn(_t('LoadFailed'));
    return;
  }
  const current = found.actor.getFlag(FLAG_SCOPE, FORM_FLAG) || '';
  const known = forms.some((f) => f.id === current) ? current : '';
  const rows = formChoices(found.actor.name, forms, known);
  const first = rows.find((r) => !r.current);
  const content = `<form class="chronicle-form-picker">
    <fieldset><legend>${escapeHtml(_t('ChangeTo'))}</legend>
      ${rows.map((r) => `<label class="chronicle-form-picker-row"><input type="radio" name="form" value="${escapeHtml(r.id)}"${r === first ? ' checked' : ''}${r.current ? ' disabled' : ''}> <span>${escapeHtml(r.name)}</span>${r.current ? `<span class="chronicle-form-picker-now">${escapeHtml(_t('Now'))}</span>` : ''}</label>`).join('')}
    </fieldset>
    <fieldset><legend>${escapeHtml(_t('How'))}</legend>
      <label class="chronicle-form-picker-row"><input type="radio" name="how" value="quiet"> <span><b>${escapeHtml(_t('Quiet'))}</b> ${escapeHtml(_t('QuietHint'))}</span></label>
      <label class="chronicle-form-picker-row"><input type="radio" name="how" value="reveal" checked> <span><b>${escapeHtml(_t('Reveal'))}</b> ${escapeHtml(_t('RevealHint'))}</span></label>
    </fieldset>
  </form>`;
  const pick = await promptDialog({
    title: _t('Title', { name: found.actor.name }),
    content,
    label: _t('Go'),
    callback: (root) => {
      const form = root?.querySelector?.('form.chronicle-form-picker');
      const to = form?.querySelector('input[name="form"]:checked');
      const how = form?.querySelector('input[name="how"]:checked')?.value === 'quiet' ? 'quiet' : 'reveal';
      return to ? { formId: to.value, how } : null;
    },
  });
  if (!pick) return;
  await changeForm(tokenDoc, pick.formId, pick.how);
}

/** Change form, with the reveal when asked for, and tell the table. */
export async function changeForm(tokenDoc, formId, how) {
  const sync = state.getSync();
  const found = sync?.creatureFor(tokenDoc);
  if (!found || state.busy.has(found.entityId)) return;
  state.busy.add(found.entityId);
  const name = tokenDoc.name || found.actor.name;
  try {
    const before = how === 'reveal'
      ? async ({ img, name: formName }) => {
        const payload = { type: MSG_TYPE, action: 'reveal', sceneId: tokenDoc.parent?.id, tokenId: tokenDoc.id, img, name: formName };
        game.socket.emit(CHANNEL, payload);
        await playReveal(payload);
      }
      : null;
    const result = await sync.changeForm(tokenDoc, formId, { before });
    const line = _t('Became', { name: escapeHtml(name), form: escapeHtml(result.formName) });
    const hits = result.stamina.map((s) => _t('StaminaLeft', { name: escapeHtml(s.name), value: s.value, max: s.max })).join(' ');
    const speaker = ChatMessage.getSpeaker?.({ token: tokenDoc }) ?? {};
    // Players hear of a reveal; Stamina is the GM's alone.
    if (how === 'reveal' && !tokenDoc.hidden) await ChatMessage.create({ speaker, content: `<p>${line}</p>` });
    await ChatMessage.create({
      speaker,
      whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
      content: `<p>${how === 'reveal' ? '' : `${line} `}${hits}</p>`,
    });
    if (!result.recorded) ui.notifications?.warn(_t('NotRecorded'));
  } catch (err) {
    console.warn('Chronicle Sync | Change of form failed', err);
    ui.notifications?.error(_t('Failed', { name }));
  } finally {
    state.busy.delete(found.entityId);
  }
}

/* ---------------- Reveal ---------------- */

/** Where a token sits on screen, or the middle of the window. */
function _tokenPoint(token) {
  try {
    const p = canvas.stage.worldTransform.apply(token.center);
    const r = canvas.app.view.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  } catch {
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }
}

/**
 * The new art, big in the middle of the screen: grown out of the token at
 * Full motion, faded at Calm, simply shown at Off. Resolves when it is gone.
 * A viewer who can't see the token sees nothing.
 */
export function playReveal(p) {
  const sameScene = !!canvas?.ready && canvas.scene?.id === p.sceneId;
  const token = sameScene ? canvas.tokens?.get(p.tokenId) : null;
  if (!token || (!game.user.isGM && (token.document.hidden || !token.visible))) return Promise.resolve();
  const el = document.createElement('div');
  el.className = 'chronicle-form-reveal';
  el.setAttribute('aria-hidden', 'true');
  const card = document.createElement('div');
  card.className = 'chronicle-form-reveal-card';
  if (p.img) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = p.img;
    // A picture that fails leaves the name card.
    img.addEventListener('error', () => img.remove());
    card.appendChild(img);
  }
  const label = document.createElement('b');
  label.textContent = String(p.name ?? '');
  card.appendChild(label);
  el.appendChild(card);
  document.body.appendChild(el);

  return new Promise((resolve) => {
    const finish = () => { el.remove(); resolve(); };
    const motion = currentMotion();
    if (motion === 'off' || !card.animate) { setTimeout(finish, STILL_MS); return; }
    let frames = [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }];
    if (motion === 'full') {
      const at = _tokenPoint(token);
      const c = card.getBoundingClientRect();
      const from = `translate(${at.x - (c.left + c.width / 2)}px, ${at.y - (c.top + c.height / 2)}px) scale(0.3)`;
      frames = [{ transform: from, opacity: 0 }, { transform: 'none', opacity: 1, offset: 0.25 },
        { transform: 'none', opacity: 1, offset: 0.75 }, { transform: from, opacity: 0 }];
    }
    const a = card.animate(frames, { duration: REVEAL_MS, easing: 'cubic-bezier(.2,.7,.2,1)' });
    a.onfinish = finish;
    a.oncancel = finish;
  });
}
