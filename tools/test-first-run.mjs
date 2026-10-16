#!/usr/bin/env node
/**
 * Chronicle Sync's first-run screen: before a campaign is connected the window
 * is the connection settings; once connected it draws the import wizard in
 * place of its four sections. The wizard has no window of its own, so its
 * redraws, root element and closing must all go to the host window, and
 * opening it must run the first step's checks (forward moves never land on
 * the first step, so nothing else would).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.foundry = globalThis.foundry || {
  applications: {
    api: {
      ApplicationV2: class {
        get element() { return 'own window'; }
        render() { return 'own render'; }
        close() { return 'own close'; }
      },
      HandlebarsApplicationMixin: (b) => b,
    },
  },
};
globalThis.game = globalThis.game || { system: { id: 'dnd5e' } };

const { ImportWizard } = await import('../scripts/import-wizard.mjs');
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

function fakeHost({ rendered = true } = {}) {
  const inner = { className: 'chronicle-wizard-inner' };
  return {
    rendered,
    renders: 0,
    left: 0,
    element: { querySelector: (sel) => (sel === '.chronicle-wizard-inner' ? inner : null) },
    inner,
    render() { this.renders++; },
    leaveFirstRun() { this.left++; },
  };
}

const fakeManager = {
  api: {
    get: async (path) => (path === '/systems' ? [{ identifier: 'dnd5e', name: 'D&D 5e' }] : [{ id: 1, name: 'Character' }]),
    getAddons: async () => [],
    getTags: async () => [],
  },
};

test('a hosted wizard draws inside its host and closes back to it', () => {
  const host = fakeHost();
  const wizard = ImportWizard.hostedIn(host, fakeManager);
  assert.equal(wizard.element, host.inner);
  wizard.render({ force: true });
  assert.equal(host.renders, 1);
  wizard.close();
  assert.equal(host.left, 1);
});

test('an import running after the window closed does not reopen it', () => {
  const host = fakeHost({ rendered: false });
  ImportWizard.hostedIn(host, fakeManager).render({ force: true });
  assert.equal(host.renders, 0);
});

test('a wizard with no host keeps its own window behaviour', () => {
  const wizard = new ImportWizard();
  assert.equal(wizard.element, 'own window');
  assert.equal(wizard.render(), 'own render');
  assert.equal(wizard.close(), 'own close');
});

test('opening the wizard runs the connect checks', async () => {
  const host = fakeHost();
  const wizard = ImportWizard.hostedIn(host, fakeManager);
  assert.equal(wizard._connectionStatus, null);
  await wizard.start();
  assert.equal(wizard._connectionStatus.connected, true);
  assert.equal(wizard._connectionStatus.systemMatch?.name, 'D&D 5e');
  assert.ok(host.renders >= 1);
});

test('the host runs the wizard buttons with the wizard as this', () => {
  const host = fakeHost();
  const wizard = ImportWizard.hostedIn(host, fakeManager);
  assert.ok(ImportWizard.ACTION_NAMES.includes('wizard-next'));
  assert.ok(ImportWizard.ACTION_NAMES.includes('wizard-cancel'));
  wizard.handleAction('wizard-cancel');
  assert.equal(host.left, 1);
});

test('Chronicle Sync wires the first-run screen', async () => {
  const dash = await read('scripts/sync-dashboard.mjs');
  const hbs = await read('templates/sync-dashboard.hbs');
  const settings = await read('scripts/settings.mjs');
  // Every wizard button reaches the wizard through the dashboard.
  assert.match(dash, /ImportWizard\.ACTION_NAMES\.map\(\(name\) => \[name, SyncDashboard\.#onWizardAction\]\)/);
  assert.match(dash, /'modules\/chronicle-sync\/templates\/import-wizard\.hbs'/);
  // The Setup Wizard button opens the first-run screen, not a second window.
  assert.match(dash, /static #onStartImportAction\(\) \{\s*return this\.startFirstRun\(\);/);
  // Saving the connection first marks the setup to open after the reload.
  assert.match(dash, /if \(firstSave\) await setSetting\('firstRunPending', true\)/);
  assert.match(dash, /context\.configured && getSetting\('firstRunPending'\)\) this\.startFirstRun\(\)/);
  assert.match(settings, /register\(MODULE_ID, 'firstRunPending'/);
  // Unconfigured: the steps and the settings; connected and in setup: the wizard.
  assert.match(hbs, /\{\{#unless configured\}\}[\s\S]*cs-firstrun-steps[\s\S]*chronicle-settings\.hbs" settings\}\}\s*\{\{else if firstRun\}\}[\s\S]*import-wizard\.hbs" firstRun\}\}\s*\{\{else\}\}/);
});
