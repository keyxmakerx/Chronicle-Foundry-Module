# Chronicle API Contract

This document defines every Chronicle REST API endpoint and WebSocket message
that the Foundry module depends on. A new AI working on this module MUST
understand this contract to avoid breaking changes.

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

## REST Endpoints

### Systems

#### GET /systems
Lists all available game systems for this campaign.

**Used by:** `sync-manager.mjs` → `_detectSystem()`

**Response:**
```json
{
  "data": [
    {
      "id": "dnd5e",
      "name": "D&D 5th Edition",
      "status": "available",
      "enabled": true,
      "has_character_fields": true,
      "has_item_fields": true,
      "foundry_system_id": "dnd5e"
    }
  ]
}
```

#### GET /systems/:systemId/character-fields
Returns character preset field definitions with Foundry annotations.

**Used by:** `adapters/generic-adapter.mjs` → `createGenericAdapter()`

**Response:**
```json
{
  "system_id": "drawsteel",
  "preset_slug": "drawsteel-character",
  "preset_name": "Draw Steel Hero",
  "foundry_system_id": "draw-steel",
  "foundry_actor_type": "hero",
  "fields": [
    {
      "key": "might",
      "label": "Might",
      "type": "number",
      "foundry_path": "system.characteristics.might.value",
      "foundry_writable": true
    },
    {
      "key": "stamina_max",
      "label": "Stamina (Max)",
      "type": "number",
      "foundry_path": "system.stamina.max",
      "foundry_writable": false
    }
  ]
}
```

**Key fields:**
- `foundry_actor_type` — Actor type to create/filter (e.g., "character", "hero")
- `foundry_path` — Dot-notation path on `actor.system` (e.g., "system.abilities.str.value")
- `foundry_writable` — Whether this field can be written back to Foundry (false = read-only from Foundry)

##### Multi-Preset Systems (e.g., Draw Steel Creatures)

A single game system may expose multiple entity presets, each with its own
`foundry_actor_type` and field mappings. For example, Draw Steel has both a
**hero** preset (`drawsteel-character`, actor type `"hero"`) and a **creature**
preset (`drawsteel-creature`, actor type `"npc"`).

**Expected creature preset response:**
```json
{
  "system_id": "drawsteel",
  "preset_slug": "drawsteel-creature",
  "preset_name": "Draw Steel Creature",
  "foundry_system_id": "draw-steel",
  "foundry_actor_type": "npc",
  "fields": [
    { "key": "stamina_max",   "label": "Stamina (Max)",     "type": "number", "foundry_path": "system.stamina.max",                     "foundry_writable": false },
    { "key": "stamina_value", "label": "Stamina (Current)", "type": "number", "foundry_path": "system.stamina.value",                   "foundry_writable": true },
    { "key": "might",         "label": "Might",             "type": "number", "foundry_path": "system.characteristics.might.value",      "foundry_writable": true },
    { "key": "agility",       "label": "Agility",           "type": "number", "foundry_path": "system.characteristics.agility.value",    "foundry_writable": true },
    { "key": "reason",        "label": "Reason",            "type": "number", "foundry_path": "system.characteristics.reason.value",     "foundry_writable": true },
    { "key": "intuition",     "label": "Intuition",         "type": "number", "foundry_path": "system.characteristics.intuition.value",  "foundry_writable": true },
    { "key": "presence",      "label": "Presence",          "type": "number", "foundry_path": "system.characteristics.presence.value",   "foundry_writable": true },
    { "key": "speed",         "label": "Speed",             "type": "number", "foundry_path": "system.speed.value",                     "foundry_writable": true },
    { "key": "stability",     "label": "Stability",         "type": "number", "foundry_path": "system.stability.value",                 "foundry_writable": true },
    { "key": "level",         "label": "Level",             "type": "number", "foundry_path": "system.level",                           "foundry_writable": false },
    { "key": "ev",            "label": "EV",                "type": "number", "foundry_path": "system.ev",                              "foundry_writable": false }
  ]
}
```

