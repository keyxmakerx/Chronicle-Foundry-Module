# Chronicle API Contract

Every Chronicle REST endpoint and WebSocket message the Foundry module depends on.

## Authentication

All REST requests include a Bearer token:
```
Authorization: Bearer <api-key>
```

REST requests through the API client also carry the module's manifest version, so Chronicle
can tell an owner when the module is out of date:
```
X-Chronicle-Module-Version: <module.json version>
```
The header is omitted when the version cannot be read. A Chronicle that
records it lists it in its CORS `Access-Control-Allow-Headers`; an older one
doesn't, so the browser refuses the preflight. The module then retries that
request once without the header and stops sending it for the session
(`scripts/_module-version.mjs`), so an older server keeps syncing. WebSocket
connections do not send it.

WebSocket connections authenticate via query parameter at connection time:
```
wss://chronicle.example.com/ws?token=<api-key>
```

API keys are scoped to a single campaign. The key determines:
- Which campaign's data is accessible
- Permission level: `read` (GET), `write` (POST/PUT/DELETE), `sync` (sync endpoints)
- A `sync`-level key covers read + write + sync
- Rate limit: 60 requests/minute (default)

## Connect Line

Chronicle shows campaign owners a one-paste line that carries everything the
module needs:
```
chronicle://chronicle.example.net/c/<campaignId>?key=<apiKey>
chronicle+http://192.168.1.5:8080/sub/c/<campaignId>?key=<apiKey>
```
- Scheme `chronicle:` means `https://<host[:port]><path>`; `chronicle+http:`
  means `http://<host[:port]><path>` (plain-http instances).
- `<path>` is everything before the final `/c/<campaignId>` segment; it is
  empty unless Chronicle is served under a sub-path. The result is the `apiUrl`
  setting.
- `key` is the URL-decoded query parameter and becomes the API key.
- Any other scheme, a missing key or campaign id, or userinfo in the line is
  invalid and changes nothing.

The module parses it in `scripts/_connect-line.mjs` (`parseConnectLine`); a GM
pastes it into the "Connect line" module setting, which fills the URL,
campaign ID and client-scoped API key and then clears itself.

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
Updates only the `fields_data` on an entity. Chronicle with keyxmakerx/Chronicle#927 merges the sent keys into the stored set (`null` removes a key); older Chronicle replaces the whole set, so the module always sends the stored set with its changes laid over it.

**Used by:** `actor-sync.mjs` → push character stats to Chronicle

**Request:**
```json
{ "fields_data": { "hp_current": 45, "str": 18, "level": 5 } }
```

#### GET /entities/:entityId/permissions
Returns entity permission/visibility settings.

#### PUT /entities/:entityId/permissions
Updates entity permissions. Owner only.

**Request:**
```json
{ "visibility": "default", "is_private": false, "permissions": [ { "subject_type": "role", "subject_id": "1", "permission": "view" } ] }
```

Answers `{"status":"ok"}`. The save stamps a new `updated_at` it does not
return, and its `entity.updated` broadcast can carry the previous one. So the
module pushes only when the body differs from the last one sent for that
journal, reads the page back afterwards, and never lets a journal's recorded
version move backwards.

Re-verify by: 2026-11-03 (Chronicle `entities/service.go` `SetEntityPermissions`)

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

**Used by:** `import-wizard.mjs` → Step 6 (Review) tag creation during import

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

**Query:** `?limit=` (max 1000) and `?offset=`.

