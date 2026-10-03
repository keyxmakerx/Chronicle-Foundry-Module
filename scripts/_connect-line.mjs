/**
 * Parses the one-paste connect line Chronicle shows campaign owners:
 *   chronicle://host[:port][/sub]/c/<campaignId>?key=<apiKey>        (https)
 *   chronicle+http://host[:port][/sub]/c/<campaignId>?key=<apiKey>   (plain http)
 * The path before the final `/c/<campaignId>` is the instance's sub-path.
 * Pure and Foundry-free so it is unit-tested; pinned by
 * `tools/test-connect-line.mjs`. Never include the line or key in a reason.
 */

const SCHEMES = Object.freeze({ 'chronicle:': 'https:', 'chronicle+http:': 'http:' });

/**
 * @param {unknown} text - Pasted line (surrounding whitespace is ignored).
 * @returns {{ok: true, baseUrl: string, campaignId: string, apiKey: string}
 *   | {ok: false, reason: string}}
 */
export function parseConnectLine(text) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof text !== 'string' || !text.trim()) return fail('empty');

  let url;
  try {
    url = new URL(text.trim());
  } catch {
    return fail('not a valid connect line');
  }

  const scheme = SCHEMES[url.protocol];
  if (!scheme) return fail('unsupported scheme');
  // Credentials in the authority would be a different, riskier line shape.
  if (url.username || url.password) return fail('userinfo not allowed');
  if (!url.host) return fail('missing host');

  const m = /^(.*)\/c\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) return fail('missing /c/<campaignId> segment');

  let campaignId;
  try { campaignId = decodeURIComponent(m[2]); } catch { return fail('bad campaign id'); }
  if (!campaignId || /[\s/]/.test(campaignId)) return fail('bad campaign id');

  const apiKey = url.searchParams.get('key');
  if (!apiKey) return fail('missing key');

  const subPath = m[1].replace(/\/+$/, '');
  return { ok: true, baseUrl: `${scheme}//${url.host}${subPath}`, campaignId, apiKey };
}
