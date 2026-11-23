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
- [ ] Hover the indicator while connected: the tooltip ends "Last change from Chronicle: N minutes ago" (or "No changes from Chronicle since connecting"), and the time moves on between hovers
- [ ] Settings → Connection: change the API key to a wrong one and Save -> no reload asked; Test connection runs by itself and its steps show the key refused. Put the right key back and Save -> the steps go green and the dot turns green without a reload, with no "Connection lost" toast
- [ ] On a world that was never connected, paste a connect line and Save -> sync starts without a reload (journals come in)
- [ ] Change the campaign to another one and Save -> a toast asks to reload Foundry to switch campaigns
- [ ] Settings → Advanced → When both sides changed: each choice shows one line under it saying which edit is replaced
- [ ] Edit the same journal in Chronicle and Foundry with "Newest wins" -> no toast; Chronicle Sync → History shows the conflict and which side was kept. With "Chronicle wins" or "Foundry wins" -> a toast names the journal and the side kept
- [ ] WebSocket auto-reconnects after network interruption (wait 30s)
- [ ] Message queue drains after reconnection

## Motion

- [ ] Configure Settings → Chronicle Sync shows Motion (Full, Calm, Off) beside the calendar, calendar look and temperature unit; on a computer set to reduce motion, a new client starts on Calm
- [ ] Full: the dashboard grows out of the scene-control button that opened it; switching dashboard sections and settings tabs settles the new panel in; Test connection's checks appear one after another
- [ ] Calm: each of those is a short fade in place, and the GM Screen fades in instead of rolling its die. Off: windows, panels and checks appear at once, the GM Screen opens and closes without its die or fold, and nothing in a Chronicle window animates
- [ ] With reduce motion on and Motion left on Calm, Foundry's own windows and other modules animate as they did before Chronicle

## Keyboard shortcuts

- [ ] Configure Controls lists a Chronicle Sync group with five shortcuts (Chronicle Sync, GM Screen, Satchel, calendar, token art on hover), all with no key bound
- [ ] Bind a key to "Open the Chronicle Sync dashboard", press it as the GM: the dashboard opens; as a player the GM-only two are not listed
- [ ] With the world not connected, a key bound to the notebook does nothing and Foundry's own use of that key still works

## Dice So Nice

- [ ] Without Dice So Nice installed: roll `/r 1d20` as GM and as a player; both get Foundry's normal roll card and no console errors. Chronicle Sync → Problems → Health shows Dice So Nice "Not in use"
- [ ] With Dice So Nice 6.x on: the same pane shows "Working", the version, and "calls for adding dice are all there"; "Check dice files" adds "All N dice files are where they should be" (or "No rune dice sets are shipped" while the list is empty)
- [ ] With rune sets shipped: Dice So Nice's settings (the dice icon in chat) list a "Chronicle Rune" group under dice and themes, on a player's client too
- [ ] A player with Dice So Nice turned off in its own settings, or with Foundry's canvas off, still sees the roll card
- [ ] Dice So Nice's settings → Special Effects: a new player has two "Chronicle crit" lines (twelve success crits → sparkles, twelve fail crits → dark); the trigger's result list names all 24 crits

## Journal Sync (Pages)

### Chronicle -> Foundry
- [ ] Create page in Chronicle -> JournalEntry appears in Foundry
- [ ] Update page name -> JournalEntry name updates
- [ ] Update page entry (rich text) -> JournalEntry pages update
- [ ] Toggle page privacy -> JournalEntry ownership changes
- [ ] Delete page -> JournalEntry set aside (unlinked, in the "Chronicle: removed" folder), never deleted

### Foundry -> Chronicle
- [ ] Create JournalEntry -> Page appears in Chronicle
- [ ] Update JournalEntry name -> Page name updates
- [ ] Edit JournalEntry page content -> Page entry updates
- [ ] Delete JournalEntry -> asked "Delete in Chronicle too?": No keeps the page, Yes deletes it. After No, Chronicle Sync → Linked → Pages shows the page as "Only in Chronicle, sync off" and does not bring it back by itself; **Bring in** on that row brings it back and turns its sync on again
- [ ] Delete several linked JournalEntries at once -> asked once, with all of them listed
- [ ] Clear all the text of a linked JournalEntry -> the Chronicle page's text is empty too
- [ ] Right-click a linked JournalEntry -> Duplicate -> a second page appears in Chronicle; editing the copy changes only that second page
- [ ] As a player matched to a Chronicle member who may edit the page there, edit the linked journal's text -> with a GM in the game, the Chronicle page updates
- [ ] The same edit by a player Chronicle does not let edit the page, or on a page with GM-only text -> nothing changes in Chronicle and the GM gets one notice saying why

### A player's own creates, and the GM card for the rest
Needs a player client matched to a Chronicle member (Settings, Players), a GM in the game, and a Chronicle with a Trash.
- [ ] As the player, create a journal -> a page appears in Chronicle under the Notes page type (or the type set in Settings), and no card is posted
- [ ] As the player, delete that journal -> the page is gone from Chronicle's list and shows in the campaign Trash; Restore brings it back; no card, no GM prompt
- [ ] As the player, create an actor -> a character page appears; with the claiming add-on on it is under Player Characters and assigned to that player
- [ ] As the player, delete a character they have claimed in Chronicle -> it goes to the Trash with no card. Delete one they have not claimed -> a whispered card reads "Mira deleted the character X" with Send to Chronicle and Not now; only the GM sees it
- [ ] As the player, drag an item that is linked to a visible Chronicle item page onto their claimed character -> a "has item" entry appears on the character's page with no card. Onto someone else's character -> a card "Mira added Rope to Sela"; nothing in Chronicle until Send is pressed, then the entry appears and the card reads "Sent by you"
- [ ] The same drag of an item linked to a GM-only page -> nothing is sent and no card appears
- [ ] Remove an item from someone else's character as the player -> a card; Send removes the entry in Chronicle. Not now leaves it and the card reads "Left alone by you"
- [ ] As the player, rewrite a deleted journal's link to a different page (console: `journal.setFlag('chronicle-sync','entityId',...)` before deleting) -> no direct delete; the card's Send shows "In Chronicle this is the page X. Send it anyway?" and waits for a second press
- [ ] A player posting a chat message with the card's markup gets no working buttons for anyone

### A player's hero picks (security)
Needs a Draw Steel world, a player client matched to a Chronicle member who claimed a hero, and a GM in the game.
- [ ] Draw Steel world, Chronicle with a hero-choice rule marking a class "Not here" for the player: as that player, drag that class onto their claimed hero, then change stamina -> Chronicle takes the stamina and keeps the old class; the GM gets one notice naming why; the player's class item stays in Foundry; changing stamina again repeats no notice
- [ ] Same player, an allowed class and stamina -> both reach Chronicle, no notice

