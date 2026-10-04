/**
 * Pictures inside Chronicle page text, translated between Chronicle's stored
 * shape and what a Foundry journal page can show.
 *
 * Chronicle stores each picture as
 *   <figure class="ce-img ce-img--w40 ce-img--right [ce-img--gm]">
 *     <img src="/media/<uuid>" alt><figcaption>…</figcaption></figure>
 * with a src relative to the Chronicle server. Chronicle only serves those
 * files through signed links that expire after minutes, so a link saved into
 * a journal would break; sync keeps its own copy of each picture in the
 * world's files instead (scripts/picture-store.mjs) and points the src there.
 *
 * GM-only pictures (ce-img--gm) are never copied. They go inside Foundry's
 * own secret block, so players don't see them; the GM's client shows them
 * from a fresh signed link at render time.
 *
 * On push every src goes back to the plain `/media/<uuid>` path, and every
 * Chronicle picture inside a secret block goes back marked GM only, in
 * whatever shape Foundry's editor left it, so an edit in Foundry can never
 * turn a GM-only picture into one players see.
 *
 * Pure string transforms over the editor's fixed output shape, so they run
 * in Node tests. `tools/test-inline-pictures.mjs`.
 */

/** Chronicle media ids are UUIDs; anything else is never used in a path. */
export const MEDIA_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Folder, inside the world's own folder, that holds the copies. */
export const PICTURE_DIR_NAME = 'chronicle-media';

