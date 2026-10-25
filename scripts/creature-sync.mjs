/**
 * Chronicle Sync - Creature sync (Chronicle creature pages to Foundry NPC actors)
 *
 * A creature page becomes an NPC actor in the "Chronicle: Creatures" folder
 * and follows every change to its stat block. Chronicle owns the stat block;
 * Foundry owns only the fields the system's preset lists in
 * `foundry_pull_fields` (current Stamina and conditions for Draw Steel), and
 * sends those back only for a page whose director turned it on (the page's
 * `foundry` system state). A page removed from Chronicle only unlinks its
 * actor; nothing is deleted. Active GM only, behind the `syncCreatures`
 * setting. Conversions live in _creature-fields.mjs. Under the Draw Steel
 * system the page's abilities become the actor's ability items
 * (_creature-abilities.mjs), so the system rolls and applies them. A page
 * with other forms (_creature-forms.mjs) puts its actor in one form at a time;
 * the GM changes it from the token (creature-forms.mjs). A page Chronicle
 * matched to a monster Foundry already has, set to play with Foundry's
 * numbers (_creature-matches.mjs), makes no actor: Foundry's own monster is
 * that creature, so nothing is made twice.
 */

import { flagRemoval } from './_flag-removal.mjs';
import { getSetting } from './settings.mjs';
import { FLAG_SCOPE, syncOptions, APPLY_OPTION } from './constants.mjs';
import { LINK_FLAG } from './npc-presence.mjs';
import { walkEntityPages, unwrapEntityList } from './_entity-page-walk.mjs';
import {
  creatureUpdate, planCreatureApply, creaturePull, sendBackOn, changedPull, seedPull,
} from './_creature-fields.mjs';
import { isAnsweringGM } from './_stash-relay.mjs';
import { playsFoundry, unwrapMatches } from './_creature-matches.mjs';
import { sameValue } from './_actor-apply-plan.mjs';
import { log } from './logger.mjs';
import { PictureStore } from './picture-store.mjs';
import { GENERIC_TOKEN, pictureChoice, pictureIds, picturePlan, PICTURES_FLAG } from './_creature-pictures.mjs';
import {
  ABILITY_FLAG, abilitiesFingerprint, desiredAbilities, hasAbilityFields, planAbilityItems,
} from './_creature-abilities.mjs';
import {
  FORM_FLAG, FORMS_KEY, appliedVersion, cleanForm, formEntity, formIndex, formKey, isFormId, isFormsKey,
  publicAfterChange, staminaAfter,
} from './_creature-forms.mjs';

/** Actor flag holding the creature page this actor follows. */
export const CREATURE_FLAG = 'creatureEntityId';
const VERSION_FLAG = 'creatureUpdatedAt';
/** Folder flag marking the "Chronicle: Creatures" folder. */
export const FOLDER_FLAG = 'creatureFolder';
const ABILITIES_FLAG = 'creatureAbilities';
const STATE_KEY = 'foundry';
const PULL_DELAY_MS = 750;

/** Every dot path in Foundry's nested update diff. */
function changedPaths(change, prefix = '', out = []) {
  for (const [k, v] of Object.entries(change || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) changedPaths(v, path, out);
    else out.push(path);
  }
  return out;
}

export class CreatureSync {
  constructor() {
    this._api = null;
    this._syncManager = null;
    this._defs = null;
    this._typeId = null;
    this._folderId = null;
    this._sendBack = new Map();
    this._pullTimers = new Map();
    this._known = new Map();
    this._inFlight = new Map();
    this._folderPromise = null;
    this._onUpdateActor = this._handleUpdateActor.bind(this);
    this._onEffect = this._handleEffect.bind(this);
    this._hooked = false;
    this._pictures = null;
    this._formsCache = new Map();
    /** @type {Map<string, object>} Chronicle's match per page, from the last read. */
    this._matches = new Map();
  }

  get _active() {
    // Every GM client runs sync; only the active one may create actors.
    return !!(this._defs && getSetting('syncCreatures') && isAnsweringGM(game.user, game.users?.activeGM));
  }

