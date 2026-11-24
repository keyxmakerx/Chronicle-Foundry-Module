/**
 * Chronicle Sync - token art on hover
 *
 * Rest the cursor on a token and its actor's full picture appears beside the
 * cursor, following it until the cursor leaves the token. On a Draw Steel
 * world an NPC or monster token shows a small card instead, which holds what
 * this viewer may know (_npc-hover.mjs). The GM gets a token HUD button to
 * switch it off for that token, and a world setting for all of them; each
 * person has their own setting and an unbound shortcut to hide previews.
 * Rules live in _hover-art.mjs.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { HOVER_ART_FLAG, HOVER_DELAY_MS, hoverArtFor, previewPlace, tokenArt } from './_hover-art.mjs';
import { npcHoverCard } from './_npc-hover.mjs';
import { VILLAIN_FLAG, hasStatBlock, villainKey, villainMarks } from './_npc-looks.mjs';
import { isTalkLive } from './_npc-presence.mjs';
import { LINK_FLAG, TALK_FLAG } from './npc-presence.mjs';

const state = { el: null, img: null, card: null, timer: null, token: null, x: 0, y: 0 };

/** Settings; call on init. */
export function registerHoverArtSettings() {
  game.settings.register(MODULE_ID, 'hoverArtWorld', {
    name: 'CHRONICLE.HoverArt.World.Name',
    hint: 'CHRONICLE.HoverArt.World.Hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
    onChange: () => hidePreview(),
  });
  game.settings.register(MODULE_ID, 'hoverArt', {
    name: 'CHRONICLE.HoverArt.Client.Name',
    hint: 'CHRONICLE.HoverArt.Client.Hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
    onChange: () => hidePreview(),
  });
}

/** Flip this person's own switch (the shortcut). */
export async function toggleHoverArt() {
  const on = !game.settings.get(MODULE_ID, 'hoverArt');
  await game.settings.set(MODULE_ID, 'hoverArt', on);
  ui.notifications?.info(game.i18n.localize(on ? 'CHRONICLE.HoverArt.TurnedOn' : 'CHRONICLE.HoverArt.TurnedOff'));
}

/** Hooks; call on ready. */
export function registerHoverArt() {
  Hooks.on('hoverToken', _onHover);
  Hooks.on('renderTokenHUD', _onRenderHud);
  Hooks.on('canvasTearDown', hidePreview);
  Hooks.on('deleteToken', (doc) => { if (state.token?.document === doc) hidePreview(); });
  Hooks.on('updateToken', (doc) => { if (state.token?.document === doc) hidePreview(); });
  window.addEventListener('pointermove', _onMove, { passive: true });
  // A press starts a drag, a pan or a click: the preview would be in the way.
  window.addEventListener('pointerdown', hidePreview, { capture: true, passive: true });
  window.addEventListener('blur', hidePreview);
}

function _artFor(token) {
  const doc = token?.document;
  if (!doc) return '';
  return hoverArtFor({
    actorImg: token.actor?.img,
    tokenSrc: doc.texture?.src,
    flag: doc.getFlag(FLAG_SCOPE, HOVER_ART_FLAG),
    disposition: doc.disposition,
    hidden: doc.hidden,
    isGM: game.user.isGM,
    worldOn: game.settings.get(MODULE_ID, 'hoverArtWorld'),
    clientOn: game.settings.get(MODULE_ID, 'hoverArt'),
  });
}

/** The plain text of Draw Steel's own immunities or weaknesses line. */
function _plain(html) {
  if (!html) return '';
  const t = document.createElement('template');
  t.innerHTML = String(html);
  return t.content.textContent.trim();
}

/**
 * The card for a Draw Steel NPC or monster token, null when this viewer sees
 * nothing, or undefined for any other token (it shows its art as before).
 */
