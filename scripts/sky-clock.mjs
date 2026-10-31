/**
 * Chronicle Sync - Sky Clock
 *
 * The calendar as a small glass globe in a corner of the screen. Inside it is
 * Chronicle's own sky (its sky code, vendored under vendor/chronicle/), and
 * the day of the month stands on the hill as a carved stone figure lit by
 * the globe's sun or moon. Snow, rain and fog fall in front of it. Dragging
 * the globe swirls its snow and drops it into the nearest corner. The GM
 * clicks it to slide out a cradle that steps Chronicle's time. A shrunk
 * globe is a still picture.
 *
 * `calendar-bar.mjs` decides when the Sky Clock shows (the person's chosen
 * look, or a shrunk calendar) and hands it the same view the strip draws.
 * The pure decisions are in `_sky-clock.mjs`.
 */

import { loadVendored } from './vendor-chronicle.mjs';
import { formatDate, formatTime, skyGradient } from './_calendar-view-model.mjs';
import {
  GLOBE, MINI, clearOf, cornerByKey, cornerOf, cornerSpots, cradleLayout, figureLight,
  framesPerSecond, frontOf, frontWeather, glassDrops, mixWeather, nearestCorner, plainRecipe, skyCalendar, skyEvents, skyWeather, stoneWeather,
} from './_sky-clock.mjs';
import { escapeHtml as esc } from './_escape-html.mjs';

/** Chronicle's sky, in the order its files depend on each other. */
const SKY_FILES = ['sky_world.js', 'sky_looks.js', 'sky_moon.js', 'sky_events.js', 'sky_2d.js', 'sky_shaders.js', 'sky_gl.js', 'sky_pane.js'];

/** Time without a pointer or key before the globe comes to rest. */
const REST_AFTER_MS = 20000;
/** A day change: the old figure crumbles and the new one gathers. */
const CRUMBLE_S = 1.25;
/** An hour step glides the sky to the new time. */
const GLIDE_S = 0.9;
/** A step further than this jumps rather than glides. */
const GLIDE_MAX_MIN = 6 * 60;

/** The day figure's face: a heavy slab with even strokes, as carved stone would hold. */
const FIG_FONT = '"Alfa Slab One"';
/** Near-black weathered stone, so the figure stands clear of any sky. */
const STONE = [64, 60, 55];

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mix = (a, b, t) => a + (b - a) * t;
const mixC = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const rgb = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const easeOut = (x) => 1 - (1 - x) ** 3;
const now = () => performance.now() / 1000;
function rnd(i, k) { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); }
/** A linear sky colour (0..1) as 0..255 sRGB. */
function srgb(lin) {
  return (lin || [0, 0, 0]).map((v) => {
    const c = clamp(v, 0, 1);
    return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  });
}

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/* ── The stone: grain and weathering, made once and laid over the figure. ── */