/** Class on the secret block sync wraps around a GM-only picture. */
export const GM_PICTURE_SECTION_CLASS = 'chronicle-gm-picture';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// The editor writes a figure as one img plus an optional plain-text caption,
// never a nested figure, so the lazy match ends at its own closing tag.
const FIGURE_RE = /<figure\b[^>]*>[\s\S]*?<\/figure>/gi;
const IMG_SRC_RE = /(<img\b[^>]*?(?<![\w-])src=)(["'])([^"']*)\2/gi;
const SECTION_RE = /<section\b[^>]*>[\s\S]*?<\/section>/gi;

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

function classList(tag) {
  const m = /\bclass=(["'])([^"']*)\1/i.exec(tag);
  return m ? m[2].split(/\s+/).filter(Boolean) : [];
}

function openingTag(html) {
  const end = html.indexOf('>');
  return end < 0 ? html : html.slice(0, end + 1);
}

function isPictureFigure(figure) {
  return classList(openingTag(figure)).includes('ce-img');
}

function isGMFigure(figure) {
  return classList(openingTag(figure)).includes('ce-img--gm');
}

/**
 * The Chronicle media id a src points at, or null. Accepts the plain
 * `/media/<uuid>` path, with or without a signed query.
 * @param {string} src
 * @returns {string|null}
 */
export function mediaIdFromChronicleSrc(src) {
  const m = new RegExp(`^/media/(${UUID})(?:[?#].*)?$`, 'i').exec(String(src || ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * The file extension a copy gets for a MIME type, or null for a type sync
 * does not copy (anything that isn't a plain raster picture).
 * @param {string} mime
 * @returns {string|null}
 */
export function extensionForMime(mime) {
  return EXT_BY_MIME[String(mime || '').toLowerCase().split(';')[0].trim()] || null;
}

/**
 * Media ids of the pictures in Chronicle HTML that sync should copy: every
 * `/media/<uuid>` image outside a GM-only figure and outside a secret block.
 * @param {string} html
 * @returns {string[]} distinct ids, in order of appearance
 */
export function sharedPictureIds(html) {
  const ids = [];
  const visible = String(html || '')
    .replace(SECTION_RE, (sec) => (isSecretSection(sec) ? '' : sec))
    .replace(FIGURE_RE, (fig) => (isGMFigure(fig) ? '' : fig));
  for (const m of visible.matchAll(IMG_SRC_RE)) {
    const id = mediaIdFromChronicleSrc(m[3]);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Stable across pulls (no churn on every sync), unique within a page.
function secretIdFor(figure, n) {
  const m = new RegExp(`/media/(${UUID})`, 'i').exec(figure);
  const seed = m ? m[1].replace(/-/g, '').slice(0, 16) : '0';
  return `secret-chr${seed}${n}`;
}

function isSecretSection(section) {
  return classList(openingTag(section)).includes('secret');
}

/**
 * Chronicle HTML → Foundry HTML. Shared pictures point at their local copy
 * when `localPathFor(id)` has one (otherwise they keep the Chronicle path
 * and are retried on the next pull); GM-only figures go inside a secret
 * block untouched.
 * @param {string} html
 * @param {(id: string) => string|undefined} localPathFor
 * @returns {string}
 */
export function toFoundryPictures(html, localPathFor) {
  const swapSrcs = (fragment) => fragment.replace(IMG_SRC_RE, (all, pre, q, src) => {
    const id = mediaIdFromChronicleSrc(src);
    const local = id ? localPathFor(id) : '';
    return local ? `${pre}${q}${local}${q}` : all;
  });

  let n = 0;
  const outsideSecrets = (fragment) => {
    let out = '';
    let last = 0;
    for (const m of fragment.matchAll(FIGURE_RE)) {
      out += swapSrcs(fragment.slice(last, m.index));
      const fig = m[0];
      if (isPictureFigure(fig) && isGMFigure(fig)) {
        out += `<section class="secret ${GM_PICTURE_SECTION_CLASS}" id="${secretIdFor(fig, n++)}">${fig}</section>`;
      } else {
        out += swapSrcs(fig);
      }
      last = m.index + fig.length;
    }
    return out + swapSrcs(fragment.slice(last));
  };

  // A secret block already in the page is left exactly as it is: whatever
  // is inside stays secret, and a second wrapper would nest.
  let out = '';
  let last = 0;
  const input = String(html || '');
  for (const m of input.matchAll(SECTION_RE)) {
    if (!isSecretSection(m[0])) continue;
    out += outsideSecrets(input.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + outsideSecrets(input.slice(last));
}

/**
 * A src Foundry holds → the plain Chronicle `/media/<uuid>` path, or null
 * when it isn't a Chronicle picture. Recognizes a local copy, the plain
 * path, and a full link on the Chronicle host.
 * @param {string} src
 * @param {string} apiUrl
 * @returns {string|null}
 */
export function chronicleSrcFor(src, apiUrl) {
  const s = String(src || '');
  const local = new RegExp(`(?:^|/)${PICTURE_DIR_NAME}/(${UUID})\\.[a-z0-9]+(?:[?#].*)?$`, 'i').exec(s);
  if (local) return `/media/${local[1].toLowerCase()}`;
  const plain = mediaIdFromChronicleSrc(s);
  if (plain) return `/media/${plain}`;
  if (/^https?:/i.test(s) && apiUrl) {
    try {
      const u = new URL(s);
      const base = new URL(apiUrl);
      if (u.protocol === base.protocol && u.host === base.host) {
        const id = mediaIdFromChronicleSrc(u.pathname);
        if (id) return `/media/${id}`;
      }
    } catch { /* not a URL: not ours */ }
  }
  return null;
}

function markGM(figure) {
  return figure.replace(/^<figure\b([^>]*)>/i, (open, attrs) => {
    const classes = classList(open);
    if (classes.includes('ce-img') && classes.includes('ce-img--gm')) return open;
    const add = ['ce-img', 'ce-img--gm'].filter((c) => !classes.includes(c)).join(' ');
    if (/\bclass=/i.test(attrs)) {
      return open.replace(/\bclass=(["'])([^"']*)\1/i, (_, q, v) => `class=${q}${v ? `${v} ` : ''}${add}${q}`);
    }
    return `<figure class="${add}"${attrs}>`;
  });
}

// Source only, without a backreference, so it can sit inside other patterns.
const CHRONICLE_IMG = `<img\\b[^>]*?(?<![\\w-])src=["']/media/${UUID}["'][^>]*>`;
const hasChroniclePicture = (fragment) => new RegExp(CHRONICLE_IMG, 'i').test(fragment);

/**
 * Inside a secret block every Chronicle picture leaves as GM-only, whatever
 * shape Foundry's editor left it in: a figure of any class is marked, and a
 * bare picture (or one alone in a paragraph) gets a GM-only figure of its own.
 */
function markSecretPictures(section) {
  let out = '';
  let last = 0;
  const bare = (fragment) => fragment
    .replace(new RegExp(`<p\\b[^>]*>\\s*(${CHRONICLE_IMG})\\s*</p>`, 'gi'), '$1')
    .replace(new RegExp(CHRONICLE_IMG, 'gi'), (img) => `<figure class="ce-img ce-img--gm">${img}</figure>`);
  for (const m of section.matchAll(FIGURE_RE)) {
    out += bare(section.slice(last, m.index));
    out += hasChroniclePicture(m[0]) ? markGM(m[0]) : m[0];
    last = m.index + m[0].length;
  }
  return out + bare(section.slice(last));
}

/**
 * Foundry HTML → Chronicle HTML for a push. Every Chronicle picture src goes
 * back to `/media/<uuid>`; every Chronicle picture inside any secret block
 * is marked GM only, and the block sync itself added (holding nothing but the
 * figure) is removed.
 * @param {string} html
 * @param {string} apiUrl
 * @returns {string}
 */
export function toChroniclePictures(html, apiUrl) {
  let out = String(html || '').replace(IMG_SRC_RE, (all, pre, q, src) => {
    const plain = chronicleSrcFor(src, apiUrl);
    return plain ? `${pre}${q}${plain}${q}` : all;
  });

  out = out.replace(SECTION_RE, (section) => {
    if (!isSecretSection(section)) return section;
    const marked = markSecretPictures(section);
    const inner = marked.slice(openingTag(marked).length, -'</section>'.length).trim();
    const figs = inner.match(FIGURE_RE) || [];
    if (figs.length === 1 && figs[0] === inner && isPictureFigure(inner)) return inner;
    return marked;
  });
  return out;
}
