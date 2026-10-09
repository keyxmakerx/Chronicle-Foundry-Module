# Chronicle Sync — Foundry VTT Module

Bidirectional real-time sync between [Chronicle](https://github.com/keyxmakerx/Chronicle) and Foundry VTT.

## Features

> **Older Chronicle servers and the calendar.** Chronicle's calendar is rebuilt
> around new date and event routes, which the module uses. A Chronicle that still
> answers calendar routes with `503 calendar_rebuilding` makes the module pause
> calendar pushes for the session rather than report an error — nothing is
> wrong on your side. Journals, maps, characters and items sync as usual.

- **Journal Sync** — Chronicle entities ↔ Foundry journal entries (with multi-page splitting); GM-only text and pictures in Chronicle pages sit in Foundry secret blocks, hidden from players who don't own the page; catches up on reconnect from Chronicle's change feed; nothing is deleted without asking
- **Map Sync** — Chronicle maps render as Foundry journal pages (not Scenes) in Chronicle's own frame and pin shapes, with markers, drawings, tokens, layers and fog drawn as overlays; players get the smudged picture of a shadowed map; markers are editable, with Chronicle's icon picker ("Open in Chronicle web editor" for the full map editor); the GM can give a map to a character, who opens it from their sheet
- **Calendar** — The dashboard's Calendar tab shows Chronicle's date, weather, season, era and moon phases; no Foundry calendar module is integrated
- **Character Sync** — Actor ↔ character entity with system-aware field mapping (D&D 5e, Pathfinder 2e, or any system with annotated fields)
- **Shop Rooms** — Chronicle shops open in Foundry as shop rooms; the GM can show a room to players, and players buy in it (charged to the character they pick) while the GM is in the game
- **Stashes** — A Stashes window on linked character sheets to move items and money between characters and stashes; the GM approves players' requests from a chat card (needs Chronicle's Armory addon)
- **DM Screen** — The GM's DM Screen from Chronicle in a Foundry window: world and downtime switch, the party, rules and reveals
- **Player Notebook** — Every player's own Chronicle journal and jot notes in a Foundry window, with jots that follow the page in view
- **NPC Tokens** — GM token tools for Chronicle NPCs: spotlight, talking glow and open page; "Show in Foundry" on an NPC page spotlights its token
- **Sync Dashboard** — management UI with diagnostics, error logs, health metrics, a copyable diagnostic bundle and a Setup Wizard for a first import
- **Permission Mapping** — Chronicle visibility ↔ Foundry ownership levels
- **Sync History** — a History tab in the Sync Dashboard showing Chronicle's sync history in both directions, the same list the owner sees in Chronicle

## Compatibility

| Foundry VTT | Status |
|-------------|--------|
| v12         | Minimum supported |
| v13         | Supported |
| v14         | Verified |

## Installation

Module releases are served from your Chronicle instance, not from GitHub.
The install URL is **per-campaign** and signed, and it follows the update
choice your campaign owner made.

**To install:**

