# Chronicle Sync — Foundry VTT Module

This repo contains the **Chronicle Sync** module for Foundry VTT. It provides
bidirectional real-time sync between a [Chronicle](https://github.com/keyxmakerx/Chronicle)
worldbuilding instance and a Foundry VTT game world.

## Architecture

See `.ai.md` for full architecture, data flow, file index, and feature details.

Entry point: `scripts/module.mjs` → registers settings on `init`, starts
`SyncManager` on `ready` (GM only).

## File Structure

```
module.json           # Foundry module manifest (v12–v13)
scripts/              # ES modules (.mjs)
  module.mjs          # Entry point
  settings.mjs        # World settings registration
  sync-manager.mjs    # Orchestrator, API routing, WS management
  api-client.mjs      # REST + WebSocket client
  journal-sync.mjs    # Entity ↔ JournalEntry sync
  map-sync.mjs        # Map drawings/tokens/fog sync
  calendar-sync.mjs   # Calendar adapter (Calendaria/SimpleCalendar)
  actor-sync.mjs      # Character entity ↔ Actor sync
  item-sync.mjs       # Item sync
  note-sync.mjs       # Chronicle Notes ↔ JournalEntry sync
  constants.mjs       # Shared constants (FLAG_SCOPE, MODULE_ID)
  shop-widget.mjs     # Shop inventory UI
  sync-dashboard.mjs  # 6-tab dashboard UI
  adapters/           # Game system field mappers
    dnd5e-adapter.mjs
    pf2e-adapter.mjs
    generic-adapter.mjs
templates/            # Handlebars templates
styles/               # CSS
lang/                 # Localization (en.json)
```

## API Contract

See **API-CONTRACT.md** for the full Chronicle REST API and WebSocket contract
with request/response schemas, authentication, and CORS requirements.

## Code Conventions

- **ES modules** (`.mjs`) with `export default class` pattern.
- Sync modules use a `_syncing` boolean guard to prevent infinite loops.
- System adapters implement `toChronicleFields()` / `fromChronicleFields()`.
- All REST calls use Bearer token auth via `api-client.mjs`.
- WebSocket messages are routed by type through `SyncManager`.

## TODO

- (none currently)
