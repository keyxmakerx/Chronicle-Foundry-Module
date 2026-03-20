# Implementation Plan: Map Journal Pages, Conflict Resolution, Folders & Multi-Page Journals

## Overview

Six interconnected workstreams addressing map sync migration, conflict resolution,
folder organization, multi-page journal structure, and GM/Scribe notes.

---

## 1. Map Sync → Journal Map Pages (migrate from Scene-based)

**Problem**: Current `map-sync.mjs` syncs Chronicle maps to Foundry Scenes. The
`map-collab-tool` project already solved interactive map journal pages with
collaborative pin placement. We need to merge that approach.

**Approach**: Integrate the map-collab-tool's `JournalPageSheet` approach into
this module so Chronicle maps become Journal Entry pages (type "image" with
interactive pins/drawings overlay) rather than Scene objects.

### Steps

1. **Port core files from map-collab-tool into this module**:
   - `map-page-sheet.mjs` → `scripts/map-page-sheet.mjs` (the interactive viewer)
   - `pin-config.mjs` → `scripts/pin-config.mjs` (pin editing dialogs)
   - `socket-manager.mjs` → merge into existing `api-client.mjs` or keep as
     `scripts/map-socket.mjs` (refactored to use Chronicle WS instead of
     Foundry sockets)
   - Templates and styles from map-collab-tool → merge into our templates/styles

2. **Register the custom JournalEntryPage sheet** in `module.mjs`:
   - Register `MapPageSheet` as a sheet for image-type journal pages
   - Chronicle map entities create JournalEntries with an "image" page using the
     Chronicle map's background image

3. **Refactor `map-sync.mjs`**:
   - Remove Scene-based hooks (`createDrawing`, `updateDrawing` on Scene, etc.)
   - Chronicle maps now create/update **JournalEntry** documents with:
     - Page 1: Map image (the map background)
     - Pins/annotations stored as flags on the journal page (not Scene drawings)
   - Drawing/token/fog data stored in `flags['chronicle-sync'].mapData` on the
     journal page rather than as Scene embedded documents
   - Keep the coordinate conversion helpers (percentage ↔ pixel)

4. **Pin ↔ Chronicle Drawing/Token mapping**:
   - Map-collab-tool pins (Location, Danger, Treasure, Quest, Note) map to
     Chronicle drawing types or token markers
   - Pin create/move/delete → push to Chronicle API (`/maps/:id/drawings`)
   - Chronicle `drawing.created/updated/deleted` WS events → update pins on the
     journal map page in real-time

5. **Fog of war as journal page overlay** (stretch):
   - Fog regions rendered as canvas overlay on the map page sheet instead of
     Scene drawings
   - GM can toggle fog visibility per-region

6. **Migration path**:
   - Existing Scene-linked maps: provide a dashboard action "Migrate to Journal
     Map" that creates a JournalEntry from the linked Scene data
   - Keep Scene-based sync as deprecated fallback for one version cycle

### API Changes Needed (Chronicle website)
- **Possibly none** — existing `/maps/:id/drawings` and `/maps/:id/tokens`
  endpoints should work. The pin types from map-collab-tool can map to Chronicle
  drawing types.
- If Chronicle doesn't have a "pin" concept distinct from "drawing", we may want
  a `drawing_type: 'pin'` with a `pin_category` field. **Let me know if this
  needs API changes.**

---

## 2. Conflict Resolution & Merge Support

**Problem**: The `conflictResolution` setting exists ("chronicle", "foundry",
"newest") but is never read by any sync module. Current behavior is last-write-wins
with no comparison or notification.

### Steps

1. **Add `updated_at` tracking to sync flags**:
   - When syncing from Chronicle, store `chronicle-sync.remoteUpdatedAt` =
     entity's `updated_at` timestamp
   - When syncing from Foundry, store `chronicle-sync.localUpdatedAt` =
     `Date.now()` ISO string
   - On each Foundry hook change (while GM is connected), set a
     `chronicle-sync.dirty` flag = `true`

2. **Create `scripts/conflict-resolver.mjs`**:
   ```
   class ConflictResolver {
     // Compare local vs remote timestamps + dirty flags
     // Returns: 'apply_remote', 'keep_local', 'conflict'
     resolve(journal, remoteEntity, strategy) { ... }

     // For 'newest' strategy: compare remoteEntity.updated_at vs
     // journal flag localUpdatedAt
     // For 'chronicle'/'foundry': return the configured winner
     // For 'conflict' result: queue for GM notification
   }
   ```

3. **Wire into JournalSync._onEntityUpdated()**:
   - Before overwriting, call `ConflictResolver.resolve()`
   - If result is `'keep_local'` → skip the remote update, optionally push
     local to Chronicle
   - If result is `'conflict'` → queue a notification, don't auto-resolve
   - If result is `'apply_remote'` → proceed as now

