/**
 * Chronicle Sync - DM Screen
 *
 * The GM's control panel from Chronicle, in a Foundry window: the world
 * (downtime switch, date, weather), the party folded to one line per hero,
 * and the system's conditions plus hidden characters to reveal. It reads
 * Chronicle's GET /dm-screen, the same view Chronicle's own panel draws, and
 * copies nothing into Foundry documents.
 *
 * Opening it plays the site's opening: a d20 rolls out of the toolbar
 * button, lands on 20, and the screen unfolds out of it while the faces fall
 * and settle. One click or Escape skips it; reduced motion gets a fade.
 * Nothing loops. GM only; the key is the GM's own sync key.
 */

import { getSetting } from './settings.mjs';
import { noticeText } from './_escape-html.mjs';
import { downtimeNotice, errorKey, screenContext } from './_dm-screen-view.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const t = (key) => game.i18n.localize(`CHRONICLE.DMScreen.${key}`);

// The die is ten flat facets: a hexagon split around the centre face, in
// percentages of the die box, so each facet can fall on its own.
const H = [[50, 3], [93, 27], [93, 73], [50, 97], [7, 73], [7, 27]];
const T = [[50, 24], [77, 67], [23, 67]];
const FACETS = [
  { p: [T[0], T[1], T[2]], shade: 0, face: true },
  { p: [H[5], H[0], T[0]], shade: 18 }, { p: [H[0], H[1], T[0]], shade: 10 },
  { p: [H[1], T[1], T[0]], shade: -8 }, { p: [H[1], H[2], T[1]], shade: -18 },
  { p: [H[2], H[3], T[1]], shade: -24 }, { p: [H[3], T[2], T[1]], shade: -12 },
  { p: [H[3], H[4], T[2]], shade: -20 }, { p: [H[4], H[5], T[2]], shade: -4 },
  { p: [H[5], T[0], T[2]], shade: 6 },
];
const DIE = 120; // px
const BREAK = 1560; // ms: the screen pushes out and the die comes apart
const FADE = BREAK + 1900;

const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The toolbar button the die rolls out of, or null when it isn't drawn. */
function toolButton() {
  return document.querySelector('[data-tool="dm-screen"]');
}

