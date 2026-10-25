/**
 * Chronicle Sync - Encounters (the DM Screen's Encounters tab)
 *
 * The GM loads a fight planned in Chronicle and runs it as a roster: one row
 * per creature, its planned start, and its live state read from the current
 * scene (Not placed, Seen, Hidden). Tokens this tab places carry a module
 * flag {encounterId, rowId, n}; the scene is the only record of what is
 * placed or hidden, so the roster is redrawn from it on every token, combat
 * and scene change.
 *
 * Nothing here reveals a creature on its own. A token becomes visible only
 * when the GM presses Show on its row or confirms "Show all hidden". Chronicle
 * is read-only from here: encounters are never written back. GM only.
 * A fight's stages say when it is due for a creature to change form or the
 * later rows to arrive; the GM presses Start or Not yet, and what was started
 * is kept on the scene (flag `encounterStages`). Pure logic lives in
 * _encounter-roster.mjs, _encounter-stages.mjs and _encounter-list.mjs.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { CREATURE_FLAG, FOLDER_FLAG } from './creature-sync.mjs';
import { confirmDialog } from './_dialogs.mjs';
import { escapeHtml, noticeText } from './_escape-html.mjs';
import { isAnsweringGM } from './_stash-relay.mjs';
import { getSetting } from './settings.mjs';
import { log } from './logger.mjs';
import {
  encounterErrorKey, encounterPath, listPath, readyFirst, unwrapEncounterList,
} from './_encounter-list.mjs';
import {
  ENCOUNTER_TOKEN_FLAG, cellToPoint, combatantHiddenUpdates, expandRows, groupLetters, hiddenTokenIds,
  layoutItems, occupiedCells, parseEncounter, pickCombat, placedTokenIds, placeHidden, pointToCell,
  compendiumFallback, resolveActor, rosterState, startRows, tokenRef, trackerAdditions, trackerBadge,
} from './_encounter-roster.mjs';
import { bringInMonster, compendiumMonsters } from './monster-report.mjs';
import { rowAsPlayed, unwrapMatches } from './_creature-matches.mjs';
import {
  afterNotYet, afterStart, newlyDue, parseStages, stageStates,
} from './_encounter-stages.mjs';
import { changeForm, creatureSync } from './creature-forms.mjs';

const STAGES_FLAG = 'encounterStages';

const SEARCH_DELAY_MS = 300;
const REDRAW_DELAY_MS = 60;

const t = (key) => game.i18n.localize(`CHRONICLE.Encounters.${key}`);
const f = (key, data) => game.i18n.format(`CHRONICLE.Encounters.${key}`, data);

// ---- The scene --------------------------------------------------------

/** The current scene's tokens as plain values for the pure helpers. */
function sceneTokens() {
  const docs = canvas?.scene?.tokens?.contents ?? [];
  return docs.map((d) => ({
    id: d.id,
    hidden: !!d.hidden,
    x: d.x,
    y: d.y,
    width: d.width,
    height: d.height,
    ref: tokenRef(d.getFlag?.(FLAG_SCOPE, ENCOUNTER_TOKEN_FLAG)),
  }));
}

function gridOf(scene) {
  const d = scene.dimensions ?? {};
  const size = d.size || scene.grid?.size || 100;
  return {
    size,
    originX: d.sceneX ?? 0,
    originY: d.sceneY ?? 0,
    bounds: {
      minI: 0,
      minJ: 0,
      maxI: Math.max(0, Math.floor((d.sceneWidth ?? size) / size) - 1),
      maxJ: Math.max(0, Math.floor((d.sceneHeight ?? size) / size) - 1),
    },
  };
}

/** Actors as the pure resolver wants them. */
function actorCandidates() {
  const folderName = game.i18n.localize('CHRONICLE.Creatures.Folder');
  const folderIds = new Set(
    game.folders.filter((fl) => fl.type === 'Actor' && (fl.getFlag(FLAG_SCOPE, FOLDER_FLAG) || fl.name === folderName)).map((fl) => fl.id),
  );
  return game.actors.map((a) => ({
    id: a.id,
    name: a.name,
    linkedEntityId: a.getFlag(FLAG_SCOPE, CREATURE_FLAG) || '',
    inCreatureFolder: !!a.folder && folderIds.has(a.folder.id),
  }));
}

/** Combats on the scene, with the token ids that already have a combatant. */
function sceneCombats() {
  const sceneId = canvas?.scene?.id;
  return game.combats.filter((c) => c.scene?.id === sceneId || c.sceneId === sceneId);
}

// ---- Combatants follow their token --------------------------------------

