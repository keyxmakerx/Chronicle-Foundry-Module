/**
 * Pure helpers for the DM Screen window (scripts/dm-screen.mjs).
 *
 * Chronicle sends the screen as JSON (GET /dm-screen, the same view its own
 * panel draws); these turn it into what the template shows, so the window
 * folds heroes and words things exactly as the site does. Every field is
 * read defensively: an older or newer Chronicle may leave sections out.
 * tools/test-dm-screen-view.mjs pins them.
 */

const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (Number.isFinite(v) ? v : 0);
const list = (v) => (Array.isArray(v) ? v : []);

/** "1 request" / "3 requests". */
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function meter(m) {
  return {
    label: str(m?.label),
    current: str(m?.current),
    max: str(m?.max),
    hasMax: m?.has_max === true,
    percent: Math.max(0, Math.min(100, Math.round(num(m?.percent)))),
    low: m?.low === true,
  };
}

/**
 * Split a hero's meters for the folded row, as Chronicle's HeroView.Folded
 * does: the first meter with a max is the bar, every meter without a max is
 * a chip, and the rest fold open.
 */
export function foldHero(hero) {
  let bar = null;
  const chips = [];
  const rest = [];
  for (const m of list(hero?.meters).map(meter)) {
    if (!m.hasMax) chips.push(m);
    else if (!bar) bar = m;
    else rest.push(m);
  }
  const conditions = list(hero?.conditions).filter((c) => typeof c === 'string' && c);
  return {
    id: str(hero?.id),
    name: str(hero?.name),
    subtitle: str(hero?.subtitle),
    playerName: str(hero?.player_name),
    conditions,
    conditionList: conditions.join(', '),
    showWho: !!(str(hero?.subtitle) || str(hero?.player_name)),
    bar,
    chips,
    rest,
  };
}

/** A Chronicle page URL, from the configured API base. */
function siteUrl(apiUrl, path) {
  const base = str(apiUrl).replace(/\/+$/, '');
  return base ? `${base}${path}` : '';
}

/**
 * Build the template context from Chronicle's view.
 * @param {object} view - GET /dm-screen body
 * @param {{apiUrl: string}} opts
 */
export function screenContext(view, { apiUrl } = {}) {
  const v = view && typeof view === 'object' ? view : {};
  const campaign = encodeURIComponent(str(v.campaign_id));

  let night = null;
  if (v.night && typeof v.night === 'object') {
    night = {
      name: str(v.night.name),
      when: str(v.night.when),
      tally: `${num(v.night.going)} coming · ${num(v.night.maybe)} maybe · ${num(v.night.no_answer)} no answer`,
    };
  }

  let downtime = null;
  if (v.downtime && typeof v.downtime === 'object') {
    const open = v.downtime.open === true;
    const canToggle = v.downtime.can_toggle === true;
    const pending = num(v.downtime.pending);
    downtime = {
      open,
      canToggle,
      note: open ? 'Moves happen at once. Shops are open.' : 'Moves need your OK. Shops are closed.',
      pending: pending > 0 ? `${plural(pending, 'request', 'requests')} waiting on you` : '',
      pendingUrl: siteUrl(apiUrl, `/campaigns/${campaign}/armory/stashes`),
      // Switching asks first: starting downtime puts every waiting request
      // through at once, and neither switch can be taken back cleanly.
      confirm: open
        ? { text: 'End downtime? Moves will need your OK again and shops close.', yes: 'End downtime' }
        : {
          text: pending > 0
            ? `Start downtime? ${plural(pending, 'waiting request goes', 'waiting requests go')} through now and shops open.`
            : 'Start downtime? Moves will happen at once and shops open.',
          yes: 'Start downtime',
        },
    };
  }

  let world = null;
  if (v.world && typeof v.world === 'object') {
    const time = str(v.world.time_label);
    world = {
      date: str(v.world.date_label) + (time ? ` · ${time}` : ''),
      weather: str(v.world.weather),
      calendarUrl: siteUrl(apiUrl, `/campaigns/${campaign}/calendars/${encodeURIComponent(str(v.world.calendar_id))}`),
    };
  }

  const party = list(v.party).map(foldHero);
  const conditions = list(v.conditions)
    .map((c) => ({ name: str(c?.name), text: str(c?.text) }))
    .filter((c) => c.name);
  const hidden = list(v.hidden)
    .map((h) => ({ id: str(h?.id), name: str(h?.name), revealed: h?.revealed === true }))
    .filter((h) => h.id);
  const systemName = str(v.system_name);

  let partyNote = '';
  if (party.length && v.party_filled !== true) {
    partyNote = systemName
      ? `${systemName} doesn't fill in hero numbers yet.`
      : 'Turn on a game system to see each hero\'s numbers here.';
  }

  return {
    night,
    downtime,
    world,
    worldEmpty: !downtime && !world,
    party,
    partyNote,
    conditions,
    hasRules: conditions.length > 0,
    hidden,
  };
}

/**
 * The lang key (under CHRONICLE.DMScreen.Error) for a failed load. A 404 is
 * a Chronicle without the DM Screen; it must be updated.
 */
export function errorKey(err) {
  switch (err?.status) {
    case 404: return 'NeedsUpdate';
    case 401: return 'BadKey';
    case 403: return 'NotAllowed';
    default: return 'Failed';
  }
}