1. In Chronicle, open your campaign → **Manage → Foundry** (the row appears
   once the campaign's Foundry sync is turned on).
2. Under **Install in Foundry**, copy the **Module Install URL**.
3. In Foundry VTT, go to **Add-on Modules → Install Module**, paste the
   URL, and click **Install**.

After install, Foundry remembers that URL and re-uses it on every update
check — so you get whichever module version your campaign's update choice
gives, without further configuration.

> **For Chronicle admins:** Chronicle picks up new versions from this repo's
> GitHub releases. In Chronicle, open **Admin → Packages**, click **Check now**
> on this module's Settings tab, and install the new version. Each campaign owner
> chooses how their world takes new versions on **Manage → Foundry → Module version**.
>
> GitHub releases are Chronicle's upstream source, not the install channel for
> Foundry users — the install URL to hand out is the per-campaign Chronicle
> URL above, since that's what makes the per-campaign update choice work. An
> install still pointed at GitHub keeps running but won't follow the
> campaign's update choice; check **Game Settings → Module Settings →
> Chronicle Sync → Update Source** to see whether an install needs re-pointing.

## Updating in Foundry

Once installed via your Chronicle install URL, Foundry stores that URL
and uses it for every future update check — updates always come from
Chronicle, following your campaign's update choice.

Foundry's central Package Repository also lists this module with its
GitHub manifest URL. On an update check, Foundry may detect the
mismatch and prompt you to switch the locally-stored manifest URL to
one from the Package Repository. **If you see this prompt, decline it
to keep your install on Chronicle.** Switching to the Package
Repository's URL bypasses your campaign's update choice and
sends update traffic to GitHub instead of Chronicle.

### Updating the module (for the operator)

Do these in order whenever you ship a new module version:

1. **Deploy Chronicle first**, with your usual backup. The module keeps
   working against an older Chronicle, but newer features (the DM Screen,
   Stashes, map icons) only appear once Chronicle has the matching routes.
2. **Make the release.** On this repo's GitHub page open **Actions →
   Release → Run workflow**, type the version as `X.Y.Z` (no leading `v`) and
   run it. It tags `main` and publishes the release; nothing is uploaded by
   hand.
3. **Pick it up in Chronicle.** Open **Admin → Packages**, open this module,
   press **Check now** on its Settings tab, then install the new version from
   its version list.
4. **Roll it out per campaign.** Each campaign follows its owner's choice on
   **Manage → Foundry → Module version**: "Update automatically" takes the new
   version at once, "Ask me first" waits until the owner presses **Update**,
   and "Stay on one version" changes nothing until the owner picks another
   version.
5. **Update in Foundry.** The GM (whoever hosts the world) opens **Add-on
   Modules**, updates Chronicle Sync, and reloads the world. Decline Foundry's offer to
   switch to the Package Repository's URL.

Working: the campaign's **Manage → Foundry** page shows the new version under
**Module version** after the GM's Foundry reconnects, and Foundry's
**Update Source & Manual Check** (Game Settings → Module Settings → Chronicle
Sync) shows a Chronicle address. Broken: the version stays old after a reload
(the campaign waits on "Ask me first" or "Stay on one version", or Foundry
is on the GitHub address), or Update
Source shows a message in red (follow the "What to do" line in it).

## Configuration

1. Enable the module in your world's **Module Management**
2. Open **Game Settings → Module Settings → Chronicle Sync**
3. Paste the **Connect line** from Chronicle (your campaign → **Manage → Foundry**, **Connection** card → **Make a connect line**) and save; it fills in the URL, API key and campaign ID, then reload Foundry. Or enter the **API URL**, **API Key**, and **Campaign ID** by hand
4. Enable the sync categories you want (Journals, Maps, Calendar, Characters)

The module runs sync for the GM only. Players receive updates passively through Foundry.

## Optional Modules

- [Monk's Enhanced Journal](https://foundryvtt.com/packages/monks-enhanced-journal) — Enhanced journal page support

## For Chronicle integrators

This module ships a [`chronicle-package.json`](chronicle-package.json)
descriptor at the repo root. Chronicle reads it during admin install to
decide how to serve the module: where the manifest lives inside the zip,
what URL shape to emit when generating per-campaign install URLs, and
whether per-campaign signed tokens are required.

The descriptor is the "Foundry instructs Chronicle" mechanism — every
Foundry-specific assumption that would otherwise be hardcoded in
Chronicle lives in this file instead, so the same Chronicle code can
serve any future Foundry module (or other package type) without
modification.

CI validates the descriptor on every push and pull request via
[`tools/check-package-descriptor.mjs`](tools/check-package-descriptor.mjs).
The check enforces:

- `chronicle-package.json` is valid JSON with `schemaVersion: 1`
- `package.id` matches `module.json#/id`
- `package.kind` is `"foundry-module"`
- `package.moduleJsonPath` resolves to an actual file in the zip
- Endpoint templates include the required `{campaign_id}` and `{token}` placeholders
- Field types are correct

Bumping `module.json#/id` (rare) requires updating
`chronicle-package.json#/package/id` in the same commit.

## License

MIT
