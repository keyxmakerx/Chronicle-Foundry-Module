# Chronicle Sync — Foundry VTT Module

This repo contains the **Chronicle Sync** module for Foundry VTT. It provides
bidirectional real-time sync between a [Chronicle](https://github.com/keyxmakerx/Chronicle)
worldbuilding instance and a Foundry VTT game world.

## Architecture

See `.ai.md` for full architecture, data flow, file index, and feature details.

Entry point: `scripts/module.mjs` → registers settings on `init`, starts
`SyncManager` on `ready` (GM only).

## File Structure

```
module.json                       # Foundry module manifest (v12–v14)
chronicle-package.json            # Chronicle serving descriptor (schema v1)
scripts/                          # ES modules (.mjs)
  module.mjs                      # Entry point
  settings.mjs                    # World settings registration
  constants.mjs                   # Shared constants (FLAG_SCOPE, MODULE_ID)
  sync-manager.mjs                # Orchestrator, API routing, WS management
  api-client.mjs                  # REST + WebSocket client
  journal-sync.mjs                # Entity ↔ JournalEntry sync
  map-sync.mjs                    # Chronicle map + sub-resources ↔ JournalEntry (image page); markers/drawings/tokens/fog/layers rendered as overlays via MapViewerSheet
  map-viewer.mjs                  # MapViewerSheet (ApplicationV2): image + SVG overlay
  calendar-sync.mjs               # Calendar adapter (Calendaria/SimpleCalendar)
  actor-sync.mjs                  # Character entity ↔ Actor sync
  item-sync.mjs                   # Item sync
  note-sync.mjs                   # Chronicle Notes ↔ JournalEntry sync
  shop-widget.mjs                 # Shop inventory UI
  sync-dashboard.mjs              # 8-tab dashboard UI
  update-info.mjs                 # "Update Source" diagnostic dialog (install/update flow)
  character-claim-indicator.mjs   # Per-player character-claim status indicator
  import-wizard.mjs               # Initial-import wizard UI
  adapters/                       # Game system field mappers
    generic-adapter.mjs           # API-driven adapter for all systems
templates/                        # Handlebars templates
styles/                           # CSS
lang/                             # Localization (en.json)
tools/
  check-package-descriptor.mjs    # CI: validates chronicle-package.json vs module.json
.github/workflows/
  check-descriptor.yml            # Runs the descriptor check on push + PR
  release.yml                     # Builds release zip (manual workflow_dispatch)
```

## API Contract

See **API-CONTRACT.md** for the full Chronicle REST API and WebSocket contract,
plus the Chronicle-served module distribution contract (per-campaign manifest +
download endpoints, serving descriptor, error JSON shape).

For the install/update flow specifically, also see `.ai.md` → "Chronicle
Integration — Install & Updates".

## Code Conventions

- **ES modules** (`.mjs`) with `export default class` pattern.
- Sync modules use a `_syncing` boolean guard to prevent infinite loops.
- System adapters implement `toChronicleFields()` / `fromChronicleFields()`.
- All REST calls use Bearer token auth via `api-client.mjs`.
- WebSocket messages are routed by type through `SyncManager`.
- Chronicle-side serving rules live in `chronicle-package.json` at repo root; CI validates it against `module.json` via `tools/check-package-descriptor.mjs`.

## TODO

- **Foundry V1 → V2 dialog migration (v16-proofing).** Ten call sites still use
  the deprecated V1 `Dialog` helper (still renders on v14; removed in v16):
  `sync-dashboard.mjs` (1 `Dialog.prompt` + 6 `Dialog.confirm`), `map-viewer.mjs`
  (2 `Dialog.confirm`), `sync-calendar.mjs` (1 `Dialog.confirm`). Migrate to
  `foundry.applications.api.DialogV2` — note the `prompt` callback signature
  changes to `(event, button, dialog)` (read fields from `button.form`).
  Suggested: a small `scripts/_dialogs.mjs` wrapper + a static regression test
  asserting no bare `new Dialog` / `Dialog.confirm` / `Dialog.prompt` remain.
  Deferred (not runtime-testable without a live Foundry; fixes no current bug).
  Details + call-site list in `AUDIT-2026-06-21-foundry-errors.md` → "DEFERRED".
- Low priority: `render(true)` → `render({ force: true })` (V1 render signature)
  at `map-viewer.mjs:875,967` and `sync-dashboard.mjs:1190`.
