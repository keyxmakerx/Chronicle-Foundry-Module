/**
 * Chronicle Sync - who sends a Foundry change to Chronicle
 *
 * Sync runs on GM clients only, and every client's hooks fire for every
 * change. A GM's own change is sent by that GM's client. A player's change
 * (their sheet, their inventory, a journal they own) has no client of its own
 * to send it, so the active GM's client sends it; without that it would never
 * reach Chronicle and the next pull would write Chronicle's older value back
 * over it.
 *
 * That client sends under the GM's key, and a player who owns a document can
 * rewrite its link to Chronicle. So a player's change is sent only when
 * Chronicle itself gives that player the page: the character is claimed by
 * the member they are matched to, or the page grants them editing.
 */

/**
 * @param {string} userId - the user the change hook names as its author.
 * @param {{user?: {id: string, isGM?: boolean}, users?: {get?: Function, activeGM?: {id: string}|null}}} world
 * @returns {boolean} whether this client sends the change.
 */
export function sendsChange(userId, { user, users } = {}) {
  if (!user || !userId) return false;
  if (userId === user.id) return true;
  if (!user.isGM) return false;
  const author = users?.get?.(userId);
  // Another GM's client sends that GM's changes; an unknown author is nobody's.
  if (!author || author.isGM) return false;
  return users?.activeGM?.id === user.id;
}

/**
 * The Chronicle member a Foundry user is matched to.
 * @param {Object<string,string>} mappings - Chronicle member id -> Foundry user id.
 * @param {string} userId
 * @returns {string|null}
 */
export function memberOf(mappings, userId) {
  if (!userId || !mappings || typeof mappings !== 'object') return null;
  for (const [memberId, foundryId] of Object.entries(mappings)) {
    if (foundryId === userId && memberId) return memberId;
  }
  return null;
}

/**
 * Whether Chronicle says this character belongs to the member.
 * @param {{owner_user_id?: string|number|null}} entity
 * @param {string|null} memberId
 * @returns {boolean}
 */
export function ownsCharacter(entity, memberId) {
  const owner = entity?.owner_user_id;
  return !!memberId && owner != null && owner !== '' && String(owner) === String(memberId);
}

/**
 * Whether a page's permissions let the member edit it: custom visibility
 * (Chronicle reads grants in no other mode) with their own edit grant, or
 * one for every player or for everyone.
 * @param {{visibility?: string, permissions?: Array<{subject_type: string, subject_id?: string|number, permission: string}>}} perms
 *   - the `GET /entities/:id/permissions` answer.
 * @param {string|null} memberId
 * @returns {boolean}
 */
export function mayEditPage(perms, memberId) {
  if (!memberId || perms?.visibility !== 'custom' || !Array.isArray(perms.permissions)) return false;
  return perms.permissions.some((g) => g?.permission === 'edit' && (
    g.subject_type === 'public'
    || (g.subject_type === 'role' && String(g.subject_id) === '1')
    || (g.subject_type === 'user' && String(g.subject_id) === String(memberId))
  ));
}

/** `sendsChange` for the live world. */
export function sendsChangeHere(userId) {
  return sendsChange(userId, { user: globalThis.game?.user, users: globalThis.game?.users });
}

/**
 * Whether this client undoes another user's change to a Chronicle link.
 * Every GM client running sync does, not only the one that sends players'
 * changes: each pulls pages through the links it finds, and the client that
 * sends may not be running sync. Undoing twice is harmless. Another GM's
 * change stands; an unknown author's does not.
 * @param {string} userId - the user the change hook names as its author.
 * @param {{user?: {id: string, isGM?: boolean}, users?: {get?: Function}}} world
 * @returns {boolean}
 */
export function undoesLinkChange(userId, { user, users } = {}) {
  if (!user?.isGM || !userId || userId === user.id) return false;
  return users?.get?.(userId)?.isGM !== true;
}

/** `undoesLinkChange` for the live world. */
export function undoesLinkChangeHere(userId) {
  return undoesLinkChange(userId, { user: globalThis.game?.user, users: globalThis.game?.users });
}
