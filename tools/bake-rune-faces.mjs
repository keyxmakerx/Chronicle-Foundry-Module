#!/usr/bin/env node
/**
 * Bakes Chronicle's rune numerals into the Dice So Nice face pictures in
 * assets/dice/rune/faces/. Each is a 256px clear tile holding one numeral in
 * white metal over a dark cut line, drawn with the strokes from Chronicle's
 * dice engine; Dice So Nice tints the white to each colour's ink
 * (`labelComposite: 'multiply'`, set in _rune-dice.mjs).
 *
 * Dice So Nice maps every face onto its tile as an upright regular shape. The
 * centres and sizes below were measured from its own picture dice, and the
 * numeral heights keep Chronicle's ratio of numeral to face. The d4 is left
 * out: Dice So Nice draws d4 pictures without the tint.
 *
 * Usage: CHRONICLE_DIR=../Chronicle node tools/bake-rune-faces.mjs
 * Needs Playwright with Chromium (installed globally is fine).
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'dice', 'rune', 'faces');
const TILE = 256;
const upTo = (n) => Array.from({ length: n }, (_, i) => String(i + 1));

/** Per die: the face's centre and inradius on the tile, and Chronicle's numeral height over inradius (one digit, two). */
const SHAPES = {
  d6: { c: [128, 128], inr: 128, k1: 0.860, k2: 0.699, labels: upTo(6) },
  d8: { c: [128.5, 137], inr: 68, k1: 0.819, k2: 0.665, labels: upTo(8) },
  d10: { c: [129, 166], inr: 68.6, k1: 0.798, k2: 0.648, labels: upTo(10) },
  d12: { c: [127, 134], inr: 107.6, k1: 0.843, k2: 0.685, labels: upTo(12) },
  // Chronicle sets a d20's numeral a little low on its face.
  d20: { c: [129, 146], inr: 73, k1: 0.770, k2: 0.626, drop: 0.05, labels: upTo(20) },
  // Dice So Nice's d100 values run 10..100, and 100 reads 00.
  d100: { c: [129, 166], inr: 68.6, k1: 0.798, k2: 0.648, labels: ['10', '20', '30', '40', '50', '60', '70', '80', '90', '00'] },
};

async function playwright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(join(globalRoot, '/'))('playwright');
  }
}

async function main() {
  const dir = process.env.CHRONICLE_DIR;
  if (!dir) throw new Error('Set CHRONICLE_DIR to a Chronicle checkout.');
  const engine = await import(pathToFileURL(resolve(dir, 'static/js/dice/engine.js')).href);

  const jobs = [];
  for (const [type, s] of Object.entries(SHAPES)) {
    for (const label of s.labels) {
      const h = (label.length > 1 ? s.k2 : s.k1) * s.inr;
      const cx = s.c[0], cy = s.c[1] + (s.drop ? s.drop * s.k1 / 0.96 * s.inr : 0);
      jobs.push({ file: `${type}-${label}.png`, label, cx, cy, h, w: Math.max(2, h * 0.13), strokes: engine.strokesFor(label, cx, cy, h) });
    }
  }

  const { chromium } = await playwright();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const baked = await page.evaluate(({ jobs, TILE }) => jobs.map((j) => {
    const c = document.createElement('canvas');
    c.width = c.height = TILE;
    const g = c.getContext('2d');
    // The same strokes and joins as Chronicle's paintNumeral, with its dot under a 6 or 9.
    const draw = (w) => {
      g.lineJoin = 'miter'; g.miterLimit = 3; g.lineCap = 'butt'; g.lineWidth = w;
      for (const pl of j.strokes) {
        g.beginPath(); g.moveTo(pl[0][0], pl[0][1]);
        for (let i = 1; i < pl.length; i++) g.lineTo(pl[i][0], pl[i][1]);
        g.stroke();
      }
      if (j.label === '6' || j.label === '9') { g.beginPath(); g.arc(j.cx, j.cy + j.h * 0.68, w * 0.62, 0, 7); g.fill(); }
    };
    g.fillStyle = g.strokeStyle = 'rgba(0,0,0,.55)';
    draw(j.w * 1.28);
    const metal = g.createLinearGradient(0, j.cy - j.h / 2, 0, j.cy + j.h / 2);
    metal.addColorStop(0, '#ffffff'); metal.addColorStop(1, '#cdcdcd');
    g.fillStyle = g.strokeStyle = metal;
    draw(j.w);
    return { file: j.file, data: c.toDataURL('image/png').split(',')[1] };
  }), { jobs, TILE });
  await browser.close();

  mkdirSync(OUT, { recursive: true });
  for (const b of baked) writeFileSync(join(OUT, b.file), Buffer.from(b.data, 'base64'));
  console.log(`${baked.length} faces in ${OUT}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
