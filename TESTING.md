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

### GM-only text and pictures
Needs a player client that can see the journal but does not own its page.
- [ ] In Chronicle, mark a sentence inside a paragraph as GM-only (secret text) and sync -> the Foundry page shows it inside a secret block for the GM; the player's view of the page has no trace of the sentence
- [ ] Add a GM-only picture in Chronicle -> it is inside a secret block for the GM and absent for the player
- [ ] As GM, edit a normal sentence next to the secret block and save -> in Chronicle the secret text is still GM-only and the rest of the paragraph reads as one paragraph
- [ ] As GM, wrap a new line in a Foundry secret block and save -> Chronicle shows it as GM-only text

### Player avatars
- [ ] A Chronicle member with a profile picture, matched to a Foundry user -> that user's avatar shows the picture after connect
- [ ] Change the picture in Chronicle, then dashboard refresh -> the avatar follows
- [ ] Set a different avatar in Foundry yourself -> a later Chronicle picture change leaves it alone
- [ ] Remove the picture in Chronicle (avatar still ours) -> the user goes back to the default avatar

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

### Marker icons and the map's look
- [ ] A map set to a frame or pin shape in Chronicle shows that frame and pin shape in the viewer
- [ ] The viewer's **Toggle Labels** button overrides the map's name setting for that viewer
- [ ] **Place Chronicle marker** or **Configure Chronicle Marker**: the Icon picker lists icon groups and a search box ("Search icons, e.g. tavern"); picking one updates the preview pin; Save -> Chronicle shows that icon
- [ ] Against an older Chronicle that has no icon list, the dialog hides the picker and an edited marker keeps its icon

### Maps with a shadow (security)
- [ ] In Chronicle, draw a shadow area over part of a map with a picture; as a player, open the map in Foundry -> the shadowed part of the picture is smudged and pins under the shadow are absent; the GM sees the original and the pins
- [ ] Move or remove the shadow in Chronicle -> the player's picture follows after the next sync

### Giving a map to a character
- [ ] GM: right-click a Chronicle map in the journal sidebar -> **Give this map to a character**, pick a character, **Give map** -> an item "Map of the area: <name>" is in that character's inventory and the owning players can open the map journal
- [ ] GM: drag a Chronicle map journal onto a character sheet -> same result, with no second item if it was already given
- [ ] On the sheet, the item's **Open** button unfolds the live map in its own window while the sheet stays open; the same works for the owning player
- [ ] A player who does not own the character cannot open the map

### View in Chronicle
- [ ] Dashboard Maps tab → the external-link icon on a map row opens the Chronicle map URL

## Calendar Sync

Chronicle's date and event routes are live; the old structure, settings,
import, export and advance routes answer `410 calendar_route_retired` (the
module calls none of them). An older Chronicle answers those with
`503 calendar_rebuilding`, which pauses date pushes for 30 seconds and shows one
GM notice. See API-CONTRACT.md.

Chronicle brings its own calendar; no Foundry calendar module is used.

### Calendar window
- [ ] Chronicle scene controls -> **Calendar** button (player and GM) -> first time, Chronicle's Allow window asks about "notes and calendar"; press Allow -> a Foundry window opens with Chronicle's own calendar page: the sky moving, day weather, moons, events
- [ ] A player already connected for the notebook -> **Calendar** opens straight away, no Allow window
- [ ] Player: GM-only events, hidden moons and secret eras never appear (compare with the same player signed in on the site)
- [ ] GM: Chronicle's editing works in the window (add an event, open it, change it); the change shows on the site after a refresh
- [ ] Resize the window from its corner -> the calendar redraws to fit (narrow: one-letter weekdays); close and reopen -> same size and place, per player
- [ ] Click a link to a page inside the calendar -> it opens on the Chronicle site in a new tab, not inside the window
- [ ] Disconnect the Foundry connection in Chronicle's Allow window list -> the calendar window says Chronicle turned it away; Connect brings it back