**Response:** full `SyncMapping` objects (same shape as `/sync/lookup` below)
plus paging fields.
```json
{
  "data": [
    { "id": "mapping-uuid", "campaign_id": "campaign-uuid",
      "chronicle_type": "entity", "chronicle_id": "entity-uuid",
      "external_system": "foundry", "external_id": "foundry-doc-id",
      "sync_version": 1, "last_synced_at": "2026-01-15T12:00:00Z",
      "sync_direction": "both", "sync_metadata": {},
      "created_at": "2026-01-15T12:00:00Z", "updated_at": "2026-01-15T12:00:00Z" }
  ],
  "total": 1, "limit": 50, "offset": 0
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

#### GET /sync/changes
Change feed: ids of what changed after a cursor. Keys of the owner or of members the owner
has given DM access only (403 otherwise); absent on older Chronicle (404).

**Used by:** `sync-manager.mjs` → initial sync (`_readChangeFeed`): journals, characters and inventories

**Query:** `?since=<seq>&limit=1000` (default 500, max 1000)

**Response:**
```json
{ "changes": [ { "seq": 12, "type": "entity", "resourceId": "uuid", "op": "created" } ], "next": 12, "hasMore": false, "resetRequired": false, "types": ["entity", "relation", "..."] }
```

- `op` is `created`, `updated` or `deleted`; content is refetched through the
  normal reads, so visibility filtering still applies.
- `resetRequired: true` means `since` is older than the feed keeps (30 days):
  do a full rescan and resume from `next`.
- Rows younger than 2 s are held back, so a cursor never passes a change
  still committing; the module reads at least 2.5 s after its socket opened.
- A `relation` change's `resourceId` is the relation's **source entity**: "this
  entity's relations changed". Item sync refetches `GET /entities/:id/relations`.
- `types` lists the resource types the server records (absent on an older
  Chronicle). The module saves it with the cursor; inventories use the delta
  only when the cursor was saved while `relation` was recorded, else every
  linked character is reconciled.

Re-verify by: 2026-11-03 (Chronicle `internal/plugins/syncapi/sync_changes_handler.go`, `sync_change_repository.go`)

#### GET /sync/history
The campaign's sync history, both directions, newest first. Owner keys and
keys of members with DM access only (403 otherwise); absent on older
Chronicle (404).

**Used by:** `sync-history-tab.mjs` → the dashboard's History tab

**Query:** `?limit=50&before=<id>&direction=to_chronicle|to_foundry|link&failed=1&q=<text>` (limit default 50, max 200; a filter matches a run when any of its steps does)

**Response:**
```json
{ "data": [ { "id": 42, "at": "2026-10-03T19:41:40.017Z", "direction": "to_chronicle", "reportedBy": "chronicle", "kind": "page", "resourceId": "uuid", "name": "Port Ashwick", "action": "page updated", "call": "PUT /entities/:entityID", "status": "200", "ok": true, "durationMs": 38, "who": "Ren", "children": [] } ], "nextBefore": 41 }
```

- `reportedBy: "chronicle"` rows are every write a sync key made, recorded by
  Chronicle with its result; `"client"` rows are what the module reported.
- `nextBefore` is present when an older page exists.

#### POST /sync/history
The module reports what only it sees: changes it applied in Foundry
(`to_foundry`), its connects and problems (`link`). Same access as the read.

**Used by:** `sync-manager.mjs` → `_history` (`scripts/_history-report.mjs`), every 15 s and on connect

**Body:** `{ "events": [ { "at", "direction", "kind", "resourceId", "name", "action", "call", "status", "ok", "durationMs", "message", "children" } ] }`, at most 50 events of 200 steps. Returns `{ "stored": n }`.

- A time more than 5 min ahead or 7 days back is replaced by the server's.
- Chronicle names a page the module sent by id only, and for a `to_foundry`
  page row names who last changed it in Chronicle.
- 403 or 404 stops reporting for the session; other failures retry on the
  next flush.

Re-verify by: 2026-11-03 (Chronicle `internal/plugins/syncapi/sync_history_handler.go`, `sync_history_recorder.go`)

#### POST /sync/players
The GM's client reports the world's Foundry users. Chronicle sees only the
GM's key, so this is how it learns which Foundry player is linked to which
member, who is online, and who last changed or failed. The campaign owner's
Foundry page shows it as "Players in Foundry".

**Used by:** `sync-manager.mjs` → `_players` (`scripts/_player-report.mjs`), sent from the GM client only, with the GM's own key

**Body:** `{ "players": [ { "foundryUserId", "name", "memberId", "online", "lastChangeAt", "lastFailedAt", "lastFailure", "failedCount" } ] }`

- At most 100 players, GMs first; a full snapshot, so each report replaces the server's list.
- `name` at most 100 chars; `memberId` is the Chronicle user id from `userMappings`, `""` when unlinked.
- `lastChangeAt` / `lastFailedAt` are RFC 3339 or `null`; `lastFailure` is a short status line (e.g. `HTTP 500 Internal Server Error`, at most 200 chars), never page text; `failedCount` counts failures over the last 7 days.
- No emails or other account details are sent.

**Response:** `{ "stored": n }`

**Errors:** 403 when the key is not the owner's or a DM-access key; 404 on an older Chronicle; both stop reporting for the session. 400 is a bad body: logged once, reporting continues.

**When:** on connect, shortly after a Foundry user logs in or out or is edited, or the mappings change, and otherwise at most every 5 min while connected, only when the snapshot changed.

Re-verify by: 2026-11-03 (Chronicle `internal/plugins/syncapi`, the players handler)

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

`player_image_url` is set on every map row (list and single) whose map has a
picture and at least one shadow area, whatever the key's role:
`/api/v1/campaigns/:id/maps/:mapId/player-image?v=<version>`. That route
returns the picture as JPEG with the shadowed areas smudged in; the version
changes whenever the picture or a shadow does. The owner's key still gets the
original in `image_id`/`image_url`, so the module fetches the player copy,
stores it in Foundry, and points the page every player reads at that file
only (`scripts/_map-player-image.mjs`). A missing field means no shadows
(also what an older Chronicle sends). `drawing_type` also includes `shadow`
(exactly two corner points).

Re-verify by: 2026-11-03 (Chronicle `internal/plugins/syncapi/map_api_handler.go` `PlayerImage`, `playerImageAPIURL`)

Each map row carries `display_settings` (nullable object): the map's own
look. The module reads `frame.style`/`frame.tint` and `pins.style`
(`drop|seal|flag|dot`), `pins.size` (`s|m|l`), `pins.labels`
(`always|hover|never`); absent means "follow the campaign" / the default.
Resolved by `scripts/_map-look.mjs` `resolveMapLook` into the page meta
(`chronicleMapMeta.look`) so players never need campaign settings.

#### GET /maps/look
The campaign map look: `{campaign_frame, frames[], kinds[{id,label,color}],
icons[{id,label,category}], default_icon}`. `campaign_frame` is one of
`atlas|arcane|old|modern|futuristic|gilded` and is what a map without its
own frame wears. Fetched once per full sync; a 404 (older Chronicle) keeps
the Atlas default. Marker `icon` is a Font Awesome class from `icons`; the
viewer draws any well-formed `fa-` class and falls back to `default_icon`.
The marker dialog's icon picker offers `icons` grouped by `category` and
sends only an `id` from that list; without the list (older Chronicle) the
picker is hidden and a marker keeps its icon.
Re-verify by: 2026-11-03 (Chronicle `internal/plugins/syncapi/map_api_look.go`, keyxmakerx/Chronicle#1017)

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

> ### Calendar routes: live, retired, and older servers
>
> Chronicle's date and event routes are live. Current Chronicle answers the
> retired routes (old structure, settings, import, export, advance) with
> `410 {"error":"calendar_route_retired"}`; the module calls none of them. An
> older Chronicle, mid-rebuild, answers calendar routes with `503
> {"error":"calendar_rebuilding"}`, which arms the module's push pause. See
> CLAUDE.md → "Calendar blackout and date-push pauses". A route marked
> Retired below answers 410.
>
> **Re-verify by: when calendar V5 ships.**

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

**Used by:** `_realtime-date-guard.mjs` →
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

#### POST /calendar
Creates the campaign's calendar. Answers `201 {"created": …, "warnings": […]}`;
`409` when the campaign already has a calendar. The module does not call it.

#### POST /calendar/date/confirm
**Optional** (newer Chronicle deployments only). Confirms Foundry *applied* a
date pulled from Chronicle to a local calendar, not merely fetched it — drives the sync chip's "SAW" vs.
"APPLIED" distinction (SAW = the `GET /calendar/date` beacon).

**Used by:** `scripts/_applied-date-confirm.mjs`, for a caller that applied
a date to a Foundry calendar; never sent on a bare fetch or an apply failure.
No Foundry calendar is integrated, so nothing calls it yet (TODO(#95)).

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

#### POST /calendar/advance — retired
Answers `410 {"error":"calendar_route_retired"}`.

#### POST /calendar/advance-time — retired
Answers `410 {"error":"calendar_route_retired"}`.

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

**Used by:** `calendar-sync.mjs` → `fetchEvents`, one request per month across the
current year ±1, and the built-in calendar's month window (current month ±1).

**Day weather.** `GET /calendar/weather/days?year=&month=` returns `{data,total}` of
that month's day readings (`year`, `month`, `day`, `icon`, `preset_label`, …); below
the Director only days up to today. **Used by:** the built-in calendar's month view.

**Players' view.** `GET /calendar`, `GET /calendar/date`, `GET /calendar/events` and
`GET /calendar/weather/days` take `?audience=players`: Chronicle filters the read for an anonymous player
(hidden moons, secret eras, GM-only, per-player and unannounced events left out)
whatever the key's role, and the date, events and day-weather answers carry
`"audience": "players"`. An older Chronicle ignores the parameter and answers
with the GM's view; without the echo the module leaves moons, era, events and
day weather out of the players' snapshot. **Used by:** `CalendarSync.publishPlayerSnapshot`.
Re-verify by: 2026-11-04 (Chronicle `internal/plugins/syncapi/calendar_api_handler.go` `readViewer`; lands with Chronicle #1084)

#### POST /calendar/events
Creates a calendar event. **Used by:** the built-in calendar's Add event (GM), sending `name`, `year`, `month`, `day`, `all_day`, `start_hour`/`start_minute` when timed, and `visibility` (`everyone` or `gm-only`).

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

**Fields:** `color` (hex), `icon` (FontAwesome/custom id),
`all_day`, `recurrence_interval` (periods between recurrences),
`recurrence_end_year/month/day`, `recurrence_max_occurrences`.

#### PUT /calendar/events/:eventId
Updates a calendar event. Same fields as POST; **PARTIAL update** — absent
preserves, an explicit `null` clears, a present value replaces (see "The
partial-update contract" under `PUT /entities/:entityId`).

The module does not call it. A future push of a Foundry note edit must keep
the body narrow: the name, the date and the body, nothing else
(`tools/test-partial-put-contract.mjs`).

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
| `GET /calendar/structure` | Returns the calendar structure |
| `GET /calendar/weather` | Returns current weather state, or `{}` if none set |
| `PUT /calendar/weather` | Sets current weather state (GM override) |
| `GET /calendar/export` | Exports the full calendar as Chronicle JSON; `?events=true` includes events |
| `POST /calendar/import` | Retired: answers `410 {"error":"calendar_route_retired"}`; use `POST /calendar` |

---

### Media

#### POST /campaigns/:id/media
Uploads a media file (image, etc.). Full path
`/api/v1/campaigns/:id/media`.

**Used by:** `api-client.mjs` (`uploadMedia`)

**Request:** Multipart form data with `file` field.

**Response:** `201` with the same media object `GET /media/:mediaId` returns.

#### GET /media/:mediaId
Returns media metadata: `mime_type`, `file_size`, and `url`, a signed
`/media/<id>?expires=…&sig=…` link valid for about 15 minutes. Journal sync
uses it to copy pictures inside page text into the world's files
(`scripts/picture-store.mjs`); a saved signed link would expire.

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

#### GET /armory/shops/:entityId/room
The shop room window's read (`scripts/shop-room-window.mjs`). Needs the armory
addon. 404 when the shop is missing, not a shop, or hidden from the key.

**Response:**
```json
{ "layout": { "...": "saved room, or null to generate one" },
  "goods": [ { "id": 7, "relationType": "sells", "targetEntityId": "item-uuid",
               "targetEntityName": "Rope", "metadata": { "price": 1, "currency": "gp", "quantity": 3 } } ] }
