/**
 * Chronicle Sync — URL validation helpers (FM-SEC-CHUNK-2)
 *
 * Host-allowlist for image URLs accepted from Chronicle. Closes M-2 — a
 * latent exfiltration vector where a tampered Chronicle response could
 * return an `image_url` pointing at an attacker-controlled host; the
 * Foundry client would then fetch the resource, leaking the player's
 * IP, referer, and any cookies/credentials that happen to apply to the
 * attacker domain.
 *
 * The rule: any full-URL image source supplied by Chronicle MUST resolve
 * to the same scheme + hostname as the configured `apiUrl` setting.
 * Relative paths (`/media/foo.png`) are handled by the existing
 * baseURL-prefix logic in the callers — they can never carry a
 * cross-host destination so they bypass the check.
 *
 * Port is intentionally NOT required to match — Chronicle deployments
 * may serve media on a different port (e.g., reverse-proxied
 * media-server) than the API itself; that shape doesn't change the
 * exfiltration risk because the host has to remain the operator's
 * configured Chronicle. Subdomains (e.g. `media.chronicle.example.com`
 * when apiUrl is `chronicle.example.com`) DO need to match — strict
 * hostname equality is the default per FM-SEC-AUDIT §0.5 D1.1.
 *
 * Per FM-SECURITY-AUDIT §2 M-2, §4 Chunk 2, §0.5 D1=(c).
 */

/**
 * Whether a full-URL image source is allowed to be fetched.
 *
 * @param {string} url - The candidate image URL (full URL with scheme).
 * @param {string} apiUrl - The configured Chronicle apiUrl setting.
 * @returns {boolean} `true` iff `url` parses, `apiUrl` parses, and the
 *   parsed scheme + hostname match. Returns `false` on any parse
 *   failure, mismatch, or non-string input — fail-closed by design.
 */
export function _isAllowedImageHost(url, apiUrl) {
  if (typeof url !== 'string' || !url) return false;
  if (typeof apiUrl !== 'string' || !apiUrl) return false;
  let target, base;
  try {
    target = new URL(url);
    base = new URL(apiUrl);
  } catch {
    return false;
  }
  return target.protocol === base.protocol && target.hostname === base.hostname;
}

/**
 * Build a consistent warning message for a rejected URL. Centralized
 * here so every callsite logs the same shape (kind + url + apiUrl),
 * which keeps operator triage straightforward.
 *
 * @param {string} kind - Callsite label (e.g., `map_image`, `token_image`, `media_url`).
 * @param {string} url - The rejected URL.
 * @param {string} apiUrl - The configured apiUrl (for the operator-facing context).
 * @returns {string}
 */
export function _describeRejection(kind, url, apiUrl) {
  return `Chronicle [${kind}]: rejected cross-host image URL (does not match apiUrl host). url=${JSON.stringify(url)} apiUrl=${JSON.stringify(apiUrl)}`;
}