  /** True when this client makes creature actors, so a fight can ask for one. */
  get canMakeActors() {
    return this._active;
  }

  get _pullKeys() { return this._defs?.foundry_pull_fields || []; }

  /** @param {import('./api-client.mjs').ChronicleAPI} api */
  async init(api) {
    this._api = api;
    this._defs = null;
    if (!getSetting('syncCreatures')) return;

    const defs = await this._loadDefs(api);
    if (!defs?.fields?.some((f) => f.foundry_path) || !defs.foundry_actor_type) {
      log.debug('Creature sync: this system has no creature fields for Foundry');
      return;
    }
    this._defs = defs;

    try {
      const result = await api.get('/entity-types');
      const types = result?.data || result || [];
      const enabled = types.filter((t) => t.enabled !== false);
      const match = enabled.find((t) => t.slug === this._defs.preset_slug)
        || enabled.find((t) => t.preset_category === 'creature');
      this._typeId = match?.id ?? null;
    } catch (err) {
      log.warn('Creature sync: could not read page types', err);
    }
    if (!this._typeId) { this._defs = null; return; }

    if (!this._hooked) {
      this._hooked = true;
      Hooks.on('updateActor', this._onUpdateActor);
      Hooks.on('createActiveEffect', this._onEffect);
      Hooks.on('deleteActiveEffect', this._onEffect);
    }
  }

  /** The matched system's creature fields, or null when it has none. */
  async _loadDefs(api) {
    const system = getSetting('detectedSystem');
    if (!system) return null;
    try {
      return await api.get(`/systems/${system}/creature-fields`);
    } catch (err) {
      // An older Chronicle has no creature-fields route.
      if (err?.status !== 404) log.warn('Creature sync: could not read creature fields', err);
      return null;
    }
  }

  destroy() {
    if (this._hooked) {
      Hooks.off('updateActor', this._onUpdateActor);
      Hooks.off('createActiveEffect', this._onEffect);
      Hooks.off('deleteActiveEffect', this._onEffect);
      this._hooked = false;
    }
    for (const t of this._pullTimers.values()) clearTimeout(t);
    this._pullTimers.clear();
    this._sendBack.clear();
    this._known.clear();
    this._inFlight.clear();
    this._formsCache.clear();
    this._matches.clear();
    this._folderPromise = null;
    this._defs = null;
  }

  /**
   * Every page's match, read again on connect. An older Chronicle has no
   * matching (404) and every page makes its actor, as before; a failed read
   * keeps the last answer rather than making copies of matched monsters.
   */
  async _loadMatches() {
    try {
      this._matches = unwrapMatches(await this._api.get('/foundry-matches'));
    } catch (err) {
      if (err?.status === 404) this._matches = new Map();
      else log.warn('Creature sync: could not read which pages are Foundry monsters', err);
    }
  }

  /** One page's match, read again before its actor follows an edit. */
  async _refreshMatch(entityId) {
    try {
      const body = await this._api.get(`/entities/${entityId}/foundry-match`);
      if (body?.match) this._matches.set(entityId, body.match);
    } catch (err) {
      if (err?.status === 404) this._matches.delete(entityId);
      else log.debug(`Creature sync: could not read the match for ${entityId}`, err);
    }
  }

  /**
   * The actor a fight places for a creature page: the one creature sync
   * made, made now if it is missing. Null when creature sync is off here,
   * the page plays Foundry's own monster, or making it failed.
   * @param {string} entityId
   * @returns {Promise<Actor|null>}
   */
  async ensureActor(entityId) {
    if (!this._active || !entityId) return null;
    await this._refreshMatch(entityId);
    if (playsFoundry(this._matches.get(entityId))) return null;
    if (!this._findActor(entityId)) await this._upsert({ id: entityId });
    return this._findActor(entityId);
  }

