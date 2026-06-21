# Chronicle Sync — Foundry error audit (2026-06-21)

Status: **fixes #1–#5 implemented, tested (suite 499 → 521 green), and pushed to
`claude/jolly-lamport-755efm`; DialogV2 migration deferred** (tracked in
CLAUDE.md → TODO). This document remains the verified root-cause record — every
cause below is anchored to source (file:line), including cross-repo facts in the
Chronicle backend. Two independent re-audits (security+correctness, regression+
modularity) found no correctness or security defects in the change set.

Implemented: #4 sanitizer `.implementation` probe (+v14 tests); #1 descriptor
404 soft-skip; #5 benign lookup-404 log scrub + 409 ConflictError matching +
`dropLastErrorLogEntry` array status (+`test-sync-mapping-conflict.mjs`); #5c
API-CONTRACT.md drift; #3 `api.copyDebug()` escape hatch + `renderSidebar`
re-attach; #2 calendar `calendarStateFromError` auth/absent/unreachable
classification + 'auth' banner + lang key (+`test-sync-calendar-probe-state.mjs`).
The calendar **root cause is environmental** (Chronicle has no calendar for the
campaign, or the token rotated) — the code change makes the state actionable;
confirm via the editor's "Recent sync errors" (404 `calendar_not_configured` =
import one; 401/403 `invalid_token` = token).

Environment from the report: Foundry **v14.364**, Chronicle Sync **v0.1.19**,
Calendaria 1.1.0, Draw Steel system, served from the operator's Chronicle instance.
Branch: `claude/jolly-lamport-755efm`.

Investigation was done by 5 parallel read-only audit agents + direct verification.

---

## Issue 1 — `chronicle-package.json` 404 error popup (HEADLINE, reported)

**Symptom:** `module.mjs:175 Chronicle Sync | descriptor ERROR: chronicle-package.json: missing or unparseable` + sticky red notification "reinstall from a fresh release."

**Root cause — FALSE ALARM (design conflict between the two repos):**
- The Chronicle backend **deliberately strips** `chronicle-package.json` from every
  served module zip: `Chronicle/internal/plugins/foundry_vtt/handler.go:461`
  (`if rel == descriptorFilename { return nil }`), guarded by test
  `zip_rewrite_test.go:84` (`TestZipDirToWriterWithRewrite_ExcludesDescriptor`).
  The descriptor is Chronicle-side-only metadata, read at install time
  (`descriptor.go`, `service.go:~554`), never shipped to the Foundry client.
- But `scripts/module.mjs:152-184` `_runtimeValidateDescriptor()` fetches
  `modules/chronicle-sync/chronicle-package.json` (line 157). A 404 does NOT throw
  in `fetch`, so the try/catch at 162-165 doesn't catch it; `descResp.ok` is false
  so `descriptor` stays `null` (line 160), and `validateDescriptor(null, …)` returns
  the "missing or unparseable" error (`scripts/_descriptor-validator.mjs:36-38`),
  surfaced as a permanent `ui.notifications.error` (module.mjs:177-179).
- So on EVERY correctly-served install this fires a false positive. Added 2026-05-22
  (commit `75447f2`, FM-SEC-CHUNK-7) for a deployment that already strips the file.
- `.github/workflows/release.yml:47` does include the file in the GitHub zip, but
  that path is dormant (tag trigger commented out; releases moved to Chronicle).
  `module.json` never references the descriptor. Confirms server-side-only intent.

**Fix (module only — do NOT change the backend; its exclusion is intentional + tested):**
In `scripts/module.mjs` `_runtimeValidateDescriptor`, soft-skip when the descriptor
isn't served, BEFORE calling `validateDescriptor`:
```js
// after the Promise.all, around line 160-161:
if (!descResp.ok) return;   // Chronicle strips chronicle-package.json from served
                            // zips by design (foundry_vtt/handler.go:461); absence
                            // here is normal, not drift.
```
Defense-in-depth: only surface the error notification when `descriptor !== null`
(i.e. the file WAS served but is malformed — the original "hand-edited release"
signal). Update the JSDoc at 135-151 to note the Chronicle-served case.
Leave `tools/check-package-descriptor.mjs` (CI) and `_descriptor-validator.mjs` as-is.

