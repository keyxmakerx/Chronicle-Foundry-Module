/**
 * Chronicle Sync — Sync Capability Inspector
 *
 * Answers the operator question: "what CAN we pull from Foundry vs what DO we
 * currently sync?" — per source (the character actor today; extensible to items,
 * effects, calendar). Drives the data-pull-completeness work and is the permanent
 * in-UI diagnostic that replaces grepping the manifest.
 *
 * Two layers (mirrors the calendar diagnostics/validation pattern):
 *   - captureActorSnapshot(actor)  → DEFENSIVE: touches the live Foundry actor,
 *                                    wrapped so a malformed actor can't blank the panel.
 *   - buildCapabilityReport(...)   → PURE: diffs the snapshot against the system's
 *                                    declared character-field manifest. No Foundry globals.
 *   - renderCapabilityMarkdown/Json → PURE: copy-to-clipboard payloads.
 *
 * The pure layers are unit-testable without Foundry (see tools/).
 */

// Cap recursion so a deep/cyclic system object can't run away. Draw Steel's
// hero.system is shallow; 4 covers it with headroom.
const DEFAULT_MAX_DEPTH = 4;

/**
 * walkSchema flattens a plain object tree into [{ path, type, sample }] rows.
 * Generalized from sync-dashboard's _extractSchemaSnapshot so it's standalone and
 * testable. Arrays are summarized (not expanded); objects recurse; primitives
 * carry a truncated sample so the operator sees a real value.
 *
 * @param {*} obj
 * @param {string} prefix - path prefix (e.g. "system")
 * @param {number} maxDepth
 * @returns {Array<{path: string, type: string, sample: *}>}
 */
export function walkSchema(obj, prefix = '', maxDepth = DEFAULT_MAX_DEPTH) {
  const out = [];
  if (maxDepth <= 0 || obj == null || typeof obj !== 'object') return out;

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value == null) {
      out.push({ path, type: 'null', sample: null });
    } else if (typeof value === 'number') {
      out.push({ path, type: 'number', sample: value });
    } else if (typeof value === 'string') {
      out.push({ path, type: 'string', sample: value.length > 60 ? `${value.slice(0, 60)}…` : value });
    } else if (typeof value === 'boolean') {
      out.push({ path, type: 'boolean', sample: value });
    } else if (Array.isArray(value)) {
      out.push({ path, type: 'array', sample: `[${value.length}]` });
    } else if (typeof value === 'object') {
      const nested = walkSchema(value, path, maxDepth - 1);
      if (nested.length === 0) {
        // empty object / opaque — still record its existence
        out.push({ path, type: 'object', sample: '{}' });
      } else {
        out.push(...nested);
      }
    }
  }
  return out;
}

/**
 * captureActorSnapshot reads everything pullable off a live Foundry actor.
 * DEFENSIVE — every access is guarded; returns { ok:false, error } on failure so
 * the inspector panel degrades gracefully instead of throwing.
 *
 * @param {object} actor - a Foundry Actor (or test double exposing the same shape)
 * @returns {object} snapshot
 */
