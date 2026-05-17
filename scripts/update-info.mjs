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
 * On a failed check, this dialog renders a 4-clause diagnostic
 * (what we tried / what happened / likely cause / what to do) with
 * a category-driven color scheme. The category is derived from the
 * Chronicle error code in the response body (preferred) or the HTTP
 * status (fallback). See `CODE_TO_CATEGORY` and `categorize()`.
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
 * Read the install-time manifest URL Foundry stored for this module.
 * v13+ exposes it as `module.manifest`; v12 nested it under `module.data`.
 * @returns {string} The manifest URL, or empty string if not available.
 */
function _readInstallManifestUrl() {
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
 * Map of Chronicle error codes (returned in the manifest endpoint's JSON
 * error body) to FM-CSU-DIAG error categories. Endpoint contract per
 * FM-CONSOLIDATE-R1 + the C-FMC-5b/C-FMC-8 work is:
 *   { error: <code>, message: <human-readable>, category: <bucket> }
 *
 * Unrecognized codes fall back to HTTP-status-based categorization in
 * `categorize()` below. Extend this map as Chronicle's API evolves.
 */
const CODE_TO_CATEGORY = {
  token_invalid:        'auth-error',
  token_expired:        'auth-error',
  campaign_not_found:   'not-found',
  version_unpinned:     'not-found',
  version_unknown:      'not-found',
  no_version_available: 'not-found',
};

/**
 * Categorize a failed manifest fetch into one of the diagnostic buckets the
 * template + CSS branches on. Prefers the Chronicle error code (more
 * specific than the HTTP status) and falls back to HTTP status.
 *
 * Buckets: `auth-error` | `not-found` | `conflict` | `network` | `parse` |
 * `server`. Success buckets (`up-to-date`, `update-available`) are produced
 * separately, not by this function.
 */
function categorize({ httpStatus, code }) {
  if (code && CODE_TO_CATEGORY[code]) return CODE_TO_CATEGORY[code];
  if (httpStatus === 401 || httpStatus === 403) return 'auth-error';
  if (httpStatus === 404) return 'not-found';
  if (httpStatus === 409) return 'conflict';
  if (httpStatus >= 500 && httpStatus < 600) return 'server';
  return 'server';
}

/**
 * FontAwesome icon class per error category. Injected into the result
 * object so the template renders the icon without a custom helper.
 */
const CATEGORY_ICONS = {
  'auth-error': 'fa-key',
  'not-found':  'fa-magnifying-glass',
  'conflict':   'fa-code-branch',
  'network':    'fa-plug-circle-xmark',
  'parse':      'fa-file-circle-question',
  'server':     'fa-server',
};

/**
 * Map a category to its i18n key prefix (PascalCase variant of the kebab
 * category name) so `buildErrorResult` can look up Cause/Action strings.
 */
const CATEGORY_I18N_KEY = {
  'auth-error': 'AuthError',
  'not-found':  'NotFound',
  'conflict':   'Conflict',
  'network':    'Network',
  'parse':      'Parse',
  'server':     'Server',
};

/**
 * Build the 4-clause result object the template renders: what was tried,
 * what happened, the likely cause, and the actionable next step. Each
 * clause is a separate field so the template can render them on their own
 * lines and the CSS can style them independently.
 */
function buildErrorResult({
  category,
  url,
  httpStatus,
  chronicleMessage,
  networkError,
  parseError,
  missingField,
}) {
  let happened;
  if (networkError) {
    happened = game.i18n.format('CHRONICLE.UpdateInfo.Errors.Happened.Network', { error: networkError });
  } else if (parseError) {
    happened = game.i18n.format('CHRONICLE.UpdateInfo.Errors.Happened.Parse', { error: parseError });
  } else if (missingField) {
    happened = game.i18n.format('CHRONICLE.UpdateInfo.Errors.Happened.MissingField', { field: missingField });
  } else {
    happened = game.i18n.format('CHRONICLE.UpdateInfo.Errors.Happened.Http', {
      status: httpStatus,
      chronicleMessage: chronicleMessage || game.i18n.localize('CHRONICLE.UpdateInfo.Errors.NoMessage'),
    });
  }

  const ck = CATEGORY_I18N_KEY[category] || 'Server';
  return {
    state: category,
    iconClass: CATEGORY_ICONS[category] || 'fa-circle-exclamation',
    tried:    game.i18n.format('CHRONICLE.UpdateInfo.Errors.Tried', { url }),
    happened,
    cause:    game.i18n.localize(`CHRONICLE.UpdateInfo.Errors.${ck}.Cause`),
    action:   game.i18n.localize(`CHRONICLE.UpdateInfo.Errors.${ck}.Action`),
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
     * Last check result. Success shape:
     *   { state: 'up-to-date'|'update-available', message, installed, latest }
     * Error shape:
     *   { state: <category>, iconClass, tried, happened, cause, action, raw? }
     * `raw` (when present) is the parsed JSON error body for future "Show
     * raw response" UI.
     */
    this._checkResult = null;
    this._checking = false;
  }

  /** @override */
  async _prepareContext(_options = {}) {
    const mod = game.modules.get(MODULE_ID);
    const url = _readInstallManifestUrl();
    const source = classifyManifestSource(url);
    return {
      url,
      hasUrl: !!url,
      source,                       // 'chronicle' | 'github' | 'unknown'
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
   * independent of Foundry's native update-check UX. On failure,
   * renders a 4-clause diagnostic with category-driven coloring; on
   * success, a single-line "up to date" or "update available" message.
   */
  static async #onCheck(_event, _target) {
    if (this._checking) return;

    const url = _readInstallManifestUrl();
    if (!url) {
      // Precondition failure — Foundry has no install-time URL recorded
      // at all. Rendered as a 4-clause result for consistency with the
      // other diagnostic paths, but the category here is `not-found`
      // since the missing thing is the URL, not Chronicle's response.
      this._checkResult = {
        state: 'not-found',
        iconClass: 'fa-link-slash',
        tried:    game.i18n.localize('CHRONICLE.UpdateInfo.Errors.NoUrl.Tried'),
        happened: game.i18n.localize('CHRONICLE.UpdateInfo.Errors.NoUrl.Happened'),
        cause:    game.i18n.localize('CHRONICLE.UpdateInfo.Errors.NoUrl.Cause'),
        action:   game.i18n.localize('CHRONICLE.UpdateInfo.Errors.NoUrl.Action'),
      };
      this.render(false);
      return;
    }

    this._checking = true;
    this._checkResult = null;
    this.render(false);

    // Phase 1 — fetch. A throw here means we never reached Chronicle
    // (DNS, TLS, CORS, firewall, etc.).
    let response;
    try {
      response = await fetch(url, { cache: 'no-store' });
    } catch (err) {
      this._checking = false;
      this._checkResult = buildErrorResult({
        category: 'network',
        url,
        networkError: err?.message || String(err),
      });
      this.render(false);
      return;
    }

    // Phase 2 — HTTP status check + structured-error parse. We try to
    // read the response body as JSON regardless of status; on an error
    // status, Chronicle ships a structured body with `error` (code) and
    // `message` (human-readable). We prefer the code for categorization
    // (more specific than the status), with the status as fallback.
    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        // Non-JSON or empty body — categorize by HTTP status alone.
      }
      const code = body?.code || body?.error || '';
      const chronicleMessage =
        body?.message ||
        (typeof body?.error === 'string' ? body.error : '') ||
        response.statusText ||
        '';
      const category = categorize({ httpStatus: response.status, code });

      this._checking = false;
      this._checkResult = buildErrorResult({
        category,
        url,
        httpStatus: response.status,
        chronicleMessage,
      });
      // Stash the raw body for a future "Show raw response" expandable.
      // Not rendered in this PR but kept on the result object so the
      // operator can inspect via `chronicle-sync.lastUpdateCheck` if
      // diagnosing deeper.
      if (body !== null) this._checkResult.raw = body;
      this.render(false);
      return;
    }

    // Phase 3 — parse the OK body.
    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      this._checking = false;
      this._checkResult = buildErrorResult({
        category: 'parse',
        url,
        parseError: err?.message || String(err),
      });
      this.render(false);
      return;
    }

    // Phase 4 — extract the version field. Missing version on an
    // otherwise-OK response is a server-side malformation; surface it
    // through the `parse` category since the response is unreadable as
    // a module manifest.
    const installed = game.modules.get(MODULE_ID)?.version || '0.0.0';
    const latest = payload?.version || '';
    if (!latest) {
      this._checking = false;
      this._checkResult = buildErrorResult({
        category: 'parse',
        url,
        missingField: 'version',
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
    const url = _readInstallManifestUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      ui.notifications.info(game.i18n.localize('CHRONICLE.UpdateInfo.UrlCopied'));
    } catch (err) {
      ui.notifications.warn(game.i18n.localize('CHRONICLE.UpdateInfo.CopyFailed'));
    }
  }
}
