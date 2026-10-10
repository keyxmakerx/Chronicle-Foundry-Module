/**
 * Decides whether a Chronicle map marker, drawing, or token may be written
 * into the shared JournalEntry page flags Foundry syncs to every client
 * with observer access. There is no per-recipient delivery for page flags
 * — anything written there is readable by every observer via ordinary
 * flag/DOM inspection, not just the render path that is supposed to hide
 * it — so restricted data must stay out of the write itself.
 *
 * Markers and drawings share one restriction shape: `visibility`
 * (`everyone`/`dm_only`) plus an optional per-user `visibility_rules`
 * allow/deny list, traveling the wire as a JSON *string* (Chronicle's
 * `Marker.VisibilityRules`/`Drawing.VisibilityRules *string`), not a
 * nested object. Tokens instead carry one GM-only `is_hidden` boolean, no
 * per-user rules. In every case, parse failure or an unrecognized shape
 * (including a JSON array, which is not the `{allowed_users,
 * denied_users}` object the rules are) fails closed — excluded — matching
 * this repo's fail-closed rule for anything security-adjacent.
 *
 * Shadow areas (drawings with `drawing_type: "shadow"`) are Chronicle's way
 * of keeping part of a map secret from players. The module syncs with the
 * owner's key, so it receives everything under a shadow; the player copy
 * must drop it the same way Chronicle's own player views do.
 */

/**
 * True when a marker carries no restriction that would make it unsafe to
 * broadcast to every observer.
 * @param {object} marker
 * @returns {boolean}
 */
export function isMarkerSafeForPlayerFlags(marker) {
  return _isSafeByVisibilityRules(marker);
}

/**
 * True when a drawing carries no restriction that would make it unsafe to
 * broadcast to every observer. Drawings carry the same `visibility`/
 * `visibility_rules` fields as markers, and no `is_visible`/`is_hidden`
 * fields — those belong to layers and tokens respectively, not drawings.
 * @param {object} drawing
 * @returns {boolean}
 */
export function isDrawingSafeForPlayerFlags(drawing) {
  return _isSafeByVisibilityRules(drawing);
}

/**
 * Shared implementation for markers and drawings. Mirrors Chronicle's own
 * default-allow semantics (`VisibilityRules.Allows`): absent rules, or
 * present rules with both lists empty, are unrestricted; a non-empty
 * `allowed_users` or `denied_users` means *some* recipient must be
 * excluded, which a single shared flag write can't express — so the whole
 * item is excluded instead.
 * @param {object} item
 * @returns {boolean}
 * @private
 */
function _isSafeByVisibilityRules(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.visibility === 'dm_only') return false;

  const rules = _parseVisibilityRules(item.visibility_rules);
  if (rules === null) return true; // no rules at all: unrestricted, as today.
  if (rules === undefined) return false; // present but unparseable: fail closed.

  const denied = Array.isArray(rules.denied_users) ? rules.denied_users : [];
  const allowed = Array.isArray(rules.allowed_users) ? rules.allowed_users : [];
  return denied.length === 0 && allowed.length === 0;
}

/**
 * True when a token carries no restriction that would make it unsafe to
 * broadcast to every observer. Tokens have no per-user visibility rules —
 * `is_hidden` is Chronicle's single GM-only flag (`Token.IsHidden`, the
 * same field its own non-owner token listing excludes with `is_hidden =
 * FALSE`) — so anything short of a confirmed `is_hidden === false` fails
 * closed.
 * @param {object} token
 * @returns {boolean}
 */
export function isTokenSafeForPlayerFlags(token) {
  if (!token || typeof token !== 'object') return false;
  return token.is_hidden === false;
}

/**
 * Parse the wire-format `visibility_rules` value into an object.
 * @param {*} raw
 * @returns {object|null|undefined} the parsed object, `null` when there is
 *   no restriction data at all, or `undefined` when `raw` is present but
 *   not a recognizable shape (caller fails closed on `undefined`). A JSON
 *   array — wire string or already-parsed — is not the `{allowed_users,
 *   denied_users}` shape and counts as unrecognized, not as an object.
 * @private
 */
function _parseVisibilityRules(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (Array.isArray(raw)) return undefined;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null) return null; // JSON null means no rules, as Chronicle reads it.
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Chronicle's drawing type for an area whose contents players must not get. */
export const SHADOW_DRAWING_TYPE = 'shadow';

/**
 * Parse a drawing's `points` (an array of `{x, y}` on the wire, or its JSON
 * string). Returns null for anything that is not an array of finite pairs.
 * @param {*} raw
 * @returns {{x: number, y: number}[]|null}
 * @private
 */