---

## Issue 4 — HTML sanitization SILENTLY SKIPPED on v14 (NOT reported; HIGH / security)

**Symptom:** `_html-sanitizer.mjs:90 ... TextEditor.cleanHTML not found; storing
Chronicle HTML without ingress sanitization.` on v14.364. Defense-in-depth ingress
sanitization (FM-SEC-CHUNK-3 / M-3) is disabled; only Foundry render-time enrich
remains (so degraded, not an open hole).

**Root cause:** `scripts/_html-sanitizer.mjs` `_resolveCleanHTML()` (lines 43-53)
probes only:
- `foundry.applications.ux.TextEditor.cleanHTML` (line 45) — on v14 the class moved
  to `foundry.applications.ux.TextEditor.**implementation**`, so the namespace object
  has no `cleanHTML` → undefined.
- `globalThis.TextEditor.cleanHTML` (line 49) — deprecated global; accessing it logs
  the compatibility warning AND returns no usable fn on v14 → resolver returns null.
The v14 console message literally names the location: `foundry.applications.ux.TextEditor.implementation`.
`cleanHTML` still EXISTS in v13/v14 — it just lives on `.implementation`.
The unit test (`tools/test-html-sanitizer.mjs`) never models the `.implementation`
shape, so the suite is green while production fails.