/**
 * Keep a combatant hidden exactly when its fight's token is, for tokens this
 * tab placed only. Foundry may already do this; the update is skipped when
 * the two agree, so nothing is written twice. Registered once, for the
 * answering GM.
 */
export function initEncounterHooks() {
  Hooks.on('updateToken', async (doc, change) => {
    if (!('hidden' in (change ?? {}))) return;
    if (!isAnsweringGM(game.user, game.users?.activeGM)) return;
    if (!tokenRef(doc.getFlag?.(FLAG_SCOPE, ENCOUNTER_TOKEN_FLAG))) return;
    try {
      for (const combat of game.combats) {
        const mine = combat.combatants.filter((c) => c.tokenId === doc.id).map((c) => ({ id: c.id, hidden: c.hidden }));
        const updates = combatantHiddenUpdates(!!doc.hidden, mine);
        if (updates.length) await combat.updateEmbeddedDocuments('Combatant', updates);
      }
    } catch (err) {
      log.warn('Encounters: could not keep a combatant in step with its token', err);
    }
  });
}

// ---- The tab -------------------------------------------------------------

/** The Encounters tab's controller; the DM Screen window owns one for its life. */
export class EncountersPane {
  /** @param {() => import('./api-client.mjs').ChronicleAPI|null} getApi */
  constructor(getApi) {
    this._getApi = getApi;
    this._root = null;
    this._q = '';
    this._list = null;
    this._listError = '';
    this._listSeq = 0;
    this._searchTimer = 0;
    this._open = null;
    this._openError = '';
    this._loadingOpen = false;
    this._armed = null;
    this._confirmShowAll = false;
    this._notice = '';
    this._busy = false;
    this._redrawTimer = 0;
    this._stageHandler = null;
    this._keyHandler = null;
    this._hooks = [];
    this._onClick = this._click.bind(this);
    this._onInput = this._input.bind(this);
  }

  /** Attach to the tab's element (a fresh one after each window render). */
  mount(root) {
    this._root = root;
    root.innerHTML = `
      <div data-enc-listview>
        <input type="search" class="dms-search" data-enc-q placeholder="${escapeHtml(t('SearchPlaceholder'))}" aria-label="${escapeHtml(t('SearchPlaceholder'))}" value="${escapeHtml(this._q)}">
        <div class="dms-elist" data-enc-list aria-live="polite"></div>
      </div>
      <div class="dms-efight" data-enc-fight hidden></div>`;
    root.addEventListener('click', this._onClick);
    root.addEventListener('input', this._onInput);
    this._bindHooks();
    this._draw();
    if (!this._list && !this._listError) this._loadList();
  }

  /** Stop listening: hooks, a pending scene click and timers. */
  destroy() {
    this._disarm();
    clearTimeout(this._searchTimer);
    clearTimeout(this._redrawTimer);
    this._unbindHooks();
    this._root?.removeEventListener('click', this._onClick);
    this._root?.removeEventListener('input', this._onInput);
    this._root = null;
  }

  _bindHooks() {
    this._unbindHooks();
    const redraw = () => this._scheduleRedraw();
    // A token change on another scene never moves this roster.
    const onScene = (doc) => { if (!doc?.parent || doc.parent.id === canvas?.scene?.id) redraw(); };
    const sceneChanged = () => { this._disarm(); this._confirmShowAll = false; redraw(); };
    for (const [name, fn] of [
      ['createToken', onScene], ['updateToken', onScene], ['deleteToken', onScene],
      ['canvasReady', sceneChanged],
      ['createCombatant', redraw], ['deleteCombatant', redraw], ['updateCombat', redraw], ['deleteCombat', redraw],
      // A linked creature's Stamina lives on its actor, and a stage may wait on it.
      ['updateActor', redraw],
    ]) {
      this._hooks.push([name, Hooks.on(name, fn)]);
    }
  }

  _unbindHooks() {
    for (const [name, id] of this._hooks) Hooks.off(name, id);
    this._hooks = [];
  }

  _scheduleRedraw() {
    clearTimeout(this._redrawTimer);
    this._redrawTimer = setTimeout(() => { if (this._open) this._drawFight(); }, REDRAW_DELAY_MS);
  }

  // ---- Loading ----------------------------------------------------------

  _api() {
    const api = this._getApi?.();
    if (!api || !getSetting('apiUrl') || !getSetting('campaignId') || !getSetting('apiKey')) return null;
    return api;
  }

