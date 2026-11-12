/**
 * Chronicle Sync - the end-of-combat spoils prompt (GM)
 *
 * When the GM ends a combat, the active GM's client lists the defeated
 * creatures that belong to a Chronicle page with what their drop lists
 * leave, and puts the ticked ones in the party's spoils tray only on "Put in
 * the tray" (_spoils-prompt.mjs holds the decisions). A combat whose tokens
 * belong to a planned encounter with stages still to come asks first: the
 * defeated are held on the scene (flag `craftingHeld`) until a later combat
 * of that encounter ends with no stage left, or the GM says the whole fight
 * is over. A campaign with no drop lists sees nothing.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { CREATURE_FLAG } from './creature-sync.mjs';
import { creatureSync } from './creature-forms.mjs';
import { choiceDialog } from './_dialogs.mjs';
import { escapeHtml, noticeText } from './_escape-html.mjs';
import { isAnsweringGM } from './_stash-relay.mjs';
import { ENCOUNTER_TOKEN_FLAG, parseEncounter, tokenRef } from './_encounter-roster.mjs';
import { encounterPath } from './_encounter-list.mjs';
import { parseStages } from './_encounter-stages.mjs';
import { craftingAvailable, getCraftingSync } from './crafting-relay.mjs';
import {
  HP_PATHS, dropSummaries, dropText, fightBody, fightResult, fightRows, firstHp, heldCreatures, isDefeated,
  promptRows, stagesToCome,
} from './_spoils-prompt.mjs';

const HELD_FLAG = 'craftingHeld';
const STAGES_FLAG = 'encounterStages';

const t = (key) => game.i18n.localize(`CHRONICLE.Spoils.${key}`);
const f = (key, data) => game.i18n.format(`CHRONICLE.Spoils.${key}`, data);

/** Combats already asked about, so a repeated hook can't ask twice. */
const asked = new Set();

export function registerSpoilsPrompt() {
  Hooks.on('deleteCombat', (combat) => {
    onCombatEnded(combat).catch((err) => console.warn('Chronicle: the spoils prompt failed', err));
  });
}

/** A combatant as the pure helpers want it. */
function describe(cb) {
  const token = cb.token ?? null;
  const actor = cb.actor ?? token?.actor ?? null;
  const get = foundry.utils.getProperty;
  const paths = [creatureSync()?.staminaPaths?.()?.value, ...HP_PATHS].filter(Boolean);
  const ref = tokenRef(token?.getFlag?.(FLAG_SCOPE, ENCOUNTER_TOKEN_FLAG));
  return {
    id: cb.tokenId || cb.id,
    name: cb.name || token?.name || actor?.name || '',
    defeated: isDefeated({ marked: cb.isDefeated ?? cb.defeated, hp: actor ? firstHp(paths.map((p) => get(actor, p))) : null }),
    playerOwned: !!actor?.hasPlayerOwner,
    pageId: String(actor?.getFlag?.(FLAG_SCOPE, CREATURE_FLAG) || actor?.getFlag?.(FLAG_SCOPE, 'entityId') || ''),
    encounterId: ref?.encounterId ?? '',
    rowId: ref?.rowId ?? '',
  };
}

/** An encounter's creature rows and stages, or null when Chronicle can't say. */
async function loadEncounter(api, id) {
  try {
    const enc = parseEncounter(await api.get(encounterPath(id)));
    if (!enc) return null;
    return { ...enc, stages: parseStages(enc.stages, new Set(enc.creatures.map((c) => c.id))) };
  } catch (err) {
    console.debug('Chronicle: spoils prompt could not read an encounter', err?.message);
    return null;
  }
}

async function onCombatEnded(combat) {
  if (!game.user.isGM || !isAnsweringGM(game.user, game.users.activeGM)) return;
  if (!combat?.started || asked.has(combat.id) || !craftingAvailable()) return;
  const api = getCraftingSync()?._api;
  if (!api) return;
  asked.add(combat.id);

  const scene = combat.scene ?? game.scenes?.get(combat._source?.scene) ?? null;
  const current = combat.combatants.map(describe);
  const encIds = [...new Set(current.map((c) => c.encounterId).filter(Boolean))];
  const encounters = (await Promise.all(encIds.map((id) => loadEncounter(api, id)))).filter(Boolean);
  // A token an encounter placed belongs to the page its row plans.
  for (const c of current) {
    const enc = encounters.find((e) => e.id === c.encounterId);
    const page = enc?.creatures.find((r) => r.id === c.rowId)?.entityId;
    if (page) c.pageId = page;
  }

  const heldStore = scene?.getFlag?.(FLAG_SCOPE, HELD_FLAG) ?? {};
  const held = encIds.flatMap((id) => (Array.isArray(heldStore[id]?.creatures) ? heldStore[id].creatures : []));
  const creatures = [...held, ...current];
  const rows = fightRows(creatures);
  if (!rows.length) return clearHeld(scene, encIds);

  const memory = scene?.getFlag?.(FLAG_SCOPE, STAGES_FLAG) ?? {};
  const waiting = encounters.find((e) => stagesToCome(e.stages, memory[e.id]) > 0);
  if (waiting && !(await fightIsOver(waiting, stagesToCome(waiting.stages, memory[waiting.id])))) {
    return hold(scene, waiting.id, encIds, heldCreatures(creatures));
  }

  let summaries;
  try {
    summaries = dropSummaries(await api.get('/crafting/spoils'));
  } catch (err) {
    console.warn('Chronicle: spoils prompt could not read the drop lists', err?.message);
    return;
  }
  const view = promptRows(rows, summaries);
  if (!summaries.size || !view.some((r) => r.can)) return clearHeld(scene, encIds);

  const ticked = await askToDrop(view);
  // Cleared before the call: a failed call is never retried on its own, since
  // Chronicle may have dropped already and every call drops again.
  await clearHeld(scene, encIds);
  if (!ticked?.size) return;
  const body = fightBody(fightName(encounters, scene), rows, ticked);
  if (!body) return;
  try {
    report(body.name, fightResult(await api.post('/crafting/fights', body)));
  } catch (err) {
    ui.notifications.error(f('Failed', { reason: noticeText(err?.serverMessage || err?.message || '') }));
  }
}

