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
 * (_creature-abilities.mjs), so the system rolls and applies them.
 */

import { getSetting } from './settings.mjs';
import { FLAG_SCOPE, syncOptions, APPLY_OPTION } from './constants.mjs';
import { LINK_FLAG } from './npc-presence.mjs';
import { walkEntityPages, unwrapEntityList } from './_entity-page-walk.mjs';
import {
  creatureUpdate, planCreatureApply, creaturePull, sendBackOn, changedPull, seedPull,
} from './_creature-fields.mjs';
import { isAnsweringGM } from './_stash-relay.mjs';
import { sameValue } from './_actor-apply-plan.mjs';
import { log } from './logger.mjs';
import { PictureStore } from './picture-store.mjs';
import { pictureChoice, pictureIds, picturePlan, PICTURES_FLAG } from './_creature-pictures.mjs';
import {
  ABILITY_FLAG, abilitiesFingerprint, desiredAbilities, hasAbilityFields, planAbilityItems,
} from './_creature-abilities.mjs';

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
  }

  get _active() {
    // Every GM client runs sync; only the active one may create actors.
    return !!(this._defs && getSetting('syncCreatures') && isAnsweringGM(game.user, game.users?.activeGM));
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
    this._folderPromise = null;
    this._defs = null;
  }

  /** Brings every creature page in on connect; actors already current are left alone. */
  async onInitialSync() {
    if (!this._active) return;
    // A missed system_state message must not leave an old answer in place.
    this._sendBack.clear();
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
    if (!msg?.type?.startsWith('entity.')) return;
    const entity = msg.payload;
    if (!entity?.id) return;
    if (msg.type === 'entity.deleted') {
      await this._unlink(entity.id);
      return;
    }
    if (entity.entity_type_id && entity.entity_type_id !== this._typeId) return;
    if (!entity.entity_type_id && entity.type_slug !== this._defs.preset_slug) return;
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
    try {
      if (!entity.fields_data) entity = await this._api.get(`/entities/${entity.id}`);
      const before = this._known.get(entity.id);
      this._remember(entity.id, entity.fields_data);
      const actor = this._findActor(entity.id);
      const abilities = this._abilitiesFor(entity);
      if (actor && entity.updated_at && actor.getFlag(FLAG_SCOPE, VERSION_FLAG) === entity.updated_at
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
      if (entity.updated_at) changes[`flags.${FLAG_SCOPE}.${VERSION_FLAG}`] = entity.updated_at;
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
    const change = {
      [`flags.${FLAG_SCOPE}.-=${CREATURE_FLAG}`]: null,
      [`flags.${FLAG_SCOPE}.-=${VERSION_FLAG}`]: null,
    };
    if (actor.getFlag(FLAG_SCOPE, LINK_FLAG) === entityId) change[`flags.${FLAG_SCOPE}.-=${LINK_FLAG}`] = null;
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
