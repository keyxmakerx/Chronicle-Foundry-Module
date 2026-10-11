#!/usr/bin/env node
/**
 * The Chronicle settings window's save rules (scripts/_settings-form.mjs)
 * and the shared connection test (scripts/_connection-test.mjs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { planSettingsSave, settingsView } from '../scripts/_settings-form.mjs';
import { runConnectionTest, stepText } from '../scripts/_connection-test.mjs';

const saved = {
  apiUrl: 'https://chronicle.example.com',
  apiKey: 'secret-key',
  campaignId: '3f9c2a1e-7b44-4d0a-9e51-0c6f2d8a1b22',
  syncEnabled: true,
  syncDirections: '{"journals":"both","maps":"both","calendar":"pull","characters":"both","shops":"off"}',
  syncJournals: true, syncMaps: true, syncCalendar: true, syncCharacters: true,
  defaultOwnership: 2, dmOnlyHidden: true, syncPermissions: true, conflictResolution: 'chronicle',
  autoSync: true, excludedTags: '["draft"]', excludedNamePattern: '', skipIncomingSanitization: false,
  calendarAnnounceWeather: true, calendarAnnounceWorldstate: false, calendarAnnounceSeasonEra: true, calendarAnnounceMoon: false,
  journalCreateTypeId: 4, userMappings: '{"u1":"fa","u2":"fb"}',
};
const keys = (plan) => plan.writes.map(([k]) => k);

test('an unchanged form writes nothing', () => {
  const v = settingsView(saved);
  const form = {
    apiUrl: v.apiUrl, campaignId: v.campaignId, apiKey: '',
    syncEnabled: v.syncEnabled,
    parts: Object.fromEntries(v.parts.map((p) => [p.part, { on: p.on, direction: p.direction }])),
    ...v.announce,
    defaultOwnership: v.defaultOwnership, dmOnlyHidden: v.dmOnlyHidden, syncPermissions: v.syncPermissions,
    conflictResolution: v.conflictResolution, autoSync: v.autoSync,
    excludedTags: v.excludedTags, excludedNamePattern: v.excludedNamePattern,
    skipIncomingSanitization: v.skipIncomingSanitization,
    journalCreateTypeId: String(saved.journalCreateTypeId), members: {},
  };
  const plan = planSettingsSave(form, saved);
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.connectionChanged, false);
});

test('a blank key field keeps the saved key; the view never carries it', () => {
  assert.ok(!JSON.stringify(settingsView(saved)).includes('secret-key'));
  assert.equal(settingsView(saved).hasKey, true);
  const plan = planSettingsSave({ apiUrl: saved.apiUrl, campaignId: saved.campaignId, apiKey: '  ' }, saved);
  assert.ok(!keys(plan).includes('apiKey'));
  const typed = planSettingsSave({ apiUrl: saved.apiUrl, campaignId: saved.campaignId, apiKey: ' new-key ' }, saved);
  assert.deepEqual(typed.writes.find(([k]) => k === 'apiKey'), ['apiKey', 'new-key']);
  assert.equal(typed.connectionChanged, true);
});

test('a connect line wins over the typed connection fields', () => {
  const plan = planSettingsSave({ connectLine: ' line ', apiUrl: 'https://other.example', apiKey: 'x', campaignId: 'y' }, saved);
  assert.equal(plan.connectLine, 'line');
  assert.ok(!keys(plan).some((k) => ['apiUrl', 'apiKey', 'campaignId'].includes(k)));
});

test('a part switched off is stored as off and its old toggle follows', () => {
  const plan = planSettingsSave({ parts: { maps: { on: false, direction: 'both' } } }, saved);
  const dirs = JSON.parse(plan.writes.find(([k]) => k === 'syncDirections')[1]);
  assert.equal(dirs.maps, 'off');
  assert.equal(dirs.calendar, 'pull', 'untouched parts keep their direction');
  assert.deepEqual(plan.writes.find(([k]) => k === 'syncMaps'), ['syncMaps', false]);
});

test('switching a part back on restores a direction, never "off"', () => {
  const plan = planSettingsSave({ parts: { shops: { on: true, direction: 'nonsense' } } }, saved);
  const dirs = JSON.parse(plan.writes.find(([k]) => k === 'syncDirections')[1]);
  assert.equal(dirs.shops, 'both');
});

test('out-of-range and unknown values are ignored', () => {
  const plan = planSettingsSave({ defaultOwnership: 7, conflictResolution: 'whatever' }, saved);
  assert.ok(!keys(plan).includes('defaultOwnership'));
  assert.ok(!keys(plan).includes('conflictResolution'));
});

test('tags are trimmed into a JSON list', () => {
  const plan = planSettingsSave({ excludedTags: ' draft , spoiler ,, ' }, saved);
  assert.deepEqual(plan.writes, [['excludedTags', '["draft","spoiler"]']]);
});

test('member links: a choice links, a blank unlinks, an unlisted member keeps its link', () => {
  const plan = planSettingsSave({ members: { u1: '', u3: 'fc' } }, saved);
  const written = plan.writes.find(([k]) => k === 'userMappings');
  assert.deepEqual(JSON.parse(written[1]), { u2: 'fb', u3: 'fc' });
});

test('member links that match what is saved write nothing', () => {
  const plan = planSettingsSave({ members: { u1: 'fa' } }, saved);
  assert.ok(!keys(plan).includes('userMappings'));
  assert.ok(!keys(planSettingsSave({ members: {} }, saved)).includes('userMappings'));
});

test('the new-journal page type is written only when the list loaded and it changed', () => {
  assert.deepEqual(planSettingsSave({ journalCreateTypeId: '7' }, saved).writes, [['journalCreateTypeId', 7]]);
  assert.deepEqual(planSettingsSave({ journalCreateTypeId: '4' }, saved).writes, []);
  assert.deepEqual(planSettingsSave({ journalCreateTypeId: undefined }, saved).writes, []);
  assert.deepEqual(planSettingsSave({ journalCreateTypeId: 'x' }, saved).writes, []);
});

function fakeFetch(routes) {
  return async (url) => {
    const r = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
    if (!r) throw new Error(`unexpected ${url}`);
    const v = r[1];
    if (v instanceof Error) throw v;
    return { ok: v.status < 400, status: v.status, statusText: '', json: async () => v.body };
  };
}
const args = { baseUrl: 'https://c.example/', apiKey: 'k', campaignId: 'c1', foundrySystemId: 'dnd5e', origin: 'https://vtt.example' };

test('connection test: missing fields stop before any request', async () => {
  const steps = await runConnectionTest({ ...args, apiKey: '', fetchImpl: () => { throw new Error('no'); } });
  assert.deepEqual(steps, [{ icon: 'xmark', code: 'Missing' }]);
});

test('connection test: CORS and unreachable are told apart', async () => {
  const cors = await runConnectionTest({ ...args, fetchImpl: fakeFetch({ '/entity-types': new TypeError('Failed to fetch') }) });
  assert.equal(cors[0].code, 'Cors');
  assert.equal(cors[0].data.origin, 'https://vtt.example');
  const down = await runConnectionTest({ ...args, fetchImpl: fakeFetch({ '/entity-types': new Error('boom') }) });
  assert.equal(down[0].code, 'Unreachable');
});

test('connection test: each refusal names its cause', async () => {
  for (const [status, code] of [[401, 'AuthFailed'], [403, 'Forbidden'], [404, 'CampaignMissing'], [429, 'RateLimited'], [500, 'HttpError']]) {
    const steps = await runConnectionTest({ ...args, fetchImpl: fakeFetch({ '/entity-types': { status } }) });
    assert.equal(steps.at(-1).code, code, String(status));
    assert.equal(steps.at(-1).icon, 'xmark');
  }
});

test('connection test: success then the game system check', async () => {
  const ok = { '/entity-types': { status: 200, body: {} } };
  const matched = await runConnectionTest({ ...args, fetchImpl: fakeFetch({ ...ok, '/systems': { status: 200, body: { data: [{ foundry_system_id: 'dnd5e', enabled: true, name: 'D&D 5e' }] } } }) });
  assert.deepEqual(matched.map((s) => s.code), ['Reachable', 'AuthOk', 'CampaignOk', 'SystemMatched']);
  const off = await runConnectionTest({ ...args, fetchImpl: fakeFetch({ ...ok, '/systems': { status: 200, body: [{ foundry_system_id: 'dnd5e', enabled: false, name: 'D&D 5e' }] } }) });
  assert.equal(off.at(-1).code, 'SystemDisabled');
  const none = await runConnectionTest({ ...args, fetchImpl: fakeFetch({ ...ok, '/systems': { status: 200, body: { data: [] } } }) });
  assert.equal(none.at(-1).code, 'NoSystems');
});

test('step text comes from the localizer, keyed by code', () => {
  const text = stepText({ icon: 'check', code: 'SystemMatched', data: { name: '<b>x</b>' } }, (k, d) => `${k}|${d.name}`);
  assert.equal(text, 'CHRONICLE.ConnectionTest.SystemMatched|<b>x</b>');
});

test('every step code has an English string', async () => {
  const { readFileSync } = await import('node:fs');
  const en = JSON.parse(readFileSync(new URL('../lang/en.json', import.meta.url), 'utf8'));
  const strings = en.CHRONICLE?.ConnectionTest ?? {};
  for (const code of ['Missing', 'Cors', 'Unreachable', 'Reachable', 'AuthOk', 'AuthFailed', 'Forbidden', 'CampaignMissing',
    'RateLimited', 'HttpError', 'CampaignOk', 'SystemMatched', 'SystemDisabled', 'SystemNoMatch', 'NoSystems']) {
    assert.equal(typeof strings[code], 'string', code);
  }
});

test('Foundry\'s own list keeps only personal choices; the rest is behind the GM-only menu', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/settings.mjs', import.meta.url), 'utf8');
  const shown = [...src.matchAll(/register\(MODULE_ID, '([A-Za-z]+)', \{([\s\S]*?)\n {2}\}\);/g)]
    .filter((m) => /config: true/.test(m[2])).map((m) => m[1]);
  assert.deepEqual(shown.sort(), ['calendarStrip', 'calendarTemperatureUnit']);
  const menu = src.slice(src.indexOf("registerMenu(MODULE_ID, 'chronicleSettings'"));
  assert.match(menu.slice(0, 500), /restricted: true/);
  assert.match(menu.slice(0, 500), /type: ChronicleSettingsWindow/);
});

test('the window never puts the saved API key into the page', async () => {
  const { readFileSync } = await import('node:fs');
  const hbs = readFileSync(new URL('../templates/chronicle-settings.hbs', import.meta.url), 'utf8');
  const key = hbs.match(/<input id="cs-api-key"[^>]*>/)[0];
  assert.doesNotMatch(key, /value=/);
  assert.match(key, /type="password"/);
});

test('the dashboard no longer carries its own Config and Members tabs', async () => {
  const { readFileSync } = await import('node:fs');
  const hbs = readFileSync(new URL('../templates/sync-dashboard.hbs', import.meta.url), 'utf8');
  assert.doesNotMatch(hbs, /data-tab="config"|data-tab="members"/);
  // The old Config tab put the saved key into the page.
  assert.doesNotMatch(hbs, /config\.apiKey/);
  const win = readFileSync(new URL('../templates/chronicle-settings.hbs', import.meta.url), 'utf8');
  assert.match(win, /data-member-key=/);
  assert.match(win, /name="journalCreateTypeId"/);
});

test('only member dropdowns the GM changed are saved', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/chronicle-settings.mjs', import.meta.url), 'utf8');
  assert.match(src, /defaultSelected/);
  assert.match(src, /members: changedMemberLinks\(this\.element\)/);
});

test('the Setup Wizard button hands the wizard the sync manager', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/chronicle-settings.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('static async #onStartImport'), src.indexOf('static async #onSubmit'));
  assert.match(body, /ImportWizard\.instance/);
  assert.match(body, /\.bind\(game\.modules\.get\(MODULE_ID\)\?\.api\?\.syncManager\)/);
});