  /** Brings every creature page in on connect; actors already current are left alone. */
  async onInitialSync() {
    if (!this._active) return;
    // A missed system_state message must not leave an old answer in place.
    this._sendBack.clear();
    await this._loadMatches();
    const walked = await walkEntityPages(
      (page, perPage) => this._api.get(`/entities?type_id=${this._typeId}&per_page=${perPage}&page=${page}`),
      unwrapEntityList,
    );
    if (walked.truncated) log.warn(`Creature sync stopped at ${walked.entities.length} creatures; there are more.`);
    let errors = 0;
    for (const entity of walked.entities) {
      if (!(await this._upsert(entity))) errors++;
    }
    // Pages removed while Foundry was closed; a cut-short walk proves nothing.
    if (!walked.truncated) {
      const seen = new Set(walked.entities.map((e) => e.id));
      for (const actor of game.actors.filter((a) => a.getFlag(FLAG_SCOPE, CREATURE_FLAG))) {
        if (!seen.has(actor.getFlag(FLAG_SCOPE, CREATURE_FLAG))) await this._unlink(actor.getFlag(FLAG_SCOPE, CREATURE_FLAG));
      }
    }
    if (errors) throw new Error(`creature catch-up: ${errors} creature(s) failed`);
  }

  async onMessage(msg) {
    if (!this._active) return;
    if (msg?.type === 'system_state.updated' && msg.payload?.key === STATE_KEY) {
      this._sendBack.delete(msg.resourceId);
      return;
    }
    if (msg?.type === 'system_state.updated' && isFormsKey(msg.payload?.key)) {
      // An edited form reaches an actor already in it.
      this._formsCache.delete(msg.resourceId);
      const actor = msg.resourceId && this._findActor(msg.resourceId);
      if (actor && msg.payload.key === formKey(actor.getFlag(FLAG_SCOPE, FORM_FLAG))) await this._upsert({ id: msg.resourceId });
      return;
    }
    if (!msg?.type?.startsWith('entity.')) return;
    const entity = msg.payload;
    if (!entity?.id) return;
    if (msg.type === 'entity.deleted') {
      await this._unlink(entity.id);
      return;
    }
    if (entity.entity_type_id && entity.entity_type_id !== this._typeId) return;
    if (!entity.entity_type_id && entity.type_slug !== this._defs.preset_slug) return;
    await this._refreshMatch(entity.id);
    await this._upsert(entity);
  }

  _findActor(entityId) {
    return game.actors.find((a) => a.getFlag(FLAG_SCOPE, CREATURE_FLAG) === entityId) ?? null;
  }

  /** One folder even when two creatures arrive at once. */
  _folder() {
    const existing = this._folderId && game.folders.get(this._folderId);
    if (existing) return Promise.resolve(existing);
    this._folderPromise ??= this._findOrCreateFolder().finally(() => { this._folderPromise = null; });
    return this._folderPromise;
  }

  async _findOrCreateFolder() {
    let folder = game.folders.find((f) => f.type === 'Actor' && f.getFlag(FLAG_SCOPE, FOLDER_FLAG));
    if (!folder) {
      folder = await Folder.create({
        name: game.i18n.localize('CHRONICLE.Creatures.Folder'),
        type: 'Actor',
        flags: { [FLAG_SCOPE]: { [FOLDER_FLAG]: true } },
      }, syncOptions());
    }
    this._folderId = folder?.id ?? null;
    return folder;
  }

  /**
   * Create or update the actor for one creature page.
   * @returns {Promise<boolean>} false when it failed.
   */
  _upsert(entity) {
    // Overlapping events for one page (created then updated) run in turn, so
    // the second sees the first's actor instead of making another.
    const prev = this._inFlight.get(entity.id) ?? Promise.resolve();
    const run = prev.then(() => this._upsertNow(entity));
    this._inFlight.set(entity.id, run);
    run.finally(() => { if (this._inFlight.get(entity.id) === run) this._inFlight.delete(entity.id); });
    return run;
  }

