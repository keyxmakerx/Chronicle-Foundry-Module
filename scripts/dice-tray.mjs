/**
 * Chronicle Sync - the dice button by the chat box. Players who don't know
 * the /roll syntax open a small tray, pick dice and a modifier (or, in a
 * Draw Steel world, a power roll on one of their hero's characteristics) and
 * roll. Every roll is an ordinary Foundry roll posted in the chat's current
 * roll mode, so Dice So Nice, the shared-rolls relay and whispers all treat
 * it like a typed /roll. The rules are in _dice-tray.mjs.
 *
 * Works without a Chronicle connection: it is a Foundry convenience, shown
 * to every user who leaves the client setting on.
 */

import { MODULE_ID } from './constants.mjs';
import { log } from './logger.mjs';
import { escapeHtml } from './_escape-html.mjs';
import {
  DIE_SIDES, addDie, characteristicChoices, createPool, dieOutline, formulaOf,
  poolIsEmpty, powerRollFormula, setModifier, signed,
} from './_dice-tray.mjs';

const SETTING = 'diceTray';
const BUTTON_CLASS = 'chronicle-dice-button';
const PANEL_ID = 'chronicle-dice-tray';
const t = (key) => game.i18n.localize(`CHRONICLE.DiceTray.${key}`);

/** The pool survives closing the tray, so a half-built roll is still there next time. */
let pool = createPool();
let panel = null;
let anchor = null;

export function registerDiceTraySetting() {
  game.settings.register(MODULE_ID, SETTING, {
    name: 'CHRONICLE.DiceTray.Setting.Name',
    hint: 'CHRONICLE.DiceTray.Setting.Hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
    onChange: () => placeButtons(),
  });
}

export function registerDiceTray() {
  // v12 renders the chat as ChatLog (and ChatPopout); v13+ re-renders parts of
  // ChatLog and moves its input box when the sidebar folds. Each render
  // re-checks the whole page, since the moved box may sit outside the
  // rendered element, and the button is added once per controls row.
  for (const hook of ['renderChatLog', 'renderChatPopout', 'renderChatInput']) {
    Hooks.on(hook, () => placeButtons());
  }
  placeButtons();
}

function wanted() {
  try {
    return game.settings.get(MODULE_ID, SETTING) !== false;
  } catch {
    return true;
  }
}

/** The rows beside the chat box that hold the export and clear buttons. */
function controlRows() {
  return [...document.querySelectorAll('#chat-controls .control-buttons, .chat-controls .control-buttons')];
}

function placeButtons() {
  const show = wanted();
  if (!show) {
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((b) => b.remove());
    closeTray();
    return;
  }
  for (const row of controlRows()) {
    if (row.querySelector(`.${BUTTON_CLASS}`)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    // Foundry's own chat buttons are ui-control icons with the glyph on the
    // button itself; wearing the same classes gives this one their size and
    // centring instead of a second, drifting copy of them.
    button.className = `ui-control icon fa-solid fa-dice-d20 ${BUTTON_CLASS}`;
    button.dataset.tooltip = t('Open');
    button.setAttribute('aria-label', t('Open'));
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (panel && anchor === button) closeTray();
      else openTray(button);
    });
    row.prepend(button);
  }
}

/** Whose characteristics a power roll uses: the user's own hero, else the token they control. */
function rollingActor() {
  const own = game.user?.character;
  if (own) return own;
  return canvas?.tokens?.controlled?.[0]?.actor ?? null;
}

function isDrawSteel() {
  return game.system?.id === 'draw-steel';
}

function openTray(button) {
  closeTray();
  anchor = button;
  anchor.setAttribute('aria-expanded', 'true');
  panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('Title'));
  document.body.append(panel);
  render();
  position();
  panel.querySelector('.cdt-die, .cdt-char')?.focus();
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', position);
}

function closeTray() {
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', position);
  panel?.remove();
  panel = null;
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'false');
    if (anchor.isConnected && document.activeElement === document.body) anchor.focus();
  }
  anchor = null;
}

function onOutside(event) {
  if (!panel || panel.contains(event.target) || anchor?.contains(event.target)) return;
  closeTray();
}

function onKey(event) {
  if (event.key !== 'Escape' || !panel) return;
  event.stopPropagation();
  event.preventDefault();
  closeTray();
}

/** Above the button, its right edge on the button's, kept on screen. */
function position() {
  if (!panel || !anchor?.isConnected) return closeTray();
  const r = anchor.getBoundingClientRect();
  const gap = 6;
  const width = panel.offsetWidth;
  const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
  panel.style.left = `${left}px`;
  if (r.top - gap - panel.offsetHeight >= 8) {
    panel.style.top = '';
    panel.style.bottom = `${window.innerHeight - r.top + gap}px`;
  } else {
    panel.style.bottom = '';
    panel.style.top = `${r.bottom + gap}px`;
  }
}

function powerSection() {
  if (!isDrawSteel()) return '';
  const actor = rollingActor();
  if (!actor) {
    return `<div class="cdt-group"><h3 class="cdt-label">${escapeHtml(t('PowerRoll'))}</h3>`
      + `<p class="cdt-note">${escapeHtml(t('NoHero'))}</p></div>`;
  }
  const chars = characteristicChoices(actor.system?.characteristics);
  const buttons = chars.map((c) => {
    const name = game.i18n.localize(`CHRONICLE.DiceTray.Char.${c.key}`);
    return `<button type="button" class="cdt-char" data-char="${c.key}">`
      + `<span class="cdt-char-name">${escapeHtml(name)}</span>`
      + `<span class="cdt-char-value">${escapeHtml(signed(c.value))}</span></button>`;
  }).join('');
  return `<div class="cdt-group"><h3 class="cdt-label">${escapeHtml(t('PowerRoll'))}`
    + ` <span class="cdt-who">${escapeHtml(actor.name ?? '')}</span></h3>`
    + `<div class="cdt-chars">${buttons}</div></div>`;
}