/** The tray's name for this fight: the planned encounter's, else the scene's. */
function fightName(encounters, scene) {
  const name = encounters.length === 1 ? encounters[0].name : scene?.name;
  return f('FightName', { name: name || t('AFight') });
}

/** Ask whether a fight with stages still to come is over anyway. */
async function fightIsOver(enc, n) {
  const res = await choiceDialog({
    title: t('HoldTitle'),
    content: `<div class="cs-spoils"><p>${escapeHtml(f(n === 1 ? 'HoldOne' : 'HoldMany', { name: enc.name, n }))}</p><p class="cs-spoils-fine">${escapeHtml(t('HoldFine'))}</p></div>`,
    buttons: [
      { action: 'over', label: t('WholeFightOver') },
      { action: 'hold', label: t('Hold'), default: true },
    ],
  });
  return res?.action === 'over';
}

/** The prompt itself; resolves to the ticked row keys, or null for "Not now". */
async function askToDrop(view) {
  const words = { harvest: t('Harvest'), study: t('Study'), anItem: t('AnItem'), also: t('Also') };
  const rowHtml = view.map((r) => {
    const what = r.can ? dropText(r.drop, words) : t(r.why);
    return `<label class="cs-spoils-row${r.can ? '' : ' is-off'}">
      <input type="checkbox" name="spoils" value="${escapeHtml(r.key)}"${r.can ? ' checked' : ' disabled'}>
      <span class="cs-spoils-what"><b>${escapeHtml(r.name || t('Someone'))}</b><small>${escapeHtml(what)}</small></span>
      <span class="cs-spoils-pill">${escapeHtml(f('Down', { n: r.down }))}</span>
    </label>`;
  }).join('');
  const res = await choiceDialog({
    title: t('Title'),
    content: `<div class="cs-spoils"><p>${escapeHtml(t('Ask'))}</p>${rowHtml}<p class="cs-spoils-fine">${escapeHtml(t('Fine'))}</p></div>`,
    buttons: [
      { action: 'later', label: t('NotNow') },
      { action: 'put', label: t('Put'), default: true },
    ],
    read: (root) => new Set([...(root?.querySelectorAll?.('input[name="spoils"]:checked:not(:disabled)') ?? [])].map((i) => i.value)),
  });
  return res?.action === 'put' ? res.value : null;
}

/** Keep the defeated for an encounter whose stages are still to come. */
async function hold(scene, encId, encIds, creatures) {
  if (!scene) return;
  await clearHeld(scene, encIds.filter((id) => id !== encId));
  await scene.setFlag(FLAG_SCOPE, `${HELD_FLAG}.${encId}`, { creatures });
  ui.notifications.info(f('Held', { n: creatures.length }));
}

async function clearHeld(scene, encIds) {
  const store = scene?.getFlag?.(FLAG_SCOPE, HELD_FLAG) ?? {};
  for (const id of encIds) {
    if (store[id]) await scene.unsetFlag(FLAG_SCOPE, `${HELD_FLAG}.${id}`);
  }
}

/** Tell the GMs what went in: a toast, and Chronicle's lines as a whisper. */
function report(name, { lines, spoils }) {
  ui.notifications.info(spoils ? f('Done', { n: spoils }) : t('Nothing'));
  if (!lines.length) return;
  try {
    ChatMessage.create({
      content: `<p><b>${escapeHtml(f('From', { name }))}</b></p>${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}`,
      whisper: ChatMessage.getWhisperRecipients('GM').map((u) => u.id),
      speaker: { alias: 'Chronicle' },
    });
  } catch (err) {
    console.debug('Chronicle: spoils chat line failed', err?.message);
  }
}
