/**
 * Chronicle Sync - Chronicle's own scripts, vendored
 *
 * Loads files from vendor/chronicle/ (Chronicle's page scripts, copied
 * unchanged) into the Foundry page, once each and in order. Those scripts
 * register themselves on a page global named Chronicle; one stand-in serves
 * every vendored widget (the shop room and the Sky Clock's sky), and one
 * that something else put there is never replaced.
 */

import { MODULE_ID } from './constants.mjs';
import { createChronicleShim } from './_shop-room-data.mjs';

const VENDOR = `modules/${MODULE_ID}/vendor/chronicle`;

let shim = null;
const loads = new Map();

/** The page's Chronicle stand-in, made on first use. Throws if another script owns the name. */
export function chronicleShim() {
  if (globalThis.Chronicle && globalThis.Chronicle !== shim) {
    throw new Error('another script already defines window.Chronicle');
  }
  shim = shim || createChronicleShim();
  globalThis.Chronicle = shim;
  return shim;
}

function loadOne(file) {
  if (!loads.has(file)) {
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${VENDOR}/${file}`;
      s.charset = 'utf-8';
      s.onload = resolve;
      s.onerror = () => reject(new Error(`could not load ${file}`));
      document.head.appendChild(s);
    });
    // A failed load is tried again next time.
    p.catch(() => loads.delete(file));
    loads.set(file, p);
  }
  return loads.get(file);
}

/** Load vendored files in order, each only once; resolves to the shim. */
export async function loadVendored(files) {
  const s = chronicleShim();
  for (const file of files) await loadOne(file);
  return s;
}
