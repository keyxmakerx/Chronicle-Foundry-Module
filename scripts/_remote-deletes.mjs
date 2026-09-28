/**
 * Deleting something in Foundry never deletes its Chronicle copy without
 * asking (#107). Chronicle deletes pages and notes for good, and a bulk
 * delete in Foundry (a clean-up, another module, a system update that
 * recreates actors) would otherwise take them all with it at once. Deletes
 * that come within a moment of each other are asked about together, and
 * the answer defaults to keeping them. `tools/test-remote-deletes.mjs`.
 */

import { confirmDialog } from './_dialogs.mjs';

/** How long after the last delete the question waits for more to arrive. */
export const REMOTE_DELETE_WAIT_MS = 400;

/**
 * Collects deletes and asks once per burst.
 * @param {{ask: (items: object[]) => Promise<boolean>, onDone?: (result: object) => void,
 *   delayMs?: number, setTimer?: Function, clearTimer?: Function}} deps
 * @returns {{add: (item: {label: string, run: () => Promise<any>}) => void, flush: () => Promise<object>}}
 */
export function createRemoteDeleteBatch({ ask, onDone = () => {}, delayMs = REMOTE_DELETE_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let items = [];
  let timer = null;

  async function flush() {
    timer = null;
    const batch = items;
    items = [];
    if (!batch.length) return { asked: false, deleted: 0, kept: 0 };
    let yes = false;
    try {
      yes = (await ask(batch)) === true;
    } catch (err) {
      console.warn('Chronicle: Could not ask about deleting in Chronicle; keeping everything', err);
    }
    let deleted = 0;
    if (yes) {
      for (const item of batch) {
        try {
          await item.run();
          deleted++;
        } catch (err) {
          // It may already be gone on Chronicle's side, which is fine.
          console.warn(`Chronicle: Failed to delete "${item.label}" in Chronicle`, err);
        }
      }
    }
    const result = { asked: true, deleted, kept: batch.length - deleted };
    onDone(result);
    return result;
  }

  return {
    add(item) {
      items.push(item);
      if (timer) clearTimer(timer);
      timer = setTimer(flush, delayMs);
    },
    flush,
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** At most this many names are listed; the rest are counted. */
const LIST_MAX = 20;

async function askGM(items) {
  const shown = items.slice(0, LIST_MAX).map((it) => `<li>${escapeHtml(it.label)}</li>`).join('');
  const more = items.length > LIST_MAX ? `<li>${escapeHtml(game.i18n.format('CHRONICLE.RemoteDelete.More', { count: items.length - LIST_MAX }))}</li>` : '';
  return confirmDialog({
    title: game.i18n.localize('CHRONICLE.RemoteDelete.Title'),
    content: game.i18n.format('CHRONICLE.RemoteDelete.Body', { count: items.length, list: `<ul>${shown}${more}</ul>` }),
    defaultYes: false,
  });
}

function notify(result) {
  if (result.deleted) ui.notifications?.info?.(game.i18n.format('CHRONICLE.RemoteDelete.Deleted', { count: result.deleted }));
  if (result.kept) ui.notifications?.info?.(game.i18n.format('CHRONICLE.RemoteDelete.Kept', { count: result.kept }));
}

let shared = null;

/**
 * Queues one Foundry-side delete for the GM's answer: `run` deletes the
 * Chronicle copy and is called only on Yes.
 * @param {{label: string, run: () => Promise<any>}} item
 */
export function queueRemoteDelete(item) {
  if (!shared) shared = createRemoteDeleteBatch({ ask: askGM, onDone: notify });
  shared.add(item);
}
