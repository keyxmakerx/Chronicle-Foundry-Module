/**
 * Chronicle Sync - Maps on character sheets
 *
 * The GM gives a Chronicle map to a character ("Give this map to a
 * character" on a map's journal entry). It becomes an item in the
 * character's inventory; its Open button unfolds the live map in its own
 * window while the sheet stays open. Giving the map also lets the players
 * who own that character open its journal.
 *
 * Sheet markup differs per system, so the Open button is added where an
 * item row can be found and always on the item's own sheet; if neither is
 * found the map is still an ordinary item, never an error.
 */

import { FLAG_SCOPE } from './constants.mjs';
import {
  pickMapItemType, journalAccessForActorOwners, mapPageUuidOf,
} from './_map-item-rules.mjs';

const OPEN_CLASS = 'cs-open-map';

/** Register hooks. Called once at `ready`. */
export function registerMapSheetItems() {
  // v12 names the directory context hook per document; v13+ per directory.
  Hooks.on('getJournalEntryContext', _addGiveOption);
  Hooks.on('getJournalEntryContextOptions', _addGiveOption);
  Hooks.on('renderActorSheet', _onRenderActorSheet);
  Hooks.on('renderActorSheetV2', _onRenderActorSheet);
  Hooks.on('renderItemSheet', _onRenderItemSheet);
  Hooks.on('renderItemSheetV2', _onRenderItemSheet);
}

/** The Chronicle map page of a journal entry, if it is one. */
function _mapPageOf(entry) {
  return entry?.pages?.find?.((p) => p.getFlag(FLAG_SCOPE, 'mapId')) || null;
}

function _entryFromLi(li) {
  const el = li instanceof HTMLElement ? li : li?.[0];
  const id = el?.dataset?.entryId || el?.dataset?.documentId;
  return id ? game.journal.get(id) : null;
}

function _addGiveOption(_app, options) {
  if (!Array.isArray(options)) return;
  const name = game.i18n.localize('CHRONICLE.MapItems.Give');
  // Some versions fire both hook names; add the option once.
  if (options.some((o) => o?.name === name)) return;
  options.push({
    name,
    icon: '<i class="fa-solid fa-map"></i>',
    condition: (li) => game.user.isGM && !!_mapPageOf(_entryFromLi(li)),
    callback: async (li) => {
      try {
        await _promptGive(_entryFromLi(li));
      } catch (err) {
        console.error('Chronicle: give map failed', err);
        ui.notifications.error(game.i18n.localize('CHRONICLE.MapItems.GiveFailed'));
      }
    },
  });
}

/** Ask the GM which character gets the map, then give it. */
async function _promptGive(entry) {
  const page = _mapPageOf(entry);
  if (!page) return;
  const actors = game.actors.filter((a) => a.hasPlayerOwner).sort((a, b) => a.name.localeCompare(b.name));
  if (!actors.length) {
    ui.notifications.warn(game.i18n.localize('CHRONICLE.MapItems.NoCharacters'));
    return;
  }
  const select = document.createElement('select');
  select.name = 'actorId';
  for (const a of actors) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    select.appendChild(opt);
  }
  const content = `<div class="form-group"><label>${game.i18n.localize('CHRONICLE.MapItems.Character')}</label>${select.outerHTML}</div>`;
  const actorId = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.format('CHRONICLE.MapItems.GiveTitle', { name: entry.name }) },
    content,
    ok: {
      label: game.i18n.localize('CHRONICLE.MapItems.GiveButton'),
      callback: (_event, button) => button.form.elements.actorId.value,
    },
    rejectClose: false,
  });
  const actor = actorId ? game.actors.get(actorId) : null;
  if (actor) await giveMapToActor(page, actor);
}

/**
 * Give a Chronicle map page to an actor as an inventory item.
 * @param {JournalEntryPage} page
 * @param {Actor} actor
 */