### Multi-Page Sync
- [ ] Page with h1/h2 headings creates multiple Foundry journal pages
- [ ] Page without headings creates single "Content" page
- [ ] Multi-page Foundry journal concatenates into single Chronicle entry
- [ ] Updating the Chronicle page's content adds/removes/updates the journal's pages correctly
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
- [ ] Private page (is_private=true) creates journal with default ownership NONE
- [ ] Public page (is_private=false) creates journal with default ownership OBSERVER
- [ ] Custom visibility page fetches permissions and maps role grants to ownership
- [ ] Custom visibility with player view grant → default OBSERVER
- [ ] Custom visibility with no player grant → default NONE
- [ ] Changing journal ownership in Foundry pushes is_private to Chronicle
- [ ] Changing journal ownership pushes visibility/permissions to Chronicle API
- [ ] **Fail closed:** a permissions API failure on a `custom`-visibility page
      gives ownership **NONE** (GM-only), even when `is_private=false`, never OBSERVER.
      Stop Chronicle (or block `/permissions`) while it syncs; players must not see it.

### Visibility Settings (Chronicle Sync → Settings → Players)
These controls drive journal ownership:
- [ ] **dmOnlyHidden ON (default):** a GM-only / private page gives players no access (NONE); the journal is hidden from a player
- [ ] **dmOnlyHidden OFF:** edit the page in Chronicle so it is fetched again: players now get it at the default-ownership level. Toggle back ON: they lose it on the next sync
- [ ] **defaultOwnership = Owner:** a player-visible page's journal default is OWNER (players can edit). **None:** public pages sync as GM-only
- [ ] Per-user grant: a page shared with one Chronicle user (linked in Settings → Players) gives that Foundry user per-user OWNER/OBSERVER; unmapped users are dropped (under-shares, no leak)

