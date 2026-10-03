/**
 * Compares API-CONTRACT.md's error-code table with Chronicle's
 * error-catalog.json, so the copy in this repo cannot silently fall behind
 * the wire contract. Pure: callers supply both texts. Used by
 * tools/check-error-catalog.mjs (CI, live catalog) and
 * tools/test-error-catalog.mjs (fixtures).
 */

/** Schema version of error-catalog.json this table was written against. */
export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Pull `{ code, category, httpStatus }` rows out of the markdown table whose
 * header starts with "| `error` code |". Returns null when no such table.
 */
export function parseContractTable(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^\|\s*`error` code\s*\|/.test(l));
  if (start === -1) return null;
  const rows = [];
  // Skip the header and the |---| separator.
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const unquote = (c) => c.replace(/^`|`$/g, '');
    rows.push({
      code: unquote(cells[0] ?? ''),
      category: unquote(cells[1] ?? ''),
      httpStatus: Number(cells[cells.length - 1]),
    });
  }
  return rows;
}

/**
 * Returns a list of human-readable mismatches between the table rows, the
 * catalog, and the module's own category set. Empty list means in sync.
 * Wildcard catalog entries (`ErrInternal`, code `<dynamic>`) are documented
 * in prose, not the table, so they are skipped.
 */
export function compareCatalog({ tableRows, catalog, moduleCategories }) {
  const problems = [];
  if (!tableRows) return ['API-CONTRACT.md: error-code table not found'];

  const version = catalog.schemaVersion ?? 1;
  if (version !== SUPPORTED_SCHEMA_VERSION) {
    problems.push(
      `error-catalog.json schemaVersion is ${version}; the table was written ` +
      `for ${SUPPORTED_SCHEMA_VERSION}. Re-read the catalog and update the contract.`,
    );
  }

  const wire = new Map();
  for (const c of catalog.codes ?? []) {
    if (!c.wildcard) wire.set(c.code, c);
  }
  const documented = new Map(tableRows.map((r) => [r.code, r]));

  for (const [code, c] of wire) {
    const row = documented.get(code);
    if (!row) {
      problems.push(`\`${code}\` is in error-catalog.json but missing from the table`);
      continue;
    }
    if (row.category !== c.category) {
      problems.push(`\`${code}\`: table says category \`${row.category}\`, catalog says \`${c.category}\``);
    }
    if (row.httpStatus !== c.httpStatus) {
      problems.push(`\`${code}\`: table says HTTP ${row.httpStatus}, catalog says ${c.httpStatus}`);
    }
  }
  for (const code of documented.keys()) {
    if (!wire.has(code)) problems.push(`\`${code}\` is in the table but not in error-catalog.json`);
  }

  // update-info.mjs styles notices by category; a category it doesn't know
  // falls back to HTTP-status guessing, so the sets must match. null means
  // the set couldn't be read; undefined skips the check.
  if (moduleCategories === null) {
    problems.push('update-info.mjs: CHRONICLE_CATEGORIES set not found');
  } else if (moduleCategories) {
    const catalogCats = new Set(catalog.categories ?? []);
    for (const cat of catalogCats) {
      if (!moduleCategories.has(cat)) {
        problems.push(`category \`${cat}\` is in error-catalog.json but not in update-info.mjs CHRONICLE_CATEGORIES`);
      }
    }
    for (const cat of moduleCategories) {
      if (!catalogCats.has(cat)) {
        problems.push(`category \`${cat}\` is in update-info.mjs CHRONICLE_CATEGORIES but not in error-catalog.json`);
      }
    }
  }
  return problems;
}

/** Reads the CHRONICLE_CATEGORIES set literal out of update-info.mjs source. */
export function parseModuleCategories(source) {
  const m = source.match(/CHRONICLE_CATEGORIES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) return null;
  return new Set([...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2]));
}