> **Current limitation:** The Foundry module's generic adapter (`generic-adapter.mjs`)
> and actor sync (`actor-sync.mjs`) currently support only **one preset per system**.
> If the primary preset is `drawsteel-character`, creature entities with slug
> `drawsteel-creature` will not sync. Multi-preset support requires extending the
> adapter architecture to load multiple presets and route entities by `type_slug`.

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
      "id": "uuid",
      "name": "Entity Name",
      "content": "<p>HTML content</p>",
      "summary": "Short text",
      "entity_type_id": 1,
      "fields_data": { "hp_current": 45, "str": 18 },
      "tags": ["npc", "villain"],
      "visibility": "public",
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-15T12:00:00Z"
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
{
  "name": "Entity Name",
  "content": "<p>HTML content</p>",
  "entity_type_id": 1,
  "visibility": "public"
}
```

**Response:** The created entity object (same shape as GET).

#### GET /entities/:entityId
Returns a single entity with full content.

#### PUT /entities/:entityId
Updates an entity. **PARTIAL update** — see the contract below.

##### The partial-update contract (Chronicle sweep R4, 2026-08-07)

Every JSON update endpoint in Chronicle now reads a request body three ways:

| what the body does with a key | what happens to the stored value |
|---|---|
| **absent** | **preserved** |
| present with a **value** | replaced |
| present and **explicitly `null`** | cleared (nullable columns only) |

The distinction is real on the server, not incidental: the request structs
bind `patch.Field[T]`, which records presence during JSON decoding, so
"absent" and `null` are different things. Non-nullable columns have no
cleared state, so an explicit `null` on one of those preserves rather than
writing a zero.

This **replaced** the previous behaviour, which had no contract at all — it
was whatever each Go field's type happened to do. Pointer fields preserved
on absence; value-typed fields (`string`, `bool`, `int`) wrote their zero.
Two consequences were live on this module's own traffic:

- **`is_private` was value-typed.** `actor-sync.mjs` pushes `{name}` alone
  on a rename, which bound `is_private = false` and **published a hidden
  character entity to every player in the campaign.** The old wording of
  this document said absent meant public. Nobody designed that; it was the
  Go zero value being read as an intention.
- **`parent_id` was not on the request struct at all**, so every update
  from this module detached the entity from the Chronicle hierarchy.

Both are fixed on the server. Send only the fields you mean to change.

**Request:** any subset of the POST shape, plus `parent_id`:

```json
{ "name": "Renamed Character" }
```

```json
{ "parent_id": null }
```
&nbsp;&nbsp;↑ explicitly unparents. Omitting `parent_id` leaves the parent alone.

> **Version skew.** A module talking to a Chronicle older than sweep R4 still
> gets the old whole-replace behaviour. Where a client-side echo already
> exists for that reason — `ChronicleMarkerConfigDialog.#onSave` spreads the
> stored marker under the edited fields — it is kept: it is harmless against
> a merging server and load-bearing against an old one.

#### DELETE /entities/:entityId
Deletes an entity.

#### PUT /entities/:entityId/fields
Updates only the `fields_data` on an entity.

**Used by:** `actor-sync.mjs` → push character stats to Chronicle

**Request:**
```json
{
  "fields_data": {
    "hp_current": 45,
    "str": 18,
    "level": 5
  }
}
```

#### GET /entities/:entityId/permissions
Returns entity permission/visibility settings.

#### PUT /entities/:entityId/permissions
Updates entity permissions.

**Request:**
```json
{
  "visibility": "public"
}
```

#### POST /entities/:entityId/reveal
Toggles entity reveal state (NPC reveal to players). Body is exactly
`{ "is_private": <bool> }` (a `*bool`); an explicit value matching the current
state is a no-op. This remains the correct way to flip visibility from the
module.

> Post-sweep-R4, a bare `PUT /entities/:id` with just `{is_private}` no longer
> 400s — an absent name means "not editing the name" rather than "empty name".
> Keep using `/reveal` anyway: it is the named, single-purpose route, and it
> works against every Chronicle version this module supports.

**Request:**
```json
{ "is_private": true }
```

**Used by:** `actor-sync.mjs`; `sync-dashboard.mjs` (single + bulk visibility
toggles, routed here as of FM-SYNC-WIRE-FIX-R1)

> **Erratum (FM-SYNC-WIRE-FIX-R1):** the dashboard visibility toggles
> previously PUT `/entities/:id` with only `{is_private}` → 400 (swallowed), so
> visibility never changed. Now routed to `POST /entities/:id/reveal`.

---

### Entity Types

#### GET /entity-types
Lists all entity types in the campaign.

**Response:**
```json
{
  "data": [
    {
      "id": 1,
      "name": "Character",
      "slug": "dnd5e-character",
      "icon": "fa-user",
      "color": "#7C3AED"
    }
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
{
  "name": "Quest",
  "name_plural": "Quests",
  "icon": "fa-solid fa-scroll",
  "color": "#fbbf24"
}
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
{
  "entity_ids": ["uuid1", "uuid2"],
  "tag_ids": [1, 2],
  "action": "add"
}
```

`action` must be `"add"`, `"remove"`, or `"set"` (replace all tags).

