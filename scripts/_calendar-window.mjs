/**
 * Chronicle Sync - the calendar window's first size (pure, so
 * tools/test-calendar-window.mjs can pin it off-DOM).
 */

/**
 * A first-time window fills most of the screen, so the month grid has room:
 * Chronicle's calendar page is laid out for a browser tab, not a dialog.
 */
export function calendarWindowSize(viewW, viewH) {
  const fit = (view, want, least) => Math.round(Math.max(least, Math.min(want, (Number(view) || 0) - 80)));
  return { width: fit(viewW, 1180, 760), height: fit(viewH, 880, 640) };
}
