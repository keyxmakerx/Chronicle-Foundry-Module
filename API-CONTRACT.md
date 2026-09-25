# Chronicle API Contract

Every Chronicle REST endpoint and WebSocket message the Foundry module depends on.

## Authentication

All REST requests include a Bearer token:
```
Authorization: Bearer <api-key>
```

WebSocket connections authenticate via query parameter at connection time:
```
wss://chronicle.example.com/ws?token=<api-key>
```

API keys are scoped to a single campaign. The key determines:
- Which campaign's data is accessible
- Permission level: `read` (GET), `write` (POST/PUT/DELETE), `sync` (sync endpoints)
- A `sync`-level key covers read + write + sync
- Rate limit: 60 requests/minute (default)

## Base URL Pattern

All REST endpoints are prefixed with:
```
{chronicleUrl}/api/v1/campaigns/{campaignId}
```

The module's `api-client.mjs` constructs this from settings:
```javascript
const baseUrl = getSetting('apiUrl');     // e.g., "https://chronicle.example.com"
const campaignId = getSetting('campaignId'); // UUID
// Requests go to: baseUrl + "/api/v1/campaigns/" + campaignId + path
```

## Error Response Format

All error responses follow:
```json
{
  "error": "Human-readable error message"
}
```

HTTP status codes:
- `400` — Bad request (invalid input)
- `401` — Unauthorized (missing/invalid API key)
- `403` — Forbidden (insufficient permissions)
- `404` — Not found
- `409` — Conflict (optimistic concurrency via `expected_updated_at`)
- `429` — Rate limited
- `500` — Server error

---

### Structured errors on the syncapi group

Some syncapi endpoints invert the field roles above: `error` is a
machine-readable code, `message` is the human sentence.

```
HTTP 503
{"error":"calendar_rebuilding","message":"Chronicle's calendar is being rebuilt and is temporarily unavailable. Calendar sync is paused; maps, actors, items and notes are unaffected."}
```

- `503` — a subsystem is deliberately unavailable, distinct from `500`
  (fault) and `404` (route absent on this build). Never read it as an empty
  resource.
- `scripts/api-client.mjs` attaches `err.status`, `err.code`,
  `err.serverMessage` to the thrown error; callers key on the code. Message
  format stays stable (`Chronicle API error <status>: <body>`) as a regex
  fallback for transports that lose the status.

**Re-verify by: when calendar V5 ships.**

## REST Endpoints

### Systems

#### GET /systems
Lists all available game systems for this campaign.

**Used by:** `sync-manager.mjs` → `_detectSystem()`

**Response:**
```json
{
  "data": [
    { "id": "dnd5e", "name": "D&D 5th Edition", "status": "available",
      "enabled": true, "has_character_fields": true, "has_item_fields": true,
      "foundry_system_id": "dnd5e" }
  ]
}
```

#### GET /systems/:systemId/character-fields
Returns character preset field definitions with Foundry annotations.

**Used by:** `adapters/generic-adapter.mjs` → `createGenericAdapter()`

**Response:**
```json
{
  "system_id": "drawsteel", "preset_slug": "drawsteel-character",
  "preset_name": "Draw Steel Hero", "foundry_system_id": "draw-steel",
  "foundry_actor_type": "hero",
  "fields": [
    { "key": "might", "label": "Might", "type": "number",
      "foundry_path": "system.characteristics.might.value", "foundry_writable": true },
    { "key": "stamina_max", "label": "Stamina (Max)", "type": "number",
      "foundry_path": "system.stamina.max", "foundry_writable": false }
  ]
}
```

**Key fields:**
- `foundry_actor_type` — Actor type to create/filter (e.g., "character", "hero")
- `foundry_path` — Dot-notation path on `actor.system` (e.g., "system.abilities.str.value")
- `foundry_writable` — Whether this field can be written back to Foundry (false = read-only from Foundry)

##### Multi-Preset Systems (e.g., Draw Steel Creatures)

A system can expose multiple entity presets, each with its own
`foundry_actor_type` and field mappings. Draw Steel: **hero** preset
(`drawsteel-character`, type `"hero"`), **creature** preset
(`drawsteel-creature`, type `"npc"`).

**Expected creature preset response:**
```json
{
  "system_id": "drawsteel", "preset_slug": "drawsteel-creature",
  "preset_name": "Draw Steel Creature", "foundry_system_id": "draw-steel",
  "foundry_actor_type": "npc",
  "fields": [
    { "key": "stamina_max", "label": "Stamina (Max)", "type": "number", "foundry_path": "system.stamina.max", "foundry_writable": false },
    { "key": "stamina_value", "label": "Stamina (Current)", "type": "number", "foundry_path": "system.stamina.value", "foundry_writable": true },
    { "key": "might", "label": "Might", "type": "number", "foundry_path": "system.characteristics.might.value", "foundry_writable": true },
    { "key": "agility", "label": "Agility", "type": "number", "foundry_path": "system.characteristics.agility.value", "foundry_writable": true },
    { "key": "reason", "label": "Reason", "type": "number", "foundry_path": "system.characteristics.reason.value", "foundry_writable": true },
    { "key": "intuition", "label": "Intuition", "type": "number", "foundry_path": "system.characteristics.intuition.value", "foundry_writable": true },
    { "key": "presence", "label": "Presence", "type": "number", "foundry_path": "system.characteristics.presence.value", "foundry_writable": true },
    { "key": "speed", "label": "Speed", "type": "number", "foundry_path": "system.speed.value", "foundry_writable": true },
    { "key": "stability", "label": "Stability", "type": "number", "foundry_path": "system.stability.value", "foundry_writable": true },
    { "key": "level", "label": "Level", "type": "number", "foundry_path": "system.level", "foundry_writable": false },
    { "key": "ev", "label": "EV", "type": "number", "foundry_path": "system.ev", "foundry_writable": false }
  ]
}
```

