/**
 * GM-only text inside Chronicle page text, translated between Chronicle's
 * shape and Foundry's.
 *
 * Chronicle marks GM-only text inline: `<span data-secret="true">…</span>`
 * inside a paragraph or heading. Foundry has no inline secret; its own GM
 * secret is a block, `<section class="secret">`, which the journal hides
 * from anyone who doesn't own the page. Sync uses the Owner key, so it
 * receives the secrets; left as spans they would show to every player who
 * can see the journal.
 *
 * Pull: each paragraph or heading holding a secret is split around it, and
 * every secret piece goes inside a secret block. The pieces share a
 * `data-chronicle-part` number so push can put the paragraph back together.
 * Spaces at a split edge become no-break spaces, because Foundry's editor
 * trims ordinary ones at the edge of a paragraph.
 *
 * Push: every piece of text inside any secret block, whether sync made it
 * or the GM did, goes back wrapped in its own `<span data-secret>`, so an
 * edit in Foundry can never turn GM-only text into text players see. One
 * span per text run (never a span around another span), because
 * Chronicle's stripper ends a secret at the first `</span>` it meets.
 * Pieces of one split paragraph are joined again; if Foundry's editor
 * dropped the part numbers they stay separate paragraphs, still secret.
 *
 * Chronicle pictures (`<figure class="ce-img">`) keep their shape: a
 * GM-only one (`ce-img--gm`) goes inside a secret block whole on pull, and
 * any picture inside a secret block leaves marked `ce-img--gm` on push.
 * Caption text is never wrapped. `tools/test-gm-secrets.mjs`.
 */

/** Attribute tying together the pieces of one split paragraph. */
export const PART_ATTR = 'data-chronicle-part';

const TOKEN_RE = /<!--[\s\S]*?-->|<\/?[a-zA-Z][\w:-]*(?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+|</g;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img',
  'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time',
  'u', 'var', 'wbr',
]);
const TEXT_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const NBSP = ' ';

// --- A small, lossless HTML tree: serializing it gives back the input. ---

function parse(html) {
  const root = { t: 'el', name: '#root', open: '', close: '', children: [] };
  const stack = [root];
  for (const m of String(html || '').matchAll(TOKEN_RE)) {
    const tok = m[0];
    const top = stack[stack.length - 1];
    if (tok.startsWith('<!--') || tok === '<') {
      top.children.push({ t: 'raw', raw: tok });
    } else if (tok.startsWith('</')) {
      const name = tok.slice(2).match(/^[\w:-]+/)[0].toLowerCase();
      const at = stack.map((n) => n.name).lastIndexOf(name);
      if (at > 0) {
        stack[at].close = tok;
        stack.length = at;
      } else {
        top.children.push({ t: 'raw', raw: tok });
      }
    } else if (tok.startsWith('<')) {
      const name = tok.slice(1).match(/^[\w:-]+/)[0].toLowerCase();
      const el = { t: 'el', name, open: tok, close: '', children: [] };
      top.children.push(el);
      if (!VOID.has(name) && !tok.endsWith('/>')) stack.push(el);
    } else {
      top.children.push({ t: 'text', raw: tok });
    }
  }
  return root;
}

function serialize(node) {
  if (node.t !== 'el') return node.raw;
  return node.open + node.children.map(serialize).join('') + node.close;
}

const inner = (node) => node.children.map(serialize).join('');
const raw = (s) => ({ t: 'raw', raw: s });

