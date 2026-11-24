/**
 * Turns the text of a campaign's pick-list entry into item HTML. PURE: no
 * Foundry globals.
 *
 * Chronicle stores an entry written through the AI tools as the Markdown it
 * was written in: `**bold**`, `@[Page]` mentions, `---` rules. Saved into an
 * item as if it were HTML, that showed as raw markup. Entries that already
 * hold HTML (package entries, the page editor) keep their markup and only get
 * their mentions converted.
 *
 * A mention becomes Chronicle's own mention anchor (`<a data-mention-id>`)
 * when a synced journal carries that page, so `mention-links.mjs` draws it as
 * a Foundry link with the reader's permission checked at view time; with no
 * journal it is left as its plain words.
 */

/** Stored prose that is markup rather than plain text (Chronicle's own test). */
const HTML_LIKE = /<(p|div|br|ul|ol|li|strong|em|b|i|h[1-6]|table|blockquote|span)\b/i;
const MENTION = /@\[([^\]|]+)(?:\|([^\]]+))?\]/g;
const GLOSSARY_REF = /\{@\w+\s+([^}|]+)(?:\|([^}]+))?\}/g;
const RULE_LINE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/;
const HEADING = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/;

const escapeHTML = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * A name-to-page lookup built from the world's synced journals.
 * @param {Iterable<{name?: string, entityId?: string}>} journals
 * @returns {(name: string) => string|null} the Chronicle page id, or null
 */
export function mentionLookup(journals) {
  const byName = new Map();
  for (const j of journals ?? []) {
    if (j?.entityId && j.name && !byName.has(norm(j.name))) byName.set(norm(j.name), j.entityId);
  }
  return (name) => byName.get(norm(name)) ?? null;
}

/** One mention as HTML: an anchor when a journal carries the page, else its words. */
function mentionHTML(name, shown, mentionId) {
  const label = escapeHTML((shown ?? name).trim());
  const id = typeof mentionId === 'function' ? mentionId(name.trim()) : null;
  return id ? `<a data-mention-id="${escapeHTML(id)}">${label}</a>` : label;
}

/** Emphasis and code inside already-escaped text. */
function emphasis(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
}

/** Inline Markdown in one block: mentions kept apart so their names aren't restyled. */
function inline(text, mentionId) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    out += emphasis(escapeHTML(text.slice(last, m.index)));
    out += mentionHTML(m[1], m[2], mentionId);
    last = m.index + m[0].length;
  }
  return out + emphasis(escapeHTML(text.slice(last)));
}

/** Plain text or Markdown as block HTML. */
function markdownHTML(text, mentionId) {
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    const words = para.join(' ').replace(/\s+-{3,}\s*$/, '').trim();
    if (words) blocks.push(`<p>${inline(words, mentionId)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(`<${list.tag}>${list.items.map((it) => `<li>${inline(it, mentionId)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const line of text.split('\n')) {
    if (!line.trim() || RULE_LINE.test(line)) {
      flushPara();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(6, heading[1].length + 2);
      blocks.push(`<h${level}>${inline(heading[2], mentionId)}</h${level}>`);
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushPara();
      const tag = item[1] ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(item[2]);
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks.join('');
}

/**
 * An entry's description as HTML, still to be sanitized by the caller.
 * @param {string} text - the entry's stored description
 * @param {{mentionId?: (name: string) => string|null}} [opts]
 * @returns {string}
 */
export function entryTextHTML(text, { mentionId } = {}) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n')
    .replace(GLOSSARY_REF, (_, term, shown) => shown || term).trim();
  if (!raw) return '';
  if (!HTML_LIKE.test(raw)) return markdownHTML(raw, mentionId);
  return raw
    .replace(/<p>\s*(?:-{3,}|\*{3,}|_{3,})\s*<\/p>/gi, '')
    .replace(MENTION, (_, name, shown) => mentionHTML(name, shown, mentionId));
}
