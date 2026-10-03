# Foundry VTT Sync Module - E2E Testing Checklist

Manual testing checklist for the Chronicle-Foundry bidirectional sync module.
Requires a running Chronicle instance and Foundry VTT (v14) with the chronicle-sync module installed.

Automated checks (no Foundry needed): `node --test tools/test-*.mjs` from the
repo root. There is no `package.json`.

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
- [ ] Delete entity -> JournalEntry set aside (unlinked, in the "Chronicle: removed" folder), never deleted

### Foundry -> Chronicle
- [ ] Create JournalEntry -> Entity appears in Chronicle
- [ ] Update JournalEntry name -> Entity name updates
- [ ] Edit JournalEntry page content -> Entity entry updates
- [ ] Delete JournalEntry -> asked "Delete in Chronicle too?": No keeps the entity, Yes deletes it
- [ ] Delete several linked JournalEntries at once -> asked once, with all of them listed

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
- [ ] **(fail-closed)** Permission API failure on a `custom`-visibility
      entity → ownership defaults to **NONE** (GM-only), even when `is_private=false`.
      It must NOT fall open to OBSERVER. To reproduce: stop Chronicle (or block the
      `/permissions` endpoint) while a custom-visibility entity syncs; confirm players
      cannot see it.

### Visibility Settings (Config tab → Permissions)
These controls drive journal ownership:
- [ ] **dmOnlyHidden ON (default):** a DM-only / private Chronicle entity → players have NO
      access to the journal (ownership NONE). Confirm as a player: the journal is hidden.
- [ ] **dmOnlyHidden OFF:** re-sync (edit the entity on Chronicle so it re-pulls). The same
      DM-only entity now appears to players at the default-ownership level. Players gain the
      dm-only content. Toggle back ON → players lose it again on the next sync.
- [ ] **defaultOwnership = Owner:** a player-visible entity → journal default ownership is OWNER
      (players can edit). Set it to **None** → public entities sync as GM-only.
- [ ] Per-user Chronicle grant: an entity shared with a specific
      Chronicle user (mapped to a Foundry user on the dashboard Members tab) → that Foundry
      user gets per-user OWNER/OBSERVER ownership; unmapped Chronicle users are dropped (the
      entity under-shares — no leak to the wrong player).