**Response:**
```json
{
  "status": "ok",
  "processed": 2,
  "results": [
    { "entity_id": "uuid1", "status": "ok" },
    { "entity_id": "uuid2", "status": "ok" }
  ]
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
{
  "entity_ids": ["uuid1", "uuid2"],
  "entity_type_id": 5
}
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
Create a relation on an entity. Uses the forward label string to identify
the relation type (not a numeric ID). The write body binds **snake_case**
(`target_entity_id` / `relation_type` / `reverse_relation_type`) and
`target_entity_id` is **required** (empty → 400). Note the read/WS payload is
camelCase — the shapes are deliberately asymmetric.

**Request:**
```json
{
  "target_entity_id": "uuid",
  "relation_type": "parent of",
  "reverse_relation_type": "child of",
  "metadata": {}
}
```

> **Erratum (FM-SYNC-WIRE-FIX-R1):** `item-sync.mjs` previously sent this body
> camelCase (`targetEntityId`/`relationType`) with a null target, so every
> create 400'd. Now snake_case, and it SKIPS the create when the item has no
> linked Chronicle target entity (a custom Foundry item has nothing to relate
> to). Metadata is sent as a raw object (bound as `json.RawMessage`), not a
> JSON-encoded string.

#### GET /entities/:entityId/relations
List all relations on an entity.

**Used by:** `item-sync.mjs` → pull inventory relations for actors

#### DELETE /relations/:relationId
Delete a relation (and its reverse). `relationId` is the numeric relation id.

**Used by:** `item-sync.mjs` → remove item from actor inventory

> **Erratum (FM-SYNC-WIRE-FIX-R1):** the route is FLAT. Earlier revisions of
> this doc (and `item-sync.mjs`) used a nested
> `DELETE /entities/:entityId/relations/:relationId`, which Chronicle does not
> serve (404). Chronicle's real route is `DELETE /relations/:relationId`
> (`syncapi/routes.go`).

#### PUT /relations/:relationId
Update relation metadata (e.g., item quantity, equipped state). Body is
`{ "metadata": { ... } }` only (bound as `json.RawMessage`); relation type and
target are immutable via this route.

**Used by:** `item-sync.mjs` → update inventory item metadata

> **Erratum (FM-SYNC-WIRE-FIX-R1):** the route is FLAT and takes no
> `/metadata` suffix. Earlier revisions used
> `PUT /entities/:entityId/relations/:relationId/metadata` (404). Chronicle's
> real route is `PUT /relations/:relationId` (`syncapi/routes.go`).

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
    {
      "id": "uuid",
      "chronicle_id": "entity-uuid",
      "foundry_id": "foundry-doc-id",
      "type": "entity",
      "last_synced": "2026-01-15T12:00:00Z"
    }
  ]
}
```

#### POST /sync/mappings
Creates a new sync mapping. Body shape is `CreateSyncMappingInput`.

**Request:**
```json
{
  "chronicle_type": "entity",
  "chronicle_id": "entity-uuid",
  "external_system": "foundry",
  "external_id": "foundry-doc-id",
  "sync_direction": "both",
  "sync_metadata": {}
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
  "id": "mapping-uuid",
  "campaign_id": "campaign-uuid",
  "chronicle_type": "entity",
  "chronicle_id": "entity-uuid",
  "external_system": "foundry",
  "external_id": "foundry-doc-id",
  "sync_version": 1,
  "last_synced_at": "2026-01-01T00:00:00Z",
  "sync_direction": "both",
  "sync_metadata": {},
  "created_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-01T00:00:00Z"
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
{
  "entities": [ ],
  "deleted_entities": [ "uuid1", "uuid2" ],
  "drawings": [ ],
  "tokens": [ ],
  "calendar_events": [ ]
}
```

#### POST /sync
Generic sync endpoint for batch operations.

---

### Maps

#### GET /maps
Lists all maps in the campaign.

> **Note:** Drawing, token, fog, and layer endpoints exist on the Chronicle API
> but are consumed by Chronicle's web map editor only — they are not synced to
> Foundry. Only markers are synced as Foundry Scene Map Notes.

#### GET /maps/:mapId/markers
Lists map markers (pins/notes on the map).

#### POST /maps/:mapId/markers
Creates a map marker.

#### PUT /maps/:mapId/markers/:markerId
Updates a map marker. **PARTIAL update** — absent preserves, an explicit
`null` clears, a present value replaces (see "The partial-update contract"
under `PUT /entities/:entityId`).

`foundry_id` is this module's pairing key. It stays clearable HERE — send
`{"foundry_id": null}` to unpair — while Chronicle's own web marker form,
which never sends the key, can no longer NULL it by omission. That omission
used to unpair every marker a GM edited in the browser, which showed up later
as duplicate markers on the next sync.

