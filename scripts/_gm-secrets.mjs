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