  async _loadList() {
    const seq = ++this._listSeq;
    const api = this._api();
    if (!api) {
      this._listError = game.i18n.localize('CHRONICLE.DMScreen.Error.NotSetUp');
      this._drawList();
      return;
    }
    this._listError = '';
    this._list = null;
    this._drawList();
    try {
      const raw = await api.get(listPath(this._q));
      if (seq !== this._listSeq) return;
      this._list = unwrapEncounterList(raw);
    } catch (err) {
      if (seq !== this._listSeq) return;
      this._listError = t(`Error.${encounterErrorKey(err)}`);
      log.warn('Encounters: could not list encounters', err);
    }
    this._drawList();
  }

  async _openEncounter(id) {
    const api = this._api();
    if (!api) return;
    this._loadingOpen = true;
    this._openError = '';
    this._notice = '';
    this._confirmShowAll = false;
    this._disarm();
    this._draw();
    try {
      const enc = parseEncounter(await api.get(encounterPath(id)));
      if (!enc) throw new Error('encounter without an id');
      const matches = await this._readMatches(api);
      this._open = { enc, rows: expandRows(enc.creatures), stages: parseStages(enc.stages, new Set(enc.creatures.map((c) => c.id))), seen: null, matches };
    } catch (err) {
      this._open = null;
      this._openError = t(`Error.${encounterErrorKey(err)}`);
      log.warn('Encounters: could not open an encounter', err);
    }
    this._loadingOpen = false;
    this._draw();
  }

  // ---- Drawing ----------------------------------------------------------

  _draw() {
    if (!this._root) return;
    const showFight = !!this._open || this._loadingOpen || !!this._openError;
    this._root.querySelector('[data-enc-listview]').hidden = showFight;
    this._root.querySelector('[data-enc-fight]').hidden = !showFight;
    if (showFight) this._drawFight();
    else this._drawList();
  }

  _drawList() {
    const box = this._root?.querySelector('[data-enc-list]');
    if (!box) return;
    if (this._listError) {
      box.innerHTML = `<p class="dms-small">${escapeHtml(this._listError)}</p><button type="button" class="dms-ebtn" data-enc-act="retryList">${escapeHtml(game.i18n.localize('CHRONICLE.DMScreen.Retry'))}</button>`;
      return;
    }
    if (!this._list) {
      box.innerHTML = `<p class="dms-small" role="status">${escapeHtml(t('Loading'))}</p>`;
      return;
    }
    const searching = this._q.trim() !== '';
    const sorted = readyFirst(this._list.items);
    const items = searching ? sorted : sorted.filter((i) => i.ready);
    let html = searching || !items.length ? '' : `<p class="dms-lbl dms-eready">${escapeHtml(t('ReadyHeading'))}</p>`;
    for (const it of items) {
      const count = it.creatureCount === 1 ? t('CreatureOne') : f('CreatureMany', { n: it.creatureCount });
      const where = [it.pageName && it.pageName !== it.name ? it.pageName : '', count].filter(Boolean).join(' · ');
      html += `<button type="button" class="dms-eitem" data-enc-act="open" data-id="${escapeHtml(it.id)}"><b>${escapeHtml(it.name)}</b><span>${escapeHtml(where)}</span></button>`;
    }
    if (!items.length) html += `<p class="dms-small">${escapeHtml(searching ? t('NoMatch') : t('NoneReady'))}</p>`;
    else if (!searching) {
      const more = Math.max(0, this._list.total - items.length);
      if (more) html += `<p class="dms-small">${escapeHtml(f('More', { n: more }))}</p>`;
    }
    box.innerHTML = html;
  }

