/**
 * Which Chronicle build this world is connected to, for the dashboard and
 * the diagnostic bundle. `GET /api/version` is public, so no key is sent.
 * `tools/test-chronicle-version.mjs`.
 */

/**
 * @param {string} apiUrl - The Chronicle address from settings.
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<string|null>} the version, or null when it can't be read.
 */
export async function fetchChronicleVersion(apiUrl, fetchFn = globalThis.fetch) {
  const base = String(apiUrl || '').replace(/\/+$/, '');
  if (!base || typeof fetchFn !== 'function') return null;
  try {
    const res = await fetchFn(`${base}/api/version`, { method: 'GET', credentials: 'omit' });
    if (!res?.ok) return null;
    const v = (await res.json())?.version;
    if (typeof v !== 'string') return null;
    const trimmed = v.trim().slice(0, 64);
    return trimmed && trimmed !== 'unknown' ? trimmed : null;
  } catch {
    return null;
  }
}