> **Current limitation:** the generic adapter (`generic-adapter.mjs`) and
> `actor-sync.mjs` support only **one preset per system** — with primary
> preset `drawsteel-character`, entities of slug `drawsteel-creature` won't
> sync. Needs the adapter to load multiple presets and route by `type_slug`.

#### GET /systems/:systemId/item-fields
Returns item preset field definitions. Same shape as character-fields.

**Used by:** `item-sync.mjs`

---

### Entities

#### GET /entities
Lists entities in the campaign. Supports pagination and filtering.

**Used by:** `journal-sync.mjs` → initial sync

**Query params:** `?page=1&per_page=50&type_id=X&updated_since=ISO`

**Response:**
```json
{
  "data": [
    {
      "id": "uuid", "name": "Entity Name", "content": "<p>HTML content</p>",
      "summary": "Short text", "entity_type_id": 1,
      "fields_data": { "hp_current": 45, "str": 18 },
      "tags": ["npc", "villain"], "visibility": "public",
      "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-15T12:00:00Z"
    }
  ],
  "pagination": { "page": 1, "per_page": 50, "total": 120 }
}
```

#### POST /entities
Creates a new entity.

**Used by:** `journal-sync.mjs` → push new journal to Chronicle

**Request:**
```json
{ "name": "Entity Name", "content": "<p>HTML content</p>", "entity_type_id": 1, "visibility": "public" }
```

**Response:** The created entity object (same shape as GET).

#### GET /entities/:entityId
Returns a single entity with full content.

#### PUT /entities/:entityId
Updates an entity. **PARTIAL update** — see the contract below.

##### The partial-update contract

Every JSON update endpoint in Chronicle reads a request body three ways:

| what the body does with a key | what happens to the stored value |
|---|---|
| **absent** | **preserved** |
| present with a **value** | replaced |
| present and **explicitly `null`** | cleared (nullable columns only) |

The distinction is real on the server: request structs bind `patch.Field[T]`,
which records presence during JSON decoding, so absent and `null` differ.
Non-nullable columns have no cleared state, so an explicit `null` there
preserves rather than writing a zero.

Before this contract, value-typed fields wrote their zero when absent. Two
consequences hit this module's own traffic: `actor-sync.mjs`'s `{name}`-only
rename bound `is_private = false` and **published a hidden character entity
to every player** in the campaign, and **`parent_id` was not on the request
struct at all**, so every update detached the entity from the hierarchy.
Both are fixed on the server. Send only the fields you mean to change.

Send only the fields you mean to change.

**Request:** any subset of the POST shape, plus `parent_id`:

```json
{ "name": "Renamed Character" }
```

```json
{ "parent_id": null }
```
&nbsp;&nbsp;↑ explicitly unparents. Omitting `parent_id` leaves the parent alone.

> **Version skew.** A pre-partial-update Chronicle does whole-replace instead.
> `ChronicleMarkerConfigDialog.#onSave` still spreads the stored marker under
> edited fields for this reason: harmless on a merging server, load-bearing
> on an older one.

#### DELETE /entities/:entityId
Deletes an entity.

#### PUT /entities/:entityId/fields
Updates only the `fields_data` on an entity.

**Used by:** `actor-sync.mjs` → push character stats to Chronicle

**Request:**
```json
{ "fields_data": { "hp_current": 45, "str": 18, "level": 5 } }
```

#### GET /entities/:entityId/permissions
Returns entity permission/visibility settings.

#### PUT /entities/:entityId/permissions
Updates entity permissions.

**Request:**
```json
{ "visibility": "public" }
```

#### POST /entities/:entityId/reveal
Toggles entity reveal state (NPC reveal to players). Body is exactly
`{ "is_private": <bool> }` (a `*bool`); a matching value is a no-op. Use this
route, not a bare `PUT /entities/:id`, to flip visibility — it works against
every Chronicle version this module supports.

**Request:**
```json
{ "is_private": true }
```

**Used by:** `actor-sync.mjs`; `sync-dashboard.mjs` (single + bulk visibility toggles)

---

### Entity Types

#### GET /entity-types
Lists all entity types in the campaign.

**Response:**
```json
{
  "data": [
    { "id": 1, "name": "Character", "slug": "dnd5e-character", "icon": "fa-user", "color": "#7C3AED" }
  ]
}
```

#### GET /entity-types/:typeId
Returns a single entity type with field definitions.

#### POST /entity-types
Create a new entity type in the campaign.

**Used by:** `import-wizard.mjs` → "Create new type" in Step 3

**Request** (all 4 fields required):
```json
{ "name": "Quest", "name_plural": "Quests", "icon": "fa-solid fa-scroll", "color": "#fbbf24" }
```

**Response:** The created entity type object (same shape as GET /entity-types items).

---

### Addons

#### GET /addons
Lists addons with their enabled/disabled state for the campaign.

**Used by:** `import-wizard.mjs` → Step 1 addon discovery

**Response:**
```json
{
  "data": [
    { "slug": "calendar", "name": "Calendar", "category": "worldbuilding", "enabled": true },
    { "slug": "maps", "name": "Maps", "category": "worldbuilding", "enabled": true },
    { "slug": "bestiary", "name": "Bestiary", "category": "worldbuilding", "enabled": false }
  ]
}
```

---

### Tags

#### GET /tags
Lists all tags in the campaign.

**Used by:** `import-wizard.mjs` → Step 4 tag detection

**Response:**
```json
{
  "data": [
    { "id": 1, "name": "Important", "color": "#ef4444", "dm_only": false }
  ]
}
```

#### POST /tags
Create a new tag.

**Used by:** `import-wizard.mjs` → Step 8 tag creation during import