#### DELETE /maps/:mapId/markers/:markerId
Deletes a map marker.

---

### Calendar

All calendar endpoints require the calendar addon to be enabled.

#### GET /calendar
Returns the full calendar with all sub-resources eager-loaded: months, weekdays,
moons, seasons, eras, event_categories, cycles, festivals.

**Response:**
```json
{
  "id": "uuid",
  "campaign_id": "uuid",
  "mode": "fantasy",
  "name": "Calendar of Harptos",
  "description": "...",
  "epoch_name": "DR",
  "current_year": 1492,
  "current_month": 1,
  "current_day": 15,
  "current_hour": 14,
  "current_minute": 30,
  "hours_per_day": 24,
  "minutes_per_hour": 60,
  "seconds_per_minute": 60,
  "leap_year_every": 4,
  "leap_year_offset": 0,
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
  "mode": "fantasy",
  "year": 1492,
  "month": 1,
  "day": 15,
  "hour": 14,
  "minute": 30,
  "tracks_real_time": false,
  "current_season": { "id": 1, "name": "Winter", "color": "#a0c4ff" },
  "current_moon_phases": [
    { "moon_id": 1, "moon_name": "Selûne", "phase_name": "Full Moon", "phase_position": 0.5, "phase_icon": "moon" }
  ],
  "current_era": { "id": 1, "name": "Dale Reckoning", "start_year": 1, "color": "#6366f1" },
  "current_weather": {
    "preset_id": "rain",
    "preset_label": "Rain",
    "icon": "cloud-rain",
    "color": "#6b9bd2",
    "temperature_celsius": 12.0,
    "wind": { "speed_kph": 25.0, "speed_tier": "moderate", "direction": "NW", "direction_degrees": 315 },
    "precipitation": { "type": "rain", "intensity": 0.6 },
    "zone_id": "temperate",
    "zone_name": "Temperate",
    "description": "Steady rainfall"
  }
}
```

**Key:** `current_season`, `current_moon_phases`, `current_era`, and `current_weather` are
computed server-side. They may be `null`/absent if no data is configured.

**`tracks_real_time`** (RC-4, FM-REALTIME-DATE-SIGNAL): the composed
`UsesRealTime()` predicate (`mode == reallife AND` the real-time flag), so the
wire signal can never disagree with the write-guard below. Read it
defensively — `payload?.tracks_real_time === true` — never assume the field
is present (older Chronicle deployments and `GET /calendar`, the structure
endpoint, never carry it). When `true`, the module treats dates as
**read-only**: it skips its own `PUT /calendar/date` pushes (fetch-before-push
check via `scripts/_realtime-date-guard.mjs`, re-probed on every push attempt
so a mid-session enable self-heals) and shows one GM notice per session. Pull
and event sync are unaffected.

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
**Optional — Chronicle ≥ the applied-beacon release (C-SYNC-APPLIED-BEACON).**
Confirms that Foundry successfully *applied* a date pulled from Chronicle to
the active local calendar module (Calendaria or SimpleCalendar), as opposed
to merely having fetched/seen it. Chronicle's sync chip uses this to
distinguish "Foundry SAW this date" (the `GET /calendar/date` beacon) from
"Foundry APPLIED this date."

**Used by:** `calendar-sync.mjs` → `_confirmAppliedDate` via
`scripts/_applied-date-confirm.mjs`, called from both the poll apply path
(`onInitialSync`) and the WebSocket-driven apply path
(`_onChronicaleDateAdvanced`, `calendar.date.advanced`) — **only** after the
local calendar-module setter (`_setLocalDate`) reports it actually ran
without throwing. Never sent on a bare fetch/pull, and never on an apply
failure. An already-current date that still round-trips through a real
setter call counts as applied and is confirmed.

**Request:**
```json
{ "year": 1492, "month": 3, "day": 1 }
```

**Response:** `204 No Content`

