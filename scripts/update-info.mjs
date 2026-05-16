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
 * Wired into the module settings panel via `game.settings.registerMenu`
 * in `settings.mjs`.
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
    /** @type {null|{state: string, message: string, latest?: string, installed?: string, raw?: object}} */
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
   * independent of Foundry's native update-check UX.
   */
  static async #onCheck(_event, _target) {
    if (this._checking) return;

    const url = _readInstallManifestUrl();
    if (!url) {
      this._checkResult = {
        state: 'error',
        message: game.i18n.localize('CHRONICLE.UpdateInfo.NoUrl'),
      };
      this.render(false);
      return;
    }

    this._checking = true;
    this._checkResult = null;
    this.render(false);

    let response;
    try {
      response = await fetch(url, { cache: 'no-store' });
    } catch (err) {
      this._checking = false;
      this._checkResult = {
        state: 'error',
        message: game.i18n.format('CHRONICLE.UpdateInfo.NetworkError', {
          error: err?.message || String(err),
        }),
      };
      this.render(false);
      return;
    }

    if (!response.ok) {
      this._checking = false;
      this._checkResult = {
        state: 'error',
        message: game.i18n.format('CHRONICLE.UpdateInfo.HttpError', {
          status: response.status,
          statusText: response.statusText || '',
        }),
      };
      this.render(false);
      return;
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      this._checking = false;
      this._checkResult = {
        state: 'error',
        message: game.i18n.format('CHRONICLE.UpdateInfo.ParseError', {
          error: err?.message || String(err),
        }),
      };
      this.render(false);
      return;
    }

    const installed = game.modules.get(MODULE_ID)?.version || '0.0.0';
    const latest = payload?.version || '';
    if (!latest) {
      this._checking = false;
      this._checkResult = {
        state: 'error',
        message: game.i18n.localize('CHRONICLE.UpdateInfo.MissingVersion'),
      };
      this.render(false);
      return;
    }

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