  async _upsertNow(entity) {
    // Foundry's own monster is this creature; an actor made earlier, before
    // the DM chose, is left as it is.
    if (playsFoundry(this._matches.get(entity.id))) return true;
    try {
      if (!entity.fields_data) entity = await this._api.get(`/entities/${entity.id}`);
      const before = this._known.get(entity.id);
      this._remember(entity.id, entity.fields_data);
      const actor = this._findActor(entity.id);
      // An actor in another form shows the page as that form.
      const form = actor ? await this._formFor(entity.id, actor) : null;
      const page = entity;
      entity = formEntity(page, form);
      const version = appliedVersion(page.updated_at, form);
      const abilities = this._abilitiesFor(entity);
      if (actor && entity.updated_at && actor.getFlag(FLAG_SCOPE, VERSION_FLAG) === version
        && (!abilities || actor.getFlag(FLAG_SCOPE, ABILITIES_FLAG) === abilities)) return true;

      const choicesFor = (path) => foundry.utils.getProperty(globalThis.CONFIG, path) ?? null;
      const { update, unknown } = creatureUpdate({
        entity,
        fields: this._defs.fields,
        pullKeys: this._pullKeys,
        choicesFor,
      });
      if (unknown.length) log.debug(`Creature "${entity.name}": no Foundry match for ${unknown.join(', ')}`);

      if (!actor) {
        const folder = await this._folder();
        const data = { name: entity.name, type: this._defs.foundry_actor_type, folder: folder?.id ?? null };
        const seed = seedPull({ entity, fields: this._defs.fields, pullKeys: this._pullKeys, choicesFor });
        for (const [path, value] of Object.entries({ ...seed, ...update })) {
          if (path !== 'name') foundry.utils.setProperty(data, path, value);
        }
        data.flags = {
          [FLAG_SCOPE]: {
            [CREATURE_FLAG]: entity.id,
            [LINK_FLAG]: entity.id,
            [VERSION_FLAG]: entity.updated_at ?? null,
          },
        };
        for (const [path, value] of Object.entries(await this._picturePlan(entity, null))) {
          foundry.utils.setProperty(data, path, value);
        }
        const created = await Actor.create(data, syncOptions({ [APPLY_OPTION]: true }));
        if (abilities && created) await this._applyAbilities(created, entity, abilities);
        return true;
      }

      // A Foundry-owned value someone changed in Chronicle since this client
      // last saw the page follows that edit; with nothing seen yet (a reload),
      // Foundry's own value stands.
      let edited = {};
      if (before) {
        const keys = this._pullKeys.filter((k) => !sameValue(before[k], entity.fields_data?.[k]));
        if (keys.length) edited = seedPull({ entity, fields: this._defs.fields, pullKeys: this._pullKeys, choicesFor, onlyKeys: keys });
      }
      const changes = planCreatureApply({ update: { ...edited, ...update }, actor });
      Object.assign(changes, await this._picturePlan(entity, actor));
      if (entity.updated_at) changes[`flags.${FLAG_SCOPE}.${VERSION_FLAG}`] = version;
      if (Object.keys(changes).length) await actor.update(changes, syncOptions({ [APPLY_OPTION]: true }));
      if (abilities && actor.getFlag(FLAG_SCOPE, ABILITIES_FLAG) !== abilities) await this._applyAbilities(actor, entity, abilities);
      return true;
    } catch (err) {
      log.warn(`Creature sync: could not bring in "${entity?.name ?? entity?.id}"`, err);
      return false;
    }
  }

  /** The page's abilities fingerprint when they become items here, else null. */
  _abilitiesFor(entity) {
    if (game.system?.id !== 'draw-steel' || !hasAbilityFields(entity.fields_data)) return null;
    return abilitiesFingerprint(entity.fields_data);
  }

