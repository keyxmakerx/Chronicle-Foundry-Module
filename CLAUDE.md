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
  logger.mjs                      # Shared console logging helper
  sync-manager.mjs                # Orchestrator, API routing, WS management
  api-client.mjs                  # REST + WebSocket client
  journal-sync.mjs                # Entity ↔ JournalEntry sync
  map-sync.mjs                    # Chronicle map + sub-resources ↔ JournalEntry (image page); markers/drawings/tokens/fog/layers rendered as overlays via MapViewerSheet
  map-viewer.mjs                  # MapViewerSheet (ApplicationV2): image + SVG overlay
  calendar-sync.mjs               # Calendar adapter (Calendaria/SimpleCalendar)
  sync-calendar.mjs               # "Sync Calendar" editor (ApplicationV2, GM-only)
  sync-calendar-*.mjs             # Pure helpers behind the editor: validation, note-form, moon-strip, condition-builder, diagnostics, Calendaria import
  actor-sync.mjs                  # Character entity ↔ Actor sync
  item-sync.mjs                   # Item sync
  note-sync.mjs                   # Chronicle Notes ↔ JournalEntry sync
  shop-widget.mjs                 # Shop inventory UI
  sync-dashboard.mjs              # Dashboard UI: Overview cockpit + grouped vertical rail (Everyday/Library/Setup/Diagnostics)
  sync-diagnostic-bundle.mjs      # Builds the dashboard's full diagnostics export
  update-info.mjs                 # "Update Source" diagnostic dialog (install/update flow)
  character-claim-indicator.mjs   # Per-player character-claim status indicator
  capability-inspector.mjs        # Probes the local Foundry/system/Calendaria capabilities
  import-wizard.mjs               # Initial-import wizard UI
  adapters/
    generic-adapter.mjs           # API-driven actor field adapter for all systems (incl. actor-embedded items)
  _*.mjs                          # Pure, Foundry-independent helper modules (guards, validators,
                                   # view-model builders); each is unit-tested by its own tools/test-*.mjs
templates/                        # Handlebars templates
styles/                           # CSS
lang/                             # Localization (en.json)
tools/
  check-package-descriptor.mjs    # CI: validates chronicle-package.json vs module.json
  test-*.mjs                      # Node's built-in test runner; one file per module/behavior (see TESTING.md)
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
- **Comments say why, briefly.** State the rule the code obeys and why, in a few lines, pointing at a test or issue if more is needed. No incident stories, task IDs (`FM-…`), dates or `file:line` pointers; those go in the PR. Deferred work is `TODO(#issue)`.
- Sync modules use a `_syncing` guard to prevent infinite loops. Most back it
  with a boolean; `calendar-sync.mjs` backs it with a reentrant `_syncDepth`
  counter (read through a `_syncing` getter) because its back-catalog loop and
  WebSocket handlers can overlap, and a boolean's `finally` would unmask the
  loop mid-flight.
- System adapters implement `toChronicleFields()` / `fromChronicleFields()`.
- All REST calls use Bearer token auth via `api-client.mjs`.
- **The API key is a CLIENT-scoped setting, never world-scoped.** A world
  setting is synced to every connected client — `config: false` only hides it
  from the UI — so a world-scoped key hands the campaign's Bearer token to
  every player's browser console. `migrateApiKeyToClientScope()` moves a
  legacy world-scoped value into the GM's browser and deletes the world
  document. Pinned by `tools/test-api-key-scope.mjs`.
- **List responses come in two shapes.** Chronicle returns some list endpoints
  as a bare JSON array and others wrapped in an envelope `{"data":[…],"total":N}`
  (envelope: `/entities`, `/entity-types`, `/systems`, `/addons`, `/tags`,
  `/relations/types`, `/calendar/events`; bare: `/maps`, `/maps/:id/*`,
  `/members`, `/entities/:id/relations`, `/notes`). Every list-consuming caller
  MUST unwrap defensively — accept a bare array AND `{data:[…]}` — via
  `result?.data || result || []`, `_normalizeArray()`, `_coerceArray()`, or an
  `Array.isArray(x) ? x : (x?.data ?? [])` guard, never assuming one shape. A
  caller that consumes an envelope endpoint as a bare array is a silent no-op.
  All call sites are pinned at `tools/test-envelope-audit.mjs`.
- **Real-time calendars are read-only for dates.** `GET /calendar/date` carries
  `tracks_real_time` (the composed `UsesRealTime()` predicate) — `GET
  /calendar` never does. When true, the module
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
  `tools/test-calendar-subresource-routing.mjs`.
- **Chronicle update endpoints are PARTIAL: absent preserves, an explicit
  `null` clears, a present value replaces** (see API-CONTRACT.md → "The
  partial-update contract"). Chronicle's request
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
  harmless against a merging server, load-bearing against an older one that
  predates the partial-update contract.
- **Never walk a list with a small hard-coded page cap.** The two places that
  need every entity in the campaign — `JournalSync.resyncAll` and the
  dashboard's `_buildEntityGroups` — both had `while (hasMore && page <= 5)`
  inline, a silent 500-entity ceiling: past it entities were never seen, and
  the GM got a completed resync and a full-looking dashboard anyway. Both now
  share `scripts/_entity-page-walk.mjs`, whose bound is 200 pages and whose
  `truncated` flag MUST be surfaced by the caller. A bound is fine; a bound
  nobody is told about is the defect. See `tools/test-entity-page-walk.mjs`.
  Chronicle's server-side twin (`POST /sync`, once capped at 1000 with no
  cursor) now returns `next_cursor`, which this module does not yet consume
  because it pulls via `GET /entities`, not `POST /sync`.
