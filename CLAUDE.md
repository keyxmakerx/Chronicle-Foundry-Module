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
  _calendar-subresources.mjs      # Pure: weather/season/era/moon payload normalization, GM chat lines, dashboard snapshot reducer
  actor-sync.mjs                  # Character entity ↔ Actor sync
  item-sync.mjs                   # Item sync
  note-sync.mjs                   # Chronicle Notes ↔ JournalEntry sync
  shop-widget.mjs                 # Shop inventory UI
  sync-dashboard.mjs              # Dashboard UI: Overview cockpit + grouped vertical rail (Everyday/Library/Setup/Diagnostics)
  _overview-model.mjs             # Pure builder for the Overview landing cockpit (stats + prioritized "needs attention")
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
- Sync modules use a `_syncing` guard to prevent infinite loops. Most back it
  with a boolean; `calendar-sync.mjs` backs it with a reentrant `_syncDepth`
  counter (read through a `_syncing` getter) because its back-catalog loop and
  WebSocket handlers can overlap, and a boolean's `finally` would unmask the
  loop mid-flight (FM-CAL-BACKCATALOG-FIX item 3).
- System adapters implement `toChronicleFields()` / `fromChronicleFields()`.
- All REST calls use Bearer token auth via `api-client.mjs`.
- **List responses come in two shapes.** Chronicle returns some list endpoints
  as a bare JSON array and others wrapped in an envelope `{"data":[…],"total":N}`
  (envelope: `/entities`, `/entity-types`, `/systems`, `/addons`, `/tags`,
  `/relations/types`, `/calendar/events`; bare: `/maps`, `/maps/:id/*`,
  `/members`, `/entities/:id/relations`, `/notes`). Every list-consuming caller
  MUST unwrap defensively — accept a bare array AND `{data:[…]}` — via
  `result?.data || result || []`, `_normalizeArray()`, `_coerceArray()`, or an
  `Array.isArray(x) ? x : (x?.data ?? [])` guard, never assuming one shape. A
  caller that consumes an envelope endpoint as a bare array is a silent no-op
  (the #77 back-catalog bug). All call sites were audited under
  FM-ENVELOPE-AUDIT (see `tools/test-envelope-audit.mjs`).
- **Real-time calendars are read-only for dates.** `GET /calendar/date` carries
  `tracks_real_time` (the composed `UsesRealTime()` predicate; RC-4,
  FM-REALTIME-DATE-SIGNAL) — `GET /calendar` never does. When true, the module
  pauses its own date-**push** only (pull/event sync unaffected). All four push
  sites (`calendar-sync.mjs`'s three hook-triggered pushes,
  `sync-dashboard.mjs`'s manual push button) route through the shared
  `scripts/_realtime-date-guard.mjs`: a fetch-before-push `GET` re-probed on
  every push (never trust a session-long cached value — pushes are rare, so
  the extra round trip is cheap and self-heals a mid-session enable), plus a
  422-from-`PUT`-is-the-same-condition backstop (never a retryable sync
  error). The GM notice fires once per session, shared across both files via
  a module-level singleton. See `tools/test-realtime-date-signal.mjs`.
- **Calendar sub-resources are display-only.** `calendar.weather/season/era/
  moon/worldstate` land on the dashboard's world-state panel and (per-type world
  setting) a **GM-whispered** chat line — never public chat, since Chronicle's
  dm_only gating is server-side and re-broadcasting would launder it into a
  player-visible decision. `calendar.structure.updated` (+ its `cycle`/`festival`
  siblings) re-runs the structure comparison and badges the result but **never
  auto-applies the structure** — that would silently re-date every Calendaria
  note. It is routed AHEAD of the `_calendarSyncDisabled` guard because it is
  the only signal that can clear a mismatch pause. Every other `calendar.*` type
  hits a `default:` that logs once per type per session. See
  `scripts/_calendar-subresources.mjs`, `tools/test-calendar-subresources.mjs`,
  `tools/test-calendar-subresource-routing.mjs` (FM-SYNC-SUBRESOURCES-P1).
- **Chronicle update endpoints are PARTIAL: absent preserves, an explicit
  `null` clears, a present value replaces** (Chronicle sweep R4, 2026-08-07;
  API-CONTRACT.md → "The partial-update contract"). Chronicle's request
  structs bind `patch.Field[T]`, which records presence during decoding, so
  absent and `null` are genuinely different. **Send only the fields you mean
  to change**, and do NOT "harden" a narrow body by echoing the untouched
  fields back: an echo re-arms the endpoint for the next writer and goes
  stale — that is how `ChronicleMarkerConfigDialog` lost the pairing key. The
  narrow bodies are pinned by `tools/test-partial-put-contract.mjs`
  (`actor-sync`'s `{name}` rename push; `calendar-sync`'s three note-edit
  pushes). Before the contract existed, `{name}` alone bound
  `is_private=false` and **published a hidden character entity to every
  player**, and the calendar pushes turned `is_recurring` and `all_day` off.
  The one surviving echo is the marker dialog's spread, kept deliberately:
  harmless against a merging server, load-bearing against a pre-R4 one.
- **Never walk a list with a small hard-coded page cap.** The two places that
  need every entity in the campaign — `JournalSync.resyncAll` and the
  dashboard's `_buildEntityGroups` — both had `while (hasMore && page <= 5)`
  inline, a silent 500-entity ceiling: past it entities were never seen, and
  the GM got a completed resync and a full-looking dashboard anyway. Both now
  share `scripts/_entity-page-walk.mjs`, whose bound is 200 pages and whose
  `truncated` flag MUST be surfaced by the caller. A bound is fine; a bound
  nobody is told about is the defect. See `tools/test-entity-page-walk.mjs`.
  Chronicle's server-side twin (`POST /sync` capped at 1000 with no cursor)
  was fixed in Chronicle sweep R4 stage 18 — that endpoint now returns
  `next_cursor`, which this module does not yet consume because it pulls via
  `GET /entities`, not `POST /sync`.
- WebSocket messages are routed by type through `SyncManager`.
- Chronicle-side serving rules live in `chronicle-package.json` at repo root; CI validates it against `module.json` via `tools/check-package-descriptor.mjs`.

## TODO

- (none currently) — the Foundry V1→V2 `DialogV2` migration and the
  `render(true)` → `render({ force: true })` cleanup are complete, centralized in
  `scripts/_dialogs.mjs` and pinned by `tools/test-dialogs.mjs`.
- Recommended once on a live **v14** client (can't be unit-tested headlessly):
  smoke-test the migrated dialogs (resync / pull / push confirms, the "create
  entity type" prompt, map pin & marker delete confirms, the calendar cleanup
  confirm) and the dashboard Calendar tab (Foundry local date now renders, the
  four-state sync badge — in-sync / date-drift with direction /
  incompatible-structures / paused, FM-SYNC-WIRE-FIX — and Push-date button).
- **Blocked on Chronicle (FM-SYNC-SUBRESOURCES-P1 Step 0):**
  `calendar.worldstate.changed` is published by
  `internal/plugins/calendar/worldstate_service.go` but has no `case` in
  `calendarEventPublisherAdapter.PublishCalendarEvent`
  (`internal/app/routes.go`), so it hits `default: return` and never reaches
  the bus (`calendar.weather.zones.changed` is dropped the same way). The
  payload also carries no celestial detail (`{date, moodTint}`) and
  `GET /calendar/world-state` isn't on the syncapi group. The module handler
  is wired + tested and dormant until Chronicle closes these. See
  API-CONTRACT.md → "Gap: `calendar.worldstate.changed` never reaches the wire".
- Recommended once on a live client after FM-SYNC-SUBRESOURCES-P1 (can't be
  unit-tested): set weather / cross a season or era boundary in Chronicle and
  confirm the GM whisper lands and the Calendar tab's "Chronicle world state"
  panel fills; edit the calendar structure in Chronicle and confirm the badge
  flips to "Structure Changed — Re-check" without the Foundry calendar being
  modified; confirm a structure-mismatch pause CLEARS when the Chronicle
  calendar is fixed (no world reload needed); check the diagnostics bundle's
  `CALENDARIA.api methods available` block for whether the build exposes any of
  `setWeather` / `setCurrentWeather` / `setWeatherForDate`.
- Recommended on a live client after FM-SYNC-WIRE-FIX (can't be unit-tested):
  confirm initial sync now fires on a fresh world AND a world with pre-existing
  synced data (console shows `_performInitialSync` / "Initial sync complete");
  confirm a SimpleCalendar world with a mismatched structure pauses + badges
  "incompatible"; confirm the entity visibility toggle round-trips (via
  `/reveal`) and item add/remove/update relations round-trip.