  /**
   * Brings the actor's Chronicle-made ability items in line with the page.
   * Never throws: the stat block still lands, and the next change retries.
   */
  async _applyAbilities(actor, entity, fingerprint) {
    try {
      const dsConfig = globalThis.ds?.CONFIG ?? globalThis.CONFIG?.DRAW_STEEL ?? {};
      const keys = (obj) => (obj && typeof obj === 'object' ? Object.keys(obj) : null);
      const conditions = Array.isArray(globalThis.CONFIG?.statusEffects) ? CONFIG.statusEffects.map((e) => e.id) : null;
      const known = {
        keywords: keys(dsConfig.abilities?.keywords),
        damageTypes: keys(dsConfig.damageTypes),
        conditions,
      };
      const desired = desiredAbilities(entity.fields_data, { known, flagScope: FLAG_SCOPE });
      const items = (actor.items?.contents ?? [...(actor.items ?? [])]).map((i) => ({
        id: i.id,
        name: i.name ?? '',
        type: i.type,
        key: i.getFlag?.(FLAG_SCOPE, ABILITY_FLAG) ?? null,
        hash: i.getFlag?.(FLAG_SCOPE, `${ABILITY_FLAG}Hash`) ?? null,
      }));
      const { create, remove } = planAbilityItems(desired, items);
      const options = syncOptions({ [APPLY_OPTION]: true });
      if (remove.length) await actor.deleteEmbeddedDocuments('Item', remove, options);
      if (create.length) await actor.createEmbeddedDocuments('Item', create, options);
      await actor.update({ [`flags.${FLAG_SCOPE}.${ABILITIES_FLAG}`]: fingerprint }, options);
    } catch (err) {
      log.warn(`Creature sync: could not bring in the abilities for "${entity?.name ?? entity?.id}"`, err);
    }
  }

  /**
   * The portrait and token changes for a page, copying its pictures into the
   * world first. Never throws: a picture that can't be copied is retried on
   * the page's next change.
   */
  async _picturePlan(entity, actor) {
    try {
      const choice = pictureChoice(entity);
      const applied = actor?.getFlag(FLAG_SCOPE, PICTURES_FLAG) || null;
      if (applied && applied.img === choice.img && applied.token === choice.token) return {};
      const current = actor ? { img: actor.img, token: actor.prototypeToken?.texture?.src } : null;
      this._pictures ??= new PictureStore({ api: this._api });
      const local = await this._pictures.ensure(pictureIds(choice));
      return picturePlan({ choice, local, applied, current });
    } catch (err) {
      log.warn(`Creature sync: could not bring in the pictures for "${entity?.name ?? entity?.id}"`, err);
      return {};
    }
  }

  _statePath(entityId, key) {
    return `/entities/${entityId}/system-state/${this._defs.system_id}/${key}`;
  }

  /** A state document, or null when the page has none (or the system is off). */
  async _readState(entityId, key) {
    try {
      return await this._api.get(this._statePath(entityId, key));
    } catch (err) {
      if ([400, 404, 422].includes(err?.status)) return null;
      throw err;
    }
  }

  /**
   * The form an actor is in, or null for the first form. A form that has
   * since been removed puts the actor back in the first form; a failed read
   * throws, so a passing outage never strips a form.
   */
  async _formFor(entityId, actor) {
    const id = actor.getFlag(FLAG_SCOPE, FORM_FLAG);
    if (!isFormId(id)) return null;
    const form = cleanForm((await this._readState(entityId, formKey(id)))?.gm);
    return form?.id === id ? form : null;
  }

  /** The Chronicle creature page behind a token, or null. */
  creatureFor(tokenDoc) {
    const actor = tokenDoc?.baseActor ?? game.actors?.get(tokenDoc?.actorId) ?? null;
    const entityId = actor?.getFlag(FLAG_SCOPE, CREATURE_FLAG);
    return this._active && entityId ? { actor, entityId } : null;
  }

  /**
   * A page's forms in the director's order, with the `forms` index. Read
   * once and kept until Chronicle says they changed.
   * @returns {Promise<{index: object, forms: object[]}>}
   */
  formsFor(entityId) {
    const hit = this._formsCache.get(entityId);
    if (hit) return hit;
    const run = (async () => {
      const index = formIndex(await this._readState(entityId, FORMS_KEY));
      const forms = [];
      for (const id of index.order) {
        const form = cleanForm((await this._readState(entityId, formKey(id)))?.gm);
        if (form?.id === id) forms.push(form);
      }
      return { index, forms };
    })();
    this._formsCache.set(entityId, run);
    run.catch(() => this._formsCache.delete(entityId));
    return run;
  }

