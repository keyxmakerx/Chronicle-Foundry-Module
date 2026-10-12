/**
 * Pure helpers for the DM Screen's Encounters list (scripts/encounters.mjs).
 *
 * Chronicle's GET /encounters answers `{"data":[...],"total":N}` for the
 * owner or a co-DM; these read it defensively so an older or newer Chronicle
 * can leave fields out without breaking the list. tools/test-encounter-list.mjs
 * pins them.
 */

/** Chronicle's default page; the list is a picker, so it is never walked. */
export const LIST_LIMIT = 50;

const str = (v) => (typeof v === 'string' ? v : '');

/** The request path for the list, with the search text when there is some. */
export function listPath(query = '', limit = LIST_LIMIT) {
  const params = [];
  const q = str(query).trim();
  if (q) params.push(`q=${encodeURIComponent(q)}`);
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : LIST_LIMIT;
  params.push(`limit=${n}`);
  return `/encounters?${params.join('&')}`;
}

/** The request path for one encounter. */
export function encounterPath(id) {
  return `/encounters/${encodeURIComponent(str(id))}`;
}

function summary(raw) {
  const id = str(raw?.id);
  if (!id) return null;
  return {
    id,
    name: str(raw?.name) || str(raw?.page?.name),
    pageName: str(raw?.page?.name),
    ready: raw?.ready === true,
    creatureCount: Number.isFinite(raw?.creatureCount) ? Math.max(0, Math.floor(raw.creatureCount)) : 0,
    updatedAt: str(raw?.updatedAt),
  };
}

/**
 * Unwrap a list answer: a bare array or `{data:[...], total}`. Rows without
 * an id are dropped; `total` falls back to the rows in hand.
 * @returns {{items: object[], total: number}}
 */
export function unwrapEncounterList(raw) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
  const items = rows.map(summary).filter(Boolean);
  const total = Number.isFinite(raw?.total) ? Math.max(raw.total, items.length) : items.length;
  return { items, total };
}

/** Ready fights first, then the rest in the order Chronicle sent them. */
export function readyFirst(items) {
  return [...items.filter((i) => i.ready), ...items.filter((i) => !i.ready)];
}

/**
 * The lang key (under CHRONICLE.Encounters.Error) for a failed request.
 * A 404 on the list is a Chronicle without encounters; a 403 is a key that
 * is not the owner's or a co-DM's.
 */
export function encounterErrorKey(err) {
  switch (err?.status) {
    case 404: return 'NeedsUpdate';
    case 401: return 'BadKey';
    case 403: return 'NotAllowed';
    default: return 'Failed';
  }
}
