#!/usr/bin/env node
/**
 * Unit tests for the pure Diagnostic Bundle builder
 * (`scripts/sync-diagnostic-bundle.mjs`).
 *
 * Run: `node --test tools/test-sync-diagnostic-bundle.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { buildDiagnosticBundle } = await import('../scripts/sync-diagnostic-bundle.mjs');

test('empty / garbage input never throws and produces a titled report', () => {
  for (const bad of [undefined, null, 'nope', 42, {}]) {
    assert.doesNotThrow(() => buildDiagnosticBundle(bad));
  }
  const out = buildDiagnosticBundle();
  assert.match(out, /# Chronicle Sync — Diagnostic Bundle/);
  assert.match(out, /## Versions/);
  assert.match(out, /## Connection/);
  assert.match(out, /## Error log \(0\)/);
  assert.match(out, /## Recent activity \(0\)/);
});

test('versions, connection and capability surface', () => {
  const out = buildDiagnosticBundle({
    generatedAt: '2026-06-26T12:00:00Z',
    versions: { module: '1.2.3', chronicle: '0.13.0', foundry: '13.300', system: 'Draw Steel', systemId: 'drawsteel' },
    connection: { state: 'connected', uptimePercent: 99, restSuccess: 120, restError: 3, reconnectAttempts: 1, retryQueue: 0 },
    fieldMapping: { systemId: 'drawsteel', characterTypeSlug: 'drawsteel-character', adapterType: 'generic' },
    capability: { source: { actorName: 'Tyne', actorType: 'hero' }, summary: { synced: 19, totalDeclared: 29, declaredUnmapped: 4, mappedMissing: 1, availableUnmapped: 12, collectionsAvailable: 2 } },
  });
  assert.match(out, /Generated: 2026-06-26T12:00:00Z/);
  assert.match(out, /Module: \*\*1\.2\.3\*\*/);
  assert.match(out, /State: \*\*connected\*\*/);
  assert.match(out, /REST: 120 ok \/ 3 error/);
  assert.match(out, /drawsteel-character/);
  assert.match(out, /Sampled: \*\*Tyne\*\*/);
  assert.match(out, /Synced: \*\*19\*\* \/ 29 declared/);
});

test('logs render with counts; sync status table when present', () => {
  const out = buildDiagnosticBundle({
    syncStatus: [{ resource: 'characters', direction: 'both', lastSync: '12:01', count: 3, errors: 0 }],
    errorLog: [{ timeFormatted: '12:00', method: 'PUT', path: '/entities/x/fields', status: 500, message: 'boom' }],
    activityLog: [{ timeFormatted: '12:01', type: 'pull', message: 'pulled Tyne' }],
  });
  assert.match(out, /## Sync status/);
  assert.match(out, /\| characters \| both \| 12:01 \| 3 \| 0 \|/);
  assert.match(out, /## Error log \(1\)/);
  assert.match(out, /PUT \/entities\/x\/fields \(500\): boom/);
  assert.match(out, /## Recent activity \(1\)/);
  assert.match(out, /\[pull\] pulled Tyne/);
});

test('missing values degrade to placeholders, not crashes', () => {
  const out = buildDiagnosticBundle({ versions: {}, connection: {} });
  assert.match(out, /Module: \*\*—\*\*/);
  assert.match(out, /State: \*\*—\*\*/);
});

test('leveled log buffer renders when present', () => {
  const out = buildDiagnosticBundle({
    logBuffer: [
      { t: Date.parse('2026-06-26T12:00:00Z'), level: 'error', msg: 'PUT failed' },
      { t: Date.parse('2026-06-26T12:00:01Z'), level: 'debug', msg: 'pull start' },
    ],
  });
  assert.match(out, /## Log buffer \(2\)/);
  assert.match(out, /ERROR PUT failed/);
  assert.match(out, /2026-06-26T12:00:01\.000Z` DEBUG pull start/);
});