### Edge Cases
- [ ] Rapid successive edits don't create duplicate entities
- [ ] Sync guard prevents infinite loops (edit in A, syncs to B, doesn't re-sync to A)
- [ ] Monk's Enhanced Journal: content syncs correctly if module active

## Map Sync (Journal Map Viewer)

Each Chronicle map becomes a JournalEntry (one image page) in a "Chronicle Maps"
folder, drawn by the Chronicle Map Viewer sheet with markers, drawings, tokens,
layers and fog as overlays. Drawings, tokens, layers and fog are read-only in
Foundry; markers are editable by the GM. Needs "Sync Maps" on and a Chronicle
campaign with at least one map that has an image, markers (some `Everyone`, one
`DM only`), and ideally a drawing, a token and a fog region.

### Materialize
- [ ] Dashboard → Maps tab → **Resync All Maps** → each Chronicle map is listed under
      "Chronicle Maps" with marker / drawing / token counts and an **Open in Foundry** button
- [ ] **Open Chronicle Maps Folder** reveals the "Chronicle Maps" folder in the Journal sidebar
- [ ] The summary row shows Materialized count, Open viewers and Last sync (not "never")
- [ ] Click **Open in Foundry** → the map opens in the Chronicle Map Viewer (image plus overlays, zoom % bottom corner)
- [ ] A map with no image does not break the Resync (a row appears under recent errors instead, **Dismiss** clears it)
- [ ] Press **Resync All Maps** twice → no duplicate journals or folders

### Chronicle -> Foundry (viewer open)
- [ ] Create a marker in Chronicle's map editor → it appears in the open viewer within a few seconds
- [ ] Move or rename the marker → the viewer updates; the tooltip shows the new name
- [ ] Delete the marker → it disappears from the viewer
- [ ] Add/change a drawing (rectangle, ellipse, line, polygon, freehand) → it renders as an overlay; layer order matches Chronicle
- [ ] Add/move a token → it renders with its image, an HP bar when it has HP, and its name when labels are on
- [ ] Hide a layer or change a layer's order in Chronicle → items on it follow
- [ ] Delete the map in Chronicle → the viewer shows the "was deleted, local annotations preserved" notice and the journal is kept

### Foundry -> Chronicle (GM, markers only)
- [ ] Toolbar → **Place Chronicle marker**, click the map → dialog with name, category, description and visibility; **Create** → marker appears in Chronicle's editor
- [ ] Right-click a Chronicle marker → **Configure Chronicle Marker**; change name/category → Save → Chronicle shows the change
- [ ] In that dialog set Visibility to **DM only** → Save → the marker shows the DM-only style for the GM and Chronicle shows it as DM only
- [ ] **Delete Marker** → confirm → marker is removed in Chronicle
- [ ] Double-click a marker that has a linked entity → the entity's journal opens
- [ ] Stop Chronicle, then save a marker edit → an error toast ("Failed to update marker on Chronicle") and the viewer keeps the old value
- [ ] Viewer toolbar **Resync this map from Chronicle** re-fetches the map; **Open in Chronicle web editor** opens the map URL

### Local pins (never sync to Chronicle)
- [ ] Pick a pin type in the toolbar, click the map → a local pin is placed; drag moves it; right-click configures; double-click opens its linked journal
- [ ] A pin marked "Visible to players" shows to a player; one that is not stays GM-only
- [ ] After a world reload the pins are still there, and they do not appear in Chronicle

### Player Visibility (security)
Players read only what the GM client wrote into the journal page flags, so
restricted data must never be written there (`scripts/_map-flag-filter.mjs`).
Setup: in Chronicle, one `Everyone` marker, one `DM only` marker, a marker or
drawing restricted to specific users, a hidden token, and a fog region; give the
test player Observer on the map journal.
- [ ] As GM, all of them show in the viewer (DM-only marker with the DM-only style; fog as a dark overlay)
- [ ] As the player, open the same map: only the `Everyone` marker and unrestricted drawings and tokens show
- [ ] As the player, the `DM only` marker, the user-restricted marker/drawing, the hidden token and the fog overlay are all absent
- [ ] As the player, F12 console: `game.journal.getName("<map name>").pages.contents[0].flags["chronicle-sync"]` — its `chronicleMarkers` list holds no `DM only` or restricted marker, and no fog data is present
- [ ] Right-click on a marker as the player does nothing (no config dialog); the Place Chronicle marker tool is absent
- [ ] Change a visible marker to `DM only` in Chronicle while the player has the map open → it vanishes from the player's view and from the page flags after the next sync
- [ ] Change it back to Everyone → it reappears for the player
- [ ] Marker JSON from a map saved by an older module version that already carried a DM-only marker in flags: **Resync All Maps** strips it from the flags

### View in Chronicle
- [ ] Dashboard Maps tab → the external-link icon on a map row opens the Chronicle map URL

## Calendar Sync

Chronicle's date and event routes are live; the old structure, settings,
import, export and advance routes answer `410 calendar_route_retired` (the
module calls none of them). An older Chronicle answers those with
`503 calendar_rebuilding`, which pauses date pushes for 30 seconds and shows one
GM notice. See API-CONTRACT.md.

### Chronicle -> Foundry
- [ ] Advance date in Chronicle -> Calendaria/SimpleCalendar date updates
- [ ] Create calendar event -> Event appears in calendar module
- [ ] Update event -> Calendar module event updates
- [ ] Delete event -> Calendar module event removed

### Foundry -> Chronicle
- [ ] Change date in Calendaria/SimpleCalendar -> Chronicle date updates
- [ ] A real-time Chronicle calendar is never overwritten by a Foundry date change
- [ ] Create event in calendar module -> Chronicle event created
- [ ] Update event -> Chronicle event updates
- [ ] Delete event -> Chronicle event removed

### Adapter Compatibility
- [ ] Test with Calendaria module active
- [ ] Test with SimpleCalendar module active (note 0-indexed months/days)
- [ ] Test with neither module -> Calendar sync gracefully disabled

## Shop Widget

- [ ] Right-click JournalEntry linked to Shop entity -> "Open Chronicle Shop" option appears
- [ ] Dashboard Shops tab -> each shop row has an **Open** button that opens the same shop room
- [ ] Shop room opens with the shop's name; the room matches the Chronicle shop page (same furniture, keeper picture, wares)
- [ ] Hovering an item in the room shows its name and price; clicking the keeper shows their lines
- [ ] Wares list shows price and stock; sold-out goods are faded; hidden or GM-only goods are missing
- [ ] Drag a row from the wares list -> Drop on character sheet -> Foundry Item created
- [ ] Real-time refresh: change price or stock in Chronicle -> the open room updates
- [ ] "Show to players" -> the room opens on each player's screen; players see no "Arrange" or "Show" buttons
- [ ] "Stop showing" -> the room closes on players' screens
- [ ] Multiple shop rooms can be open simultaneously; closing one cleans up its tooltip
- [ ] GM: open the wares, Add an item, pick who pays, Buy -> "Bought … left." in the room; the coins drop on that character's sheet and the item appears in its inventory; a whispered chat line names the character, goods and cost
- [ ] Player (matched to a Chronicle member, downtime open, shop shown): the basket lists only their own characters; Buy works the same; the GM gets the chat line naming the player
- [ ] Player while downtime is closed: Buy reads "Buying opens in downtime" and nothing is charged
- [ ] Player whose Foundry user is not matched: no basket appears; GM stops showing the shop mid-basket -> Buy says the GM isn't showing it any more

## Initial Sync

- [ ] Fresh connection triggers initial sync (GET /sync/pull)
- [ ] Existing entities create proper sync mappings
- [ ] Existing Chronicle maps are materialized as journals in the "Chronicle Maps" folder
- [ ] lastSyncTime updates after successful initial sync

## Permission & Security

- [ ] API key with read-only permission can't write via sync
- [ ] API key scoped to campaign A can't access campaign B data
- [ ] Against a Chronicle that answers calendar routes with `503 calendar_rebuilding`: the dashboard Calendar tab says the calendar is being rebuilt and does NOT claim "No calendar configured"
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
- [ ] Delete Actor -> asked "Delete in Chronicle too?": No keeps the entity, Yes deletes it

### Dashboard - Characters Tab
- [ ] Characters tab visible in sync dashboard (rail group "Everyday")
- [ ] System badge shows matched system name
- [ ] Synced actors show green check with "Synced" label, a last-sync time and a **Re-sync** button
- [ ] Unlinked actors show "Not linked" with a Push button, and **Push All** appears in the toolbar
- [ ] Push button creates Chronicle entity and links actor
- [ ] Empty state shown when no character actors exist
- [ ] Disabled state shown when syncCharacters is off
- [ ] No-system state shown when game system doesn't match

### Generic Adapter (all systems)
Character sync uses one API-driven adapter (`scripts/adapters/generic-adapter.mjs`)
that reads each field's `foundry_path` from the matched Chronicle system's manifest.
- [ ] A game system with a Chronicle package that declares `foundry_path` fields (e.g. D&D 5e, PF2e, Draw Steel) -> Dashboard Status tab → Field Mapping shows Adapter loaded and a Character Type
- [ ] Mapped fields sync Chronicle -> Foundry and Foundry -> Chronicle (change one number field each way)
- [ ] Fields with `foundry_writable: false` push to Chronicle only and are not written back to the actor
- [ ] Number fields are cast to numbers; string fields pass through
- [ ] System package with no `foundry_path` on any field -> character sync is off (Characters tab shows no adapter, Status tab shows Adapter none)
- [ ] The game system is matched by the Chronicle system's `foundry_system_id` and the system must be enabled for the campaign (Status tab → Game System shows both ids); a system that is installed but not enabled shows the "not enabled" message in the activity log
- [ ] When Chronicle is unreachable at load, the last matched system is reused

### Edge Cases
- [ ] Actor sync disabled when no system adapter available
- [ ] Sync guard prevents infinite loops (change in A doesn't re-trigger back to A)
- [ ] Only character-type actors processed (NPCs, vehicles ignored)
- [ ] Only current user's changes pushed (other users' changes ignored)
- [ ] Pre-existing actors can be manually pushed via dashboard Push button

## NPC Tokens (Spotlight, Talking)

Needs a GM and a player client on the same scene, and an NPC page synced as a journal.

- [ ] Right-click a token named like an NPC page: the HUD shows a star, a speech icon and a book; the book opens the page
- [ ] Drag a Chronicle journal onto any token: "linked" notice, no map note placed; the book now opens that page
- [ ] Dragging a journal onto a hero synced by character sync only warns; the hero keeps its own page
- [ ] Star on a visible token: both clients glide to it and see the gold ring; the player sees the name only if the page is shown to players or the nameplate shows to everyone
- [ ] Star on a hidden token: only the GM gets a notice; the player's camera doesn't move
- [ ] Speech icon: ring breathes and a speech mark shows on both clients; GM chat comes from the NPC with a bubble
- [ ] Starting a second NPC talking stops the first; two minutes with no lines switches it off; a reload doesn't leave it on
- [ ] Leave a client idle for a minute, or switch its tab away: the glow slows to still, and comes back on return
- [ ] Reveal a hidden NPC token whose page is hidden: asked once "Show their Chronicle page?"; Yes shows the page to players in Chronicle, No leaves it hidden

## Error Recovery

- [ ] Invalid API key shows clear error message
- [ ] Network timeout during sync doesn't corrupt state
- [ ] Partial sync failure (one entity fails) doesn't block others
- [ ] Module gracefully handles Chronicle server restart
- [ ] A failed Foundry→Chronicle push (e.g. Chronicle down)
      surfaces a `ui.notifications.warn` to the GM and appears in the dashboard error log
      (not console-only). Journal/note *updates* are queued for retry and re-push on reconnect.

### Reconnect re-pull
Edits made on Chronicle while Foundry was disconnected arrive after reconnect, without a world reload.
- [ ] With Foundry connected, **disconnect** (stop Chronicle, or pull the network) so the status
      pill goes red/yellow.
- [ ] While disconnected, **edit an entity on Chronicle** (e.g. rename it, change its content).
- [ ] **Reconnect** (restart Chronicle / restore network). After the connection settles
      (~3 s debounce), the change appears in Foundry automatically — no world reload needed.
      The activity log shows "Reconnected — re-pulled changes made during the disconnect".
- [ ] **Flapping** connection (rapid disconnect/reconnect cycles) triggers only ONE re-pull
      once the link stabilizes, not a re-pull per reconnect (no re-pull storm).

## Sync Dashboard

The dashboard is a left rail of 11 tabs in five groups. Rail order: Overview
(top, ungrouped); Everyday: Entities, Characters, Calendar, Issues; Library:
Shops, Maps, Notes; Setup: Config, Members; Diagnostics: Status.

### Access
- [ ] Click the sidebar status indicator (when connected) or the Chronicle Sync button in the scene controls → dashboard opens (GM only); right-click on the indicator opens it even when disconnected; clicking while disconnected tries to reconnect
- [ ] Dashboard shows "Chronicle Sync is not configured" with an **Open Settings** button when URL, key or campaign ID is missing
- [ ] Dashboard opens to the last-active tab; an unknown saved tab falls back to Overview
- [ ] A tab that fails to load shows a "Some data failed to load" banner naming the tab, with **Retry**

### Tabs
- [ ] **Overview:** connection banner (green/yellow/red) with **Reconnect** when not connected; stat tiles for Entities Synced, Characters Synced (n/total) and Maps Linked, each jumps to its tab on click; "Needs Attention" lists only real problems (each row jumps to the fixing tab) or says "Everything's in sync"; **Sync Everything Now**, **Diagnostics** and **Refresh** work
- [ ] **Entities:** entity list grouped by type with sync status dots, Pull/Push per row, Pull All / Push All, Resync All Journals, visibility toggle, search filter, bulk select (Make Public / Private / Delete / Change Type), **Create Type**
- [ ] **Characters:** system badge, synced and unlinked actors, Push / Push All / Re-sync (see Character Sync)
- [ ] **Calendar:** shows the Chronicle vs Foundry date with Pull Date / Push Date and the detected calendar module; **Open Sync Calendar** opens the Sync Calendar editor; the tab explains why when sync is disabled, no calendar module is active, or the calendar is rebuilding or unreachable
- [ ] **Issues:** badge shows the number of character actors that cannot be matched. Each row offers a "Match to existing…" dropdown with **Match**, and **Create new**. Resolving a row links it and removes it. With none, the tab says every character is linked
- [ ] **Shops:** shop entities with type, keeper, private lock, "Synced" badge and an **Open** button that opens the Shop window; empty states say whether the "Shop" entity type is missing or just has no shops
- [ ] **Maps:** per-map rows with marker / drawing / token counts, **Open in Foundry**, external-link icon; **Resync All Maps**, **Open Chronicle Maps Folder**; summary row and dismissible error list (see Map Sync)
- [ ] **Notes:** Chronicle notes with a status badge (synced / chronicle-only), shared or private icon, last-sync time, and a Pull button on chronicle-only notes
- [ ] **Config:** Connection (URL, API key as password field, campaign ID, **Test Connection**), Import Wizard button, Sync Scope, Permissions, Behavior (conflict resolution), Exclusion Rules (tags, name) and **Save**; unsaved checkbox/select changes are marked until saved
- [ ] **Members:** one row per Chronicle campaign member with Matched / Unmatched badge and a Foundry-user dropdown; changing the dropdown saves the mapping; the rail badge counts unmatched members; **Refresh** re-fetches
- [ ] **Status:** Game System (Foundry and Chronicle system, Character Sync), Diagnostics, Field Mapping, Sync Capability (pick an actor to inspect; **Copy** report and JSON), Error Log, Recent Activity, Diagnostic Bundle copy and System Debug Export copy

### Layout Persistence
- [ ] Switch to Maps tab, close dashboard, reopen -> Maps tab still active (a different tab than Overview)
- [ ] Collapse an entity type group, reload Foundry -> group still collapsed
- [ ] A different browser/user has independent layout preferences (they are client settings)

### Entity Type Creation
- [ ] "Create Type" button visible in Entities tab toolbar
- [ ] Click -> Dialog with name, plural name, icon and color fields
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

### Diagnostics
- [ ] Health metrics: Uptime, API OK, API Errors, Reconnects, Last Success, Last Error
- [ ] Error log: recent errors (up to 50) with timestamp, method, path, status
- [ ] Retry queue: failed writes queued and processed on reconnect (Status tab → Pending Retries drains to 0)
- [ ] Activity log: recent sync actions (up to 100 kept, newest first) with color-coded type icons
- [ ] Clear log button resets activity log (Status tab)
- [ ] Reconnect button (Status tab, and Overview when disconnected) triggers manual WebSocket reconnection
