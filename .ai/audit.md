# Feature Parity & Completeness Audit

<!-- ====================================================================== -->
<!-- Category: REFERENCE                                                      -->
<!-- Purpose: Comprehensive audit of feature parity, test coverage, JS        -->
<!--          consistency, export gaps, and documentation completeness.       -->
<!-- Created: 2026-03-05                                                     -->
<!-- Update: When fixing audit items, mark them [x] and note the batch.      -->
<!-- ====================================================================== -->

## 1. Test Coverage

**23 test files, ~530 test functions. ALL service-layer mock-based tests.**
No handler tests, no repository tests, no integration tests exist anywhere.

### Plugins

| Plugin | Test File(s) | Tests | Notes |
|--------|-------------|-------|-------|
| campaigns | service_test, import_test, group_service_test | 90 | Best coverage |
| entities | service_test | 50 | |
| settings | service_test | 36 | |
| addons | service_test | 33 | |
| syncapi | service_test | 31 | |
| auth | service_test | 29 | |
| media | service_test, clamav_test | 28 | |
| audit | service_test | 12 | |
| calendar | day_test, week_test | 10 | Domain-logic only; 23+ endpoints untested |
| timeline | connection_test | 3 | Domain-logic only; 20+ endpoints untested |
| **maps** | — | **0** | 27+ endpoints, HIGH priority |
| **sessions** | — | **0** | 8+ endpoints, HIGH priority |
| **admin** | — | **0** | 12+ endpoints, MEDIUM priority |
| **smtp** | — | **0** | 3 endpoints, LOW priority |

### Widgets

| Widget | Tests | Notes |
|--------|-------|-------|
| notes | 32 | |
| tags | 30 | |
| relations | 25 | |
| posts | 13 | |
| attributes | 0 | Frontend-only |
| editor | 0 | Frontend-only |
| mentions | 0 | Frontend-only |
| title | 0 | Pure Templ |

### Core/Infrastructure (zero tests)

- [ ] `internal/apperror/` — error types and `validate.go` helpers
- [ ] `internal/config/` — configuration loading
- [ ] `internal/app/` — bootstrap, route wiring
- [ ] `internal/websocket/` — WebSocket handler
- [ ] `internal/sanitize/` — CDR pipeline, MIME validation
- [ ] `internal/middleware/` — only IDOR has 3 tests; auth, CSRF, role, addon, security middleware all untested

### CI gaps

- [ ] CI runs `go test ./... -v -short` but no test implements `testing.Short()` skip — the flag has no effect
- [ ] `make test-int` target exists but zero `TestIntegration*` functions in codebase
- [ ] No integration test stage in CI pipeline

---

## 2. JS Widget Consistency

### Chronicle.apiFetch() Migration

**Done (8 widgets):** dashboard_editor, sidebar_config, sidebar_nav_editor,
entity_type_config, calendar_widget, map_widget, shop_inventory, timeline_widget

**Not migrated:**

| Widget | Raw fetch() calls | Priority |
|--------|------------------|----------|
| `notes.js` | 10 | HIGH |
| `attributes.js` | 5 | HIGH |
| `relations.js` | 6 | HIGH |
| `tag_picker.js` | 6 | MEDIUM |
| `permissions.js` | 2 | MEDIUM |
| `editor.js` | 2 | MEDIUM |
| `image_upload.js` | 1 | LOW |
| `entity_posts.js` | 1 (local wrapper) | LOW |
| `editor_autolink.js` | 1 | LOW |
| `editor_mention.js` | 1 | LOW |
| `entity_tooltip.js` | 1 | LOW |
| `entity_type_editor.js` | 1 | LOW |
| `groups.js` | 1 (local wrapper) | LOW |
| `relation_graph.js` | 1 | LOW |
| `template_editor.js` | 1 | LOW |
| `timeline_viz.js` | 1 | LOW |
| `search_modal.js` | 1 | LOW |

### Error Handling (User Feedback)

**Only 2 widgets show toast on error:** entity_posts.js, calendar_widget.js

**Console-only errors (no user feedback):**
- [ ] `notes.js` — all catch blocks log to console only
- [ ] `tag_picker.js` — Promise.all().catch() console-only
- [ ] `timeline_viz.js` — fetch() without .catch()
- [ ] `entity_tooltip.js` — fetch() without .catch()
- [ ] `editor_autolink.js` — catch logs only
- [ ] `editor_mention.js` — catch logs only
- [ ] `template_editor.js` — catch logs only
- [ ] `relation_graph.js` — catch logs only
- [ ] `search_modal.js` — catch logs only

**Widgets with proper error feedback:** entity_posts, calendar_widget,
image_upload, relations, attributes, permissions, groups, shop_inventory

### Utility Duplication

- [ ] `groups.js` defines local `escHtml()` + `escAttr()` — should use `Chronicle.escapeHtml()` / `Chronicle.escapeAttr()`
- [ ] `relation_graph.js` defines local `escHtml()` — should use `Chronicle.escapeHtml()`
- [ ] `groups.js` defines local `apiFetch()` wrapper — should use `Chronicle.apiFetch()`