### Edge Cases
- [ ] Rapid successive edits don't create duplicate pages
- [ ] Sync guard prevents infinite loops (edit in A, syncs to B, doesn't re-sync to A)
- [ ] Monk's Enhanced Journal: content syncs correctly if module active

## Map Sync (Journal Map Viewer)

Each Chronicle map becomes a JournalEntry (one image page) in a "Chronicle Maps"
folder, drawn by the Chronicle Map Viewer sheet with markers, drawings, tokens,
layers and fog as overlays. Drawings, tokens, layers and fog are read-only in
Foundry; markers are editable by the GM. Needs "Sync Maps" on and a Chronicle
campaign with at least one map that has an image, markers (some `Everyone`, one
`DM only`), and ideally a drawing, a token and a fog region.

### Bring maps in
- [ ] Dashboard → Linked → Maps → **Sync all maps again** → each Chronicle map is listed under
      "Chronicle Maps" with marker / drawing / token counts and an **Open in Foundry** button
- [ ] **Open Chronicle Maps Folder** reveals the "Chronicle Maps" folder in the Journal sidebar
- [ ] The summary row shows In Foundry count, Open viewers and Last sync (not "never")
- [ ] Click **Open in Foundry** → the map opens in the Chronicle Map Viewer (image plus overlays, zoom % bottom corner)
- [ ] A map with no image does not break Sync all maps again (a row appears under recent errors instead, **Dismiss** clears it)
- [ ] After syncing all maps again, wait 20 minutes, then open a map as a player who has never opened it -> the picture shows (it is a copy in the world's `chronicle-media` folder, not a Chronicle link)
- [ ] Share a map's journal with a player, open it as the GM and note its picture address (right-click the image -> copy image address; it ends in `chronicle-media/<id>.<ext>`). Add a shadow to the map in Chronicle. Open that address in a private browser window -> a blank page or one transparent pixel, not the map. Broken: the full map still shows
- [ ] A map whose journal no player can open: its picture address stays a Chronicle link (`/media/...?sig=...`), not a `chronicle-media` file
- [ ] Press **Sync all maps again** twice → no duplicate journals or folders

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
- [ ] In that dialog set Visibility to **GM only** → Save → the marker shows the GM-only style for the GM and Chronicle shows it as DM only
- [ ] **Delete Marker** → confirm → marker is removed in Chronicle
- [ ] Double-click a marker that has a linked page → the page's journal opens
- [ ] Stop Chronicle, then save a marker edit → an error toast ("Failed to update marker on Chronicle") and the viewer keeps the old value
- [ ] Viewer toolbar **Sync this map again from Chronicle** re-fetches the map; **Open in Chronicle web editor** opens the map URL

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
- [ ] As GM, all of them show in the viewer (GM-only marker with the GM-only style; fog as a dark overlay)
- [ ] As the player, open the same map: only the `Everyone` marker and unrestricted drawings and tokens show
- [ ] As the player, the `DM only` marker, the user-restricted marker/drawing, the hidden token and the fog overlay are all absent
- [ ] As the player, F12 console: `game.journal.getName("<map name>").pages.contents[0].flags["chronicle-sync"]` — its `chronicleMarkers` list holds no `DM only` or restricted marker, and no fog data is present
- [ ] Right-click on a marker as the player does nothing (no config dialog); the Place Chronicle marker tool is absent
- [ ] Change a visible marker to `DM only` in Chronicle while the player has the map open → it vanishes from the player's view and from the page flags after the next sync
- [ ] Change it back to Everyone → it reappears for the player
- [ ] A map whose page flags already hold a GM-only marker: **Sync all maps again** strips it

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

- [ ] Right-click JournalEntry linked to Shop page -> "Open Chronicle Shop" option appears
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

## Direction and Sync now

In **Chronicle Sync → Settings → What syncs**.

- [ ] Set Journals to **From Chronicle only** and save. Edit a synced journal in Foundry, rename it and make a new journal: none of it reaches Chronicle. Edit the page in Chronicle: the journal updates.
- [ ] Set Journals to **From Foundry only** and save. Edit the page in Chronicle: the journal in Foundry does not change, also not after a reload. Edit the journal in Foundry: the page updates.
- [ ] Repeat both with Characters, using a sheet field and an inventory item.
- [ ] Set Maps to **From Chronicle only**. Open a map and try to add, move and delete a marker: each is refused with a notice and Chronicle keeps its markers.
- [ ] With Journals From Foundry only, the dashboard's **Pull All**, **Resync All Journals** and a single page's pull are refused with a notice; with Journals From Chronicle only, **Push All** and a single journal's push are refused.
- [ ] Calendar offers only **Both ways** and **From Chronicle only**; Shops offers no direction. With Calendar From Chronicle only, setting the date and adding an event in Foundry are refused with a notice.
- [ ] Switch **Sync changes as they happen** off and save. Edit a journal and a character in Foundry and a different page in Chronicle. Nothing moves; Settings shows how many changes are waiting and a **Sync now** button. The calendar and shops still update as before.
- [ ] Reload Foundry: the waiting count is still there.
- [ ] Click **Sync now**: the Foundry edits reach Chronicle, the Chronicle edit reaches Foundry, and the count returns to nothing waiting.
- [ ] Make another edit, then switch **Sync changes as they happen** back on and save: the waiting edit is sent without pressing Sync now.
- [ ] With live sync off, delete a synced journal in Foundry and answer the question to remove the page too: the page is removed only when you press Sync now.

## Initial Sync

- [ ] Fresh connection triggers initial sync (GET /sync/pull)
- [ ] Existing pages create proper sync mappings
- [ ] Existing Chronicle maps are materialized as journals in the "Chronicle Maps" folder
- [ ] lastSyncTime updates after successful initial sync

## Permission & Security

- [ ] API key with read-only permission can't write via sync
- [ ] API key scoped to campaign A can't access campaign B data
- [ ] Against a Chronicle that answers calendar routes with `503 calendar_rebuilding`: the dashboard Calendar tab says the calendar is being rebuilt and does NOT claim "No calendar configured"
- [ ] Maps / actors / items / notes still sync while the calendar is down
- [ ] Disabled maps addon -> Maps API returns 404
- [ ] Private pages hidden from non-owner API keys
- [ ] Rate limiting enforced (300 req/min default); a 429 pauses the module's REST calls until `Retry-After`

## Character Sync (Actor ↔ Page)

### Prerequisites
- [ ] Game system matches a Chronicle system (built-in or custom with foundry_path annotations)
- [ ] Characters switched on in Chronicle Sync → Settings → What syncs
- [ ] Character page type exists in Chronicle campaign

### Chronicle -> Foundry
- [ ] Create character page in Chronicle -> Actor (type: character) created in Foundry
- [ ] Update character page fields -> Actor system data updates (ability scores, HP)
- [ ] Update character page name -> Actor name updates
- [ ] Delete character page -> Actor unlinked (flags removed) but NOT deleted

### Identity items (Draw Steel: ancestry, culture, career, kit)
- [ ] In Chronicle, set an actor's linked character to an ancestry that exists in the system compendium (e.g. Dwarf) -> within a few seconds the Foundry sheet shows the Dwarf ancestry item in place of the old one (data from the compendium); the Chronicle value does not change
- [ ] Same with an ancestry that exists as an Item in the world's Items sidebar -> the world item is used
- [ ] Pick a name that exists nowhere (a campaign's own entry) -> a plain item with that name appears on the sheet
- [ ] Culture, career and kit behave the same way
- [ ] Clear the value in Chronicle -> the Foundry item stays
- [ ] Class, subclass and level changed in Chronicle do not touch the Foundry sheet
- [ ] Nothing in the Dashboard activity log or Chronicle's sync history shows the item swap coming back as a Foundry change
- [ ] As a non-GM player nothing is swapped on their client (only the GM's client applies it)

### Chronicle hero sheet (Draw Steel)
Needs Draw Steel 1.1.0 or later; on an older Draw Steel the sheet is not offered. Pick it on a hero: open the hero, title bar menu (three dots) -> Sheet -> Sheet: "Chronicle hero sheet" -> Save. Draw Steel's sheet stays the world's default.
- [ ] The hero opens with the portrait, name, "Level N · class · subclass", origin chips (a missing one dashed, "Still to choose"), Level, XP and Victories; below, the characteristic and combat boxes, Stamina with its bar, recoveries, the heroic resource and surges, then potency, damage, conditions and skills; then the tabs, Abilities open
- [ ] Light and dark interface themes both read cleanly
- [ ] Insight, Surges and the epic resource each show their number in their box, and no stray line runs over the Stamina, Temporary or Recoveries numbers
- [ ] Click a characteristic box -> Draw Steel's roll dialog for it
- [ ] Type a new Stamina, temporary Stamina, recoveries, heroic resource or surges value -> it saves; the bar turns amber at or under the winded figure and red at 0 or less
- [ ] Hero token, recovery heart and surge bolt buttons do what they do on Draw Steel's sheet
- [ ] An active effect that sets one of those values greys its field out, as on Draw Steel's sheet
- [ ] Take Respite, and Level up when it shows, work
- [ ] Abilities: use one, its three-dot menu, right click, unfold its description, drag to reorder; Features, Equipment, Projects, Effects and Biography tabs work as on Draw Steel's sheet; drop a treasure on Projects -> it becomes a project
- [ ] Scroll down -> the tab row stays pinned at the top; change Stamina while scrolled -> the page stays where it was
- [ ] Press Tab until Stamina's number is reached -> a clear accent ring shows around it
- [ ] Edit mode (padlock in the title bar): the name field, origin chips with remove and add, XP and Victories fields, and Draw Steel's characteristic, combat, movement, damage and skill editors
- [ ] A player who owns the hero sees the same; an Observer cannot roll or change values; a Limited viewer sees only the header (picture, name, class, origins, level, XP and victories), the tab row and the Biography tab, as on Draw Steel's sheet
- [ ] Title bar: beside the padlock, a Fold button (two arrows) and a Sheet look button (palette)
- [ ] Fold -> the window shrinks to a small card: picture, name, "Level N · class", the Stamina bar and number, recovery marks, the five characteristics, then Abilities, Respite and Open. Drag it beside the map
- [ ] With the card out, damage the hero's token on the map -> the card's Stamina changes within a moment, without the card moving; the bar turns amber at the winded figure
- [ ] Click a characteristic on the card -> Draw Steel's roll dialog for it; Respite -> Draw Steel's respite
- [ ] Abilities on the card -> the full sheet, on the Abilities tab; Open -> the full sheet at the size and place it had before folding
- [ ] Close the card and open the hero again -> it opens as the card, where it was left. A second player on another computer still gets the full sheet until they fold it themselves
- [ ] Sheet look -> a menu headed "Sheet look for <hero>": "Chronicle", ticked and marked "now", "The portrait hall", "Steel and banner", "Arcane glass", "The gilded card", "Night sky", a line, then "Draw Steel's own sheet". With Draw Steel Plus switched on, "Draw Steel Plus", marked "found installed", sits above it. Arrow keys move, Escape closes it and puts focus back on the palette button, a click elsewhere closes it. In every look the menu is solid: nothing of the sheet shows through it
- [ ] Pick "Draw Steel's own sheet" -> the window closes and the hero opens in Draw Steel's sheet (come back through Sheet configuration). With Draw Steel Plus on, pick it -> the hero opens in Draw Steel Plus's sheet
- [ ] Click the portrait -> a menu: "See the full picture" (the GM can show it to everyone from there), "See the token" (for owners, when the hero has its own token picture), and "Change picture or token", which opens the hero's Chronicle page in a pop-up window. That last row shows only on a hero linked to Chronicle, for the GM or a player whose Foundry user is linked to a Chronicle account
- [ ] In Edit mode, the portrait menu starts with "Choose a picture file" -> Foundry's file picker; the picked picture becomes the portrait
- [ ] An Observer has Fold but no Sheet look button, and the portrait menu shows only "See the full picture"; a Limited viewer has neither button, never gets the card, and gets the same one-row portrait menu
- [ ] With the sheet open on a player's screen, the GM changes that player's permission on the hero (Limited, Observer, Owner) -> Fold and Sheet look appear and disappear to match; a player lowered to Limited while the card is out gets the Limited view, with no card left behind
- [ ] Fold, open, the two menus and picking a look change nothing in Chronicle: the hero's history in Chronicle shows no new entry
- [ ] Switch the hero back to Draw Steel's sheet -> Draw Steel's sheet, nothing lost
- [ ] On a world with Draw Steel older than 1.1 (if one is to hand): the Sheet list has no "Chronicle hero sheet"

#### The portrait hall look
Open a hero in the Chronicle hero sheet, then palette button in the title bar -> "The portrait hall".
- [ ] The window grows to about 1100 by 760 and turns black and gold: the hero's picture fills the left, with "Level N · class · subclass", the name, the origins, XP, Victories and Take Respite over its foot, a thin gold frame round the window; on the right the Stamina ring, recoveries, heroic resource and surges as rows of diamonds, the combat line, five six-sided plaques and the skills; the tabs run down a gold rail on the far right, Abilities open
- [ ] On first opening, the picture fades up and the name and boxes rise in turn, all within about a second and a half; set Motion (module settings) to Calm -> only fades; Off -> no movement at all. The same with the computer's "reduce motion" setting on
- [ ] Pictures: try a bright picture, a wide landscape picture and a hero with no picture of its own. The name stays readable over the bright one, the wide one fills the left without stretching, and with no picture a gold shield outline stands in
- [ ] A long name (about 20 letters) wraps between words, never mid-word, and stays readable over the picture
- [ ] Foundry's light theme: the hall stays dark and readable; switch the hero back to "Chronicle" -> the light look returns
- [ ] Plaques: a characteristic of 2 or more is gold, 1 bronze, 0 or less iron; hover lifts a plaque; click it -> Draw Steel's roll dialog
- [ ] With no temporary Stamina, damage the hero (its token on the map, or type a lower Stamina) -> the picture jolts, its edges flash red and the Stamina number thumps; at or under the winded figure the ring turns amber and says "Winded", at 0 or less red and "Dying". Heal it -> the ring glows for a moment and turns back to green
- [ ] With Level up showing, the level glints; level the hero up -> a gold light sweeps across the window
- [ ] Type in Stamina, temporary Stamina, recoveries, heroic resource and surges -> each saves; the hero token, recovery heart and surge bolt buttons work as on Draw Steel's sheet
- [ ] Drag the window narrower: about 820 wide everything still fits beside the picture; under about 760 the picture becomes a banner across the top, the boxes go under it and the tabs become a row
- [ ] Every tab (Abilities, Features, Equipment, Projects, Effects, Biography) works as on Draw Steel's sheet, in black and gold; ability names have room beside Cost, Distance and Target
- [ ] Edit mode (padlock): the name field, origins with remove and add, XP and Victories fields, and Draw Steel's editors on the right, rising in one after another
- [ ] Fold -> the card in black and gold, with all five characteristic names readable; Open -> the hall again, at its size
- [ ] Press Tab through the sheet -> a clear gold ring shows on each plaque, button and field
- [ ] A Limited viewer sees the hall's picture, name, class, origins, level, XP and victories, the tab rail and Biography, and nothing else; when the GM damages or heals the hero, the picture doesn't jolt or flash for them
- [ ] Module settings now show "Default hero sheet look" and "Lock hero sheet looks" (GM only). Set the default to "The portrait hall" -> a hero that never picked a look opens in the hall. Turn the lock on -> every hero shows the default look; the Sheet look menu greys out the other looks with a note ("Your GM has set the look for every hero" for a player, "Locked to the world's default look in the module settings" for the GM), and "Draw Steel's own sheet" still works for both
- [ ] Picking the hall changes nothing in Chronicle: the hero's history in Chronicle shows no new entry

#### The steel and banner look
Open a hero in the Chronicle hero sheet, then palette button in the title bar -> "Steel and banner".
- [ ] The window grows to about 1100 by 760 and turns to dark steel with a thin frame and rivets: a red banner down the left with the hero's picture in a gold shield, the level medal, the class and subclass; the name in capitals with the origins, XP, Victories and Take Respite; a red Stamina blade, pips for recoveries, the heroic resource and surges, five shields, Movement and Combat plates and the skills; the tabs as slanted plates, Abilities open and amber
- [ ] The banner sways slightly and holds still with Motion on Calm; on first opening it unfurls, the name and blade slide in and the shields drop in turn, within about a second and a half; Calm -> only fades; Off -> no movement at all. The same with the computer's "reduce motion" setting on
- [ ] Pictures: try a bright picture, a wide landscape picture and a hero with no picture of its own. Each stays inside the shield, and with no picture a gold emblem stands in
- [ ] A long name (about 20 letters) wraps between words, never mid-word
- [ ] Foundry's light theme: the sheet stays dark and readable; switch the hero back to "Chronicle" -> the light look returns
- [ ] Shields: hover turns the rim amber, a press sinks it, click -> Draw Steel's roll dialog
- [ ] Damage the hero -> the plate jolts, the blade flashes white and drops in notches with sparks off its tip; at or under the winded figure the blade turns amber with a "Winded" tag, at 0 or less a "Dying" tag and a grey banner. Heal it -> a shine runs along the blade
- [ ] With Level up showing, an amber arrow, a glow and a gentle rock show on the medal; level the hero up -> the medal spins, the banner is hoisted, the tabs clack down and the shields drop in again
- [ ] Type in Stamina, temporary Stamina, recoveries, heroic resource and surges -> each saves; the Stamina (hero token), Recoveries and Surges labels work as on Draw Steel's sheet; Take Respite works
- [ ] Drag the window narrower: about 820 wide everything still fits; under about 760 the banner becomes a pennant across the top and the boxes and tabs go under it; no sideways scroll down to about 640
- [ ] Every tab works as on Draw Steel's sheet, in steel and amber
- [ ] Edit mode (padlock): the name field, origins with remove and add, XP and Victories fields and Draw Steel's editors, sliding in one after another
- [ ] Fold -> the card on steel with a short banner picture and all five characteristic names readable; Open -> the full sheet again
- [ ] Press Tab through the sheet -> a clear ring or bar shows on each shield, label, tab, button and field
- [ ] A Limited viewer sees the banner, name, class, origins, level, XP and victories, the tab row and Biography, and nothing else; no jolt or shine when the GM damages or heals the hero

#### The arcane glass look
Open a hero in the Chronicle hero sheet, then palette button in the title bar -> "Arcane glass".
- [ ] The window grows to about 1100 by 760 on a dark violet field with a wine-red glow top left and a plum glow bottom right: one frosted glass panel with the hero's picture in a teal ring that is also the Stamina gauge, "Level N · class · subclass", the name, the origins, XP and Victories, Take Respite as a pill top right, a row of tracker boxes, five hexagons and Skills and Combat cells; a floating pill of tabs under it, Abilities open
- [ ] The glass blurs the field: the faint grid is crisp beside the panel and soft inside it
- [ ] On first opening, the panel settles into focus out of a blur and the hexagons pop in one by one, within about a second and a half; set Motion (module settings) to Calm -> only fades, the lights and ring do not move, a hit only tints the panel rose and nothing scales; Off -> no movement at all. The same with the computer's "reduce motion" setting on
- [ ] Pictures: try a bright picture, a wide landscape picture and a hero with no picture of its own. The bright one stays inside the ring, the wide one fills the circle without stretching, and with no picture a teal hexagon rune stands in
- [ ] A long name (about 20 letters) wraps between words, never mid-word
- [ ] Foundry's light theme: the look stays dark and readable; switch the hero back to "Chronicle" -> the light look returns
- [ ] Hexagons: hover lifts and lights one; click -> Draw Steel's roll dialog for that characteristic
- [ ] With no temporary Stamina, damage the hero (its token on the map, or type a lower Stamina) -> a rose ripple spreads from the picture and the glass shivers; at or under the winded figure the ring turns rose and the pill says "Winded", at 0 or less "Dying" and the picture greys. Heal it -> the ring blooms with light and turns teal again
- [ ] With Level up showing, level the hero up -> the hexagons light one after another, a line draws between them and the name glows
- [ ] Type in Stamina, temporary Stamina, recoveries, heroic resource and surges -> each saves; the Stamina, Recoveries and Surges buttons work as on Draw Steel's sheet; Take Respite works
- [ ] Drag the window narrower: about 820 wide everything fits; under about 780 the tracker boxes go three across; under about 700 the picture centres over the name and everything stacks; no sideways scroll
- [ ] Every tab (Abilities, Features, Equipment, Projects, Effects, Biography) works as on Draw Steel's sheet, on glass; scrolling a long tab keeps the tab pill pinned
- [ ] Edit mode (padlock): the name field, origins with remove and add, XP and Victories fields, and Draw Steel's editors in glass cells, arriving one after another
- [ ] Fold -> the card in glass with a round teal-ringed picture and all five characteristic names readable; over a busy map it shows the map blurred through; Open -> the full sheet again, at its size
- [ ] Press Tab through the sheet -> a clear teal ring shows on each hexagon, button and field
- [ ] A Limited viewer sees the picture ring (no Stamina), name, class, origins, level, XP and victories, the tab pill and Biography, and nothing else; when the GM damages or heals the hero, the picture doesn't ripple or shiver for them

#### The gilded card look
Open a hero in the Chronicle hero sheet, then palette button in the title bar -> "The gilded card".
- [ ] The window grows to about 1100 by 760 and turns navy and gold with a double gold border and flourished corners: tabs along the top; the picture under an arch in the middle with a gold Level medal on its foot, the name in gold capitals, origins, subclass, XP and Victories under it; left, the Stamina dial, rows of round pips and Speed, Stability, Size, Disengage; right, five gold-ringed medallions and the skills; Take Respite at the right foot
- [ ] On first opening the card turns in from its edge and the medallions are dealt in one after another, all within about a second and a half; now and then light crosses the gold. Motion Calm (module settings) -> only fades and no light; Off -> no movement at all. The same with the computer's "reduce motion" setting on
- [ ] Pictures: a bright picture, a wide landscape picture and a hero with no picture of its own all sit under the arch without stretching; with no picture a gold crest stands in
- [ ] A long name (about 20 letters, two words) wraps between words, never mid-word, and the card, Take Respite and XP stay inside the gold border, also in a window about 600 high
- [ ] Foundry's light theme: the card stays dark and readable; switch the hero back to "Chronicle" -> the light look returns
- [ ] Medallions: the phrase under a name is "a master's gift" for 2 or more, "a steady hand" for 1, "the weakest suit" for 0 or less; hover nudges a medallion; click -> Draw Steel's roll dialog
- [ ] Damage the hero -> the card tilts and a red crack flashes across the picture; at or under the winded figure the Stamina number turns pink and says "Winded", at 0 or less red, "Dying", and the picture loses its colour. Heal it -> the dial's rays swell
- [ ] With Level up showing (the medal shows an arrow and glows), level the hero up -> the medal spins and light runs across the gold
- [ ] Type in Stamina, temporary Stamina, recoveries, heroic resource and surges -> each saves; the hero token, Recoveries and Surges buttons work as on Draw Steel's sheet; Take Respite works
- [ ] Drag the window narrower: about 820 wide everything fits; under about 760 the picture comes first, the two boxes sit side by side under it; the tab row never touches the corners
- [ ] Every tab works as on Draw Steel's sheet in navy and gold; the tab row stays pinned and the border stays on the window while scrolling
- [ ] Scroll a long tab to its end, at full size, about 640 wide and in Edit mode -> the page fades out just above the gold foot; no words or fields show under the frame's bottom edge, its corner flourishes or outside the border, and the last line can be scrolled clear of the foot
- [ ] Edit mode (padlock): one light sweep; the name field, origins with remove and add, XP and Victories on the card, Draw Steel's editors under it
- [ ] Fold -> the card turns over into a small gold-edged card with five round medallions; Open -> the full card again
- [ ] Press Tab through the sheet -> a clear gold ring shows on each medallion, button, label and field, and round the whole arch for the picture
- [ ] A Limited viewer sees the picture, name, class, origins, level, XP and victories, the tab row and Biography, and nothing else; when the GM damages or heals the hero nothing tilts, flashes or loses colour for them

#### The night sky look
Open a hero in the Chronicle hero sheet, then palette button in the title bar -> "Night sky".
- [ ] The window grows to about 1100 by 760 and turns to a night sky with stars and a mountain line: the hero's picture in a round moon on the left with a gold Stamina ring and a ring of recovery arcs round it; on the right "Level N · class · origins", the name in thin capitals, the subclass, XP and Victories, then big thin numbers for Stamina, Recoveries, the heroic resource, Surges and Speed; the five characteristics below as a constellation of stars joined by lines; the skills under the moon; the tabs as thin capitals across the top right, Abilities open
- [ ] On first opening, the moon rises, the name fades in, the stars come on and the lines draw between them, all within about two and a half seconds; set Motion (module settings) to Calm -> only short fades and no twinkling; Off -> no movement at all, stars included. The same with the computer's "reduce motion" setting on
- [ ] Pictures: try a bright picture, a wide landscape picture and a hero with no picture of its own. Each fills the round moon without stretching, and with no picture a pale moon with a few darker seas stands in
- [ ] A long name (about 20 letters) wraps between words, never mid-word, and nothing overlaps
- [ ] Foundry's light theme: the sky stays dark and readable; switch the hero back to "Chronicle" -> the light look returns
- [ ] Stars: a characteristic of 3 or more is the biggest star, 0 or less the smallest; the five stars never change place; hover glows a star and brightens its number; click it -> Draw Steel's roll dialog
- [ ] Damage the hero (its token on the map, or type a lower Stamina) -> the horizon flushes red, the moon is eclipsed and clears, a star falls; at or under the winded figure the ring turns rose and says "Winded", at 0 or less darker and "Dying", the moon dimmed but the face still recognisable. Heal it -> an aurora drifts across and the ring turns gold again
- [ ] With Level up showing, a star pulses beside the level; level the hero up -> a shooting star crosses and the stars flare in turn
- [ ] Type in Stamina, temporary Stamina, recoveries, heroic resource and surges -> each saves; the hero token, spend a recovery and gain surges buttons work as on Draw Steel's sheet
- [ ] The five big numbers (Stamina, Recoveries, the heroic resource, Surges, Speed) and their labels sit on one line. The skills are in alphabetical order with a small dot between names, and no line of skills starts or ends with a dot
- [ ] Drag the window narrower: about 820 wide everything still fits; under about 760 the moon goes to the top, centred, with everything in one column and the tabs a row; no sideways scroll at 640
- [ ] Every tab (Abilities, Features, Equipment, Projects, Effects, Biography) works as on Draw Steel's sheet, in the sky's colours; scrolling keeps the tab row at the top and the sky still
- [ ] Edit mode (padlock): the name field, origins with remove and add, XP and Victories fields, and Draw Steel's editors, fading in one after another
- [ ] Fold -> the card as a small night sky, with all five characteristic names readable; Open -> the sky again, at its size
- [ ] Press Tab through the sheet -> a thin gold ring shows on each star, button, tab and field
- [ ] A Limited viewer sees the moon with the picture (no Stamina ring), name, class, origins, level, XP and victories, the tab row and Biography, and nothing else; when the GM damages or heals the hero, nothing flashes or falls for them
- [ ] Picking the night sky changes nothing in Chronicle: the hero's history in Chronicle shows no new entry

### Foundry -> Chronicle
- [ ] Create character Actor in Foundry -> Page created in Chronicle with mapped fields
- [ ] Update Actor ability scores -> Chronicle page fields_data updates
- [ ] Update Actor HP -> Chronicle page hp_current/hp_max update
- [ ] Update Actor name -> Chronicle page name updates
- [ ] Delete Actor -> asked "Delete in Chronicle too?": No keeps the page, Yes deletes it

### Dashboard - Characters Tab
- [ ] Characters pane visible in the sync dashboard under Linked
- [ ] System badge shows matched system name
- [ ] Synced actors show green check with "In sync" label, a last-sync time and a **Sync again** button
- [ ] Unlinked actors show "Not linked" with a Send button, and **Send all** appears in the toolbar
- [ ] Send button creates Chronicle page and links actor
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
- [ ] As a player on the character you claimed in Chronicle, change HP and an item's quantity -> with a GM in the game, Chronicle shows both; a later change in Chronicle does not undo them
- [ ] As a player on a character nobody claimed in Chronicle, change HP -> nothing changes in Chronicle and the GM gets one notice saying the character isn't claimed
- [ ] With two GMs in the game, a player's change is sent once (one History row), not twice
- [ ] Duplicate a linked character Actor -> the copy is not linked; editing it changes nothing in Chronicle
- [ ] Pre-existing actors can be manually pushed via dashboard Send button

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

## GM Screen

GM only. Needs a Chronicle that serves its DM Screen (Chronicle's own name for it).

- [ ] The scene controls' Chronicle group has a d20 button for the GM; a player's group has only the Satchel and Calendar buttons
- [ ] Click it: a d20 rolls out of the button, lands on 20 and the screen unfolds into three leaves (The world, The party, Rules and reveals); a click or Escape skips the opening
- [ ] The world leaf shows In session / Downtime; pressing the other one asks first, **Cancel** leaves it, confirming switches it and a notice says how many waiting requests went through
- [ ] The party leaf lists each hero on one line; a row expands for detail, with a green dot after "Played by" when that player is on Chronicle now
- [ ] The top strip says how many players are here (hover lists who); with requests waiting, **Waiting on you** lists them and its link opens the Stashes page
- [ ] Rules tab: **Find a condition** filters the list. Reveal tab: **Reveal** on a hidden character makes it visible to players in Chronicle
- [ ] Against a Chronicle without the DM Screen, the window says to update Chronicle; with a wrong key it says the key was not accepted; **Try again** reloads
- [ ] **Cast** lists the scene's tokens that belong to a Chronicle page and no player, hidden ones marked Hidden. Spotlight, Talk as (then Stop talking) and Page do what the token's own buttons do; a player's hero never appears
- [ ] **Party** shows each shared stash with its money and items, **Move things** opens a hero's Stashes window, and each shop's **Open** opens its shop room. With stashes off in Chronicle, it says so

## Encounters (GM Screen tab)

GM only. Needs a Chronicle that serves encounters, a key for the campaign owner or a co-DM, creature sync on (so creature pages have actors), and a scene with a grid open. Plan one fight in Chronicle with a creature of count 3, one planned hidden, one planned seen and one planned "arrives later".

- [ ] GM Screen, **Encounters** tab: the panel widens; fights marked Ready are listed first with their page name and creature count; typing in **Search planned encounters** finds others after a short pause
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
- [ ] **Start stage N**: the creature changes form the way the stage says (quiet or reveal); then the scene waits for one click and the arriving rows land there. The stage reads **Started**, and still does after closing and reopening the GM Screen
- [ ] A "round 3" stage turns due at the start of round 3; a manual stage is never due but its Start works any time

## Character claims

Needs the Player Character Claiming addon on in Chronicle, a character linked to an actor, and two players linked to Chronicle members (Chronicle Sync → Settings → Players). Run as the GM.

- [ ] In Chronicle, assign the character to player A -> within a few seconds A is **Owner** in the actor's Ownership settings, and A can open and edit the sheet; nothing about the ownership is sent back to Chronicle
- [ ] Reassign it to player B -> B is Owner, A is still Owner, and the GM sees one notice saying A still owns it and can be changed in the actor's Ownership settings
- [ ] Unassign it in Chronicle -> Foundry ownership is unchanged
- [ ] Assign it to a member with no Foundry user mapped -> no ownership change, one GM notice that the player has no Foundry user, and Chronicle Sync → Settings → Players shows that member as "Owns a character, not linked"; linking them, pressing **Save**, then reconnecting, gives them Owner
- [ ] Reconnect (or Bring in all) with a claim that is already applied -> no notice and no ownership change

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

## Crafting

Needs Chronicle's crafting addon on, a character linked to an actor, and a player linked to a Chronicle member (Chronicle Sync → Settings → Players). Have something in the Director's spoils tray on Chronicle (the Crafting page → Put in the tray), one find identified and one not.

- [ ] A **Crafting** button (flask) is in the title bar of a linked character sheet (players on characters they own, the GM on all); with the crafting addon off, or on a Chronicle without crafting routes, it is absent and the Satchel's **Crafting** tab says crafting is off
- [ ] The button opens the Satchel on **Crafting** showing the same block as the hero's Chronicle page: spoils to take, projects in progress, recipes to start
- [ ] As a player, **Take** an identified find -> the result shows under it, the item lands on the Foundry sheet, and the GM gets a whispered line "<hero> (<player>) took …"
- [ ] **Harvest** a find -> the dice and the tier show, the sheet gets what the roll gave, and the GM's whisper says what was rolled
- [ ] **Study it** on an unidentified find -> the test shows; on a pass the find is named for everyone; a second study before the next respite is greyed out with "tries again after the next respite"
- [ ] Start a recipe, then roll it after a respite was logged on Chronicle -> the points go up; a roll that finishes it puts the item on the sheet and the GM gets "finished …"
- [ ] **Work at the bench** says the bench is on Chronicle and links to the hero's page there
- [ ] Make the window narrow -> the rows stack (name, then chips, then buttons) without overlapping, in light and dark
- [ ] With no GM connected, a player's tab says crafting waits for the GM, and fills in by itself once the GM joins
- [ ] A player cannot reach another player's hero: the tab only ever shows the character they own

### The end-of-combat spoils prompt

Needs a drop list on two creature pages in Chronicle (Crafting → Spoils tab → Edit), their actors in Foundry from creature sync, and a planned encounter with one stage for the second half.

- [ ] Start a combat with both creatures, a third token with no Chronicle page and a player's character. Bring both creatures and the third token to 0 (or mark them defeated), then **End Combat** -> one window "The fight is over" lists both creatures with what their drop lists leave and "1 down"; the token with no page is greyed out; the character is not listed
- [ ] Untick one creature and press **Put in the tray** -> only the ticked one's spoils appear in the players' Satchel → Crafting and on Chronicle's Spoils tab, named "<scene> (Foundry)"; you get a toast and a whispered "Spoils from …" line
- [ ] End another combat and press **Not now** (or close the window) -> nothing appears in the tray
- [ ] Place the encounter from the GM Screen, defeat a creature, and end the combat before its stage starts -> "Is the whole fight over?" asks first; **Hold for the next stage** sends nothing. Start the stage, end the next combat of that encounter -> the spoils window lists the held creature too, counted once even if its token was in both combats
- [ ] Same again, but press **The whole fight is over** -> the spoils window opens at once
- [ ] A campaign with no drop lists, or with the crafting addon off, gets no window when a combat ends
- [ ] With two GMs connected, only one gets the window

## Cut scenes

Needs Chronicle's Cut scenes add-on on with one saved scene (Chronicle → the campaign → Cut scenes → New scene), a GM client and two player clients each linked to a Chronicle member (Chronicle Sync → Settings → Players), and a third linked player who is not logged in to Foundry.

- [ ] Before anything is shown, a player's Satchel has a **Cut scenes** tab once the GM has connected; with the add-on off it has no such tab
- [ ] In Chronicle, open the scene → **Show to…**, tick the first player only, **Show** -> that player's Foundry goes dark full screen and plays the scene over the canvas; the second player's Foundry and the GM's do not change
- [ ] On the player's screen, Esc or the small close control ends it after about 2 seconds; with **Ending: tap**, a quiet **Close** appears once the last layer has finished
- [ ] Show it again to both players, then press **Stop** on the "Showing to …" row in Chronicle -> both takeovers end at once
- [ ] Chronicle Sync → Overview's activity shows a line "Cut scene "…": 2 in Foundry now, 0 away, …"
- [ ] Show a scene to the player who is not logged in, then log them in within two minutes -> it plays when their Foundry finishes loading. Past two minutes it does not play, but it is in their Satchel → **Cut scenes**
- [ ] A player's Satchel → **Cut scenes** lists each scene shown to them with "Until <time>" and **Watch again**; **Watch again** plays it full screen; a scene shown to the other player only is not listed
- [ ] Show a scene with rewatch **1 hour**; after the hour the row disappears from an open Satchel without reopening it
- [ ] Log the GM out: a player's Cut scenes tab says the GM isn't connected and still lists the scenes shown to them this session, and **Watch again** still plays them; log the GM back in -> the full list fills in by itself
- [ ] A player not linked to a Chronicle member sees "Not linked to Chronicle yet" on the tab
- [ ] Set Configure Settings → Chronicle Sync → Motion to **Calm** on a player and show a scene -> no drifting particles; the layers fade in place
- [ ] In the player's browser console, `game.journal.contents.some(j => JSON.stringify(j.flags).includes("Something"))` is `false` (use a word from the scene's text): nothing of a scene is saved in the world

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
- [ ] In a world with no connection, Chronicle Sync opens on "Set up Chronicle in this world" with the five steps listed and the connect-line field below. Paste a connect line and press **Connect and continue**: the wizard opens in the same window. **Skip setup** returns to the four sections and the wizard does not reappear on the next open
- [ ] Tags and Characters steps are skipped when tags are unavailable or no game system matched
- [ ] Review lists what will be created; running it creates the pages and marks the wizard completed

## Problem reports (privacy, module #94)

Needs a GM client and a player client, on each of Foundry v12, v13 and v14.

- [ ] As a player, open a character's Stashes window, click "Report a problem", send text: "Sent to your GM"; the GM sees "{name} reported a problem" and the Problems badge goes up
- [ ] In the GM's Journal sidebar there is no "Chronicle: problem reports" entry
- [ ] In the player's browser console, `game.journal.find(j => j.getFlag("chronicle-sync", "problemReportsStore"))` returns `undefined`, and `game.journal.contents.some(j => j.name.includes("problem reports"))` is `false`
- [ ] As the GM, the same first console line returns the entry, and its `flags["chronicle-sync"].reports` lists the report
- [ ] Reload the GM client: the report is still there and no second entry was made
- [ ] The entry does not appear in the Import wizard's journal list or the dashboard's journals that are only in Foundry, and nothing was pushed to Chronicle

## Error Recovery

- [ ] Invalid API key shows clear error message
- [ ] Network timeout during sync doesn't corrupt state
- [ ] A Chronicle that stops answering mid-request: the request gives up after 30 seconds and later changes still sync
- [ ] If the first sync after connecting fails, it is tried again by itself within 30 seconds, with no reload
- [ ] Partial sync failure (one page fails) doesn't block others
- [ ] A Chronicle restart reconnects without a reload
- [ ] A failed Foundry→Chronicle push (Chronicle down) shows a `ui.notifications.warn` to the GM and an error-log row; journal updates are queued and re-pushed on reconnect

### Catch-up after a closed world
- [ ] Close Foundry, edit a page and a character in Chronicle, change a character's inventory there, then reopen the world -> the page, the character and the inventory change appear without Sync all again
- [ ] Delete a page in Chronicle while Foundry is closed, then reopen -> its journal is set aside in the "Chronicle: removed" folder, not deleted
- [ ] Against an older Chronicle with no change feed, reopening still catches up (a full rescan; slower)
- [ ] Remove a "Has Item" relation in Chronicle -> the Foundry item is unlinked from Chronicle but not deleted from the character

### Reconnect catch-up
Edits made on Chronicle while Foundry was disconnected arrive after reconnect, without a world reload.
- [ ] Disconnect (stop Chronicle or pull the network) until the status pill goes red/yellow, then rename a page or change its content in Chronicle
- [ ] Reconnect: after about 3 s the change appears in Foundry with no reload, and the activity log reads "Reconnected — fetched again the changes made during the disconnect"
- [ ] Rapid disconnect/reconnect cycles trigger one catch-up once the link settles, not one per reconnect

## Sync Dashboard

The Chronicle Sync window is a left rail of four sections: Overview, Linked
(Pages, Characters, Maps, Shops and Calendar panes), Problems (Health,
Player reports and History panes) and Settings (at the foot, set apart).

### Access
- [ ] Open the Chronicle group in the scene controls: no button in it looks pressed, and only its buttons appear (no blank slot). Press Chronicle Sync → dashboard opens; press it again after closing → opens again. Click Tokens, then back to the Chronicle group → nothing opens on its own
- [ ] Click the sidebar status indicator (when connected) or the Chronicle Sync button in the scene controls → dashboard opens (GM only); right-click on the indicator opens it even when disconnected; clicking while disconnected tries to reconnect
- [ ] With URL, key or campaign ID missing, the window shows "Set up Chronicle in this world", the five steps with Connect current, and one **Connect line** field with the cursor in it; no rail, no tabs, no Save or Test connection button
- [ ] Paste a connect line (Chronicle: your campaign → Manage → Foundry → Connection) → after a moment "Chronicle answers", "Key accepted", "Campaign found" and the game system line tick by themselves and **Connect and continue** turns on. A wrong key shows a cross with what to do, and the button stays off. Typing "hello" shows "That is not a connect line", and the line is never shown back
- [ ] **Connect and continue** → the window goes straight on to the Scan step with no reload (or, if the connection cannot start at once, a notice asks for one reload and the setup opens after it)
- [ ] **Enter details by hand**: fill address, key and campaign → nothing is checked while you type; leaving a field or pressing **Connect and continue** runs the same checks, and it connects only when they pass
- [ ] It opens to the last-active section and pane; an unknown saved tab falls back to Overview, and a tab saved by an older version opens where its content now lives (Maps → Linked, Maps; Diagnostics → Problems; Status → Problems, Health; Issues → Linked, Characters)
- [ ] Configure Settings → Chronicle Sync → **Open Chronicle Sync settings** opens the window at Settings (or brings it forward there)
- [ ] Settings: change a field, let the window re-render (e.g. a player sends a report) → the change is still there; **Undo changes** puts the saved values back; **Save** saves and says so; arrow keys move along every pane strip
- [ ] A tab that fails to load shows a "Some data failed to load" banner naming the tab, with **Retry**

### Tabs
Details for Characters, Maps, Shops and Calendar are under their own sections.
- [ ] **Overview:** connection banner (green/yellow/red) with **Reconnect** when not connected; stat tiles (Pages in sync, Characters in sync n/total, Maps Linked) each jump to their tab; "Needs Attention" lists only real problems, each row jumping to the fixing tab, or says "Everything's in sync"; **Sync Everything Now**, **Problems** and **Refresh** work; below: the GM-only note when any were hidden, last sync time, Recent Activity, **Clear Log**
- [ ] **Pages:** a search box, then the list's commands as plain words (Bring in all (n), Send all (n), Sync all again, New type, and Select at the far end), then one small-caps heading per type with a count line ("3 in sync, 1 only in Chronicle"). Each row: a dot, the name, a lock only when the page is hidden from players, a state word, at most one button, and a ⋯ menu
- [ ] Type in the search box → rows filter as you type, the cursor stays in the box, types with no match disappear, a folded type shows its matches, and "No pages match that search." shows when nothing does; Escape clears it
- [ ] Click a type's name → its rows fold away (and stay folded after a reload); its ⋯ menu offers "Turn sync off for this type" and folding. With sync off for a type the count line reads "9 pages, sync off for this type"
- [ ] A row's ⋯ menu: **Sync this page again**, **Show to players** / **Hide from players**, **Turn sync off for this page**, **Copy details for help**. Arrow keys move through it, Escape closes it and returns to the ⋯ button, a click elsewhere closes it
- [ ] **Select** → checkboxes appear with "Select all shown", Change type, Show to players, Hide from players and Delete; they stay greyed until a page is ticked; **Done selecting** leaves and forgets the ticks
- [ ] Self-fixing: edit a page in Chronicle while Foundry is closed to it (stop the world's connection, or edit a page whose live update was missed), then open Chronicle Sync → the row reads "Catching up…" and then "In sync" without a click, and Recent Activity says pages were brought up to date. A page with sync off is left alone
- [ ] Self-fixing: with Chronicle unreachable, edit a synced journal → its row reads "Waiting to send" with **Send now**; once Chronicle is back it sends by itself. A page that will not sync reads "Couldn't sync" in red, its reason shows on hover, and **Try again** retries it
- [ ] One side only, Chronicle: make a page in Chronicle while Foundry is closed, then open Chronicle Sync → Linked → Pages → its row reads "Bringing in…" and then "In sync" without a click, and the journal exists. With sync off for the page or its type it reads "Only in Chronicle, sync off" with **Bring in** and stays out
- [ ] One side only, Foundry: with Chronicle unreachable, make a journal with some text; reconnect and open the list → under "Only in Foundry" its row reads "Sending…", then it moves up among the pages as "In sync", the page in Chronicle has the text, and a notice says how many journals were sent. A journal hidden from players arrives in Chronicle hidden from players
- [ ] Held back: a journal in "Chronicle: removed" reads "Set aside" and is never sent by itself; a journal's ⋯ menu → **Turn sync off for this journal** → it reads "Sync off", has no Send button, and stays in Foundry; **Turn sync on for this journal** → it is sent
- [ ] Same name: make a journal named like a Chronicle page that has no journal → neither is copied; both rows read "Same name in Foundry" / "Same name in Chronicle" with **Link**. **Link** asks first and says whose text is kept (what Settings' conflict choice picks); Yes → one row, "In sync", with that text on both sides; No → nothing changes. A journal named like a page that already has a journal reads "Same name in Chronicle" with **Send** and is sent only when pressed
- [ ] A send that fails reads "Couldn't send" in red with the reason on hover and **Try again**; it is not retried by itself until **Check again** or the window is reopened
- [ ] Maps and calendar notes are not listed under "Only in Foundry"
- [ ] Settings → Sync: turn **Sync changes as they happen** off → nothing in the list moves by itself and a line above it says why; set Pages to **From Chronicle** → pages are still brought in, journals are not sent, and the line says so; **From Foundry** → the reverse
- [ ] **Bring in all** and **Send all** ask first, name what they leave out (sync off, set aside, same name, characters), and their counts leave those out too
- [ ] **Copy details for help** → the clipboard holds the page's name, ids, versions, state and its recent errors, and none of the page's text and no key; the same on a journal's ⋯ menu
- [ ] At the foot: "This list was read from Chronicle at HH:MM." with **Check again**; closing and reopening the window also reads it again
- [ ] **Characters:** a "Needs a match" list comes first when any character can't be matched (the rail shows its count); each row offers "Match to existing…" with **Match**, and **Create new**, and resolving a row links it and removes it
- [ ] **Calendar**, **Shops**, **Maps:** as in their sections; the Calendar pane explains why when sync is off, no calendar exists, or it is rebuilding or unreachable; Shops empty states say whether the "Shop" type is missing or has no shops
- [ ] **Problems:** Health / Player reports / History switch; the badge counts new player reports. Health: a checklist of plain sentences, problems first (changes waiting to be sent, recent errors, dice, connection, game system, sheet fields), each with at most one action in plain words; "Show them" lists the waiting changes with **Send them now**; **Copy a report for help** copies the diagnostic report; a closed **For troubleshooting** drawer holds Game System, Connection counts, Field Mapping, Sync Capability (pick an actor; **Copy** report and JSON), Dice detail, the Error Log and System Debug Export, and stays open across a redraw once opened

### Layout Persistence
- [ ] Switch to Linked → Maps, close the window, reopen -> Linked → Maps still open
- [ ] Collapse a page type group, reload Foundry -> group still collapsed
- [ ] A different browser/user has independent layout preferences (they are client settings)

### Page Type Creation
- [ ] "New type" shows among the Pages list's commands
- [ ] Click -> Dialog with name, plural name, icon and color fields
- [ ] Submit with name "Quest" -> type created, dashboard refreshes
- [ ] New type appears in select mode's "Change type" dropdown
- [ ] Cancel/close without name -> no API call, no errors

### Settings (in Chronicle Sync)
- [ ] Configure Settings shows Chronicle's button and only the calendar strip, Motion and temperature unit; the button opens Chronicle Sync at Settings, with panes Connection, What syncs, Calendar, Players and Advanced (GM only)
- [ ] **Players:** one row per Chronicle member with a Linked / Not linked badge and a Foundry player dropdown; change one, press **Save**, reopen -> the change stuck and the other links are unchanged; **Fetch members again** re-reads the list
- [ ] **What syncs:** the new-journal page type lists Chronicle's page types; pick one, **Save**, then make a journal in Foundry -> the Chronicle page has that type
- [ ] **Connection:** **Setup Wizard** shows the import wizard in the same window; the API key field is always empty, with "Saved in this browser" when a key exists
- [ ] Overview -> "campaign member(s) not mapped" opens Settings → Players
- [ ] Delete a synced page in Chronicle -> its journal moves to "Chronicle: removed", and Overview shows "1 page removed in Chronicle was set aside"; the row opens Linked → Pages, where the journal is listed as Set aside with Send and Delete
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