function _parsePoints(raw) {
  let pts = raw;
  if (typeof pts === 'string') {
    try { pts = JSON.parse(pts); } catch { return null; }
  }
  if (!Array.isArray(pts)) return null;
  const out = [];
  for (const p of pts) {
    const x = p?.x;
    const y = p?.y;
    if (typeof x !== 'number' || typeof y !== 'number' ||
        !Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push({ x, y });
  }
  return out;
}

/**
 * The boxes of every shadow drawing, in map percentages, corners ordered.
 * Mirrors Chronicle: a shadow is exactly two corners; anything else is not
 * an area (Chronicle refuses to store it).
 * @param {object[]} drawings
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}[]}
 */
export function shadowAreasOf(drawings) {
  const areas = [];
  for (const d of drawings || []) {
    if (d?.drawing_type !== SHADOW_DRAWING_TYPE) continue;
    const pts = _parsePoints(d.points);
    if (!pts || pts.length !== 2) continue;
    areas.push({
      minX: Math.min(pts[0].x, pts[1].x),
      minY: Math.min(pts[0].y, pts[1].y),
      maxX: Math.max(pts[0].x, pts[1].x),
      maxY: Math.max(pts[0].y, pts[1].y),
    });
  }
  return areas;
}

/**
 * Is (x, y) under any shadow? Edges count as inside, so a pin on the
 * border is not left showing.
 * @private
 */
function _pointInAnyShadow(areas, x, y) {
  return areas.some((a) => x >= a.minX && x <= a.maxX && y >= a.minY && y <= a.maxY);
}

/**
 * True when a marker sits under a shadow. A marker with no usable position
 * is treated as hidden whenever any shadow exists (fail closed).
 * @param {object} marker
 * @param {object[]} areas from `shadowAreasOf`
 * @returns {boolean}
 */
export function isMarkerUnderShadow(marker, areas) {
  if (!areas.length) return false;
  const x = Number(marker?.x);
  const y = Number(marker?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  return _pointInAnyShadow(areas, x, y);
}

/**
 * True when a non-shadow drawing lies wholly under shadows. One that only
 * touches a shadow stays, as on Chronicle, because hiding it would also hide
 * the part players may see. Unparseable points count as hidden.
 * @param {object} drawing
 * @param {object[]} areas from `shadowAreasOf`
 * @returns {boolean}
 */
export function isDrawingUnderShadow(drawing, areas) {
  if (!areas.length || drawing?.drawing_type === SHADOW_DRAWING_TYPE) return false;
  const pts = _parsePoints(drawing?.points);
  if (!pts) return true;
  if (pts.length === 0) return false;
  return pts.every((p) => _pointInAnyShadow(areas, p.x, p.y));
}

/**
 * The subset of a map's markers and drawings that may go into the page
 * flags every Foundry player can read: visibility rules first, then shadow
 * areas. Shadow drawings themselves stay out too, since the viewer cannot
 * draw them for players yet and their position alone tells where the
 * secret is. TODO(#118): pass them through once the viewer draws the smoke.
 * @param {object[]} markers
 * @param {object[]} drawings the map's full drawing list (GM view)
 * @returns {{ markers: object[], drawings: object[] }}
 */
export function playerSafeMapItems(markers, drawings) {
  const areas = shadowAreasOf(drawings);
  return {
    markers: (markers || []).filter(
      (m) => isMarkerSafeForPlayerFlags(m) && !isMarkerUnderShadow(m, areas)
    ),
    drawings: (drawings || []).filter(
      (d) => d?.drawing_type !== SHADOW_DRAWING_TYPE &&
        isDrawingSafeForPlayerFlags(d) && !isDrawingUnderShadow(d, areas)
    ),
  };
}

/**
 * Render-time check for one marker in the map viewer. Player clients only
 * ever hold the filtered flag copy, so this is a second line, not the
 * first: `dm_only` is GM-only, and per-user rules (a JSON string on the
 * wire) are honored against the player's mapped Chronicle user id.
 * Unparseable rules hide the marker from players.
 * @param {object} marker
 * @param {boolean} isGM
 * @param {string|null} chronicleUserId
 * @returns {boolean}
 */
export function userCanSeeMarker(marker, isGM, chronicleUserId) {
  if (!marker || typeof marker !== 'object') return false;
  if (marker.visibility === 'dm_only') return isGM;
  if (isGM) return true;

  const rules = _parseVisibilityRules(marker.visibility_rules);
  if (rules === null) return true;
  if (rules === undefined) return false;

  const denied = Array.isArray(rules.denied_users) ? rules.denied_users : [];
  if (chronicleUserId && denied.includes(chronicleUserId)) return false;

  const allowed = Array.isArray(rules.allowed_users) ? rules.allowed_users : [];
  if (allowed.length > 0) {
    return chronicleUserId ? allowed.includes(chronicleUserId) : false;
  }
  return true;
}

/**
 * Which page-flag lists a refresh may overwrite. A list whose fetch failed is
 * unknown, not empty, so its stored player copy stays as it was. Markers also
 * need the drawings (shadow areas hide pins), so they are rewritten only when
 * both arrived.
 * @param {{ markers?: boolean, drawings?: boolean, tokens?: boolean, layers?: boolean }} known
 *   true for each list that was fetched (default true)
 * @returns {{ markers: boolean, drawings: boolean, tokens: boolean, layers: boolean }}
 */
export function flagListsToWrite(known = {}) {
  const k = (name) => known[name] !== false;
  return {
    markers: k('markers') && k('drawings'),
    drawings: k('drawings'),
    tokens: k('tokens'),
    layers: k('layers'),
  };
}
