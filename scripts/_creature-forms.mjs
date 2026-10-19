/**
 * Chronicle Sync - creature forms (pure)
 *
 * A creature page can have other forms (a boss's second phase, a disguise).
 * The page's fields are the first form; every other form is a list of changes
 * to them, kept in the page's system state by the system package: `forms`
 * holds the order (gm half) and what players have seen and the current form
 * (public half); `form-<id>` holds one form. The actor follows one form at a
 * time. These rules mirror DrawSteelForms in the Draw Steel package's stat
 * block, which writes the forms; a form read here is cleaned the same way.
 */

import { mediaId, TOKEN_FIELD } from './_creature-pictures.mjs';

/** Actor flag: the id of the form the actor is in; absent for the first form. */
export const FORM_FLAG = 'creatureForm';
export const FORMS_KEY = 'forms';
export const STAMINA_MODES = ['carry', 'fresh'];

const ID_RE = /^[a-z0-9]{1,24}$/;
const MAX_FORMS = 12;
const MAX_LIST = 50;
const FIGURES = ['level', 'organization', 'role', 'ev', 'size', 'keywords', 'faction', 'stamina', 'winded', 'speed',
  'stability', 'immunities', 'weaknesses', 'movement', 'with_captain', 'free_strike',
  'might', 'agility', 'reason', 'intuition', 'presence'];
const LISTS = ['traits', 'abilities_json', 'villain_actions_json'];

export function isFormId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function formKey(id) {
  return `form-${id}`;
}

/** True when a system-state key is one of the forms documents. */
export function isFormsKey(key) {
  return key === FORMS_KEY || (typeof key === 'string' && key.startsWith('form-') && isFormId(key.slice(5)));
}

const scalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function objects(v) {
  let p = v;
  if (typeof v === 'string') {
    try { p = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(p) ? p.filter(isObj).slice(0, MAX_LIST) : [];
}

/** A list field as the stat block reads it; prose traits become one trait. */
function listOf(fields, key) {
  const v = fields?.[key];
  if (key === 'traits' && typeof v === 'string' && v.trim() && !/^\s*\[/.test(v)) {
    const m = /^([^:.]{1,60}):\s*([\s\S]+)$/.exec(v.trim());
    return [m ? { name: m[1].trim(), description: m[2].trim() } : { name: '', description: v.trim() }];
  }
  return objects(v);
}

const itemName = (x) => String(x?.name ?? '').trim();

/** A stored form, or null when it is not one. Malformed parts are dropped. */
export function cleanForm(raw) {
  if (!isObj(raw) || !isFormId(raw.id)) return null;
  const form = {
    id: raw.id,
    name: String(raw.name ?? '').trim().slice(0, 80) || 'Unnamed form',
    stamina: raw.stamina === 'fresh' ? 'fresh' : 'carry',
    changes: {},
    lists: {},
    art: mediaId(raw.art),
    token: mediaId(raw.token),
  };
  const ch = isObj(raw.changes) ? raw.changes : {};
  for (const k of FIGURES) if (Object.hasOwn(ch, k) && scalar(ch[k])) form.changes[k] = ch[k];
  const ls = isObj(raw.lists) ? raw.lists : {};
  for (const k of LISTS) {
    const d = ls[k];
    if (!isObj(d)) continue;
    const drop = Array.isArray(d.drop) ? d.drop.map(String).filter(Boolean).slice(0, MAX_LIST) : [];
    const add = objects(d.add);
    if (drop.length || add.length) form.lists[k] = { drop, add };
  }
  return form;
}

/** The `forms` document: the director's order, and what players have seen. */
export function formIndex(doc) {
  const ids = (v) => [...new Set((Array.isArray(v) ? v : []).filter(isFormId))].slice(0, MAX_FORMS);
  const pub = isObj(doc?.public) ? doc.public : {};
  const gm = isObj(doc?.gm) ? doc.gm : null;
  return {
    order: gm ? ids(gm.order) : [],
    shown: ids(pub.shown),
    current: isFormId(pub.current) ? pub.current : '',
    pub,
  };
}

/** One list with a form's change laid over: changed items keep their place. */
function mergeList(base, d) {
  const drop = [...(d?.drop ?? [])];
  const add = [...(d?.add ?? [])];
  const out = [];
  for (const b of base) {
    const i = drop.indexOf(itemName(b));
    if (i === -1) { out.push(b); continue; }
    drop.splice(i, 1);
    const j = add.findIndex((a) => itemName(a) === itemName(b));
    if (j !== -1) out.push(add.splice(j, 1)[0]);
  }
  return out.concat(add);
}

/**
 * The page as this form: its fields with the form's changes laid over, and
 * its pictures. A form without its own picture borrows the page's; a form
 * with art but no token lets the art stand in for the token, as a page does.
 * The page object itself is never changed.
 */
export function formEntity(entity, form) {
  if (!form) return entity;
  const base = entity?.fields_data ?? {};
  const fields = { ...base, ...form.changes };
  for (const k of LISTS) {
    if (form.lists[k]) fields[k] = JSON.stringify(mergeList(listOf(base, k), form.lists[k]));
  }
  const art = form.art || mediaId(entity?.image_path);
  fields[TOKEN_FIELD] = form.token || (form.art ? '' : (base[TOKEN_FIELD] ?? ''));
  return { ...entity, image_path: art, fields_data: fields };
}

/** A short fingerprint of a form, so an edited form re-applies. */
export function formTag(form) {
  if (!form) return '';
  const s = JSON.stringify(form);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${form.id}:${(h >>> 0).toString(36)}`;
}

/** What the actor records as the version it last applied. */
export function appliedVersion(updatedAt, form) {
  const tag = formTag(form);
  return tag ? `${updatedAt ?? ''}#${tag}` : (updatedAt ?? null);
}

/**
 * Current Stamina after a change of form. `carry`: the damage taken so far
 * carries over; `fresh`: the new form starts at full.
 */
export function staminaAfter({ oldMax, oldValue, newMax, mode }) {
  const max = Number(newMax);
  if (!Number.isFinite(max)) return null;
  if (mode === 'fresh') return max;
  const taken = Math.max(0, (Number(oldMax) || 0) - (Number(oldValue) || 0));
  return Math.max(0, max - taken);
}

/**
 * The picker's rows: the first form, then each form in the director's order,
 * with the current one marked.
 */
export function formChoices(firstName, forms, currentId) {
  const rows = [{ id: '', name: firstName || 'First form' }, ...forms.map((f) => ({ id: f.id, name: f.name }))];
  return rows.map((r) => ({ ...r, current: r.id === (currentId || '') }));
}

/**
 * The `forms` public half after the table changes form: players have now seen
 * it (when they could see the token), and it is the current form. Other keys
 * are kept.
 */
export function publicAfterChange(index, formId, seen) {
  const shown = seen && formId && !index.shown.includes(formId) ? [...index.shown, formId] : [...index.shown];
  const ordered = index.order.length ? index.order.filter((id) => shown.includes(id)) : shown;
  // Players' page follows only to a form they have seen.
  return { ...index.pub, v: 1, shown: ordered, current: formId && ordered.includes(formId) ? formId : '' };
}
