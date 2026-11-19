/**
 * The first-run connect screen: paste the connect line and the checks run by
 * themselves; "Connect and continue" then saves it and picks it up in place.
 * The decisions are in _first-connect.mjs. The line and the key are only ever
 * read from the fields and passed on; they are never written into the page,
 * a notice or the console.
 */

import { MODULE_ID } from './constants.mjs';
import { runConnectionTest, stepText } from './_connection-test.mjs';
import { connectValues, checksPass } from './_first-connect.mjs';
import { noticeText } from './_escape-html.mjs';
import { saveConnectionFields, stepItem } from './chronicle-settings.mjs';

const DEBOUNCE_MS = 350;
const FIELDS = ['line', 'apiUrl', 'apiKey', 'campaignId'];

const text = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/**
 * @param {HTMLElement} root - the dashboard element
 * @param {{ onConnected: () => void }} hooks - called once the connection is live in this session
 */
export function wireFirstConnect(root, { onConnected }) {
  const screen = root?.querySelector('[data-first-connect]');
  if (!screen) return;
  const field = Object.fromEntries(FIELDS.map((name) => [name, screen.querySelector(`[data-field="${name}"]`)]));
  const list = screen.querySelector('[data-connect-checks]');
  const button = screen.querySelector('[data-connect-go]');
  const idleHint = list.innerHTML;
  const goLabel = button.textContent;

  let run = 0;
  let timer = null;
  let ready = null;
  let busy = false;

  const read = () => Object.fromEntries(FIELDS.map((name) => [name, field[name]?.value ?? '']));
  const idle = () => { list.innerHTML = idleHint; };
  const show = (steps) => {
    const ul = document.createElement('ul');
    ul.className = 'cs-steps';
    ul.append(...steps);
    list.replaceChildren(ul);
  };

  async function check() {
    const mine = ++run;
    const values = connectValues(read());
    if (!values.ok) {
      if (values.code === 'BadLine') show([stepItem('xmark', text('CHRONICLE.Dashboard.FirstConnect.BadLine'))]);
      else idle();
      return;
    }
    show([stepItem('wait', text('CHRONICLE.ConnectionTest.Testing'))]);
    let steps;
    try {
      steps = await runConnectionTest({
        baseUrl: values.baseUrl,
        apiKey: values.apiKey,
        campaignId: values.campaignId,
        foundrySystemId: game.system?.id,
        origin: window.location.origin,
        fetchImpl: (...args) => fetch(...args),
      });
    } catch {
      steps = [{ icon: 'xmark', code: 'Unreachable', data: { url: values.baseUrl } }];
    }
    // A newer edit started another run; its result is the one to show.
    if (mine !== run) return;
    show(steps.map((s, n) => stepItem(s.icon, stepText(s, (key, data) => game.i18n.format(key, data)), n)));
    if (checksPass(steps)) {
      ready = values;
      button.disabled = false;
    }
  }

  const onEdit = () => {
    // Stop the old result from enabling the button, and keep it off until the new one is in.
    run += 1;
    ready = null;
    button.disabled = true;
    clearTimeout(timer);
    timer = setTimeout(() => { check().catch((err) => console.warn('Chronicle Sync | First connect check failed', err?.message)); }, DEBOUNCE_MS);
  };
  for (const name of FIELDS) field[name]?.addEventListener('input', onEdit);

  async function connect() {
    const values = ready;
    if (!values || busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = text('CHRONICLE.Dashboard.FirstConnect.Connecting');
    const restore = () => { busy = false; button.textContent = goLabel; };
    const line = values.from === 'line' ? read().line : '';
    try {
      const saved = await saveConnectionFields(values.from === 'line'
        ? { connectLine: line }
        : { apiUrl: values.baseUrl, apiKey: values.apiKey, campaignId: values.campaignId });
      if (!saved) { restore(); button.disabled = false; return; }
    } catch (err) {
      console.error('Chronicle Sync | Saving the connection failed:', err?.message);
      ui.notifications.error(game.i18n.format('CHRONICLE.SettingsWindow.SaveFailed', { message: noticeText(err?.message ?? '') }));
      restore();
      button.disabled = false;
      return;
    }

    // From here the connection is saved; the setup opens after a reload if it cannot start now.
    let outcome = 'reload';
    try {
      const { setSetting } = await import('./settings.mjs');
      await setSetting('firstRunPending', true);
      const manager = game.modules.get(MODULE_ID)?.api?.syncManager;
      if (manager?.applyConnection) outcome = await manager.applyConnection();
    } catch (err) {
      console.warn('Chronicle Sync | Picking up the connection failed:', err?.message);
    }
    restore();
    if (outcome === 'started' || outcome === 'reconnected') {
      onConnected();
    } else {
      ui.notifications.warn(text('CHRONICLE.Dashboard.FirstConnect.Connected'));
    }
  }

  button.addEventListener('click', connect);
  field.line?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !button.disabled) { ev.preventDefault(); connect(); }
  });
  field.line?.focus();
}
