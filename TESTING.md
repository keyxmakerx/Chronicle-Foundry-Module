# Foundry VTT Sync Module - E2E Testing Checklist

Live checklist for the sync module. Needs a running Chronicle and Foundry VTT
(v14) with chronicle-sync installed.

Automated checks (no Foundry): `node --test tools/test-*.mjs` from the repo
root. There is no `package.json`.

## Prerequisites

- [ ] Chronicle running with API key created for target campaign
- [ ] Foundry VTT world with chronicle-sync module enabled
- [ ] Chronicle Sync → Settings → Connection filled in: address, API key, campaign
- [ ] Chronicle Sync → Settings → What syncs: Sync is on

## Connection & Status

- [ ] Status indicator shows green dot when connected
- [ ] Status indicator shows yellow during reconnection
- [ ] Status indicator shows red when disconnected
- [ ] WebSocket auto-reconnects after network interruption (wait 30s)
- [ ] Message queue drains after reconnection

## Motion

- [ ] Configure Settings → Chronicle Sync shows Motion (Full, Calm, Off) beside the calendar, calendar look and temperature unit; on a computer set to reduce motion, a new client starts on Calm
- [ ] Full: the dashboard grows out of the scene-control button that opened it; switching dashboard sections and settings tabs settles the new panel in; Test connection's checks appear one after another
- [ ] Calm: each of those is a short fade in place, and the DM Screen fades in instead of rolling its die. Off: windows, panels and checks appear at once, the DM Screen opens and closes without its die or fold, and nothing in a Chronicle window animates
- [ ] With reduce motion on and Motion left on Calm, Foundry's own windows and other modules animate as they did before Chronicle

## Keyboard shortcuts

- [ ] Configure Controls lists a Chronicle Sync group with five shortcuts (Chronicle Sync, DM Screen, Satchel, calendar, token art on hover), all with no key bound
- [ ] Bind a key to "Open the Chronicle Sync dashboard", press it as the GM: the dashboard opens; as a player the GM-only two are not listed
- [ ] With the world not connected, a key bound to the notebook does nothing and Foundry's own use of that key still works

## Dice So Nice

- [ ] Without Dice So Nice installed: roll `/r 1d20` as GM and as a player; both get Foundry's normal roll card and no console errors. Chronicle Sync → Problems → Health shows Dice So Nice "Not in use"
- [ ] With Dice So Nice 6.x on: the same pane shows "Working", the version, and "calls for adding dice are all there"; "Check dice files" adds "All N dice files are where they should be" (or "No rune dice sets are shipped" while the list is empty)
- [ ] With rune sets shipped: Dice So Nice's settings (the dice icon in chat) list a "Chronicle Rune" group under dice and themes, on a player's client too
- [ ] A player with Dice So Nice turned off in its own settings, or with Foundry's canvas off, still sees the roll card
- [ ] Dice So Nice's settings → Special Effects: a new player has two "Chronicle crit" lines (six success crits → sparkles, six fail crits → dark); the trigger's result list names all 12 crits

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
- [ ] **Fail closed:** a permissions API failure on a `custom`-visibility entity
      gives ownership **NONE** (GM-only), even when `is_private=false`, never OBSERVER.
      Stop Chronicle (or block `/permissions`) while it syncs; players must not see it.

### Visibility Settings (Chronicle Sync → Settings → Players)
These controls drive journal ownership:
- [ ] **dmOnlyHidden ON (default):** a DM-only / private entity gives players no access (NONE); the journal is hidden from a player
- [ ] **dmOnlyHidden OFF:** edit the entity in Chronicle so it re-pulls: players now get it at the default-ownership level. Toggle back ON: they lose it on the next sync
- [ ] **defaultOwnership = Owner:** a player-visible entity's journal default is OWNER (players can edit). **None:** public entities sync as GM-only
- [ ] Per-user grant: an entity shared with one Chronicle user (linked in Settings → Players) gives that Foundry user per-user OWNER/OBSERVER; unmapped users are dropped (under-shares, no leak)

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
- [ ] Dashboard → Linked → Maps → **Resync All Maps** → each Chronicle map is listed under
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
- [ ] A map whose page flags already hold a DM-only marker: **Resync All Maps** strips it

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
- [ ] Dashboard Linked → Maps → the external-link icon on a map row opens the Chronicle map URL

## Calendar Sync

