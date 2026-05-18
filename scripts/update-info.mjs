/**
 * Chronicle Sync — Update Source Info dialog
 *
 * Shows the install-time manifest URL Foundry stored for this module,
 * pattern-matches it to detect whether the module is wired up to
 * Chronicle's per-campaign update endpoint or still pointing at the
 * legacy GitHub releases. Adds a manual "Check Chronicle for updates"
 * button so operators can confirm reachability without going through
 * Foundry's native Setup → Modules → Update All UX.
 *
 * On a failed check, this dialog renders a category-tagged diagnostic.
 * Chronicle ships a JSON error body with shape:
 *   { error: <code>, message: <human-readable string>, category: <bucket> }
 * where `category` is one of `auth | config | not_found | validation |
 * internal`. We trust Chronicle's classification (it's the source of
 * truth) and render `body.message` directly — Chronicle's message is
 * already operator-actionable, so the Foundry side does not re-construct
 * cause/action strings for Chronicle errors.
 *
 * For non-Chronicle failures (network unreachable, non-JSON body, JSON
 * parse failed, no install-time URL recorded), we build a 4-clause
 * diagnostic client-side using the `Errors.Network` / `Errors.Parse` /
 * `Errors.NoUrl` / `Errors.HttpFallback` i18n trees.
 *
 * Wired into the module settings panel via `game.settings.registerMenu`
 * in `settings.mjs`.
 *
 * Architecture context: see `.ai.md` → "Chronicle Integration — Install
 * & Updates" for the Foundry-side narrative (how Foundry stores the
 * install-time URL, how rotation breaks installs, what counts as
 * recovery). For the wire-level contract (response shapes, error
 * codes), see `API-CONTRACT.md` → "Chronicle-served Module
 * Distribution".
 */

import { MODULE_ID } from './constants.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Patterns used to classify the install-time manifest URL.
 *
 * Chronicle pattern matches the per-campaign signed manifest endpoint
 * served by Chronicle's `foundry_vtt` sub-plugin:
 *   `/api/v1/campaigns/<uuid>/foundry-vtt/module.json?token=<signed>`
 * The URL shape is defined in `chronicle-package.json` at repo root
 * (`serving.manifestEndpoint`) and locked by FM-CONSOLIDATE-R1 D1.
 */
const CHRONICLE_MANIFEST_RE = /\/api\/v1\/campaigns\/[^/]+\/foundry-vtt\/module\.json/i;
const GITHUB_MANIFEST_RE = /github\.com/i;

/**
 * Chronicle's category enum. Foundry rejects any value outside this set
 * and falls back to HTTP-status classification — so a typo or unknown
 * Chronicle release can't render an unstyled `result-{whatever}` class.
 */
const CHRONICLE_CATEGORIES = new Set([
  'auth',
  'config',
  'not_found',
  'validation',
  'internal',
]);

/**
 * Read the install-time manifest URL Foundry stored for this module.
 * v13+ exposes it as `module.manifest`; v12 nested it under `module.data`.
 *
 * Exported for reuse by the startup recovery probe in `module.mjs` and by
 * the unit tests in `tools/test-update-info.mjs`.
 *
 * @returns {string} The manifest URL, or empty string if not available.
 */
export function readInstallManifestUrl() {
  const mod = game.modules.get(MODULE_ID);
  if (!mod) return '';
  return mod.manifest || mod?.data?.manifest || '';
}

/**
 * Classify a manifest URL into one of three known sources. Used both for
 * the indicator label and to drive the "Check" button's expectations.
 * @param {string} url
 * @returns {'chronicle'|'github'|'unknown'}
 */
function classifyManifestSource(url) {
  if (!url) return 'unknown';
  if (CHRONICLE_MANIFEST_RE.test(url)) return 'chronicle';
  if (GITHUB_MANIFEST_RE.test(url)) return 'github';
  return 'unknown';
}

/**
 * Categorize a failed manifest fetch. Chronicle's server-side `category`
 * field is authoritative; only fall back to HTTP-status mapping when
 * Chronicle did not return a JSON body (proxy error, CDN, etc.).
 *
 * Categories produced here are exactly Chronicle's enum (auth | config |
 * not_found | validation | internal) — no kebab-case mutation. Foundry-
 * specific buckets `network` and `parse` are set by the call sites, not
 * by this function.
 *
 * Exported for testability — see `tools/test-update-info.mjs`.
 *
 * @param {{httpStatus: number, chronicleCategory: string|undefined}} args
 * @returns {'auth'|'config'|'not_found'|'validation'|'internal'}
 */