**Graceful degradation:** a Chronicle deployment that predates this endpoint
returns 404 (route doesn't exist) or 405 (method not recognized). The module
tolerates both silently — one `console.debug` per session, no retries — so
it keeps working unchanged against pre-upgrade Chronicle servers. Any other
failure (network, 5xx) is debug-logged and swallowed; a missed confirmation
only leaves Chronicle's applied-beacon stale, it never blocks or retries
sync. See `scripts/_applied-date-confirm.mjs::isConfirmNotSupported`.

#### POST /calendar/advance
Advances the calendar by N days (1-3650).

**Request:** `{ "days": 7 }`

#### POST /calendar/advance-time
Advances time by hours/minutes (rolls over into days).

**Request:** `{ "hours": 2, "minutes": 30 }`

---

#### Calendar Sub-Resources

#### GET /calendar/seasons
Returns all season definitions.

#### PUT /calendar/seasons
Replaces all season definitions (bulk replace).

#### GET /calendar/moons
Returns all moon definitions.

#### PUT /calendar/moons
Replaces all moon definitions.

#### GET /calendar/eras
Returns all era definitions.

#### PUT /calendar/eras
Replaces all era definitions.

#### GET /calendar/event-categories
Returns all event category definitions.

#### PUT /calendar/event-categories
Replaces all event categories.

#### GET /calendar/cycles
Returns zodiac/elemental cycle definitions with entries.

#### PUT /calendar/cycles
Replaces all cycle definitions (including entries).

#### GET /calendar/festivals
Returns fixed calendar festival entries.

#### PUT /calendar/festivals
Replaces all festival definitions.

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
  "year": 1492, "month": 11, "day": 30,
  "start_hour": 8, "start_minute": 0,
  "end_year": 1492, "end_month": 12, "end_day": 1,
  "end_hour": 23, "end_minute": 59,
  "is_recurring": true,
  "recurrence_type": "yearly",
  "recurrence_interval": 1,
  "recurrence_end_year": null, "recurrence_end_month": null, "recurrence_end_day": null,
  "recurrence_max_occurrences": null,
  "visibility": "everyone",
  "category": "festival",
  "color": "#ffd700",
  "icon": "star",
  "all_day": true
}
```

**New fields (Calendaria parity):**
- `color` — Hex color for calendar display
- `icon` — Icon identifier (FontAwesome or custom)
- `all_day` — Whether event spans entire day(s) vs. specific times
- `recurrence_interval` — How many periods between recurrences (e.g., every 2 years)
- `recurrence_end_year/month/day` — When recurrence stops
- `recurrence_max_occurrences` — Maximum number of recurrences

#### PUT /calendar/events/:eventId
Updates a calendar event. Same fields as POST, but it is a **PARTIAL update**
— absent preserves, an explicit `null` clears, a present value replaces (see
"The partial-update contract" under `PUT /entities/:entityId`).

This is the endpoint `calendar-sync.mjs` pushes note edits to, from three
paths (`_onCalendariaNoteUpdated`, `_onLocalEventUpdate`,
`_onSimpleCalendarNoteUpdate`), each with a five-key body. Before sweep R4
every one of those pushes also wrote `is_recurring = false`, `all_day = false`
and a cleared `entity_id`, because those were value-typed / clear-on-nil on
the server. They are preserved now. Keep the bodies narrow: a Foundry note
edit means the name, the date and the body, and nothing else.

#### DELETE /calendar/events/:eventId
Deletes a calendar event.

#### GET /calendar/events/:eventId
Returns a single event by ID.

---

#### Calendar Settings & Structure

#### PUT /calendar/settings
Updates calendar name, time system, leap year, current date/time.

#### PUT /calendar/months
Replaces all month definitions.

#### PUT /calendar/weekdays
Replaces all weekday definitions.

#### GET /calendar/structure
Returns calendar structure in Calendaria-compatible format.

#### GET /calendar/weather
Returns current weather state, or `{}` if none set.

#### PUT /calendar/weather
Sets current weather state (GM override).

#### GET /calendar/export
Exports the full calendar as Chronicle JSON. Add `?events=true` to include events.

#### POST /calendar/import
Imports a calendar from JSON (Chronicle, Simple Calendar, Calendaria, Fantasy-Calendar formats).

---

### Media

#### POST /media/upload
Uploads a media file (image, etc.).

**Used by:** `api-client.mjs` for image sync

**Request:** Multipart form data with `file` field.

**Response:**
```json
{
  "id": "media-uuid",
  "url": "/media/media-uuid.png",
  "filename": "map-background.png",
  "content_type": "image/png",
  "size": 1048576
}
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
    {
      "id": "relation-uuid",
      "source_id": "shop-entity-uuid",
      "target_id": "item-entity-uuid",
      "relation_type_id": 1,
      "metadata": { "quantity": 5, "equipped": false },
      "target": { "id": "item-uuid", "name": "Longsword", "fields_data": {} }
    }
  ]
}
```

---

## Chronicle-served Module Distribution

This section documents the install/update contract — the URLs Foundry hits to
fetch the module's manifest and zip from Chronicle (rather than GitHub).
Settled by FM-CONSOLIDATE-R1 D1 and codified in `chronicle-package.json` at
this repo's root (`serving.manifestEndpoint`, `serving.downloadEndpoint`).

Unlike the REST endpoints above, these endpoints are hit by **Foundry itself**
(both at install and on every update check), not by this module's runtime
code. The Update Source diagnostic dialog (`scripts/update-info.mjs`) also
hits the manifest endpoint manually so the operator can confirm reachability.

> **For the Foundry-side narrative** (how Foundry stores the install-time
> URL, how rotation affects already-installed instances, how update-info.mjs
> classifies errors), see `.ai.md` → "Chronicle Integration — Install &
> Updates".

### Authentication

Per-campaign signed token in the query string — not the Bearer-token API key.
Each token is tied to a specific campaign; Chronicle rotates them on request
from the campaign owner. The token is generated when the owner first opens
the Foundry VTT disclosure in their campaign settings.

```
?token=<signed>
```

### Token rotation behavior

The campaign owner can rotate their token at any time from the Foundry VTT
disclosure in campaign settings (the rotate button hits the `token/rotate`
endpoint documented below). After rotation:

- The old token is **immediately invalidated**. Any Foundry instance that
  installed before the rotation will start getting `403` with
  `{ "error": "invalid_token", "category": "auth", ... }` on its next
  update check.
- The new token is the one embedded in the per-campaign URLs Chronicle
  emits going forward. Players who reinstall via the freshly-displayed
  URL get a working install again.
- Recovery for existing installs is **reinstall**, not in-place repair —
  Foundry stores the install-time URL on its own and we don't have a
  supported way to swap it out from within the module. The Update Source
  diagnostic dialog detects this case (`auth` category in
  `update-info.mjs`) and surfaces a "reinstall using the fresh install
  URL" action message.

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
  "id": "chronicle-sync",
  "version": "0.1.11",
  "manifest": "https://chronicle.example.com/api/v1/campaigns/<cid>/foundry-vtt/module.json?token=<signed>",
  "download": "https://chronicle.example.com/api/v1/campaigns/<cid>/foundry-vtt/module.zip?token=<signed>",
  "...": "all other fields unchanged from the on-disk module.json"
}
```

