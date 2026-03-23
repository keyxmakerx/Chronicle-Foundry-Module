# Chronicle API — Calendar Feature Parity Request

This document describes the Chronicle API additions needed to achieve full
feature parity with **Calendaria** (the primary Foundry VTT calendar module).
Each section maps a Calendaria feature to the Chronicle API endpoints or fields
required to support it.

Reference: [Calendaria Documentation](https://github.com/Sayshal/Calendaria/tree/main/docs)

---

## Table of Contents

- [Currently Supported](#currently-supported)
- [1. Seasons](#1-seasons)
- [2. Moon Phases](#2-moon-phases)
- [3. Weather System](#3-weather-system)
- [4. Calendar Structure](#4-calendar-structure)
- [5. Calendar Events — Extended Fields](#5-calendar-events--extended-fields)
- [6. Eras and Cycles](#6-eras-and-cycles)
- [7. Festivals and Rest Days](#7-festivals-and-rest-days)
- [8. WebSocket Messages — New Types](#8-websocket-messages--new-types)
- [Priority Summary](#priority-summary)

---

## Currently Supported

The Chronicle API already supports these calendar features:

| Feature | Endpoint | Status |
|---------|----------|--------|
| Current date (year/month/day) | `GET /calendar` | Working |
| Current time (hour/minute) | `GET /calendar` | Working |
| Set date/time | `PUT /calendar/date` | Working |
| Calendar events CRUD | `POST/PUT/DELETE /calendar/events` | Working |
| Event name, date, description | Event body fields | Working |
| Event visibility | `visibility` field | Working |

The Foundry module currently syncs all of the above bidirectionally with both
Calendaria and SimpleCalendar.

---

## 1. Seasons

**Calendaria feature:** Configurable seasons with names, date ranges, colors,
icons, and temperature modifiers. The `calendaria.seasonChange` hook fires when
the in-game date crosses a season boundary.

**What Chronicle needs:**

### GET /calendar/seasons

Fetch all season definitions for the campaign calendar.

```json
[
  {
    "id": "season_001",
    "name": "Winter",
    "start_month": 12,
    "start_day": 1,
    "end_month": 2,
    "end_day": 28,
    "color": "#a0c4ff",
    "icon": "snowflake",
    "sort_order": 0,
    "description": "The cold months of Deepwinter"
  }
]
```

### PUT /calendar/seasons (bulk update)

Set/replace all season definitions.

### GET /calendar — additional fields

Add `current_season` to the calendar state response:

```json
{
  "current_year": 1492,
  "current_month": 1,
  "current_day": 15,
  "current_hour": 14,
  "current_minute": 30,
  "current_season": {
    "id": "season_001",
    "name": "Winter",
    "color": "#a0c4ff",
    "icon": "snowflake"
  }
}
```

### WebSocket: `calendar.season.changed`

```json
{
  "type": "calendar.season.changed",
  "payload": {
    "id": "season_002",
    "name": "Spring",
    "color": "#77dd77",
    "icon": "leaf"
  }
}
```

---

## 2. Moon Phases

**Calendaria feature:** Multiple configurable moons with independent cycle
lengths, phase names/icons, reference dates for phase calculation, brightness
effects on scene darkness, and moon-phase-based note recurrence.

**What Chronicle needs:**

### GET /calendar/moons

Fetch moon definitions.

```json
[
  {
    "id": "moon_001",
    "name": "Selûne",
    "cycle_length": 30,
    "color": "#c0c0ff",
    "reference_year": 1492,
    "reference_month": 1,
    "reference_day": 1,
    "reference_phase": 0,
    "brightness_max": 0.2,
    "phases": [
      {
        "name": "New Moon",
        "icon": "circle-dot",
        "position_start": 0,
        "position_end": 0.125
      },
      {
        "name": "Waxing Crescent",
        "icon": "moon-waxing-crescent",
        "position_start": 0.125,
        "position_end": 0.25
      },
      {
        "name": "First Quarter",
        "icon": "moon-first-quarter",
        "position_start": 0.25,
        "position_end": 0.375
      },
      {
        "name": "Waxing Gibbous",
        "icon": "moon-waxing-gibbous",
        "position_start": 0.375,
        "position_end": 0.5
      },
      {
        "name": "Full Moon",
        "icon": "moon",
        "position_start": 0.5,
        "position_end": 0.625
      },
      {
        "name": "Waning Gibbous",
        "icon": "moon-waning-gibbous",
        "position_start": 0.625,
        "position_end": 0.75
      },
      {
        "name": "Last Quarter",
        "icon": "moon-last-quarter",
        "position_start": 0.75,
        "position_end": 0.875
      },
      {
        "name": "Waning Crescent",
        "icon": "moon-waning-crescent",
        "position_start": 0.875,
        "position_end": 1.0
      }
    ]
  }
]
```

### GET /calendar — additional fields

Add `current_moon_phases` to the calendar state:

```json
{
  "current_moon_phases": [
    {
      "moon_id": "moon_001",
      "moon_name": "Selûne",
      "phase_name": "Full Moon",
      "phase_position": 0.5,
      "phase_icon": "moon"
    }
  ]
}
```

### PUT /calendar/moons (bulk update)

Set/replace moon definitions.

### WebSocket: `calendar.moon.phase_changed`

```json
{
  "type": "calendar.moon.phase_changed",
  "payload": {
    "moon_id": "moon_001",
    "moon_name": "Selûne",
    "phase_name": "Waning Gibbous",
    "phase_position": 0.65
  }
}
```

---

## 3. Weather System

**Calendaria feature:** Procedural weather generation with 7 climate zone
templates, 42 built-in weather presets, temperature modeling (stored in Celsius),
wind speed/direction (6-tier scale, 16-point compass), 5 precipitation types
with intensity scaling, weather inertia/persistence, multi-day forecast planning,
forecast variance/accuracy, per-zone weather history, and scene darkness effects.

This is the largest feature gap. A minimal viable implementation would cover
current weather state and manual weather setting. Full parity would add
forecasts, zones, and history.

**What Chronicle needs:**

### Minimal: GET /calendar/weather

Current weather state for the campaign.

```json
{
  "preset_id": "rain",
  "preset_label": "Rain",
  "icon": "cloud-rain",
  "color": "#6b9bd2",
  "temperature_celsius": 12,
  "temperature_display": "54°F",
  "wind": {
    "speed_kph": 25,
    "speed_tier": "moderate",
    "direction": "NW",
    "direction_degrees": 315
  },
  "precipitation": {
    "type": "rain",
    "intensity": 0.6
  },
  "zone_id": "temperate",
  "zone_name": "Temperate",
  "description": "Steady rainfall with moderate winds from the northwest"
}
```

### Minimal: PUT /calendar/weather

Set current weather (GM override).

```json
{
  "preset_id": "thunderstorm",
  "temperature_celsius": 18,
  "wind": {
    "speed_kph": 60,
    "direction": "S"
  },
  "description": "A violent thunderstorm rolls in"
}
```

### Full: GET /calendar/weather/zones

Climate zone definitions.

```json
[
  {
    "id": "temperate",
    "name": "Temperate",
    "temp_min_celsius": -5,
    "temp_max_celsius": 30,
    "sunrise_hour": 6.5,
    "sunset_hour": 18.5,
    "enabled_presets": ["clear", "partly_cloudy", "cloudy", "rain", "thunderstorm", "snow"]
  }
]
```

### Full: GET /calendar/weather/forecast

Forecast for upcoming days.

```json
[
  {
    "year": 1492,
    "month": 3,
    "day": 16,
    "preset_id": "partly_cloudy",
    "temperature_celsius": 15,
    "wind": { "speed_kph": 10, "direction": "E" },
    "precipitation": null
  }
]
```

### Full: GET /calendar/weather/history

Historical weather records.

### WebSocket: `calendar.weather.changed`

```json
{
  "type": "calendar.weather.changed",
  "payload": {
    "preset_id": "rain",
    "preset_label": "Rain",
    "temperature_celsius": 12,
    "wind": { "speed_kph": 25, "direction": "NW" },
    "precipitation": { "type": "rain", "intensity": 0.6 },
    "zone_id": "temperate"
  }
}
```

---

## 4. Calendar Structure

**Calendaria feature:** Fully configurable calendar structures with custom
months (names, day counts, intercalary months), weekdays, hours per day,
minutes per hour, leap year rules, and 15+ preset calendars (Forgotten Realms,
Greyhawk, Eberron, Exandria, Golarion, etc.).

**What Chronicle needs:**

### GET /calendar/structure

Return the campaign's calendar structure definition.

```json
{
  "id": "forgotten_realms",
  "name": "Calendar of Harptos",
  "hours_per_day": 24,
  "minutes_per_hour": 60,
  "months": [
    {
      "id": 1,
      "name": "Hammer",
      "abbreviation": "Ham",
      "days": 30,
      "intercalary": false
    },
    {
      "id": 2,
      "name": "Midwinter",
      "abbreviation": "Mid",
      "days": 1,
      "intercalary": true
    }
  ],
  "weekdays": [
    { "index": 0, "name": "First Day", "abbreviation": "1st", "is_rest_day": false },
    { "index": 1, "name": "Second Day", "abbreviation": "2nd", "is_rest_day": false },
    { "index": 9, "name": "Tenth Day", "abbreviation": "10th", "is_rest_day": true }
  ],
  "leap_year": {
    "rule": "every_4_years",
    "month_id": 2,
    "extra_days": 1
  },
  "year_zero": 0,
  "epoch_name": "Dale Reckoning"
}
```

### PUT /calendar/structure (GM only)

Update the calendar structure. This would be a rare operation (campaign setup).

---

## 5. Calendar Events — Extended Fields

**Calendaria feature:** Events/notes support recurrence patterns (daily, weekly,
monthly, yearly, moon-phase-based, seasonal, random, linked, computed),
categories, custom icons/colors, multi-day spans, reminders, macro triggers,
scene activation, and playlist triggers.

**What Chronicle needs on existing event endpoints:**

### Extended event fields for POST/PUT /calendar/events

```json
{
  "name": "Festival of the Moon",
  "year": 1492,
  "month": 11,
  "day": 30,
  "hour": 0,
  "minute": 0,
  "description": "Annual celebration",
  "visibility": "everyone",
  "end_year": 1492,
  "end_month": 12,
  "end_day": 1,
  "end_hour": 23,
  "end_minute": 59,
  "all_day": true,
  "color": "#ffd700",
  "icon": "star",
  "category": "festival",
  "recurrence": {
    "pattern": "yearly",
    "interval": 1,
    "end_date": null,
    "max_occurrences": null
  }
}
```

### GET /calendar/event-categories

```json
[
  { "id": "holiday", "name": "Holiday", "color": "#ff6b6b", "icon": "gift" },
  { "id": "festival", "name": "Festival", "color": "#ffd700", "icon": "star" },
  { "id": "quest", "name": "Quest", "color": "#4ecdc4", "icon": "scroll" },
  { "id": "session", "name": "Session", "color": "#95e1d3", "icon": "dice-d20" },
  { "id": "combat", "name": "Combat", "color": "#ff6348", "icon": "swords" },
  { "id": "birthday", "name": "Birthday", "color": "#ff9ff3", "icon": "cake" },
  { "id": "reminder", "name": "Reminder", "color": "#48dbfb", "icon": "bell" }
]
```

---

## 6. Eras and Cycles

**Calendaria feature:** Named eras with start/end dates (e.g., "Age of Humanity",
"Dale Reckoning"), zodiac/elemental cycles that change periodically, and
canonical hours (liturgical time divisions).

**What Chronicle needs:**

### GET /calendar/eras

```json
[
  {
    "id": "era_001",
    "name": "Dale Reckoning",
    "abbreviation": "DR",
    "start_year": 1,
    "end_year": null,
    "description": "The common calendar dating system of the Forgotten Realms"
  }
]
```

### GET /calendar/cycles

```json
[
  {
    "id": "cycle_001",
    "name": "Zodiac",
    "entries": [
      { "name": "The Warrior", "icon": "shield", "year_offset": 0 },
      { "name": "The Mage", "icon": "hat-wizard", "year_offset": 1 }
    ],
    "cycle_length": 12,
    "type": "yearly"
  }
]
```

---

## 7. Festivals and Rest Days

**Calendaria feature:** Named festivals on specific dates (not recurring events
— fixed calendar entries), and rest day designation on specific weekdays.

These could be included in the calendar structure (Section 4) or as separate
endpoints.

### GET /calendar/festivals

```json
[
  {
    "id": "fest_001",
    "name": "Midsummer",
    "month": 7,
    "day": null,
    "after_month": 7,
    "description": "The grand festival between Flamerule and Eleasis"
  }
]
```

---

## 8. WebSocket Messages — New Types

Summary of all new WS message types needed:

| Message Type | Payload | Trigger |
|---|---|---|
| `calendar.season.changed` | `{ id, name, color, icon }` | Date crosses season boundary |
| `calendar.moon.phase_changed` | `{ moon_id, moon_name, phase_name, phase_position }` | Moon phase changes |
| `calendar.weather.changed` | `{ preset_id, temperature_celsius, wind, precipitation, zone_id }` | Weather set or generated |
| `calendar.structure.updated` | `{ calendar_id }` | Calendar structure modified |
| `calendar.era.changed` | `{ id, name, abbreviation }` | Date crosses era boundary |

---

## Priority Summary

Ordered by impact and implementation complexity:

### High Priority (enables core Calendaria features)

1. **Seasons** — Small data model, high user visibility. Season names/colors
   appear in Calendaria's HUD, BigCal, and notes. Without this, Calendaria's
   season indicator shows nothing from Chronicle.

2. **Moon Phases** — Moon definitions enable the Calendaria dome display, moon
   icons on calendar dates, and moon-phase-based note recurrence. Requires a
   simple cycle calculation (modulo arithmetic).

3. **Calendar Events Extended Fields** — Adding `end_date`, `all_day`, `color`,
   `icon`, `category`, and `recurrence` to events enables full round-trip of
   Calendaria notes. Without these, notes lose metadata on sync.

### Medium Priority (enhances experience)

4. **Weather (Minimal)** — Current weather state + manual set. Enables the
   Foundry module to display/control weather through Chronicle's web UI and
   sync it to Calendaria's weather system.

5. **Calendar Structure** — Enables Chronicle to define custom calendars that
   Calendaria can import. Lower priority because most GMs set up their calendar
   in Calendaria directly.

6. **Eras and Cycles** — Enriches the timeline but doesn't block core
   functionality.

### Lower Priority (nice-to-have)

7. **Festivals and Rest Days** — Could be modeled as recurring events instead.

8. **Weather (Full)** — Forecast, zones, history. Complex implementation with
   limited Chronicle web UI benefit.

---

## Calendaria API Reference

For implementation reference, Calendaria exposes its full API at
`CALENDARIA.api`. Key methods the Foundry module would use to sync these new
features:

| Method | Purpose |
|---|---|
| `getCurrentDateTime()` | Get full date/time with year, month, day, hour, minute |
| `setDateTime(components)` | Set date/time (GM only) |
| `getCurrentSeason()` | Get current season object |
| `getMoonPhase(index)` | Get current phase of specific moon |
| `getAllMoonPhases()` | Get phases for all moons |
| `getCurrentWeather(zoneId)` | Get current weather state |
| `setWeather(presetId, options)` | Set weather by preset (GM only) |
| `getWeatherForecast(options)` | Get forecast for upcoming days |
| `createNote(options)` | Create calendar note with full metadata |
| `updateNote(pageId, updates)` | Update existing note |
| `deleteNote(pageId)` | Delete note |
| `getNotesForDate(y, m, d)` | Get notes on specific date |
| `formatDate(components, format)` | Format date as string |

Hooks the Foundry module listens to:

| Hook | Fires When |
|---|---|
| `calendaria.dateTimeChange` | Any world time change (includes full date+time) |
| `calendaria.dayChange` | Day boundary crossed |
| `calendaria.seasonChange` | Season boundary crossed |
| `calendaria.moonPhaseChange` | Any moon phase changes |
| `calendaria.weatherChange` | Weather changes |
| `calendaria.noteCreated` | Calendar note created |
| `calendaria.noteUpdated` | Calendar note updated |
| `calendaria.noteDeleted` | Calendar note deleted |
