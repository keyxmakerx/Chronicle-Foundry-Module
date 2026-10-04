/**
 * A problem report as GitHub-issue markdown. Built only from the report's own
 * stored, already-scrubbed fields and scrubbed again here, so the text is safe
 * to paste into a public issue: no API key, no URL with a token, no email.
 *
 * Pure — see tools/test-debug-markdown.mjs.
 */

import { cleanLine, redactText } from './_debug-snapshot.mjs';

const cell = (v) => cleanLine(v, 120).replace(/\|/g, '\\|');

/**
 * @param {object} report - a stored report.
 * @param {{statusLabels?: Object<string,string>}} [opts] - words for each row status.
 * @returns {string}
 */
export function reportToMarkdown(report, { statusLabels = {} } = {}) {
  const r = report && typeof report === 'object' ? report : {};
  const snap = r.snapshot && typeof r.snapshot === 'object' ? r.snapshot : null;
  const L = [];
  const when = Number.isFinite(Number(r.at)) && Number(r.at) > 0 ? new Date(Number(r.at)).toISOString() : '';

  L.push('## Problem reported from Foundry');
  L.push(`Reported by ${cleanLine(r.fromName, 80) || 'a player'}${when ? ` on ${when}` : ''}${snap?.characterName ? ` about ${cleanLine(snap.characterName, 120)}` : ''}.`);
  L.push('');
  L.push('### What they said');
  const quoted = redactText(r.text).split(/\r?\n/).map((l) => `> ${l}`).join('\n');
  L.push(quoted || '> ');
  L.push('');

  if (!snap && r.note) {
    L.push(`_${cleanLine(r.note, 100)}_`);
    L.push('');
  }

  const info = snap?.info;
  if (info) {
    L.push('### Module and system');
    L.push(`- Module: ${cleanLine(info.moduleVersion) || 'unknown'}`);
    L.push(`- Foundry: ${cleanLine(info.foundryVersion) || 'unknown'}`);
    L.push(`- Game system: ${cleanLine(info.systemId) || 'unknown'} ${cleanLine(info.systemVersion)}`.trimEnd());
    L.push(`- Chronicle host: ${cleanLine(info.chronicleHost) || 'unknown'}`);
    if (info.moneyField) L.push(`- Money field: ${cleanLine(info.moneyField)}`);
    L.push('');
  }

  if (snap?.compare?.rows?.length) {
    L.push('### Side by side');
    L.push('| Thing | In Chronicle | In Foundry | Result |');
    L.push('|---|---|---|---|');
    for (const row of snap.compare.rows) {
      L.push(`| ${cell(row.thing)} | ${cell(row.chronicle)} | ${cell(row.foundry)} | ${cell(statusLabels[row.status] || row.status)} |`);
    }
    if (snap.compare.moneyLine) L.push('', cleanLine(snap.compare.moneyLine, 400));
    L.push('');
  }

  if (snap?.log?.length) {
    L.push('### Recent sync log');
    L.push('```');
    for (const e of snap.log.slice(0, 20)) {
      const t = e.at ? new Date(e.at).toISOString() : '';
      L.push(`${t} ${String(e.level || '').toUpperCase()} ${cleanLine(e.text).replace(/`/g, "'")}`.trim());
    }
    L.push('```');
    L.push('');
  }

  return L.join('\n').trimEnd() + '\n';
}