  /** The creature preset's Stamina paths, when the system has them. */
  staminaPaths() {
    const path = (key) => this._defs?.fields?.find((f) => f.key === key)?.foundry_path || null;
    const max = path('stamina');
    const value = path('stamina_current');
    return max && value ? { max, value } : null;
  }

  /**
   * Puts a creature in another form ('' for the first): the actor's sheet,
   * abilities, portrait and token change in place, so position, conditions
   * and initiative stay. Each of its tokens on this scene takes the new token
   * picture and its Stamina follows the form's rule. `before(art)` runs once
   * the new art is in the world, for the reveal. Chronicle then records the
   * current form, and that players have seen it when a token was visible.
   * @returns {Promise<{formName: string, stamina: Array<{name: string, value: number, max: number}>, recorded: boolean}>}
   */
  async changeForm(tokenDoc, formId, { before } = {}) {
    const found = this.creatureFor(tokenDoc);
    if (!found) throw new Error('This token is not a Chronicle creature.');
    const { actor, entityId } = found;
    const { forms } = await this.formsFor(entityId);
    const form = formId ? forms.find((f) => f.id === formId) : null;
    if (formId && !form) throw new Error('That form is no longer on the page.');
    const page = await this._api.get(`/entities/${entityId}`);
    const formName = form ? form.name : page.name;

    if (before) {
      const choice = pictureChoice(formEntity(page, form));
      this._pictures ??= new PictureStore({ api: this._api });
      const local = await this._pictures.ensure(pictureIds(choice));
      await before({ img: choice.img === 'generic' ? GENERIC_TOKEN : local.get(choice.img) || '', name: formName });
    }

    const paths = this.staminaPaths();
    const get = foundry.utils.getProperty;
    const tokens = (canvas?.scene?.tokens?.contents ?? []).filter((t) => t.actorId === actor.id);
    if (!tokens.some((t) => t.id === tokenDoc.id) && tokenDoc.parent === canvas?.scene) tokens.push(tokenDoc);
    const was = tokens.map((t) => ({ t, max: paths ? get(t.actor, paths.max) : null, value: paths ? get(t.actor, paths.value) : null }));

    const flag = formId ? { [`flags.${FLAG_SCOPE}.${FORM_FLAG}`]: formId } : flagRemoval(FLAG_SCOPE, FORM_FLAG);
    await actor.update(flag, syncOptions({ [APPLY_OPTION]: true }));
    if (!(await this._upsert(page))) throw new Error('The new form could not be applied.');

    const src = actor.prototypeToken?.texture?.src;
    const stamina = [];
    const doneActors = new Set();
    for (const w of was) {
      if (src && w.t.texture?.src !== src) await w.t.update({ 'texture.src': src }, syncOptions());
      const a = w.t.actor;
      if (!paths || !a || doneActors.has(a)) continue;
      doneActors.add(a);
      const max = get(a, paths.max);
      const value = staminaAfter({ oldMax: w.max, oldValue: w.value, newMax: max, mode: form?.stamina });
      if (value === null) continue;
      // Not an apply: current Stamina goes back to Chronicle like any other hit.
      if (value !== get(a, paths.value)) await a.update({ [paths.value]: value });
      stamina.push({ name: w.t.name, value, max });
    }

    const recorded = await this._recordForm(entityId, form, tokens.some((t) => !t.hidden));
    return { formName, stamina, recorded };
  }