```
`goods` are the shop's `sells` relations a plain player can see (no `dmOnly`
rows, no items hidden from players), so the room can be shown to every player.

#### GET /armory/shops/:entityId/buyers?actingUserId=
#### POST /armory/shops/:entityId/buy
The shop room's buying calls (`scripts/shop-room-window.mjs`), made by the
GM's client: for the GM, or for a player as the Chronicle member the player
is matched to (`actingUserId`, a query parameter on GET and a body field on
POST). Only an Owner key, or the key of a member the owner has given DM
access, may name someone else (403); the name must
be a current member (404); the call then has that member's rights only. Needs
the armory addon.

**Buyers response:** `{"downtimeOpen": true, "canBuyNow": true, "buyers": [{"id": "char-uuid", "name": "Brin", "moneyKey": "gp", "money": 50}]}`

**Buy body:** `{"actingUserId": "member-uuid", "buyerEntityId": "char-uuid", "items": [{"relationId": 7, "quantity": 2}]}`
(at most 50 lines, quantity 1–99; prices come from the listing, never the body)

**Buy response:** `{"status": "bought", "spent": 6, "currency": "gp", "moneyLeft": 44}`.
A player while downtime is closed gets `{"status": "requested"}` instead: the
basket is stored as a request the GM approves on Chronicle's Stashes page, and
nothing is charged yet (`canBuyNow` is false in the buyers response then).
Refusals are `{"message": "..."}`: 400 (empty basket, no coin field, a Wealth
sheet, not enough coin, mixed currencies), 403 (not their character), 404
(shop or good hidden), 409 (prices changed, or the item could not be added).

Re-verify by: 2026-11-03 (Chronicle `internal/plugins/syncapi/shop_api_handler.go`)

---

### DM Screen

The GM's DM Screen window (`dm-screen.mjs`, parsed by `_dm-screen-view.mjs`).
The body is Chronicle's `dmscreen.View`, the same data its own panel draws.
A Chronicle without these routes answers 404; the window then says to update
Chronicle. Players are refused (403) and the downtime switch is owner-only;
the GM's sync key counts as the owner.
Re-verify by: 2026-11-03 (Chronicle `internal/plugins/syncapi/dm_screen_api.go`, `internal/plugins/dmscreen/model.go`; added in Chronicle PR #1021)

#### GET /dm-screen
Used by: `dm-screen.mjs`. Scope: read.

**Response:** sections Chronicle can't fill are left out (`downtime`, `world`, `night`) or empty.
```json
{
  "campaign_id": "uuid",
  "downtime": { "open": false, "can_toggle": true, "pending": 2 },
  "world": { "calendar_id": "uuid", "date_label": "3 Frostfall 1204", "time_label": "14:00", "weather": "Light snow" },
  "night": { "name": "Session 12", "when": "Fri 3 Oct, 7pm", "going": 3, "maybe": 1, "cant": 0, "no_answer": 2 },
  "foundry": { "connected": true, "never_seen": false, "last_seen": "2026-10-03T15:00:00Z" },
  "system_name": "Draw Steel",
  "party_filled": true,
  "party": [
    { "id": "uuid", "name": "Vex", "player_name": "Sam", "subtitle": "Shadow", "conditions": ["Bleeding"],
      "meters": [ { "label": "Stamina", "current": "12", "max": "30", "has_max": true, "percent": 40, "low": true } ] }
  ],
  "hidden": [ { "id": "uuid", "name": "The Baron", "type_name": "Character", "revealed": false } ],
  "conditions": [ { "name": "Bleeding", "text": "Plain rule text." } ]
}
```

#### POST /dm-screen/reveal/:entityId
Used by: `dm-screen.mjs`. Scope: write. Body `{}`. Makes one hidden character visible to players.

**Response:** `{ "id": "uuid", "name": "The Baron", "revealed": true }`

#### POST /dm-screen/downtime
Used by: `dm-screen.mjs`. Scope: write. Body `{ "open": true }` or `{ "open": false }`; a missing `open` is a 400.
404 when the campaign has no Armory.

**Response:** `{ "open": true, "applied": 2, "failed": 0 }` (waiting requests that went through or failed on opening)

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

The catalog carries `"schemaVersion": 1`. CI (`tools/check-error-catalog.mjs`,
`.github/workflows/check-error-catalog.yml`) fetches it on every PR, push to
`main` and weekly, and fails when the table below or `update-info.mjs`'s
`CHRONICLE_CATEGORIES` no longer match it, or when `schemaVersion` changes.

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

### Stashes

Move items and money between characters and stashes. All routes need the
Armory addon; an older Chronicle, or a campaign with the addon off, answers
**404** and the module simply does not offer Stashes (it probes
`GET /stashes/downtime` once per session, caches a definitive answer, and keeps
that 404 out of the error log). JSON is camelCase, money is a number in whole
currency units, ids are strings (a stash id may arrive as a number).

**Used by:** `scripts/stash-sync.mjs` (GM client only), reached by players
through the module socket (`scripts/stash-client.mjs`).

**Acting member.** Every call may carry `actingUserId` (query on GET, body on
POST/PUT): the Chronicle user id of a current member. The call then runs under
THAT member's role and rules. Only an Owner key, or the key of a member the owner has given DM
access, may name someone else (403 otherwise), so naming a player only narrows what the call may do.
The module sends it only when relaying for a player, and takes the member from
the Foundry user id the socket layer attached to the request, never from the
request body.

| Method | Path | Notes |
|---|---|---|
| GET | `/stashes/view?characterId=&actingUserId=` | `{downtimeOpen, canApprove, character:{id,name,moneyKey,money,items:[{itemId,name,quantity}]}, stashes:[{id,name,money,items}], destinations:[{kind,id,name}]}`. `characterId` is the Chronicle entity id (the actor's `entityId` flag). `moneyKey` is empty when the system has no money field. |
| POST | `/stashes/moves` | Body `{actingUserId, kind:"item"\|"money", itemId, quantity, amount, from:{kind,id}, to:{kind,id}}`, endpoint kinds `character`\|`stash`. Items send `itemId`+integer `quantity`; money sends a number `amount` (at most two decimals). Answer `{status:"applied"\|"pending", move}`. 403 not your character, 404 unseen stash, 409 not enough / not applicable. |
| GET | `/stashes/history?characterId=&actingUserId=` | `{history:[line]}`, newest first, at most 50. A line has `id, kind, status, quantity, amount, itemName, fromName, toName, requesterName, summary, createdAt`; a sheet money edit has both ends the same character and reads e.g. "Wealth changed 2 → 3 · in Foundry". |
| GET | `/stashes/requests` | `{requests:[line]}`, pending only; the actor must be able to approve. |
| POST | `/stashes/requests/:moveId/approve`, `/decline` | Body `{actingUserId}` optional; the actor must be able to approve. Answer `{status, move}` (`applied`, `declined` or `failed`). |
| GET | `/stashes/downtime` | `{open}`. |
| PUT | `/stashes/downtime` | `{open, actingUserId}`; approver only. The module does not call it. |

Known limits: only the active GM client answers players, posts request cards and
refreshes actors; the Stashes button treats any Chronicle-linked actor as a
character. Replies to players travel encrypted on the module socket; a refresh
never deletes a Foundry item except the one an applied move took from a
character.

Lists are unwrapped defensively (`{history}`/`{requests}`/`{data}` or a bare
array): `scripts/_stash-model.mjs`.

Re-verify by: 2026-11-03 (Chronicle `internal/plugins/syncapi/stash_api_handler.go`, `internal/plugins/armory/stash_api.go`, `docs/api/openapi.yaml` Stashes tag; the routes are on Chronicle PR #1022 and unreleased as of 2026-10-03)

### Quests

Chronicle's quest boards and quest sheets. Every route needs a key of the
campaign owner or a co-DM (403 otherwise). Players have no key: the active GM's
client reads for them and always adds `?audience=players`, which answers as a
plain player would see it. Pay and give also need the Armory addon (404 when
it is off).

| Method | Path | Notes |
|---|---|---|
| GET | `/quests/homes` | `[{kind:"category"\|"page", id, name?}]`, the places with boards; categories first. `id` is the entity type id (as a string) for a category, the page id for a page; only pages carry `name`. With `?audience=players`, pages a player may not open are left out. |
| GET | `/quests/boards?category=<typeId>` or `?page=<entityId>` | `{canManage, me, looks:{board, ledger}, boards:[{id, name, who, canChange, items:[…]}], mapsOn}`. An item has `id, kind (notice\|note\|page\|map\|string), x, y, w, r` (percentages and degrees) plus, by kind: notice `questId, title, kicker, blurb, reward, status, daysLeft?`; note `text, ownerName`; page or map `entityId\|mapId, name, typeName, concealed, imageUrl` (site-relative); string `from, to`. `hidden` appears only in the DM view. Exactly one of `category`, `page` (400 otherwise). |
| GET | `/quests/:entityID` | DM view `{version, notice, status, handedOut, steps:[{id,text,done,shown}], rewards:[{id,kind,text,amount,entityId,name}], foes, links, layout, looks, due?}`; players' view `{notice (null when hidden), status, handedOut, steps (shown ones), hiddenSteps, due?:{label, daysLeft}, …}`. `status` is `not_started`, `active`, `done` or `failed`. |
| PUT | `/quests/:entityID` | Partial: `{version, …changed fields}`; `steps` is sent whole. 409 when `version` is stale (the module reloads). Answers the DM view. Body at most 256 KiB. |
| GET | `/quests/party` | `[{id, name, player?, imageUrl?}]`, the characters rewards can go to. DM only: `?audience=players` is refused (403), and the module never relays it. |
| POST | `/quests/pay` | `{characterId, amount, reason}`, `amount` in the sheet's main unit (two decimals). One call per character; the module splits coin rewards itself. |
| POST | `/quests/give` | `{characterId, itemId}`, one reward item to one character. Answers `{itemName, characterName}`. |

The module sends hand-out steps one at a time and remembers the ones that
worked, so a retry after a failure never pays or gives twice; the quest is then
saved with `handedOut: true` (and `status: "done"` when asked).

Re-verify by: 2026-11-09 (Chronicle `internal/plugins/syncapi/quest_api_handler.go`, `internal/app/quests_api_adapter.go`, `internal/plugins/quests/model.go`)

### Player notebook pages

Not part of the REST API: the notebook (`scripts/player-notebook.mjs`,
checks in `scripts/_notes-grant.mjs`) frames Chronicle web pages and never
uses the GM's sync key. Everything crosses `postMessage`, and each side checks
the other's origin (Chronicle's, taken from `apiUrl`) before acting.

| Page | Address | Purpose |
|---|---|---|
| Allow window | `/campaigns/:id/notes/allow-app?origin=<Foundry origin>` | A pop-up where the player presses Allow. Replies `{type:"chronicle:notes-grant", token, userId, campaignId}` (token starts `cnt_`) or `{type:"chronicle:notes-grant-declined"}`. |
| Notebook frame | `/embed/campaigns/:id/notes/journal` | The player's Journal. |
| Jot frame | `/embed/campaigns/:id/notes/jots` | Jot notes for the page in view. |
| Calendar frame | `/embed/campaigns/:id/notes/calendar` | The campaign's default calendar, Chronicle's own page, as this player sees it (same grant; the frame reads `/api/notes-app/campaigns/:id/calendars/…`). An older Chronicle answers 404. |

The module keeps a grant only when `campaignId` matches and the GM has matched
the returned `userId` to this Foundry login (Members tab); an unmatched or
mismatched account is refused. Frame to module: `chronicle:embed-ready` (the
module answers `chronicle:notes-token` with the token and current `entityId`),
`chronicle:grant-rejected` (the stored grant is dropped), `chronicle:open-note`
with `noteId`. Module to frame: `chronicle:notes-token`, `chronicle:jots-page`
with `entityId`, `chronicle:open-note`.

Re-verify by: 2026-11-04 (Chronicle `internal/widgets/notes/app_grants_handler.go`, `allow_app.templ`, `static/js/notes_embed.js`, `internal/plugins/calendar/routes.go` `RegisterAppRoutes`)

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
| `marker.deleted` | The deleted marker (with `map_id`) | Map marker deleted |
| `drawing.created` / `.updated` / `.deleted` | Full drawing (`map_id`, `visibility`, …) | Map drawing changed |
| `token.created` / `.updated` / `.deleted` | Full token (`map_id`, `x`, `y`, `is_hidden`, …) | Map token changed |
| `token.moved` | `{ x, y }`; `resourceId` is the token id (no `map_id`); GM-only for a hidden token | Token dragged |
| `layer.created` / `.updated` / `.deleted` | Full layer (`map_id`, …) | Map layer changed |
| `fog.created` / `.updated` / `.deleted` | `{ event, map_id, region? }`; `resourceId` is the map; GM-only. A fog reset arrives as `fog.updated` | Fog changed |
| `note.created` | `{ noteId, entityId }` — ids only; the module fetches the note. An older Chronicle sends the full note object instead | Note created |
| `note.updated` | `{ noteId, entityId }` — ids only; the module fetches the note. An older Chronicle sends the full note object instead | Note modified |
| `note.deleted` | `{ noteId, entityId }` (an older Chronicle sends the full note object; only the id is read) | Note deleted |
| `relation.created` | Full relation row (`id`, `sourceEntityId`, `targetEntityId`, `relationType`, `metadata`, …); `resourceId` is the source entity | Relation row created (one message per direction) |
| `relation.deleted` | Same | Relation row deleted |
| `relation.metadata_updated` | Same | Relation metadata changed (quantity, equipped, stash moves) |
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
| `stash.requested` | `{ moveId, requestedBy, summary }` — ids and a size summary only | A player asked to move something; the GM client fetches `GET /stashes/requests` and posts a card |
| `stash.settled` | `{ moveId, status, decidedBy }` | A request was answered (here or on the website); the card is rewritten |
| `stash.moved` | `{ moveId, status, characterIds, stashIds }` | A move ran; the touched linked actors are re-pulled |
| `stash.money_changed` | `{ characterId, moveId }` | A character's money changed (including a sheet edit); the actor is re-pulled |
| `downtime.changed` | `{ open }` | Downtime was opened or closed; relayed to players' open windows |
| `npc.spotlight` | none; `resourceId` is the NPC's entity id | "Show in Foundry" pressed on a Chronicle NPC page |
| `system_state.updated` | `{ systemId, key }`; `resourceId` is the page's entity id; DM-equivalent sockets only | A system widget saved a page's per-system state (Draw Steel negotiation tracker: `systemId` `drawsteel`, `key` `negotiation`) |
| `quest.updated` | `{ version }`; `resourceId` is the quest page's id. Sent only to DM sockets when the change is DM-only | A quest sheet was saved; open quest windows refetch |
| `notice_boards.updated` | `{ home }` (`page` or `category`); `resourceId` is the page id or the type id | A home's boards changed; open board windows refetch |
| `sync.status` | `{ connected: bool }` | Connection state change |
| `sync.error` | `{ message }` | Synchronization error |
| `sync.conflict` | Conflict details | Data conflict detected |

`relation.*` messages go to the owner's socket and sockets of members the owner has
given DM access only (a relation can
name a private entity). Item sync treats any of them for a linked character
as "reconcile this character's inventory" (`scripts/_inventory-plan.mjs`),
so a missed or repeated message cannot leave it wrong. A removed relation
only unlinks its Foundry item; the module deletes it only when a stash
move the GM just applied took it off that character. Re-verify by:
2026-11-03 (Chronicle `internal/widgets/relations/service.go`,
`internal/app/routes.go` `relationEventPublisherAdapter`; sent since
keyxmakerx/Chronicle#1025).

### What the module does with `stash.*` and `downtime.changed`

These reach DM-equivalent sockets only, with ids and statuses, never names.
Handled in `scripts/stash-sync.mjs` `onMessage`, by the **active GM client
only** (`game.users.activeGM`), and only once the Stashes probe said yes. The
module's WebSocket allowlist includes the `stash.` and `downtime.` prefixes.

Re-verify by: 2026-11-03 (Chronicle `internal/websocket/.ai.md`, `internal/plugins/armory/stash_events.go`)

### What the module does with map items

Every map item change arrives as one of the messages above, so the module
never polls. `marker.*`, `drawing.*`, `token.*`, `layer.*` and `fog.*`
refetch that map's items (`GET /maps/:id/{markers,drawings,tokens,layers,fog}`)
and rewrite the player-safe copy on the map page. `token.moved` is
patched into the GM's cached token instead, many per drag, and the stored
token positions are rewritten once the drag settles. Chronicle answers an
empty item list as `null`, which the module reads as an empty list; only a
failed fetch leaves the drawings, and so the shadows, unknown.

Chronicle sends no message for a map row itself (`map.*` is not published),
so every connect still reads `GET /maps`. On connect the change feed also
names map items changed while Foundry was closed: fog entries name their
map, other entries name the item, which the module places from what it has
stored, refreshing every map once when it cannot. Re-verify by: 2026-11-03
(Chronicle `internal/app/routes.go` `mapEventPublisherAdapter`,
`internal/plugins/syncapi/map_api_handler.go`).

### What the module does with `npc.spotlight`

Sent to DM-equivalent sockets only, with the page id and nothing else, when
the owner or a member given DM access presses "Show in Foundry" on an NPC
page. It is not in the change feed, so a missed one is simply gone. The
module's allowlist includes the `npc.` prefix; `scripts/npc-presence.mjs`
`npcSpotlightRelay` acts on the **active GM client only**: it finds a token
on the GM's current scene linked to that page (shown before hidden) and runs
the same spotlight as the token HUD star. No such token, or a hidden one,
only tells the GM. `tools/test-npc-presence.mjs`.

Re-verify by: 2026-11-03 (Chronicle `internal/plugins/foundry_vtt/npc_spotlight.go`, `internal/app/npc_spotlight_adapters.go`; keyxmakerx/Chronicle#1039)

### What the module does with `system_state.updated`

Sent to DM-equivalent sockets only, with ids and nothing of the state
itself. The module's allowlist includes the `system_state.` prefix;
`scripts/negotiation-mirror.mjs` acts on the **active GM client only**, on
worlds where `game.system.id` is `draw-steel`, and only for `systemId`
`drawsteel` with `key` `negotiation`. It reads

`GET /entities/:entityId/system-state/:system/:key` →
`{ "systemId", "key", "public": {...}, "gm": {...}, "isGm": true, "updatedAt" }`

(the `gm` half is present only for an owner-level key; a 404 means an older
Chronicle or no such page and is ignored quietly) and copies interest and
patience (clamped 0 to 5), motivations, pitfalls (`higher-authority` becomes
the system's `authority`; unknown slugs are dropped) and impression (only
when the tracker has one) onto `system.negotiation` of the NPC actors linked
to that page (actor flag `npcEntityId`, else a unique NPC name match; heroes
never). It runs once more when a GM links a page by dropping its journal on a
token. Nothing is written back: edits on the Foundry sheet don't sync to
Chronicle yet. `tools/test-negotiation-mirror.mjs`.

Re-verify by: 2026-11-03 (Chronicle `internal/plugins/systemstate`, `internal/plugins/syncapi/system_state_api.go`; keyxmakerx/Chronicle#1051)

### What the module does with `note.*`

Nothing. The player notebook shows Chronicle's own Journal and Jot pages in
frames, so notes never become Foundry journals and no sync module reads
`note.*`. The old "Chronicle Notes" folder from the retired note sync is set
aside on the GM's world load (`scripts/_notes-folder.mjs`).

### What the module does with each `calendar.*` type

Handled in `scripts/calendar-sync.mjs` `onMessage` + `scripts/_calendar-subresources.mjs`.
**Display-level and non-destructive**: no Foundry calendar module is
integrated, and no branch writes into Foundry. Chat announcements are **GM
whispers only** — never public, so a DM-gated payload is never laundered into
a player-visible one.

| Type | Module behavior |
|---|---|
| `calendar.date.advanced` | Updates the cached date the dashboard shows. TODO(#95): apply it to the built-in calendar and confirm it back |
| `calendar.event.created/updated/deleted` | Routed; no handler writes anywhere yet. TODO(#95) |
| `calendar.weather.changed` | Updates the dashboard world-state panel and whispers a GM chat line (`calendarAnnounceWeather`). `null` payload → one `GET /calendar/weather` refetch |
| `calendar.season.changed` | Panel + GM chat line (`calendarAnnounceSeasonEra`, default **on**) |
| `calendar.era.changed` | Panel + GM chat line (`calendarAnnounceSeasonEra`, default **on**) |
| `calendar.moon.phase_changed` | Panel + GM chat line (`calendarAnnounceMoon`, default **off** — moons change phase every few in-world days) |
| `calendar.worldstate.changed` | Panel + GM chat line (`calendarAnnounceWorldstate`, default **on**). Wired and tested, unreachable during blackout |
| `calendar.structure.updated`, `calendar.cycle.changed`, `calendar.festival.changed` | Refetches `GET /calendar` into the cache |
| any other `calendar.*` | `default:` logs one `console.debug` line **per type per session** — no silent drops |

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
