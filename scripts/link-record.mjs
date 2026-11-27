/**
 * Keeps the GM-only record of the Chronicle links sync made, and checks every
 * journal's and actor's link against it when a GM's sync starts (rules in
 * _link-record.mjs). The live hooks check link changes while a GM's sync
 * runs; this checks the links as they stand when it starts.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { touchesLinkFlags } from './_set-aside.mjs';
import { noticeText } from './_escape-html.mjs';
import { LINK_KINDS, linkOf, linkHash, readRecord, recordValue, unconfirmedLinks } from './_link-record.mjs';

/** The world setting that holds the record. */
export const LINK_RECORD_SETTING = 'linkRecord';

const DOCS = [['JournalEntry', 'journals'], ['Actor', 'actors']];
const FLUSH_MS = 200;
const NAMES_SHOWN = 10;

export default class LinkRecord {
  constructor() {
    /** Hashes to add and drop on the next save. */
    this._add = new Set();
    this._drop = new Set();
    /** A document's link just before this GM's own update changed it. */
    this._before = new Map();
    /** Hashing is async; saves wait for the hashes noted before them. */
    this._noted = Promise.resolve();
    this._timer = null;
    this._hooks = [];
    // A link noted just before the tab closes would otherwise miss the
    // record and be undone at the next start.
    this._onUnload = () => { this.flush(); };
  }

  /** Watch this GM's own writes, which are the only links the record takes. */
  start() {
    if (this._hooks.length) return;
    globalThis.window?.addEventListener?.('beforeunload', this._onUnload);
    for (const [doc, kind] of DOCS) {
      const keys = LINK_KINDS[kind];
      this._on(`preUpdate${doc}`, (d, change, _o, userId) => {
        if (this._mine(userId) && touchesLinkFlags(change, FLAG_SCOPE, keys)) this._before.set(d.uuid, linkOf(d, FLAG_SCOPE, kind));
      });
      // The new link is read from the update itself; the old one, which only
      // leaves the record, from the preUpdate hook when it ran.
      this._on(`update${doc}`, (d, change, _o, userId) => {
        if (!this._mine(userId) || !touchesLinkFlags(change, FLAG_SCOPE, keys)) return;
        const before = this._before.get(d.uuid) ?? null;
        this._before.delete(d.uuid);
        this._note(kind, d.id, before, linkOf(d, FLAG_SCOPE, kind));
      });
      this._on(`create${doc}`, (d, _o, userId) => {
        if (this._mine(userId)) this._note(kind, d.id, null, linkOf(d, FLAG_SCOPE, kind));
      });
      this._on(`delete${doc}`, (d, _o, userId) => {
        if (this._mine(userId)) this._note(kind, d.id, linkOf(d, FLAG_SCOPE, kind), null);
      });
    }
  }

  stop() {
    for (const [name, fn] of this._hooks) Hooks.off(name, fn);
    this._hooks = [];
    globalThis.window?.removeEventListener?.('beforeunload', this._onUnload);
    this.flush();
  }

  /** Save what was noted now, not after the debounce. */
  flush() {
    const pending = this._timer !== null;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (pending || this._add.size || this._drop.size) {
      this.save().catch((err) => console.warn('Chronicle: could not save the link record', err));
    }
  }

  _on(name, fn) {
    Hooks.on(name, fn);
    this._hooks.push([name, fn]);
  }

  /** Only a GM's own client records that GM's change: a player's never counts. */
  _mine(userId) {
    return userId === game.user?.id && game.user?.isGM === true;
  }

  _note(kind, id, before, after) {
    this._noted = this._noted.then(async () => {
      const was = before ? await linkHash(kind, id, before) : null;
      const now = after ? await linkHash(kind, id, after) : null;
      if (was === now) return;
      if (was) { this._drop.add(was); this._add.delete(was); }
      if (now) { this._add.add(now); this._drop.delete(now); }
    }).catch((err) => console.warn('Chronicle: could not note a link', err));
    if (!this._timer) this._timer = setTimeout(() => { this._timer = null; this.save(); }, FLUSH_MS);
  }

  /**
   * Save what was noted. Read the setting again first: another GM's client
   * saves its own GM's links to the same setting. Before the first check
   * there is no record, and the noted links wait for it.
   */
  async save() {
    await this._noted;
    const recorded = readRecord(game.settings.get(MODULE_ID, LINK_RECORD_SETTING));
    if (!recorded || (!this._add.size && !this._drop.size)) return;
    for (const h of this._drop) recorded.delete(h);
    for (const h of this._add) recorded.add(h);
    this._add.clear();
    this._drop.clear();
    await game.settings.set(MODULE_ID, LINK_RECORD_SETTING, recordValue(recorded));
  }

  /**
   * When sync starts, undo every link the record doesn't hold, warn the GM
   * which, and save the record as the links that stand. The first time, with
   * no record yet, the links as they are become it. Every GM client running
   * sync checks, since each pulls through the links it finds and the active
   * GM's client may not be running sync; a second check finds nothing to undo.
   * Local only, so it finishes before sync reads or sends anything.
   * @param {(kind: string, doc: object) => Promise<void>} unlink
   * @returns {Promise<object[]>} the documents whose link was undone
   */
  async checkLinks(unlink) {
    if (game.user?.isGM !== true) return [];
    await this._noted;

    const docs = [];
    for (const [coll, kind] of [[game.journal, 'journals'], [game.actors, 'actors']]) {
      for (const doc of coll?.contents ?? []) {
        const link = linkOf(doc, FLAG_SCOPE, kind);
        if (link) docs.push({ kind, id: doc.id, name: doc.name, doc, link, hash: await linkHash(kind, doc.id, link) });
      }
    }

    const recorded = readRecord(game.settings.get(MODULE_ID, LINK_RECORD_SETTING));
    const undone = recorded ? unconfirmedLinks(docs, recorded) : [];
    for (const d of undone) await unlink(d.kind, d.doc);

    // Saved only when it changes, so a start with nothing new writes nothing.
    const standing = recordValue(docs.filter((d) => !undone.includes(d)).map((d) => d.hash));
    if (!recorded || JSON.stringify(recordValue(recorded)) !== JSON.stringify(standing)) {
      await game.settings.set(MODULE_ID, LINK_RECORD_SETTING, standing);
    }
    if (this._add.size || this._drop.size) await this.save();

    if (undone.length) {
      const names = undone.slice(0, NAMES_SHOWN).map((d) => noticeText(d.name)).join(', ');
      const more = undone.length > NAMES_SHOWN ? ` (+${undone.length - NAMES_SHOWN})` : '';
      // Each name went through noticeText above.
      const notice = game.i18n.format('CHRONICLE.Notifications.LinksUndoneOnConnect', { count: undone.length, names: names + more });
      ui.notifications?.warn?.(notice, { permanent: true });
    }
    return undone;
  }
}
