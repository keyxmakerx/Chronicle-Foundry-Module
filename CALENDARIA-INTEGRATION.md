# Calendaria Integration Reference

A condensed, integration-focused reference for **Calendaria** (the Foundry VTT
calendar module this module syncs with). Written so contributors — human or AI —
don't have to guess at Calendaria's data model again. The exact behaviours that
caused calendar holidays to show up as Chronicle **Characters** are called out
under [Integration rules](#integration-rules-read-before-touching-journal-sync).

> **Source of truth.** All facts below were read directly from the upstream
> repo **[Sayshal/Calendaria](https://github.com/Sayshal/Calendaria)** at commit
> `2945dd2` (2026‑06‑14, `module.json` compatibility: Foundry v14, verified
> 14.364). When in doubt, re-read the cited files rather than this summary, and
> bump the commit ref when you do. Full user docs: the upstream README and the
> [Calendaria wiki](https://wiki.3deathsaves.com/calendaria/).

---

## TL;DR for sync code

- **Calendaria notes are Foundry `JournalEntry` documents.** Creating a note
  fires `createJournalEntry`. Any sync module that listens on that hook will see
  them.
- Each note JournalEntry is tagged **`flags.calendaria.isCalendarNote === true`**
  and lives in a **"Calendar Notes"** folder (per‑calendar subfolders).
- **Festivals/holidays are auto‑seeded as notes.** When a calendar defines
  `festivals`, Calendaria creates one note JournalEntry per festival
  (e.g. "Day of Rebirth", "Eve of the Dead"). These are ordinary calendar notes
  with an extra `linkedFestival` descriptor.
- ⇒ **Journal‑listening sync code MUST skip these documents.** This module does
  so via `isCalendarNoteJournal()` in `scripts/calendar-sync.mjs`. They are the
  domain of `CalendarSync` (mirrored to Chronicle *calendar events*), never of
  `JournalSync` (entities).

---

## Note storage model

| Aspect | Detail | Source |
|--------|--------|--------|
| Document type | `JournalEntry` + a `JournalEntryPage` of type `calendaria.calendarnote` | `notes/note-manager.mjs:379‑380`, `notes/note-data.mjs:63` |
| Folder | Root **"Calendar Notes"** folder, with a subfolder per calendar | `notes/note-manager.mjs` (`getCalendarFolder`, `:752`) |
| Module flag scope | `calendaria` (`MODULE.ID`) | `constants.mjs:3` |
| Note marker flag | `flags.calendaria.isCalendarNote === true` | `notes/note-manager.mjs:379` |
| Also stored on note | `flags.calendaria.calendarId` | `notes/note-manager.mjs:379` |

### Flags Calendaria writes

| Flag (under `flags.calendaria`) | On | Meaning |
|------|----|---------|
| `isCalendarNote` | JournalEntry | A calendar note (incl. festival notes) |
| `isCalendarJournal` | JournalEntry | A calendar **structure** journal; deletion is hard‑blocked |
| `isCalendarNotesFolder` | Folder | The root "Calendar Notes" folder; deletion blocked |
| `isCalendarFolder` | Folder | A per‑calendar subfolder; deletion blocked |
| `isCalendariumExport` | — | Marks Calendarium export data |
| `isDescriptionPage` | JournalEntryPage | The note's description page |

### Note page system data (`calendaria.calendarnote`)

From `notes/note-data.mjs`:

```
startDate:   { year, month, dayOfMonth, hour, minute }   // required
endDate:     { ... } | null
allDay:      boolean            // default false
repeat:      'never' | ...      // legacy; superseded by conditionTree
repeatInterval, repeatEndDate
displayStyle: 'icon' | 'pip' | 'banner'         // DISPLAY_STYLES, default 'icon'
visibility:   'visible' | 'hidden' | 'secret'   // NOTE_VISIBILITY
linkedFestival: { calendarId, festivalKey, countsForWeekday, leapYearOnly, leapDuration } | null
conditionTree: { type:'group', mode, children }  // recurrence engine (root must be a group)
```

`visibility` defaults to `hidden` when a GM creates the note, `visible` for a
player. Chronicle wire visibility maps via `chronicleVisibilityFromCalendariaNote()`
in `calendar-sync.mjs` (`hidden`/`secret` → `gm-only`, else `everyone`).

---

## Festival / holiday seeding (the bug mechanism)

`scripts/festivals/festival-manager.mjs`:

- `seedFestivalNotes(calendarId, calendar)` — runs **once per calendar** (guarded
  by the `SEEDED_CALENDARS` world setting). For every entry in
  `calendar.festivals`, it calls `createFestivalNote(...)`.
- `createFestivalNote(...)` → `NoteManager.createNote({ name, content, noteData, ... })`
  — i.e. festival holidays become **ordinary calendar notes** (JournalEntries
  with `isCalendarNote`), plus a `linkedFestival` descriptor on the page.
- Seeding is one‑shot: a deleted festival note is **not** re‑seeded unless the
  seed record is cleared (`clearSeedRecord`).

So a calendar like *"Calendar of Therin"* with festivals
("Day of Rebirth", "Eve of the Dead", "Haelyn's Day", "Night of Fire",
"Veneration of the Sleeping", …) produces that many note JournalEntries the
first time the calendar activates. Those are exactly the documents that were
mis‑filed as Chronicle Characters before the guard existed.

---

## Hooks

### Custom hooks Calendaria fires (`constants.mjs` `HOOKS`)

The ones this module consumes (in `calendar-sync.mjs`):

| Hook | When |
|------|------|
| `calendaria.dateTimeChange` | World date/time changed (full date+time payload) |
| `calendaria.noteCreated` | A note was created |
| `calendaria.noteUpdated` | A note was updated |
| `calendaria.noteDeleted` | A note was deleted |

Other custom hooks exist (`calendaria.calendarAdded/Removed/Switched/Updated`,
`calendaria.dayChange`, `calendaria.clockUpdate`, `calendaria.conditionEvaluated`,
cinematic hooks, …) — see `HOOKS` in upstream `constants.mjs`.

### Foundry document hooks Calendaria itself registers

Relevant overlap: Calendaria registers `createJournalEntry`,
`createJournalEntryPage`, `updateJournalEntry`, `updateJournalEntryPage`,
`preUpdateJournalEntryPage`, `deleteJournalEntry`, `deleteJournalEntryPage`,
`preDeleteJournalEntry`, `preDeleteFolder`. **This module's `JournalSync`,
`NoteSync`, and (SimpleCalendar) `CalendarSync` all share `createJournalEntry`
with Calendaria** — hence the need for strict domain ownership checks.

---

## `CALENDARIA.api` surface (used / useful)

From `scripts/api.mjs`. Notes API is used by `calendar-sync.mjs`:

- Notes: `createNote(...)`, `updateNote(id, ...)`, `deleteNote(id)`, `getNote(id)`
- Date/time: `getCurrentDateTime()`, `setDateTime(components)`, `advanceTime(delta)`, `jumpToDate({year,month,day})`
- Calendars: `getActiveCalendar()`, `getCalendar(id)`, `getAllCalendars()`, `switchCalendar(id)`, `setActiveCalendar(id)`, `addCalendar(id, def)`
- Moons: `getMoonPhase(i)`, `getAllMoonPhases()`, `isMoonFull(...)`, `getNextFullMoon(...)`, `getNextConvergence(...)`, `getEclipse(...)`
- Conversion: `convertDate(...)`, `getEquivalentDates(...)`, `getCurrentDateOn(id)`

> Calendaria uses a `yearZero` offset internally; the API exposes "public" dates
> (`toPublic`) — keep using the API, don't read raw stored dates.

---

## Delete protection (matters for cleanup)

`notes/note-manager.mjs` `onPreDeleteJournalEntry`:

- `isCalendarJournal` documents → deletion **always blocked** (unless dev mode or
  an internal bypass).
- Festival notes (`page.system.linkedFestival`) → deletion blocked **only for
  non‑GM users**. **A GM can delete a festival note.**

⚠️ **Consequence for Chronicle sync.** Chronicle sync runs as the GM. If a
mis‑synced festival entity is deleted on the Chronicle side while Foundry is
connected, the `entity.deleted` broadcast makes `JournalSync._onEntityDeleted`
delete the linked JournalEntry — and Calendaria does **not** block that for the
GM, so the festival note is permanently lost (no re‑seed). Always **unlink the
journal locally first** (drop its `chronicle-sync.entityId` flag) before deleting
the entity server‑side. See the cleanup macro below.

---

## Integration rules (read before touching journal sync)

1. **Never push a calendar note to `/entities`.** Calendar notes are
   JournalEntries; `JournalSync` must skip any journal where
   `isCalendarNoteJournal(journal)` is true (calendar‑module flags or our
   `calendarEventId` link). They sync as Chronicle **calendar events** via
   `CalendarSync`, not as entities. (Guarded; see `F-SYNC-1` in `.ai.md`.)
2. **`entity_type_id: 0` is a footgun.** The Chronicle API resolves it to the
   campaign's *first* entity type (`syncapi/api_handler.go` `CreateEntity`),
   almost always "Character". Anything pushed without an explicit type lands
   there. The wizard maps types deliberately; the realtime hook should not push
   ambiguous documents at all.
3. **Multiple modules share `createJournalEntry`.** Scope every journal hook
   handler to its own domain (flags/folder), the way `NoteSync._isNoteJournal`
   and the calendar guard do — don't assume "any new journal is mine".
4. **Cleanup must unlink before deleting** (see the delete‑protection note).

---

## One‑off cleanup macro (existing mis‑synced festival notes)

Run **as the GM**, in Foundry's script console (F12) or a Script macro, **once**.
It unlinks each calendar‑note journal that carries a bogus Chronicle entity link
(so deleting the entity can't cascade back and destroy your festival note), then
deletes that bogus entity in Chronicle. Real characters (Foundry Actors) are
never touched. Review the logged list afterwards.

```js
// Chronicle Sync — clean up calendar notes wrongly synced as entities.
const FLAG = 'chronicle-sync';
const api = game.modules.get(FLAG)?.api?.getAPI?.();
if (!api) { ui.notifications.error('Chronicle Sync API unavailable — is sync configured & connected?'); }
else {
  const isCalNote = (j) => {
    const f = j.flags ?? {};
    const cal = f.calendaria;
    if (cal && (cal.isCalendarNote === true || cal.isCalendarJournal === true)) return true;
    if (f['foundryvtt-simple-calendar'] || f['simple-calendar']) return true;
    return !!j.getFlag(FLAG, 'calendarEventId');
  };
  const targets = game.journal.contents.filter((j) => j.getFlag(FLAG, 'entityId') && isCalNote(j));
  const removed = [];
  for (const j of targets) {
    const entityId = j.getFlag(FLAG, 'entityId');
    // 1) Unlink locally FIRST so the entity.deleted broadcast can't cascade
    //    back and delete this calendar note.
    await j.unsetFlag(FLAG, 'entityId');
    await j.unsetFlag(FLAG, 'lastSync');
    await j.unsetFlag(FLAG, 'chronicleUpdatedAt');
    // 2) Delete the bogus entity in Chronicle.
    try { await api.delete(`/entities/${entityId}`); removed.push(`${j.name} (${entityId})`); }
    catch (e) { console.warn('Chronicle cleanup: failed to delete entity', entityId, e); }
  }
  console.log('Chronicle cleanup — unlinked & removed bogus entities:', removed);
  ui.notifications.info(`Chronicle: cleaned up ${removed.length} mis-synced calendar note(s). See console for the list.`);
}
```

If you'd rather delete the entities yourself in the Chronicle UI, run only the
unlink portion first (drop the `api.delete(...)` line) — that breaks the cascade
so the manual delete is safe — then delete them in Chronicle.
