/**
 * Chronicle Sync - Notes Sync
 *
 * Bidirectional sync between Chronicle Notes and Foundry JournalEntries.
 * Chronicle Notes are a separate resource from entities — they map to
 * JournalEntries in a dedicated "Chronicle Notes" folder tree.
 *
 * Sync flow:
 * - Chronicle → Foundry: Note changes arrive via WebSocket, create/update JournalEntry.
 * - Foundry → Chronicle: JournalEntry changes detected via Hooks, push to Chronicle API.
 *
 * Note: Chronicle Notes API responses use camelCase keys, but requests use snake_case.
 * The api-client.mjs getNotes/postNote/putNote methods handle this conversion.
 */

import { getSetting } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';

/** Name of the root Foundry folder for Chronicle notes. */
const NOTES_FOLDER_NAME = 'Chronicle Notes';

/**
 * NoteSync handles Chronicle Note ↔ JournalEntry synchronization.
 */
export class NoteSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;

    /** @type {boolean} Suppress hook processing during sync-initiated changes. */
    this._syncing = false;

    /** @type {Folder|null} Cached root "Chronicle Notes" folder. */
    this._rootFolder = null;

    // Bound hook handlers for cleanup.
    this._onCreateJournal = this._handleCreateJournal.bind(this);
    this._onUpdateJournal = this._handleUpdateJournal.bind(this);
    this._onDeleteJournal = this._handleDeleteJournal.bind(this);
  }

  /**
   * Initialize the notes sync module.
   * @param {import('./api-client.mjs').ChronicleAPI} api
   */
  async init(api) {
    this._api = api;

    if (!getSetting('syncNotes')) return;

    Hooks.on('createJournalEntry', this._onCreateJournal);
    Hooks.on('updateJournalEntry', this._onUpdateJournal);
    Hooks.on('deleteJournalEntry', this._onDeleteJournal);

    console.debug('Chronicle: Notes sync initialized');
  }

  /**
   * Handle incoming WebSocket messages for note events.
   * @param {object} msg
   */
  async onMessage(msg) {
    if (!getSetting('syncNotes')) return;

    switch (msg.type) {
      case 'note.created':
        await this._onNoteCreated(msg.payload);
        break;
      case 'note.updated':
        await this._onNoteUpdated(msg.payload);
        break;
      case 'note.deleted':
        await this._onNoteDeleted(msg.payload);
        break;
    }
  }

  /**
   * Perform initial sync: pull all notes and reconcile.
   */
  async onInitialSync() {
    if (!getSetting('syncNotes')) return;

    try {
      const result = await this._api.getNotes('/notes');
      const notes = result?.data || result || [];
      if (!Array.isArray(notes)) return;

      // Ensure root folder exists.
      await this._getOrCreateRootFolder();

      // Create folder hierarchy first (notes with is_folder=true).
      const folders = notes.filter((n) => n.is_folder);
      for (const folder of folders) {
        await this._getOrCreateNoteFolder(folder);
      }

      // Then sync actual notes.
      const actualNotes = notes.filter((n) => !n.is_folder);
      for (const note of actualNotes) {
        const existing = game.journal.find(
          (j) => j.getFlag(FLAG_SCOPE, 'noteId') === note.id
        );
        if (existing) {
          await this._updateJournalFromNote(existing, note);
        } else {
          await this._createJournalFromNote(note);
        }
      }

      console.debug(`Chronicle: Notes initial sync complete (${notes.length} notes)`);
    } catch (err) {
      console.warn('Chronicle: Notes initial sync failed', err);
    }
  }

  /**
   * Clean up hooks on destroy.
   */
  destroy() {
    Hooks.off('createJournalEntry', this._onCreateJournal);
    Hooks.off('updateJournalEntry', this._onUpdateJournal);
    Hooks.off('deleteJournalEntry', this._onDeleteJournal);
  }

  // ---------------------------------------------------------------------------
  // Chronicle → Foundry
  // ---------------------------------------------------------------------------

  /**
   * Handle a new note from Chronicle.
   * @param {object} payload - Raw WS payload (camelCase keys).
   * @private
   */
  async _onNoteCreated(payload) {
    if (!payload?.id) return;

    // Normalize camelCase payload to snake_case.
    const note = this._normalizeNote(payload);

    // Skip folder-type notes (handle separately if needed).
    if (note.is_folder) return;

    const existing = game.journal.find(
      (j) => j.getFlag(FLAG_SCOPE, 'noteId') === note.id
    );
    if (existing) return;

    await this._createJournalFromNote(note);
  }

  /**
   * Handle an updated note from Chronicle.
   * @param {object} payload
   * @private
   */
  async _onNoteUpdated(payload) {
    if (!payload?.id) return;

    const note = this._normalizeNote(payload);

    const journal = game.journal.find(
      (j) => j.getFlag(FLAG_SCOPE, 'noteId') === note.id
    );
    if (!journal) {
      if (!note.is_folder) await this._createJournalFromNote(note);
      return;
    }

    await this._updateJournalFromNote(journal, note);
  }

  /**
   * Handle a deleted note from Chronicle.
   * @param {object} payload
   * @private
   */
  async _onNoteDeleted(payload) {
    const noteId = payload?.id || payload?.noteId;
    if (!noteId) return;

    const journal = game.journal.find(
      (j) => j.getFlag(FLAG_SCOPE, 'noteId') === noteId
    );
    if (!journal) return;

    this._syncing = true;
    try {
      await journal.delete();
      console.debug(`Chronicle: Deleted journal for note ${noteId}`);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Create a Foundry JournalEntry from a Chronicle note.
   * @param {object} note - Normalized note data (snake_case).
   * @private
   */
  async _createJournalFromNote(note) {
    this._syncing = true;
    try {
      const rootFolder = await this._getOrCreateRootFolder();
      const parentFolder = note.parent_id
        ? await this._findNoteFolder(note.parent_id)
        : null;

      const content = note.entry_html || '';

      // Build ownership from sharing settings.
      const ownership = this._buildNoteOwnership(note);

      const journalData = {
        name: note.title || 'Untitled Note',
        pages: [
          {
            name: note.title || 'Content',
            type: 'text',
            text: { content },
            sort: 0,
          },
        ],
        folder: parentFolder?.id || rootFolder?.id || null,
        ownership,
        flags: {
          [FLAG_SCOPE]: {
            noteId: note.id,
            isNote: true,
            lastSync: new Date().toISOString(),
          },
        },
      };

      const journal = await JournalEntry.create(journalData);
      console.debug(`Chronicle: Created journal "${note.title}" from note`);
      return journal;
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Update a Foundry JournalEntry from a Chronicle note.
   * @param {JournalEntry} journal
   * @param {object} note - Normalized note data (snake_case).
   * @private
   */
  async _updateJournalFromNote(journal, note) {
    this._syncing = true;
    try {
      // Update journal name.
      if (journal.name !== note.title) {
        await journal.update({ name: note.title });
      }

      // Update page content.
      const content = note.entry_html || '';
      const textPage = journal.pages.find((p) => p.type === 'text');
      if (textPage) {
        await textPage.update({ 'text.content': content });
      }

      // Update ownership.
      const ownership = this._buildNoteOwnership(note);
      await journal.update({ ownership });

      await journal.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString());

      console.debug(`Chronicle: Updated journal "${journal.name}" from note`);
    } finally {
      this._syncing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Foundry → Chronicle
  // ---------------------------------------------------------------------------

  /**
   * Handle Foundry JournalEntry creation — push to Chronicle as a note.
   * Only processes journals in the "Chronicle Notes" folder tree.
   * @param {JournalEntry} journal
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleCreateJournal(journal, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;

    // Only process journals that are flagged as notes or in the notes folder.
    if (!this._isNoteJournal(journal)) return;
    if (journal.getFlag(FLAG_SCOPE, 'noteId')) return;

    try {
      const content = this._collectJournalContent(journal);

      const noteBody = {
        title: journal.name,
        entry_html: content,
        content: [],
        is_shared: (journal.ownership?.default ?? 0) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
      };

      const result = await this._api.postNote('/notes', noteBody);

      if (result?.id) {
        this._syncing = true;
        try {
          await journal.setFlag(FLAG_SCOPE, 'noteId', result.id);
          await journal.setFlag(FLAG_SCOPE, 'isNote', true);
          await journal.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString());
        } finally {
          this._syncing = false;
        }
        console.debug(`Chronicle: Pushed new note "${journal.name}" to Chronicle`);
      }
    } catch (err) {
      console.error('Chronicle: Failed to push journal as note', err);
    }
  }

  /**
   * Handle Foundry JournalEntry update — push to Chronicle note.
   * @param {JournalEntry} journal
   * @param {object} change
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleUpdateJournal(journal, change, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;

    const noteId = journal.getFlag(FLAG_SCOPE, 'noteId');
    if (!noteId) return;

    try {
      const content = this._collectJournalContent(journal);

      const noteBody = {
        title: journal.name,
        entry_html: content,
        is_shared: (journal.ownership?.default ?? 0) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
      };

      await this._api.putNote(`/notes/${noteId}`, noteBody);

      this._syncing = true;
      try {
        await journal.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString());
      } finally {
        this._syncing = false;
      }

      console.debug(`Chronicle: Pushed note update "${journal.name}" to Chronicle`);
    } catch (err) {
      console.error('Chronicle: Failed to push note update', err);
    }
  }

  /**
   * Handle Foundry JournalEntry deletion — delete Chronicle note.
   * @param {JournalEntry} journal
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleDeleteJournal(journal, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;

    const noteId = journal.getFlag(FLAG_SCOPE, 'noteId');
    if (!noteId) return;

    try {
      await this._api.deleteNote(`/notes/${noteId}`);
      console.debug(`Chronicle: Deleted note ${noteId} from journal deletion`);
    } catch (err) {
      console.warn('Chronicle: Failed to delete note on Chronicle', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Normalize a raw WS payload (potentially camelCase) to snake_case keys.
   * WS payloads may already be camelCase since they come from the Note model.
   * @param {object} payload
   * @returns {object}
   * @private
   */
  _normalizeNote(payload) {
    // Handle both camelCase and snake_case keys.
    return {
      id: payload.id,
      campaign_id: payload.campaign_id || payload.campaignId,
      user_id: payload.user_id || payload.userId,
      entity_id: payload.entity_id || payload.entityId,
      parent_id: payload.parent_id || payload.parentId,
      is_folder: payload.is_folder ?? payload.isFolder ?? false,
      title: payload.title,
      content: payload.content || [],
      entry: payload.entry,
      entry_html: payload.entry_html || payload.entryHtml || '',
      color: payload.color,
      pinned: payload.pinned ?? false,
      is_shared: payload.is_shared ?? payload.isShared ?? false,
      shared_with: payload.shared_with || payload.sharedWith || [],
      created_at: payload.created_at || payload.createdAt,
      updated_at: payload.updated_at || payload.updatedAt,
    };
  }

  /**
   * Build Foundry ownership from note sharing settings.
   * @param {object} note
   * @returns {object}
   * @private
   */
  _buildNoteOwnership(note) {
    if (note.is_shared) {
      return { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER };
    }
    return { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE };
  }

  /**
   * Check if a journal belongs to the Chronicle Notes folder tree.
   * @param {JournalEntry} journal
   * @returns {boolean}
   * @private
   */
  _isNoteJournal(journal) {
    if (journal.getFlag(FLAG_SCOPE, 'isNote')) return true;

    // Walk up the folder tree looking for the root notes folder.
    let folder = journal.folder;
    while (folder) {
      if (folder.name === NOTES_FOLDER_NAME && folder.getFlag(FLAG_SCOPE, 'isNotesRoot')) {
        return true;
      }
      folder = folder.folder; // Parent folder.
    }
    return false;
  }

  /**
   * Collect text content from all journal pages as HTML.
   * @param {JournalEntry} journal
   * @returns {string}
   * @private
   */
  _collectJournalContent(journal) {
    const textPages = journal.pages
      .filter((p) => p.type === 'text')
      .sort((a, b) => a.sort - b.sort);

    if (textPages.length === 0) return '';
    if (textPages.length === 1) return textPages[0].text?.content || '';

    return textPages
      .map((p) => p.text?.content || '')
      .join('\n');
  }

  /**
   * Get or create the root "Chronicle Notes" folder.
   * @returns {Promise<Folder>}
   * @private
   */
  async _getOrCreateRootFolder() {
    if (this._rootFolder) return this._rootFolder;

    // Check for existing root folder.
    this._rootFolder = game.folders.find(
      (f) => f.type === 'JournalEntry'
        && f.name === NOTES_FOLDER_NAME
        && f.getFlag(FLAG_SCOPE, 'isNotesRoot')
    );
    if (this._rootFolder) return this._rootFolder;

    // Check by name only (in case flag is missing).
    this._rootFolder = game.folders.find(
      (f) => f.type === 'JournalEntry' && f.name === NOTES_FOLDER_NAME && !f.folder
    );
    if (this._rootFolder) {
      await this._rootFolder.setFlag(FLAG_SCOPE, 'isNotesRoot', true);
      return this._rootFolder;
    }

    // Create new root folder.
    this._rootFolder = await Folder.create({
      name: NOTES_FOLDER_NAME,
      type: 'JournalEntry',
      flags: { [FLAG_SCOPE]: { isNotesRoot: true } },
    });
    return this._rootFolder;
  }

  /**
   * Get or create a Foundry folder for a Chronicle note folder.
   * @param {object} noteFolder - Note data with is_folder=true.
   * @returns {Promise<Folder>}
   * @private
   */
  async _getOrCreateNoteFolder(noteFolder) {
    // Check for existing folder by note ID.
    let folder = game.folders.find(
      (f) => f.type === 'JournalEntry' && f.getFlag(FLAG_SCOPE, 'noteFolderId') === noteFolder.id
    );
    if (folder) return folder;

    const rootFolder = await this._getOrCreateRootFolder();
    const parentFolder = noteFolder.parent_id
      ? await this._findNoteFolder(noteFolder.parent_id)
      : null;

    folder = await Folder.create({
      name: noteFolder.title || 'Untitled Folder',
      type: 'JournalEntry',
      folder: parentFolder?.id || rootFolder?.id || null,
      color: noteFolder.color || null,
      flags: { [FLAG_SCOPE]: { noteFolderId: noteFolder.id } },
    });
    return folder;
  }

  /**
   * Find a Foundry folder mapped to a Chronicle note folder ID.
   * @param {string} noteFolderId
   * @returns {Folder|null}
   * @private
   */
  _findNoteFolder(noteFolderId) {
    return game.folders.find(
      (f) => f.type === 'JournalEntry' && f.getFlag(FLAG_SCOPE, 'noteFolderId') === noteFolderId
    ) || null;
  }
}