export function categorize({ httpStatus, chronicleCategory }) {
  if (chronicleCategory && CHRONICLE_CATEGORIES.has(chronicleCategory)) {
    return chronicleCategory;
  }
  if (httpStatus === 401 || httpStatus === 403) return 'auth';
  if (httpStatus === 404) return 'not_found';
  if (httpStatus >= 500 && httpStatus < 600) return 'internal';
  return 'internal';
}

/**
 * FontAwesome icon class per category. Chronicle categories use icons
 * that reinforce the actor cue: gear for "config you need to set",
 * triangle for "data malformed", etc.
 */
const CATEGORY_ICONS = {
  // Chronicle-driven
  auth:       'fa-key',
  config:     'fa-gear',
  not_found:  'fa-magnifying-glass',
  validation: 'fa-triangle-exclamation',
  internal:   'fa-server',
  // Foundry-driven
  network:    'fa-plug-circle-xmark',
  parse:      'fa-file-circle-question',
};

/**
 * Parse Chronicle's error body shape.
 *
 *   { error: <code-string>, message: <human-string>, category: <bucket> }
 *
 * Defensive: any field may be missing. Returns nullish-safe object with
 * empty-string defaults so callers can render without optional-chaining
 * everywhere.
 *
 * Exported for testability.
 */
export function parseChronicleErrorBody(body) {
  if (!body || typeof body !== 'object') {
    return { code: '', message: '', category: '' };
  }
  return {
    code:     typeof body.error    === 'string' ? body.error    : '',
    message:  typeof body.message  === 'string' ? body.message  : '',
    category: typeof body.category === 'string' ? body.category : '',
  };
}

/**
 * Passive manifest health probe. Fetches the install-time URL Foundry
 * stored for this module and classifies the result using the same
 * `parseChronicleErrorBody` + `categorize` path the "Check for updates"
 * button uses. Pure data return — does not touch `ui.notifications`,
 * does not render. Caller decides what to do with the result.
 *
 * Used by `surfaceManifestRecoveryIfNeeded()` on `ready` to detect a
 * stuck install (post-restart secret rotation, token-version bump, or
 * any other auth-category failure) and surface a recovery notification
 * to the GM. Designed so future callers (e.g. a periodic re-probe) can
 * reuse the same shape.
 *
 * Outcome shape:
 *   { ok: false, state: 'no_url' }                               — Foundry has no install URL
 *   { ok: true,  state: 'ok', httpStatus, url }                  — 200 reachable
 *   { ok: false, state: <category>, httpStatus, url, code,
 *     message, body? }                                           — Chronicle (or HTTP-fallback) error
 *   { ok: false, state: 'network', url, error }                  — fetch threw
 *   { ok: false, state: 'parse',   url, httpStatus, error }      — body not JSON / unreadable
 *
 * `state` values mirror `categorize()`'s output (`auth | config |
 * not_found | validation | internal`) plus the Foundry-only buckets
 * (`network`, `parse`) and the precondition state `no_url`. Callers
 * branch on `state` for routing, render `message` verbatim.
 *
 * @returns {Promise<object>} Outcome object — see shape above.
 */
export async function probeManifest() {
  const url = readInstallManifestUrl();
  if (!url) return { ok: false, state: 'no_url' };

  let response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    return { ok: false, state: 'network', url, error: err?.message || String(err) };
  }

  if (response.ok) {
    return { ok: true, state: 'ok', httpStatus: response.status, url };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON or empty body — body stays null; classification falls
    // through to HTTP-status only.
  }
  const parsed = parseChronicleErrorBody(body);
  const category = categorize({
    httpStatus: response.status,
    chronicleCategory: parsed.category,
  });

  return {
    ok:         false,
    state:      category,
    httpStatus: response.status,
    url,
    code:       parsed.code,
    message:    parsed.message,
    body,
  };
}

/**
 * Startup recovery hook. Probes the install-time manifest URL and, on an
 * `auth`-category failure, surfaces a sticky `ui.notifications.error`
 * with Chronicle's `body.message` (or a localized fallback) so the GM
 * sees a clear recovery prompt in the Foundry UI instead of having to
 * open DevTools.
 *
 * GM-only — players can't reinstall a module, so the banner would be
 * unactionable noise. Callers should gate on `game.user.isGM`.
 *
 * One-shot per session. Fire-and-forget from the `ready` hook; failures
 * inside this function never propagate. Non-`auth` failures (network,
 * parse, server, etc.) intentionally do NOT surface here — the "Check
 * for updates" dialog covers diagnostic cases that aren't actionable as
 * "reinstall from a fresh URL".
 *
 * Resolves the Foundry-side companion to cordinator Issue #17
 * (`FM-UPDATER-RECOVERY-UX`).
 *
 * @returns {Promise<void>}
 */