- WebSocket messages are routed by type through `SyncManager`.
- Chronicle-side serving rules live in `chronicle-package.json` at repo root; CI validates it against `module.json` via `tools/check-package-descriptor.mjs`.

## Calendar blackout

Chronicle deleted its calendar plugin for a ground-up rebuild (V5); the data
was not preserved. Every syncapi calendar route stays registered and answers
`HTTP 503 {"error":"calendar_rebuilding", "message":"..."}` — 503 rather than
404 so the module doesn't mistake it for an old Chronicle without the
endpoint. No `calendar.*` WebSocket message reaches the wire either.

The module classifies this as its own `'rebuilding'` probe state, shows the
GM a one-time notice per session instead of erroring on every push, and keeps
maps, actors, items and notes syncing normally. A structure-mismatch pause
taken before the blackout can't be cleared by its normal recovery path until
V5 ships — reload the world instead. Pinned by `tools/test-calendar-blackout.mjs`.

## Working with this project

These rules come from the old coordination repo (Cordinator), which is now a
frozen archive. The same block is in the CLAUDE.md of Chronicle, the Foundry
module and the Draw Steel package; change all three together. The binding
tenets the PR templates name (T-B1 security first, T-B2 plugin isolation, T-B3
production-grade UI, T-B4 docs for humans and AI alike) are defined in
Cordinator's `decisions/2026-05-21-core-tenets.md`.

**With the operator** (the maintainer, who reviews and deploys):
- Explain things in plain language, without code. Give each trade-off in one sentence.
- Give live checks as click-paths: the exact URL, what to click, and what working
  and broken look like. Docker, OS and network commands are fine; never ask the
  operator to read code or run a test suite.
- The operator checks things later, not while you wait. Put checks in an issue
  labelled `needs-operator`, and when work is blocked on them, name the exact action.
- Decide and recommend. Don't offer a menu of options for things you can judge;
  ask only about real product, visual or scheduling choices.
- Stop at natural stopping points rather than interrupting with status questions.
- UI work gets a mockup first, and a mockup the operator signed stays the contract
  until they sign a new one. A decision about motion is shown as playable clips,
  never stills.

**Safety**
- Chronicle runs in production. Verify, then fix; back up before deploys; put
  anything risky behind an operator step. Security wins every tie.
- A merged PR is not a deployed fix. Deploy settings and gates are separate steps
  with their own checks.

**Verify before you claim**
- Read the source in the same turn before naming files, lines, identifiers or wire
  values. Verify a wire contract from the code that consumes it.
- Check any claim about state (open, merged, shipped, deployed) against git or
  GitHub first. A claim measured against another repo is true only on the day it
  was measured.
- A root cause is a guess until the code confirms it; a bug-fix PR says why the bug
  existed. When the scope is unclear, start by reading, not changing.
- CI red with local green on the same commit means an environment difference until
  proven otherwise.
- If a rule can't be followed or the task is wrong, stop and say so instead of
  pressing on.

**Scope and reporting**
- The PR description is what gets reviewed: what and why, the load-bearing lines,
  honest deviations, the exact test commands and their pass counts.
- Stay inside the task. Open an issue for anything else; ship the smallest useful
  change and split the follow-ups.

**Sessions**
- Big agent fleets are welcome for work that splits cleanly, but run them on a
  lighter model. Never fan a large fleet out on the most expensive model; keep
  that for the few agents that need it. Usage is a real limit.
- One session per piece of work, ended when it ships. Don't sit in a loop polling
  for CI or PR events.
- Work only on the branch you were given. Never push to another branch without
  explicit permission.
- File the issue before handing work on, and never point anyone at something that
  hasn't landed.

## Open work

Tracked in GitHub issues, not in this file:

- **Live checks on a real Foundry v14 world** (the migrated dialogs, the
  dashboard, initial sync, visibility, shops, characters): #94, once
  `TESTING.md` is brought up to date (#88).
- **Calendar V5.** Everything calendar-shaped waits for Chronicle's rebuild:
  #95, a sub-issue of keyxmakerx/Chronicle#741. That includes pointing the
  module at a chosen Chronicle calendar. Until Chronicle allows it, the
  structure-mismatch message says the reachable thing (edit either calendar so
  the two agree), and `tools/test-calendar-mismatch-remedy.mjs` fails if any of
  the three mismatch prints starts recommending an import or a new calendar.
- Everything else is in this repo's open issues. Ideas nobody has planned: #96.

**A claim measured against another repo's source is only true on the day it
was measured.** `calendar.worldstate.changed` stayed booked here as "blocked on
Chronicle" for 26 days after Chronicle fixed it (commit `f8d3550`,
2026-07-26), because nobody re-checked. Claims like that in these docs carry a
`Re-verify by:` date; past it, treat the claim as unknown, not as fact.