  _drawFight() {
    const box = this._root?.querySelector('[data-enc-fight]');
    if (!box) return;
    const back = `<button type="button" class="dms-ebtn" data-enc-act="back">← ${escapeHtml(t('Back'))}</button>`;
    if (this._loadingOpen) {
      box.innerHTML = `${back}<p class="dms-small" role="status">${escapeHtml(t('Loading'))}</p>`;
      return;
    }
    if (!this._open) {
      box.innerHTML = `${back}<p class="dms-small">${escapeHtml(this._openError)}</p>`;
      return;
    }
    const { enc, rows } = this._open;
    const scene = canvas?.scene;
    const tokens = scene ? sceneTokens() : [];
    const state = rosterState(enc.id, rows, tokens);
    const actors = actorCandidates();
    const combats = scene ? sceneCombats() : [];
    const inCombat = new Set(combats.flatMap((c) => c.combatants.map((cb) => cb.tokenId).filter(Boolean)));
    const mineIds = new Set(placedTokenIds(enc.id, tokens));
    const trackerOn = [...mineIds].some((id) => inCombat.has(id));
    const hiddenCount = hiddenTokenIds(enc.id, tokens).length;
    const placed = mineIds.size;
    const canStart = !!scene && startRows(state).length > 0;

    const packs = compendiumMonsters();
    const makesOwn = !!creatureSync()?.canMakeActors;
    const rowHtml = state.map((shown) => {
      const r = rowAsPlayed(shown, this._open.matches);
      const found = resolveActor(r, actors);
      // No world actor yet, but a compendium has one: Place brings it in.
      const fromPack = found ? null : compendiumFallback(r, packs);
      // A page playing its own numbers: Place has creature sync make its actor.
      const fromPage = !found && r.pageOnly && makesOwn;
      const badge = trackerBadge(r, { trackerOn, inCombat });
      const startLabel = t(`Start.${r.start}`);
      const meta = [r.group ? f('Group', { g: r.group }) : '', startLabel].filter(Boolean).join(' · ');
      let actions = '';
      if (r.state === 'out') {
        const armed = this._armed?.kind === 'row' && this._armed.key === r.key;
        actions = `<button type="button" class="dms-ebtn${armed ? ' dms-eon' : ''}" data-enc-act="place" data-key="${escapeHtml(r.key)}" ${(found || fromPack || fromPage) && scene ? '' : 'disabled'} ${found || fromPack || fromPage ? '' : `title="${escapeHtml(t('NoActorTip'))}"`}>${escapeHtml(armed ? t('ClickScene') : t('Place'))}</button>`;
      } else {
        actions = `<button type="button" class="dms-ebtn" data-enc-act="toggle" data-key="${escapeHtml(r.key)}">${escapeHtml(r.state === 'hidden' ? t('Show') : t('Hide'))}</button>`;
      }
      return `<div class="dms-erow" data-state="${r.state}">
        <span class="dms-en">${escapeHtml(r.name)}<small>${escapeHtml(meta)}${found || r.state !== 'out' ? '' : fromPack ? ` · ${escapeHtml(f('FromCompendium', { pack: fromPack.pack }))}` : fromPage ? ` · ${escapeHtml(t('FromPage'))}` : ` · <em>${escapeHtml(t('NoActor'))}</em>`}</small></span>
        <span class="dms-est dms-est-${r.state}">${escapeHtml(t(`State.${r.state}`))}${badge ? `<small>${escapeHtml(t(`Tracker.${badge}`))}</small>` : ''}</span>
        <span class="dms-eact">${actions}</span>
      </div>`;
    }).join('');

    const armedBanner = this._armed
      ? `<div class="dms-earmed" role="status"><span>${escapeHtml(this._armed.kind === 'start' ? t('ArmedStart') : this._armed.kind === 'stage' ? t('Stage.Armed') : f('ArmedRow', { name: noticeText(this._armed.name) }))}</span><button type="button" class="dms-ebtn" data-enc-act="cancelArm">${escapeHtml(t('Cancel'))}</button></div>`
      : '';
    const confirm = this._confirmShowAll
      ? `<div class="dms-confirm" role="alertdialog" aria-label="${escapeHtml(t('ShowAllYes'))}"><p>${escapeHtml(f('ShowAllAsk', { n: hiddenCount }))}</p><div class="dms-confirm-btns"><button type="button" class="dms-confirm-yes" data-enc-act="showAllYes">${escapeHtml(t('ShowAllYes'))}</button><button type="button" data-enc-act="showAllNo">${escapeHtml(t('Cancel'))}</button></div></div>`
      : '';

    box.innerHTML = `
      <div class="dms-ehead">${back}<button type="button" class="dms-ebtn" data-enc-act="reload">${escapeHtml(t('Reload'))}</button></div>
      <h4 class="dms-etitle">${escapeHtml(enc.name)}</h4>
      ${enc.pageName && enc.pageName !== enc.name ? `<p class="dms-small">${escapeHtml(enc.pageName)}</p>` : ''}
      ${scene ? '' : `<p class="dms-small">${escapeHtml(t('NoScene'))}</p>`}
      <div class="dms-ebar">
        <button type="button" class="dms-ebtn dms-egold" data-enc-act="start" ${canStart ? '' : 'disabled'}>${escapeHtml(t('SetUp'))}</button>
        <button type="button" class="dms-ebtn" data-enc-act="showAllAsk" ${hiddenCount ? '' : 'disabled'}>${escapeHtml(f('ShowAll', { n: hiddenCount }))}</button>
        <button type="button" class="dms-ebtn" data-enc-act="tracker" ${placed ? '' : 'disabled'}>${escapeHtml(t('Tracker.add'))}</button>
        <button type="button" class="dms-ebtn" data-enc-act="undo" ${placed ? '' : 'disabled'}>${escapeHtml(t('Undo'))}</button>
      </div>
      ${armedBanner}${confirm}
      <p class="dms-small dms-enotice" role="status">${escapeHtml(this._notice)}</p>
      <div class="dms-eroster">${rowHtml || `<p class="dms-small">${escapeHtml(t('NoCreatures'))}</p>`}</div>
      ${this._stagesHtml(scene)}`;
  }

