# Chronicle Sync — Constants & Magic Values

Reference for all hardcoded values, thresholds, and behavioral constants in the
module. Useful when debugging sync behavior or tuning performance.

---

## Timing & Debounce

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| Token position debounce | 100ms | `map-sync.mjs:904` | Batches rapid token drags into single API call |
| Status dot activity flash | 300ms | `module.mjs:150` | Brief white flash on WS message |
| WS initial reconnect delay | 1000ms | `api-client.mjs:28` | First reconnect attempt delay |
| WS max reconnect delay | 30000ms | `api-client.mjs:528` | Cap on exponential backoff |
| WS backoff multiplier | 2x | `api-client.mjs:536` | Delay doubles each attempt |

## Queue & Cache Limits

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| Message queue cap | 100 | `api-client.mjs:408` | Max buffered WS messages while disconnected |
| Retry queue cap | 50 | `api-client.mjs:234` | Max failed REST operations to retry on reconnect |
| Retry max attempts | 3 | `api-client.mjs:234` | Per-operation retry limit |
| Activity log max | 100 | `sync-manager.mjs:43` | Dashboard activity log entries |
| Error log max | 50 | `api-client.mjs:66` | Dashboard error log entries |
| Error message truncation | 200 chars | `api-client.mjs:322` | Truncated with `…` |
| Entity pagination | 100/page, 5 pages | `sync-dashboard.mjs:215` | Max 500 entities loaded |

## Coordinate Systems

The module converts between two coordinate systems:

| System | Range | Used by |
|--------|-------|---------|
| **Pixel** | 0 to canvas width/height | Foundry scenes |
| **Percentage** | 0–100 | Chronicle API |

Conversion: `percentage = (pixel / sceneDimension) * 100`

Applies to: drawings, tokens, fog regions, polygon points.

## Fog Detection Heuristics

When converting Foundry drawings to Chronicle fog regions:

| Heuristic | Threshold | Location | Purpose |
|-----------|-----------|----------|---------|
| Dark color luminance | < 0.15 | `map-sync.mjs:798` | Identifies fog-like fill colors |
| Fill alpha (fog threshold) | >= 0.5 | `map-sync.mjs:766` | Minimum opacity for fog detection |
| Explored vs unexplored | opacity < 0.9 | `map-sync.mjs:869` | Semi-transparent = explored |

## Permission Mapping

### Chronicle → Foundry

| Chronicle `visibility` | Chronicle `is_private` | Foundry default ownership |
|------------------------|----------------------|---------------------------|
| any | `true` | `NONE` (0) |
| `"default"` | `false` | `OBSERVER` (2) |
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

## Calendar Indexing

| Calendar Module | Month indexing | Day indexing |
|----------------|---------------|-------------|
| Chronicle API | 1-indexed | 1-indexed |
| Calendaria | 1-indexed | 1-indexed |
| SimpleCalendar | **0-indexed** | **0-indexed** |

The module adds/subtracts 1 when converting between SimpleCalendar and Chronicle.

## System Matching

### Fallback Map (used when API fails)

```javascript
SYSTEM_MAP_FALLBACK = {
  'dnd5e': 'dnd5e',
  'pf2e': 'pathfinder2e',
  'draw-steel': 'drawsteel',
}
```

### Actor Type by System

| System | Foundry `actor.type` |
|--------|---------------------|
| D&D 5e | `"character"` |
| Pathfinder 2e | `"character"` |
| Draw Steel | `"hero"` |
| Generic | Via `foundry_actor_type` in system manifest |

## Drawing Type Codes

| Foundry code | Chronicle type |
|-------------|---------------|
| `"f"` | `"freehand"` |
| `"r"` | `"rectangle"` |
| `"e"` | `"ellipse"` |
| `"p"` | `"polygon"` |
| `"t"` | `"text"` |

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
