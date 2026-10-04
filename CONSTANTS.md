# Chronicle Sync — Constants & Magic Values

Reference for all hardcoded values, thresholds, and behavioral constants in the
module. Useful when debugging sync behavior or tuning performance.

---

## Timing & Debounce

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| Map-viewer notify debounce | 200ms | `map-sync.mjs` `NOTIFY_DEBOUNCE_MS` | Collapses a burst of WS updates for a map into one viewer re-render |
| Status dot activity flash | 300ms | `module.mjs` `activityThrottled` timeout | Brief white flash on WS message |
| WS initial reconnect delay | 1000ms | `api-client.mjs` `_reconnectDelay` | First reconnect attempt delay |
| WS max reconnect delay | 30000ms | `api-client.mjs` `_scheduleReconnect` | Cap on exponential backoff |
| WS backoff multiplier | 2x | `api-client.mjs` `_scheduleReconnect` | Delay doubles each attempt |

## Queue & Cache Limits

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| Message queue cap | 100 | `api-client.mjs` `send` | Max buffered WS messages while disconnected |
| Retry queue cap | 50 | `api-client.mjs` `queueForRetry` | Max failed REST operations to retry on reconnect |
| Retry max attempts | 3 | `api-client.mjs` `queueForRetry` | Per-operation retry limit |
| Activity log max | 100 | `sync-manager.mjs` `_maxLogEntries` | Dashboard activity log entries |
| Error log max | 50 | `api-client.mjs` `_maxErrorLogEntries` | Dashboard error log entries |
| Error message truncation | 200 chars | `api-client.mjs` `_logError` | Truncated with `…` |
| Sync pull page | 1000 rows | `_sync-pull-walk.mjs` `PULL_PAGE_SIZE` | `GET /sync/pull` is walked page by page until `has_more` is false |
| Change feed page | 1000 rows | `_change-feed.mjs` `FEED_PAGE_SIZE` | `GET /sync/changes` page size |
| Change feed settle | 2500ms | `_change-feed.mjs` `FEED_SETTLE_MS` | Minimum wait after the socket opens before reading the feed |
| NPC talking timeout | 2 min | `_npc-presence.mjs` `TALK_TIMEOUT_MS` | An NPC's Talking state switches off after this long without a line |
| Entity pagination | 100/page, 200 pages | `_entity-page-walk.mjs` `ENTITY_PAGE_SIZE`/`MAX_ENTITY_PAGES` | Bound is 20,000 entities; a walk that hits it sets a `truncated` flag the caller must surface |

## Coordinate Systems

Map markers, drawings, tokens and fog regions use percentages (0–100) of the
map image on both sides. `MapViewerSheet` draws them as SVG overlays on the
image page, so no pixel conversion happens.

## Permission Mapping

### Chronicle → Foundry

| Chronicle `visibility` | Chronicle `is_private` | Foundry default ownership |
|------------------------|----------------------|---------------------------|
| any | `true` | `NONE` (0), or the default level when the `dmOnlyHidden` setting is off |
| `"default"` | `false` | `defaultOwnership` setting (default `OBSERVER`, 2) |
| `"custom"` | `false` | Per-role grants |

### Role Grants → Foundry Ownership

| Chronicle permission | Foundry ownership level |
|---------------------|------------------------|
| `"view"` | `OBSERVER` (2) |
| `"edit"` | `OWNER` (3) |

### Chronicle Role IDs

| Role ID | Meaning |
|---------|---------|
| `"1"` | Player |
| `"2"` | Scribe |

## System Matching

System matching is API-driven: the `/systems` endpoint returns each system's
`foundry_system_id`, which `sync-manager.mjs`'s `_detectSystem()` matches
against `game.system.id`. There is no in-module fallback table.

### Actor Type by System

| System | Foundry `actor.type` |
|--------|---------------------|
| D&D 5e | `"character"` |
| Pathfinder 2e | `"character"` |
| Draw Steel | `"hero"` |
| Generic | Via `foundry_actor_type` in system manifest |

## Relation Types (Inventory)

| Relation type | Reverse type | Used for |
|--------------|-------------|----------|
| `"Has Item"` | `"In Inventory Of"` | Character/shop inventory |

## Item Metadata Defaults

When creating inventory items via relation metadata:

| Field | Default | Notes |
|-------|---------|-------|
| `quantity` | 1 | |
| `equipped` | false | |
| `in_stock` | true | For shop items |
| Foundry item type | `"equipment"` | May not match all systems |

## Sync Direction Values

| Value | Pull (Chronicle→Foundry) | Push (Foundry→Chronicle) |
|-------|--------------------------|--------------------------|
| `"both"` | Yes | Yes |
| `"pull"` | Yes | No |
| `"push"` | No | Yes |
| `"off"` | No | No |