  // ---- Stages -------------------------------------------------------------

  /** This fight's round: its started tracker's, else 0. */
  _round() {
    const mine = new Set(placedTokenIds(this._open.enc.id, sceneTokens()));
    const combat = sceneCombats().find((c) => c.started && c.combatants.some((cb) => mine.has(cb.tokenId)));
    return combat?.round ?? 0;
  }

  /** Each placed token of this fight with its Stamina, when the system has it. */
  _staminaTokens() {
    const paths = creatureSync()?.staminaPaths?.();
    if (!paths) return [];
    const get = foundry.utils.getProperty;
    return (canvas?.scene?.tokens?.contents ?? []).flatMap((d) => {
      const ref = tokenRef(d.getFlag?.(FLAG_SCOPE, ENCOUNTER_TOKEN_FLAG));
      if (!ref || ref.encounterId !== this._open.enc.id || !d.actor) return [];
      return [{ rowId: ref.rowId, value: get(d.actor, paths.value), max: get(d.actor, paths.max) }];
    });
  }

  _memory() {
    return canvas?.scene?.getFlag?.(FLAG_SCOPE, STAGES_FLAG)?.[this._open.enc.id] ?? { started: [], notYet: {} };
  }

  async _saveMemory(memory) {
    await canvas.scene.setFlag(FLAG_SCOPE, `${STAGES_FLAG}.${this._open.enc.id}`, memory);
  }

  _stagesHtml(scene) {
    const { enc, stages } = this._open;
    if (!stages.length) return '';
    const states = scene ? stageStates(stages, { round: this._round(), tokens: this._staminaTokens() }, this._memory()) : stages.map(() => 'waiting');
    // A stage that has just come due is announced once, besides being marked.
    for (const i of newlyDue(this._open.seen, states)) ui.notifications.info(f('Stage.DueNotice', { n: i + 1, name: noticeText(enc.name) }));
    this._open.seen = states;
    const nameOf = (rowId) => enc.creatures.find((c) => c.id === rowId)?.name || t('Stage.Someone');
    const cards = stages.map((s, i) => {
      const when = s.when.kind === 'stamina' ? f('Stage.WhenStamina', { name: nameOf(s.when.row), p: s.when.percent })
        : s.when.kind === 'round' ? f('Stage.WhenRound', { n: s.when.round }) : t('Stage.WhenManual');
      const what = [
        ...s.forms.map((fc) => f('Stage.TakesForm', { name: nameOf(fc.row), form: fc.formName || t('Stage.FirstForm') })),
        ...(s.arrive.length ? [f('Stage.Arrive', { names: s.arrive.map(nameOf).join(', ') })] : []),
      ];
      const st = states[i];
      const acts = st === 'started' ? `<span class="dms-small">${escapeHtml(t('Stage.Started'))}</span>`
        : st === 'due'
          ? `<button type="button" class="dms-ebtn dms-egold" data-enc-act="stageStart" data-id="${escapeHtml(s.id)}" ${scene ? '' : 'disabled'}>${escapeHtml(f('Stage.Start', { n: i + 1 }))}</button><button type="button" class="dms-ebtn" data-enc-act="stageNotYet" data-id="${escapeHtml(s.id)}">${escapeHtml(t('Stage.NotYet'))}</button>`
          : `<button type="button" class="dms-ebtn" data-enc-act="stageStart" data-id="${escapeHtml(s.id)}" ${scene ? '' : 'disabled'}>${escapeHtml(f('Stage.Start', { n: i + 1 }))}</button>`;
      return `<div class="dms-estage" data-state="${st}">
        <p class="dms-estage-h"><b>${escapeHtml(f('Stage.Title', { n: i + 1 }))}</b>${st === 'due' ? ` <span class="dms-estage-due">${escapeHtml(t('Stage.Due'))}</span>` : ''}</p>
        <p class="dms-small">${escapeHtml(when)}</p>
        <ul class="dms-estage-what">${what.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
        ${s.note ? `<p class="dms-small"><em>${escapeHtml(s.note)}</em></p>` : ''}
        <div class="dms-estage-acts">${acts}</div>
      </div>`;
    }).join('');
    return `<p class="dms-lbl dms-estages-h">${escapeHtml(t('Stage.Heading'))}</p><div class="dms-estages" aria-live="polite">${cards}</div>`;
  }