Chronicle owns the calendar; no Foundry calendar module is used. Retired
routes answer 410; an older Chronicle's `503 calendar_rebuilding` pauses date
pushes for 30 seconds with one GM notice (API-CONTRACT.md).

### Calendar window
- [ ] Chronicle scene controls -> **Calendar** button (player and GM) -> first time, Chronicle's Allow window asks about "notes and calendar"; press Allow -> a Foundry window opens with Chronicle's own calendar page: the sky moving, day weather, moons, events
- [ ] A player already connected for the notebook -> **Calendar** opens straight away, no Allow window
- [ ] The first time it opens on a player's screen it fills most of the screen (no squashed month grid), under a slim title bar with no padding or border around the page
- [ ] Player: GM-only events, hidden moons and secret eras never appear (compare with the same player signed in on the site)
- [ ] GM: Chronicle's editing works in the window (add an event, open it, change it); the change shows on the site after a refresh
- [ ] Resize the window from its corner -> the calendar redraws to fit (narrow: one-letter weekdays); close and reopen -> same size and place, per player
- [ ] Click a link to a page inside the calendar -> it opens on the Chronicle site in a new tab, not inside the window
- [ ] Disconnect the Foundry connection in Chronicle's Allow window list -> the calendar window says Chronicle turned it away; Connect brings it back

### Built-in calendar (strip)
- [ ] With Calendar sync on and nothing else changed, no strip shows
- [ ] Configure Settings -> Show Chronicle's calendar on (Calendar look: Strip) -> a thin strip sits at the top centre: date, time and a weather icon over a small sky coloured for the hour; snow, rain or night stars move in it to match Chronicle
- [ ] Hover the strip -> it widens to show season, temperature and moons
- [ ] Drag the strip by its dots anywhere -> it stays there after a reload, and each player's spot is their own
- [ ] Click the lock on the strip -> the dots disappear and the strip (or its small globe) cannot be dragged; click again to unlock. Per player, survives a reload
- [ ] Click the shrink button -> the strip shrinks to a small still globe showing the day; click the globe -> the strip comes back with the month open
- [ ] Leave the mouse still for 20 seconds -> the sky's motion stops; move it -> it starts again
- [ ] Click the date -> the calendar window opens (as above). Not connected and "Not now" -> the small month opens under the strip instead; days up to today show their sky colour and weather icon, later days are plain; event days have a dot and the month's events are listed below; ‹ › flips months; click outside or Esc closes it
- [ ] GM: the small ‹ › arrows move the time one hour; Chronicle's calendar page shows the new time after a refresh
- [ ] GM: on a real-time calendar the arrows are greyed out and Set date is disabled
- [ ] GM: **Set date…** in the month moves Chronicle's date; a date the calendar doesn't have is refused with a warning
- [ ] GM: **Add event** creates the event in Chronicle (check the Chronicle calendar page); "GM only" makes it GM-only there and shows "(GM only)" in the list
- [ ] Player client: the same strip and month, without arrows, Set date or Add event; GM-only events, hidden moons, secret eras and future days' weather never appear
- [ ] Move the date in Chronicle -> the strip updates for the GM and every player
- [ ] A calendar hidden from players in Chronicle -> players see no strip
- [ ] Turn Calendar off in Chronicle Sync → Settings → What syncs -> the strip disappears for everyone without a reload
- [ ] Configure Settings -> Calendar temperature unit °F -> only your strip switches to °F

