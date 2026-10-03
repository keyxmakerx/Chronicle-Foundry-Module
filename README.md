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
- **Calendar Sync** — Calendaria and Simple Calendar integration
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
| v13         | Verified |
| v14         | Verified |

## Installation

Module releases are served from your Chronicle instance, not from GitHub.
The install URL is **per-campaign**, signed, and pinned to the version
your campaign owner selected.

**To install:**

1. In Chronicle, open your campaign → **Settings → Integrations**.
2. Copy the **install URL** shown on that page.
3. In Foundry VTT, go to **Add-on Modules → Install Module**, paste the
   URL, and click **Install**.

After install, Foundry remembers that URL and re-uses it on every update
check — so you'll receive whichever module version your campaign owner
pins, without further configuration.

> **For Chronicle admins:** Chronicle picks up new versions from this repo's
> GitHub releases. In Chronicle, open **Admin → Packages**, click **Check now**
> on this module's Settings tab, and install the new version. Campaign owners then
> pin it per campaign under **Settings → Integrations**.
>
> GitHub releases are Chronicle's upstream source, not the install channel for
> Foundry users — the install URL to hand out is the per-campaign Chronicle
> URL above, since that's what makes per-campaign version pinning work. An
> install still pointed at GitHub keeps running but won't receive the
> campaign's pinned version; check **Game Settings → Module Settings →
> Chronicle Sync → Update Source** to see whether an install needs re-pointing.

## Updating in Foundry

Once installed via your Chronicle install URL, Foundry stores that URL
and uses it for every future update check — updates always come from
Chronicle, reflecting whichever version your campaign owner has pinned.

Foundry's central Package Repository also lists this module with its
GitHub manifest URL. On an update check, Foundry may detect the
mismatch and prompt you to switch the locally-stored manifest URL to
one from the Package Repository. **If you see this prompt, decline it
to keep your install on Chronicle.** Switching to the Package
Repository's URL bypasses your campaign owner's pinned version and
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
4. **Roll it out per campaign.** A campaign set to "auto: latest" follows the
   newest installed version. A pinned campaign stays on its pin until its owner
   picks the new version under **Settings → Integrations → Pin to Version**
   and presses **Save Pin**.
5. **Update in Foundry.** The GM (whoever hosts the world) opens **Add-on
   Modules**, updates Chronicle Sync, and reloads the world. Decline Foundry's offer to
   switch to the Package Repository's URL.

Working: the campaign's **Manage → Apps & game system** page shows the new
module version on the Foundry VTT row after the GM's Foundry reconnects, and Foundry's
**Update Source & Manual Check** (Game Settings → Module Settings → Chronicle
Sync) shows a Chronicle address. Broken: the version stays old after a reload
(the campaign is still pinned, or Foundry is on the GitHub address), or Update
Source shows a message in red (follow the "What to do" line in it).

## Configuration

1. Enable the module in your world's **Module Management**
2. Open **Game Settings → Module Settings → Chronicle Sync**
3. Paste the **Connect line** from Chronicle (your campaign → **Manage → Apps & game system**, Foundry VTT row → **Make a connect line**) and save; it fills in the URL, API key and campaign ID, then reload Foundry. Or enter the **API URL**, **API Key**, and **Campaign ID** by hand
4. Enable the sync categories you want (Journals, Maps, Calendar, Characters)

The module runs sync for the GM only. Players receive updates passively through Foundry.

## Optional Modules

- [Monk's Enhanced Journal](https://foundryvtt.com/packages/monks-enhanced-journal) — Enhanced journal page support
- [Calendaria](https://foundryvtt.com/packages/calendaria) — Calendar sync
- [Simple Calendar](https://foundryvtt.com/packages/foundryvtt-simple-calendar) — Calendar sync (alternative)

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
