# Sync bench

Runs the module's real sync code against a real Chronicle and checks that
both sides end up agreeing. Unit tests in `tools/` check one function at a
time; the bench checks the whole round trip, which is where most past sync
bugs lived (a field Chronicle refused, a delete that came back, an edit that
never left Foundry).

- `fake-foundry.mjs` is an in-memory Foundry world: journals, pages, actors
  and their items, folders, settings and hooks, with Foundry's semantics where sync bugs hide
  (every write fires its hook with the diff, options and user id; handlers
  are not awaited; page edits fire page hooks).
- `chronicle.mjs` sets up a campaign through Chronicle's own sign-up and
  campaign forms and makes two API keys: one for the module, one for
  "someone editing in Chronicle".
- `world.mjs` opens and closes the world (a new `SyncManager` with the real
  sync modules), records the module's requests, and waits until it is quiet.
  Its `benchAdapter` is the one stand-in: a game system's field mapping
  (Chronicle `fields_data.hp` ↔ Foundry `system.hp`), because a fresh
  Chronicle has no system package installed.
- `chronicle.mjs` also makes maps (`seed.createMap`), through the owner's
  web route with the campaign's maps add-on switched on, since the sync API
  only reads maps.
- `scenario.mjs` holds what every scenario shares: the wrapper and the
  checks each one ends with (no duplicate pages, journals or actors, no
  character turned into a journal, both sides agree on names, no failed
  writes, no hook errors, no error pop-ups).
- `*.bench.mjs` are the scenarios, one file per area (`journals`, `actors`,
  `items`, `maps`, `notes`); the area name is the argument to `run.sh`.

## Running it

```bash
CHRONICLE_DIR=../Chronicle bench/run.sh            # every area
CHRONICLE_DIR=../Chronicle bench/run.sh journals   # one area
```

`run.sh` builds Chronicle from `CHRONICLE_DIR`, starts it on a fresh
database, runs the scenarios and stops it. It uses `DATABASE_URL` and
`REDIS_URL` when set (CI services), otherwise Chronicle's no-Docker test
MariaDB (`tools/start-test-db.sh`) and a local `redis-server`. Needs Go,
Node 22 (built-in `WebSocket`) and the `mysql` client. `BENCH_VERBOSE=1`
shows the module's own console output; `BENCH_KEEP_LOG=1` keeps the
server log.

CI runs it on every pull request (`.github/workflows/sync-bench.yml`)
against the Chronicle branch with the same name as the PR branch, or
`main` when there is none, so a change made in both repos is tested
together before either merges.

## Adding a scenario

Write it with `scenario(label, async ({ seed, world }) => { ... })` so it
gets its own campaign and the shared checks. Do things the way a GM would
(`JournalEntry.create`, `journal.update`, `seed.chronicle.put(...)`), then
`settle()` before asserting. A known gap goes in as a `{ todo: '...' }`
test that names the issue, so it shows up without failing the run.