export async function giveMapToActor(page, actor) {
  if (!game.user.isGM) return;
  const already = actor.items.find((i) => i.getFlag(FLAG_SCOPE, 'mapPageUuid') === page.uuid);
  if (already) {
    ui.notifications.info(game.i18n.format('CHRONICLE.MapItems.AlreadyHas', { actor: actor.name }));
    return;
  }
  const type = pickMapItemType(game.documentTypes?.Item ?? Object.keys(CONFIG.Item?.dataModels ?? {}));
  if (!type) {
    ui.notifications.warn(game.i18n.localize('CHRONICLE.MapItems.NoItemType'));
    return;
  }

  const entry = page.parent;
  const gmIds = new Set(game.users.filter((u) => u.isGM).map((u) => u.id));
  const access = journalAccessForActorOwners(
    actor.ownership, entry.ownership, gmIds, CONST.DOCUMENT_OWNERSHIP_LEVELS,
  );
  if (Object.keys(access).length) {
    await entry.update({ ownership: { ...entry.ownership, ...access } });
  }

  await actor.createEmbeddedDocuments('Item', [{
    name: game.i18n.format('CHRONICLE.MapItems.ItemName', { name: entry.name }),
    type,
    img: 'icons/svg/book.svg',
    flags: {
      [FLAG_SCOPE]: {
        mapPageUuid: page.uuid,
        mapId: page.getFlag(FLAG_SCOPE, 'mapId'),
      },
    },
  }]);
  ui.notifications.info(game.i18n.format('CHRONICLE.MapItems.Given', { name: entry.name, actor: actor.name }));
}

/**
 * Open the live map an item carries, unfolding out of `fromEl` like a
 * paper map (a short fade with reduced motion).
 * @param {string} pageUuid
 * @param {Element|null} fromEl
 */
export async function openMapPage(pageUuid, fromEl = null) {
  const page = pageUuid ? await fromUuid(pageUuid) : null;
  if (!page || !page.parent?.testUserPermission?.(game.user, 'OBSERVER')) {
    ui.notifications.warn(game.i18n.localize('CHRONICLE.MapItems.CannotOpen'));
    return;
  }
  const sheet = page.parent.sheet;
  const isV2 = sheet instanceof foundry.applications.api.ApplicationV2;
  const app = isV2
    ? await sheet.render({ force: true, pageId: page.id })
    : await sheet.render(true, { pageId: page.id });
  const el = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
  if (el) _unfold(el, fromEl);
}

/** The unfold: from the clicked row to the window, sideways then down. */
function _unfold(win, fromEl) {
  if (typeof win.animate !== 'function') return;
  const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !fromEl) {
    win.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
    return;
  }
  const a = fromEl.getBoundingClientRect();
  const b = win.getBoundingClientRect();
  if (!b.width || !b.height) return;
  const sx = a.width / b.width;
  const sy = a.height / b.height;
  const dx = a.left - b.left;
  const dy = a.top - b.top;
  const origin = win.style.transformOrigin;
  win.style.transformOrigin = '0 0';
  const creases = document.createElement('div');
  creases.className = 'cs-map-creases';
  win.appendChild(creases);
  const anim = win.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
    { transform: `translate(${dx * 0.5}px, ${dy}px) scale(1, ${sy})`, offset: 0.45 },
    { transform: `translate(0, ${dy * 0.15}px) scale(1, 1.02)`, offset: 0.85 },
    { transform: 'none' },
  ], { duration: 620, easing: 'cubic-bezier(.3,.8,.3,1)' });
  creases.animate([{ opacity: 1 }, { opacity: 0.7, offset: 0.6 }, { opacity: 0 }], { duration: 700, fill: 'forwards' });
  const done = () => { creases.remove(); win.style.transformOrigin = origin; };
  anim.finished.then(done, done);
}

function _openButton(uuid) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = OPEN_CLASS;
  btn.dataset.mapPageUuid = uuid;
  btn.innerHTML = `<i class="fa-solid fa-map" aria-hidden="true"></i> ${game.i18n.localize('CHRONICLE.MapItems.Open')}`;
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openMapPage(uuid, btn.closest('[data-item-id],[data-entry-id],[data-document-id]') || btn);
  });
  return btn;
}

function _onRenderActorSheet(app, html) {
  const actor = app?.actor ?? app?.document;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!actor?.items || !root) return;
  for (const item of actor.items) {
    const uuid = mapPageUuidOf(item.flags?.[FLAG_SCOPE]);
    if (!uuid) continue;
    const row = root.querySelector(
      `[data-item-id="${item.id}"], [data-entry-id="${item.id}"], [data-document-id="${item.id}"]`,
    );
    if (!row || row.querySelector(`.${OPEN_CLASS}`)) continue;
    row.classList.add('cs-map-item');
    row.appendChild(_openButton(uuid));
  }
}

function _onRenderItemSheet(app, html) {
  const item = app?.item ?? app?.document;
  const uuid = mapPageUuidOf(item?.flags?.[FLAG_SCOPE]);
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!uuid || !root || root.querySelector('.cs-map-item-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'cs-map-item-banner';
  const note = document.createElement('span');
  note.textContent = game.i18n.localize('CHRONICLE.MapItems.FromChronicle');
  banner.append(note, _openButton(uuid));
  const host = root.querySelector('.window-content') || root;
  host.prepend(banner);
}