  /**
   * Tells Chronicle the current form, and that players have seen it. The
   * form's public copy is written before the index lists it. An older
   * Chronicle has no write route: the change still happened here.
   */
  async _recordForm(entityId, form, seen) {
    try {
      const index = formIndex(await this._readState(entityId, FORMS_KEY));
      if (form && seen && !index.shown.includes(form.id)) {
        await this._api.put(this._statePath(entityId, formKey(form.id)), { public: form });
      }
      await this._api.put(this._statePath(entityId, FORMS_KEY), { public: publicAfterChange(index, form?.id ?? '', seen) });
      return true;
    } catch (err) {
      log.warn('Creature sync: Chronicle did not record the change of form', err);
      return false;
    } finally {
      this._formsCache.delete(entityId);
    }
  }

  /** The page's Foundry-owned values as Chronicle last had them. */
  _remember(entityId, fieldsData) {
    const known = {};
    for (const key of this._pullKeys) {
      if (fieldsData && key in fieldsData) known[key] = fieldsData[key];
    }
    this._known.set(entityId, known);
  }

  /** A creature page that left Chronicle: the actor stays, only unlinked. */
  async _unlink(entityId) {
    const actor = this._findActor(entityId);
    if (!actor) return;
    const change = flagRemoval(FLAG_SCOPE, CREATURE_FLAG, VERSION_FLAG);
    if (actor.getFlag(FLAG_SCOPE, LINK_FLAG) === entityId) Object.assign(change, flagRemoval(FLAG_SCOPE, LINK_FLAG));
    await actor.update(change, syncOptions({ [APPLY_OPTION]: true }));
    this._known.delete(entityId);
  }

  async _sendBackAllowed(entityId) {
    if (this._sendBack.has(entityId)) return this._sendBack.get(entityId);
    let state = null;
    try {
      state = await this._api.get(`/entities/${entityId}/system-state/${this._defs.system_id}/${STATE_KEY}`);
    } catch (err) {
      // No state (404) or the system not enabled here (400/422) means off;
      // anything else is off this time and asked again next change.
      if (![400, 404, 422].includes(err?.status)) throw err;
    }
    const on = sendBackOn(state);
    this._sendBack.set(entityId, on);
    return on;
  }

  _handleUpdateActor(actor, change, options) {
    if (!this._active || options?.[APPLY_OPTION] || !this._pullKeys.length) return;
    const entityId = actor.getFlag(FLAG_SCOPE, CREATURE_FLAG);
    if (!entityId) return;
    const pullPaths = this._defs.fields.filter((f) => this._pullKeys.includes(f.key)).map((f) => f.foundry_path);
    if (!changedPaths(change).some((p) => pullPaths.some((pp) => p === pp || p.startsWith(`${pp}.`)))) return;
    this._schedulePull(actor);
  }

  /** Conditions arrive as active effects, not as an actor update. */
  _handleEffect(effect) {
    if (!this._active || !this._pullKeys.length) return;
    const actor = effect?.parent;
    if (actor?.documentName !== 'Actor' || !actor.getFlag(FLAG_SCOPE, CREATURE_FLAG)) return;
    this._schedulePull(actor);
  }

  _schedulePull(actor) {
    clearTimeout(this._pullTimers.get(actor.id));
    this._pullTimers.set(actor.id, setTimeout(() => {
      this._pullTimers.delete(actor.id);
      this._pull(actor.id);
    }, PULL_DELAY_MS));
  }

  async _pull(actorId) {
    const actor = game.actors.get(actorId);
    const entityId = actor?.getFlag(FLAG_SCOPE, CREATURE_FLAG);
    if (!entityId || !this._active) return;
    try {
      if (!(await this._sendBackAllowed(entityId))) return;
      const fields = changedPull(creaturePull(actor, this._defs.fields, this._pullKeys), this._known.get(entityId));
      if (!Object.keys(fields).length) return;
      // Only a Chronicle with creature-fields gets here, and it merges this
      // PUT into the page's fields rather than replacing them.
      await this._api.put(`/entities/${entityId}/fields`, { fields_data: fields });
      this._known.set(entityId, { ...this._known.get(entityId), ...fields });
    } catch (err) {
      log.warn(`Creature sync: could not send "${actor.name}" back to Chronicle`, err);
    }
  }
}