### Built-in calendar (Sky Clock)
- [ ] Configure Settings -> Calendar look -> **Sky Clock** -> a round glass globe replaces the strip in the top-right corner, left of the sidebar: Chronicle's sky for the hour, the day as a weathered stone number, the month name under it. Other players keep their own look
- [ ] The sky in the globe matches Chronicle's calendar page at the same hour: sun or stars, moons and their phases, the day's weather. A blood moon or eclipse day in Chronicle shows it
- [ ] Snow or rain in Chronicle -> it falls in front of the stone number; fog drifts over it; a storm flashes now and then
- [ ] Rain in Chronicle -> a few faint drops land round the glass rim, slide and fade, never over the number; blood rain reddish, acid rain greenish; clear or fog none
- [ ] Weather on the stone: clear -> plain dry stone with no pale spots; rain -> darker, shiny stone with drops running down; snow -> snow on the tops; fog -> glinting dew; a sandstorm -> sand on the tops; autumn leaves -> a few leaves resting on it; a magic weather (Luminous sky) -> its colour glowing in the cracks. Change the weather in Chronicle -> the old marks fade out as the new ones arrive
- [ ] Drag the globe and let go anywhere -> it swirls and slides into the nearest corner, never under the sidebar, scene controls, player list, hotbar or scene tabs. It is in the same corner after a reload; each player's corner is their own
- [ ] Hover the globe -> a lock and a shrink button appear. Lock -> it can no longer be dragged. Shrink -> it becomes a small still globe; click that -> the full globe comes back
- [ ] Tab to the globe -> arrow keys move it to another corner; Space swirls it
- [ ] Leave the mouse still for 20 seconds -> the globe stops moving; move the mouse -> it starts again
- [ ] GM: click the globe -> a dark cradle slides out under it (over it in a bottom corner) with −1d, −1h, +1h, +1d and the time. +1d -> the stone number crumbles and rebuilds as the next day, and Chronicle's calendar page shows the new date after a refresh. +1h -> the sky glides to the new hour; click +1h several times quickly -> the sun or moon moves steadily to the last hour and never jumps. Click outside or Esc closes the cradle
- [ ] GM: on a real-time calendar the cradle's four buttons are greyed out; the time still shows
- [ ] Player: clicking the globe only swirls it; no cradle
- [ ] Configure Settings -> Motion -> Calm or Off -> the globe is a still picture (weather included) and the day changes without crumbling
- [ ] Move the date in Chronicle -> the globe updates for the GM and every player who picked it
- [ ] Open a shop room after the globe has shown -> the shop still works (both use the same Chronicle scripts)

### Dashboard
- [ ] Calendar tab shows Chronicle's calendar name, date (day, month, year) and time
- [ ] Advance the date in Chronicle -> the tab shows the new date after the next refresh
- [ ] Change weather, season, era or a moon phase in Chronicle -> the world-state panel updates
- [ ] With the announce settings on, a GM-only whisper appears for each change; players never see it
- [ ] Calendar off in Chronicle Sync → Settings → What syncs -> the tab says it is off
- [ ] A campaign with no calendar -> the tab says none is configured

## Shop Widget

- [ ] Right-click JournalEntry linked to Shop entity -> "Open Chronicle Shop" option appears
- [ ] Dashboard Linked → Shops -> each shop row has an **Open** button that opens the same shop room
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
- [ ] Rate limiting enforced (300 req/min default); a 429 pauses the module's REST calls until `Retry-After`

## Character Sync (Actor ↔ Entity)

### Prerequisites
- [ ] Game system matches a Chronicle system (built-in or custom with foundry_path annotations)
- [ ] Characters switched on in Chronicle Sync → Settings → What syncs
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
- [ ] Characters pane visible in the sync dashboard under Linked
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
- [ ] A game system with a Chronicle package that declares `foundry_path` fields (e.g. D&D 5e, PF2e, Draw Steel) -> Chronicle Sync → Problems → Health → Field Mapping shows Adapter loaded and a Character Type
- [ ] Mapped fields sync Chronicle -> Foundry and Foundry -> Chronicle (change one number field each way)
- [ ] Fields with `foundry_writable: false` push to Chronicle only and are not written back to the actor
- [ ] Number fields are cast to numbers; string fields pass through
- [ ] System package with no `foundry_path` on any field -> character sync is off (Characters tab shows no adapter, Problems → Health shows Adapter none)
- [ ] The game system is matched by the Chronicle system's `foundry_system_id` and the system must be enabled for the campaign (Problems → Health → Game System shows both ids); a system that is installed but not enabled shows the "not enabled" message in the activity log
- [ ] When Chronicle is unreachable at load, the last matched system is reused

### Edge Cases
- [ ] Actor sync disabled when no system adapter available
- [ ] Sync guard prevents infinite loops (change in A doesn't re-trigger back to A)
- [ ] Only character-type actors processed (NPCs, vehicles ignored)
- [ ] Only current user's changes pushed (other users' changes ignored)
- [ ] Pre-existing actors can be manually pushed via dashboard Push button

## Creature Sync (Draw Steel creature pages → NPC actors)

