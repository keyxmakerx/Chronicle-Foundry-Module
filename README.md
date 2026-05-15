# Chronicle Sync — Foundry VTT Module

Bidirectional real-time sync between [Chronicle](https://github.com/keyxmakerx/Chronicle) and Foundry VTT.

## Features

- **Journal Sync** — Chronicle entities ↔ Foundry journal entries (with multi-page splitting)
- **Map Sync** — Chronicle map markers ↔ Foundry scene pins (with "View in Chronicle" for full map editor)
- **Calendar Sync** — Calendaria and Simple Calendar integration
- **Character Sync** — Actor ↔ character entity with system-aware field mapping (D&D 5e, Pathfinder 2e, or any system with annotated fields)
- **Shop Widget** — Browse and purchase from Chronicle shop entities in Foundry
- **Sync Dashboard** — 8-tab management UI with diagnostics, error logs, and health metrics
- **Permission Mapping** — Chronicle visibility ↔ Foundry ownership levels

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

1. In Chronicle, open your campaign → **Settings → Foundry Module** tab.
2. Copy the **install URL** shown on that page.
3. In Foundry VTT, go to **Add-on Modules → Install Module**, paste the
   URL, and click **Install**.

After install, Foundry remembers that URL and re-uses it on every update
check — so you'll receive whichever module version your campaign owner
pins, without further configuration.

> **For Chronicle admins:** upload new module `.zip` builds via
> `/admin/modules/foundry` on your Chronicle instance. Campaign owners
> can then pin any uploaded version per-campaign from their settings
> tab.

> **GitHub release distribution is deprecated.** The
> `https://github.com/.../releases/latest/download/module.json` URL is
> no longer published. Existing installs that point at GitHub continue
> to run, but no further updates will arrive via that channel — open
> the **Update Source** panel inside the module settings (Game Settings
> → Module Settings → Chronicle Sync → Update Source) to check whether
> your install needs to be re-pointed at Chronicle.

## Configuration

1. Enable the module in your world's **Module Management**
2. Open **Game Settings → Module Settings → Chronicle Sync**
3. Enter your Chronicle **API URL**, **API Key**, and **Campaign ID**
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