export async function surfaceManifestRecoveryIfNeeded() {
  let result;
  try {
    result = await probeManifest();
  } catch (err) {
    // probeManifest itself catches network errors; an exception here is
    // an unexpected bug in the probe path. Log, don't crash startup.
    console.warn('Chronicle Sync | Manifest probe failed unexpectedly', err);
    return;
  }
  if (result.state !== 'auth') return;

  const fallback = game.i18n.localize('CHRONICLE.Recovery.AuthFailure.Message');
  const prefix   = game.i18n.localize('CHRONICLE.Recovery.AuthFailure.Prefix');
  const detail   = result.message && result.message.trim() ? result.message : fallback;
  const text     = `${prefix} ${detail}`;

  // Sticky banner so the GM can't miss it between sessions.
  ui.notifications.error(text, { permanent: true, console: false });
  // Mirror to the console for support / log-scraping operators. Reusing
  // the existing structured log path from PR #40's error log would be
  // overkill for a one-shot startup notice.
  console.warn('Chronicle Sync | Manifest auth failure on startup:', {
    httpStatus: result.httpStatus,
    code:       result.code,
    url:        result.url,
  });
}

/**
 * Build a client-side 4-clause result for failures Chronicle didn't
 * classify — network errors, JSON parse failures, the precondition
 * "no install URL" case, and HTTP errors whose body wasn't JSON.
 */
function buildClientFallbackResult({ state, i18nPrefix, formatArgs = {} }) {
  return {
    state,
    iconClass: CATEGORY_ICONS[state] || 'fa-circle-exclamation',
    tried:    game.i18n.format(`CHRONICLE.UpdateInfo.Errors.${i18nPrefix}.Tried`,    formatArgs),
    happened: game.i18n.format(`CHRONICLE.UpdateInfo.Errors.${i18nPrefix}.Happened`, formatArgs),
    cause:    game.i18n.format(`CHRONICLE.UpdateInfo.Errors.${i18nPrefix}.Cause`,    formatArgs),
    action:   game.i18n.format(`CHRONICLE.UpdateInfo.Errors.${i18nPrefix}.Action`,   formatArgs),
  };
}

/**
 * Compare two semver-ish version strings ("0.1.5", "1.2.10").
 * Returns -1, 0, or 1. Non-numeric segments compare lexicographically.
 * Defensive: avoids the npm `semver` dep so we don't grow module weight.
 */
function compareVersions(a, b) {
  if (a === b) return 0;
  const pa = String(a || '').split('.');
  const pb = String(b || '').split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? '0';
    const bv = pb[i] ?? '0';
    const an = Number(av);
    const bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) return an < bn ? -1 : 1;
    } else {
      if (av !== bv) return av < bv ? -1 : 1;
    }
  }
  return 0;
}