function classList(open) {
  const m = /\sclass=(["'])([^"']*)\1/i.exec(open);
  return m ? m[2].split(/\s+/).filter(Boolean) : [];
}

function getAttr(open, name) {
  const m = new RegExp(`\\s${name}=(["'])([^"']*)\\1`, 'i').exec(open);
  return m ? m[2] : null;
}

function withAttr(open, name, value) {
  const bare = withoutAttr(open, name);
  return bare.replace(/\s*(\/?)>$/, ` ${name}="${value}"$1>`);
}

function withoutAttr(open, name) {
  return open.replace(new RegExp(`\\s${name}=(["'])[^"']*\\1`, 'gi'), '');
}

const isInline = (n) => n.t !== 'el' || INLINE.has(n.name);
const isBlank = (n) => n.t === 'text' && !n.raw.trim();
// Same test as Chronicle's own stripper, so anything Chronicle would hide
// from a player is hidden here too.
const isSecretSpan = (n) => n.t === 'el' && n.name === 'span' && /\bdata-secret\b/i.test(n.open);
const isSecretBlock = (n) => n.t === 'el' && n.name === 'section' && classList(n.open).includes('secret');
const isPicture = (n) => n.t === 'el' && n.name === 'figure' && classList(n.open).includes('ce-img');
const isGMPicture = (n) => isPicture(n) && classList(n.open).includes('ce-img--gm');

function markGMPicture(n) {
  if (isGMPicture(n)) return n;
  const open = /\sclass=(["'])([^"']*)\1/i.test(n.open)
    ? n.open.replace(/\sclass=(["'])([^"']*)\1/i, (_, q, v) => ` class=${q}${v} ce-img--gm${q}`)
    : n.open.replace(/^<figure/i, '<figure class="ce-img--gm"');
  return { ...n, open };
}
const containsSecret = (n) => n.t === 'el' && (isSecretSpan(n) || n.children.some(containsSecret));

// --- Pull: Chronicle → Foundry ---

// Inline nodes → pieces alternating shared / secret, with the inline
// elements around a secret repeated on each side of the split.
function splitInline(nodes) {
  const segs = [];
  const add = (secret, html) => {
    if (!html) return;
    const last = segs[segs.length - 1];
    if (last && last.secret === secret) last.html += html;
    else segs.push({ secret, html });
  };
  for (const n of nodes) {
    if (isSecretSpan(n)) add(true, inner(n));
    else if (containsSecret(n)) {
      for (const s of splitInline(n.children)) add(s.secret, n.open + s.html + n.close);
    } else add(false, serialize(n));
  }
  return segs;
}

// Whitespace alone between pieces rides with a secret piece instead of
// becoming an empty paragraph.
function foldBlankPieces(segs) {
  const out = [];
  segs.forEach((s, i) => {
    if (s.secret || s.html.trim()) { out.push({ ...s }); return; }
    const prev = out[out.length - 1];
    if (prev?.secret) prev.html += s.html;
    else if (segs[i + 1]?.secret) segs[i + 1] = { ...segs[i + 1], html: s.html + segs[i + 1].html };
    else out.push({ ...s });
  });
  return out;
}

function splitBlock(open, close, nodes, ids) {
  const segs = foldBlankPieces(splitInline(nodes));
  const k = ++ids.part;
  const tagged = withAttr(open, PART_ATTR, k);
  return raw(segs.map((s, i) => {
    let html = s.html;
    if (i > 0) html = html.replace(/^ +/, (sp) => NBSP.repeat(sp.length));
    if (i < segs.length - 1) html = html.replace(/ +$/, (sp) => NBSP.repeat(sp.length));
    const block = `${tagged}${html}${close}`;
    if (!s.secret) return block;
    return `<section class="secret" id="secret-chrtxt${++ids.secret}" ${PART_ATTR}="${k}">${block}</section>`;
  }).join(''));
}

const containsGMPicture = (n) => n.t === 'el' && !isSecretBlock(n) && (isGMPicture(n) || n.children.some(containsGMPicture));

function pullNode(n, ids) {
  if (isGMPicture(n)) return [raw(`<section class="secret" id="secret-chrtxt${++ids.secret}">${serialize(n)}</section>`)];
  if (!(containsSecret(n) || containsGMPicture(n)) || isSecretBlock(n)) return [n];
  if (TEXT_BLOCKS.has(n.name) && n.children.every(isInline)) {
    return [splitBlock(n.open, n.close || `</${n.name}>`, n.children, ids)];
  }
  const children = [];
  let run = [];
  const flush = () => {
    if (run.some(containsSecret)) children.push(splitBlock('<p>', '</p>', run, ids));
    else children.push(...run);
    run = [];
  };
  for (const c of n.children) {
    if (isInline(c)) { run.push(c); continue; }
    flush();
    children.push(...pullNode(c, ids));
  }
  flush();
  return [{ ...n, children }];
}

/**
 * Chronicle HTML → Foundry HTML: GM-only text goes into Foundry secret
 * blocks. HTML without secrets comes back unchanged.
 * @param {string} html
 * @returns {string}
 */
export function toFoundrySecrets(html) {
  const input = String(html || '');
  if (!/\bdata-secret\b|\bce-img--gm\b/i.test(input)) return input;
  const ids = { part: 0, secret: 0 };
  return inner(pullNode(parse(input), ids)[0]);
}

// --- Push: Foundry → Chronicle ---

const secretSpan = (html) => raw(`<span data-secret="true">${html}</span>`);

// Edge whitespace stays outside the span, as Chronicle's editor writes it.
function secretText(text) {
  const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  return raw(`${lead}<span data-secret="true">${body}</span>${trail}`);
}

// Mark everything a player could read inside a secret block.
function markSecret(n) {
  n.children = n.children.map((c) => {
    if (c.t === 'text') return c.raw.trim() ? secretText(c.raw) : c;
    if (isPicture(c)) return markGMPicture(c);
    if (c.t !== 'el' || isSecretSpan(c) || c.name === 'br') return c;
    if (INLINE.has(c.name) && !/<\/?span\b/i.test(serialize(c))) return secretSpan(serialize(c));
    markSecret(c);
    return c;
  });
}

function markAllSecrets(n) {
  if (n.t !== 'el') return;
  if (isSecretBlock(n)) markSecret(n);
  else n.children.forEach(markAllSecrets);
}

function partOf(n) {
  if (n.t !== 'el') return null;
  if (TEXT_BLOCKS.has(n.name)) return getAttr(n.open, PART_ATTR);
  if (!isSecretBlock(n)) return null;
  const own = getAttr(n.open, PART_ATTR);
  if (own) return own;
  const kids = n.children.filter((c) => !isBlank(c));
  return kids.length === 1 && kids[0].t === 'el' && TEXT_BLOCKS.has(kids[0].name)
    ? getAttr(kids[0].open, PART_ATTR) : null;
}

function unmarked(n) {
  return n.t === 'el' ? { ...n, open: withoutAttr(n.open, PART_ATTR) } : n;
}

// The text block a run member holds: itself, or the one block inside a
// secret block. Null when the GM changed the piece beyond a single block.
function pieceBlock(n) {
  if (!isSecretBlock(n)) return n;
  const kids = n.children.filter((c) => !isBlank(c));
  return kids.length === 1 && kids[0].t === 'el' && TEXT_BLOCKS.has(kids[0].name) ? kids[0] : null;
}

function joinRun(run) {
  const blocks = run.map(pieceBlock);
  if (blocks.every((b) => b && b.name === blocks[0].name)) {
    const body = blocks.map((b, i) => {
      let html = inner(b);
      if (i > 0) html = html.replace(/^(?: |&nbsp;)+/, (sp) => ' '.repeat(sp.replace(/&nbsp;/g, NBSP).length));
      if (i < blocks.length - 1) html = html.replace(/(?: |&nbsp;)+$/, (sp) => ' '.repeat(sp.replace(/&nbsp;/g, NBSP).length));
      return html;
    }).join('');
    return [raw(withoutAttr(blocks[0].open, PART_ATTR) + body + (blocks[0].close || `</${blocks[0].name}>`))];
  }
  return run.flatMap((n) => (isSecretBlock(n) ? n.children.map(unmarked) : [unmarked(n)]));
}

function pushChildren(n) {
  if (n.t !== 'el') return n;
  const kids = n.children.map(pushChildren);
  // A split piece is joined by the block holding the whole run.
  if (isSecretBlock(n)) return { ...n, children: kids };
  const out = [];
  for (let i = 0; i < kids.length; i++) {
    const id = partOf(kids[i]);
    if (id) {
      const run = [kids[i]];
      let j = i + 1;
      while (j < kids.length) {
        if (isBlank(kids[j]) && partOf(kids[j + 1] || {}) === id) { j++; continue; }
        if (partOf(kids[j]) !== id) break;
        run.push(kids[j++]);
      }
      out.push(...joinRun(run));
      i = j - 1;
    } else if (isSecretBlock(kids[i])) {
      out.push(...kids[i].children);
    } else {
      out.push(kids[i]);
    }
  }
  return { ...n, children: out };
}

/**
 * Foundry HTML → Chronicle HTML for a push: everything inside a secret
 * block leaves as GM-only text, and paragraphs sync split on pull are
 * joined again.
 * @param {string} html
 * @returns {string}
 */
export function toChronicleSecrets(html) {
  const input = String(html || '');
  if (!/<section\b/i.test(input) && !input.includes(PART_ATTR)) return input;
  const tree = parse(input);
  markAllSecrets(tree);
  return inner(pushChildren(tree));
}

/**
 * [start, end) offsets of each outermost secret block, so a heading inside
 * one never becomes a page break (its text would name a page players see).
 * @param {string} html
 * @returns {Array<[number, number]>}
 */
export function secretBlockRanges(html) {
  const ranges = [];
  const walk = (n, at) => {
    const len = serialize(n).length;
    if (isSecretBlock(n)) { ranges.push([at, at + len]); return; }
    if (n.t !== 'el') return;
    let pos = at + n.open.length;
    for (const c of n.children) {
      walk(c, pos);
      pos += serialize(c).length;
    }
  };
  walk(parse(html), 0);
  return ranges;
}

// --- Keeping GM-only content out of Foundry's saved pages ---
//
// Foundry sends every journal page to every connected client and only hides
// a secret block when it draws the page, and a player who owns a page sees
// its secret blocks. So the saved page holds a placeholder instead of each
// secret: a secret block whose id names the secret by a keyed hash. The GM's
// client shows the real content in place of the placeholder (it holds the
// API key and can read Chronicle), and puts it back before a push.

/** The placeholder label in English, recognized whatever the GM's language. */
export const DEFAULT_PLACEHOLDER_TEXT = 'GM-only text, kept in Chronicle';

const escapeText = (t) => String(t).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const textOf = (n) => serialize(n).replace(/<[^>]*>/g, '')
  .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c)).replace(/&nbsp;/g, ' ').trim();
const placeholderLabels = (text) => [...new Set([String(text || '').trim(), DEFAULT_PLACEHOLDER_TEXT].filter(Boolean))];

/** Prefix of the id on every placeholder secret block sync writes. */
export const PLACEHOLDER_ID_PREFIX = 'secret-chrk';

const stripParts = (html) => html.replace(new RegExp(`\\s${PART_ATTR}=(["'])[^"']*\\1`, 'gi'), '');

// SHA-256 in plain JS: Web Crypto exists only on HTTPS pages, and many
// Foundry servers are reached over plain HTTP on a home network.
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of bytes. Exported for its test vectors. */
export function sha256(bytes) {
  const len = bytes.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(total - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
  return out;
}

/** HMAC-SHA-256 (RFC 2104) of bytes under a byte key. */
export function hmacSha256(key, msg) {
  let k = key.length > 64 ? sha256(key) : key;
  const pad = (x) => {
    const b = new Uint8Array(64 + (x === 0x36 ? msg.length : 32));
    for (let i = 0; i < 64; i++) b[i] = (k[i] || 0) ^ x;
    return b;
  };
  const ipad = pad(0x36);
  ipad.set(msg, 64);
  const opad = pad(0x5c);
  opad.set(sha256(ipad), 64);
  return sha256(opad);
}

/**
 * A keyed hash for secrets of one Chronicle page: HMAC-SHA-256 under the
 * GM's API key, so a player can't test a guess against a placeholder id.
 * @param {string} apiKey
 * @param {string} entityId
 * @returns {(content: string) => Promise<string>} 32 hex characters
 */
export function secretKeyer(apiKey, entityId) {
  const enc = new TextEncoder();
  const key = enc.encode(String(apiKey || ''));
  return async (content) => [...hmacSha256(key, enc.encode(`${entityId}\n${content}`)).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

function secretBlocks(n, out = []) {
  if (n.t !== 'el') return out;
  if (isSecretBlock(n)) out.push(n);
  else n.children.forEach((c) => secretBlocks(c, out));
  return out;
}

/**
 * Foundry HTML from toFoundrySecrets → the same HTML with every secret
 * block's content replaced by a placeholder, plus the content each
 * placeholder stands for.
 * @param {string} html
 * @param {string} placeholderText - plain text shown where a secret was
 * @param {(content: string) => Promise<string>} keyOf - secretKeyer(...)
 * @returns {Promise<{html: string, pieces: Map<string, string>}>}
 */
export async function hideSecrets(html, placeholderText, keyOf) {
  const pieces = new Map();
  const input = String(html || '');
  if (!/<section\b/i.test(input)) return { html: input, pieces };
  const tree = parse(input);
  const seen = new Map();
  const label = escapeText(placeholderText || DEFAULT_PLACEHOLDER_TEXT);
  for (const sec of secretBlocks(tree)) {
    const content = stripParts(inner(sec)).trim();
    const hash = await keyOf(content);
    const n = seen.get(hash) || 0;
    seen.set(hash, n + 1);
    const id = `${PLACEHOLDER_ID_PREFIX}${hash}${n ? `-${n}` : ''}`;
    pieces.set(id, content);
    const part = partOf(sec);
    const tagOpen = part ? `<p ${PART_ATTR}="${part}">` : '<p>';
    sec.open = withAttr(sec.open, 'id', id);
    sec.children = [raw(`${tagOpen}${label}</p>`)];
  }
  return { html: inner(tree), pieces };
}

/**
 * Before a push: every placeholder gets its content back. Text the GM
 * added inside a placeholder block is kept after it, still secret.
 * `missing` lists placeholders with no known content (the page changed in
 * Chronicle since it was pulled, or another API key keyed it); a caller
 * must not send the page then, or that GM-only content would be lost.
 * @param {string} html
 * @param {Map<string, string>} pieces - id → content, from hideSecrets
 * @param {string} placeholderText
 * @returns {{html: string, missing: string[], gmMade: boolean}}
 */
export function restoreSecrets(html, pieces, placeholderText) {
  const missing = [];
  let gmMade = false;
  const input = String(html || '');
  if (!/<section\b/i.test(input)) return { html: input, missing, gmMade };
  const tree = parse(input);
  const labels = placeholderLabels(placeholderText);
  for (const sec of secretBlocks(tree)) {
    const id = getAttr(sec.open, 'id') || '';
    const isPlaceholder = id.startsWith(PLACEHOLDER_ID_PREFIX);
    if (!isPlaceholder) {
      // A secret block whose id was lost but still shows a placeholder is
      // treated as unknown rather than pushed as its placeholder text.
      if (sec.children.some((c) => labels.some((l) => textOf(c).startsWith(l)))) missing.push(id || '(no id)');
      else gmMade = true;
      continue;
    }
    const content = pieces.get(id);
    if (content === undefined) { missing.push(id); continue; }
    const kids = sec.children.filter((c) => !isBlank(c));
    const part = partOf(sec);
    let restored = content;
    const only = parse(content).children.filter((c) => !isBlank(c));
    if (part && only.length === 1 && only[0].t === 'el' && TEXT_BLOCKS.has(only[0].name)) {
      restored = serialize({ ...only[0], open: withAttr(only[0].open, PART_ATTR, part) });
    }
    // The label block gives way to the content. Anything the GM typed (after
    // the label, over it, or in new paragraphs) is kept after it, secret.
    if (kids.length > 1) gmMade = true;
    const at = kids.findIndex((c) => labels.some((l) => textOf(c).startsWith(l)));
    if (at < 0) {
      kids.unshift(raw(restored));
      gmMade = true;
    } else {
      const block = kids[at];
      const label = labels.find((l) => textOf(block).startsWith(l));
      const rest = [raw(restored)];
      if (textOf(block) !== label) {
        gmMade = true;
        const tail = block.t === 'el' ? { ...block, children: parse(inner(block).replace(escapeText(label), '')).children } : block;
        if (textOf(tail)) rest.push(tail);
      }
      kids.splice(at, 1, ...rest);
    }
    sec.children = kids;
  }
  return { html: inner(tree), missing, gmMade };
}

/**
 * True when page HTML holds GM-only content in the clear: a secret block
 * that isn't a placeholder, or a placeholder holding anything but its
 * label (text the GM typed into it). With `chronicleOnly`, only what an
 * older sync wrote (Chronicle secret spans, or sync's own non-placeholder
 * secret blocks), leaving the GM's own edits to their next push.
 * @param {string} html
 * @param {{chronicleOnly?: boolean, placeholderText?: string}} [opts]
 * @returns {boolean}
 */
export function hasClearSecrets(html, { chronicleOnly = false, placeholderText } = {}) {
  const input = String(html || '');
  if (/\bdata-secret\b/i.test(input)) return true;
  if (!/<section\b/i.test(input)) return false;
  const labels = placeholderLabels(placeholderText);
  return secretBlocks(parse(input)).some((sec) => {
    const id = getAttr(sec.open, 'id') || '';
    if (id.startsWith(PLACEHOLDER_ID_PREFIX)) {
      if (chronicleOnly) return false;
      const kids = sec.children.filter((c) => !isBlank(c));
      return !(kids.length === 1 && labels.includes(textOf(kids[0])));
    }
    return chronicleOnly ? id.startsWith('secret-chr') : true;
  });
}
