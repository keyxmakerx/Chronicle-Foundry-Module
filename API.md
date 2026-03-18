# Chronicle Sync — API Reference

This document describes every REST API endpoint and WebSocket message that the
Foundry VTT module expects from a Chronicle backend. Use this as a contract
when making server-side changes.

All REST endpoints are relative to the configured **API URL** and scoped to the
configured **Campaign ID**. The base path is:

```
{apiUrl}/api/v1/campaigns/{campaignId}
```

All requests include `Authorization: Bearer {apiKey}` header.
All request/response bodies are JSON (`Content-Type: application/json`) unless
noted otherwise.

---

## Table of Contents

- [Authentication](#authentication)
- [Systems](#systems)
- [Entities](#entities)
- [Entity Types](#entity-types)
- [Entity Permissions](#entity-permissions)
- [Entity Relations](#entity-relations)
- [Maps](#maps)
- [Drawings](#drawings)
- [Tokens](#tokens)
- [Fog of War](#fog-of-war)
- [Calendar](#calendar)
- [Sync Mappings](#sync-mappings)
- [Armory / Purchases](#armory--purchases)
- [Media](#media)
- [WebSocket](#websocket)

---

## Authentication

Every REST request includes:

```
Authorization: Bearer {apiKey}
```

The API key is stored as a Foundry world setting (`chronicle-sync.apiKey`),
visible only to GMs. Rate limiting is per-key (default 60 req/min server-side).

WebSocket connections use query param auth:

```
GET {apiUrl}/ws?token={apiKey}
```

---

## Systems

### GET /systems

Fetch all available game systems. Used during startup to match Foundry's
`game.system.id` against Chronicle systems.

**Response:**
```json
[
  {
    "id": "dnd5e",
    "name": "D&D 5th Edition",
    "foundry_system_id": "dnd5e",
    "enabled": true
  }
]
```

- `foundry_system_id` — If set, the module auto-matches this system to the
  Foundry game system with matching `game.system.id`.
- `enabled` — Whether this system is active for the campaign. Only enabled
  systems are matched.

### GET /systems/{systemId}/character-fields

Fetch character field definitions for a system. Used by the generic adapter to
auto-generate field mappings.

**Response:**
```json
{
  "fields": [
    {
      "key": "strength",
      "label": "Strength",
      "type": "number",
      "foundry_path": "system.abilities.str.value",
      "foundry_writable": true
    }
  ],
  "preset_slug": "character",
  "foundry_actor_type": "character"
}
```

- `foundry_path` — Dot-notation path into a Foundry Actor document. Fields
  without this are silently skipped by the module.
- `foundry_writable` — If `false`, the module reads this field from Foundry
  but never writes to it (used for derived values like PF2e ability mods).
- `type` — `"number"` triggers numeric casting. Other types pass through as-is.
- `foundry_actor_type` — Foundry Actor type to target (e.g. `"character"`,
  `"hero"`).

### GET /systems/{systemId}/item-fields

Fetch item field definitions for a system. Used by item-sync to map Chronicle
item data to Foundry Item documents.

**Response:**
```json
{
  "fields": [
    {
      "key": "weight",
      "label": "Weight",
      "type": "number",
      "foundry_path": "system.weight.value"
    }
  ]
}
```

---

## Entities

### GET /entities

List entities with optional type filter and pagination.

**Query params:**
| Param | Type | Description |
|-------|------|-------------|
| `type_id` | string | Filter by entity type ID |
| `per_page` | number | Results per page (default varies, module uses 100) |

**Response:**
```json
{
  "data": [
    {
      "id": "abc123",
      "name": "Elara Brightwood",
      "type_id": "type_char",
      "type_name": "Character",
      "type_slug": "character",
      "entry_html": "<h1>Background</h1><p>...</p>",
      "fields_data": { "strength": 16, "hp_current": 45 },
      "tags": ["npc", "allied"],
      "visibility": "default",
      "is_private": false,
      "cover_image_url": "/uploads/...",
      "created_at": "2026-01-15T10:00:00Z",
      "updated_at": "2026-03-10T14:30:00Z"
    }
  ]
}
```

### GET /entities/{entityId}

Fetch full entity details including HTML content and fields.

**Response:** Same shape as items in the list above.

### POST /entities

Create a new entity.

**Request body:**
```json
{
  "name": "New Character",
  "entity_type_id": "type_char",
  "is_private": false,
  "entry": "Description text (HTML)",
  "fields_data": { "strength": 14 }
}
```

**Response:** Created entity object with `id`.

### PUT /entities/{entityId}

Update entity name, privacy, or content.

**Request body** (partial — include only changed fields):
```json
{
  "name": "Updated Name",
  "is_private": true,
  "entry": "Updated HTML content"
}
```

### PUT /entities/{entityId}/fields

Update only the structured fields on an entity. Used for character stat sync
without touching the narrative content.

**Request body:**
```json
{
  "fields_data": { "hp_current": 30, "strength": 18 }
}
```

### DELETE /entities/{entityId}

Delete an entity permanently.

### POST /entities/{entityId}/reveal

Toggle entity visibility (NPC reveal/hide).

**Request body:**
```json
{
  "is_private": true
}
```

---

## Entity Types

### GET /entity-types

Fetch all entity types configured for the campaign. Used to resolve type IDs
for character, shop, and other entity categories.

**Response:**
```json
[
  { "id": "type_char", "slug": "character", "name": "Character" },
  { "id": "type_shop", "slug": "shop", "name": "Shop" },
  { "id": "type_loc",  "slug": "location",  "name": "Location" }
]
```

The module matches types by `slug` (e.g. `"character"`) to identify which
entities are characters vs journals vs shops.

---

## Entity Permissions

### GET /entities/{entityId}/permissions

Fetch permission grants for an entity.

**Response:**
```json
{
  "permissions": [
    {
      "subject_type": "role",
      "subject_id": "1",
      "permission": "view"
    },
    {
      "subject_type": "role",
      "subject_id": "2",
      "permission": "edit"
    }
  ]
}
```

Permission mapping to Foundry:
| Chronicle | Foundry Ownership |
|-----------|-------------------|
| `view`    | `OBSERVER` (2)    |
| `edit`    | `OWNER` (3)       |

Subject types:
| subject_type | subject_id | Meaning |
|-------------|------------|---------|
| `role`      | `"1"`      | Player role |
| `role`      | `"2"`      | Scribe role |

> **Limitation:** User-specific permissions (`subject_type: "user"`) cannot be
> mapped to Foundry without a user ID mapping table. Only role-based grants are
> synced.

### PUT /entities/{entityId}/permissions

Update entity visibility and permission grants.

**Request body:**
```json
{
  "visibility": "custom",
  "is_private": false,
  "permissions": [
    { "subject_type": "role", "subject_id": "1", "permission": "view" }
  ]
}
```

- `visibility` — `"default"` (simple public/private) or `"custom"` (role-based).

---

## Entity Relations

Used for shop inventory and item ownership.

### GET /entities/{entityId}/relations

Fetch all relations for an entity.

**Response:**
```json
[
  {
    "id": "rel_001",
    "relationType": "Has Item",
    "sourceEntityId": "shop_001",
    "targetEntityId": "item_001",
    "targetEntityName": "Longsword",
    "metadata": "{\"price\":50,\"currency\":\"gp\",\"quantity\":3,\"in_stock\":true}"
  }
]
```

- `metadata` — JSON string containing item-specific data. For shop items:
  `price`, `currency`, `quantity`, `in_stock`, `equipped`.

### POST /entities/{entityId}/relations

Create a new relation (e.g. add item to inventory).

**Request body:**
```json
{
  "targetEntityId": "item_001",
  "relationType": "Has Item",
  "reverseRelationType": "In Inventory Of",
  "metadata": "{\"quantity\":1,\"equipped\":false}"
}
```

### PUT /entities/{entityId}/relations/{relationId}/metadata

Update relation metadata (quantity, equipped state, etc.).

**Request body:**
```json
{
  "metadata": "{\"quantity\":2,\"equipped\":true}"
}
```

### DELETE /entities/{entityId}/relations/{relationId}

Remove a relation (e.g. remove item from inventory).

---

## Maps

### GET /maps

List all maps in the campaign.

**Response:**
```json
[
  { "id": "map_001", "name": "Tavern Ground Floor" }
]
```

---

## Drawings

All drawing coordinates use **percentage-based** values (0–100), not pixels.
The module converts between Foundry's pixel coordinates and Chronicle's
percentages on every sync.

### GET /maps/{mapId}/drawings

Fetch all drawings on a map.

**Response:**
```json
[
  {
    "id": "drw_001",
    "drawing_type": "rectangle",
    "x": 25.5,
    "y": 10.0,
    "width": 15.0,
    "height": 20.0,
    "points": [],
    "stroke_color": "#ff0000",
    "stroke_width": 2,
    "fill_color": "#00ff00",
    "fill_alpha": 0.5,
    "text_content": "",
    "font_size": 14,
    "rotation": 0,
    "visibility": "visible"
  }
]
```

Drawing types: `freehand`, `rectangle`, `ellipse`, `polygon`, `text`.

Foundry type codes → Chronicle types:
| Foundry | Chronicle |
|---------|-----------|
| `f`     | `freehand` |
| `r`     | `rectangle` |
| `e`     | `ellipse` |
| `p`     | `polygon` |
| `t`     | `text` |

### POST /maps/{mapId}/drawings

Create a drawing. Body matches the response shape above (without `id`).

**Response:** `{ "id": "drw_002" }`

### PUT /maps/{mapId}/drawings/{drawingId}

Update a drawing. Full drawing object.

### DELETE /maps/{mapId}/drawings/{drawingId}

Delete a drawing.

---

## Tokens

Token coordinates also use **percentage-based** values (0–100).

### GET /maps/{mapId}/tokens

Fetch all tokens on a map.

**Response:**
```json
[
  {
    "id": "tok_001",
    "name": "Goblin Archer",
    "image_path": "/uploads/tokens/goblin.png",
    "x": 45.2,
    "y": 67.8,
    "width": 5.0,
    "height": 5.0,
    "rotation": 0,
    "is_hidden": false,
    "elevation": 0,
    "bar1_value": 15,
    "bar1_max": 15,
    "bar2_value": null,
    "bar2_max": null,
    "entity_id": "ent_goblin01"
  }
]
```

### POST /maps/{mapId}/tokens

Create a token. Body matches response shape (without `id`).

**Response:** `{ "id": "tok_002" }`

### PUT /maps/{mapId}/tokens/{tokenId}

Update token properties.

### PATCH /maps/{mapId}/tokens/{tokenId}/position

Lightweight position-only update. Used during token drag (debounced 100ms).

**Request body:**
```json
{ "x": 50.0, "y": 30.0 }
```

### DELETE /maps/{mapId}/tokens/{tokenId}

Delete a token.

---

## Fog of War

Fog regions use percentage coordinates. Points are stored as a JSON array of
`{x, y}` objects.

> **Note:** Fog sync is one-way only (Chronicle → Foundry). The module renders
> fog regions as semi-transparent polygon drawings on the Foundry scene.

### GET /maps/{mapId}/fog

Fetch fog regions for a map.

**Response:**
```json
[
  {
    "id": "fog_001",
    "points": "[{\"x\":10,\"y\":10},{\"x\":30,\"y\":10},{\"x\":30,\"y\":30}]",
    "is_explored": false
  }
]
```

- `points` — JSON string of `[{x, y}, ...]` in percentage coordinates.
- `is_explored` — If `true`, region is semi-transparent (explored). If `false`,
  fully opaque (unexplored).

### POST /maps/{mapId}/fog

Create a fog region.

**Request body:**
```json
{
  "points": "[{\"x\":10,\"y\":10},{\"x\":30,\"y\":10},{\"x\":30,\"y\":30}]",
  "is_explored": false
}
```

### DELETE /maps/{mapId}/fog/{fogRegionId}

Delete a fog region.

---

## Calendar

### GET /calendar

Fetch current calendar state.

**Response:**
```json
{
  "current_year": 1492,
  "current_month": 3,
  "current_day": 15,
  "current_hour": 14,
  "current_minute": 30
}
```

> **Indexing:** Chronicle uses 1-indexed months and days. SimpleCalendar uses
> 0-indexed. The module handles this conversion.

### PUT /calendar/date

Set the current calendar date/time.

**Request body:**
```json
{
  "year": 1492,
  "month": 4,
  "day": 1,
  "hour": 8,
  "minute": 0
}
```

### POST /calendar/events

Create a calendar event.

**Request body:**
```json
{
  "name": "Festival of the Moon",
  "year": 1492,
  "month": 11,
  "day": 30,
  "description": "Annual celebration under the full moon",
  "visibility": "public"
}
```

**Response:** `{ "id": "evt_001" }`

### PUT /calendar/events/{eventId}

Update a calendar event.

**Request body:** Same shape as POST (without `visibility`).

### DELETE /calendar/events/{eventId}

Delete a calendar event.

---

## Sync Mappings

Sync mappings track the link between Foundry documents and Chronicle entities.

### GET /sync/pull

Pull all mapping changes since a timestamp. Used during initial sync.

**Query params:**
| Param | Type | Description |
|-------|------|-------------|
| `since` | string | ISO 8601 timestamp (URL-encoded) |

**Response:**
```json
{
  "mappings": [
    {
      "chronicle_type": "entity",
      "chronicle_id": "ent_001",
      "external_system": "foundry",
      "external_id": "JournalEntry.abc123",
      "sync_direction": "both",
      "sync_metadata": {}
    }
  ],
  "server_time": "2026-03-17T12:00:00Z"
}
```

### POST /sync/mappings

Create a new sync mapping.

**Request body:**
```json
{
  "chronicle_type": "entity",
  "chronicle_id": "ent_001",
  "external_system": "foundry",
  "external_id": "JournalEntry.abc123",
  "sync_direction": "both",
  "sync_metadata": {}
}
```

### GET /sync/lookup

Look up a mapping by either side of the link.

**Query params** (use one pair):
| Param | Type | Description |
|-------|------|-------------|
| `chronicle_type` | string | + `chronicle_id` |
| `external_system` | string | + `external_id` |

**Response:** Single mapping object.

---

## Armory / Purchases

### POST /armory/purchase

Execute a shop purchase transaction.

**Request body:**
```json
{
  "shop_entity_id": "shop_001",
  "item_entity_id": "item_001",
  "buyer_entity_id": "char_001",
  "relation_id": "rel_001",
  "quantity": 1,
  "price_paid": 50,
  "currency": "gp",
  "price_numeric": 50,
  "transaction_type": "purchase"
}
```

---

## Media

### POST /media

Upload a file (e.g. token image). Uses `multipart/form-data`.

**Request:** FormData with file attachment.

**Response:** Object containing the uploaded file URL/path.

---

## WebSocket

### Connection

```
GET {apiUrl}/ws?token={apiKey}
```

Messages are JSON objects with a `type` field and optional `payload`, `resourceId`,
and `mapId` fields.

### Message Format

```json
{
  "type": "entity.updated",
  "payload": { ... },
  "resourceId": "ent_001",
  "mapId": "map_001"
}
```

### Entity Events

| Type | Payload | Notes |
|------|---------|-------|
| `entity.created` | Partial entity object | May lack `entry_html`; module fetches full entity via REST |
| `entity.updated` | Partial entity object | Module fetches full entity if fields incomplete |
| `entity.deleted` | `{ id }` | Module unlinks Foundry document (preserves local data) |

### Drawing Events

| Type | Payload | Notes |
|------|---------|-------|
| `drawing.created` | Drawing data | Includes `mapId` at top level |
| `drawing.updated` | Drawing data | `resourceId` = drawing ID |
| `drawing.deleted` | — | `resourceId` = drawing ID |

### Token Events

| Type | Payload | Notes |
|------|---------|-------|
| `token.created` | Token data | Includes `mapId` at top level |
| `token.moved` | Token data | `resourceId` = token ID, percentage coords |
| `token.updated` | Token data | `resourceId` = token ID |
| `token.deleted` | — | `resourceId` = token ID |

### Fog Events

| Type | Payload | Notes |
|------|---------|-------|
| `fog.updated` | `{ event, region, mapId }` | `event`: `"created"`, `"updated"`, or `"reset"` |

### Calendar Events

| Type | Payload | Notes |
|------|---------|-------|
| `calendar.date.advanced` | `{ year, month, day, hour, minute }` | 1-indexed |
| `calendar.event.created` | `{ id, name, year, month, day, description }` | |
| `calendar.event.updated` | Event object with `id` | |
| `calendar.event.deleted` | `{ id }` | |

### Relation Events

| Type | Payload | Notes |
|------|---------|-------|
| `relation.created` | `{ id, relationType, sourceEntityId, targetEntityId, targetEntityName, metadata }` | Used for inventory sync |
| `relation.deleted` | `{ id, relationType, sourceEntityId }` | |
| `relation.metadata_updated` | `{ id, relationType, sourceEntityId, metadata }` | Quantity/equipped changes |

### System Events

| Type | Payload | Notes |
|------|---------|-------|
| `sync.status` | `{ status }` | `"connected"` triggers initial sync |
| `sync.retryComplete` | `{ payload: { success, failed } }` | After retry queue flush |

### Wildcard

The module registers a `*` listener that receives ALL messages for the activity
indicator and message routing.