**Request:**
```json
{ "name": "NPCs", "color": "#60a5fa", "dm_only": false }
```

**Response:** The created tag object.

#### POST /entities/bulk-tags
Bulk assign or remove tags on multiple entities. Maximum 200 entities per
request — the Foundry module auto-batches larger sets.

**Used by:** `import-wizard.mjs` → bulk tag assignment after import

**Request:**
```json
{ "entity_ids": ["uuid1", "uuid2"], "tag_ids": [1, 2], "action": "add" }
```

`action` must be `"add"`, `"remove"`, or `"set"` (replace all tags).

**Response:**
```json
{
  "status": "ok", "processed": 2,
  "results": [ { "entity_id": "uuid1", "status": "ok" }, { "entity_id": "uuid2", "status": "ok" } ]
}
```

---

### Bulk Operations

#### POST /entities/bulk-update
Bulk update entity type for multiple entities.

**Used by:** `sync-dashboard.mjs` → bulk Change Type action

**Response:** `{ "status": "ok", "updated": 5 }`

**Request:**
```json
{ "entity_ids": ["uuid1", "uuid2"], "entity_type_id": 5 }
```

---

### Relations

#### GET /relations/types
Lists predefined relation types for the campaign. Types are immutable
forward/reverse string pairs (17 built-in pairs like "parent of" / "child of").

**Used by:** `import-wizard.mjs` → future relation creation support

**Response:**
```json
{
  "data": [
    { "forward": "parent of", "reverse": "child of" },
    { "forward": "has item", "reverse": "owned by" },
    { "forward": "member of", "reverse": "has member" }
  ]
}
```

#### POST /entities/:entityId/relations
Create a relation. Identifies the type by forward label string, not a
numeric ID. Write body is **snake_case** (`target_entity_id` /
`relation_type` / `reverse_relation_type`), `target_entity_id` **required**
(empty → 400). Read/WS payload is camelCase — deliberately asymmetric.
`metadata` is a raw object (`json.RawMessage`), not a JSON-encoded string.

**Request:**
```json
{ "target_entity_id": "uuid", "relation_type": "parent of", "reverse_relation_type": "child of", "metadata": {} }
```

`item-sync.mjs` skips the create when the item has no linked Chronicle target
entity (a custom Foundry item has nothing to relate to).

#### GET /entities/:entityId/relations
List all relations on an entity.

**Used by:** `item-sync.mjs` → pull inventory relations for actors

#### DELETE /relations/:relationId
Delete a relation (and its reverse). `relationId` is the numeric relation id.
The route is flat — `DELETE /relations/:relationId` (`syncapi/routes.go`),
never nested under `/entities`.

**Used by:** `item-sync.mjs` → remove item from actor inventory

#### PUT /relations/:relationId
Update relation metadata (e.g., item quantity, equipped state). Body is
`{ "metadata": { ... } }` only (`json.RawMessage`); relation type and target
are immutable via this route. Flat route, no `/metadata` suffix
(`syncapi/routes.go`).

**Used by:** `item-sync.mjs` → update inventory item metadata

---

### Members

#### GET /members
Lists campaign members with their display names and roles.

**Used by:** `sync-manager.mjs` → auto-match Chronicle users to Foundry users by display name

**Response:**
```json
{
  "data": [
    { "id": "uuid", "display_name": "Alice", "role": "player" }
  ]
}
```

---

### Sync Mappings

#### GET /sync/mappings
Lists all sync mappings for the campaign.

**Used by:** `sync-manager.mjs` → initial sync setup

**Response:**
```json
{
  "data": [
    { "id": "uuid", "chronicle_id": "entity-uuid", "foundry_id": "foundry-doc-id",
      "type": "entity", "last_synced": "2026-01-15T12:00:00Z" }
  ]
}
```

#### POST /sync/mappings
Creates a new sync mapping. Body shape is `CreateSyncMappingInput`.

**Request:**
```json
{
  "chronicle_type": "entity", "chronicle_id": "entity-uuid",
  "external_system": "foundry", "external_id": "foundry-doc-id",
  "sync_direction": "both", "sync_metadata": {}
}
```

- `chronicle_type` — one of `entity, map, calendar_event, marker, drawing, token`
- `external_system` — `foundry`
- `sync_direction` — `both | push | pull` (defaults to `both`)
- `sync_metadata` — optional object

Returns **409 Conflict** (`message: "sync mapping already exists for this object"`)
if a mapping already exists for the object.

#### DELETE /sync/mappings/:mappingId
Removes a sync mapping.

#### GET /sync/lookup
Looks up a mapping by **Chronicle identity** OR **external (Foundry) identity**.

**Used by:** all sync modules (`sync-manager.mjs` → `findMapping` /
`findMappingByExternal`) to find existing mappings before create.

**Query:** `?chronicle_type=entity&chronicle_id=<uuid>`
&nbsp;— or —&nbsp; `?external_system=foundry&external_id=<foundry-doc-id>`

**Response:** the full `SyncMapping`
```json
{
  "id": "mapping-uuid", "campaign_id": "campaign-uuid",
  "chronicle_type": "entity", "chronicle_id": "entity-uuid",
  "external_system": "foundry", "external_id": "foundry-doc-id",
  "sync_version": 1, "last_synced_at": "2026-01-01T00:00:00Z",
  "sync_direction": "both", "sync_metadata": {},
  "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"
}
```

Returns **404** (`{"error":"Not Found","message":"sync mapping not found"}`) when no
mapping exists. This is the normal "not yet mapped" signal callers use to decide to
create one — **not** an error (the client scrubs it from the diagnostics error log).

#### GET /sync/pull
Pulls all changes since a timestamp.

**Used by:** `sync-manager.mjs` → initial sync

**Query:** `?since=2026-01-01T00:00:00Z`

