# Foundry VTT Sync Module - E2E Testing Checklist

Manual testing checklist for the Chronicle-Foundry bidirectional sync module.
Requires a running Chronicle instance and Foundry VTT with the chronicle-sync module installed.

## Prerequisites

- [ ] Chronicle running with API key created for target campaign
- [ ] Foundry VTT world with chronicle-sync module enabled
- [ ] Module settings configured: API URL, API key, campaign ID
- [ ] Sync enabled in module settings

## Connection & Status

- [ ] Status indicator shows green dot when connected
- [ ] Status indicator shows yellow during reconnection
- [ ] Status indicator shows red when disconnected
- [ ] WebSocket auto-reconnects after network interruption (wait 30s)
- [ ] Message queue drains after reconnection

## Journal Sync (Entities)

### Chronicle -> Foundry
- [ ] Create entity in Chronicle -> JournalEntry appears in Foundry
- [ ] Update entity name -> JournalEntry name updates
- [ ] Update entity entry (rich text) -> JournalEntry pages update
- [ ] Toggle entity privacy -> JournalEntry ownership changes
- [ ] Delete entity -> JournalEntry removed

### Foundry -> Chronicle
- [ ] Create JournalEntry -> Entity appears in Chronicle
- [ ] Update JournalEntry name -> Entity name updates
- [ ] Edit JournalEntry page content -> Entity entry updates
- [ ] Delete JournalEntry -> Entity deleted in Chronicle

### Multi-Page Sync
- [ ] Entity with h1/h2 headings creates multiple Foundry journal pages
- [ ] Entity without headings creates single "Content" page
- [ ] Multi-page Foundry journal concatenates into single Chronicle entry
- [ ] Updating entity content adds/removes/updates pages correctly
- [ ] Page titles match heading text (HTML stripped)
- [ ] Pre-heading content creates "Overview" page

### Permission Sync
- [ ] Private entity (is_private=true) creates journal with default ownership NONE
- [ ] Public entity (is_private=false) creates journal with default ownership OBSERVER
- [ ] Custom visibility entity fetches permissions and maps role grants to ownership
- [ ] Custom visibility with player view grant → default OBSERVER
- [ ] Custom visibility with no player grant → default NONE
- [ ] Changing journal ownership in Foundry pushes is_private to Chronicle
- [ ] Changing journal ownership pushes visibility/permissions to Chronicle API
- [ ] **(FM-SYNC-HARDENING §3, fail-closed)** Permission API failure on a `custom`-visibility
      entity → ownership defaults to **NONE** (GM-only), even when `is_private=false`.
      It must NOT fall open to OBSERVER. To reproduce: stop Chronicle (or block the
      `/permissions` endpoint) while a custom-visibility entity syncs; confirm players
      cannot see it.

### Visibility Settings (Config tab → Permissions) — FM-SYNC-HARDENING §1
These controls were previously dead config (written but never read). Verify they now drive ownership:
- [ ] **dmOnlyHidden ON (default):** a DM-only / private Chronicle entity → players have NO
      access to the journal (ownership NONE). Confirm as a player: the journal is hidden.
- [ ] **dmOnlyHidden OFF:** re-sync (edit the entity on Chronicle so it re-pulls). The same
      DM-only entity now appears to players at the default-ownership level. Players gain the
      dm-only content. Toggle back ON → players lose it again on the next sync.
- [ ] **defaultOwnership = Owner:** a player-visible entity → journal default ownership is OWNER
      (players can edit). Set it to **None** → public entities sync as GM-only.
- [ ] **(FM-SYNC-HARDENING §4)** Per-user Chronicle grant: an entity shared with a specific
      Chronicle user (mapped to a Foundry user via the auto-matched user table) → that Foundry
      user gets per-user OWNER/OBSERVER ownership; unmapped Chronicle users are dropped (the
      entity under-shares — no leak to the wrong player).