### Built-in calendar (strip)
- [ ] With Calendar sync on and nothing else changed, no strip shows
- [ ] Module Settings -> Show the calendar strip on -> a thin strip sits at the top centre: date, time and a weather icon over a small sky coloured for the hour; snow, rain or night stars move in it to match Chronicle
- [ ] Hover the strip -> it widens to show season, temperature and moons
- [ ] Drag the strip by its dots anywhere -> it stays there after a reload, and each player's spot is their own
- [ ] Click the lock on the strip -> the dots disappear and the strip (or its clock) cannot be dragged; click it again -> dragging works. The lock survives a reload and is per player
- [ ] Click the clock icon -> the strip shrinks to a round clock; click the clock -> the strip comes back with the month open
- [ ] Leave the mouse still for 20 seconds -> the sky's motion stops; move it -> it starts again
- [ ] Click the date -> the calendar window opens (as above). Not connected and "Not now" -> the small month opens under the strip instead; days up to today show their sky colour and weather icon, later days are plain; event days have a dot and the month's events are listed below; ‹ › flips months; click outside or Esc closes it
- [ ] GM: the small ‹ › arrows move the time one hour; Chronicle's calendar page shows the new time after a refresh
- [ ] GM: on a real-time calendar the arrows are greyed out and Set date is disabled
- [ ] GM: **Set date…** in the month moves Chronicle's date; a date the calendar doesn't have is refused with a warning
- [ ] GM: **Add event** creates the event in Chronicle (check the Chronicle calendar page); "GM only" makes it GM-only there and shows "(GM only)" in the list
- [ ] Player client: the same strip and month, without arrows, Set date or Add event; GM-only events, hidden moons, secret eras and future days' weather never appear
- [ ] Move the date in Chronicle -> the strip updates for the GM and every player
- [ ] A calendar hidden from players in Chronicle -> players see no strip
- [ ] Turn Calendar sync off in Module Settings -> the strip disappears for everyone without a reload
- [ ] Module Settings -> Calendar temperature unit °F -> only your strip switches to °F

### Dashboard
- [ ] Calendar tab shows Chronicle's calendar name, date (day, month, year) and time
- [ ] Advance the date in Chronicle -> the tab shows the new date after the next refresh
- [ ] Change weather, season, era or a moon phase in Chronicle -> the world-state panel updates
- [ ] With the announce settings on, a GM-only whisper appears for each change; players never see it
- [ ] Calendar sync off in Module Settings -> the tab says it is disabled
- [ ] A campaign with no calendar -> the tab says none is configured

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
- [ ] Player while downtime is closed: the button reads "Ask to buy"; pressing it says "Asked the GM for …", nothing is charged and no chat line appears; the request waits on Chronicle's Stashes page
- [ ] Player whose Foundry user is not matched: no basket appears; GM stops showing the shop mid-basket -> Buy says the GM isn't showing it any more
- [ ] Open a shop's journal entry -> the title bar has an **Open shop** button; the GM's opens the GM room
- [ ] Player with Observer or more on the shop journal: **Open shop** opens the room on that player's screen only, and their basket works as above
- [ ] Player with no access to the shop journal: the entry and its button are not visible; a player given Owner on it gets no button
- [ ] Player presses **Open shop** with no GM logged in -> the window says "The shop is closed"
- [ ] GM shows then stops showing a shop a player opened from its journal -> the player's room stays open

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

