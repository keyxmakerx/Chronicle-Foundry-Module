/**
 * Which maps a change-feed catch-up must refresh. Fog and map entries name
 * their map; marker, drawing, token and layer entries name only the item,
 * so their map is looked up among the items this world already knows. An
 * item it cannot place (new while Foundry was closed, or GM-only and never
 * stored) means every map is refreshed, since guessing would leave one
 * stale.
 *
 * Pure — see tools/test-map-feed.mjs.
 */

/** Feed types that live inside a map. */
const ITEM_TYPES = new Set(['marker', 'drawing', 'token', 'layer']);

/**
 * @param {Array<{type: string, resourceId: string}>} changes  Feed entries.
 * @param {(type: string, id: string) => string|null} mapOf  The map holding a known item, or null.
 * @returns {{mapIds: Set<string>, all: boolean}}
 */
export function mapsToRefresh(changes, mapOf) {
  const mapIds = new Set();
  let all = false;
  for (const c of changes || []) {
    if (!c?.resourceId) continue;
    if (c.type === 'fog' || c.type === 'map') {
      mapIds.add(String(c.resourceId));
    } else if (ITEM_TYPES.has(c.type)) {
      const mapId = mapOf(c.type, String(c.resourceId));
      if (mapId) mapIds.add(String(mapId));
      else all = true;
    }
  }
  return { mapIds, all };
}