function centerOf(el) {
  const r = el?.getBoundingClientRect?.();
  if (!r || !r.width) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** @type {DMScreenWindow|null} */
let screen = null;

/**
 * Open the DM Screen, or bring it forward when it is already open.
 * @param {() => import('./api-client.mjs').ChronicleAPI|null} getApi
 */
export function openDMScreen(getApi) {
  if (!game.user.isGM) return;
  if (screen?.rendered) {
    screen.bringToFront?.();
    return;
  }
  screen = new DMScreenWindow(getApi);
  screen.render({ force: true });
}

class DMScreenWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'chronicle-dm-screen',
    classes: ['chronicle-dm-screen'],
    window: { title: 'CHRONICLE.DMScreen.Title', icon: 'fa-solid fa-dice-d20', resizable: true },
    position: { width: 980, height: 'auto' },
    actions: {
      downtime: DMScreenWindow._onDowntime,
      downtimeAsk: DMScreenWindow._onDowntimeAsk,
      downtimeCancel: DMScreenWindow._onDowntimeCancel,
      reveal: DMScreenWindow._onReveal,
      tab: DMScreenWindow._onTab,
      hero: DMScreenWindow._onHero,
      retry: DMScreenWindow._onRetry,
    },
  };

  static PARTS = {
    screen: { template: 'modules/chronicle-sync/templates/dm-screen.hbs' },
  };

  constructor(getApi) {
    super();
    this._getApi = getApi;
    /** @type {object|null} Chronicle's view, null until loaded */
    this._view = null;
    this._error = '';
    /** Hero ids folded open, kept across re-renders. */
    this._openHeroes = new Set();
    this._tab = '';
    this._fx = { anims: [], nodes: [], raf: 0, playing: false, onKey: null };
  }

  async _load() {
    const api = this._getApi?.();
    if (!api || !getSetting('apiUrl') || !getSetting('campaignId') || !getSetting('apiKey')) {
      this._error = t('Error.NotSetUp');
      return;
    }
    try {
      this._view = await api.get('/dm-screen');
      this._error = '';
    } catch (err) {
      this._error = t(`Error.${errorKey(err)}`);
    }
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (!this._view && !this._error) await this._load();
    if (this._error) return { ...context, error: this._error, retryLabel: t('Retry') };
    return { ...context, ...screenContext(this._view, { apiUrl: getSetting('apiUrl') }) };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element.querySelector('[data-dms-root]');
    if (!root) return;
    this._restoreState(root);
    root.querySelector('[data-dms-filter]')?.addEventListener('input', (e) => this._filter(e.target));
    root.querySelector('[data-dms-party]')?.addEventListener('scroll', (e) => partyEdges(e.target));
    if (options.isFirstRender && !this._error) this._playOpening(root);
    else this._refreshParty();
  }

  /** Put back the open heroes, chosen tab and filter after a re-render. */
  _restoreState(root) {
    root.querySelectorAll('[data-dms-hero]').forEach((hero, i) => {
      const id = this._view?.party?.[i]?.id;
      if (!id || !this._openHeroes.has(id)) return;
      hero.classList.add('dms-open');
      hero.querySelector('[data-action="hero"]')?.setAttribute('aria-expanded', 'true');
    });
    const tab = this._tab && root.querySelector(`[data-action="tab"][data-tab="${this._tab}"]`);
    if (tab) selectTab(root, tab);
  }

  _refreshParty() {
    const list = this.element?.querySelector('[data-dms-party]');
    if (!list) return;
    fitOpenHeroes(list);
    partyEdges(list);
  }

  _filter(input) {
    const q = input.value.trim().toLowerCase();
    this.element.querySelectorAll('[data-dms-cond]').forEach((d) => {
      d.hidden = q !== '' && !d.dataset.dmsCond.toLowerCase().includes(q);
    });
  }

  // ---- Opening and closing -------------------------------------------

  _anim(target, frames, opts) {
    const a = target.animate(frames, { fill: 'backwards', easing: 'cubic-bezier(.2,.8,.2,1)', ...opts });
    this._fx.anims.push(a);
    return a;
  }

  /** A full-window layer for the die; a click on it skips the opening. */
  _fxLayer() {
    const layer = document.createElement('div');
    layer.className = 'chronicle-dms-fx';
    const skip = document.createElement('span');
    skip.className = 'dms-skip';
    skip.textContent = t('Skip');
    layer.append(skip);
    layer.addEventListener('click', () => this._finish());
    document.body.append(layer);
    this._fx.nodes.push(layer);
    return layer;
  }

  _buildDie(layer, x, y) {
    const wrap = document.createElement('div');
    wrap.className = 'dms-die';
    wrap.style.left = `${x - DIE / 2}px`;
    wrap.style.top = `${y - DIE / 2}px`;
    const pieces = FACETS.map((f) => {
      const el = document.createElement('div');
      el.className = 'dms-piece';
      el.style.clipPath = `polygon(${f.p.map(([a, b]) => `${a}% ${b}%`).join(',')})`;
      el.style.filter = `brightness(${100 + f.shade}%)`;
      if (f.face) {
        const b = document.createElement('b');
        b.textContent = '20';
        el.append(b);
      }
      const cx = (f.p[0][0] + f.p[1][0] + f.p[2][0]) / 3;
      const cy = (f.p[0][1] + f.p[1][1] + f.p[2][1]) / 3;
      el.style.transformOrigin = `${cx}% ${cy}%`;
      wrap.append(el);
      return { el, cx, cy, face: !!f.face };
    });
    layer.append(wrap);
    return { wrap, pieces };
  }

  // The faces are knocked loose by the rising screen, fall under gravity,
  // bounce on the bottom of the window, slide to rest, then fade.
  _shatter(die, start) {
    const W = window.innerWidth;
    const Hh = window.innerHeight;
    const wl = parseFloat(die.wrap.style.left);
    const wt = parseFloat(die.wrap.style.top);
    const bodies = die.pieces.map((p) => {
      const px = (p.cx / 100) * DIE;
      const py = (p.cy / 100) * DIE;
      const r = p.face ? 16 : 11;
      return {
        el: p.el, x: 0, y: 0, a: 0,
        vx: (p.cx - 50) * 9 + (Math.random() - 0.5) * 90,
        vy: (p.cy - 50) * 7 - 420 - Math.random() * 260,
        va: (Math.random() < 0.5 ? -1 : 1) * (240 + Math.random() * 420),
        floor: Hh - 6 - r - (wt + py),
        xmin: -(wl + px) + r,
        xmax: W - (wl + px) - r,
      };
    });
    let last = start;
    const step = (now) => {
      const time = now - start;
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      if (time >= BREAK) {
        for (const b of bodies) {
          b.vy += 2400 * dt; b.x += b.vx * dt; b.y += b.vy * dt; b.a += b.va * dt;
          if (b.y > b.floor) {
            b.y = b.floor;
            if (b.vy > 90) { b.vy = -b.vy * 0.42; b.vx *= 0.7; b.va = -b.va * 0.5 + b.vx * 0.6; }
            else { b.vy = 0; b.vx *= 0.86; b.va *= 0.8; }
          }
          if (b.x < b.xmin) { b.x = b.xmin; b.vx = -b.vx * 0.5; }
          if (b.x > b.xmax) { b.x = b.xmax; b.vx = -b.vx * 0.5; }
          b.el.style.transform = `translate(${b.x.toFixed(1)}px,${b.y.toFixed(1)}px) rotate(${b.a.toFixed(1)}deg)`;
          b.el.style.opacity = time < FADE ? 1 : Math.max(0, 1 - (time - FADE) / 700);
        }
      }
      if (time < FADE + 700) this._fx.raf = requestAnimationFrame(step);
      else this._clearFx();
    };
    this._fx.raf = requestAnimationFrame(step);
  }

  _playOpening(root) {
    const win = this.element;
    if (reduceMotion()) {
      this._anim(win, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
      this._refreshParty();
      return;
    }
    this._setPlaying(true);
    const layer = this._fxLayer();
    const box = win.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + Math.min(box.height * 0.42, 360);
    const from = centerOf(toolButton()) ?? { x: 40, y: window.innerHeight / 2 };
    const die = this._buildDie(layer, cx, cy);
    const sx = from.x - cx;
    const sy = from.y - cy;
    this._anim(die.wrap, [
      { transform: `translate(${sx}px,${sy}px) rotate(-30deg) scale(.25)`, opacity: 0 },
      { transform: `translate(${sx * 0.55}px,${sy * 0.55 - 70}px) rotate(260deg) scale(.8)`, opacity: 1, offset: 0.3 },
      { transform: 'translate(0,0) rotate(520deg) scale(1)', offset: 0.58 },
      { transform: 'translate(0,-34px) rotate(610deg) scale(1)', offset: 0.7 },
      { transform: 'translate(0,0) rotate(700deg) scale(1)', offset: 0.82 },
      { transform: 'translate(0,-8px) rotate(715deg) scale(1)', offset: 0.9 },
      { transform: 'translate(0,0) rotate(720deg) scale(1)', opacity: 1 },
    ], { duration: 1150, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'both' });
    // A beat so the 20 reads, then a small tremor as it gives way.
    this._anim(die.wrap, [{ translate: '0 0' }, { translate: '-2px 0' }, { translate: '2px 1px' }, { translate: '-1px 0' }, { translate: '0 0' }],
      { duration: 200, delay: 1340, easing: 'linear', composite: 'add' });
    this._shatter(die, performance.now());
    this._unfold(win, root, cx, cy, BREAK);
  }

  // The window rises out of where the die stood, stands, and swings open.
  _unfold(win, root, fromX, fromY, delay) {
    const rect = win.getBoundingClientRect();
    const dx = fromX - (rect.left + rect.width / 2);
    const dy = fromY - (rect.top + rect.height / 2);
    const narrow = rect.width < 640;
    const side = narrow ? 'rotateX' : 'rotateY';
    const L = root.querySelector('[data-dms-leaf="l"]');
    const M = root.querySelector('[data-dms-leaf="m"]');
    const R = root.querySelector('[data-dms-leaf="r"]');
    this._anim(win, [
      { transform: `translate(${dx}px,${dy}px) scale(.1)`, opacity: 0 },
      { transform: `translate(${dx * 0.6}px,${dy * 0.6}px) scale(.22)`, opacity: 1, offset: 0.2 },
      { transform: `translate(${dx * 0.3}px,${dy * 0.3}px) scale(.6)`, opacity: 1, offset: 0.55 },
      { transform: 'none', opacity: 1 },
    ], { duration: 950, delay, easing: 'cubic-bezier(.3,.5,.3,1)' });
    if (M) this._anim(M, [{ transform: 'rotateX(-80deg)' }, { transform: 'rotateX(-80deg)', offset: 0.15 }, { transform: 'rotateX(6deg)', offset: 0.8 }, { transform: 'none' }], { duration: 800, delay });
    if (L) this._anim(L, [{ transform: `${side}(${narrow ? '-' : ''}178deg)` }, { transform: `${side}(${narrow ? '8' : '-8'}deg)`, offset: 0.75 }, { transform: 'none' }], { duration: 620, delay: delay + 650, easing: 'cubic-bezier(.3,.7,.3,1)' });
    const last = R ? this._anim(R, [{ transform: `${side}(${narrow ? '' : '-'}178deg)` }, { transform: `${side}(${narrow ? '-8' : '8'}deg)`, offset: 0.75 }, { transform: 'none' }], { duration: 620, delay: delay + 730, easing: 'cubic-bezier(.3,.7,.3,1)' }) : null;
    root.querySelectorAll('.dms-strip').forEach((n) => {
      this._anim(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 250, delay: delay + 1150 });
    });
    if (last) last.onfinish = () => this._setPlaying(false);
  }

  _setPlaying(on) {
    const fx = this._fx;
    fx.playing = on;
    if (on && !fx.onKey) {
      // Escape skips the opening instead of closing the window.
      fx.onKey = (e) => {
        if (e.key !== 'Escape' || !fx.playing) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this._finish();
      };
      window.addEventListener('keydown', fx.onKey, true);
    }
    if (!on) {
      if (fx.onKey) window.removeEventListener('keydown', fx.onKey, true);
      fx.onKey = null;
      // The falling faces may still be settling; only the skip hint goes.
      fx.nodes.forEach((n) => { n.style.pointerEvents = 'none'; n.querySelector('.dms-skip')?.remove(); });
      this._refreshParty();
    }
  }

  _clearFx() {
    if (this._fx.raf) cancelAnimationFrame(this._fx.raf);
    this._fx.raf = 0;
    this._fx.nodes.forEach((n) => n.remove());
    this._fx.nodes = [];
  }

  // Skip: jump every animation to its end and clear the falling pieces.
  _finish() {
    this._clearFx();
    for (const a of this._fx.anims) {
      try { a.finish(); } catch { /* already gone */ }
    }
    this._fx.anims = [];
    this._setPlaying(false);
  }

  _stopAll() {
    this._clearFx();
    for (const a of this._fx.anims) {
      try { a.cancel(); } catch { /* already gone */ }
    }
    this._fx.anims = [];
    this._setPlaying(false);
  }

  /** @override Fold back into the toolbar button, as the site does. */
  async close(options = {}) {
    this._stopAll();
    const win = this.element;
    const to = centerOf(toolButton());
    if (!this.rendered || !win || !to || reduceMotion() || options.animate === false) return super.close(options);
    const rect = win.getBoundingClientRect();
    const dx = to.x - (rect.left + rect.width / 2);
    const dy = to.y - (rect.top + rect.height / 2);
    const a = win.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px,${dy}px) scale(.1)`, opacity: 0 }],
      { duration: 380, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
    await a.finished.catch(() => {});
    return super.close({ ...options, animate: false });
  }

  static async _onRetry() {
    this._view = null;
    this._error = '';
    await this.render();
  }

  static _onTab(_event, target) {
    this._tab = target.dataset.tab;
    selectTab(this.element, target);
  }

  // Heroes start folded to one line; a click folds the rest open, and an
  // open hero is always shown whole.
  static _onHero(_event, target) {
    if (this._fx.playing) return;
    const hero = target.closest('[data-dms-hero]');
    const index = [...this.element.querySelectorAll('[data-dms-hero]')].indexOf(hero);
    const id = this._view?.party?.[index]?.id;
    const open = !hero.classList.contains('dms-open');
    hero.classList.toggle('dms-open', open);
    target.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (id) {
      if (open) this._openHeroes.add(id);
      else this._openHeroes.delete(id);
    }
    setTimeout(() => {
      const list = hero.closest('[data-dms-party]');
      if (!list) return;
      fitOpenHeroes(list);
      if (open) showWhole(list, hero);
      partyEdges(list);
    }, 340);
  }

  // The switch asks before it changes anything; see screenContext.
  static _onDowntimeAsk() {
    const box = this.element.querySelector('[data-dms-confirm]');
    if (!box) return;
    box.hidden = false;
    box.querySelector('[data-action="downtimeCancel"]')?.focus();
  }

  static _onDowntimeCancel() {
    const box = this.element.querySelector('[data-dms-confirm]');
    if (box) box.hidden = true;
  }

  static async _onDowntime(_event, target) {
    const api = this._getApi?.();
    if (!api) return;
    const open = target.dataset.open === 'true';
    this.element.querySelectorAll('[data-action^="downtime"]').forEach((b) => { b.disabled = true; });
    try {
      const res = await api.post('/dm-screen/downtime', { open });
      ui.notifications.info(downtimeNotice(open, res));
    } catch (err) {
      ui.notifications.warn(err?.serverMessage ? noticeText(err.serverMessage) : t('Error.Action'));
    }
    await this._load();
    await this.render();
  }

  static async _onReveal(_event, target) {
    const api = this._getApi?.();
    const id = target.dataset.id;
    if (!api || !id) return;
    target.disabled = true;
    try {
      await api.post(`/dm-screen/reveal/${encodeURIComponent(id)}`, {});
      const row = this._view?.hidden?.find((h) => h.id === id);
      if (row) row.revealed = true;
      await this.render();
    } catch (err) {
      target.disabled = false;
      ui.notifications.warn(err?.serverMessage ? noticeText(err.serverMessage) : t('Error.Action'));
    }
  }
}

function selectTab(root, tab) {
  const name = tab.dataset.tab;
  root.querySelectorAll('[data-action="tab"]').forEach((b) => {
    b.setAttribute('aria-selected', b === tab ? 'true' : 'false');
  });
  root.querySelectorAll('[data-dms-pane]').forEach((p) => {
    p.hidden = p.dataset.dmsPane !== name;
  });
}

// The list grows past its usual height when one open hero alone wouldn't
// fit, and the others move aside.
function fitOpenHeroes(list) {
  list.style.maxHeight = '';
  const cap = list.clientHeight;
  let need = 0;
  list.querySelectorAll('[data-dms-hero].dms-open').forEach((h) => {
    need = Math.max(need, h.offsetHeight + 8);
  });
  if (need > cap) list.style.maxHeight = `${need}px`;
}

function showWhole(list, hero) {
  const top = hero.offsetTop;
  const bottom = top + hero.offsetHeight;
  let target = list.scrollTop;
  if (bottom > list.scrollTop + list.clientHeight) target = bottom - list.clientHeight + 4;
  if (top < target) target = Math.max(0, top - 4);
  if (target !== list.scrollTop) list.scrollTo({ top: target, behavior: reduceMotion() ? 'auto' : 'smooth' });
}

// Fades the list edge and counts the heroes still below it.
function partyEdges(list) {
  const end = list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
  list.classList.toggle('dms-at-end', end);
  list.classList.toggle('dms-scrolled', list.scrollTop > 2);
  const bottom = list.getBoundingClientRect().bottom;
  let below = 0;
  list.querySelectorAll('[data-dms-hero]').forEach((h) => {
    if (h.getBoundingClientRect().top > bottom - 12) below++;
  });
  const more = list.parentNode.querySelector('[data-dms-more]');
  if (!more) return;
  more.hidden = end || !below;
  more.textContent = `${below} more below`;
}