### Edge Cases
- [ ] Rapid successive edits don't create duplicate entities
- [ ] Sync guard prevents infinite loops (edit in A, syncs to B, doesn't re-sync to A)
- [ ] Monk's Enhanced Journal: content syncs correctly if module active

## Map Sync (Markers Only)

Note: Drawings, tokens, fog of war, and layers are managed by Chronicle's web
map editor. Only markers/pins sync to Foundry as Scene Map Notes.

### Chronicle -> Foundry
- [ ] Create marker in Chronicle -> Scene Note (pin) appears on linked Foundry scene
- [ ] Update marker position/name -> Scene Note updates
- [ ] Delete marker -> Scene Note removed

### Foundry -> Chronicle
- [ ] Create Scene Note on linked scene -> Marker syncs to Chronicle map
- [ ] Move/update Scene Note -> Marker updates in Chronicle
- [ ] Delete Scene Note -> Marker removed from Chronicle

### Coordinate Conversion
- [ ] Verify percentage-to-pixel conversion is accurate for markers
- [ ] Markers at scene edge map correctly

### View in Chronicle
- [ ] Right-click linked scene -> "View in Chronicle" opens map URL in browser
- [ ] Dashboard Maps tab -> "View in Chronicle" link opens map URL

## Calendar Sync

> **BLACKOUT (2026-08-21):** Chronicle's calendar is deleted pending V5, so the
> checks in this section cannot be performed end to end. See API-CONTRACT.md →
> "CALENDAR BLACKOUT". The three boxes that ARE the blackout test are in the
> API section above.

### Chronicle -> Foundry
- [ ] Advance date in Chronicle -> Calendaria/SimpleCalendar date updates
- [ ] Create calendar event -> Event appears in calendar module
- [ ] Update event -> Calendar module event updates
- [ ] Delete event -> Calendar module event removed

### Foundry -> Chronicle
- [ ] Change date in Calendaria/SimpleCalendar -> Chronicle date updates
- [ ] Create event in calendar module -> Chronicle event created
- [ ] Update event -> Chronicle event updates
- [ ] Delete event -> Chronicle event removed

### Adapter Compatibility
- [ ] Test with Calendaria module active
- [ ] Test with SimpleCalendar module active (note 0-indexed months/days)
- [ ] Test with neither module -> Calendar sync gracefully disabled

## Shop Widget

- [ ] Right-click JournalEntry linked to Shop entity -> "Open Chronicle Shop" option appears
- [ ] Shop window opens with correct shop name
- [ ] Inventory loads from relations API (items with price/quantity metadata)
- [ ] Items show name, price, quantity
- [ ] Out-of-stock items visually distinct
- [ ] Drag item from shop -> Drop on character sheet -> Foundry Item created
- [ ] Real-time refresh: update shop entity in Chronicle -> Shop window updates
- [ ] Multiple shop windows can be open simultaneously
- [ ] Closing shop window cleans up properly

## Scene-to-Map Linking

- [ ] Right-click scene in nav bar -> "Link to Chronicle Map" option visible (GM only)
- [ ] Dialog shows all Chronicle maps for the campaign
- [ ] Selecting a map links the scene (sets flag)
- [ ] Unlinking clears the flag
- [ ] Auto-link: if campaign has exactly one map, scene auto-links on initial sync
- [ ] Multi-map warning: if campaign has multiple maps, log warning with instructions
- [ ] Linked scene shows correct map ID in flag inspector

## Initial Sync

- [ ] Fresh connection triggers initial sync (GET /sync/pull)
- [ ] Existing entities create proper sync mappings
- [ ] Existing map-to-scene links and marker mappings created
- [ ] lastSyncTime updates after successful initial sync

## Permission & Security

- [ ] API key with read-only permission can't write via sync
- [ ] API key scoped to campaign A can't access campaign B data
- [ ] Calendar API returns `503 calendar_rebuilding` (blackout, 2026-08-21).
      The addon-disabled 404 case is untestable until V5.
- [ ] The dashboard Calendar tab does NOT claim "No calendar configured"
- [ ] Maps / actors / items / notes still sync while the calendar is down
- [ ] Disabled maps addon -> Maps API returns 404
- [ ] Private entities hidden from non-owner API keys
- [ ] Rate limiting enforced (60 req/min default)

## Character Sync (Actor ↔ Entity)

### Prerequisites
- [ ] Game system matches a Chronicle system (built-in or custom with foundry_path annotations)
- [ ] "Sync Characters" enabled in module settings
- [ ] Character entity type exists in Chronicle campaign

### Chronicle -> Foundry
- [ ] Create character entity in Chronicle -> Actor (type: character) created in Foundry
- [ ] Update character entity fields -> Actor system data updates (ability scores, HP)
- [ ] Update character entity name -> Actor name updates
- [ ] Delete character entity -> Actor unlinked (flags removed) but NOT deleted

### Foundry -> Chronicle
- [ ] Create character Actor in Foundry -> Entity created in Chronicle with mapped fields
- [ ] Update Actor ability scores -> Chronicle entity fields_data updates
- [ ] Update Actor HP -> Chronicle entity hp_current/hp_max update
- [ ] Update Actor name -> Chronicle entity name updates
- [ ] Delete Actor -> Chronicle entity deleted

### Dashboard - Characters Tab
- [ ] Characters tab visible in sync dashboard
- [ ] System badge shows matched system name
- [ ] Synced actors show green check with "Synced" label
- [ ] Unlinked actors show "Not linked" with Push button
- [ ] Push button creates Chronicle entity and links actor
- [ ] Empty state shown when no character actors exist
- [ ] Disabled state shown when syncCharacters is off
- [ ] No-system state shown when game system doesn't match

### System Adapters
- [ ] D&D 5e: All 6 ability scores sync (str, dex, con, int, wis, cha)
- [ ] D&D 5e: HP current/max syncs bidirectionally
- [ ] D&D 5e: AC, speed, level, class, race, alignment, proficiency_bonus push to Chronicle
- [ ] PF2e: Ability mods sync to Chronicle (str_mod through cha_mod)
- [ ] PF2e: HP syncs bidirectionally
- [ ] PF2e: Only HP and name sync back from Chronicle (derived values protected)
- [ ] PF2e: ancestry, heritage, class, level, perception, speed push to Chronicle

### Generic Adapter (Custom Systems)
- [ ] Custom system with foundry_path annotations → generic adapter loaded
- [ ] Generic adapter maps annotated fields bidirectionally (Chronicle ↔ Foundry)
- [ ] Fields with foundry_writable: false only push to Chronicle, not written back
- [ ] System without foundry_path on any field → generic adapter returns null, character sync disabled
- [ ] Type casting: number fields cast via Number(), string fields pass through
- [ ] _detectSystem() matches by foundry_system_id from API (not SYSTEM_MAP)
- [ ] _detectSystem() falls back to SYSTEM_MAP_FALLBACK when API fails
- [ ] _loadAdapter() tries dnd5e/pf2e first, then generic adapter

### Edge Cases
- [ ] Actor sync disabled when no system adapter available
- [ ] Sync guard prevents infinite loops (change in A doesn't re-trigger back to A)
- [ ] Only character-type actors processed (NPCs, vehicles ignored)
- [ ] Only current user's changes pushed (other users' changes ignored)
- [ ] Pre-existing actors can be manually pushed via dashboard Push button

## Error Recovery

- [ ] Invalid API key shows clear error message
- [ ] Network timeout during sync doesn't corrupt state
- [ ] Partial sync failure (one entity fails) doesn't block others
- [ ] Module gracefully handles Chronicle server restart
- [ ] **(FM-SYNC-HARDENING §4)** A failed Foundry→Chronicle push (e.g. Chronicle down)
      surfaces a `ui.notifications.warn` to the GM and appears in the dashboard error log
      (not console-only). Journal/note *updates* are queued for retry and re-push on reconnect.

### Reconnect re-pull (FM-SYNC-HARDENING §2)
Previously, edits made on Chronicle while Foundry was disconnected were lost until a world reload.
- [ ] With Foundry connected, **disconnect** (stop Chronicle, or pull the network) so the status
      pill goes red/yellow.
- [ ] While disconnected, **edit an entity on Chronicle** (e.g. rename it, change its content).
- [ ] **Reconnect** (restart Chronicle / restore network). After the connection settles
      (~3 s debounce), the change appears in Foundry automatically — no world reload needed.
      The activity log shows "Reconnected — re-pulled changes made during the disconnect".
- [ ] **Flapping** connection (rapid disconnect/reconnect cycles) triggers only ONE re-pull
      once the link stabilizes, not a re-pull per reconnect (no re-pull storm).

## Sync Dashboard

### Access
- [ ] Click status indicator → dashboard opens (GM only)
- [ ] Dashboard shows "Not configured" state when settings missing
- [ ] Dashboard opens to last-active tab

### Tabs (8 total)
- [ ] Config tab: API URL, key, campaign ID, sync scope, exclusion rules, save config
- [ ] Entities tab: entity list with sync status dots, pull/push actions, visibility toggle, search filter, bulk tools, "Create Type" button
- [ ] Shops tab: shop entities with "Open Shop" button linking to ShopWidget
- [ ] Maps tab: scene-to-map linking via dropdown, pin count, "View in Chronicle" link
- [ ] Characters tab: synced/unlinked actors, push button, system badge
- [ ] Notes tab: Chronicle notes synced as JournalEntries
- [ ] Calendar tab: date comparison (Chronicle vs Foundry), pull/push buttons, module detection
- [ ] Status tab: connection health, activity log, error log, diagnostics grid, system match info

### Layout Persistence
- [ ] Switch to Maps tab, close dashboard, reopen -> Maps tab still active
- [ ] Collapse an entity type group, reload Foundry -> group still collapsed
- [ ] Different browser/user has independent layout preferences

### Entity Type Creation
- [ ] "Create Type" button visible in Entities tab toolbar
- [ ] Click -> Dialog with name, plural name, icon class, color fields
- [ ] Submit with name "Quest" -> type created, dashboard refreshes
- [ ] New type appears in bulk "Change Type" dropdown
- [ ] Cancel/close without name -> no API call, no errors

### Test Connection (Multi-step)
- [ ] Test with valid config -> Shows: API reachable ✓, Auth OK ✓, Campaign ✓, System match ✓
- [ ] Test with wrong URL -> "Unreachable: Chronicle not responding at {url}"
- [ ] Test with wrong API key -> "Auth failed: API key invalid or revoked"
- [ ] Test with wrong campaign ID -> "Campaign not found"
- [ ] Test with CORS issue -> Shows origin URL and whitelist instructions
- [ ] Test with system not matched -> Shows available foundry_system_ids

### Diagnostics (F-QoL)
- [ ] Health metrics: REST success/error counts, uptime percentage, reconnect attempts
- [ ] Error log: last 50 errors with timestamp, method, path, status
- [ ] Retry queue: failed writes queued and processed on reconnect (max 3 retries)
- [ ] Activity log: last 100 sync actions with color-coded type icons
- [ ] Clear log button resets activity log
- [ ] Reconnect button triggers manual WebSocket reconnection
