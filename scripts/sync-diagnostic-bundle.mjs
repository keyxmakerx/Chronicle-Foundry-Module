/**
 * Chronicle Sync — Diagnostic Bundle builder
 *
 * Assembles a single, copy-paste troubleshooting report from the data the
 * dashboard already gathers: versions, connection/health status, per-resource
 * sync state, field-mapping, the Sync Capability summary, and the recent
 * activity/error logs. This is the manual precursor to the admin AI assist — it
 * is exactly what a human (or an AI) needs to diagnose a sync problem in one
 * paste, instead of the multi-screenshot hunting this project lived through.
 *
 * PURE — no Foundry globals, no DOM. The dashboard supplies a plain input object;
 * this returns a Markdown string. Unit-tested in tools/test-sync-diagnostic-bundle.mjs.
 *
 * Security: callers must pass already-redacted data. This builder never invents
 * values, but it also does not fetch secrets — keep API keys / tokens out of the
 * input. (The dashboard sources from activity/error logs + health metrics, none
 * of which carry secrets.)
 */

/**
 * @typedef {object} DiagnosticInput
 * @property {object} [versions]    - { module, chronicle, foundry, system, systemId }
 * @property {object} [connection]  - { state, uptimePercent, restSuccess, restError, reconnectAttempts, retryQueue }
 * @property {Array}  [syncStatus]  - [{ resource, direction, lastSync, count, errors }]
 * @property {object} [fieldMapping]- { systemId, characterTypeSlug, adapterType }
 * @property {object} [capability]  - { source:{actorName,actorType}, summary:{...} }
 * @property {Array}  [activityLog] - [{ timeFormatted, type, message }]
 * @property {Array}  [errorLog]    - [{ timeFormatted, method, path, status, message }]
 * @property {string} [generatedAt] - ISO timestamp (caller stamps it; pure builder won't read the clock)
 */

/**
 * Build a Markdown diagnostic bundle. Tolerant of missing/partial input — every
 * section degrades to a clear placeholder rather than throwing.
 * @param {DiagnosticInput} [input]
 * @returns {string}
 */
export function buildDiagnosticBundle(input) {
  const d = input && typeof input === 'object' ? input : {};
  const L = [];

  L.push('# Chronicle Sync — Diagnostic Bundle');
  if (d.generatedAt) L.push(`_Generated: ${d.generatedAt}_`);
  L.push('');

  // --- Versions ---
  L.push('## Versions');
  const v = d.versions || {};
  L.push(`- Module: **${_s(v.module)}**`);
  L.push(`- Chronicle: **${_s(v.chronicle)}**`);
  L.push(`- Foundry: **${_s(v.foundry)}**`);
  L.push(`- Game system: **${_s(v.system)}** (\`${_s(v.systemId)}\`)`);
  L.push('');

  // --- Connection / health ---
  L.push('## Connection');
  const c = d.connection || {};
  L.push(`- State: **${_s(c.state)}**`);
  if (c.uptimePercent != null) L.push(`- Uptime: ${c.uptimePercent}%`);
  if (c.restSuccess != null || c.restError != null) {
    L.push(`- REST: ${_n(c.restSuccess)} ok / ${_n(c.restError)} error`);
  }
  if (c.reconnectAttempts != null) L.push(`- Reconnect attempts: ${_n(c.reconnectAttempts)}`);
  if (c.retryQueue != null) L.push(`- Retry queue: ${_n(c.retryQueue)}`);
  L.push('');

  // --- Per-resource sync status ---
  if (Array.isArray(d.syncStatus) && d.syncStatus.length) {
    L.push('## Sync status');
    L.push('| resource | direction | last sync | count | errors |');
    L.push('|----------|-----------|-----------|-------|--------|');
    for (const r of d.syncStatus) {
      L.push(`| ${_s(r.resource)} | ${_s(r.direction)} | ${_s(r.lastSync)} | ${_n(r.count)} | ${_n(r.errors)} |`);
    }
    L.push('');
  }

  // --- Field mapping ---
  if (d.fieldMapping) {
    const f = d.fieldMapping;
    L.push('## Field mapping');
    L.push(`- Adapter: **${_s(f.adapterType)}** (\`${_s(f.systemId)}\`)`);
    L.push(`- Character type: \`${_s(f.characterTypeSlug)}\``);
    L.push('');
  }

  // --- Capability summary ---
  if (d.capability && d.capability.summary) {
    const s = d.capability.summary;
    const src = d.capability.source || {};
    L.push('## Sync capability');
    if (src.actorName) L.push(`Sampled: **${_s(src.actorName)}** (\`${_s(src.actorType)}\`)`);
    L.push(`- Synced: **${_n(s.synced)}** / ${_n(s.totalDeclared)} declared`);
    L.push(`- Declared, unmapped: ${_n(s.declaredUnmapped)}`);
    L.push(`- Mapped, missing on actor: ${_n(s.mappedMissing)}`);
    L.push(`- Available, not mapped: ${_n(s.availableUnmapped)}`);
    L.push(`- Collections available: ${_n(s.collectionsAvailable)}`);
    L.push('');
  }

  // --- Error log (most useful first) ---
  L.push(`## Error log (${_count(d.errorLog)})`);
  if (Array.isArray(d.errorLog) && d.errorLog.length) {
    for (const e of d.errorLog) {
      const status = e.status ? ` (${e.status})` : '';
      L.push(`- \`${_s(e.timeFormatted)}\` ${_s(e.method)} ${_s(e.path)}${status}: ${_s(e.message)}`);
    }
  } else {
    L.push('_none_');
  }
  L.push('');

  // --- Recent activity ---
  L.push(`## Recent activity (${_count(d.activityLog)})`);
  if (Array.isArray(d.activityLog) && d.activityLog.length) {
    for (const a of d.activityLog) {
      L.push(`- \`${_s(a.timeFormatted)}\` [${_s(a.type)}] ${_s(a.message)}`);
    }
  } else {
    L.push('_none_');
  }
  L.push('');

  // --- Captured log buffer (leveled logger ring) ---
  if (Array.isArray(d.logBuffer) && d.logBuffer.length) {
    L.push(`## Log buffer (${d.logBuffer.length})`);
    for (const e of d.logBuffer) {
      const ts = e && e.t ? new Date(e.t).toISOString() : '';
      L.push(`- \`${ts}\` ${String((e && e.level) || '').toUpperCase()} ${_s(e && e.msg)}`);
    }
    L.push('');
  }

  return L.join('\n');
}

function _s(v) {
  if (v == null || v === '') return '—';
  return String(v);
}
function _n(v) {
  return v == null ? 0 : v;
}
function _count(arr) {
  return Array.isArray(arr) ? arr.length : 0;
}
