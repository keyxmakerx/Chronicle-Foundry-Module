/**
 * Chronicle Sync - the campaign's dice pick, for "Sync with Chronicle" in
 * Dice So Nice. A SyncManager module, so it runs on the GM's client while
 * connected: it reads the pick and stores it in a world setting that every
 * client's Dice So Nice bridge follows. Only the active GM writes, and only
 * a change. Chronicle sends no event when the pick changes, so it is re-read
 * every few minutes.
 */

import { MODULE_ID } from './constants.mjs';
import { log } from './logger.mjs';
import { LOOK_SETTING } from './dice-so-nice.mjs';
import { lookFromSettings, readLook } from './_rune-dice.mjs';
import { isRouteMissing } from './_roll-relay.mjs';

const LOOK_REFRESH_MS = 5 * 60 * 1000;

export const diceLookSync = {
  _api: null,
  _timer: null,

  init(api) {
    this._api = api;
    this.refresh();
    if (this._timer === null) this._timer = setInterval(() => this.refresh(), LOOK_REFRESH_MS);
  },

  destroy() {
    if (this._timer !== null) clearInterval(this._timer);
    this._timer = null;
    this._api = null;
  },

  async refresh() {
    if (!this._api || !game.user?.isGM || !game.users?.activeGM?.isSelf) return;
    try {
      const look = lookFromSettings(await this._api.get('/rolls/settings'));
      const next = JSON.stringify(look);
      if (JSON.stringify(readLook(game.settings.get(MODULE_ID, LOOK_SETTING))) === next) return;
      await game.settings.set(MODULE_ID, LOOK_SETTING, next);
    } catch (err) {
      if (isRouteMissing(err)) {
        // An older Chronicle with no dice settings: stop asking, keep the log clean.
        this._api?.dropLastErrorLogEntry?.({ status: 404, path: '/rolls/settings' });
        this.destroy();
        return;
      }
      log.debug('Dice So Nice: campaign dice pick not read', err);
    }
  },
};

