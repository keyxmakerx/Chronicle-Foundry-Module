/**
 * The "Test connection" check, shared by the Chronicle settings window and
 * the dashboard. Pure apart from the injected fetch: it returns steps as
 * codes plus data, and the caller localizes them (stepText), so no
 * Chronicle-side string is ever treated as markup. Pinned by tools/test-settings-form.mjs.
 */

/**
 * @typedef {{ icon: 'check'|'xmark'|'warn', code: string, data?: object }} TestStep
 */

/**
 * @param {object} args
 * @param {string} args.baseUrl
 * @param {string} args.apiKey
 * @param {string} args.campaignId
 * @param {string} [args.foundrySystemId] - game.system.id
 * @param {string} [args.origin] - window.location.origin, named in the CORS hint
 * @param {typeof fetch} args.fetchImpl
 * @returns {Promise<TestStep[]>}
 */
export async function runConnectionTest({ baseUrl, apiKey, campaignId, foundrySystemId, origin, fetchImpl }) {
  const url = String(baseUrl || '').trim().replace(/\/+$/, '');
  const key = String(apiKey || '').trim();
  const camp = String(campaignId || '').trim();
  if (!url || !key || !camp) return [{ icon: 'xmark', code: 'Missing' }];

  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  const base = `${url}/api/v1/campaigns/${encodeURIComponent(camp)}`;
  let resp;
  try {
    resp = await fetchImpl(`${base}/entity-types`, { method: 'GET', headers });
  } catch (err) {
    // A browser reports a CORS refusal as a bare TypeError with no status.
    const cors = err instanceof TypeError && /failed to fetch|networkerror/i.test(err.message || '');
    return [cors
      ? { icon: 'xmark', code: 'Cors', data: { origin: origin || '' } }
      : { icon: 'xmark', code: 'Unreachable', data: { url } }];
  }

  const reached = { icon: 'check', code: 'Reachable' };
  const authOk = { icon: 'check', code: 'AuthOk' };
  if (resp.status === 401) return [reached, { icon: 'xmark', code: 'AuthFailed' }];
  if (resp.status === 403) return [reached, { icon: 'xmark', code: 'Forbidden' }];
  if (resp.status === 404) return [reached, authOk, { icon: 'xmark', code: 'CampaignMissing', data: { campaignId: camp } }];
  if (resp.status === 429) return [reached, { icon: 'xmark', code: 'RateLimited' }];
  if (!resp.ok) return [reached, { icon: 'xmark', code: 'HttpError', data: { status: resp.status, statusText: resp.statusText || '' } }];

  const steps = [reached, authOk, { icon: 'check', code: 'CampaignOk' }];
  if (!foundrySystemId) return steps;
  try {
    const sysResp = await fetchImpl(`${base}/systems`, { method: 'GET', headers });
    if (!sysResp.ok) return steps;
    const body = await sysResp.json();
    const systems = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : []);
    const match = systems.find((s) => s.foundry_system_id === foundrySystemId && s.enabled);
    const byId = systems.find((s) => s.foundry_system_id === foundrySystemId);
    if (match) steps.push({ icon: 'check', code: 'SystemMatched', data: { name: String(match.name ?? '') } });
    else if (byId) steps.push({ icon: 'warn', code: 'SystemDisabled', data: { name: String(byId.name ?? '') } });
    else if (systems.length) {
      steps.push({ icon: 'warn', code: 'SystemNoMatch', data: {
        foundryId: foundrySystemId,
        available: systems.map((s) => s.foundry_system_id || '-').join(', '),
      } });
    } else steps.push({ icon: 'warn', code: 'NoSystems' });
  } catch { /* the system check is optional */ }
  return steps;
}

/**
 * Localize one step. `format(key, data)` is game.i18n.format; the result is
 * text, to be set with textContent.
 * @param {TestStep} step
 * @param {(key: string, data?: object) => string} format
 */
export function stepText(step, format) {
  return format(`CHRONICLE.ConnectionTest.${step.code}`, step.data ?? {});
}