**Error response shape:** Structured JSON body so clients (including
`update-info.mjs`) can surface actionable messages. Three fields, all
strings:

```json
{
  "error": "invalid_token",
  "category": "auth",
  "message": "The install-time token was rotated by the campaign owner..."
}
```

- `error` — machine-readable code from the catalog below. **Opaque
  identifier**, used for logs / debugging. Foundry consumers MUST NOT
  branch on this field; treating it as a public enum couples Foundry to
  Chronicle's internal naming. Branch on `category` instead.
- `category` — snake_case bucket from the five-value enum below
  (`auth`, `config`, `not_found`, `validation`, `internal`). Pinned by
  cordinator `decisions/2026-05-17-error-catalog-wire-contract.md`. This
  is the canonical wire field name (Chronicle marshals it as
  `json:"category"`); the `chronicleCategory` identifier seen inside
  `scripts/update-info.mjs` is a local function-parameter rename, not a
  wire field.
- `message` — human-readable, operator-actionable string. Render verbatim;
  do not re-construct on the client side.

**Authoritative catalog.** The live source of truth is `error-catalog.json`
at the Chronicle repo, pinned by the wire-contract decision:

```
https://raw.githubusercontent.com/keyxmakerx/Chronicle/main/internal/plugins/foundry_vtt/error-catalog.json
```

The artifact is treated as **implicit schema v1** — it does not currently
carry an explicit `schema_version` field, and the decision to add one is
deferred to the FM-DRIFT-GUARD dispatch (which will pin both the field
shape and the CI mismatch behavior). FM-DRIFT-GUARD CI (queued) will
fetch this URL on every Foundry PR and assert the table below matches.

| `error` code                   | `category`   | Description                                                                                                                       |
|--------------------------------|--------------|-----------------------------------------------------------------------------------------------------------------------------------|
| `campaign_not_found`           | `not_found`  | Campaign id in the URL does not exist (deleted by the owner, or never existed). HTTP 404.                                         |
| `descriptor_invalid`           | `validation` | The release zip's `chronicle-package.json` failed schema validation on Chronicle's `PostInstallHook`. HTTP 422.                   |
| `invalid_token`                | `auth`       | Token signature does not match (rotated, forged, or truncated). HTTP 403.                                                         |
| `module_json_missing`          | `internal`   | The resolved release zip is missing its `module.json` at the descriptor's `moduleJsonPath`. Chronicle-side packaging bug. HTTP 500. |
| `no_package_registered`        | `config`     | Chronicle has no package registered for this campaign's Foundry serving slot. Owner needs to install / re-pin a release. HTTP 503. |
| `no_version_available`         | `config`     | Campaign has no pinned version and no auto-latest is available (e.g., catalog is empty). HTTP 503.                                |
| `pinned_version_not_installed` | `config`     | Campaign is pinned to a version that isn't in Chronicle's installed catalog (race after admin-side unpublish, or stale pin). HTTP 503. |
| `token_not_initialized`        | `config`     | Owner has never opened the Foundry VTT disclosure for this campaign, so no token has been generated yet. HTTP 503.                |

