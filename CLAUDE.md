# Chronicle Sync — Foundry VTT Module

The **Chronicle Sync** module for Foundry VTT: bidirectional real-time sync
between a [Chronicle](https://github.com/keyxmakerx/Chronicle) instance and a
Foundry world. Entry point `scripts/module.mjs` (settings on `init`,
`SyncManager` on `ready`, GM only). **`.ai.md` is the full reference**: what
each file does, data flow, endpoints, security posture. Read the section you
need rather than the whole file.

## Layout

`scripts/*.mjs` module code (`_*.mjs` are pure helpers, most tested by their own
`tools/test-*.mjs`); `templates/`, `styles/`, `lang/en.json`; `fonts/` holds the
Sky Clock's font; `assets/` holds the generic monster token;
`vendor/chronicle/` holds Chronicle's shop room and sky widgets, copied unchanged;
`bench/` is the two-sided sync bench (`CHRONICLE_DIR=../Chronicle bench/run.sh`),
and a sync change is not ready until its bench scenarios pass. Tests: Node's
test runner, see `TESTING.md`. **API-CONTRACT.md** is the Chronicle REST and
WebSocket contract.

## Rules the code must keep

Each is pinned by the test named in `.ai.md`; read it there before changing one.

- ES modules, `export default class`. Comments say why, briefly; no task IDs,
  dates or `file:line` (`tools/check-comment-clutter.sh`). Deferred work is `TODO(#issue)`.
- Tool windows take colours from `styles/tokens.css` (`--cs-*`, light and dark).
  Paper look only on the quest notices and sheet, player notebook and shop room.
- The API key is client-scoped, never world-scoped.
- List responses are a bare array or `{"data":[…],"total":N}`; unwrap defensively.
- Chronicle update endpoints are partial: send only changed fields.
- GM-only content never goes into a saved Foundry document (secret-block placeholders).
- Sync never deletes without asking; Chronicle-side removals set things aside.
- Never hard-cap a list walk; surface the `truncated` flag.
- Chronicle owns the calendar: the module pulls it and pushes dates and events
  back; players see only `?audience=players` data. Real-time calendars are
  read-only for dates. Retired calendar routes answer 410; only a 503 saying
  `calendar_rebuilding` arms the blackout guard.
- Connect catch-up reads `GET /sync/changes`; replays must be harmless.
- `_syncing` is the boolean guard against sync loops.

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

Tracked in GitHub issues: live checks on a real Foundry v14 world (#94, using
`TESTING.md`); calendar V5 (#95, sub-issue of
keyxmakerx/Chronicle#741); everything else in this repo's open issues; unplanned
ideas #96.

Cross-repo claims carry a `Re-verify by:` line (API-CONTRACT.md); past that
date, treat the claim as unknown, not fact.