function grainCanvas() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 160; const g = cv.getContext('2d');
  // Mottling at two scales, smoothed up from coarse noise: real stone varies in tone across its face, not only in specks.
  for (const [n, a, salt] of [[10, 0.26, 290], [40, 0.16, 295]]) {
    const m = document.createElement('canvas'); m.width = m.height = n; const mg = m.getContext('2d');
    for (let i = 0; i < n * n; i++) {
      const v = rnd(i, salt) > 0.85 ? 255 : 0;
      mg.fillStyle = `rgba(${v},${v},${v},${(rnd(i, salt + 1) * a).toFixed(3)})`; mg.fillRect(i % n, Math.floor(i / n), 1, 1);
    }
    g.imageSmoothingEnabled = true; g.drawImage(m, 0, 0, 160, 160);
  }
  for (let i = 0; i < 2600; i++) {
    const v = rnd(i, 300) > 0.5 ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${(0.06 + rnd(i, 301) * 0.16).toFixed(3)})`;
    g.fillRect(rnd(i, 302) * 160, rnd(i, 303) * 160, 1 + rnd(i, 304), 1 + rnd(i, 305));
  }
  g.strokeStyle = 'rgba(40,36,30,0.18)'; g.lineWidth = 0.7;
  for (let k = 0; k < 5; k++) {
    g.beginPath(); let x = rnd(k, 310) * 160; let y = rnd(k, 311) * 160; g.moveTo(x, y);
    for (let j = 0; j < 6; j++) { x += (rnd(k * 9 + j, 312) - 0.3) * 30; y += (rnd(k * 9 + j, 313) - 0.5) * 22; g.lineTo(x, y); }
    g.stroke();
  }
  return cv;
}

/** Rain-streaked grime, pitting and a few lichen spots: old stone left out on the hill. */
function weatherCanvas() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 160; const g = cv.getContext('2d');
  for (let i = 0; i < 70; i++) {
    const x = rnd(i, 320) * 160; const y = rnd(i, 321) * 160; const r = 2 + rnd(i, 322) * 6;
    const gd = g.createRadialGradient(x, y, 0, x, y, r);
    gd.addColorStop(0, `rgba(28,24,20,${(0.12 + rnd(i, 323) * 0.18).toFixed(3)})`); gd.addColorStop(1, 'rgba(28,24,20,0)');
    g.fillStyle = gd; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let s = 0; s < 26; s++) {
    const sx = rnd(s, 330) * 160; const sy = rnd(s, 331) * 120; const sl = 14 + rnd(s, 332) * 40;
    const sg = g.createLinearGradient(0, sy, 0, sy + sl);
    sg.addColorStop(0, 'rgba(22,20,18,0)'); sg.addColorStop(0.4, `rgba(22,20,18,${(0.12 + rnd(s, 333) * 0.14).toFixed(3)})`); sg.addColorStop(1, 'rgba(22,20,18,0)');
    g.fillStyle = sg; g.fillRect(sx, sy, 1 + rnd(s, 334) * 2.2, sl);
  }
  for (let q = 0; q < 900; q++) {
    g.fillStyle = `rgba(10,8,6,${(0.2 + rnd(q, 340) * 0.3).toFixed(3)})`;
    g.fillRect(rnd(q, 341) * 160, rnd(q, 342) * 160, 0.8 + rnd(q, 343) * 1.2, 0.8 + rnd(q, 344));
  }
  for (let l = 0; l < 14; l++) {
    const lx = rnd(l, 350) * 160; const ly = rnd(l, 351) * 160;
    for (let m = 0; m < 9; m++) {
      // Lichen stays darker than the stone's lit face, so it never reads as snow left behind.
      g.fillStyle = `${rnd(l, 352) > 0.5 ? 'rgba(74,86,50,' : 'rgba(90,78,44,'}${(0.3 + rnd(l * 9 + m, 353) * 0.25).toFixed(3)})`;
      g.beginPath(); g.arc(lx + (rnd(l * 9 + m, 354) - 0.5) * 6, ly + (rnd(l * 9 + m, 355) - 0.5) * 6, 0.6 + rnd(l * 9 + m, 356) * 1.2, 0, TAU); g.fill();
    }
  }
  return cv;
}

/**
 * The figure's shape as points: its edge (for chips and cracks), its tops
 * (where weather settles) and a spread over its body (where the crumbs break
 * off and gather). Made once per number and size.
 */
const SHAPES = new Map();
function shapeOf(txt, font, fs) {
  const key = `${txt}|${font}`;
  if (SHAPES.has(key)) return SHAPES.get(key);
  const W = Math.ceil(fs * 2); const H = Math.ceil(fs * 1.2);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.font = font; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = '#000'; g.fillText(txt, W / 2, H * 0.9);
  const a = g.getImageData(0, 0, W, H).data; const body = []; const rim = []; const tops = []; const step = Math.max(1, Math.round(fs / 40));
  const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && a[(y * W + x) * 4 + 3] > 128;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (!on(x, y)) continue;
      const p = [x - W / 2, y - H * 0.9];
      body.push(p);
      if (!on(x - step, y) || !on(x + step, y) || !on(x, y - step) || !on(x, y + step)) rim.push(p);
      // A top: open sky above it, where snow, dust and leaves come to rest.
      if (!on(x, y - step) && !on(x, y - 2 * step)) tops.push(p);
    }
  }
  const seed = Number(txt) || 0;
  const pick = (list, n, salt) => (list.length ? Array.from({ length: n }, (_, i) => list[Math.floor(rnd(i + seed * 7, salt) * list.length)]) : []);
  // Each chip carries which way is out of the stone, so its bite is a notch in the outline, not a hole in the face.
  const outward = (p) => {
    const x = Math.round(p[0] + W / 2); const y = Math.round(p[1] + H * 0.9); let nx = 0; let ny = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) if (!on(x + dx * step, y + dy * step)) { nx += dx; ny += dy; }
    const n = Math.hypot(nx, ny) || 1;
    return [p[0], p[1], nx / n, ny / n];
  };
  const shape = { chips: pick(rim, 30, 400).map(outward), cracks: pick(rim, 5, 401), crumbs: pick(body, 240, 402), tops: pick(tops, 16, 403) };
  SHAPES.set(key, shape);
  return shape;
}

/** The hairline cracks running in from the figure's edge, as polylines. */
function crackLines(sh, bx, by, fs) {
  const u = fs / 60;
  return sh.cracks.map((p, i) => {
    let x = bx + p[0]; let y = by + p[1]; let ang = Math.atan2(-p[1] - fs * 0.35, -p[0]);
    const line = [[x, y]];
    for (let j = 0; j < 4; j++) { ang += (rnd(i * 4 + j, 420) - 0.5) * 1.1; x += Math.cos(ang) * 2.6 * u; y += Math.sin(ang) * 2.6 * u; line.push([x, y]); }
    return line;
  });
}

/**
 * Worn stone: notches broken out of the outline and a few hairline cracks
 * running in from them. A notch is centred outside the edge so it bites into
 * the outline without opening a hole in the face, and a soft shadow round it
 * gives it depth instead of a flat dark spot.
 */
function crumble(F, sh, bx, by, fs, seed, ext) {
  const u = fs / 60;
  // Cut along the figure's depth as well (ext is the step of each layer behind the face), so a notch goes clean through.
  const notch = (p, i) => {
    const r = (1 + rnd(i + seed * 3, 410) * 1.2) * u; const x = bx + p[0] + p[2] * r * 0.55; const y = by + p[1] + p[3] * r * 0.55; const a0 = rnd(i, 411) * 6.28;
    for (let k = 0; k <= ext.n; k++) {
      F.beginPath();
      for (let j = 0; j < 5; j++) { const a = a0 + j * 1.257 + (rnd(i * 5 + j, 413) - 0.5) * 0.7; const rr = r * (0.35 + rnd(i * 5 + j, 412) * 0.85); F.lineTo(x + ext.x * k + Math.cos(a) * rr * (1 - k / (ext.n + 1)), y + ext.y * k + Math.sin(a) * rr * (1 - k / (ext.n + 1))); }
      F.fill();
    }
    return [x, y, r];
  };
  F.save();
  F.globalCompositeOperation = 'destination-out'; F.fillStyle = '#000';
  // The foot stays whole: it sits in the ground, where nothing breaks off it.
  const cut = sh.chips.filter((p, i) => i % 5 < 2 && p[3] < 0.5 && p[1] < -fs * 0.08).map((p, i) => notch(p, i));
  F.globalCompositeOperation = 'source-atop';
  for (const [x, y, r] of cut) {
    const sg = F.createRadialGradient(x, y, r * 0.6, x, y, r * 1.8);
    sg.addColorStop(0, 'rgba(10,8,7,0.32)'); sg.addColorStop(1, 'rgba(10,8,7,0)');
    F.fillStyle = sg; F.fillRect(x - r * 1.8, y - r * 1.8, r * 3.6, r * 3.6);
  } F.strokeStyle = 'rgba(8,6,5,0.55)'; F.lineWidth = Math.max(0.6, 0.5 * u);
  for (const line of crackLines(sh, bx, by, fs)) {
    F.beginPath(); line.forEach(([x, y], j) => (j ? F.lineTo(x, y) : F.moveTo(x, y))); F.stroke();
  }
  F.restore();
}

/** Day change: the old number breaks into crumbs that tumble, then drift up and pack into the new one. */
function drawCrumbs(g, k, from, to, bx, by, face, side, u) {
  const n = Math.min(from.crumbs.length, to.crumbs.length);
  for (let i = 0; i < n; i++) {
    const a = from.crumbs[i]; const b = to.crumbs[i]; const d = rnd(i, 430) * 0.12;
    if (k < d) continue;
    const vx = (rnd(i, 431) - 0.5) * 16 * u; const vy = -rnd(i, 432) * 10 * u;
    const fall = clamp((k - d) / 0.3, 0, 1);
    const fx = a[0] + vx * fall; const fy = a[1] + vy * fall + 26 * u * fall * fall;
    let x = fx; let y = fy;
    if (k >= 0.3 + d) {
      const m = easeOut(clamp((k - 0.3 - d) / 0.55, 0, 1));
      x = mix(fx, b[0], m); y = mix(fy, b[1], m) - Math.sin(Math.PI * m) * 10 * u;
    }
    const r = (0.7 + rnd(i, 433) * 1.3) * u * 0.95;
    g.globalAlpha = k > 0.8 ? 1 - clamp((k - 0.8) / 0.2, 0, 1) : 1;
    g.fillStyle = rgb(i % 3 ? face : side);
    g.save(); g.translate(bx + x, by + y); g.rotate(rnd(i, 434) * 6 + k * 6 * (rnd(i, 435) - 0.5)); g.fillRect(-r, -r * 0.7, r * 2, r * 1.4); g.restore();
  }
  g.globalAlpha = 1;
}

/* ── Weather in front of the figure, with a little snow-globe physics. ── */

function particles(n, salt, fn) { return Array.from({ length: n }, (_, i) => fn(i, salt)); }
const FLAKES = particles(56, 50, (i, s) => ({ x: rnd(i, s), y: rnd(i, s + 1), r: 0.6 + rnd(i, s + 2) * 1.2, f: 0.1 + rnd(i, s + 3) * 0.1, p: rnd(i, s + 4) * 6.28, vx: 0, vy: 0 }));
const MOTES = particles(22, 60, (i, s) => ({ x: 0.2 + rnd(i, s) * 0.6, y: 0.55 + rnd(i, s + 1) * 0.3, r: 0.6 + rnd(i, s + 2), f: 0.03 + rnd(i, s + 3) * 0.04, p: rnd(i, s + 4) * 6.28, vx: 0, vy: 0 }));
const DROPS = particles(90, 40, (i, s) => ({ x: rnd(i, s), y: rnd(i, s + 1), l: 4 + rnd(i, s + 2) * 5, v: 0.9 + rnd(i, s + 3) * 0.6 }));

/** Particles drift, fall, and bounce off the inside of the glass. */
function stepParticles(list, dt, fall, t) {
  const R = 0.5;
  for (const p of list) {
    p.vx *= Math.exp(-dt * 1.6); p.vy += (0 - p.vy) * Math.min(1, dt * 1.2);
    p.x += (p.vx + Math.sin(t * 1.1 + p.p) * 0.02) * dt;
    p.y += (p.vy + p.f * fall) * dt;
    const dx = p.x - R; const dy = p.y - R; const d = Math.hypot(dx, dy); const lim = R - 0.02;
    if (d <= lim) continue;
    // A flake that has settled on the bottom starts again at the top.
    if (dy > 0 && Math.abs(p.vy) + Math.abs(p.vx) < 0.15) { p.x = 0.15 + Math.random() * 0.7; p.y = 0.08 + Math.random() * 0.05; p.vx = 0; p.vy = 0; continue; }
    p.x = R + dx / d * lim; p.y = R + dy / d * lim;
    const nx = dx / d; const ny = dy / d; const vn = p.vx * nx + p.vy * ny;
    if (vn > 0) { p.vx -= 1.6 * vn * nx; p.vy -= 1.6 * vn * ny; }
  }
}

/* ── The globe ── */

const LOCK_OPEN = 'M8 11V8a4 4 0 0 1 7.5-2';
const LOCK_SHUT = 'M8 11V8a4 4 0 0 1 8 0v3';

/**
 * One Sky Clock on the page. `o`: {t (string lookup), source (the GM's
 * CalendarSync, or null), savePlace(patch), grow() (a shrunk globe was
 * clicked), motion() (the module's motion level)}.
 */
export class SkyClock {
  constructor(o) {
    this.o = o;
    this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.rm = this.still();
    this.hold = {};
    this.S = null;
    this.model = null;
    this.view = null;
    this.mini = false;
    this.corner = 'tr';
    this.locked = false;
    this.day = null; this.figPrev = null; this.figT0 = -10;
    this.shownMin = null; this.glide = null;
    this.wxKey = null; this.wxA = null; this.wxB = null; this.wxK = 1; this.roll = null; this.W = null;
    this.stir = 0; this.glitter = 0; this.frameN = 0; this.nextFlash = 3;
    this.raf = 0; this.lastDraw = -1; this.lastInput = performance.now();
    this.cradle = null; this.nudge = 0; this.drag = null; this.busy = false;
    this.grain = grainCanvas(); this.weathering = weatherCanvas();
    this.FIG = document.createElement('canvas'); this.FG = this.FIG.getContext('2d');
    this.FIG2 = document.createElement('canvas'); this.F2 = this.FIG2.getContext('2d');
    this.MASK = document.createElement('canvas'); this.MK = this.MASK.getContext('2d');
    this.build();
    this._wake = () => this.wake();
    this._vis = () => this.pace();
    this._resize = () => { this.closeCradle(true); this.place(false); };
    this._outside = (e) => { if (this.cradle && !this.el.contains(e.target)) this.closeCradle(); };
    this._esc = (e) => { if (e.key === 'Escape' && this.cradle) { this.closeCradle(); this.el.focus({ preventScroll: true }); } };
    for (const ev of ['pointermove', 'keydown', 'pointerdown', 'wheel']) document.addEventListener(ev, this._wake, { passive: true });
    document.addEventListener('visibilitychange', this._vis);
    document.addEventListener('pointerdown', this._outside, true);
    document.addEventListener('keydown', this._esc, true);
    window.addEventListener('resize', this._resize);
    this.loadSky();
    document.fonts?.load(`40px ${FIG_FONT}`).then(() => { SHAPES.clear(); this.paintNow(); }).catch(() => {});
  }

  /**
   * Below Full motion (Calm, the default on a device set to reduce motion, or
   * Off) the globe is painted once, weather included, and held: no swirl, no
   * glide, no crumble.
   */
  still() {
    const level = this.o.motion ? this.o.motion() : (reducedMotion() ? 'calm' : 'full');
    return level !== 'full';
  }

  build() {
    const t = this.o.t;
    const el = document.createElement('div');
    el.id = 'chronicle-sky-clock';
    el.className = 'csc';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.innerHTML = `<div class="csc-globe"><div class="csc-glass">
        <canvas class="csc-back" aria-hidden="true"></canvas>
        <canvas class="csc-front" aria-hidden="true"></canvas>
        <div class="csc-shine"></div><div class="csc-flash"></div>
      </div></div>
      <button type="button" class="csc-tool csc-lock" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="${LOCK_OPEN}"/></svg></button>
      <button type="button" class="csc-tool csc-shrink" aria-label="${esc(t('Shrink'))}" title="${esc(t('Shrink'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button>`;
    document.body.appendChild(el);
    this.el = el;
    this.back = el.querySelector('.csc-back'); this.bctx = this.back.getContext('2d');
    this.front = el.querySelector('.csc-front'); this.fctx = this.front.getContext('2d');
    this.flashEl = el.querySelector('.csc-flash');
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', () => this.onUp());
    el.addEventListener('pointercancel', () => this.onUp());
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** Load Chronicle's sky; until it is here, or if it never comes, the still gradient behind the canvas shows. */
  async loadSky() {
    try {
      await loadVendored(SKY_FILES);
      const S = window.SkyPane?.Scene;
      if (!S || !window.SkyWorld || !window.Sky2D) throw new Error('the sky did not load');
      this.S = S;
      this.LOOKS = window.SkyLooks;
      // The weather read before the sky loaded was a stand-in; read it again from the sky's own recipe.
      if (this.view) { this.wxA = this.wxB = this.weatherOf(this.view); this.wxK = 1; this.roll = null; }
      this._glChange = () => this.paintNow();
      window.SkyGL?.onChange(this._glChange);
      this.makeModel();
      this.paintNow();
      this.pace();
    } catch (err) {
      console.warn('Chronicle Sync | Sky Clock: drawing without Chronicle\'s sky', err?.message);
    }
  }

  /** Show the view, or change how it is shown. Cheap when nothing changed. */
  show(view, place) {
    const t = this.o.t;
    this.rm = this.still();
    const wasMini = this.mini;
    this.mini = !!place.mini;
    this.locked = !!place.locked;
    this.gm = !!view.gm;
    this.readOnly = !!view.readOnly;
    const corner = cornerOf(place.corner);
    const moved = corner !== this.corner;
    this.corner = corner;
    this.el.classList.toggle('csc-mini', this.mini);
    this.el.classList.toggle('csc-gm', this.gm);
    this.el.classList.toggle('csc-locked', this.locked);
    if (!this.gm || this.mini) this.closeCradle(true);
    const lock = this.el.querySelector('.csc-lock');
    lock.setAttribute('aria-pressed', String(this.locked));
    lock.setAttribute('aria-label', t(this.locked ? 'Unlock' : 'Lock'));
    lock.title = t(this.locked ? 'Unlock' : 'Lock');
    lock.querySelector('path').setAttribute('d', this.locked ? LOCK_SHUT : LOCK_OPEN);
    this.setView(view);
    if (wasMini !== this.mini || moved || !this.placed) {
      this.size();
      this.place(false);
      if (wasMini !== this.mini && !this.rm) { this.el.classList.remove('csc-grow'); void this.el.offsetWidth; this.el.classList.add('csc-grow'); }
    }
    this.label();
    this.paintNow();
    this.pace();
  }

  /** Take a new view: a new day crumbles in, a new time glides, new weather rolls in. */
  setView(view) {
    const prev = this.view;
    this.view = view;
    const d = view.date;
    const mph = view.calendar.minutes_per_hour || 60;
    const min = (d.hour ?? 0) * mph + (d.minute ?? 0);
    const sameDay = prev && prev.date.year === d.year && prev.date.month === d.month && prev.date.day === d.day;
    if (this.day !== null && !sameDay && !this.rm) { this.figPrev = this.day; this.figT0 = now(); }
    this.day = d.day;
    if (this.shownMin === null || !sameDay || this.rm || this.mini || Math.abs(min - this.shownMin) > GLIDE_MAX_MIN) {
      this.shownMin = min; this.glide = null;
    } else if (min !== (this.glide ? this.glide.to : this.shownMin)) {
      this.glide = { from: this.shownMin, to: min, t0: now() };
    }
    const key = JSON.stringify(skyWeather(view) || null);
    if (key !== this.wxKey) {
      const next = this.weatherOf(view);
      this.wxA = this.wxB ? this.weatherNow() : next; this.wxB = next; this.wxKey = key; this.glitter = 0;
      if (this.rm || this.mini || !prev) { this.wxK = 1; this.wxA = next; this.roll = null; } else { this.wxK = 0; this.roll = { t0: now() }; }
      this.nextFlash = now() + 1.5;
    }
    this.el.style.setProperty('--csc-sky', skyGradient(view.calendar, d.hour ?? 12));
    this.makeModel();
    this.paintCradle();
  }

  makeModel() {
    if (!this.S || !this.view) return;
    const cal = skyCalendar(this.view);
    if (!cal) { this.model = null; return; }
    const seed = this.S.seed((cal.months || []).map((m) => m.name).join('|'));
    const prev = this.model;
    const same = prev && prev.calendar.months === cal.months && JSON.stringify(prev.calendar.moons) === JSON.stringify(cal.moons);
    this.model = {
      calendar: cal,
      todayEvents: skyEvents(this.view),
      dayWeather: cal.weather,
      skym: same ? prev.skym : window.SkyWorld.makeSkym(cal),
      landSeed: seed, width: 0, height: 0, reduced: this.rm,
      glide: prev ? prev.glide : null,
    };
  }

  size() {
    this.D = this.mini ? MINI - 4 : GLOBE - 6;
    for (const cv of [this.back, this.front]) { cv.width = Math.round(this.D * this.dpr); cv.height = Math.round(this.D * this.dpr); }
    this.fctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  label() {
    const v = this.view; const t = this.o.t;
    const text = `${formatDate(v.calendar, v.date)}${skyWeather(v)?.preset_label ? `, ${skyWeather(v).preset_label}` : ''}`;
    this.el.setAttribute('aria-label', this.mini ? t('MiniLabel', { date: text }) : this.gm ? t('GmLabel', { date: text }) : text);
    this.el.title = this.mini ? t('MiniLabel', { date: text }) : text;
    if (this.gm && !this.mini) { this.el.setAttribute('aria-haspopup', 'dialog'); this.el.setAttribute('aria-expanded', String(!!this.cradle)); } else { this.el.removeAttribute('aria-haspopup'); this.el.removeAttribute('aria-expanded'); }
  }

/* ── Placement: a corner of the free screen, kept per person. ── */

  /** The screen left clear by Foundry's sidebar and tool bar, and the panels a corner must not cover. */
  freeArea() {
    const W = window.innerWidth; const H = window.innerHeight;
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 ? b : null;
    };
    let left = 0; let right = W;
    const side = box('#sidebar');
    if (side && side.left > W / 2) right = side.left;
    const tools = box('#scene-controls') || box('#controls');
    if (tools && tools.right < W / 2) left = tools.right;
    const panels = ['#players', '#hotbar', '#navigation', '#scene-navigation', '#camera-views', '#chronicle-calendar-bar']
      .map(box).filter(Boolean);
    return { free: { left, top: 0, right, bottom: H }, panels };
  }

  spot(corner = this.corner) {
    const s = this.mini ? MINI : GLOBE;
    const { free, panels } = this.freeArea();
    return { at: clearOf(cornerSpots(free, s)[corner], s, panels, corner), free };
  }

  at(x, y) {
    this.pos = { x, y };
    const tr = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.el.style.transform = tr;
    this.el.style.setProperty('--csc-at', tr);
  }

  place(animate) {
    const { at } = this.spot();
    this.el.classList.toggle('csc-snap', !!animate && !this.rm);
    this.at(at.x, at.y);
    this.el.classList.toggle('csc-up', this.corner[0] === 'b');
    this.placed = true;
  }

  onDown(ev) {
    if (ev.button !== 0 || ev.target.closest('.csc-tool, .csc-cradle')) return;
    this.drag = { x0: ev.clientX, y0: ev.clientY, ox: this.pos?.x ?? 0, oy: this.pos?.y ?? 0, lx: ev.clientX, ly: ev.clientY, moved: false, shook: false };
    this.el.setPointerCapture(ev.pointerId);
    if (ev.pointerType !== 'mouse') this.el.classList.add('csc-touch');
  }

  onMove(ev) {
    const d = this.drag;
    if (!d) return;
    const dx = ev.clientX - d.x0; const dy = ev.clientY - d.y0;
    // A few pixels of wobble is still a click.
    if (!d.shook && Math.abs(dx) + Math.abs(dy) < 4) return;
    d.shook = true;
    this.shake(ev.clientX - d.lx, ev.clientY - d.ly);
    d.lx = ev.clientX; d.ly = ev.clientY;
    // A locked globe can still be shaken in place.
    if (this.locked) return;
    if (!d.moved) { d.moved = true; this.closeCradle(true); this.el.classList.add('csc-dragging'); this.el.classList.remove('csc-snap'); }
    this.at(d.ox + dx, d.oy + dy);
  }

  onUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.el.classList.remove('csc-dragging');
    if (d.moved) {
      const s = this.mini ? MINI : GLOBE;
      this.corner = nearestCorner(this.pos, this.freeArea().free, s);
      this.place(true);
      this.o.savePlace({ corner: this.corner });
    }
    // The click that ends a drag or a shake must not also open anything.
    if (d.shook) this.el.addEventListener('click', (e) => e.stopPropagation(), { once: true, capture: true });
  }

  onClick(ev) {
    if (ev.target.closest('.csc-lock')) { this.o.savePlace({ locked: !this.locked }); return; }
    if (ev.target.closest('.csc-shrink')) { this.closeCradle(true); this.o.savePlace({ mini: true }); return; }
    if (ev.target.closest('.csc-cradle')) return;
    if (this.mini) { this.o.grow(); return; }
    if (this.gm) this.toggleCradle();
  }

  onKey(ev) {
    if (ev.target !== this.el) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (this.mini) this.o.grow(); else if (this.gm) this.toggleCradle();
      return;
    }
    if (ev.key === ' ') { ev.preventDefault(); this.shake(18, -10); setTimeout(() => this.shake(-22, 8), 90); return; }
    if (this.locked) return;
    const next = cornerByKey(this.corner, ev.key);
    if (!next) return;
    ev.preventDefault();
    this.closeCradle(true);
    this.corner = next;
    this.place(true);
    this.o.savePlace({ corner: next });
  }

  /* ── The GM's cradle: a rounded band that slides out from behind the globe
     and holds it from below (from above in a bottom corner), its buttons
     along the curve. ── */

  toggleCradle() { if (this.cradle) this.closeCradle(); else this.openCradle(); }

  openCradle() {
    const t = this.o.t;
    const up = this.corner[0] === 'b' ? -1 : 1;
    const R = GLOBE / 2; const ARC = R + 22;
    const xy = (a, r) => { const rad = a * Math.PI / 180; return [100 + r * Math.cos(rad), 100 + up * r * Math.sin(rad)]; };
    const p = (a, r) => xy(a, r).map((v) => v.toFixed(1)).join(' ');
    const r0 = R + 3; const r1 = R + 41; const cap = (r1 - r0) / 2; const sw = up > 0 ? 1 : 0;
    const band = `M${p(6, r1)} A${r1} ${r1} 0 0 ${sw} ${p(174, r1)} A${cap} ${cap} 0 0 ${sw} ${p(174, r0)} A${r0} ${r0} 0 0 ${1 - sw} ${p(6, r0)} A${cap} ${cap} 0 0 ${sw} ${p(6, r1)}Z`;
    const spots = [
      { a: 160, u: 'day', n: -1, k: 'BackDay', txt: '−1d' }, { a: 128, u: 'hour', n: -1, k: 'BackHour', txt: '−1h' },
      { a: 52, u: 'hour', n: 1, k: 'ForwardHour', txt: '+1h' }, { a: 20, u: 'day', n: 1, k: 'ForwardDay', txt: '+1d' },
    ];
    let h = `<svg viewBox="0 0 200 200" aria-hidden="true"><path class="csc-band" d="${band}"/></svg>`;
    spots.forEach((s, i) => {
      const q = xy(s.a, ARC);
      h += `<button type="button" class="csc-step" style="left:${q[0]}px;top:${q[1]}px;--i:${i}" data-u="${s.u}" data-n="${s.n}" aria-label="${esc(t(s.k))}" title="${esc(t(s.k))}">${s.txt}</button>`;
    });
    const c = xy(90, ARC - 1);
    h += `<div class="csc-time" style="left:${c[0]}px;top:${c[1]}px"><b><i></i><span class="csc-tt"></span></b><span class="csc-dd"></span></div><span class="csc-sr" role="status" aria-live="polite"></span>`;
    const cradle = document.createElement('div');
    cradle.className = 'csc-cradle';
    cradle.setAttribute('role', 'dialog');
    cradle.setAttribute('aria-label', t('CradleLabel'));
    cradle.innerHTML = h;
    cradle.addEventListener('pointerdown', (e) => e.stopPropagation());
    cradle.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button[data-u]');
      if (b && !b.disabled) this.step(b.dataset.u, Number(b.dataset.n));
    });
    this.el.appendChild(cradle);
    this.cradle = cradle;
    this.el.classList.add('csc-open');
    // In a side corner the globe slides inward to make room for the cradle.
    const { at, free } = this.spot();
    this.nudge = cradleLayout(this.corner, at, free).nudge;
    if (this.nudge) { this.el.classList.toggle('csc-snap', !this.rm); this.at(at.x + this.nudge, at.y); }
    this.paintCradle();
    this.label();
    cradle.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  closeCradle(instant) {
    if (!this.cradle) return;
    const c = this.cradle;
    this.cradle = null;
    this.el.classList.remove('csc-open');
    if (this.nudge) { this.nudge = 0; this.place(!instant); }
    this.label();
    if (instant || this.rm) { c.remove(); return; }
    c.classList.add('csc-closing');
    setTimeout(() => c.remove(), 170);
  }

  paintCradle() {
    const c = this.cradle; const v = this.view;
    if (!c || !v) return;
    const t = this.o.t;
    c.querySelector('.csc-tt').textContent = formatTime(v.calendar, v.date);
    c.querySelector('.csc-dd').textContent = formatDate(v.calendar, v.date);
    c.querySelectorAll('button[data-u]').forEach((b) => { b.disabled = this.readOnly || this.busy || !this.o.source; });
    c.querySelector('.csc-time i').classList.toggle('csc-busy', this.busy);
    c.querySelector('.csc-sr').textContent = this.readOnly ? t('RealTime') : this.busy ? t('Saving') : t('Saved', { time: formatTime(v.calendar, v.date) });
  }

  /** A step is written to Chronicle; the globe follows when Chronicle's answer comes back. */
  async step(unit, n) {
    const src = this.o.source;
    if (!src || this.busy || this.readOnly) return;
    this.busy = true;
    this.paintCradle();
    let ok = false;
    try { ok = await src.step(unit, n); } catch (err) { console.debug('Chronicle Sync | Sky Clock step failed', err?.message); }
    this.busy = false;
    if (!ok) ui.notifications.warn(this.o.t('StepRefused'));
    this.paintCradle();
    this.cradle?.querySelector(`button[data-u="${unit}"][data-n="${n}"]`)?.focus({ preventScroll: true });
  }