export class UpdateInfoApplication extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: 'chronicle-update-info',
    classes: ['chronicle-update-info'],
    tag: 'div',
    window: {
      title: 'CHRONICLE.UpdateInfo.Title',
      resizable: false,
      contentClasses: ['chronicle-update-info-content'],
    },
    position: { width: 520 },
    actions: {
      'check-for-updates': UpdateInfoApplication.#onCheck,
      'copy-url':          UpdateInfoApplication.#onCopyUrl,
    },
  };

  static PARTS = {
    body: {
      template: 'modules/chronicle-sync/templates/update-info.hbs',
    },
  };

  constructor(options = {}) {
    super(options);
    /**
     * Last check result. Three possible shapes by `state`:
     *
     * Success (`up-to-date`, `update-available`):
     *   { state, message, installed, latest }
     *
     * Chronicle-classified error (`auth`, `config`, `not_found`,
     * `validation`, `internal`):
     *   { state, iconClass, code, message, raw }
     *   — `message` is rendered as-is from Chronicle (server is the
     *     source of truth for cause + action wording).
     *
     * Foundry-built fallback (`network`, `parse`, plus the NoUrl
     * precondition):
     *   { state, iconClass, tried, happened, cause, action }
     */
    this._checkResult = null;
    this._checking = false;
  }

  /** @override */
  async _prepareContext(_options = {}) {
    const mod = game.modules.get(MODULE_ID);
    const url = readInstallManifestUrl();
    const source = classifyManifestSource(url);
    return {
      url,
      hasUrl: !!url,
      source,
      isChronicle: source === 'chronicle',
      isGithub:    source === 'github',
      isUnknown:   source === 'unknown',
      installedVersion: mod?.version || '?',
      checking: this._checking,
      result: this._checkResult,
    };
  }

  /**
   * "Check Chronicle for updates" button. Fetches the install-time
   * manifest URL directly so the operator can confirm reachability
   * independent of Foundry's native update-check UX.
   */
  static async #onCheck(_event, _target) {
    if (this._checking) return;

    const url = readInstallManifestUrl();
    if (!url) {
      // Precondition failure — Foundry has no install-time URL recorded.
      // Categorized as `not_found` so the styling lines up (something
      // expected to exist is missing); 4-clause is client-built.
      this._checkResult = buildClientFallbackResult({
        state: 'not_found',
        i18nPrefix: 'NoUrl',
      });
      // Override the icon — NoUrl is precondition, not a Chronicle lookup miss.
      this._checkResult.iconClass = 'fa-link-slash';
      this.render(false);
      return;
    }

    this._checking = true;
    this._checkResult = null;
    this.render(false);

    // Phase 1 — fetch. A throw here means we never reached Chronicle.
    let response;
    try {
      response = await fetch(url, { cache: 'no-store' });
    } catch (err) {
      this._checking = false;
      this._checkResult = buildClientFallbackResult({
        state: 'network',
        i18nPrefix: 'Network',
        formatArgs: { url, error: err?.message || String(err) },
      });
      this.render(false);
      return;
    }

    // Phase 2 — error status. Try to parse the body as JSON; if it
    // parses and looks like Chronicle's structured error, use
    // Chronicle's server-side category + message verbatim. Otherwise
    // build a client-side 4-clause from the HTTP status.
    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        // Non-JSON or empty body — body stays null.
      }
      const parsed = parseChronicleErrorBody(body);
      const category = categorize({
        httpStatus: response.status,
        chronicleCategory: parsed.category,
      });

      this._checking = false;
      if (parsed.message) {
        // Chronicle gave us a server-classified, human-actionable
        // message — render it directly.
        this._checkResult = {
          state: category,
          iconClass: CATEGORY_ICONS[category] || 'fa-circle-exclamation',
          code: parsed.code,
          message: parsed.message,
          raw: body,
        };
      } else {
        // Non-Chronicle HTTP error (proxy, CDN, unexpected). Build a
        // 4-clause fallback so the operator still gets context.
        this._checkResult = buildClientFallbackResult({
          state: category,
          i18nPrefix: 'HttpFallback',
          formatArgs: {
            url,
            status: response.status,
            statusText: response.statusText || game.i18n.localize('CHRONICLE.UpdateInfo.Errors.NoStatusText'),
          },
        });
      }
      this.render(false);
      return;
    }

    // Phase 3 — parse the OK body.
    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      this._checking = false;
      this._checkResult = buildClientFallbackResult({
        state: 'parse',
        i18nPrefix: 'Parse',
        formatArgs: { url, error: err?.message || String(err) },
      });
      this.render(false);
      return;
    }

    // Phase 4 — extract the version field. Missing version on an
    // otherwise-OK response is a server-side malformation; render via
    // the `parse` fallback (same hue + icon since the response is
    // unreadable as a module manifest).
    const installed = game.modules.get(MODULE_ID)?.version || '0.0.0';
    const latest = payload?.version || '';
    if (!latest) {
      this._checking = false;
      this._checkResult = buildClientFallbackResult({
        state: 'parse',
        i18nPrefix: 'Parse',
        formatArgs: { url, error: game.i18n.format('CHRONICLE.UpdateInfo.Errors.Parse.MissingFieldError', { field: 'version' }) },
      });
      this.render(false);
      return;
    }

    // Phase 5 — compare and report success.
    const cmp = compareVersions(latest, installed);
    this._checking = false;
    this._checkResult = {
      state: cmp > 0 ? 'update-available' : 'up-to-date',
      installed,
      latest,
      message: cmp > 0
        ? game.i18n.format('CHRONICLE.UpdateInfo.UpdateAvailable', { installed, latest })
        : game.i18n.format('CHRONICLE.UpdateInfo.UpToDate', { installed }),
    };
    this.render(false);
  }

  static async #onCopyUrl(_event, _target) {
    const url = readInstallManifestUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      ui.notifications.info(game.i18n.localize('CHRONICLE.UpdateInfo.UrlCopied'));
    } catch (err) {
      ui.notifications.warn(game.i18n.localize('CHRONICLE.UpdateInfo.CopyFailed'));
    }
  }
}
