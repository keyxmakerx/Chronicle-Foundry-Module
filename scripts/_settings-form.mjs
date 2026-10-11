/**
 * What the Chronicle settings window writes when the GM presses Save. Pure,
 * so the rules are tested without Foundry (tools/test-settings-form.mjs):
 *   - a pasted connect line wins over the typed connection fields;
 *   - a blank API key field keeps the saved key, so the key is never shown;
 *   - a part switched off is stored as direction "off", and the older
 *     per-part toggles follow the directions, as the dashboard has always done;
 *   - only values that changed are written.
 */

/** Parts of the world that sync, in the order the window lists them. */
export const SYNC_PARTS = ['journals', 'maps', 'calendar', 'characters', 'shops'];

/** Legacy per-part toggles kept in step with the directions. */
const PART_TOGGLES = { journals: 'syncJournals', maps: 'syncMaps', calendar: 'syncCalendar', characters: 'syncCharacters' };

const DIRECTIONS = new Set(['both', 'pull', 'push']);
const CONFLICT = new Set(['chronicle', 'foundry', 'newest']);
const ANNOUNCE = ['calendarAnnounceWeather', 'calendarAnnounceWorldstate', 'calendarAnnounceSeasonEra', 'calendarAnnounceMoon'];
const FLAGS = ['syncEnabled', 'dmOnlyHidden', 'syncPermissions', 'autoSync', 'skipIncomingSanitization', ...ANNOUNCE];

/**
 * @param {object} form - values read from the window
 * @param {object} current - the saved settings, same keys as Foundry's
 * @returns {{ writes: Array<[string, any]>, connectLine: string, connectionChanged: boolean }}
 */
export function planSettingsSave(form, current) {
  const writes = [];
  const put = (key, value) => { if (!sameValue(current[key], value)) writes.push([key, value]); };

  const connectLine = String(form.connectLine ?? '').trim();
  let connectionChanged = false;
  if (!connectLine) {
    // A field the form didn't carry is left alone, never cleared.
    const before = writes.length;
    if (typeof form.apiUrl === 'string') put('apiUrl', form.apiUrl.trim());
    if (typeof form.campaignId === 'string') put('campaignId', form.campaignId.trim());
    const apiKey = String(form.apiKey ?? '').trim();
    if (apiKey) put('apiKey', apiKey);
    connectionChanged = writes.length > before;
  }

  for (const key of FLAGS) {
    if (typeof form[key] === 'boolean') put(key, form[key]);
  }

  const savedDirections = parseJson(current.syncDirections, {});
  const directions = { ...savedDirections };
  for (const part of SYNC_PARTS) {
    const on = form.parts?.[part]?.on;
    if (typeof on !== 'boolean') continue;
    const dir = form.parts[part].direction;
    const kept = DIRECTIONS.has(savedDirections[part]) ? savedDirections[part] : 'both';
    directions[part] = on ? (DIRECTIONS.has(dir) ? dir : kept) : 'off';
  }
  put('syncDirections', JSON.stringify(directions));
  for (const [part, key] of Object.entries(PART_TOGGLES)) {
    if (part in directions) put(key, directions[part] !== 'off');
  }

  if (form.defaultOwnership !== undefined) {
    const level = Math.trunc(Number(form.defaultOwnership));
    if (level >= 0 && level <= 3) put('defaultOwnership', level);
  }
  if (CONFLICT.has(form.conflictResolution)) put('conflictResolution', form.conflictResolution);
  if (typeof form.excludedTags === 'string') {
    const tags = form.excludedTags.split(',').map((t) => t.trim()).filter(Boolean);
    put('excludedTags', JSON.stringify(tags));
  }
  if (typeof form.excludedNamePattern === 'string') put('excludedNamePattern', form.excludedNamePattern.trim());

  return { writes, connectLine, connectionChanged };
}

/**
 * Settings as the window shows them, from the saved values.
 * @param {object} current
 */
export function settingsView(current) {
  const directions = parseJson(current.syncDirections, {});
  const tags = parseJson(current.excludedTags, []);
  return {
    apiUrl: current.apiUrl || '',
    campaignId: current.campaignId || '',
    hasKey: !!current.apiKey,
    syncEnabled: current.syncEnabled !== false,
    parts: SYNC_PARTS.map((part) => {
      const dir = directions[part] || 'both';
      return { part, on: dir !== 'off', direction: DIRECTIONS.has(dir) ? dir : 'both' };
    }),
    announce: Object.fromEntries(ANNOUNCE.map((k) => [k, !!current[k]])),
    defaultOwnership: Number.isInteger(current.defaultOwnership) ? current.defaultOwnership : 2,
    dmOnlyHidden: current.dmOnlyHidden !== false,
    syncPermissions: current.syncPermissions !== false,
    conflictResolution: CONFLICT.has(current.conflictResolution) ? current.conflictResolution : 'chronicle',
    autoSync: current.autoSync !== false,
    excludedTags: Array.isArray(tags) ? tags.join(', ') : '',
    excludedNamePattern: current.excludedNamePattern || '',
    skipIncomingSanitization: !!current.skipIncomingSanitization,
  };
}

/** Keys the window reads; the caller fetches each with game.settings.get. */
export const SETTINGS_KEYS = [
  'apiUrl', 'apiKey', 'campaignId', 'syncDirections', 'defaultOwnership', 'conflictResolution',
  'excludedTags', 'excludedNamePattern', ...FLAGS, ...Object.values(PART_TOGGLES),
];

function parseJson(raw, fallback) {
  if (typeof raw !== 'string') return raw ?? fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function sameValue(a, b) {
  return a === b || (a == null && b === '');
}