/* ── Drawing ── */

  /**
   * A weather as the globe draws it, from the sky's own recipe for it: what
   * falls in front of the figure, and the marks it leaves on the stone.
   */
  weatherOf(view) {
    const w = skyWeather(view);
    let R = null;
    try { R = this.LOOKS ? this.LOOKS.resolve(this.LOOKS.spec(w)) : null; } catch { R = null; }
    if (!R) R = plainRecipe(frontWeather(w));
    return { front: frontOf(R), stone: stoneWeather(R) };
  }

  /** The weather showing now, part of the way through a change. */
  weatherNow() {
    const a = this.wxA || this.wxB; const b = this.wxB;
    if (!b) return { front: frontOf(null), stone: stoneWeather(null) };
    return { front: mixWeather(a.front, b.front, this.wxK), stone: mixWeather(a.stone, b.stone, this.wxK) };
  }

  paintNow() { if (this.view && this.D) this.paint(now(), 0); }

  paint(t, dt) {
    const D = this.D; const dpr = this.dpr; const g = this.bctx;
    this.W = this.weatherNow();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.back.width, this.back.height);
    let st = null;
    if (this.S && this.model) {
      const m = this.model; const cal = m.calendar; const mph = this.view.calendar.minutes_per_hour || 60;
      cal.current_hour = Math.floor(this.shownMin / mph);
      cal.current_minute = this.shownMin - cal.current_hour * mph;
      m.width = D; m.height = D;
      try {
        st = this.S.state(m, this.rm ? 0 : t, dt);
        this.S.paint(g, this.hold, st, dpr, 0, !!this.looping);
        this.skyPace = this.rm ? 0 : this.S.pace(st);
      } catch (err) {
        // One bad frame leaves the gradient behind the canvas showing.
        console.debug('Chronicle Sync | Sky Clock sky frame failed', err?.message);
        g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.back.width, this.back.height);
        st = null;
      }
    }
    this.el.classList.toggle('csc-painted', !!st);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawFigure(g, st, t);
    this.drawFront(t, dt);
  }

  drawFigure(g, st, t) {
    const D = this.D; const dpr = this.dpr;
    let fs = Math.round(D * 0.52);
    const k = clamp((t - this.figT0) / CRUMBLE_S, 0, 1);
    const changing = k < 1 && this.figPrev !== null;
    const txt = String(changing && k < 0.22 ? this.figPrev : this.day);
    // The old number fades as it breaks apart; the new one firms up as its crumbs arrive.
    const fade = !changing ? 1 : k < 0.22 ? 1 - clamp((k - 0.06) / 0.16, 0, 1) : clamp((k - 0.72) / 0.22, 0, 1);
    const bx = D / 2; const by = D * 0.8;
    let font = `${fs}px ${FIG_FONT}, Georgia, serif`;
    // Wide days like 28 shrink a little so the figure always clears the glass.
    g.font = font;
    const fw0 = g.measureText(txt).width;
    if (fw0 > D * 0.64) { fs = Math.floor(fs * D * 0.64 / fw0); font = `${fs}px ${FIG_FONT}, Georgia, serif`; }

    const L0 = figureLight(st);
    const L = { x: L0.x * D, y: L0.y * D, k: L0.k, warm: L0.warm };
    let lx = L.x - bx; let ly = L.y - (by - fs * 0.35); const ln = Math.hypot(lx, ly) || 1; lx /= ln; ly /= ln;
    const amb = st ? mixC(srgb(st.P.zen), srgb(st.P.hor), 0.65) : [60, 70, 110];
    const altDeg = st ? st.altEff : 30;
    const twi = clamp(1 - Math.abs(altDeg) / 12, 0, 1) * (L.warm ? 1 : 0);
    const over = st ? clamp(st.wx.cloud || 0, 0, 1) : 0;
    const lit = 0.8 + 0.45 * L.k;
    // Only a hint of the sky's colour, so the dark stone never blends into the sky behind it.
    let face = mixC([STONE[0] * lit, STONE[1] * lit, STONE[2] * lit], amb, 0.08);
    face = mixC(face, [150, 96, 60], twi * 0.18);
    // The weather colours the stone itself: rain darkens it, heat bleaches it, smoke blackens it.
    const S = this.W?.stone || stoneWeather(null);
    face = mixC(face, [face[0] * 0.6, face[1] * 0.63, face[2] * 0.7], S.wet * 0.85);
    face = mixC(face, [face[0] + 26, face[1] + 18, face[2] + 6], S.heat * 0.55);
    face = mixC(face, [26, 22, 20], S.soot * 0.6);
    if (S.grey) { const y = (face[0] + face[1] + face[2]) / 3; face = mixC(face, [y, y, y], S.grey * 0.8); }
    const under = face.map((c) => c * 0.6);
    const side = [face[0] * 0.34, face[1] * 0.33, face[2] * 0.32];

    g.save();
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const w = g.measureText(txt).width; const sA = fade * (0.35 + 0.65 * L.k) * (1 - over * 0.5);
    // A soft contact shadow, then the figure's shadow laid on the ground away from the light.
    const cs = g.createRadialGradient(bx, by + 1, 0, bx, by + 1, w * 0.6);
    cs.addColorStop(0, `rgba(0,0,0,${(0.42 * fade).toFixed(3)})`); cs.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = cs; g.setTransform(dpr, 0, 0, dpr * 0.12, 0, 0);
    g.beginPath(); g.arc(bx, (by + 1) / 0.12, w * 0.6, 0, TAU); g.fill();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.translate(bx, by + 0.5); g.transform(1, 0, clamp(lx, -1, 1) * 0.9, -0.26, 0, 0);
    g.filter = `blur(${D > 60 ? 1.2 : 0.6}px)`;
    g.fillStyle = `rgba(8,10,24,${(0.3 * sA).toFixed(3)})`; g.fillText(txt, 0, 0);
    g.restore();

    // The figure itself, drawn apart so its edge light and snow land only on it.
    const FIG = this.FIG; const FG = this.FG; const F2 = this.F2;
    for (const cv of [FIG, this.FIG2, this.MASK]) { if (cv.width !== this.back.width) { cv.width = this.back.width; cv.height = this.back.height; } }
    FG.setTransform(dpr, 0, 0, dpr, 0, 0); FG.clearRect(0, 0, D, D);
    FG.font = font; FG.textAlign = 'center'; FG.textBaseline = 'alphabetic';
    const depth = D > 60 ? 4 : 2;
    const ext = { x: -lx * 0.55, y: -ly * 0.45 + 0.25, n: depth };
    for (let i = depth; i >= 1; i--) { FG.fillStyle = rgb(side); FG.fillText(txt, bx + ext.x * i, by + ext.y * i); }
    const gr = FG.createLinearGradient(0, by - fs * 0.75, 0, by);
    gr.addColorStop(0, rgb(face)); gr.addColorStop(1, rgb(under));
    FG.fillStyle = gr; FG.fillText(txt, bx, by);
    const seed = Number(txt) || 0;
    FG.save(); FG.globalCompositeOperation = 'source-atop'; FG.globalAlpha = 0.9; FG.drawImage(this.grain, (seed * 37) % 40 - 40, -20, 200, 200); FG.restore();
    FG.save(); FG.globalCompositeOperation = 'source-atop'; FG.drawImage(this.weathering, (seed * 53) % 50 - 50, by - fs * 0.95, 220, 220 * fs / 160); FG.restore();
    const shape = shapeOf(txt, font, fs);
    crumble(FG, shape, bx, by, fs, seed, ext);
    // The worn outline, kept so the edge light and what settles follow the notches too.
    const MK = this.MK; MK.setTransform(1, 0, 0, 1, 0, 0); MK.clearRect(0, 0, this.MASK.width, this.MASK.height); MK.drawImage(FIG, 0, 0);
    this.stoneMarks(FG, S, shape, bx, by, fs, t);
    const edge = (dx, dy, col) => {
      F2.setTransform(1, 0, 0, 1, 0, 0); F2.globalCompositeOperation = 'source-over'; F2.clearRect(0, 0, this.FIG2.width, this.FIG2.height);
      F2.drawImage(this.MASK, 0, 0);
      F2.globalCompositeOperation = 'destination-out'; F2.drawImage(this.MASK, dx * dpr, dy * dpr);
      F2.globalCompositeOperation = 'source-in'; F2.fillStyle = col; F2.fillRect(0, 0, this.FIG2.width, this.FIG2.height);
      FG.setTransform(1, 0, 0, 1, 0, 0); FG.drawImage(this.FIG2, 0, 0); FG.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    // Matte stone: a soft chiselled edge toward the light, a shaded one away from it. Wet stone shines there.
    const hi = (0.22 + 0.2 * L.k + 0.4 * S.wet).toFixed(3);
    edge(-lx * 0.9, -ly * 0.9, L.warm ? `rgba(255,${236 + Math.round(10 * S.wet)},${206 + Math.round(30 * S.wet)},${hi})` : `rgba(${200 + Math.round(30 * S.wet)},${212 + Math.round(25 * S.wet)},240,${hi})`);
    edge(lx * 0.9, ly * 0.9, 'rgba(14,12,10,0.4)');
    // Frost rimes every edge; magic glows along the shaded one.
    if (S.rime > 0.05) for (const [dx, dy] of [[0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) edge(dx, dy, `rgba(214,236,255,${(0.5 * S.rime).toFixed(3)})`);
    if (S.glow?.k > 0.05) edge(lx * 1.2, ly * 1.2, rgb(S.glow.c, (0.45 * S.glow.k * (0.7 + 0.3 * Math.sin(t * 1.7))).toFixed(3)));
    // What settles on the tops: snow (deeper the harder it falls), hail, then sand or ash.
    const cap = D > 60 ? 1.5 : 1;
    if (S.snow > 0.05) edge(0, cap * (1 + 0.7 * S.snow), `rgba(255,255,255,${(0.95 * Math.min(1, S.snow * 1.1)).toFixed(3)})`);
    if (S.hail > 0.05) edge(0, cap * 0.8, `rgba(226,236,248,${(0.7 * S.hail).toFixed(3)})`);
    if (S.dust?.k > 0.05) edge(0, cap * 1.1, rgb(S.dust.c, (0.85 * S.dust.k).toFixed(3)));
    if (fade > 0) { g.save(); g.globalAlpha = fade; g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(FIG, 0, 0); g.restore(); }
    if (fade > 0.5) this.restingOnTops(g, S, shape, bx, by, fs, t);
    if (changing) {
      const prevTxt = String(this.figPrev);
      drawCrumbs(g, k, shapeOf(prevTxt, font, fs), shapeOf(String(this.day), font, fs), bx, by, face, side, fs / 60);
    }

    // The month, pressed into the ground in front.
    if (D > 60) {
      const ground = st ? srgb(st.P.h3) : [40, 60, 40];
      const lum = (ground[0] + ground[1] + ground[2]) / 3;
      g.save(); g.font = `600 ${(D * 0.058).toFixed(1)}px system-ui, sans-serif`; g.textAlign = 'center';
      g.letterSpacing = '1px';
      g.fillStyle = lum > 150 ? 'rgba(30,34,52,0.62)' : 'rgba(255,255,255,0.62)';
      g.fillText(monthLabel(this.view).toUpperCase(), bx, D * 0.925);
      g.restore();
    }
  }

  /**
   * The weather's marks drawn into the stone (only where the stone is): a
   * wash of dust, drops running down wet stone, dew catching the light, and
   * magic glowing out of the cracks. They move with time, so they are never
   * a still decal.
   */
  stoneMarks(F, S, shape, bx, by, fs, t) {
    const u = fs / 60;
    F.save(); F.globalCompositeOperation = 'source-atop';
    if (S.dust?.k > 0.05) { F.fillStyle = rgb(S.dust.c, (0.16 * S.dust.k).toFixed(3)); F.fillRect(0, 0, this.D, this.D); }
    if (S.wet > 0.05) {
      // Wet stone mirrors a little sky near its top.
      const sheen = F.createLinearGradient(0, by - fs * 0.75, 0, by - fs * 0.3);
      sheen.addColorStop(0, rgb(S.drip || [200, 214, 238], (0.1 * S.wet).toFixed(3))); sheen.addColorStop(1, 'rgba(0,0,0,0)');
      F.fillStyle = sheen; F.fillRect(0, by - fs, this.D, fs * 0.7);
      // Water running down: a thin dark run that fades behind a pinpoint of light, never a bead.
      const n = Math.round(shape.tops.length * Math.min(1, S.wet));
      for (let i = 0; i < n; i++) {
        const p = shape.tops[i]; const x = bx + p[0] + (rnd(i, 443) - 0.5) * 2 * u; const y0 = by + p[1];
        const run = (8 + rnd(i, 440) * 16) * u; const k = (t * 0.3 * (0.6 + rnd(i, 441)) + rnd(i, 442)) % 1; const y = y0 + run * k;
        const trail = F.createLinearGradient(0, y0, 0, y);
        trail.addColorStop(0, 'rgba(10,12,16,0)'); trail.addColorStop(1, `rgba(10,12,16,${(0.34 * S.wet).toFixed(3)})`);
        F.fillStyle = trail; F.fillRect(x - 0.3 * u, y0, 0.6 * u, y - y0);
        F.fillStyle = rgb(S.drip || [200, 214, 238], (0.5 * S.wet * (1 - k)).toFixed(3));
        F.fillRect(x - 0.25 * u, y - 0.5 * u, 0.5 * u, 0.7 * u);
      }
    }
    if (S.dew > 0.05) {
      for (let i = 0; i < 48; i++) {
        const p = shape.crumbs[(i * 5) % shape.crumbs.length]; if (!p) break;
        const a = S.dew * (0.25 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.6 + i * 2.3)));
        F.fillStyle = `rgba(236,244,255,${a.toFixed(3)})`;
        F.beginPath(); F.arc(bx + p[0], by + p[1], 0.45 * u + 0.2, 0, TAU); F.fill();
      }
    }
    if (S.glow?.k > 0.05) {
      F.globalCompositeOperation = 'source-over';
      F.strokeStyle = rgb(S.glow.c, (S.glow.k * (0.6 + 0.4 * Math.sin(t * 1.7))).toFixed(3));
      F.lineWidth = Math.max(0.8, 0.9 * u); F.shadowColor = rgb(S.glow.c, 0.9); F.shadowBlur = 3 * u;
      for (const line of crackLines(shape, bx, by, fs)) {
        F.beginPath(); line.forEach(([x, y], j) => (j ? F.lineTo(x, y) : F.moveTo(x, y))); F.stroke();
      }
    }
    F.restore();
  }

  /** What comes to rest on the figure's tops whole: hail pellets, fallen leaves or petals. */
  restingOnTops(g, S, shape, bx, by, fs, t) {
    const u = fs / 60;
    if (S.hail > 0.05) {
      const n = Math.round(10 * S.hail);
      for (let i = 0; i < n && i < shape.tops.length; i++) {
        const p = shape.tops[(i * 3) % shape.tops.length];
        g.fillStyle = `rgba(238,244,252,${(0.9 * S.hail).toFixed(3)})`;
        g.beginPath(); g.arc(bx + p[0] + (rnd(i, 450) - 0.5) * 2 * u, by + p[1] - 0.9 * u, 0.8 * u + 0.3, 0, TAU); g.fill();
      }
    }
    if (S.litter?.k > 0.05) {
      const n = Math.round(6 * S.litter.k); const petal = S.litter.kind === 'petal';
      for (let i = 0; i < n && i < shape.tops.length; i++) {
        const p = shape.tops[(i * 5 + 2) % shape.tops.length];
        g.save(); g.translate(bx + p[0], by + p[1] - 0.7 * u);
        g.rotate((rnd(i, 460) - 0.5) * 1.6 + 0.12 * Math.sin(t * 2.2 + i));
        g.fillStyle = rgb(i % 2 ? S.litter.c : S.litter.c2, (0.95 * S.litter.k).toFixed(3));
        g.beginPath(); g.ellipse(0, 0, (petal ? 1.5 : 2.3) * u, (petal ? 1 : 1.1) * u, 0, 0, TAU); g.fill();
        g.restore();
      }
    }
  }

  drawFront(t, dt) {
    const g = this.fctx; const D = this.D;
    g.clearRect(0, 0, D, D);
    if (this.mini) return;
    const F = this.W?.front || frontOf(null);
    const rain = F.rain; const storm = F.storm; const wet = rain + storm;
    if (wet > 0.01) {
      const n = Math.min(DROPS.length, Math.round(42 * rain + 40 * storm)); const wind = (0.14 * rain + 0.32 * storm) / wet;
      const tint = F.tint ? mixC([214, 226, 255], F.tint, 0.7) : [214, 226, 255];
      // Fine, faint streaks in two depths: far drops thinner and dimmer than near ones, so rain reads as rain, not dashes.
      g.lineCap = 'butt';
      for (const near of [false, true]) {
        g.strokeStyle = rgb(tint, ((near ? 0.42 : 0.24) * Math.min(1, wet)).toFixed(3)); g.lineWidth = near ? 0.8 : 0.55; g.beginPath();
        for (let k = near ? 0 : 1; k < n; k += 2) {
          const d = DROPS[k]; const sp = near ? 1.25 : 1; const len = d.l * (near ? 1.5 : 1);
          const y = ((d.y * (D + 20) + t * 130 * d.v * sp) % (D + 20)) - 10;
          const x = ((d.x * (D + 30) + y * wind) % (D + 30)) - 10;
          g.moveTo(x, y); g.lineTo(x - len * wind, y - len);
        }
        g.stroke();
      }
      this.drawGlassDrops(g, D, wet, F.tint, t);
    }
    const sn = Math.min(1, F.snow);
    if (sn > 0.01) {
      if (dt) stepParticles(FLAKES, dt, 1 + 0.6 * Math.max(0, F.snow - 1), t);
      g.fillStyle = `rgba(255,255,255,${(0.92 * sn).toFixed(3)})`;
      const n = Math.round(FLAKES.length * Math.min(1, 0.4 + 0.6 * F.snow));
      for (let k = 0; k < n; k++) { const p = FLAKES[k]; g.beginPath(); g.arc(p.x * D, p.y * D, p.r, 0, TAU); g.fill(); }
    }
    // Hail: hard white pellets, falling fast and straight.
    if (F.hail > 0.01) {
      g.fillStyle = `rgba(236,242,250,${(0.85 * F.hail).toFixed(3)})`;
      const n = Math.round(30 * F.hail);
      for (let k = 0; k < n; k++) {
        const d = DROPS[k]; const y = ((d.y * (D + 20) + t * 190 * d.v) % (D + 20)) - 10; const x = d.x * D;
        g.beginPath(); g.arc(x, y, 0.9 + d.v * 0.5, 0, TAU); g.fill();
      }
    }
    const fog = F.fog;
    if (fog > 0.01) {
      for (let b = 0; b < 3; b++) {
        const bx = ((t * (4 + b * 3) + b * 50) % (D * 2)) - D; const by = D * (0.42 + b * 0.16);
        const gr = g.createLinearGradient(0, by - 14, 0, by + 14);
        gr.addColorStop(0, 'rgba(225,230,238,0)'); gr.addColorStop(0.5, `rgba(225,230,238,${(0.34 * fog).toFixed(3)})`); gr.addColorStop(1, 'rgba(225,230,238,0)');
        g.fillStyle = gr; g.fillRect(bx, by - 14, D * 2, 28);
      }
    }
    if (this.glitter > 0.01) {
      if (dt) stepParticles(MOTES, dt, 0.5, t);
      MOTES.forEach((p, k) => {
        g.fillStyle = `rgba(255,226,150,${(this.glitter * (0.55 + 0.45 * Math.sin(t * 6 + k))).toFixed(3)})`;
        g.beginPath(); g.arc(p.x * D, p.y * D, p.r, 0, TAU); g.fill();
      });
    }
  }

  /**
   * Rain landing on the glass itself: a few small drops round the rim, faint,
   * coloured by the rain (red in blood rain, green in acid rain) so an
   * unusual rain reads at a glance. Still motion leaves them where they are.
   */
  drawGlassDrops(g, D, wet, tint, t) {
    const water = tint ? mixC([214, 226, 255], tint, 0.85) : [214, 226, 255];
    for (const d of glassDrops(wet, this.rm ? 0 : t)) {
      if (d.a <= 0.01) continue;
      const x = d.x * D; const y = d.y * D; const r = Math.max(1, d.r * D);
      if (d.trail > 0) {
        g.strokeStyle = rgb(water, (0.14 * d.a).toFixed(3)); g.lineWidth = r * 0.7; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x, y - d.trail * D); g.lineTo(x, y); g.stroke();
      }
      g.fillStyle = rgb(water, (0.22 * d.a).toFixed(3)); g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      // A darker lower rim and a pin of light up top: a lens of water, not a dot.
      g.strokeStyle = `rgba(16,20,28,${(0.3 * d.a).toFixed(3)})`; g.lineWidth = 0.6;
      g.beginPath(); g.arc(x, y, r, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
      g.fillStyle = `rgba(255,255,255,${(0.6 * d.a).toFixed(3)})`; g.beginPath(); g.arc(x - r * 0.35, y - r * 0.4, Math.max(0.35, r * 0.3), 0, TAU); g.fill();
    }
  }

  /** A storm lights the glass now and then. */
  flash(t) {
    if ((this.W?.front.storm || 0) < 0.6 || this.rm || this.mini || t < this.nextFlash) return;
    this.nextFlash = t + 5 + Math.random() * 5;
    const f = this.flashEl;
    f.style.transition = 'none'; f.style.opacity = '0.5';
    requestAnimationFrame(() => { f.style.transition = 'opacity 420ms cubic-bezier(.22,.8,.3,1)'; f.style.opacity = '0'; });
  }

  /** The contents lag behind the glass, so they are pushed against the motion, with a swirl. */
  shake(mx, my) {
    if (this.rm || this.mini) return;
    const sp = Math.min(60, Math.hypot(mx, my));
    if (sp < 1) return;
    this.stir = Math.min(1, this.stir + sp / 60);
    const f = this.weatherNow().front;
    const list = f.snow > 0.5 ? FLAKES : (f.rain + f.storm + f.hail > 0.5 ? null : MOTES);
    if (!list) return;
    // In clear weather a shake stirs up a few sparks of light instead of snow.
    if (list === MOTES) this.glitter = Math.min(1, this.glitter + sp / 40);
    list.forEach((p, k) => {
      const j = 0.5 + rnd(k, 70 + (this.frameN % 9));
      p.vx += (-mx * 0.06 + (rnd(k, this.frameN % 13) - 0.5) * 0.04 * sp) * j;
      p.vy += (-my * 0.06 - 0.02 * sp * rnd(k, 90)) * j;
    });
    this.pace();
  }

  /* ── Pace: one loop, a low frame rate, nothing when nobody is looking. ── */

  moving() {
    return !!this.glide || !!this.roll || this.stir > 0.03 || this.glitter > 0.03 || now() - this.figT0 < CRUMBLE_S;
  }

  /** Rain, snow or hail coming down in front of the figure. */
  falling() {
    const f = this.W?.front || this.weatherNow().front;
    return f.rain + f.storm + f.snow + f.hail > 0.5;
  }

  fps() {
    return framesPerSecond({
      hidden: document.hidden || !this.view,
      mini: this.mini,
      still: this.rm,
      resting: performance.now() - this.lastInput > REST_AFTER_MS,
      moving: this.moving(),
      falling: this.falling(),
      skyPace: this.skyPace,
    });
  }

  /** Anything mid-move lands at once when drawing stops. */
  finishMoves() {
    if (this.glide) { this.shownMin = this.glide.to; this.glide = null; }
    if (this.roll) { this.roll = null; this.wxK = 1; this.wxA = this.wxB; }
    this.paintNow();
  }

  loop() {
    this.raf = 0;
    if (this.gone) return;
    const f = this.fps();
    if (!f) { this.finishMoves(); return; }
    const t = now();
    if (t - this.lastDraw >= 1 / f - 0.002) {
      const dt = this.lastDraw < 0 ? 0 : Math.min(0.1, t - this.lastDraw);
      this.lastDraw = t; this.frameN++;
      this.stir *= Math.exp(-dt / 0.8); this.glitter *= Math.exp(-dt / 1.6);
      const gl = this.glide;
      if (gl) {
        const k = clamp((t - gl.t0) / GLIDE_S, 0, 1);
        this.shownMin = mix(gl.from, gl.to, easeOut(k));
        if (k >= 1) { this.shownMin = gl.to; this.glide = null; }
      }
      if (this.roll) {
        const fadeS = this.LOOKS?.FADE_S || 2;
        this.wxK = clamp((t - this.roll.t0) / fadeS, 0, 1);
        if (this.wxK >= 1) { this.roll = null; this.wxA = this.wxB; }
      }
      this.looping = true;
      this.paint(t, dt);
      this.looping = false;
      this.flash(t);
    }
    this.raf = requestAnimationFrame(() => this.loop());
  }

  pace() {
    if (this.gone || this.raf) return;
    this.lastDraw = -1;
    this.raf = requestAnimationFrame(() => this.loop());
  }

  wake() {
    const was = performance.now() - this.lastInput > REST_AFTER_MS;
    this.lastInput = performance.now();
    if (was) this.pace();
  }

  destroy() {
    this.gone = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const ev of ['pointermove', 'keydown', 'pointerdown', 'wheel']) document.removeEventListener(ev, this._wake);
    document.removeEventListener('visibilitychange', this._vis);
    document.removeEventListener('pointerdown', this._outside, true);
    document.removeEventListener('keydown', this._esc, true);
    window.removeEventListener('resize', this._resize);
    if (this._glChange) window.SkyGL?.offChange?.(this._glChange);
    this.el.remove();
  }
}

/** The month's name for the ground in front of the figure. */
function monthLabel(view) {
  const m = view?.calendar?.months?.[(view?.date?.month ?? 1) - 1];
  return m?.name || '';
}
