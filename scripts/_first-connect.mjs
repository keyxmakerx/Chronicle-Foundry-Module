/**
 * Decisions behind the first-run connect screen, kept free of Foundry and the
 * DOM so they are unit-tested (tools/test-first-connect.mjs). Nothing here
 * may carry the connect line or the key into a message: callers get codes.
 */

import { parseConnectLine } from './_connect-line.mjs';

/**
 * Which values the screen would connect with. A pasted line wins over the
 * by-hand fields, so a GM who filled both is never surprised by stale ones.
 * @param {{ line?: string, apiUrl?: string, apiKey?: string, campaignId?: string }} fields
 * @returns {{ ok: true, baseUrl: string, apiKey: string, campaignId: string, from: 'line'|'hand' }
 *   | { ok: false, code: 'Empty'|'BadLine'|'Incomplete' }}
 */
export function connectValues({ line, apiUrl, apiKey, campaignId } = {}) {
  const pasted = String(line ?? '').trim();
  if (pasted) {
    const parsed = parseConnectLine(pasted);
    // The parser's reason is dropped on purpose: it is not for display.
    if (!parsed.ok) return { ok: false, code: 'BadLine' };
    return { ok: true, baseUrl: parsed.baseUrl, apiKey: parsed.apiKey, campaignId: parsed.campaignId, from: 'line' };
  }
  const url = String(apiUrl ?? '').trim();
  const key = String(apiKey ?? '').trim();
  const campaign = String(campaignId ?? '').trim();
  if (!url && !key && !campaign) return { ok: false, code: 'Empty' };
  if (!url || !key || !campaign) return { ok: false, code: 'Incomplete' };
  return { ok: true, baseUrl: url, apiKey: key, campaignId: campaign, from: 'hand' };
}

/**
 * Whether the checks allow connecting: the campaign was found and nothing
 * failed. A warning (the game system did not match) does not block, since
 * connecting without a matched system is legitimate.
 * @param {Array<{ icon: string, code: string }>} steps
 */
export function checksPass(steps) {
  if (!Array.isArray(steps)) return false;
  return steps.some((s) => s?.code === 'CampaignOk') && !steps.some((s) => s?.icon === 'xmark');
}