**Fix:** make `_resolveCleanHTML` probe most-specific modern path FIRST (also avoids
tripping the deprecated-global warning):
```js
function _resolveCleanHTML() {
  const ns = globalThis.foundry?.applications?.ux?.TextEditor;
  try { const impl = ns?.implementation?.cleanHTML;
        if (typeof impl === 'function') return impl.bind(ns.implementation); } catch {}
  try { const direct = ns?.cleanHTML;
        if (typeof direct === 'function') return direct.bind(ns); } catch {}
  try { const v12 = globalThis.TextEditor?.cleanHTML;
        if (typeof v12 === 'function') return v12.bind(globalThis.TextEditor); } catch {}
  return null;
}
```
This is strictly additive/fail-open — if `.implementation.cleanHTML` is absent it
falls through exactly as today. Existing tests still pass (v13-direct test hits
probe #2; prefers-v13 test hits probe #2 before global).
**Add tests** to `tools/test-html-sanitizer.mjs`: an `installV14CleanHTML` helper
setting `foundry.applications.ux.TextEditor.implementation.cleanHTML`, plus cases
"delegates to v14 .implementation" and "prefers .implementation over global".
Run: `node --test tools/test-html-sanitizer.mjs`.

---

## Issue 5 — `/sync/lookup` 404 noise + 409 conflict bug + doc drift (the "Recent sync errors (11)")

### 5a. The 11 "sync mapping not found" 404s are BENIGN.
Lookup-before-create. `findMapping` (`scripts/sync-manager.mjs:804-812`) GETs
`/sync/lookup`; backend returns 404 `{"error":"Not Found","message":"sync mapping not found"}`
by design when no mapping row exists (`Chronicle/internal/plugins/syncapi/sync_handler.go:134`).
`findMapping` catches and returns null → `ensureMapping` (sync-manager.mjs:642-667)
POSTs `/sync/mappings` to create it. 11 new journals = 11 benign 404s; "11 created"
proves it worked.

**Defect (cosmetic):** `api-client.fetch` logs EVERY non-OK response
(`scripts/api-client.mjs:255` `_logError`) and bumps `restErrorCount` (line 253)
BEFORE the throw, so these benign 404s pollute the dashboard "Recent sync errors"
list (read via `getErrorLog()`, api-client.mjs:655) and inflate the error count.

**Fix:** scrub the benign entry in `findMapping` (and `findMappingByExternal`,
sync-manager.mjs:819-827), mirroring the existing precedent at ensureMapping:657:
```js
async findMapping(chronicleType, chronicleId) {
  try { return await this.api.get(`/sync/lookup?chronicle_type=...&chronicle_id=...`); }
  catch {
    this.api.dropLastErrorLogEntry?.({
      status: 404, path: /\/sync\/lookup/, messageIncludes: 'sync mapping not found',
    });
    return null;
  }
}
```
(A real 500/network error won't match the criteria, so it still surfaces — correct.)

### 5b. 409-vs-400 conflict bug (latent, race-only) — VERIFIED.
The comment at `sync-manager.mjs:670-674` claims the backend returns **400**
"already exists". **It actually returns 409**: `CreateMapping` →
`apperror.NewConflict("sync mapping already exists for this object")`
(`Chronicle/internal/plugins/syncapi/sync_service.go:100`), and
`apperror.NewConflict` → `http.StatusConflict` = 409
(`Chronicle/internal/apperror/errors.go:84-86`). The module's api-client wraps 409
in `ConflictError` (`api-client.mjs:258-262`; class at api-client.mjs:67-77:
`.status=409`, `.name='ConflictError'`, `.message = data.message`).
So `_isMappingConflict` (sync-manager.mjs:679-682) checking `/Chronicle API error 400/`
NEVER matches a real conflict → a concurrent-create 409 would propagate as an error
instead of being absorbed. And the `dropLastErrorLogEntry({status:400,...})` at
ensureMapping:657-661 won't match the logged 409 either.
(Not hit in this session — the GET returned 404 for all 11, so no POST conflict —
but it's a real latent bug.)

**Fix:**
1. `_isMappingConflict` — match the verified 409/ConflictError (keep 400 defensively):
```js
_isMappingConflict(err) {
  const msg = err?.message || '';
  if (!/already exists/i.test(msg)) return false;  // discriminator (mapping-conflict msg)
  return err?.status === 409 || err?.name === 'ConflictError'
      || /Chronicle API error 40[09]/.test(msg);
}
```
   Update the stale comment to say 409.
2. `dropLastErrorLogEntry` (api-client.mjs:631-649) — let `status` accept a number OR
   array, then call ensureMapping's drop with `status: [400, 409]`:
```js
if (match.status != null) {
  const statuses = Array.isArray(match.status) ? match.status : [match.status];
  if (!statuses.includes(top.status)) return false;
}
```
   Update its JSDoc (api-client.mjs:619-630) accordingly.
**Add test:** a small node test for `_isMappingConflict` (409 ConflictError, legacy
400, and a non-conflict 409 like "Entity was modified" → false) and for
`dropLastErrorLogEntry` array-status matching.

### 5c. Doc drift in `API-CONTRACT.md` (authoritative doc is WRONG; superseded API.md is right).
- `API-CONTRACT.md:504-518` documents `GET /sync/lookup` as `?foundry_id=abc123&type=entity`
  returning `{chronicle_id, foundry_id, type}`. **Actual** (sync_handler.go:116-148):
  `?chronicle_type=&chronicle_id=` OR `?external_system=&external_id=`, returns a full
  `SyncMapping` (`Chronicle/internal/plugins/syncapi/model.go:184-197`). Module uses the
  real params (sync-manager.mjs:807,822).
- `API-CONTRACT.md:492-498` documents `POST /sync/mappings` body as
  `{chronicle_id, foundry_id, type}`. **Actual** `CreateSyncMappingInput`
  (model.go:200-207): `{chronicle_type, chronicle_id, external_system, external_id,
  sync_direction, sync_metadata?}`.
**Fix:** correct both blocks in `API-CONTRACT.md` to match the backend. (API.md:644-669
is already correct but is marked superseded — leave it.)
Confirmed ACCURATE (no change): descriptor/serving contract (API-CONTRACT.md:1037-1064),
download/error contract (939-1000), calendar endpoints (568-687).

---

## Issue 3 — "debug button is gone" (reported)

**Root cause:** the buttons were NOT removed. "Copy System Debug to Clipboard"
(`templates/sync-dashboard.hbs:995`, `data-action="copy-debug"`) and "Copy Calendar
Diagnostics" (`:1005`) still live at the bottom of the dashboard **Status tab**
(`hbs:824`), ungated, on both `main` and this branch. The problem is the **dashboard
is unreachable on v14.364**:
- Sidebar status pill is injected once at ready via
  `document.getElementById('sidebar').prepend(...)` (`module.mjs:357-361`). v13+ rebuilt
  the sidebar as ApplicationV2 that re-renders and wipes injected nodes → pill vanishes.
- Scene-controls button (`module.mjs:225-251`) targets the v13 keyed-object shape; may
  not match v14.364's contract.
Version caveat: `module.json` version is pinned `0.1.0` and injected from the git tag at
release; **no tags exist in this clone**, so we can't byte-confirm what `0.1.19` shipped.

**Fix (defensive — UI not runtime-testable here):**
1. **Robust escape hatch (highest value, zero risk — purely additive):** expose on
   `module.api` (module.mjs:387-397) a DOM-independent `copyDebug()` so the operator
   can always grab diagnostics from the console:
   - Add method `async copyDebugReport()` to `SyncDashboard` (sync-dashboard.mjs) that
     calls the existing `_buildDebugExport()` (DOM-independent, line 2038), formats,
     copies via `game.clipboard?.copyPlainText?.()`, and RETURNS the string. Refactor
     `_onCopyDebug` (2006-2028) to delegate to it.
   - `module.api.copyDebug = () => dashboard?.copyDebugReport();`
     `module.api.copyCalendarDiagnostics = () => dashboard?._onCopyCalendarDiagnostics();`
   `dashboard` is created at ready (module.mjs:88) so this works even unrendered.
2. **Sidebar re-attach:** store the indicator in a module-scoped `_statusIndicatorEl`
   (set in `_addStatusIndicator`), and add a guarded re-attach hook:
```js
Hooks.on('renderSidebar', () => {
  try {
    if (!_statusIndicatorEl || _statusIndicatorEl.isConnected) return;
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.contains(_statusIndicatorEl)) sidebar.prepend(_statusIndicatorEl);
  } catch (err) { console.debug('Chronicle Sync | status-indicator re-attach skipped', err); }
});
```
   Additive + guarded → worst case == today (no regression). `renderSidebar` is the
   long-standing hook name.
3. Leave scene-controls as-is (already v13-aware; can't verify v14 shape here) — note
   for runtime verification.

---

## Issue 2 — calendar says "not found" in the UI (reported)

> **UPDATE (user clarification):** the real symptom is in the **dashboard
> Calendar tab** — the *Chronicle* calendar shows fine while the **Foundry
> (local) side shows "Unable to read"** (template `sync-dashboard.hbs:776`).
> Root cause: `_getLocalCalendarDate` (sync-dashboard.mjs) read ONLY the legacy
> `game.Calendaria.getDate()`, which doesn't exist on Calendaria 1.x, so it
> always returned null → "Unable to read", a permanent "Out of Sync" badge, and
> a no-op Push-date button (`_onPushDate` returns early on null). **Fixed** to
> read modern `globalThis.CALENDARIA.api.getCurrentDateTime()` first (legacy
> fallback retained), matching the rest of the module + the diagnostics shape.
> Test: `tools/test-dashboard-local-calendar-date.mjs`. The Chronicle-side
> `#probeChronicleCalendar` auth/absent improvement below still applies to the
> Sync Calendar editor's import banner, but was NOT this symptom's cause.

**Root cause (original Chronicle-side analysis — still valid for the editor banner):**
NO module code passively prints "calendar not found" — all such
strings are action-triggered. The Sync Calendar editor itself resolved the active
calendar fine (diagnostics listed "Calendar of Therin" with full structure counts), so
the editor isn't broken. Most likely Chronicle returns **404 `calendar_not_configured`**
for `GET /calendar` (`Chronicle/internal/plugins/calendar/api_handler.go:336`) — i.e.
**this campaign has no calendar on the Chronicle side** (deleted, campaign-id drift, or
token rotated) — and the module swallows it silently:
- `sync-calendar.mjs:599-609` `#probeChronicleCalendar`: only regexes `/404/`→'absent',
  else 'unreachable'. An auth failure (401/403 `invalid_token`) is mislabeled.
- `sync-dashboard.mjs:580-589` `_buildCalendarData`: any `/calendar` failure →
  `noCampaignCalendar:true` → ambiguous "No calendar configured" panel (hbs:801-803).
`WEATHER_ACTIVE_ZONE_MISSING` ("temperate") is an unrelated advisory — red herring.

**Needs ONE datum from the user to pin sub-cause:** reopen Sync Calendar editor → Copy
diagnostics → "Recent sync errors": `GET /calendar 404 (calendar_not_configured)` =
re-import a calendar; `401/403 invalid_token` = token issue.

**Fix (observability; UI not runtime-testable here):**
1. `#probeChronicleCalendar` — add an `'auth'` state distinct from `'unreachable'`:
```js
} catch (err) {
  const msg = String(err?.message || '');
  if (/\b404\b/.test(msg) || /calendar_not_configured/.test(msg)) this._chronicleCalendarState = 'absent';
  else if (/\b401\b|\b403\b/.test(msg) || /invalid_token|unauthor/i.test(msg)) this._chronicleCalendarState = 'auth';
  else this._chronicleCalendarState = 'unreachable';
}
```
2. Template `templates/sync-calendar.hbs` — the import banner exists TWICE (degraded
   view ~lines 41-75, inline view ~131-163). Add an `{{else if (eq importBanner.state "auth")}}`
   branch to BOTH, localized via a new key.
3. `lang/en.json` — add under `CHRONICLE.SyncCalendar.Import` (block at line 599-612,
   after `Unreachable` at :607):
   `"NotAuthorized": "Chronicle rejected the sync token while checking for a calendar. Re-check your API key / reinstall from a fresh campaign URL."`
   `#buildImportBanner` already forwards `state` verbatim (sync-calendar.mjs:492,502,521),
   so no JS change needed beyond the probe.
4. (Optional) `_buildCalendarData` (sync-dashboard.mjs:580-589): capture the caught
   error status so the dashboard panel can distinguish 404 vs 401/403 instead of always
   "No calendar configured". Requires a matching template tweak at hbs:801-803.

---

## DEFERRED — Foundry V1 → V2 migration (v16-proofing; NOT applied)

Reason for deferral: only hard-breaks at **v16** (the v14.364 log confirms the dialogs
still RENDER — "Foundry VTT | Rendering Dialog" — they only log a deprecation warning);
fixes no reported issue; and dialogs are NOT runtime-testable in this environment, so
migrating 10 sites blind conflicts with the "test as much as possible" priority. Track
as its own focused, runtime-tested PR.

V1 `Dialog` call sites to migrate to `foundry.applications.api.DialogV2`:
- `scripts/sync-dashboard.mjs:1386` — `Dialog.prompt` (tricky: V2 callback signature is
  `(event, button, dialog)`, read form via `button.form`) 
- `scripts/sync-dashboard.mjs:1531, 1559, 1588, 1726, 2308, 2376` — `Dialog.confirm`
- `scripts/map-viewer.mjs:1091, 1188` — `Dialog.confirm`
- `scripts/sync-calendar.mjs:1419` — `Dialog.confirm({defaultYes:false})`
All module Application/Sheet classes ALREADY extend ApplicationV2 (no `extends Application`
/`FormApplication`). Suggested modular approach: a tiny `scripts/_dialogs.mjs`
(`confirmDialog`/`promptDialog`) wrapping DialogV2 with a v12 `Dialog` fallback; migrate
call sites to it; add a static regression test asserting no bare `new Dialog`/`Dialog.confirm`/
`Dialog.prompt` remain. Low priority: `render(true)` → `render({force:true})` at
map-viewer.mjs:875,967 and sync-dashboard.mjs:1190.

Third-party deprecation noise in the same log (touch-vtt, calendaria `new Dialog`/V1
Application) is NOT this module — ignore.

---

## Implementation order (when resuming)
1. #4 sanitizer + tests   2. #1 descriptor soft-skip   3. #5a/5b noise+409 + tests
4. #5c doc drift   5. #3 copyDebug api + sidebar re-attach   6. #2 probe+banner+lang
7. Run ALL tests (`node --test tools/`) + `node -c` syntax check every edited .mjs
8. Re-audit the diff (security + correctness + modularity)   9. Update `.ai.md`,
   CLAUDE.md TODO   10. Commit + push to `claude/jolly-lamport-755efm`.

No backend (Chronicle) code changes required — only `API-CONTRACT.md` doc fixes live in
this module repo; the backend's descriptor-stripping and 404/409 semantics are correct.