function _cardFor(token) {
  const actor = token?.actor;
  const doc = token?.document;
  if (game.system?.id !== 'draw-steel' || actor?.type !== 'npc' || !doc) return undefined;
  const sys = actor.system ?? {};
  const isGM = !!game.user.isGM;
  const localize = (k) => (k ? game.i18n.localize(k) : '');
  const flagOn = doc.getFlag(FLAG_SCOPE, HOVER_ART_FLAG) !== false;
  const on = flagOn && game.settings.get(MODULE_ID, 'hoverArtWorld') && game.settings.get(MODULE_ID, 'hoverArt');
  const statBlock = hasStatBlock({ staminaMax: sys.stamina?.max, abilityCount: actor.itemTypes?.ability?.length ?? 0 });

  let stats = null;
  if (isGM && statBlock) {
    const m = sys.monster ?? {};
    const iw = sys._getImmunitiesWeaknesses?.() ?? {};
    const statusNames = Object.fromEntries(Object.values(CONFIG.statusEffects ?? {}).map((e) => [e.id, localize(e.name)]));
    const combat = game.combat?.combatants?.some?.((c) => c.actor?.uuid === actor.uuid) ? game.combat : null;
    const abilities = (actor.itemTypes?.ability ?? [])
      .filter((i) => i.system?.type === 'villain' && !i.getFlag?.('draw-steel', 'hideInSheet'))
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
      .map((i) => ({ id: i.id, name: i.name }));
    const villain = villainMarks(abilities, combat?.getFlag(FLAG_SCOPE, VILLAIN_FLAG)?.[villainKey(actor.uuid)] ?? []);
    const charConfig = globalThis.ds?.CONFIG?.characteristics ?? {};
    stats = {
      sub: [
        game.i18n.format('CHRONICLE.HeroSheet.LevelN', { level: m.level ?? '' }),
        m.organizationLabel,
        m.roleLabel,
      ].filter(Boolean).join(' · '),
      stability: sys.combat?.stability,
      freeStrike: m.freeStrike,
      immunities: _plain(iw.immunities),
      weaknesses: _plain(iw.weaknesses),
      conditions: [...(actor.statuses ?? [])].map((id) => statusNames[id]).filter(Boolean),
      villain: { left: villain.left, total: villain.total, inFight: !!combat },
      characteristics: Object.entries(sys.characteristics ?? {}).map(([key, c]) => ({
        label: localize(charConfig[key]?.label) || key,
        value: c?.value,
      })),
    };
  }

  const neg = sys.negotiation;
  const motives = globalThis.ds?.CONFIG?.negotiation?.motivations ?? {};
  const labelOf = (slug) => localize(motives[slug]?.label) || slug;
  return npcHoverCard({
    isGM,
    isOwner: !!actor.isOwner,
    on,
    hidden: !!doc.hidden,
    disposition: doc.disposition,
    art: _artFor(token),
    name: token.name,
    displayName: doc.displayName,
    linked: !!(actor.getFlag(FLAG_SCOPE, 'entityId') || actor.getFlag(FLAG_SCOPE, LINK_FLAG)),
    talking: isTalkLive(doc.getFlag(FLAG_SCOPE, TALK_FLAG), Date.now()),
    statBlock,
    stamina: sys.stamina,
    stats,
    negotiation: neg ? {
      interest: neg.interest,
      patience: neg.patience,
      motivations: [...(neg.motivations ?? [])].map(labelOf),
      pitfalls: [...(neg.pitfalls ?? [])].map(labelOf),
    } : null,
    shown: actor.getFlag(FLAG_SCOPE, 'negotiationShown') === true,
  });
}

function _onHover(token, hovered) {
  try {
    if (!hovered) {
      if (state.token === token) hidePreview();
      return;
    }
    hidePreview();
    const card = _cardFor(token);
    if (card !== undefined) {
      if (!card) return;
      state.token = token;
      state.timer = setTimeout(() => (card.artOnly ? _show(card.art, '') : _showCard(card)), HOVER_DELAY_MS);
      return;
    }
    const src = _artFor(token);
    if (!src) return;
    state.token = token;
    state.timer = setTimeout(() => _show(src, token.name), HOVER_DELAY_MS);
  } catch (err) {
    console.warn('Chronicle Sync | Token art preview unavailable', err);
    hidePreview();
  }
}

function _show(src, name) {
  state.timer = null;
  if (!state.el) {
    const el = document.createElement('div');
    el.className = 'chronicle-hover-art';
    el.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img');
    img.alt = '';
    // A picture that fails to load just doesn't show.
    img.addEventListener('error', hidePreview);
    img.addEventListener('load', () => { if (state.el) _place(); });
    el.appendChild(img);
    document.body.appendChild(el);
    state.el = el;
    state.img = img;
  }
  state.img.title = name ?? '';
  state.img.src = src;
  state.el.hidden = false;
  state.el.classList.remove('cs-peek');
  void state.el.offsetWidth;
  state.el.classList.add('cs-peek');
  _place();
}