`error-catalog.json` also lists Chronicle's catch-all `ErrInternal`
constructor with `wildcard: true`, category `internal`, HTTP 500. In the
catalog file this entry's `code` is the literal placeholder `<dynamic>`;
on the wire, the runtime `error` value is the underlying Go error
message, **not** the literal text `<dynamic>`. Consumer rules per
cordinator `decisions/2026-05-17-error-catalog-wire-contract.md`:

- Treat wildcard codes as valid but **opaque**. Do not enumerate them in
  any code→category map; do not branch on the runtime `error` value.
- The `category` field remains authoritative for routing (here,
  `internal`). Render `message` verbatim as with any other error.
- Documentation lists the wildcard as a placeholder row, not an
  enumerable code. FM-DRIFT-GUARD CI will treat any `wildcard: true`
  entry as "any code value matches the placeholder" so the doc keeps
  passing even though the wire payload differs from the literal
  `<dynamic>` string.

**Fallback when `category` is missing or unrecognized.**
`scripts/update-info.mjs`'s `categorize()` (file:line
`scripts/update-info.mjs:104-110`) trusts `body.category` if it appears
in the local `CHRONICLE_CATEGORIES` set; otherwise it derives a category
from HTTP status: 401 / 403 → `auth`, 404 → `not_found`, 5xx → `internal`,
anything else → `internal`. There is intentionally **no** code-to-category
lookup table on the Foundry side — branching on `error` would re-create
the cross-repo drift the wire contract was written to prevent. New
Chronicle categories therefore need a paired Foundry-side update; until
that update lands, an unrecognized `category` falls through to HTTP-status
classification (less precise, but never wrong).

### GET /api/v1/campaigns/:campaignId/foundry-vtt/module.zip

Streams the release zip for the resolved pinned version. Same token auth as
the manifest endpoint.

**Used by:** Foundry's install/update flow, after reading the `download` URL
from the manifest response.

**Response:** `application/zip` body. The embedded `module.json` inside the
zip carries Chronicle URLs (not the GitHub URLs in the source zip), so
Foundry's subsequent update checks go to Chronicle. This rewrite happens at
download time per-campaign, so two campaigns hitting the same on-disk source
zip get two zips whose embedded `module.json` carries different
campaign-specific URLs. Settled by C-FMC-7.

**Error response:** Same JSON error shape as the manifest endpoint (same
`error` / `message` / `category` triple, same code catalog).

### Owner-side endpoints (Chronicle web app)

These endpoints are part of Chronicle's web UI, **not** called by Foundry or
by anything in this module. They are documented here because they affect the
contract Foundry depends on — token rotation invalidates installs, pin
changes change the version served to Foundry — and a future contributor
reading this file should know they exist.

#### POST /api/v1/campaigns/:campaignId/foundry-vtt/token/rotate

Owner-only. Rotates the per-campaign signed token. After rotation, all
existing Foundry installs of this campaign's module will get
`invalid_token` errors on their next update check (see "Token rotation
behavior" above).

**Used by:** Chronicle's owner-side Foundry VTT disclosure (rotate button).

**Response (200):** The new signed token. Owner-side UI re-renders the
per-campaign install URL with the new token embedded.

#### PUT /api/v1/campaigns/:campaignId/settings/foundry-vtt-pin

Owner-only. Sets or clears the campaign's pinned module version. An empty /
absent pin means "track latest". A specific version (e.g., `0.1.11`) means
"serve exactly this version regardless of newer releases".

**Used by:** Chronicle's owner-side Foundry VTT disclosure (pin selector).

**Effect on Foundry:** Already-installed instances will see the new version
on their next `module.json` update check. Foundry will offer an update if
the new pin's version is greater than the installed version, a downgrade
prompt if it's lower (Foundry's native behavior — not module-specific), or
do nothing if it's equal.

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
Chronicle reads it from the extracted zip via `PostInstallHook` (C-FMC-5b);
absent or invalid descriptor falls back to hardcoded defaults matching the
schema above. CI validates the descriptor on every push via
`tools/check-package-descriptor.mjs`.

