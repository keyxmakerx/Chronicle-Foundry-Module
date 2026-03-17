# Chronicle Sync — Foundry VTT Module

Bidirectional real-time sync between [Chronicle](https://github.com/keyxmakerx/Chronicle) and Foundry VTT.

## Features

- **Journal Sync** — Chronicle entities ↔ Foundry journal entries (with multi-page splitting)
- **Map Sync** — Drawings, tokens, and fog of war
- **Calendar Sync** — Calendaria and Simple Calendar integration
- **Character Sync** — Actor ↔ character entity with system-aware field mapping (D&D 5e, Pathfinder 2e, or any system with annotated fields)
- **Shop Widget** — Browse and purchase from Chronicle shop entities in Foundry
- **Sync Dashboard** — 6-tab management UI with diagnostics, error logs, and health metrics
- **Permission Mapping** — Chronicle visibility ↔ Foundry ownership levels

## Compatibility

| Foundry VTT | Status |
|-------------|--------|
| v12         | Minimum supported |
| v13         | Verified |

## Installation

1. In Foundry VTT, go to **Add-on Modules → Install Module**
2. Paste the manifest URL:
   ```
   https://raw.githubusercontent.com/keyxmakerx/Chronicle-Foundry-Module/main/module.json
   ```
3. Click **Install**

## Configuration

1. Enable the module in your world's **Module Management**
2. Open **Game Settings → Module Settings → Chronicle Sync**
3. Enter your Chronicle **API URL**, **API Key**, and **Campaign ID**
4. Enable the sync categories you want (Journals, Maps, Calendar, Characters)

The module runs sync for the GM only. Players receive updates passively through Foundry.

## Optional Modules

- [Monk's Enhanced Journal](https://foundryvtt.com/packages/monks-enhanced-journal) — Enhanced journal page support
- [Calendaria](https://foundryvtt.com/packages/calendaria) — Calendar sync
- [Simple Calendar](https://foundryvtt.com/packages/foundryvtt-simple-calendar) — Calendar sync (alternative)

## License

MIT