  /**
   * Start a stage: each named creature changes form (quiet or reveal as the
   * stage says), then the scene waits for one click to place the arrivals.
   */
  async _startStage(id) {
    const { enc, stages } = this._open;
    const stage = stages.find((s) => s.id === id);
    if (!stage || !canvas?.scene) return;
    await this._saveMemory(afterStart(this._memory(), id));
    const missing = [];
    for (const fc of stage.forms) {
      const doc = canvas.scene.tokens.contents.find((d) => {
        const ref = tokenRef(d.getFlag?.(FLAG_SCOPE, ENCOUNTER_TOKEN_FLAG));
        return ref?.encounterId === enc.id && ref.rowId === fc.row;
      });
      if (!doc || !creatureSync()?.creatureFor(doc)) { missing.push(enc.creatures.find((c) => c.id === fc.row)?.name || '?'); continue; }
      await changeForm(doc, fc.form, stage.how);
    }
    if (missing.length) ui.notifications.warn(f('Stage.NoForm', { names: noticeText(missing.join(', ')) }));
    const arriving = this._stateRows().filter((r) => stage.arrive.includes(r.rowId) && r.state === 'out');
    if (arriving.length) this._arm({ kind: 'stage', keys: arriving.map((r) => r.key) });
    else this._drawFight();
  }

  // ---- Events -------------------------------------------------------------