Needs Draw Steel in both Chronicle and Foundry, and Creatures switched on in
Chronicle Sync → Settings, under What syncs.
- [ ] A creature page made in Chronicle appears as one NPC actor in the "Chronicle: Creatures" folder, with level, organization, role, keywords, EV, size, Stamina, speed, stability, characteristics and free strike filled in
- [ ] Editing the page in Chronicle updates the actor; editing the stat block on the actor sheet is not sent to Chronicle
- [ ] A keyword Foundry doesn't know, or the Swarm organization, is left blank rather than guessed
- [ ] Damage and conditions on the token stay in Foundry until the page allows sending them back; then they show on the page
- [ ] Deleting the page in Chronicle (live or while Foundry is closed) keeps the actor, only unlinked
- [ ] The actor's Abilities tab lists every ability and villain action from the page. Open a goblin's signature ability, target a hero and use it: one roll, the hero's tier result in chat, with Apply Damage and, where the result has one, Apply Effect
- [ ] An area ability (a burst or cube) shows Place Template; placing it draws the area on the map
- [ ] Drag an ability from the system's compendium onto a synced actor, named like one of the page's: after the next page edit the actor still has just that one, and the GM's copy is unchanged
- [ ] Change a tier on the page in Chronicle: that ability updates on the actor; the others keep their place

## Token Art on Hover

Needs a GM and a player client on the same scene, and a creature actor whose portrait differs from its token (Sync Creatures does this when the page has both art and a token).

- [ ] As the player, rest the cursor on the creature's token: after a moment its full art appears beside the cursor and follows it; moving off the token, clicking or dragging takes it away
- [ ] Near the right or bottom edge of the screen the picture flips to the other side of the cursor and stays on screen
- [ ] A token whose portrait is the same as its token, or the default mystery man, shows nothing
- [ ] GM: right-click the token; the HUD has a portrait button. Click it: the tooltip says off, and the player no longer gets the art for that token. Click again: it's back
- [ ] GM: hide the token, or set its disposition to Secret: the player gets no art; the GM still does
- [ ] Player: Game Settings, Chronicle Sync, untick "Show token art on hover": no more previews for that player only. Bind "Show or hide token art on hover" in Configure Controls: the key switches it with a notice
- [ ] GM: untick "Token art on hover" in the world settings: nobody gets previews
- [ ] Motion Calm: the picture fades in; Off: it appears at once

## Creature Forms (Change Form)

Needs Sync Creatures on, a GM and a player client on the same scene, a Chronicle creature page with a second form (Draw Steel: Add a form on its stat block), and its token on the scene. The GM's Chronicle must have the system-state write route (keyxmakerx/Chronicle#1504) for the page steps.

- [ ] GM: right-click the token; the HUD has a masks button "Change form". A creature with no other forms has none
- [ ] Click it: a window lists the first form and each other form, the current one marked Now and not pickable, with Quiet and Reveal (Reveal picked)
- [ ] Reveal: on both clients the new art grows out of the token, holds, and shrinks back; then the sheet, portrait and token change. Position, conditions and the combat tracker entry stay
- [ ] Chat: everyone sees "<name> becomes <form>"; the GM alone gets the Stamina left
- [ ] Stamina: with "Damage carries over" on the form, a creature that had taken 95 damage keeps it against the new maximum; with "Starts at full Stamina" it is full
- [ ] Quiet: no reveal and no public chat line; only the GM's whisper
- [ ] Hidden token, Reveal: the player sees nothing; the creature's Chronicle page does not list the form for the player
- [ ] Visible token: the player's view of the creature's Chronicle page now lists the form and opens on it
- [ ] Change back to the first form: everything returns; edit the current form on the Chronicle page and the actor follows
- [ ] Motion Calm: the reveal fades instead of growing; Off: the card shows still for a moment

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