export function captureActorSnapshot(actor) {
  try {
    if (!actor) return { ok: false, error: 'no actor available to sample' };

    // actor.system may be a DataModel — toObject() yields a plain tree to walk.
    let system = {};
    try {
      const raw = actor.system;
      system = raw && typeof raw.toObject === 'function' ? raw.toObject() : (raw || {});
    } catch (err) {
      system = {};
    }

    // items / effects are Foundry collections (Map-like) — summarize by type, with
    // a sample item's system schema. The generic dot-path adapter cannot reach
    // these today; that's the gap the report flags for WS-3.
    const items = _summarizeCollection(actor.items, true);
    const effects = _summarizeCollection(actor.effects, false);

    let flags = [];
    try {
      flags = walkSchema(actor.flags || {}, 'flags', 2);
    } catch (err) {
      flags = [];
    }

    return {
      ok: true,
      actorId: actor.id ?? null,
      actorName: actor.name ?? '(unnamed)',
      actorType: actor.type ?? null,
      system: walkSchema(system, 'system'),
      items,
      effects,
      flags,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/**
 * _summarizeCollection summarizes a Foundry embedded collection (items/effects).
 * Returns counts, the distinct sub-types, and (for items) one sample's system
 * schema so the operator can see what a future collection-pull would expose.
 */
function _summarizeCollection(coll, withSampleSchema) {
  const result = { available: false, count: 0, types: [], sample: null };
  if (!coll) return result;
  let contents = [];
  try {
    // Foundry Collections expose .contents; fall back to Array.from for Map-likes.
    contents = coll.contents || (typeof coll[Symbol.iterator] === 'function' ? Array.from(coll) : []);
  } catch (err) {
    contents = [];
  }
  result.count = contents.length;
  result.available = contents.length > 0;
  const typeSet = new Set();
  for (const c of contents) {
    if (c && c.type) typeSet.add(c.type);
  }
  result.types = [...typeSet];
  if (withSampleSchema && contents.length > 0) {
    const first = contents[0];
    let sys = {};
    try {
      const raw = first.system;
      sys = raw && typeof raw.toObject === 'function' ? raw.toObject() : (raw || {});
    } catch (err) {
      sys = {};
    }
    result.sample = {
      name: first.name ?? '(unnamed)',
      type: first.type ?? null,
      schema: walkSchema(sys, 'system', 3),
    };
  }
  return result;
}

/**
 * Status codes for a capability row.
 * - synced:             manifest field has a foundry_path AND the actor has a value there
 * - mapped-missing:     manifest field has a foundry_path but the actor lacks that path
 * - declared-unmapped:  manifest field exists but has NO foundry_path (e.g. abilities_json)
 * - available-unmapped: actor exposes a path no manifest field maps (candidate to add)
 * - collection:         items/effects available but the dot-path adapter can't pull them yet
 */
export const CAP_STATUS = Object.freeze({
  SYNCED: 'synced',
  MAPPED_MISSING: 'mapped-missing',
  DECLARED_UNMAPPED: 'declared-unmapped',
  AVAILABLE_UNMAPPED: 'available-unmapped',
  COLLECTION: 'collection',
});

/**
 * buildCapabilityReport diffs a captured actor snapshot against the system's
 * declared character-field manifest. PURE — feed it the snapshot + the fieldDefs
 * fetched from /systems/{id}/character-fields.
 *
 * @param {object} snapshot - from captureActorSnapshot
 * @param {object} fieldDefs - { fields: [{key, foundry_path, foundry_writable, type}], preset_slug, foundry_actor_type }
 * @returns {object} report { ok, source, summary, fields, collections }
 */
export function buildCapabilityReport(snapshot, fieldDefs) {
  if (!snapshot || !snapshot.ok) {
    return { ok: false, error: (snapshot && snapshot.error) || 'no snapshot' };
  }
  const defs = (fieldDefs && Array.isArray(fieldDefs.fields)) ? fieldDefs.fields : [];

  // Index the actor's available system paths for O(1) lookup.
  const availByPath = new Map();
  for (const row of snapshot.system) availByPath.set(row.path, row);

  const mappedPaths = new Set();
  const rows = [];

  // 1. Walk the manifest: classify each declared field.
  for (const f of defs) {
    if (!f.foundry_path) {
      rows.push({
        status: CAP_STATUS.DECLARED_UNMAPPED,
        key: f.key,
        foundry_path: null,
        type: f.type || null,
        writable: f.foundry_writable !== false,
        sample: undefined,
      });
      continue;
    }
    mappedPaths.add(f.foundry_path);
    const avail = availByPath.get(f.foundry_path);
    rows.push({
      status: avail ? CAP_STATUS.SYNCED : CAP_STATUS.MAPPED_MISSING,
      key: f.key,
      foundry_path: f.foundry_path,
      type: f.type || (avail ? avail.type : null),
      writable: f.foundry_writable !== false,
      sample: avail ? avail.sample : undefined,
    });
  }

  // 2. Walk the actor: any available path not mapped is a candidate to add.
  for (const row of snapshot.system) {
    if (mappedPaths.has(row.path)) continue;
    rows.push({
      status: CAP_STATUS.AVAILABLE_UNMAPPED,
      key: null,
      foundry_path: row.path,
      type: row.type,
      writable: null,
      sample: row.sample,
    });
  }

  // 3. Collections (items/effects): available but unreachable by the dot-path adapter.
  const collections = [];
  if (snapshot.items && snapshot.items.available) {
    collections.push({
      status: CAP_STATUS.COLLECTION,
      source: 'actor.items',
      count: snapshot.items.count,
      types: snapshot.items.types,
      note: 'Embedded items (abilities/inventory) — not pullable by the dot-path adapter yet (WS-3).',
      sample: snapshot.items.sample,
    });
  }
  if (snapshot.effects && snapshot.effects.available) {
    collections.push({
      status: CAP_STATUS.COLLECTION,
      source: 'actor.effects',
      count: snapshot.effects.count,
      types: snapshot.effects.types,
      note: 'Active effects (conditions) — live combat-state tier (WS-3 later).',
      sample: null,
    });
  }

  const summary = _summarize(rows, collections);
  return {
    ok: true,
    source: {
      actorName: snapshot.actorName,
      actorType: snapshot.actorType,
      presetSlug: fieldDefs && fieldDefs.preset_slug ? fieldDefs.preset_slug : null,
    },
    summary,
    fields: rows,
    collections,
  };
}

function _summarize(rows, collections) {
  const c = {
    synced: 0,
    mappedMissing: 0,
    declaredUnmapped: 0,
    availableUnmapped: 0,
    collectionsAvailable: collections.length,
    totalDeclared: 0,
  };
  for (const r of rows) {
    if (r.status === CAP_STATUS.SYNCED) c.synced++;
    else if (r.status === CAP_STATUS.MAPPED_MISSING) c.mappedMissing++;
    else if (r.status === CAP_STATUS.DECLARED_UNMAPPED) c.declaredUnmapped++;
    else if (r.status === CAP_STATUS.AVAILABLE_UNMAPPED) c.availableUnmapped++;
  }
  c.totalDeclared = c.synced + c.mappedMissing + c.declaredUnmapped;
  return c;
}

/**
 * renderCapabilityMarkdown — copy-to-clipboard report (human + AI friendly).
 * PURE.
 */
export function renderCapabilityMarkdown(report) {
  if (!report || !report.ok) {
    return `# Sync Capability\n\n_Could not build report: ${(report && report.error) || 'unknown'}_\n`;
  }
  const s = report.summary;
  const lines = [];
  lines.push(`# Sync Capability — ${report.source.presetSlug || report.source.actorType || 'character'}`);
  lines.push('');
  lines.push(`Sampled actor: **${report.source.actorName}** (type \`${report.source.actorType}\`)`);
  lines.push('');
  lines.push(`- Synced: **${s.synced}** / ${s.totalDeclared} declared`);
  lines.push(`- Declared but unmapped (no foundry_path): **${s.declaredUnmapped}**`);
  lines.push(`- Mapped but missing on this actor: **${s.mappedMissing}**`);
  lines.push(`- Available but not mapped (candidates): **${s.availableUnmapped}**`);
  lines.push(`- Collections available (items/effects): **${s.collectionsAvailable}**`);
  lines.push('');
  lines.push('| status | chronicle key | foundry_path | type | writable | sample |');
  lines.push('|--------|---------------|--------------|------|----------|--------|');
  for (const r of report.fields) {
    lines.push(`| ${r.status} | ${r.key ?? ''} | ${r.foundry_path ?? ''} | ${r.type ?? ''} | ${r.writable == null ? '' : r.writable} | ${_fmtSample(r.sample)} |`);
  }
  if (report.collections.length) {
    lines.push('');
    lines.push('## Collections (not yet pullable)');
    for (const c of report.collections) {
      lines.push(`- \`${c.source}\` — ${c.count} item(s), types: ${c.types.join(', ') || '—'} — ${c.note}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** renderCapabilityJSON — machine-readable copy payload. PURE. */
export function renderCapabilityJSON(report) {
  return JSON.stringify(report, null, 2);
}

function _fmtSample(v) {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.replace(/\|/g, '\\|');
  return String(v);
}