4. **Wire into JournalSync._handleUpdateJournal()**:
   - Before pushing to Chronicle, check if the remote has been updated since our
     last sync (`remoteUpdatedAt`)
   - If remote is newer and strategy isn't "foundry wins" → conflict

5. **GM Notification System** (`scripts/sync-notifications.mjs`):
   - Persistent notification area (sidebar widget or dashboard tab section)
   - Shows: "Entity X was updated on Chronicle while you were offline.
     [Apply Remote] [Keep Local] [View Diff]"
   - "View Diff" opens a simple side-by-side HTML diff of the content
   - Notifications persist until resolved (stored in a world setting or flags)
   - Batch notification on initial sync: "12 entities were updated while offline.
     [Review Changes]"

6. **Offline change detection**:
   - On each Foundry document change (while connected), mark the journal's
     `dirty` flag = true and `localUpdatedAt` = now
   - On initial sync reconnect, for each mapping:
     - Fetch the remote entity's `updated_at`
     - Check if local journal has `dirty` flag
     - If both sides changed → conflict notification
     - If only remote changed → apply per strategy
     - If only local changed → push per strategy

7. **Apply to all sync modules** (not just journals):
   - ActorSync, CalendarSync, MapSync all get the same conflict check

### API Changes Needed (Chronicle website)
- **`updated_at` on entity responses**: The `/entities/:id` response likely
  already includes `updated_at`. If not, it needs to be added.
- **Conditional update endpoint** (nice-to-have): `PUT /entities/:id` with
  `If-Unmodified-Since` header or `expected_version` field to prevent silent
  overwrites. This would let the module do optimistic concurrency. **Check if
  this exists or needs adding.**

---

## 3. Category → Folder Mapping

**Problem**: Chronicle entities have categories (entity types). Foundry has a
Folder system for JournalEntries. Currently, all synced journals land in the
root with no folder organization.

### Steps

1. **Fetch categories from Chronicle API**:
   - On initial sync, call `GET /entity-types` (or equivalent) to get the list
     of entity type categories
   - Each category has: `id`, `name`, possibly `parent_id` for nested categories

2. **Create/sync Foundry Folders**:
   - For each Chronicle category, create a Foundry `Folder` (type "JournalEntry")
     with a matching name
   - Store `chronicle-sync.categoryId` flag on each Folder
   - Nested categories → nested Folders (Foundry supports folder nesting)
   - On category rename in Chronicle → rename Folder in Foundry

3. **Assign journals to folders on create/update**:
   - In `JournalSync._createJournalFromEntity()`: look up the entity's
     `entity_type_id` or `type_name`, find the matching Folder, set
     `folder: folderId` on the journal data
   - In `JournalSync._onEntityUpdated()`: if entity type changed, move journal
     to the new folder

4. **Foundry → Chronicle folder assignment**:
   - When a journal is moved between folders in Foundry, detect via
     `updateJournalEntry` hook (check for `folder` in `change`), and update
     the entity's `entity_type_id` in Chronicle

5. **Create a folder manager utility** (`scripts/folder-manager.mjs`):
   ```
   class FolderManager {
     async syncFolders(api)           // Pull categories, create/update folders
     getFolderForCategory(categoryId) // Lookup
     getCategoryForFolder(folderId)   // Reverse lookup
   }
   ```

### API Changes Needed (Chronicle website)
- **`GET /entity-types`** (or `/categories`): Need endpoint that returns the
  category tree with `id`, `name`, `parent_id`. **Confirm this exists.**
- **Category change events via WS**: `category.created`, `category.updated`,
  `category.deleted` messages so folders stay in sync real-time. **May need
  adding.**

---

## 4. Multi-Page Journal Entries (Character Info + Player Notes)

**Problem**: Current journal sync splits Chronicle `entry_html` by headings into
pages. But Chronicle entities have structured content — character info fields,
an `entry_html` body, and potentially player-facing notes. These should map to
distinct Foundry journal pages.

### Steps

1. **Page structure for synced entities**:
   - **Page 1: "Overview"** — Entity image (if exists) + basic info summary
     (type, tags, custom fields rendered as a table)
   - **Page 2: "Content"** — The `entry_html` body (or split by headings as now)
   - **Page 3: "Player Notes"** — Only created if the entity has a
     `player_notes` or `public_notes` field. This page gets
     `ownership.default = OBSERVER` so players can see it even if the main
     entry is GM-only
   - Additional pages for heading splits of the main content (as current logic)

2. **Modify `_createJournalFromEntity()`**:
   - Build pages array with the structured layout above
   - Tag each page with a `chronicle-sync.pageRole` flag: `'overview'`,
     `'content'`, `'player_notes'`
   - On update, match pages by role flag rather than by index position

3. **Modify `_syncPagesToJournal()`**:
   - Match existing pages by their `pageRole` flag
   - Update content in-place rather than positional index matching
   - Only create "Player Notes" page if the entity has player notes content
   - Remove "Player Notes" page if the field is emptied

