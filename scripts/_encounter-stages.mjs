/**
 * Chronicle Sync - encounter stages (pure)
 *
 * A stage, planned on the encounter in Chronicle, says when something changes
 * mid-fight: creatures take another form, and "later" rows arrive. A stage is
 * due when its moment comes (a creature low on Stamina, or the start of a
 * round); the DM Screen says so and the GM presses Start or Not yet. Nothing
 * starts on its own, and a manual stage is never due, only startable.
 */

const FORM_ID_RE = /^[a-z0-9]{1,24}$/;
const str = (v) => (typeof v === 'string' ? v : '');
const int = (v) => (Number.isInteger(v) ? v : 0);

/**
 * The stages of an encounter, with references to rows it doesn't have
 * dropped. A Stamina stage whose creature is gone can only be started by hand.
 * @param {unknown} raw - the encounter's `stages`
 * @param {Set<string>} rowIds - the encounter's creature row ids
 */
export function parseStages(raw, rowIds) {
  const out = [];
  for (const s of Array.isArray(raw) ? raw.slice(0, 8) : []) {
    const id = str(s?.id);
    if (!id) continue;
    const w = s?.when ?? {};
    let when = { kind: 'manual' };
    if (w.kind === 'stamina' && rowIds.has(str(w.row)) && int(w.percent) >= 1 && int(w.percent) <= 99) {
      when = { kind: 'stamina', row: w.row, percent: w.percent };
    } else if (w.kind === 'round' && int(w.round) >= 2) {
      when = { kind: 'round', round: w.round };
    }
    const forms = (Array.isArray(s?.forms) ? s.forms : [])
      .filter((f) => rowIds.has(str(f?.row)) && (f.form === '' || FORM_ID_RE.test(str(f.form))))
      .map((f) => ({ row: f.row, form: f.form, formName: str(f.formName) }));
    const arrive = [...new Set((Array.isArray(s?.arrive) ? s.arrive : []).filter((r) => rowIds.has(str(r))))];
    if (!forms.length && !arrive.length) continue;
    out.push({ id, when, forms, arrive, how: s?.how === 'quiet' ? 'quiet' : 'reveal', note: str(s?.note) });
  }
  return out;
}

/**
 * The lowest Stamina, as a percent of its maximum, among a row's tokens on
 * the scene; null when none is placed or the system has no Stamina.
 * @param {Array<{rowId: string, value: number, max: number}>} tokens
 */
export function rowStaminaPercent(rowId, tokens) {
  let low = null;
  for (const t of tokens) {
    if (t.rowId !== rowId || !(Number(t.max) > 0) || !Number.isFinite(Number(t.value))) continue;
    const p = (100 * Number(t.value)) / Number(t.max);
    if (low === null || p < low) low = p;
  }
  return low;
}

/**
 * Whether a stage's moment has come.
 * @param {object} stage
 * @param {{round: number, tokens: Array<{rowId: string, value: number, max: number}>}} ctx
 */
export function stageMet(stage, ctx) {
  if (stage.when.kind === 'round') return Number(ctx.round) >= stage.when.round;
  if (stage.when.kind === 'stamina') {
    const p = rowStaminaPercent(stage.when.row, ctx.tokens);
    return p !== null && p <= stage.when.percent;
  }
  return false;
}

/**
 * What the DM Screen shows for each stage: 'started', 'due' or 'waiting'.
 * Not yet holds a due stage back until the next round of the fight.
 * @param {object[]} stages
 * @param {{round: number, tokens: Array}} ctx
 * @param {{started: string[], notYet: Object<string, number>}} memory - per fight
 */
export function stageStates(stages, ctx, memory) {
  const started = new Set(memory?.started ?? []);
  const notYet = memory?.notYet ?? {};
  return stages.map((s) => {
    if (started.has(s.id)) return 'started';
    if (!stageMet(s, ctx)) return 'waiting';
    if (Object.hasOwn(notYet, s.id) && Number(ctx.round) <= notYet[s.id]) return 'waiting';
    return 'due';
  });
}

/** Memory after a stage starts; it stays started for this fight. */
export function afterStart(memory, id) {
  const started = [...new Set([...(memory?.started ?? []), id])];
  return { started, notYet: { ...(memory?.notYet ?? {}) } };
}

/** Memory after Not yet: asked again from the next round. */
export function afterNotYet(memory, id, round) {
  return { started: [...(memory?.started ?? [])], notYet: { ...(memory?.notYet ?? {}), [id]: Number(round) || 0 } };
}

/** Indexes of the stages that became due since the last look, to announce once. */
export function newlyDue(before, now) {
  return now.flatMap((s, i) => (s === 'due' && before?.[i] !== 'due' ? [i] : []));
}
