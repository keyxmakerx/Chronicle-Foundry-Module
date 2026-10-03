/**
 * How a Chronicle map looks, resolved for the module's viewer: the frame
 * around it, the pin shape, size and name display, and each marker's icon.
 *
 * Chronicle stores per-map choices in the map row's `display_settings`
 * (absent means "follow the campaign"); the campaign frame and the icon
 * catalog come from `GET /maps/look`. Everything here is a closed set: a
 * value Chronicle may add later, or anything malformed, falls back to the
 * default rather than reaching the DOM.
 */

/** Chronicle's frames, in its gallery order; the first is the default. */
export const FRAMES = Object.freeze(['atlas', 'arcane', 'old', 'modern', 'futuristic', 'gilded']);
export const DEFAULT_FRAME = 'atlas';

const PIN_STYLES = ['drop', 'seal', 'flag', 'dot'];
const PIN_SIZES = ['s', 'm', 'l'];
const PIN_LABELS = ['always', 'hover', 'never'];

/** Chronicle's fallback icon for a marker with none, or one it doesn't know. */
export const DEFAULT_MARKER_ICON = 'fa-map-pin';

/**
 * Parse `display_settings` as it arrives: an object, its JSON string, or
 * nothing.
 * @param {*} raw
 * @returns {object}
 * @private
 */
function _parseDisplay(raw) {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return {}; }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function _oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

/**
 * Resolve a map's look. Mirrors Chronicle's `ResolveDisplay`: a map's own
 * frame wins, else the campaign's; tint is on unless the map turned it off.
 * @param {*} displaySettings the map row's `display_settings`
 * @param {string} [campaignFrame] from `GET /maps/look`
 * @returns {{ frame: string, tint: boolean, pinStyle: string, pinSize: string, pinLabels: string }}
 */
export function resolveMapLook(displaySettings, campaignFrame) {
  const d = _parseDisplay(displaySettings);
  const frame = d.frame && typeof d.frame === 'object' ? d.frame : {};
  const pins = d.pins && typeof d.pins === 'object' ? d.pins : {};
  const campaign = _oneOf(campaignFrame, FRAMES, DEFAULT_FRAME);
  return {
    frame: _oneOf(frame.style, FRAMES, campaign),
    tint: frame.tint !== false,
    pinStyle: _oneOf(pins.style, PIN_STYLES, 'drop'),
    pinSize: _oneOf(pins.size, PIN_SIZES, 'm'),
    pinLabels: _oneOf(pins.labels, PIN_LABELS, 'hover'),
  };
}

/**
 * Re-check a look read back from page flags (anyone with write access to
 * the page could have edited it) against the same closed sets.
 * @param {*} look a `resolveMapLook` result, or nothing
 */
export function sanitizeLook(look) {
  const l = look && typeof look === 'object' ? look : {};
  return {
    frame: _oneOf(l.frame, FRAMES, DEFAULT_FRAME),
    tint: l.tint !== false,
    pinStyle: _oneOf(l.pinStyle, PIN_STYLES, 'drop'),
    pinSize: _oneOf(l.pinSize, PIN_SIZES, 'm'),
    pinLabels: _oneOf(l.pinLabels, PIN_LABELS, 'hover'),
  };
}

/**
 * The Font Awesome class to draw for a marker. Chronicle's catalog is the
 * contract (`icons` from `GET /maps/look`); without it, any well-formed
 * `fa-` class is accepted, since Foundry ships the full icon set.
 * @param {*} icon the marker's `icon`
 * @param {Set<string>|null} [catalog] canonical icon ids, when known
 * @returns {string}
 */
export function markerIconClass(icon, catalog = null) {
  if (typeof icon !== 'string' || !/^fa-[a-z0-9-]{1,40}$/.test(icon)) return DEFAULT_MARKER_ICON;
  if (catalog && catalog.size && !catalog.has(icon)) return DEFAULT_MARKER_ICON;
  return icon;
}

/**
 * Normalise the `GET /maps/look` answer into what the sync stores. Returns
 * null for anything that isn't the expected object (an older Chronicle
 * answers 404), so callers keep their defaults.
 * @param {*} resp
 * @returns {{ campaignFrame: string, icons: string[], iconCatalog: {id: string, label: string, category: string}[] }|null}
 */
export function parseMapLook(resp) {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return null;
  const iconCatalog = Array.isArray(resp.icons)
    ? resp.icons
      .filter((i) => typeof i?.id === 'string' && /^fa-[a-z0-9-]{1,40}$/.test(i.id))
      .map((i) => ({
        id: i.id,
        label: _shortText(i.label) || i.id.slice(3),
        category: _shortText(i.category) || 'Other',
      }))
    : [];
  return {
    campaignFrame: _oneOf(resp.campaign_frame, FRAMES, DEFAULT_FRAME),
    icons: iconCatalog.map((i) => i.id),
    iconCatalog,
  };
}