---

## 3. Feature Parity

### Visibility/Permission Controls

| Content Type | Controls | Status |
|-------------|----------|--------|
| Entities | Everyone / DM Only / Custom (user/role/group grants) | Best |
| Calendar events | `dm_only` flag | OK |
| Timeline events | `visibility` field | OK |
| Map markers | DM-only flag | OK |
| Tags | `dm_only` flag | OK |
| Posts | `dm_only` toggle | OK |
| **Relations** | **None** | **Gap** |
| Sessions | Campaign membership only | By design |
| Notes | Per-user ownership + locking | By design |

### Search

| Content Type | Ctrl+K | In-Context | Status |
|-------------|--------|-----------|--------|
| Entities | Yes | Full-text | Best |
| Calendar events | Yes | — | Gap: no filter in calendar views |
| Timelines | Yes | — | Gap: no search within timeline |
| Maps | Yes | Client-side marker | OK |
| Sessions | Yes | — | Gap: no filter on sessions list |
| **Notes** | — | — | **No search at all** |
| **Posts** | — | — | **No search at all** |

### Other Parity

- [x] Empty states — all plugins audited (batch 31)
- [x] Breadcrumbs — maps, timelines, sessions, calendar, entities all have them
- [x] HTMX fragment detection — all plugins use `middleware.IsHTMX()` or `HX-Request`
- [x] CSRF on state-changing routes — all plugins
- [x] RequireAddon gating — calendar, maps, sessions, timeline all gated
- [x] Error types — all 249 echo.NewHTTPError replaced with apperror

---

## 4. Export/Import Gaps

Campaign export covers entities (types, entities, tags, relations), calendar (full),
timelines (full including connections), sessions (partial), maps (full), addons, media manifest.

### Data NOT exported

| Missing Data | Table(s) | Impact | Priority |
|-------------|----------|--------|----------|
| Entity permissions | `entity_permissions` | Custom visibility grants lost | **HIGH** |
| Campaign groups | `campaign_groups`, `campaign_group_members` | Group-based permissions lost | **HIGH** |
| Entity posts | `entity_posts` | Sub-notes completely lost | **HIGH** |
| Session attendees | `session_attendees` | RSVP tracking lost | **LOW** |
| Media file bytes | Disk files | JSON-only; no file backup | **MEDIUM** |

### Data correctly exported (verified)

- Campaign metadata (name, desc, public, settings, sidebar, dashboard) ✓
- Entity types (all fields including layout, colors, dashboard) ✓
- Timeline event connections (migration 000047) ✓
- Calendar event categories ✓
- Map layers, drawings, tokens, fog ✓

### Intentionally excluded

- Player notes (per-user; NoteService lacks `ListSharedByCampaign`)
- Foundry sync metadata (external system coupling)

---

## 5. Documentation Gaps

### Missing .ai.md files

**Go widgets:**
- [ ] `internal/widgets/posts/` — no `.ai.md`

**JS widgets (16 files missing):**
- [ ] `calendar_widget.js`
- [ ] `map_widget.js`
- [ ] `relation_graph.js`
- [ ] `entity_type_config.js`
- [ ] `entity_type_editor.js`
- [ ] `groups.js`
- [ ] `permissions.js`
- [ ] `shop_inventory.js`
- [ ] `sidebar_config.js`
- [ ] `timeline_widget.js`
- [ ] `entity_posts.js`
- [ ] `recent_entities.js`
- [ ] `notifications.js`
- [ ] `shortcuts_help.js`

**Editor sub-extensions (consolidate into editor.ai.md):**
- [ ] `editor_autolink.js`
- [ ] `editor_secret.js`

---

## 6. Module System

All 3 modules (dnd5e, drawsteel, pathfinder2e) are scaffold-only:

| Module | manifest.json | handler.go | data/ | Routes | Tooltip API | Pages |
|--------|:---:|:---:|:---:|:---:|:---:|:---:|
| dnd5e | ✓ | stub | spells.json | — | — | — |
| drawsteel | ✓ | stub | empty | — | — | — |
| pathfinder2e | ✓ | stub | empty | — | — | — |

This is Phase M planned work, not a parity issue.

---

## Priority Summary

### Must Fix (data correctness / user-facing bugs)

1. Export: entity_permissions, campaign_groups, entity_posts adapters
2. Relations: add visibility controls (at minimum `dm_only` flag for parity)
3. JS error handling: notes.js, tag_picker.js (most-used widgets with silent failures)

### Should Fix (consistency / quality)

4. Migrate notes.js, attributes.js, relations.js to Chronicle.apiFetch()
5. Remove utility duplication in groups.js and relation_graph.js
6. Add service tests for maps and sessions plugins
7. Add service tests for calendar and timeline (beyond domain-logic tests)

### Nice to Have (polish / documentation)

8. Posts widget .ai.md
9. Add toast error feedback to remaining widgets
10. Add .ai.md to 16 undocumented JS widgets
11. Fix CI `-short` flag (either add Short() checks or remove flag)
12. Create actual integration test infrastructure
