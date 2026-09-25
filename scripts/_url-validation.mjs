/**
 * Host-allowlist for image URLs accepted from Chronicle. Without it a
 * tampered Chronicle response could point `image_url` at an
 * attacker-controlled host, and the Foundry client would fetch it, leaking
 * the player's IP, referer, and any applicable cookies/credentials.
 *
 * Rule: any full-URL image source from Chronicle MUST resolve to the same
 * scheme + hostname as the configured `apiUrl` setting (port need not
 * match — media may be reverse-proxied on a different port — but
 * subdomains must match exactly). Relative paths (`/media/foo.png`) go
 * through the callers' existing baseURL-prefix logic and can never carry
 * a cross-host destination, so they bypass this check.
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