**Response:**
```json
{ "entities": [ ], "deleted_entities": [ "uuid1", "uuid2" ], "drawings": [ ], "tokens": [ ], "calendar_events": [ ] }
```

#### POST /sync
Generic sync endpoint for batch operations.

---

### Maps

#### GET /maps
Lists all maps in the campaign.

> **Note:** the module renders a Chronicle map as a JournalEntry image page
> with an SVG overlay (`MapViewerSheet`), not a Foundry Scene. Drawing, token,
> fog and layer endpoints below are read-only for that overlay; only markers
> are editable and pushed back.

#### GET /maps/:mapId/drawings
All coordinates are percentage-based (0–100), not pixels. `drawing_type` is
one of `freehand`, `rectangle`, `ellipse`, `polygon`, `text`.

```json
{
  "id": "drw_001", "map_id": "map_001", "layer_id": null, "drawing_type": "rectangle", "points": [],
  "stroke_color": "#ff0000", "stroke_width": 2, "fill_color": "#00ff00", "fill_alpha": 0.5,
  "text_content": null, "font_size": null, "rotation": 0, "visibility": "everyone", "visibility_rules": null,
  "created_by": "user_001", "foundry_id": null
}
```

#### GET /maps/:mapId/tokens
Coordinates are percentage-based (0–100); `width`/`height` are grid units.

```json
{
  "id": "tok_001", "map_id": "map_001", "layer_id": null, "entity_id": "ent_goblin01",
  "name": "Goblin Archer", "image_path": "/uploads/tokens/goblin.png",
  "x": 45.2, "y": 67.8, "width": 5.0, "height": 5.0, "rotation": 0, "scale": 1.0,
  "is_hidden": false, "is_locked": false,
  "bar1_value": 15, "bar1_max": 15, "bar2_value": null, "bar2_max": null,
  "aura_radius": null, "aura_color": null,
  "light_radius": null, "light_dim_radius": null, "light_color": null,
  "vision_enabled": false, "vision_range": null, "elevation": 0, "sort_order": 0,
  "status_effects": null, "flags": null, "foundry_id": null
}
```

#### GET /maps/:mapId/fog
Fog regions use percentage coordinates; `points` is a JSON string of
`[{x, y}, ...]`. `is_explored: true` renders semi-transparent, `false` fully
opaque.

```json
{ "id": "fog_001", "map_id": "map_001",
  "points": "[{\"x\":10,\"y\":10},{\"x\":30,\"y\":10},{\"x\":30,\"y\":30}]",
  "is_explored": false }
```

#### GET /maps/:mapId/layers
`layer_type` is one of `background`, `drawing`, `token`, `gm`, `fog`.

```json
{ "id": "lyr_001", "map_id": "map_001", "name": "Tokens",
  "layer_type": "token", "sort_order": 1,
  "is_visible": true, "opacity": 1.0, "is_locked": false }
```

#### GET /maps/:mapId/markers
Lists map markers (pins/notes on the map).

#### POST /maps/:mapId/markers
Creates a map marker.

#### PUT /maps/:mapId/markers/:markerId
Updates a map marker. **PARTIAL update** — absent preserves, an explicit
`null` clears, a present value replaces (see "The partial-update contract"
under `PUT /entities/:entityId`).

`foundry_id` is this module's pairing key. It stays clearable HERE — send
`{"foundry_id": null}` to unpair — while Chronicle's web marker form, which
never sends the key, can no longer NULL it by omission.

#### DELETE /maps/:mapId/markers/:markerId
Deletes a map marker.

---

### Calendar

> ### CALENDAR BLACKOUT — every route in this section answers 503
>
> Chronicle deleted its calendar plugin for a ground-up rebuild (V5). All 34
> routes stay REGISTERED and answer `503
> {"error":"calendar_rebuilding","message":"…"}` — 503, not 404, so the module
> doesn't fall back to old-build compatibility and hide the reason from the
> GM. Maps, actors, items, notes, media and entities are unaffected. See
> CLAUDE.md → "Calendar blackout".
>
> **The specs below are the pre-blackout contract, kept as the V5 starting
> point, not today's behavior. Re-verify by: when calendar V5 ships.**

All calendar endpoints require the calendar addon to be enabled.

#### GET /calendar
Returns the full calendar with all sub-resources eager-loaded: months, weekdays,
moons, seasons, eras, event_categories, cycles, festivals.

**Response:**
```json
{
  "id": "uuid", "campaign_id": "uuid", "mode": "fantasy",
  "name": "Calendar of Harptos", "description": "...", "epoch_name": "DR",
  "current_year": 1492, "current_month": 1, "current_day": 15,
  "current_hour": 14, "current_minute": 30,
  "hours_per_day": 24, "minutes_per_hour": 60, "seconds_per_minute": 60,
  "leap_year_every": 4, "leap_year_offset": 0,
  "months": [{ "id": 1, "name": "Hammer", "days": 30, "sort_order": 0, "is_intercalary": false, "leap_year_days": 0 }],
  "weekdays": [{ "id": 1, "name": "First Day", "sort_order": 0, "is_rest_day": false }],
  "moons": [{ "id": 1, "name": "Selûne", "cycle_days": 30.0, "phase_offset": 0.0, "color": "#c0c0ff" }],
  "seasons": [{ "id": 1, "name": "Winter", "start_month": 11, "start_day": 1, "end_month": 2, "end_day": 28, "color": "#a0c4ff" }],
  "eras": [{ "id": 1, "name": "Dale Reckoning", "start_year": 1, "end_year": null, "color": "#6366f1", "sort_order": 0 }],
  "event_categories": [{ "id": 1, "slug": "holiday", "name": "Holiday", "icon": "⭐", "color": "#f59e0b", "sort_order": 0 }],
  "cycles": [{ "id": 1, "name": "Zodiac", "cycle_length": 12, "type": "yearly", "sort_order": 0, "entries": [] }],
  "festivals": [{ "id": 1, "name": "Midsummer", "month": 7, "day": null, "after_month": 7, "sort_order": 0 }]
}
```