/** A child element with text, never HTML. */
function _el(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

/** Five pips, lit up to the meter's value. */
function _pips(pips) {
  const wrap = _el('span', 'cs-hc-pips');
  for (const on of pips) wrap.append(_el('i', on ? 'on' : ''));
  return wrap;
}

/** Draw the NPC card from its plain model (_npc-hover.mjs). */
function _showCard(card) {
  state.timer = null;
  if (state.el) state.el.hidden = true;
  const t = (k, data) => (data ? game.i18n.format(k, data) : game.i18n.localize(k));
  const root = _el('div', 'chronicle-hover-art cs-hover-card');
  root.setAttribute('aria-hidden', 'true');
  if (card.art) {
    const img = _el('img');
    img.alt = '';
    // A picture that fails to load leaves the card without it.
    img.addEventListener('error', () => img.remove());
    img.addEventListener('load', () => _place());
    img.src = card.art;
    root.append(img);
  }
  const body = _el('div', 'cs-hc-body');
  if (card.name) body.append(_el('b', 'cs-hc-name', card.name));
  for (const f of card.facts.filter((x) => x.key === 'sub')) body.append(_el('span', 'cs-hc-sub', f.value));
  if (card.state) body.append(_el('span', 'cs-hc-state', t(card.state)));
  if (card.stamina) {
    const st = _el('div', 'cs-hc-stam');
    st.dataset.band = card.stamina.band;
    const bar = _el('span', 'cs-hc-bar');
    const fill = _el('i');
    fill.style.width = `${card.stamina.fill}%`;
    bar.append(fill);
    if (card.stamina.windedAt !== null) {
      const mark = _el('u');
      mark.style.left = `${card.stamina.windedAt}%`;
      bar.append(mark);
    }
    st.append(_el('span', 'cs-hc-lab', t('CHRONICLE.NpcSheet.Hover.Stamina')), bar, _el('span', 'cs-hc-num', `${card.stamina.value} / ${card.stamina.max}`));
    body.append(st);
  }
  const facts = card.facts.filter((x) => x.key !== 'sub');
  if (facts.length) {
    const dl = _el('dl', 'cs-hc-facts');
    for (const f of facts) {
      const row = _el('div');
      if (f.data) row.append(_el('dd', 'cs-hc-wide', t(f.key, f.data)));
      else row.append(_el('dt', '', t(f.key)), _el('dd', '', f.value));
      dl.append(row);
    }
    body.append(dl);
  }
  if (card.chars.length) {
    const ul = _el('ul', 'cs-hc-chars');
    for (const c of card.chars) {
      const li = _el('li');
      li.append(_el('b', '', c.value < 0 ? `−${Math.abs(c.value)}` : `+${c.value}`), _el('span', '', c.label));
      ul.append(li);
    }
    body.append(ul);
  }
  if (card.meters) {
    const m = _el('div', 'cs-hc-meters');
    const meters = [['Interest', card.meters.interest, card.meters.interestPips], ['Patience', card.meters.patience, card.meters.patiencePips]];
    for (const [key, value, pips] of meters) {
      const row = _el('span', 'cs-hc-meter');
      row.append(_el('span', 'cs-hc-lab', t(`CHRONICLE.NpcSheet.${key}`)), _el('b', '', value ?? '–'), _pips(pips));
      m.append(row);
    }
    body.append(m);
  }
  if (card.motives.length) {
    const ul = _el('ul', 'cs-hc-motives');
    for (const mo of card.motives) {
      const li = _el('li', '', mo.label);
      li.dataset.kind = mo.kind;
      if (mo.kind === 'pitfall') li.prepend(_el('span', 'cs-hc-kind', t('CHRONICLE.NpcSheet.Kind.pitfall')));
      ul.append(li);
    }
    body.append(ul);
  }
  if (body.childElementCount) root.append(body);
  state.card?.remove();
  document.body.appendChild(root);
  state.card = root;
  root.classList.add('cs-peek');
  _place();
}

function _place() {
  const el = state.card && !state.card.hidden ? state.card : state.el;
  if (!el || el.hidden) return;
  const r = el.getBoundingClientRect();
  const { left, top } = previewPlace(
    { x: state.x, y: state.y },
    { width: r.width, height: r.height },
    { width: window.innerWidth, height: window.innerHeight },
  );
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function _onMove(e) {
  state.x = e.clientX;
  state.y = e.clientY;
  if ((state.el && !state.el.hidden) || state.card) _place();
}

/** Take the preview away, and forget a pending one. */
export function hidePreview() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.token = null;
  if (state.el) state.el.hidden = true;
  state.card?.remove();
  state.card = null;
}

/** GM: a HUD button switching this token's preview off and on. */
function _onRenderHud(hud, html) {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const col = root?.querySelector('.col.right');
  const token = hud?.object;
  if (!col || !token) return;
  col.querySelectorAll('.chronicle-hover-art-hud').forEach((el) => el.remove());
  // Only tokens with art to show get the button.
  if (!tokenArt({ actorImg: token.actor?.img, tokenSrc: token.document.texture?.src })) return;
  const on = token.document.getFlag(FLAG_SCOPE, HOVER_ART_FLAG) !== false;
  const tag = col.querySelector('.control-icon')?.tagName === 'BUTTON' ? 'button' : 'div';
  const el = document.createElement(tag);
  if (tag === 'button') el.type = 'button';
  el.className = `control-icon chronicle-hover-art-hud${on ? ' active' : ''}`;
  const label = game.i18n.localize(on ? 'CHRONICLE.HoverArt.HudOn' : 'CHRONICLE.HoverArt.HudOff');
  el.dataset.tooltip = label;
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-pressed', String(on));
  el.innerHTML = '<i class="fa-solid fa-image-portrait"></i>';
  el.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      if (on) await token.document.setFlag(FLAG_SCOPE, HOVER_ART_FLAG, false);
      else await token.document.unsetFlag(FLAG_SCOPE, HOVER_ART_FLAG);
      hud.render?.();
    } catch (err) {
      console.warn('Chronicle Sync | Token art switch failed', err);
      ui.notifications?.warn(game.i18n.localize('CHRONICLE.HoverArt.SwitchFailed'));
    }
  });
  col.appendChild(el);
}