  _input(ev) {
    if (!ev.target.matches('[data-enc-q]')) return;
    this._q = ev.target.value;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this._loadList(), SEARCH_DELAY_MS);
  }

  async _click(ev) {
    const btn = ev.target.closest('[data-enc-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.encAct;
    const key = btn.dataset.key;
    try {
      switch (act) {
        case 'open': await this._openEncounter(btn.dataset.id); break;
        case 'retryList': await this._loadList(); break;
        case 'back':
          this._disarm();
          this._open = null;
          this._openError = '';
          this._confirmShowAll = false;
          this._notice = '';
          this._draw();
          break;
        case 'reload': await this._openEncounter(this._open.enc.id); break;
        case 'start': this._arm({ kind: 'start' }); break;
        case 'place': this._armRow(key); break;
        case 'cancelArm': this._disarm(); this._drawFight(); break;
        case 'toggle': await this._toggle(key); break;
        case 'showAllAsk': this._confirmShowAll = true; this._drawFight(); break;
        case 'showAllNo': this._confirmShowAll = false; this._drawFight(); break;
        case 'showAllYes': await this._showAll(); break;
        case 'tracker': await this._addToTracker(); break;
        case 'undo': await this._undo(); break;
        case 'stageStart': await this._startStage(btn.dataset.id); break;
        case 'stageNotYet': await this._saveMemory(afterNotYet(this._memory(), btn.dataset.id, this._round())); this._drawFight(); break;
        default: break;
      }
    } catch (err) {
      log.warn(`Encounters: "${act}" failed`, err);
      ui.notifications.warn(t('Error.Action'));
      this._drawFight();
    }
  }

  // ---- Placing -------------------------------------------------------------

  _stateRows() {
    return rosterState(this._open.enc.id, this._open.rows, sceneTokens());
  }

  /**
   * Which creature pages are Foundry's own monsters, read with the fight. An
   * older Chronicle, or a failed read, places every row as before.
   */
  async _readMatches(api) {
    try {
      return unwrapMatches(await api.get('/foundry-matches'));
    } catch (err) {
      if (err?.status !== 404) log.warn('Encounters: could not read which pages are Foundry monsters', err);
      return new Map();
    }
  }

  _armRow(key) {
    if (this._armed?.kind === 'row' && this._armed.key === key) { this._disarm(); this._drawFight(); return; }
    const row = this._open.rows.find((r) => r.key === key);
    if (row) this._arm({ kind: 'row', key, name: row.name });
  }

  /** Wait for one click on the scene; the next one places what was armed. */
  _arm(armed) {
    this._disarm();
    if (!canvas?.stage || !canvas.scene) {
      ui.notifications.warn(t('NoScene'));
      return;
    }
    this._armed = armed;
    this._notice = '';
    this._stageHandler = (event) => {
      const native = event?.nativeEvent ?? event?.data?.originalEvent ?? event?.originalEvent;
      const button = native?.button ?? event?.button;
      if (button !== undefined && button !== 0) return;
      const point = event.getLocalPosition?.(canvas.stage) ?? event.data?.getLocalPosition?.(canvas.stage);
      if (!point) return;
      const what = this._armed;
      this._disarm();
      this._placeAt(what, point).catch((err) => {
        log.warn('Encounters: placing failed', err);
        ui.notifications.warn(t('Error.Place'));
        this._drawFight();
      });
    };
    canvas.stage.once('pointerdown', this._stageHandler);
    this._keyHandler = (e) => { if (e.key === 'Escape') { this._disarm(); this._drawFight(); } };
    window.addEventListener('keydown', this._keyHandler);
    try { canvas.app.view.style.cursor = 'crosshair'; } catch { /* no cursor change */ }
    this._drawFight();
  }

  _disarm() {
    if (this._stageHandler) {
      try { canvas?.stage?.off('pointerdown', this._stageHandler); } catch { /* stage gone */ }
      try { canvas.app.view.style.cursor = ''; } catch { /* no cursor change */ }
    }
    if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler);
    this._stageHandler = null;
    this._keyHandler = null;
    this._armed = null;
  }

  async _placeAt(armed, point) {
    if (!this._open) return;
    const rows = armed.kind === 'start'
      ? startRows(this._stateRows())
      : armed.kind === 'stage'
        ? this._stateRows().filter((r) => armed.keys.includes(r.key) && r.state === 'out')
        : this._stateRows().filter((r) => r.key === armed.key && r.state === 'out');
    if (!rows.length) {
      this._notice = t('NothingToPlace');
      this._drawFight();
      return;
    }
    const made = await this._placeRows(rows, point);
    this._notice = made;
    this._drawFight();
  }

  /**
   * Create one unlinked token per row on free squares around `point`.
   * @returns {Promise<string>} the sentence for the window
   */
  async _placeRows(rows, point) {
    const scene = canvas.scene;
    const { enc } = this._open;
    const actors = actorCandidates();
    const grid = gridOf(scene);
    const noActor = [];
    const built = [];
    for (const shown of rows) {
      const row = rowAsPlayed(shown, this._open.matches);
      const found = resolveActor(row, actors);
      let actor = found && game.actors.get(found.actor.id);
      if (!actor && row.pageOnly) actor = await creatureSync()?.ensureActor(row.entityId) ?? null;
      if (!actor) actor = await this._fromCompendium(row);
      if (!actor) { noActor.push(row.name); continue; }
      const hidden = placeHidden(row);
      const doc = await actor.getTokenDocument({
        name: row.name,
        hidden,
        actorLink: false,
        flags: { [FLAG_SCOPE]: { [ENCOUNTER_TOKEN_FLAG]: { encounterId: enc.id, rowId: row.rowId, n: row.n } } },
      });
      built.push({ row, doc, hidden });
    }
    if (noActor.length) ui.notifications.warn(f('SkippedNoActor', { names: noticeText(noActor.join(', ')) }));
    if (!built.length) return '';

    const center = pointToCell(point.x, point.y, grid);
    const occupied = occupiedCells(sceneTokens(), grid);
    const { placements, unplaced } = layoutItems(
      built.map((b) => ({ key: b.row.key, w: b.doc.width, h: b.doc.height })),
      center,
      { occupied, bounds: grid.bounds },
    );
    if (unplaced.length) ui.notifications.warn(f('NoRoom', { n: unplaced.length }));
    const byKey = new Map(built.map((b) => [b.row.key, b]));
    const data = placements.map((p) => {
      const at = cellToPoint(p.i, p.j, grid);
      const obj = byKey.get(p.key).doc.toObject();
      return { ...obj, x: at.x, y: at.y };
    });
    if (!data.length) return '';
    const created = await scene.createEmbeddedDocuments('Token', data);
    const hiddenN = created.filter((d) => d.hidden).length;
    await this._joinRunning(created);
    return f('Placed', { n: created.length, hidden: hiddenN });
  }

  /**
   * The world actor for a row no world actor answers, brought in once from a
   * compendium; later rows and fights reuse it. Null when no compendium has
   * it or bringing it in failed.
   */
  async _fromCompendium(row) {
    const entry = compendiumFallback(row, compendiumMonsters());
    if (!entry) return null;
    try {
      return await bringInMonster(entry);
    } catch (err) {
      log.warn(`Encounters: could not bring ${entry.name} in from ${entry.pack}`, err);
      return null;
    }
  }

  /** Tokens placed while this fight is in an unstarted tracker join it. */
  async _joinRunning(createdTokens) {
    const scene = canvas.scene;
    const tokens = sceneTokens();
    const mine = new Set(placedTokenIds(this._open.enc.id, tokens));
    const combat = sceneCombats().find((c) => !c.started && c.combatants.some((cb) => mine.has(cb.tokenId)));
    if (!combat) return;
    try {
      const have = new Set(combat.combatants.map((cb) => cb.tokenId));
      const add = createdTokens.filter((d) => !have.has(d.id)).map((d) => ({
        tokenId: d.id, sceneId: scene.id, actorId: d.actorId, hidden: !!d.hidden,
      }));
      if (add.length) await combat.createEmbeddedDocuments('Combatant', add);
    } catch (err) {
      log.warn('Encounters: could not add a placed creature to the tracker', err);
    }
  }

  // ---- Show, hide, undo ---------------------------------------------------

  async _toggle(key) {
    const row = this._stateRows().find((r) => r.key === key);
    const doc = row?.tokenId && canvas.scene?.tokens.get(row.tokenId);
    if (!doc) { this._drawFight(); return; }
    await doc.update({ hidden: !doc.hidden });
  }

  async _showAll() {
    this._confirmShowAll = false;
    const ids = hiddenTokenIds(this._open.enc.id, sceneTokens());
    if (ids.length) {
      await canvas.scene.updateEmbeddedDocuments('Token', ids.map((id) => ({ _id: id, hidden: false })));
      this._notice = f('ShowAllDone', { n: ids.length });
    }
    this._drawFight();
  }

  async _undo() {
    const ids = placedTokenIds(this._open.enc.id, sceneTokens());
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: t('Undo'),
      content: `<p>${escapeHtml(f('UndoAsk', { n: ids.length }))}</p>`,
      defaultYes: false,
    });
    if (!ok) return;
    // Asked about a moment ago; only what is still this fight's goes.
    const still = placedTokenIds(this._open.enc.id, sceneTokens()).filter((id) => ids.includes(id));
    if (still.length) await canvas.scene.deleteEmbeddedDocuments('Token', still);
    this._notice = f('Undone', { n: still.length });
    this._drawFight();
  }

  // ---- The combat tracker --------------------------------------------------

  async _addToTracker() {
    const scene = canvas.scene;
    if (!scene) return;
    const state = this._stateRows();
    const combats = sceneCombats();
    const pick = pickCombat(combats.map((c) => ({ id: c.id, started: !!c.started })));
    let combat = pick.id ? game.combats.get(pick.id) : null;
    if (pick.kind === 'ask') {
      const ok = await confirmDialog({ title: t('Tracker.add'), content: `<p>${escapeHtml(t('Tracker.RunningAsk'))}</p>`, defaultYes: false });
      if (!ok) return;
    }
    const have = new Set(combat ? combat.combatants.map((cb) => cb.tokenId) : []);
    const add = trackerAdditions(state, have);
    if (!add.length) {
      this._notice = state.some((r) => r.state !== 'out') ? t('Tracker.AlreadyIn') : t('Tracker.Nobody');
      this._drawFight();
      return;
    }
    if (!combat) {
      combat = await getDocumentClass('Combat').create({ scene: scene.id, active: true });
    }
    const groupIds = await this._groupsFor(combat, add);
    const data = add.map((a) => {
      const doc = scene.tokens.get(a.tokenId);
      const row = { tokenId: a.tokenId, sceneId: scene.id, actorId: doc?.actorId, hidden: a.hidden };
      if (groupIds.has(a.group)) row.group = groupIds.get(a.group);
      return row;
    });
    await combat.createEmbeddedDocuments('Combatant', data);
    const pending = state.filter((r) => r.state === 'out').length;
    this._notice = pending ? f('Tracker.AddedPending', { n: add.length, m: pending }) : f('Tracker.Added', { n: add.length });
    this._drawFight();
  }

  /**
   * Initiative groups for the added creatures, where this Foundry has them
   * (v13+). A failure leaves the creatures ungrouped rather than blocking.
   * @returns {Promise<Map<string, string>>} group letter to group id
   */
  async _groupsFor(combat, additions) {
    const out = new Map();
    if (!(game.release?.generation >= 13) || !combat.groups) return out;
    try {
      const letters = groupLetters(additions);
      const nameOf = (g) => f('Group', { g });
      const existing = new Map([...combat.groups].map((g) => [g.name, g.id]));
      const missing = letters.filter((g) => !existing.has(nameOf(g)));
      if (missing.length) {
        const made = await combat.createEmbeddedDocuments('CombatantGroup', missing.map((g) => ({ name: nameOf(g) })));
        made.forEach((g) => existing.set(g.name, g.id));
      }
      for (const g of letters) out.set(g, existing.get(nameOf(g)));
    } catch (err) {
      log.warn('Encounters: could not make initiative groups', err);
    }
    return out;
  }
}