#### GET /calendar/date
Returns current date/time with computed state: current season, moon phases, era, weather.

**Used by:** `calendar-sync.mjs` → poll current state; `_realtime-date-guard.mjs` →
fetch-before-push real-time check (see below)

**Response:**
```json
{
  "mode": "fantasy", "year": 1492, "month": 1, "day": 15, "hour": 14, "minute": 30,
  "tracks_real_time": false,
  "current_season": { "id": 1, "name": "Winter", "color": "#a0c4ff" },
  "current_moon_phases": [
    { "moon_id": 1, "moon_name": "Selûne", "phase_name": "Full Moon", "phase_position": 0.5, "phase_icon": "moon" }
  ],
  "current_era": { "id": 1, "name": "Dale Reckoning", "start_year": 1, "color": "#6366f1" },
  "current_weather": {
    "preset_id": "rain", "preset_label": "Rain", "icon": "cloud-rain", "color": "#6b9bd2",
    "temperature_celsius": 12.0,
    "wind": { "speed_kph": 25.0, "speed_tier": "moderate", "direction": "NW", "direction_degrees": 315 },
    "precipitation": { "type": "rain", "intensity": 0.6 },
    "zone_id": "temperate", "zone_name": "Temperate", "description": "Steady rainfall"
  }
}
```

**Key:** `current_season`, `current_moon_phases`, `current_era`, and `current_weather` are
computed server-side. They may be `null`/absent if no data is configured.

**`tracks_real_time`**: the composed `UsesRealTime()` predicate (`mode == reallife AND` the real-time flag).
Read defensively — `payload?.tracks_real_time === true` — never assume it's
present (older deployments and `GET /calendar` never carry it). When `true`,
dates are **read-only**: the module skips `PUT /calendar/date` pushes
(fetch-before-push check via `scripts/_realtime-date-guard.mjs`, re-probed
each push so a mid-session enable self-heals) and shows one GM notice per
session. Pull and event sync are unaffected.

