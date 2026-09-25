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