### Identity items (Draw Steel: ancestry, culture, career, kit)
- [ ] In Chronicle, set an actor's linked character to an ancestry that exists in the system compendium (e.g. Dwarf) -> within a few seconds the Foundry sheet shows the Dwarf ancestry item in place of the old one (data from the compendium); the Chronicle value does not change
- [ ] Same with an ancestry that exists as an Item in the world's Items sidebar -> the world item is used
- [ ] Pick a name that exists nowhere (a campaign's own entry) -> a plain item with that name appears on the sheet
- [ ] Culture, career and kit behave the same way
- [ ] Clear the value in Chronicle -> the Foundry item stays
- [ ] Class, subclass and level changed in Chronicle do not touch the Foundry sheet
- [ ] Nothing in the Dashboard activity log or Chronicle's sync history shows the item swap coming back as a Foundry change
- [ ] As a non-GM player nothing is swapped on their client (only the GM's client applies it)

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
- [ ] Draw Steel world: on a linked or same-named NPC's Chronicle page, change the negotiation tracker (interest, patience, motivations, impression): the NPC actor's sheet shows the same values within a moment; a non-Draw-Steel world and hero actors stay untouched
- [ ] Draw Steel world: drop a Chronicle NPC journal on a token whose page already has a tracker: the actor's negotiation fills in right after the "linked" notice (edits on the Foundry sheet don't go back to Chronicle yet)
- [ ] On the NPC's Chronicle page press "Show in Foundry": the page says "Sent to Foundry." and both clients play the same spotlight as the star
- [ ] "Show in Foundry" for an NPC with no token on the GM's scene, or only a hidden one: only the GM gets a notice

## DM Screen

GM only. Needs a Chronicle that serves the DM Screen.

- [ ] The scene controls' Chronicle group has a d20 button for the GM; a player's group has only the notebook button
- [ ] Click it: a d20 rolls out of the button, lands on 20 and the screen unfolds into three leaves (The world, The party, Rules and reveals); a click or Escape skips the opening
- [ ] The world leaf shows In session / Downtime; pressing the other one asks first, **Cancel** leaves it, confirming switches it and a notice says how many waiting requests went through
- [ ] The party leaf lists each hero on one line; a row expands for detail
- [ ] Rules tab: **Find a condition** filters the list. Reveal tab: **Reveal** on a hidden character makes it visible to players in Chronicle
- [ ] Against a Chronicle without the DM Screen, the window says to update Chronicle; with a wrong key it says the key was not accepted; **Try again** reloads

## Character claims

Needs the Player Character Claiming addon on in Chronicle, a character linked to an actor, and two players matched to Chronicle members (Members tab). Run as the GM.

- [ ] In Chronicle, assign the character to player A -> within a few seconds A is **Owner** in the actor's Ownership settings, and A can open and edit the sheet; nothing about the ownership is sent back to Chronicle
- [ ] Reassign it to player B -> B is Owner, A is still Owner, and the GM sees one notice saying A still owns it and can be changed in the actor's Ownership settings
- [ ] Unassign it in Chronicle -> Foundry ownership is unchanged
- [ ] Assign it to a member with no Foundry user mapped -> no ownership change, one GM notice that the player has no Foundry user, and the Members tab shows that member as "Owns a character, no Foundry user" with a banner; mapping them and pressing **Refresh Members**, then reconnecting, gives them Owner
- [ ] Reconnect (or Pull All) with a claim that is already applied -> no notice and no ownership change

## Stashes

Needs the Armory addon on in Chronicle, a character linked to an actor, and a player matched to a Chronicle member (Members tab).

- [ ] A **Stashes** button is in the title bar of a linked character sheet (players on characters they own, the GM on all); with the Armory off, or on a Chronicle without stash routes, it is absent
- [ ] The window shows the character on the left and a destination on the right, a downtime badge, and Move / History tabs
- [ ] As GM, move an item or an amount of money to another character or a stash -> it happens at once and both sheets update
- [ ] As a player, move something -> "Sent to your GM"; the GM gets a whispered **Stash request** chat card
- [ ] **Approve** on the card -> the card reads "Approved by <name>", the player's window updates and both inventories change; **Turn down** -> "Turned down by <name>" and nothing moves
- [ ] An item moved away from a character in Chronicle disappears from the Foundry sheet; a relation removed any other way only unlinks the Foundry item
- [ ] With no GM connected, a player's move says stashes need the GM to be connected

## Player Notebook

- [ ] Every user (GM and players) has an **Open my Chronicle notebook** button in the Chronicle scene controls and a **Jot notes** tab in the bottom-right corner while the world is connected to Chronicle
- [ ] First use: **Connect to Chronicle** opens Chronicle's Allow window; **Allow** closes it and the player's own Journal appears in the frame
- [ ] A player whose Foundry user is not matched to a Chronicle member sees the "hasn't matched your Foundry login" message; one who allows with a different Chronicle account sees the "isn't the one your GM matched" message
- [ ] Open a Chronicle-linked journal, then the Jot notes tab -> the jots follow the page in view; opening another linked journal moves them
- [ ] Drag the Jot notes tab somewhere else -> it moves and stays closed or open as it was; a plain click still opens and closes it. Drag the open panel by the slim bar on its top edge -> it moves, even across the notebook window; the X closes it. Reload Foundry -> both are where you left them
- [ ] Disconnect the player in Chronicle -> the frame shows "no longer accepts this connection" with a Connect button
- [ ] The old "Chronicle Notes" journal folder, if the world had one, is moved into "Chronicle: removed" on the GM's world load and nothing in it is deleted

## Import Wizard

- [ ] Dashboard Config tab -> **Setup Wizard** opens a six-step wizard: Connect, Scan, Types, Tags, Characters, Review; there are no maps or calendar steps
- [ ] Tags and Characters steps are skipped when tags are unavailable or no game system matched
- [ ] Review lists what will be created; running it creates the entities and marks the wizard completed

## Problem reports (privacy, module #94)

Needs a GM client and a player client, on each of Foundry v12, v13 and v14.

- [ ] As a player, open a character's Stashes window, click "Report a problem", send text: "Sent to your GM"; the GM sees "{name} reported a problem" and the Debug tab badge goes up
- [ ] In the GM's Journal sidebar there is no "Chronicle: problem reports" entry
- [ ] In the player's browser console, `game.journal.find(j => j.getFlag("chronicle-sync", "problemReportsStore"))` returns `undefined`, and `game.journal.contents.some(j => j.name.includes("problem reports"))` is `false`
- [ ] As the GM, the same first console line returns the entry, and its `flags["chronicle-sync"].reports` lists the report
- [ ] Reload the GM client: the report is still there and no second entry was made
- [ ] The entry does not appear in the Import wizard's journal list or the dashboard's Foundry-only journals, and nothing was pushed to Chronicle

## Error Recovery

- [ ] Invalid API key shows clear error message
- [ ] Network timeout during sync doesn't corrupt state
- [ ] Partial sync failure (one entity fails) doesn't block others
- [ ] Module gracefully handles Chronicle server restart
- [ ] A failed Foundry→Chronicle push (e.g. Chronicle down)
      surfaces a `ui.notifications.warn` to the GM and appears in the dashboard error log
      (not console-only). Journal/note *updates* are queued for retry and re-push on reconnect.

### Catch-up after a closed world
- [ ] Close Foundry, edit a page and a character in Chronicle, change a character's inventory there, then reopen the world -> the page, the character and the inventory change appear without Resync All
- [ ] Delete a page in Chronicle while Foundry is closed, then reopen -> its journal is set aside in the "Chronicle: removed" folder, not deleted
- [ ] Against an older Chronicle with no change feed, reopening still catches up (a full rescan; slower)
- [ ] Remove a "Has Item" relation in Chronicle -> the Foundry item is unlinked from Chronicle but not deleted from the character

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

The dashboard is a left rail of 10 tabs in four labelled groups. Rail order:
Overview (top, ungrouped); Everyday: Entities, Characters, Calendar, Issues;
Library: Shops, Maps; Setup: Config, Members; Diagnostics: Status.

### Access
- [ ] Click the sidebar status indicator (when connected) or the Chronicle Sync button in the scene controls → dashboard opens (GM only); right-click on the indicator opens it even when disconnected; clicking while disconnected tries to reconnect
- [ ] Dashboard shows "Chronicle Sync is not configured" with an **Open Settings** button when URL, key or campaign ID is missing
- [ ] Dashboard opens to the last-active tab; an unknown saved tab falls back to Overview
- [ ] A tab that fails to load shows a "Some data failed to load" banner naming the tab, with **Retry**

### Tabs
- [ ] **Overview:** connection banner (green/yellow/red) with **Reconnect** when not connected; stat tiles for Entities Synced, Characters Synced (n/total) and Maps Linked, each jumps to its tab on click; "Needs Attention" lists only real problems (each row jumps to the fixing tab) or says "Everything's in sync"; **Sync Everything Now**, **Diagnostics** and **Refresh** work
- [ ] **Entities:** entity list grouped by type with sync status dots, Pull/Push per row, Pull All / Push All, Resync All Journals, visibility toggle, search filter, bulk select (Make Public / Private / Delete / Change Type), **Create Type**
- [ ] **Characters:** system badge, synced and unlinked actors, Push / Push All / Re-sync (see Character Sync)
- [ ] **Calendar:** shows Chronicle's date and time and the world-state panel (weather, season, era, moons); the tab explains why when sync is disabled, no calendar is configured, or the calendar is rebuilding or unreachable
- [ ] **Issues:** badge shows the number of character actors that cannot be matched. Each row offers a "Match to existing…" dropdown with **Match**, and **Create new**. Resolving a row links it and removes it. With none, the tab says every character is linked
- [ ] **Shops:** shop entities with type, keeper, private lock, "Synced" badge and an **Open** button that opens the Shop window; empty states say whether the "Shop" entity type is missing or just has no shops
- [ ] **Maps:** per-map rows with the map's picture (a shadowed map shows the players' copy), marker / drawing / token counts, **Open in Foundry**, external-link icon; **Resync All Maps**, **Open Chronicle Maps Folder**; summary row and dismissible error list (see Map Sync)
- [ ] **Config:** Connection (URL, API key as password field, campaign ID, **Test Connection**), **Setup Wizard** button, Sync Scope, Permissions, Behavior (conflict resolution), Exclusion Rules (tags, name) and **Save**; unsaved checkbox/select changes are marked until saved
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
- [ ] Status tab -> **Copy Diagnostic Bundle** puts a Markdown report (versions, connection health, sync state, field mapping, recent activity and errors) on the clipboard; it contains no API key
- [ ] Clear log button resets activity log (Status tab)
- [ ] Reconnect button (Status tab, and Overview when disconnected) triggers manual WebSocket reconnection