#### PUT /calendar/date
Sets current calendar date/time to an absolute value. Rejected with **422**
(Chronicle's W3 guard) when the target calendar's `tracks_real_time` is true —
the module treats a 422 here identically to a pre-emptive `tracks_real_time`
read (sets the same session guard, shows the same one-time notice), never as
a retryable sync error.

**Request:**
```json
{ "year": 1492, "month": 3, "day": 1, "hour": 8, "minute": 0 }
```

#### POST /calendar/date/confirm
**Optional** (newer Chronicle deployments only). Confirms Foundry *applied* a
date pulled from Chronicle to the active local calendar module (Calendaria or
SimpleCalendar), not merely fetched it — drives the sync chip's "SAW" vs.
"APPLIED" distinction (SAW = the `GET /calendar/date` beacon).

**Used by:** `calendar-sync.mjs` → `_confirmAppliedDate` via
`scripts/_applied-date-confirm.mjs`, from the poll path (`onInitialSync`) and
the WebSocket path (`_onChronicaleDateAdvanced`, `calendar.date.advanced`) —
only after the local setter (`_setLocalDate`) runs without throwing. Never
sent on a bare fetch or an apply failure.

**Request:**
```json
{ "year": 1492, "month": 3, "day": 1 }
```

**Response:** `204 No Content`

**Graceful degradation:** a Chronicle predating this endpoint returns 404 or
405; the module tolerates both silently (one `console.debug`, no retries).
Any other failure is debug-logged and swallowed — a missed confirmation only
leaves the applied-beacon stale, never blocks sync. See
`scripts/_applied-date-confirm.mjs::isConfirmNotSupported`.

#### POST /calendar/advance
Advances the calendar by N days (1-3650).

**Request:** `{ "days": 7 }`

#### POST /calendar/advance-time
Advances time by hours/minutes (rolls over into days).

**Request:** `{ "hours": 2, "minutes": 30 }`

---

#### Calendar Sub-Resources

Each resource has a `GET` (returns all definitions) and a `PUT` (bulk-replaces all definitions):

| Resource | Routes | Notes |
|---|---|---|
| Seasons | `GET`/`PUT /calendar/seasons` | |
| Moons | `GET`/`PUT /calendar/moons` | |
| Eras | `GET`/`PUT /calendar/eras` | |
| Event categories | `GET`/`PUT /calendar/event-categories` | |
| Cycles | `GET`/`PUT /calendar/cycles` | zodiac/elemental cycles, `PUT` includes entries |
| Festivals | `GET`/`PUT /calendar/festivals` | fixed calendar entries |

---

#### Calendar Events

#### GET /calendar/events
Lists events for a month. Query: `?year=1492&month=3` or `?entity_id=uuid`.

#### POST /calendar/events
Creates a calendar event.

**Request:**
```json
{
  "name": "Festival of the Moon",
  "description": "ProseMirror JSON or plain text",
  "description_html": "<p>Rendered HTML</p>",
  "entity_id": "optional-entity-uuid",
  "year": 1492, "month": 11, "day": 30, "start_hour": 8, "start_minute": 0,
  "end_year": 1492, "end_month": 12, "end_day": 1, "end_hour": 23, "end_minute": 59,
  "is_recurring": true, "recurrence_type": "yearly", "recurrence_interval": 1,
  "recurrence_end_year": null, "recurrence_end_month": null, "recurrence_end_day": null,
  "recurrence_max_occurrences": null,
  "visibility": "everyone", "category": "festival",
  "color": "#ffd700", "icon": "star", "all_day": true
}
```

**Fields (Calendaria parity):** `color` (hex), `icon` (FontAwesome/custom id),
`all_day`, `recurrence_interval` (periods between recurrences),
`recurrence_end_year/month/day`, `recurrence_max_occurrences`.

#### PUT /calendar/events/:eventId
Updates a calendar event. Same fields as POST; **PARTIAL update** — absent
preserves, an explicit `null` clears, a present value replaces (see "The
partial-update contract" under `PUT /entities/:entityId`).

`calendar-sync.mjs` pushes note edits here from three paths
(`_onCalendariaNoteUpdated`, `_onLocalEventUpdate`,
`_onSimpleCalendarNoteUpdate`), each with a five-key body. Keep bodies
narrow: a Foundry note edit means the name, the date and the body, nothing
else.

#### DELETE /calendar/events/:eventId
Deletes a calendar event.

#### GET /calendar/events/:eventId
Returns a single event by ID.

---

#### Calendar Settings & Structure

| Route | Behavior |
|---|---|
| `PUT /calendar/settings` | Updates calendar name, time system, leap year, current date/time |
| `PUT /calendar/months` | Replaces all month definitions |
| `PUT /calendar/weekdays` | Replaces all weekday definitions |
| `GET /calendar/structure` | Returns calendar structure in Calendaria-compatible format |
| `GET /calendar/weather` | Returns current weather state, or `{}` if none set |
| `PUT /calendar/weather` | Sets current weather state (GM override) |
| `GET /calendar/export` | Exports the full calendar as Chronicle JSON; `?events=true` includes events |
| `POST /calendar/import` | Imports a calendar from JSON (Chronicle, Simple Calendar, Calendaria, Fantasy-Calendar formats) |

---

### Media

#### POST /media/upload
Uploads a media file (image, etc.).

**Used by:** `api-client.mjs` for image sync

**Request:** Multipart form data with `file` field.

**Response:**
```json
{ "id": "media-uuid", "url": "/media/media-uuid.png", "filename": "map-background.png",
  "content_type": "image/png", "size": 1048576 }
```

#### GET /media/:mediaId
Returns media metadata.

#### DELETE /media/:mediaId
Deletes a media file.

---

### Relations (Shops/Inventory)

#### GET /entities/:entityId/relations
Lists relations for an entity (used for shop inventory).

**Response:**
```json
{
  "data": [
    { "id": "relation-uuid", "source_id": "shop-entity-uuid", "target_id": "item-entity-uuid",
      "relation_type_id": 1, "metadata": { "quantity": 5, "equipped": false },
      "target": { "id": "item-uuid", "name": "Longsword", "fields_data": {} } }
  ]
}
```

---

## Chronicle-served Module Distribution

The install/update contract: the URLs Foundry hits to fetch the module's
manifest and zip from Chronicle (not GitHub), codified in
`chronicle-package.json` at this repo's root (`serving.manifestEndpoint`,
`serving.downloadEndpoint`). Hit by **Foundry itself** (install, every update
check) and by the Update Source diagnostic dialog
(`scripts/update-info.mjs`), which also hits the manifest endpoint manually
so the operator can confirm reachability.

> Install-time URL storage, rotation effects, and `update-info.mjs` error
> classification: `.ai.md` → "Chronicle Integration — Install & Updates".

### Authentication

Per-campaign signed token in the query string — not the Bearer-token API key.
Chronicle rotates it on request from the campaign owner. Generated when the
owner first opens the Foundry VTT disclosure in campaign settings.

```
?token=<signed>
```

### Token rotation behavior

The owner rotates their token any time from the Foundry VTT disclosure in
campaign settings (rotate button → `token/rotate` below). After rotation:

- The old token is **immediately invalidated**: a pre-rotation install gets
  `403` with `{ "error": "invalid_token", "category": "auth", ... }` on its
  next update check.
- The new token is embedded in URLs Chronicle emits going forward;
  reinstalling via the freshly-displayed URL works again.
- Recovery is **reinstall**, not repair — Foundry stores the install-time URL
  with no supported way to swap it from the module. The Update Source dialog
  detects this (`auth` category) and suggests reinstalling.

### GET /api/v1/campaigns/:campaignId/foundry-vtt/module.json

Returns the resolved `module.json` for whichever version the campaign is
pinned to (or the auto-latest version if no pin is set), with `manifest` and
`download` fields rewritten to per-campaign Chronicle URLs.

**Used by:**
- Foundry's Install Module dialog (operator pastes this URL).
- Foundry's native Setup → Modules → Update All on every check.
- `scripts/update-info.mjs` for the manual "Check Chronicle for updates".

**Success response (200):** A standard Foundry `module.json` body. The fields
named in the descriptor's `serving.rewriteFields` array (currently `manifest`
and `download`) carry Chronicle URLs:

```json
{
  "id": "chronicle-sync", "version": "0.1.11",
  "manifest": "https://chronicle.example.com/api/v1/campaigns/<cid>/foundry-vtt/module.json?token=<signed>",
  "download": "https://chronicle.example.com/api/v1/campaigns/<cid>/foundry-vtt/module.zip?token=<signed>",
  "...": "all other fields unchanged from the on-disk module.json"
}
```

**Error response shape:** Structured JSON body so clients (including
`update-info.mjs`) can surface actionable messages. Three fields, all
strings:

```json
{ "error": "invalid_token", "category": "auth", "message": "The install-time token was rotated by the campaign owner..." }
```

- `error` — code from the catalog below. **Opaque**, logs/debugging only.
  Foundry MUST NOT branch on it — that couples Foundry to Chronicle's
  internal naming. Branch on `category` instead.
- `category` — snake_case bucket, one of `auth`, `config`, `not_found`,
  `validation`, `internal`. Pinned by cordinator
  `decisions/2026-05-17-error-catalog-wire-contract.md`; canonical wire field
  (`json:"category"`) — `update-info.mjs`'s `chronicleCategory` is a local
  rename, not the wire field.
