/**
 * Chronicle Sync - "Finish your hero"
 *
 * A hero built in Chronicle reaches Foundry without its class: the system
 * builds a class through its own level-up steps, which sync must not skip.
 * The GM's sync notes Chronicle's pick on the actor (actor-sync.mjs,
 * `classPick`). Here, on the client of the player who owns the actor:
 *
 * - one card per session offers to run those steps with Chronicle's class
 *   chosen (dnd5e's advancement window, or the class handed to the sheet as
 *   a drop on other systems, which then runs whatever a dragged class runs);
 * - the sheet carries a line naming the pick until a class item is on it, so
 *   a player who said "Later", or a GM, still sees what is left to do.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { escapeHtml } from './_escape-html.mjs';
import { choiceDialog } from './_dialogs.mjs';
import { findIdentityItem } from './_identity-item-apply.mjs';
import { CLASS_PICK_FLAG, pickToFinish, offersCard } from './_finish-hero.mjs';

const LINE_CLASS = 'chronicle-finish-hero';

/** Actors already offered the card this session, so it is asked once. */
const shown = new Set();
/** Cards wait for each other: two at once would stack on the screen. */
let queue = Promise.resolve();

const t = (key, data) => (data
  ? game.i18n.format(`CHRONICLE.FinishHero.${key}`, data)
  : game.i18n.localize(`CHRONICLE.FinishHero.${key}`));

/** What the actor still needs, from its flag and its items. */
function pendingPick(actor) {
  if (!actor?.getFlag?.(FLAG_SCOPE, 'entityId')) return null;
  const items = actor.items?.contents ?? Array.from(actor.items ?? []);
  return pickToFinish(items, actor.getFlag(FLAG_SCOPE, CLASS_PICK_FLAG) ?? null);
}

/** Register the hooks. Called once at ready, on every client. */
export function registerFinishHero() {
  Hooks.on('renderActorSheet', onRenderSheet);
  Hooks.on('renderActorSheetV2', onRenderSheet);
  // A new pick from the GM's sync, or a hero handed to this player later.
  Hooks.on('updateActor', (actor, change) => {
    const picked = foundry.utils.hasProperty(change ?? {}, `flags.${FLAG_SCOPE}.${CLASS_PICK_FLAG}`);
    if (picked || change?.ownership) maybeOffer(actor);
  });
  for (const actor of game.actors ?? []) maybeOffer(actor);
}

function maybeOffer(actor) {
  const pick = pendingPick(actor);
  const key = actor?.id;
  if (!offersCard({ isGM: !!game.user?.isGM, isOwner: !!actor?.isOwner, pick, shown: shown.has(key) })) return;
  shown.add(key);
  queue = queue.then(() => offer(actor)).catch((err) => console.warn('Chronicle: finish-hero card failed', err));
}

async function offer(actor) {
  const pick = pendingPick(actor);
  if (!pick) return;
  const data = { actor: escapeHtml(actor.name), cls: escapeHtml(pick.name), level: pick.level };
  const content = `<p>${t('Body', data)}</p>${pick.level > 1 ? `<p>${t('BodyLevel', data)}</p>` : ''}`;
  const res = await choiceDialog({
    title: t('Title', { actor: actor.name }),
    content,
    buttons: [
      { action: 'finish', label: t('Finish'), default: true },
      { action: 'later', label: t('Later') },
    ],
  });
  if (res?.action === 'finish') await finishHero(actor);
}

/**
 * Run the system's own steps for Chronicle's class. Falls back to opening
 * the sheet with a notice saying which class to drag on.
 * @param {Actor} actor
 */
export async function finishHero(actor) {
  const pick = pendingPick(actor);
  if (!pick) return;
  try {
    const item = await findIdentityItem(game, 'class', pick.name);
    if (!item) {
      ui.notifications?.warn(t('NoClass', { cls: escapeHtml(pick.name) }));
      await actor.sheet?.render({ force: true });
      return;
    }
    const data = item.toObject();
    delete data._id;
    if (item.pack) foundry.utils.setProperty(data, '_stats.compendiumSource', item.uuid);

    const Manager = globalThis.dnd5e?.applications?.advancement?.AdvancementManager;
    if (typeof Manager?.forNewItem === 'function') {
      // dnd5e builds each level's steps up to the class item's levels.
      if (pick.level > 1 && data.system && 'levels' in data.system) data.system.levels = pick.level;
      const manager = Manager.forNewItem(actor, data);
      if (manager?.steps?.length) {
        manager.render({ force: true });
        return;
      }
      await actor.createEmbeddedDocuments('Item', [data]);
      return;
    }

    const sheet = actor.sheet;
    await sheet?.render({ force: true });
    const root = await sheetElement(sheet);
    if (!root || !dropOnSheet(root, item.uuid)) {
      ui.notifications?.info(t('DragIt', { cls: escapeHtml(pick.name) }));
    }
  } catch (err) {
    console.error(`Chronicle: could not finish "${actor.name}"`, err);
    ui.notifications?.warn(t('Failed', { actor: escapeHtml(actor.name), cls: escapeHtml(pick.name) }));
  }
}

/** The sheet's element once drawn (v1 sheets draw after render returns). */
async function sheetElement(sheet) {
  for (let i = 0; i < 20; i += 1) {
    const el = sheet?.element instanceof HTMLElement ? sheet.element : sheet?.element?.[0];
    if (el?.isConnected) return el;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/**
 * Hand the class to the sheet as if dragged from the sidebar. Dispatched on
 * the deepest common body so it bubbles past whichever element the sheet
 * listens on.
 */
function dropOnSheet(root, uuid) {
  if (typeof DataTransfer !== 'function' || typeof DragEvent !== 'function') return false;
  const target = root.querySelector('.tab.active') ?? root.querySelector('.sheet-body')
    ?? root.querySelector('.window-content') ?? root;
  const dataTransfer = new DataTransfer();
  dataTransfer.setData('text/plain', JSON.stringify({ type: 'Item', uuid }));
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  return true;
}

/** The line on the sheet, for its owners, while a class is still to come. */
function onRenderSheet(app, html) {
  const actor = app?.actor ?? app?.document;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!actor || !root) return;
  root.querySelector(`.${LINE_CLASS}`)?.remove();
  const pick = pendingPick(actor);
  if (!pick || !actor.isOwner) return;

  const line = document.createElement('div');
  line.className = LINE_CLASS;
  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-scroll';
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = t('SheetLine', { cls: pick.name, level: pick.level });
  line.append(icon, text);
  if (!game.user?.isGM) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t('Finish');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      finishHero(actor);
    });
    line.append(button);
  }
  const host = root.querySelector('.window-content') ?? root;
  host.prepend(line);
}