- [ ] The scene controls' Chronicle group has a d20 button for the GM; a player's group has only the Satchel and Calendar buttons
- [ ] Click it: a d20 rolls out of the button, lands on 20 and the screen unfolds into three leaves (The world, The party, Rules and reveals); a click or Escape skips the opening
- [ ] The world leaf shows In session / Downtime; pressing the other one asks first, **Cancel** leaves it, confirming switches it and a notice says how many waiting requests went through
- [ ] The party leaf lists each hero on one line; a row expands for detail, with a green dot after "Played by" when that player is on Chronicle now
- [ ] The top strip says how many players are here (hover lists who); with requests waiting, **Waiting on you** lists them and its link opens the Stashes page
- [ ] Rules tab: **Find a condition** filters the list. Reveal tab: **Reveal** on a hidden character makes it visible to players in Chronicle
- [ ] Against a Chronicle without the DM Screen, the window says to update Chronicle; with a wrong key it says the key was not accepted; **Try again** reloads
- [ ] **Cast** lists the scene's tokens that belong to a Chronicle page and no player, hidden ones marked Hidden. Spotlight, Talk as (then Stop talking) and Page do what the token's own buttons do; a player's hero never appears
- [ ] **Party** shows each shared stash with its money and items, **Move things** opens a hero's Stashes window, and each shop's **Open** opens its shop room. With stashes off in Chronicle, it says so

## Encounters (DM Screen tab)

GM only. Needs a Chronicle that serves encounters, a key for the campaign owner or a co-DM, creature sync on (so creature pages have actors), and a scene with a grid open. Plan one fight in Chronicle with a creature of count 3, one planned hidden, one planned seen and one planned "arrives later".

- [ ] DM Screen, **Encounters** tab: the panel widens; fights marked Ready are listed first with their page name and creature count; typing in **Search planned encounters** finds others after a short pause
- [ ] A player-role key or a Chronicle without encounters shows a plain message and **Try again**, not an empty list
- [ ] Open the fight: one row per creature copy ("Hobgoblin Soldier 1", "2", "3"), each with its group and planned start; every row reads **Not placed**; a creature with no actor says "Not in Foundry yet" and its Place is greyed out
- [ ] **Set up the start**, then click the scene: seen and hidden creatures appear on free squares around the click, hidden ones with the hidden look for the GM; the arrives-later ones stay off. Log in as a player in another browser: no hidden token is visible
- [ ] Each placed token is its own copy: damage one and the others keep their Stamina; the token name is the row name
- [ ] **Place** on a row, then click the scene: that one creature lands there, hidden. Clicking **Click the scene** again or pressing Escape cancels
- [ ] **Show** on a hidden row reveals only that token (the player now sees it); **Hide** hides it again; toggling a token with Foundry's own Toggle Visibility changes the row within a moment
- [ ] **Show all hidden (n)** asks in the window first; **Cancel** reveals nothing; **Show them** reveals only this fight's hidden tokens, not other hidden tokens on the scene
- [ ] **Add who's here to the tracker** makes a new combat that is not started, with the placed tokens (in groups A, B, C on Foundry 13 and later); hidden tokens' combatants are hidden in the tracker for a player; rows not on the scene read **Pending**
- [ ] Place a pending row: it joins the tracker, hidden if its token is. Hide or Show a token with Foundry's own control: its combatant follows
- [ ] With a started combat on the scene, **Add who's here** asks first; saying no changes nothing
- [ ] **Undo placing** asks; confirming removes only the tokens this fight placed, other tokens stay
- [ ] Switch scenes with the tab open: the roster reads the new scene (all **Not placed** there) and any waiting scene click is cancelled

Stages (needs the encounter to have stages in Chronicle, a creature with a second form, and Change form working, see Creature Forms):

- [ ] Under the roster, **Stages** lists each stage with when it comes and what it does; a fight with no stages shows nothing new
- [ ] A "half Stamina" stage: damage the creature's token past half: the stage turns **Due**, and one notice says so. **Not yet** sets it back until the next round of the started tracker, then it is due again
- [ ] **Start stage N**: the creature changes form the way the stage says (quiet or reveal); then the scene waits for one click and the arriving rows land there. The stage reads **Started**, and still does after closing and reopening the DM Screen
- [ ] A "round 3" stage turns due at the start of round 3; a manual stage is never due but its Start works any time

## Character claims

Needs the Player Character Claiming addon on in Chronicle, a character linked to an actor, and two players linked to Chronicle members (Chronicle Sync → Settings → Players). Run as the GM.

- [ ] In Chronicle, assign the character to player A -> within a few seconds A is **Owner** in the actor's Ownership settings, and A can open and edit the sheet; nothing about the ownership is sent back to Chronicle
- [ ] Reassign it to player B -> B is Owner, A is still Owner, and the GM sees one notice saying A still owns it and can be changed in the actor's Ownership settings
- [ ] Unassign it in Chronicle -> Foundry ownership is unchanged
- [ ] Assign it to a member with no Foundry user mapped -> no ownership change, one GM notice that the player has no Foundry user, and Chronicle Sync → Settings → Players shows that member as "Owns a character, not linked"; linking them, pressing **Save**, then reconnecting, gives them Owner
- [ ] Reconnect (or Pull All) with a claim that is already applied -> no notice and no ownership change

