/**
 * Where a Chronicle page's journal goes in Foundry's folders: the same
 * nesting as Chronicle's sidebar. A category inside its parent category,
 * then the page's sidebar folders, outermost first. A page under another
 * page sits beside it, in the parent's folder (a journal can't hold one).
 * Deeper than Foundry allows, the chain stops at the deepest level it can.
 * Pure: `tools/test-folder-tree.mjs`.
 */

/**
 * @typedef {{key: string, kind: 'type'|'node', id: number|string, name: string, color?: string}} FolderLevel
 */

/**
 * @param {object} entity - needs entity_type_id; reads parent_id, parent_node_id, type_name, type_color
 * @param {object} tree
 * @param {Map<number, {id: number, name: string, color?: string, parent_type_id?: number|null}>} tree.types
 * @param {Map<string, {id: string, name: string, entity_type_id: number, parent_id?: string|null}>} tree.folders
 * @param {Map<string, {parent_id?: string|null, parent_node_id?: string|null}>} tree.parents - pages seen, by id
 * @param {number} [maxDepth] - Foundry's folder depth limit
 * @returns {FolderLevel[]} outermost first; empty when the page has no category
 */
export function folderChain(entity, { types, folders, parents }, maxDepth = 4) {
  const typeId = entity?.entity_type_id;
  if (typeId == null) return [];
  const chain = [];
  const seenTypes = new Set();
  for (let t = types.get(typeId); t && !seenTypes.has(t.id); t = types.get(t.parent_type_id)) {
    seenTypes.add(t.id);
    chain.unshift({ key: `type:${t.id}`, kind: 'type', id: t.id, name: t.name, color: t.color || undefined });
  }
  if (!chain.length) {
    if (!entity.type_name) return [];
    chain.push({ key: `type:${typeId}`, kind: 'type', id: typeId, name: entity.type_name, color: entity.type_color || undefined });
  }

  const seen = new Set();
  const fromNode = (nodeId) => {
    const node = folders.get(nodeId);
    if (!node || node.entity_type_id !== typeId || seen.has(node.id)) return [];
    seen.add(node.id);
    const up = node.parent_id ? (folders.has(node.parent_id) ? fromNode(node.parent_id) : fromPage(node.parent_id)) : [];
    return [...up, { key: `node:${node.id}`, kind: 'node', id: node.id, name: node.name }];
  };
  const fromPage = (pageId) => {
    const p = parents.get(pageId);
    if (!p || seen.has(pageId)) return [];
    seen.add(pageId);
    if (p.parent_node_id) return fromNode(p.parent_node_id);
    if (p.parent_id) return fromPage(p.parent_id);
    return [];
  };
  const nodes = entity.parent_node_id ? fromNode(entity.parent_node_id)
    : entity.parent_id ? fromPage(entity.parent_id) : [];
  return [...chain, ...nodes].slice(0, Math.max(1, maxDepth));
}

/**
 * A short fingerprint of the folder layout, so a connect knows when the
 * journals need placing again.
 * @param {object} tree - as for folderChain
 * @returns {string}
 */
export function layoutFingerprint({ types, folders }) {
  const rows = [
    ...[...types.values()].map((t) => `t${t.id}:${t.parent_type_id ?? ''}:${t.name}`),
    ...[...folders.values()].map((f) => `f${f.id}:${f.entity_type_id}:${f.parent_id ?? ''}:${f.name}`),
  ].sort();
  let h = 0x811c9dc5;
  for (const ch of `v1|${rows.join('|')}`) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(16);
}