function render() {
  if (!panel) return;
  const formula = formulaOf(pool);
  const dice = DIE_SIDES.map((s) => {
    const n = pool.counts[s] ?? 0;
    const label = n ? `${n}d${s}` : `d${s}`;
    return `<button type="button" class="cdt-die${n ? ' is-picked' : ''}" data-sides="${s}"`
      + ` aria-label="${escapeHtml(game.i18n.format('CHRONICLE.DiceTray.AddDie', { die: `d${s}` }))}">`
      + `${dieOutline(s)}<span class="cdt-die-name">${label}</span></button>`;
  }).join('');
  panel.innerHTML = `
    <header class="cdt-head">
      <h2>${escapeHtml(t('Title'))}</h2>
      <button type="button" class="cdt-close" data-action="close" aria-label="${escapeHtml(t('Close'))}" data-tooltip="${escapeHtml(t('Close'))}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
    </header>
    ${powerSection()}
    <div class="cdt-group">
      <h3 class="cdt-label">${escapeHtml(t('Dice'))}</h3>
      <div class="cdt-dice">${dice}</div>
      <p class="cdt-note">${escapeHtml(t('RemoveHint'))}</p>
    </div>
    <div class="cdt-group cdt-mod-row">
      <label class="cdt-label" for="cdt-mod">${escapeHtml(t('Modifier'))}</label>
      <div class="cdt-stepper">
        <button type="button" data-action="mod-down" aria-label="${escapeHtml(t('Less'))}"><i class="fa-solid fa-minus" aria-hidden="true"></i></button>
        <input id="cdt-mod" type="number" inputmode="numeric" step="1" min="-99" max="99" value="${pool.modifier}">
        <button type="button" data-action="mod-up" aria-label="${escapeHtml(t('More'))}"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>
      </div>
    </div>
    <footer class="cdt-foot">
      <output class="cdt-formula" aria-live="polite">${escapeHtml(formula || t('Empty'))}</output>
      <button type="button" class="cdt-clear" data-action="clear"${poolIsEmpty(pool) && !pool.modifier ? ' hidden' : ''}>${escapeHtml(t('Clear'))}</button>
      <button type="button" class="cdt-roll" data-action="roll"${formula ? '' : ' disabled'}>${escapeHtml(t('Roll'))}</button>
    </footer>`;
  bind();
}

/** Re-render, keeping focus on the control that had it. */
function update(next) {
  pool = next;
  const focused = document.activeElement;
  const key = focused?.dataset?.sides ?? focused?.dataset?.action ?? (focused?.id === 'cdt-mod' ? 'mod' : null);
  render();
  position();
  if (!key) return;
  const again = key === 'mod'
    ? panel.querySelector('#cdt-mod')
    : panel.querySelector(`[data-sides="${key}"], [data-action="${key}"]`);
  (again && !again.disabled && !again.hidden ? again : panel.querySelector('.cdt-die'))?.focus();
}

function bind() {
  panel.querySelectorAll('.cdt-die').forEach((b) => {
    const sides = Number(b.dataset.sides);
    b.addEventListener('click', (e) => update(addDie(pool, sides, e.shiftKey ? -1 : 1)));
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      update(addDie(pool, sides, -1));
    });
  });
  panel.querySelectorAll('.cdt-char').forEach((b) => {
    b.addEventListener('click', () => rollCharacteristic(b.dataset.char));
  });
  const mod = panel.querySelector('#cdt-mod');
  mod.addEventListener('change', () => update(setModifier(pool, mod.value)));
  mod.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    pool = setModifier(pool, mod.value);
    rollPool();
  });
  const on = (action, fn) => panel.querySelector(`[data-action="${action}"]`)?.addEventListener('click', fn);
  on('close', () => closeTray());
  on('mod-down', () => update(setModifier(pool, pool.modifier - 1)));
  on('mod-up', () => update(setModifier(pool, pool.modifier + 1)));
  on('clear', () => update(createPool()));
  on('roll', () => rollPool());
}

async function rollPool() {
  const formula = formulaOf(pool);
  if (!formula) return;
  closeTray();
  try {
    const roll = new Roll(formula);
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: rollingActor() ?? undefined }) });
  } catch (err) {
    log.warn('Dice tray roll failed', err);
    ui.notifications?.error(t('Failed'));
  }
}

/**
 * A power roll on one characteristic. The Draw Steel system's own test is
 * used when it offers one, so edges, banes and its chat card stay its own;
 * otherwise a plain 2d10 plus the characteristic.
 */
async function rollCharacteristic(key) {
  const actor = rollingActor();
  if (!actor) return;
  closeTray();
  try {
    if (typeof actor.system?.rollCharacteristic === 'function') {
      await actor.system.rollCharacteristic(key);
      return;
    }
    const value = characteristicChoices(actor.system?.characteristics).find((c) => c.key === key)?.value ?? 0;
    const roll = new Roll(powerRollFormula(value));
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: game.i18n.localize(`CHRONICLE.DiceTray.Char.${key}`),
    });
  } catch (err) {
    log.warn('Dice tray power roll failed', err);
    ui.notifications?.error(t('Failed'));
  }
}
