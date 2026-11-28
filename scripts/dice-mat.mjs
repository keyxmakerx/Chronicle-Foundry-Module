/**
 * Chronicle Sync - the Dice mat
 *
 * Chronicle's shared dice mat in a Foundry panel: the public rolls of the
 * table, each under its roller's name tag, whether made in Chronicle or in
 * Foundry. The drawing is Chronicle's own tray script, vendored unchanged
 * under vendor/chronicle/; Foundry has no 3D engine, so every level draws
 * flat dice on the mat's art.
 *
 * Only the GM's client holds the Chronicle socket. It judges each roll
 * (_dice-mat.mjs: public only, never a stub, gm, blind or self roll) and
 * relays a rebuilt copy over the module socket; a player's client takes it
 * only from a GM and judges it again.
 */

import { MODULE_ID } from './constants.mjs';
import { log } from './logger.mjs';
import { loadVendored } from './vendor-chronicle.mjs';
import { MAT_FILES, MAT_FINISHES, MAT_LEVELS, cleanChoices, matMessage, matView, readMatMessage } from './_dice-mat.mjs';

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SETTINGS = { level: 'diceMatLevel', finish: 'diceMatFinish', others: 'diceMatOthers' };
const KEEP = 10;
const t = (key) => game.i18n.localize(`CHRONICLE.DiceMat.${key}`);

/** The latest rolls, so a panel opened after a roll still shows it. */
const recent = [];
let panel = null;
let loading = null;

export function registerDiceMatSettings() {
  const common = { scope: 'client', config: true, onChange: () => panel?.applyChoices() };
  game.settings.register(MODULE_ID, SETTINGS.level, {
    ...common, name: 'CHRONICLE.DiceMat.Level.Name', hint: 'CHRONICLE.DiceMat.Level.Hint', type: String, default: 'detailed',
    choices: { simple: 'CHRONICLE.DiceMat.Level.simple', flat: 'CHRONICLE.DiceMat.Level.flat', detailed: 'CHRONICLE.DiceMat.Level.detailed' },
  });
  game.settings.register(MODULE_ID, SETTINGS.finish, {
    ...common, name: 'CHRONICLE.DiceMat.Finish.Name', hint: 'CHRONICLE.DiceMat.Finish.Hint', type: String, default: 'paper',
    choices: { paper: 'CHRONICLE.DiceMat.Finish.paper', kit: 'CHRONICLE.DiceMat.Finish.kit' },
  });
  game.settings.register(MODULE_ID, SETTINGS.others, {
    ...common, name: 'CHRONICLE.DiceMat.Others.Name', hint: 'CHRONICLE.DiceMat.Others.Hint', type: Boolean, default: true,
  });
}

function choices() {
  const get = (k) => { try { return game.settings.get(MODULE_ID, k); } catch { return undefined; } };
  return cleanChoices({ level: get(SETTINGS.level), finish: get(SETTINGS.finish), others: get(SETTINGS.others) });
}

function remember(view) {
  recent.push(view);
  while (recent.length > KEEP) recent.shift();
  panel?.show(view);
}

/** A hex colour the tray's art can mix, from any computed CSS colour. */
function hexOf(css, fallback) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.fillStyle = '#000000';
  probe.fillStyle = css || fallback;
  const v = probe.fillStyle;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  return m ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : fallback;
}

function load() {
  loading = loading || loadVendored(MAT_FILES).then((shim) => {
    if (!shim.diceTray?.mount) throw new Error('dice tray did not register');
    return shim.diceTray;
  });
  loading.catch(() => { loading = null; });
  return loading;
}

const { ApplicationV2 } = foundry.applications.api;

class DiceMatWindow extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: 'chronicle-dice-mat',
    classes: ['chronicle-dice-mat-window'],
    window: { title: 'CHRONICLE.DiceMat.Title', icon: 'fa-solid fa-dice-d20', resizable: true },
    position: { width: 520, height: 'auto' },
  };

  _tray = null;
  _host = null;

  async _renderHTML() {
    const el = document.createElement('div');
    el.className = 'chronicle-dice-mat';
    return el;
  }

  _replaceHTML(result, content) {
    if (this._host) return;
    content.replaceChildren(result);
    this._host = result;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    this._mountTray().catch((err) => {
      log.warn('Could not start the dice mat', err);
      this._host.textContent = t('LoadFailed');
    });
  }

  async _mountTray() {
    const tray = await load();
    if (!this._host?.isConnected) return;
    const body = document.createElement('div');
    this._host.replaceChildren(body);
    const c = choices();
    const style = () => getComputedStyle(this._host);
    this._tray = tray.mount(body, {
      own: false, level: c.level, finish: c.finish, others: c.others,
      tokens: () => {
        const s = style();
        const g = (n, f) => hexOf(s.getPropertyValue(n).trim(), f);
        return { surface: g('--cs-surface', '#f7f4ee'), alt: g('--cs-surface-2', '#e8e3d8'), border: g('--cs-line', '#c3bcae'), accent: g('--cs-accent', '#4f52d6'), text: g('--cs-text', '#1f1c17') };
      },
      kit: () => 'material',
      dark: () => !!this._host.closest('.theme-dark') || (!this._host.closest('.theme-light') && !!document.body.classList.contains('theme-dark')),
      look: (v) => ({ set: v.rollerDice?.set || '', colour: v.rollerDice?.colour || '' }),
    });
    for (const v of recent) this._tray.roll(v);
  }

  show(view) { this._tray?.roll(view); }

  applyChoices() {
    if (!this._tray) return;
    const c = choices();
    this._tray.setLevel(c.level);
    this._tray.setFinish(c.finish);
    this._tray.setOthers(c.others);
  }

  async close(options) {
    this._tray?.destroy();
    this._tray = null;
    this._host = null;
    if (panel === this) panel = null;
    return super.close(options);
  }
}

/** Open the panel, or bring the open one forward. */
export function openDiceMat() {
  if (!panel) panel = new DiceMatWindow();
  panel.render({ force: true });
  panel.bringToFront?.() ?? panel.bringToTop?.();
}

/**
 * The GM client's Chronicle roll.made: draw it here and hand it to players.
 * @param {object} payload - the WebSocket payload
 * @param {{rollerFoundryId: string|null, relay: boolean}} opts - the Foundry user the roller is matched to; whether this client relays (the active GM)
 */
export function feedDiceMat(payload, { rollerFoundryId, relay }) {
  const msg = matMessage(payload, rollerFoundryId);
  if (!msg) return;
  const view = matView(payload);
  view.mine = !!rollerFoundryId && rollerFoundryId === game.user.id;
  remember(view);
  if (relay) game.socket.emit(SOCKET_CHANNEL, msg);
}

/** Every client: take a relayed roll, only from a GM. */
export function registerDiceMatSocket() {
  game.socket.on(SOCKET_CHANNEL, (data, senderId) => {
    if (data?.type !== 'dice-mat' || game.user.isGM) return;
    const view = readMatMessage(data, { senderIsGM: !!game.users.get(senderId)?.isGM, selfId: game.user.id });
    if (view) remember(view);
  });
}

export { MAT_FINISHES, MAT_LEVELS };