## Stashes

Needs the Armory addon on in Chronicle, a character linked to an actor, and a player linked to a Chronicle member (Chronicle Sync → Settings → Players).

- [ ] A **Stashes** button is in the title bar of a linked character sheet (players on characters they own, the GM on all); with the Armory off, or on a Chronicle without stash routes, it is absent
- [ ] The window shows the character on the left and a destination on the right, a downtime badge, and Move / History tabs
- [ ] As GM, move an item or an amount of money to another character or a stash -> it happens at once and both sheets update
- [ ] As a player, move something -> "Sent to your GM"; the GM gets a whispered **Stash request** chat card
- [ ] **Approve** on the card -> the card reads "Approved by <name>", the player's window updates and both inventories change; **Turn down** -> "Turned down by <name>" and nothing moves
- [ ] An item moved away from a character in Chronicle disappears from the Foundry sheet; a relation removed any other way only unlinks the Foundry item
- [ ] With no GM connected, a player's move says stashes need the GM to be connected

## Quest Board

Needs a Chronicle with quest boards (a category or a place page with at least one board and a pinned notice) and the GM connected.

- [ ] The Satchel's **Quests** tab shows the boards of the first place with boards, and the drop-down switches places
- [ ] Notices, sticky notes, pinned pages and red strings sit where they do on Chronicle's board; a notice due soon or late says so under it; with more than one board, the arrows turn boards
- [ ] Click a notice -> its quest opens as a paper sheet in the same tab, with **Back to the board**; the GM also sees the ledger under it
- [ ] As GM, tick a step, toggle its eye, change the status -> Chronicle's page shows the same after a refresh; an edit made in Chronicle shows in the open Foundry window without reopening it
- [ ] As GM, **Hand out** with a coin reward and two characters -> each sheet gets its share, with "as a reward for <quest>" in its money history; with an item reward -> the item lands on the chosen character; the ledger reads "Handed out to the party"
- [ ] As a player, the board shows only what Chronicle shows a player: no hidden notices, no hidden steps (a "More steps the party has yet to learn" line instead), no ledger
- [ ] A journal synced from a Chronicle quest page has an **Open quest** button in its header
- [ ] With no GM connected, a player's board says it needs the GM to be connected

## Satchel and notebook

- [ ] Every user (GM and players) has an **Open my Satchel** button (briefcase) in the Chronicle scene controls and a **Jot notes** tab in the bottom-right corner while the world is connected to Chronicle
- [ ] The Satchel opens on the tab it was last left on; **Notebook**, **Quests** and **Stash** switch without reloading the notebook frame
- [ ] A player's **Stash** tab shows their character's Stashes window (move, history, report a problem); a player with no Chronicle character, and the GM, see a line saying where to look instead
- [ ] First use: **Connect to Chronicle** opens Chronicle's Allow window; **Allow** closes it and the player's own Journal appears in the frame
- [ ] A player whose Foundry user is not matched to a Chronicle member sees the "hasn't matched your Foundry login" message; one who allows with a different Chronicle account sees the "isn't the one your GM matched" message
- [ ] Open a Chronicle-linked journal, then the Jot notes tab -> the jots follow the page in view; opening another linked journal moves them
- [ ] Drag the Jot notes tab somewhere else -> it moves and stays closed or open as it was; a plain click still opens and closes it. Drag the open panel by the slim bar on its top edge -> it moves, even across the notebook window; the X closes it. Reload Foundry -> both are where you left them
- [ ] Disconnect the player in Chronicle -> the frame shows "no longer accepts this connection" with a Connect button
- [ ] The old "Chronicle Notes" journal folder, if the world had one, is moved into "Chronicle: removed" on the GM's world load and nothing in it is deleted

## Import Wizard