4. **Foundry → Chronicle for player notes**:
   - When a player-notes page is edited in Foundry, push it to the entity's
     `player_notes` field (not the main `entry` field)
   - Detect which page was edited by checking the `pageRole` flag

5. **Real-time page updates**:
   - WS `entity.updated` events should include which fields changed. If only
     `player_notes` changed, only update that page (avoid unnecessary re-renders
     of the full journal)

### API Changes Needed (Chronicle website)
- **`player_notes` field on entities**: Confirm entities have a separate
  player-notes field (or equivalent like `public_description`). If not, this
  needs adding to the entity model.
- **Partial update events**: WS `entity.updated` ideally includes a
  `changed_fields` array so the module knows which page(s) to update. **Nice
  to have, not blocking.**

---

## 5. Real-Time Sync Emphasis

**Problem**: Current sync works but has no multiplayer awareness. Multiple users
editing the same entity on Chronicle website and in Foundry simultaneously need
live updates without polling.

### Steps

1. **Already handled by WebSocket** — the existing WS infrastructure routes
   `entity.updated` events in real-time. The main gaps are:
   - No debouncing of rapid edits (Foundry user typing → each keystroke fires
     `updateJournalEntry`)
   - No presence awareness ("User X is editing entity Y")

2. **Debounce Foundry → Chronicle pushes**:
   - Add a 2-second debounce timer per journal in `_handleUpdateJournal()`
   - Collect changes during the window, push the final state
   - Immediately push on tab close / page unload

3. **Presence indicators** (stretch goal):
   - If Chronicle WS supports presence events (`user.editing.start/stop`), show
     a small indicator on the journal entry header: "Being edited on Chronicle
     by [username]"
   - In Foundry's journal sidebar, show a colored dot on entries being edited
     remotely

### API Changes Needed (Chronicle website)
- **Debounce is client-side only** — no API changes needed
- **Presence events** (stretch): WS messages `user.editing.start` /
  `user.editing.stop` with `{ entity_id, user_name }`. **Only if you want
  this feature.**

---

## 6. GM/Scribe Note Sync

**Problem**: GMs and Scribes need a personal notes area that syncs between
Chronicle and Foundry. This is distinct from entity content — it's session notes,
GM prep, campaign plans, etc.

### Steps

1. **Identify the Chronicle concept**:
   - Does Chronicle have a "notes" or "journal" feature separate from entities?
     (Session notes, GM notes, campaign log?)
   - If yes → sync as a dedicated Foundry JournalEntry folder "Chronicle Notes"
   - If these are just entities with a specific type → handle via category/folder
     mapping (Step 3) with a "Notes" category

2. **Create `scripts/note-sync.mjs`**:
   - Similar pattern to JournalSync but scoped to note-type entities
   - Notes are GM-only by default (ownership NONE for non-GMs)
   - Scribe role: if a Foundry user is mapped to a Chronicle Scribe, they get
     OWNER on note journals

3. **Role mapping** (prerequisite):
   - Need a way to map Foundry user IDs to Chronicle user IDs
   - Settings: `userMapping` — JSON map of `{ foundryUserId: chronicleUserId }`
   - Dashboard tab or settings form to configure this mapping
   - Once mapped, Scribe permissions can flow properly

4. **WS events for notes**:
   - If notes are entities, already handled by `entity.created/updated/deleted`
   - If notes are a separate resource type, need new WS message types

### API Changes Needed (Chronicle website)
- **Clarify**: Are GM/Scribe notes entities with a special type, or a separate
  resource? This determines whether we reuse JournalSync or build NotesSync.
- **User ID mapping**: Need an endpoint to look up Chronicle users by some
  identifier (email, username) so we can build the mapping table. Something
  like `GET /users?search=...` or `GET /campaign-members`.

---

## Execution Order (Recommended)

1. **Category → Folder mapping** (Step 3) — foundational, relatively standalone
2. **Conflict resolution** (Step 2) — critical safety feature before more sync
3. **Multi-page journals** (Step 4) — builds on folder work, improves sync quality
4. **Map journal pages** (Step 1) — largest change, refactors map-sync entirely
5. **GM/Scribe notes** (Step 6) — depends on role mapping, may need API work
6. **Real-time enhancements** (Step 5) — polish layer on top of everything

## Questions Before Starting

1. Does Chronicle have a `player_notes` / `public_notes` field on entities?
2. Does the `/entity-types` endpoint exist and return parent/child relationships?
3. Are GM/Scribe notes stored as entities (with a type) or a separate resource?
4. Does `PUT /entities/:id` support conditional updates (versioning/etag)?
5. Should map pins from map-collab-tool map to Chronicle drawings, or do we
   need a new "pin" resource type on the API?
6. Is there a `GET /campaign-members` endpoint for user ID mapping?
