# Chronicle Sync — Foundry VTT Module

The **Chronicle Sync** module for Foundry VTT: bidirectional real-time sync
between a [Chronicle](https://github.com/keyxmakerx/Chronicle) worldbuilding
instance and a Foundry VTT game world. See `.ai.md` for full architecture,
data flow, file index and feature details. Entry point: `scripts/module.mjs`
— registers settings on `init`, starts `SyncManager` on `ready` (GM only).

## File Structure

- `module.json` (Foundry manifest, v12–v14), `chronicle-package.json`
  (serving descriptor, schema v1) — cross-validated by
  `tools/check-package-descriptor.mjs`.
- `scripts/*.mjs`: sync (`journal-sync`, `map-sync`+`map-viewer`,
  `calendar-sync`+`sync-calendar`+`sync-calendar-*`, `actor-sync`,
  `item-sync`, `note-sync`), UI (`sync-dashboard`,
  `sync-diagnostic-bundle`, `update-info`, `character-claim-indicator`,
  `capability-inspector`, `import-wizard`, `shop-widget`), core (`module`,
  `settings`, `constants`, `logger`, `sync-manager`, `api-client`),
  `adapters/generic-adapter.mjs`. `.ai.md` has what each does. `_*.mjs` are
  pure helpers, each unit-tested by its own `tools/test-*.mjs`.
- `templates/` Handlebars, `styles/` CSS, `lang/en.json` strings,
  `tools/test-*.mjs` (Node's test runner, see TESTING.md).
- `.github/workflows/`: `check-descriptor.yml`, `release.yml` (Actions → Release
  with a version; tags main), `snapshot.yml`.

## API Contract

**API-CONTRACT.md**: full Chronicle REST/WebSocket contract plus the module
distribution contract (manifest, downloads, descriptor, error shape).
Install/update flow: also `.ai.md` → "Chronicle Integration — Install & Updates".

## Code Conventions

- **ES modules** (`.mjs`), `export default class` pattern.
- **Comments say why, briefly**, pointing at a test/issue for more — no incident stories, task IDs, dates or `file:line` (those go in the PR). Deferred work is `TODO(#issue)`.
- `_syncing` guard against infinite loops: boolean, except `calendar-sync.mjs`'s reentrant `_syncDepth` counter (overlapping back-catalog loop and WebSocket handlers).
- Adapters implement `toChronicleFields()`/`fromChronicleFields()`; REST uses Bearer auth via `api-client.mjs`.
- **API key is CLIENT-scoped, never world-scoped** (a world setting syncs to every client). `migrateApiKeyToClientScope()` migrates legacy values. `tools/test-api-key-scope.mjs`.
- **List responses are bare array or `{"data":[…],"total":N}`** — unwrap defensively everywhere. Envelope: `/entities`, `/entity-types`, `/systems`, `/addons`, `/tags`, `/relations/types`, `/calendar/events`. Bare: `/maps`, `/maps/:id/*`, `/members`, `/entities/:id/relations`, `/notes`. `tools/test-envelope-audit.mjs`.
- **Real-time calendars are read-only for dates**: `tracks_real_time` from `GET /calendar/date` pauses date-push only, via `scripts/_realtime-date-guard.mjs`. `tools/test-realtime-date-signal.mjs`.
- **Calendar sub-resources are display-only** (dashboard + optional GM-whisper, never public); `structure.updated` badges mismatches, never auto-applies. `scripts/_calendar-subresources.mjs`, `tools/test-calendar-subresources.mjs`, `tools/test-calendar-subresource-routing.mjs`.
- **Chronicle update endpoints are PARTIAL**: absent preserves, `null` clears, present replaces (API-CONTRACT.md → "partial-update contract"). Send only changed fields; never echo untouched ones back. `tools/test-partial-put-contract.mjs`. One deliberate exception: the marker dialog in `scripts/map-viewer.mjs` spreads the stored marker, harmless on current Chronicle and needed by older servers that replace the whole record.
- **Never hard-cap a list walk.** `JournalSync.resyncAll` and `_buildEntityGroups` share `scripts/_entity-page-walk.mjs` (200-page bound); its `truncated` flag must be surfaced. `tools/test-entity-page-walk.mjs`.
- WebSocket messages route by type through `SyncManager`.

## Calendar blackout

Chronicle's calendar plugin is mid-rebuild (V5): every calendar route answers
`HTTP 503 {"error":"calendar_rebuilding", ...}` (503 so the module doesn't
mistake it for an old Chronicle lacking the endpoint); no `calendar.*`
WebSocket message fires. The module shows a one-time GM notice per session
and keeps maps/actors/items/notes syncing. A pre-blackout structure-mismatch
pause needs a world reload to clear until V5 ships. `tools/test-calendar-blackout.mjs`.

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

Tracked in GitHub issues: live checks on a real Foundry v14 world (#94, needs
`TESTING.md` update #88); calendar V5 (#95, sub-issue of
keyxmakerx/Chronicle#741); everything else in this repo's open issues; unplanned
ideas #96.

Cross-repo claims carry a `Re-verify by:` line (API-CONTRACT.md); past that
date, treat the claim as unknown, not fact.