- [ ] Chronicle Sync → Settings → Connection -> **Setup Wizard** shows a six-step wizard inside the Chronicle Sync window (no second window): Connect, Scan, Types, Tags, Characters, Review; there are no maps or calendar steps. The Connect step fills in its checks (connection, page types, game system) on its own
- [ ] In a world with no connection, Chronicle Sync opens on "Set up Chronicle in this world" with the five steps listed and the connection settings below. Save a connect line and reload: Chronicle Sync opens on the wizard. **Skip setup** returns to the four sections and the wizard does not reappear on the next open
- [ ] Tags and Characters steps are skipped when tags are unavailable or no game system matched
- [ ] Review lists what will be created; running it creates the entities and marks the wizard completed

## Problem reports (privacy, module #94)

Needs a GM client and a player client, on each of Foundry v12, v13 and v14.

- [ ] As a player, open a character's Stashes window, click "Report a problem", send text: "Sent to your GM"; the GM sees "{name} reported a problem" and the Problems badge goes up
- [ ] In the GM's Journal sidebar there is no "Chronicle: problem reports" entry
- [ ] In the player's browser console, `game.journal.find(j => j.getFlag("chronicle-sync", "problemReportsStore"))` returns `undefined`, and `game.journal.contents.some(j => j.name.includes("problem reports"))` is `false`
- [ ] As the GM, the same first console line returns the entry, and its `flags["chronicle-sync"].reports` lists the report
- [ ] Reload the GM client: the report is still there and no second entry was made
- [ ] The entry does not appear in the Import wizard's journal list or the dashboard's Foundry-only journals, and nothing was pushed to Chronicle

## Error Recovery

- [ ] Invalid API key shows clear error message
- [ ] Network timeout during sync doesn't corrupt state
- [ ] Partial sync failure (one entity fails) doesn't block others
- [ ] A Chronicle restart reconnects without a reload
- [ ] A failed Foundry→Chronicle push (Chronicle down) shows a `ui.notifications.warn` to the GM and an error-log row; journal updates are queued and re-pushed on reconnect

### Catch-up after a closed world
- [ ] Close Foundry, edit a page and a character in Chronicle, change a character's inventory there, then reopen the world -> the page, the character and the inventory change appear without Resync All
- [ ] Delete a page in Chronicle while Foundry is closed, then reopen -> its journal is set aside in the "Chronicle: removed" folder, not deleted
- [ ] Against an older Chronicle with no change feed, reopening still catches up (a full rescan; slower)
- [ ] Remove a "Has Item" relation in Chronicle -> the Foundry item is unlinked from Chronicle but not deleted from the character

### Reconnect re-pull
Edits made on Chronicle while Foundry was disconnected arrive after reconnect, without a world reload.
- [ ] Disconnect (stop Chronicle or pull the network) until the status pill goes red/yellow, then rename an entity or change its content in Chronicle
- [ ] Reconnect: after about 3 s the change appears in Foundry with no reload, and the activity log reads "Reconnected — re-pulled changes made during the disconnect"
- [ ] Rapid disconnect/reconnect cycles trigger one re-pull once the link settles, not one per reconnect

## Sync Dashboard

The Chronicle Sync window is a left rail of four sections: Overview, Linked
(Entities, Characters, Maps, Shops and Calendar panes), Problems (Health,
Player reports and History panes) and Settings (at the foot, set apart).

### Access
- [ ] Open the Chronicle group in the scene controls: no button in it looks pressed, and only its buttons appear (no blank slot). Press Chronicle Sync → dashboard opens; press it again after closing → opens again. Click Tokens, then back to the Chronicle group → nothing opens on its own
- [ ] Click the sidebar status indicator (when connected) or the Chronicle Sync button in the scene controls → dashboard opens (GM only); right-click on the indicator opens it even when disconnected; clicking while disconnected tries to reconnect
- [ ] With URL, key or campaign ID missing, the window shows "Chronicle Sync is not configured" and the Settings form under it, with no rail
- [ ] It opens to the last-active section and pane; an unknown saved tab falls back to Overview, and a tab saved by an older version opens where its content now lives (Maps → Linked, Maps; Diagnostics → Problems; Status → Problems, Health; Issues → Linked, Characters)
- [ ] Configure Settings → Chronicle Sync → **Open Chronicle Sync settings** opens the window at Settings (or brings it forward there)
- [ ] Settings: change a field, let the window re-render (e.g. a player sends a report) → the change is still there; **Undo changes** puts the saved values back; **Save** saves and says so; arrow keys move along every pane strip
- [ ] A tab that fails to load shows a "Some data failed to load" banner naming the tab, with **Retry**