- `message` — human-readable, operator-actionable. Render verbatim.

**Authoritative catalog:** `error-catalog.json` at the Chronicle repo, pinned
by the wire-contract decision above:

```
https://raw.githubusercontent.com/keyxmakerx/Chronicle/main/internal/plugins/foundry_vtt/error-catalog.json
```

The artifact is treated as **implicit schema v1** — it carries no explicit
`schema_version` field.

| `error` code | `category` | Description | HTTP |
|---|---|---|---|
| `campaign_not_found` | `not_found` | Campaign id in the URL doesn't exist (deleted, or never existed) | 404 |
| `descriptor_invalid` | `validation` | Release zip's `chronicle-package.json` failed schema validation (`PostInstallHook`) | 422 |
| `invalid_token` | `auth` | Token signature doesn't match (rotated, forged, truncated) | 403 |
| `module_json_missing` | `internal` | Release zip is missing `module.json` at the descriptor's `moduleJsonPath` (Chronicle packaging bug) | 500 |
| `no_package_registered` | `config` | No package registered for this campaign's Foundry serving slot — install / re-pin a release | 503 |
| `no_version_available` | `config` | No pinned version and no auto-latest available (catalog empty) | 503 |
| `pinned_version_not_installed` | `config` | Pinned version isn't in Chronicle's installed catalog (race after unpublish, or stale pin) | 503 |
| `token_not_initialized` | `config` | Owner has never opened the Foundry VTT disclosure for this campaign | 503 |

`error-catalog.json` also lists a catch-all `ErrInternal` constructor:
`wildcard: true`, category `internal`, HTTP 500. Its catalog `code` is the
placeholder `<dynamic>`; the wire `error` value is the actual Go error
message. Treat wildcard codes as valid but **opaque** — never enumerate or
branch on the runtime `error` value; `category` (`internal`) is authoritative
for routing, `message` renders verbatim.

**Fallback when `category` is missing or unrecognized:**
`categorize()` in `scripts/update-info.mjs` trusts `body.category` if it's in
the local `CHRONICLE_CATEGORIES` set, else derives one from HTTP status
(401/403 → `auth`, 404 → `not_found`, else → `internal`). No
code-to-category lookup exists by design — branching on `error` would
reintroduce cross-repo drift; a new Chronicle category needs a paired
Foundry-side update first.

### GET /api/v1/campaigns/:campaignId/foundry-vtt/module.zip

Streams the release zip for the resolved pinned version. Same token auth as
the manifest endpoint.

**Used by:** Foundry's install/update flow, after reading the `download` URL
from the manifest response.