If Chronicle's URL shape ever changes, three places update together:

1. `chronicle-package.json` (`serving.manifestEndpoint` / `downloadEndpoint`)
2. `scripts/update-info.mjs` (`CHRONICLE_MANIFEST_RE` classifier)
3. This section of `API-CONTRACT.md`

---

## WebSocket Protocol

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
|------|-------------|-------------|
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
| `calendar.worldstate.changed` | `{ date: {year, month, day}, moodTint: {color, intensity} }` | World state changed — **see the gap note below; does not currently reach the wire** |
| `sync.status` | `{ connected: bool }` | Connection state change |
| `sync.error` | `{ message }` | Synchronization error |
| `sync.conflict` | Conflict details | Data conflict detected |

### What the module does with each `calendar.*` type

Wired by FM-SYNC-SUBRESOURCES-P1 (`scripts/calendar-sync.mjs` `onMessage` +
`scripts/_calendar-subresources.mjs`). Before that dispatch only the first four
rows were handled and the switch had no `default:`, so every other type was
dropped with no trace.

P1 is **display-level and non-destructive**: no branch below writes a Chronicle
value into the Foundry calendar's stored structure, and none creates a note.
Chat announcements are **GM whispers only** — never public chat, so a payload
Chronicle gated to the DM is not laundered into a player-visible one.

| Type | Module behavior | Calendaria | Simple Calendar |
|------|-----------------|-----------|-----------------|
| `calendar.date.advanced` | Applies the date, confirms it back | `CALENDARIA.api.setDateTime` | `SimpleCalendar.api` date set |
| `calendar.event.created/updated/deleted` | Mirrors to a calendar note | Full (notes API) | Full (journal-flag notes) |
| `calendar.weather.changed` | Updates the dashboard world-state panel; applies to the calendar module if it exposes a weather **setter**, else whispers a GM chat line. A `null` payload triggers one `GET /calendar/weather` refetch. | Reads only on shipped builds — the module probes `setWeather` / `setCurrentWeather` / `setWeatherForDate` and falls back to chat when absent (the probe result is reported in the diagnostics bundle) | No weather surface → chat fallback |
| `calendar.season.changed` | Panel + GM chat line (`calendarAnnounceSeasonEra`, default **on**) | Display only | Display only |
| `calendar.era.changed` | Panel + GM chat line (`calendarAnnounceSeasonEra`, default **on**) | Display only | Display only |
| `calendar.moon.phase_changed` | Panel + GM chat line (`calendarAnnounceMoon`, default **off** — moons change phase every few in-world days) | Display only | Display only |
| `calendar.worldstate.changed` | Panel + GM chat line (`calendarAnnounceWorldstate`, default **on**). Handler is wired and tested but **currently unreachable** — see the gap note. | Display only | Display only |
| `calendar.structure.updated`, `calendar.cycle.changed`, `calendar.festival.changed` | Refetches `GET /calendar`, re-runs the structure comparison, and sets the badge: pause if now incompatible, clear a prior mismatch pause if now compatible, otherwise raise the advisory `structure-changed` state. **Never auto-applies the structure** — rewriting months/weekdays would silently re-date every existing note. Processed even while sync is paused (the only recovery path). | Both | Both |
| any other `calendar.*` | `default:` branch logs one `console.debug` line **per type per session** — no more silent drops | — | — |

#### Gap: `calendar.worldstate.changed` never reaches the wire

Verified against Chronicle `main` on 2026-07-25 (FM-SYNC-SUBRESOURCES-P1
Step 0). Three independent blockers, all Chronicle-side:

1. **Not published.** `worldstate_service.go:265` calls
   `PublishCalendarEvent("calendar.worldstate.changed", …)`, but the adapter
   that translates internal event names to `ws.MessageType`
   (`calendarEventPublisherAdapter.PublishCalendarEvent`,
   `internal/app/routes.go`) has no `case` for it and hits `default: return`.
   The event is dropped before the bus. `calendar.weather.zones.changed` is
   dropped the same way.
2. **No celestial detail in the payload.** Even once published, the payload is
   `{date, moodTint}` — the meteor/eclipse rows in `calendar_celestial_events`
   that motivated the dispatch are not in it.
3. **No syncapi read path.** `GET /calendar/world-state` is registered on the
   web plugin group, not the Bearer-token `syncapi` group, so the module cannot
   fetch the detail either (`internal/plugins/calendar/routes.go:157` vs
   `internal/plugins/syncapi/routes.go`).

The module-side handler ships wired and tested so the feature lights up the
moment Chronicle closes (1); until then it is dormant. Closing (2) and (3) is
Chronicle-side work.

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