### Tabs
Details for Characters, Maps, Shops and Calendar are under their own sections.
- [ ] **Overview:** connection banner (green/yellow/red) with **Reconnect** when not connected; stat tiles (Entities Synced, Characters Synced n/total, Maps Linked) each jump to their tab; "Needs Attention" lists only real problems, each row jumping to the fixing tab, or says "Everything's in sync"; **Sync Everything Now**, **Problems** and **Refresh** work; below: the DM-only note when any were hidden, last sync time, Recent Activity, **Clear Log**
- [ ] **Entities:** list grouped by type with status dots, Pull/Push per row, Pull All / Push All, Resync All Journals, visibility toggle, search, bulk select (Make Public / Private / Delete / Change Type), **Create Type**
- [ ] **Characters:** a "Needs a match" list comes first when any character can't be matched (the rail shows its count); each row offers "Match to existing…" with **Match**, and **Create new**, and resolving a row links it and removes it
- [ ] **Calendar**, **Shops**, **Maps:** as in their sections; the Calendar pane explains why when sync is off, no calendar exists, or it is rebuilding or unreachable; Shops empty states say whether the "Shop" type is missing or has no shops
- [ ] **Problems:** Health / Player reports / History switch; the badge counts new player reports. Health: Game System, Connection, Field Mapping, Sync Capability (pick an actor; **Copy** report and JSON), Error Log, Diagnostic Bundle and System Debug Export copy

### Layout Persistence
- [ ] Switch to Linked → Maps, close the window, reopen -> Linked → Maps still open
- [ ] Collapse an entity type group, reload Foundry -> group still collapsed
- [ ] A different browser/user has independent layout preferences (they are client settings)

### Entity Type Creation
- [ ] "Create Type" button visible in Entities tab toolbar
- [ ] Click -> Dialog with name, plural name, icon and color fields
- [ ] Submit with name "Quest" -> type created, dashboard refreshes
- [ ] New type appears in bulk "Change Type" dropdown
- [ ] Cancel/close without name -> no API call, no errors

### Settings (in Chronicle Sync)
- [ ] Configure Settings shows Chronicle's button and only the calendar strip, Motion and temperature unit; the button opens Chronicle Sync at Settings, with panes Connection, What syncs, Calendar, Players and Advanced (GM only)
- [ ] **Players:** one row per Chronicle member with a Linked / Not linked badge and a Foundry player dropdown; change one, press **Save**, reopen -> the change stuck and the other links are unchanged; **Fetch members again** re-reads the list
- [ ] **What syncs:** the new-journal page type lists Chronicle's page types; pick one, **Save**, then make a journal in Foundry -> the Chronicle page has that type
- [ ] **Connection:** **Setup Wizard** shows the import wizard in the same window; the API key field is always empty, with "Saved in this browser" when a key exists
- [ ] Overview -> "campaign member(s) not mapped" opens Settings → Players
- [ ] A dashboard last left on the old Config or Members tab opens on Overview

### Test Connection (Multi-step, Chronicle Sync → Settings → Connection)
- [ ] Test with valid config -> Shows: API reachable ✓, Auth OK ✓, Campaign ✓, System match ✓
- [ ] Test with wrong URL -> "Unreachable: Chronicle not responding at {url}"
- [ ] Test with wrong API key -> "Auth failed: API key invalid or revoked"
- [ ] Test with wrong campaign ID -> "Campaign not found"
- [ ] Test with CORS issue -> Shows origin URL and whitelist instructions
- [ ] Test with system not matched -> Shows available foundry_system_ids

### Problems
- [ ] Health metrics: Uptime, API OK, API Errors, Reconnects, Last Success, Last Error
- [ ] Error log: recent errors (up to 50) with timestamp, method, path, status
- [ ] Retry queue: failed writes queued and processed on reconnect (Problems → Health → Pending Retries drains to 0)
- [ ] Activity log: recent sync actions (up to 100 kept, newest first) with color-coded type icons
- [ ] Problems → Health → **Copy Diagnostic Bundle** puts a Markdown report (versions, connection health, sync state, field mapping, recent activity and errors) on the clipboard; it contains no API key
- [ ] Clear log button resets the Overview's recent activity
- [ ] Reconnect button (Overview, when disconnected) triggers manual WebSocket reconnection