**Response:** `application/zip` body. The embedded `module.json` carries
Chronicle URLs (not the source zip's GitHub URLs), so subsequent update
checks go to Chronicle. Rewritten at download time per-campaign, so two
campaigns hitting the same source zip get differently-addressed zips.

**Error response:** Same JSON error shape as the manifest endpoint (same
`error` / `message` / `category` triple, same code catalog).

### Owner-side endpoints (Chronicle web app)

Part of Chronicle's web UI, **not** called by Foundry or this module.
Documented because they affect the contract: token rotation invalidates
installs, pin changes change the version served to Foundry.

#### POST /api/v1/campaigns/:campaignId/foundry-vtt/token/rotate

Owner-only. Rotates the per-campaign signed token. After rotation, all
existing Foundry installs of this campaign's module get `invalid_token`
errors on their next update check (see "Token rotation behavior" above).

**Used by:** Chronicle's owner-side Foundry VTT disclosure (rotate button).

**Response (200):** The new signed token. Owner-side UI re-renders the
per-campaign install URL with the new token embedded.

#### PUT /api/v1/campaigns/:campaignId/settings/foundry-vtt-pin

Owner-only. Sets or clears the campaign's pinned module version. An empty /
absent pin means "track latest". A specific version (e.g., `0.1.11`) means
"serve exactly this version regardless of newer releases".

**Used by:** Chronicle's owner-side Foundry VTT disclosure (pin selector).

**Effect on Foundry:** installed instances see the new version on their next
`module.json` check — an update offer if the pin's version is greater, a
downgrade prompt if lower (Foundry's native behavior), nothing if equal.

### Serving descriptor

`chronicle-package.json` at this repo's root tells Chronicle how to serve
this module. Schema v1:

```jsonc
{
  "schemaVersion": 1,
  "package": {
    "id": "chronicle-sync",       // must match module.json#/id
    "kind": "foundry-module",
    "moduleJsonPath": "module.json"
  },
  "serving": {
    "rewriteFields": ["manifest", "download"],
    "manifestEndpoint": "/api/v1/campaigns/{campaign_id}/foundry-vtt/module.json?token={token}",
    "downloadEndpoint": "/api/v1/campaigns/{campaign_id}/foundry-vtt/module.zip?token={token}",
    "perCampaignSignedToken": true,
    "zipContentRoot": ""
  }
}
```

This is the **contract between this repo and Chronicle's `packages` plugin**.
Chronicle reads it from the extracted zip via `PostInstallHook`; an absent or
invalid descriptor falls back to hardcoded defaults matching the schema
above. `tools/check-package-descriptor.mjs` validates it on every push.

If Chronicle's URL shape changes, update all three together:

1. `chronicle-package.json` (`serving.manifestEndpoint` / `downloadEndpoint`)
2. `scripts/update-info.mjs` (`CHRONICLE_MANIFEST_RE` classifier)
3. This section of `API-CONTRACT.md`

---

## WebSocket Protocol

> **Every `calendar.*` message type below is DORMANT.** Chronicle's calendar
> event publisher was deleted with the plugin, so none reach the wire. A
> structure-mismatch pause from before the blackout can't be cleared by its
> recovery path (`calendar.structure.updated`) until V5 — reload the world.
> **Re-verify by: when calendar V5 ships.**

### Connection
```
GET /ws?token=<api-key>
Upgrade: websocket
```

Authentication happens at connection time via the `token` query parameter.
If the token is invalid, the server rejects the upgrade.

### Message Format (Server → Client)
```json
{
  "type": "entity.updated",
  "data": { }
}
```

### Message Types

| Type | Data Payload | Description |
|---|---|---|
| `entity.created` | Full entity object | New entity created |
| `entity.updated` | Full entity object | Entity modified |
| `entity.deleted` | `{ id: "uuid" }` | Entity deleted |
| `entity_type.created` | Full entity type object | Entity type created |
| `entity_type.updated` | Full entity type object | Entity type modified |
| `entity_type.deleted` | `{ id: "uuid" }` | Entity type deleted |
| `marker.created` | Full marker object | Map marker created |
| `marker.updated` | Full marker object | Map marker modified |
| `marker.deleted` | `{ id }` | Map marker deleted |
| `note.created` | Full note object | Note created |
| `note.updated` | Full note object | Note modified |
| `note.deleted` | `{ id }` | Note deleted |
| `calendar.event.created` | Full event object | Calendar event created |
| `calendar.event.updated` | Full event object | Calendar event modified |
| `calendar.event.deleted` | `{ id }` | Calendar event deleted |
| `calendar.date.advanced` | `{ year, month, day, hour, minute }` | Date/time changed |
| `calendar.season.changed` | `{ id, name, color }` — **or `null`** when the date left a season without entering another | Season boundary crossed |
| `calendar.moon.phase_changed` | `{ moon_id, moon_name, phase_name, phase_position }` | Moon phase changed |
| `calendar.weather.changed` | merged `WeatherInput` (FLAT snake_case) — **or `null`** from the weather-zone paths, where it is a "refetch me" ping | Weather set or generated |
| `calendar.structure.updated` | `null` | Calendar structure modified |
| `calendar.cycle.changed` | `null` | Cycle edited (always fires alongside `structure.updated`) |
| `calendar.festival.changed` | `null` | Festival edited (always fires alongside `structure.updated`) |
| `calendar.era.changed` | `{ id, name, color }` | Era boundary crossed |
| `calendar.worldstate.changed` | `{ date: {year, month, day}, moodTint: {color, intensity} }` | World state changed — dormant along with every other `calendar.*` type during the blackout |
| `sync.status` | `{ connected: bool }` | Connection state change |
| `sync.error` | `{ message }` | Synchronization error |
| `sync.conflict` | Conflict details | Data conflict detected |

### What the module does with each `calendar.*` type

Handled in `scripts/calendar-sync.mjs` `onMessage` + `scripts/_calendar-subresources.mjs`.
**Display-level and non-destructive**: no branch writes a Chronicle value
into the Foundry calendar's stored structure, and none creates a note. Chat
announcements are **GM whispers only** — never public, so a DM-gated payload
is never laundered into a player-visible one.

| Type | Module behavior | Calendaria | Simple Calendar |
|---|---|---|---|
| `calendar.date.advanced` | Applies the date, confirms it back | `CALENDARIA.api.setDateTime` | `SimpleCalendar.api` date set |
| `calendar.event.created/updated/deleted` | Mirrors to a calendar note | Full (notes API) | Full (journal-flag notes) |
| `calendar.weather.changed` | Updates the dashboard world-state panel; applies to the calendar module if it exposes a weather **setter**, else whispers a GM chat line. `null` payload → one `GET /calendar/weather` refetch. | Probes `setWeather` / `setCurrentWeather` / `setWeatherForDate`, falls back to chat when absent (probe result in diagnostics bundle) | No weather surface → chat fallback |
| `calendar.season.changed` | Panel + GM chat line (`calendarAnnounceSeasonEra`, default **on**) | Display only | Display only |
| `calendar.era.changed` | Panel + GM chat line (`calendarAnnounceSeasonEra`, default **on**) | Display only | Display only |
| `calendar.moon.phase_changed` | Panel + GM chat line (`calendarAnnounceMoon`, default **off** — moons change phase every few in-world days) | Display only | Display only |
| `calendar.worldstate.changed` | Panel + GM chat line (`calendarAnnounceWorldstate`, default **on**). Wired and tested, unreachable during blackout. | Display only | Display only |
| `calendar.structure.updated`, `calendar.cycle.changed`, `calendar.festival.changed` | Refetches `GET /calendar`, re-runs the structure comparison, sets the badge: pause if now incompatible, clear a prior pause if compatible, else raise advisory `structure-changed`. **Never auto-applies the structure** — rewriting months/weekdays would silently re-date every note. Runs even while sync is paused (the only recovery path). | Both | Both |
| any other `calendar.*` | `default:` logs one `console.debug` line **per type per session** — no silent drops | — | — |

Every cross-repo claim here carries a `Re-verify by:` line.

### Reconnection

The API client automatically reconnects on WebSocket disconnection:
- Initial retry delay: 2 seconds
- Max retry delay: 30 seconds (exponential backoff)
- Infinite retries (never gives up)
- Queued messages are replayed on reconnection

---

## CORS Requirements

Chronicle must whitelist the Foundry VTT server's origin in its CORS configuration.
The module makes cross-origin requests from the Foundry server (typically
`http://localhost:30000` or a custom domain) to the Chronicle server.

CORS origins are managed in Chronicle's admin panel:
**Admin > API Settings > CORS Origin Whitelist**

Required CORS headers from Chronicle:
```
Access-Control-Allow-Origin: <foundry-origin>
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Allow-Credentials: true
```