/** A label from Chronicle, trimmed and capped; '' when not a string. */
function _shortText(v) {
  return typeof v === 'string' ? v.trim().slice(0, 40) : '';
}

/**
 * Chronicle's icon catalog grouped for the marker window's picker, in
 * Chronicle's own order (groups by first appearance).
 * @param {{id: string, label: string, category: string}[]} catalog
 * @returns {{category: string, icons: {id: string, label: string}[]}[]}
 */
export function groupIconCatalog(catalog) {
  const groups = new Map();
  for (const i of catalog || []) {
    if (!groups.has(i.category)) groups.set(i.category, []);
    groups.get(i.category).push({ id: i.id, label: i.label });
  }
  return Array.from(groups, ([category, icons]) => ({ category, icons }));
}

/**
 * The picture to show for a map in the sync window: the page's own picture,
 * which for a shadowed map is the stored player copy. A Foundry-relative
 * path is used as is; a full URL only when it is on the Chronicle host.
 * @param {*} src the map page's `src`
 * @param {(url: string) => boolean} isAllowedHost
 * @returns {string} '' when there is nothing safe to show
 */
export function mapThumbSrc(src, isAllowedHost) {
  if (typeof src !== 'string' || !src) return '';
  if (/^https?:\/\//i.test(src)) return isAllowedHost(src) ? src : '';
  // Any other scheme, a protocol-relative URL, or a step up out of Foundry's
  // data folder is not a stored picture.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') || src.split(/[\\/]/).includes('..')) return '';
  return src;
}

/* ------------------------------------------------------------------
   Pin shapes: the same SVGs Chronicle draws around a marker's icon.
   Metrics are per shape because each one's map point is elsewhere.
   ------------------------------------------------------------------ */

const PIN_SCALE = { s: 0.75, m: 1, l: 1.35 };
// cx, cy: where the icon sits in the 30x38 box; fs: icon size; ax, ay: the
// map point (the tip of a drop, the foot of a flag, the middle of a dot).
const PIN_SHAPE = {
  drop: { cx: 15, cy: 15, fs: 12, ax: 15, ay: 37 },
  seal: { cx: 15, cy: 22, fs: 12, ax: 15, ay: 37 },
  flag: { cx: 17, cy: 11, fs: 8, ax: 8, ay: 37 },
  dot: { cx: 15, cy: 19, fs: 11, ax: 15, ay: 19 },
};

/**
 * Box size, anchor and icon placement for a pin, in CSS pixels.
 * @param {string} style
 * @param {string} size
 */
export function pinMetrics(style, size) {
  const k = PIN_SCALE[size] || 1;
  const sh = PIN_SHAPE[style] || PIN_SHAPE.drop;
  return {
    w: 30 * k, h: 38 * k, ax: sh.ax * k, ay: sh.ay * k,
    icoX: sh.cx * k, icoY: sh.cy * k, icoSize: sh.fs * k,
  };
}

/**
 * The pin shape as SVG markup. `color` must already be a validated hex
 * colour (the viewer's `_safeColor`); a hidden pin gets a dashed outline.
 * @param {string} style
 * @param {string} color
 * @param {boolean} dashed
 * @returns {string}
 */
export function pinShapeSvg(style, color, dashed) {
  const c = /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#0d9488';
  const dash = dashed ? ' stroke-dasharray="3 2"' : '';
  const open = '<svg viewBox="0 0 30 38" aria-hidden="true">';
  if (style === 'seal') return `${open}<path d="M15 34v4" stroke="${c}" stroke-width="2"/><circle cx="15" cy="22" r="12" fill="${c}" stroke="#fff" stroke-width="2"${dash}/><circle cx="15" cy="22" r="8" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.2"/></svg>`;
  if (style === 'flag') return `${open}<path d="M8 37V4" stroke="#3b2f1e" stroke-width="2.4"/><path d="M9 5h17l-4 6 4 6H9z" fill="${c}" stroke="#fff" stroke-width="1.5"${dash}/></svg>`;
  if (style === 'dot') return `${open}<circle cx="15" cy="19" r="10" fill="${c}" stroke="#fff" stroke-width="2.5"${dash}/></svg>`;
  return `${open}<path d="M15 37s-12-12.5-12-22a12 12 0 0124 0c0 9.5-12 22-12 22z" fill="${c}" stroke="#fff" stroke-width="2"${dash}/></svg>`;
}

/** The frame's title-plate initial (the wax seal on Old). */
export function frameInitial(title) {
  const ch = String(title || '').trim().charAt(0);
  return ch ? ch.toUpperCase() : 'M';
}
