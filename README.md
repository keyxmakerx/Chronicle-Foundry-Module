<h1 align="center">Chronicle Sync</h1>

<p align="center">
  <b>Your <a href="https://github.com/keyxmakerx/Chronicle">Chronicle</a> campaign and your Foundry VTT world, kept in step both ways.</b><br>
  Journals, maps, characters, items, shops and the calendar, live while you play.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-6366f1"></a>
  <img alt="Foundry VTT v12 to v14" src="https://img.shields.io/badge/foundry-v12%E2%80%93v14-f97316">
</p>

Write in Chronicle between sessions and run the game in Foundry. Chronicle Sync runs in the GM's Foundry client and keeps the two in step: a change on either side shows up on the other, and journals, characters, inventories and map items catch up on what changed while Foundry was closed. Players never need a key of their own.

## What it syncs

- **Journals**: Chronicle pages become Foundry journal entries. GM-only text and pictures stay hidden from players who don't own the page, and nothing is deleted without asking.
- **Maps**: Chronicle maps open as Foundry journal pages with their markers, drawings, tokens, layers and fog. Players see the smudged picture of a shadowed map, and the GM can hand a map to a character.
- **Characters and items**: actors and character pages map field by field for D&D 5e, Pathfinder 2e, or any system whose fields are annotated.
- **Calendar**: Chronicle's date, weather, season, era and moon phases, with no Foundry calendar module needed.
- **Shops and stashes**: Chronicle's shop rooms open in Foundry, and players buy with the character they pick. Stashes move items and money between characters, with the GM approving players' requests from a chat card.
- **DM Screen and notebook**: the GM's DM Screen from Chronicle in a Foundry window, and each player's own Chronicle journal and jot notes.
- **NPC tokens**: spotlight, talking glow and open page for Chronicle NPCs. "Show in Foundry" on an NPC page spotlights its token.
- **Sync dashboard**: diagnostics, error logs, a copyable diagnostic bundle, a setup wizard for the first import, and the same sync history the owner sees in Chronicle.

> **Older Chronicle servers and the calendar.** A Chronicle that still answers
> calendar routes with `503 calendar_rebuilding` makes the module pause calendar
> pushes for the session rather than report an error. Nothing is wrong on your
> side, and journals, maps, characters and items sync as usual.

## Install

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

## Configuration

1. Enable the module in your world's **Module Management**
2. Open **Game Settings → Module Settings → Chronicle Sync**
3. Paste the **Connect line** from Chronicle (your campaign → **Manage → Foundry**, **Connection** card → **Make a connect line**) and save; it fills in the URL, API key and campaign ID, then reload Foundry. Or enter the **API URL**, **API Key**, and **Campaign ID** by hand
4. Enable the sync categories you want (Journals, Maps, Calendar, Characters)

The module runs sync for the GM only. Players receive updates passively through Foundry.

## Updating

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

## Compatibility

| Foundry VTT | Status |
|-------------|--------|
| v12         | Minimum supported |
| v13         | Supported |
| v14         | Verified |

## Optional Modules

- [Monk's Enhanced Journal](https://foundryvtt.com/packages/monks-enhanced-journal) — Enhanced journal page support

## For the Chronicle operator

<details>
<summary><b>Shipping a new module version</b></summary>

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

</details>

<details>
<summary><b>The package descriptor, for Chronicle integrators</b></summary>

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

</details>

## Contributing

Bug reports and ideas are welcome as [issues](https://github.com/keyxmakerx/Chronicle-Foundry-Module/issues). How the module works is in [`.ai.md`](.ai.md), the Chronicle API it relies on is in [`API-CONTRACT.md`](API-CONTRACT.md), and [`TESTING.md`](TESTING.md) covers the tests and the two-sided sync bench.

## License

[MIT](LICENSE).
