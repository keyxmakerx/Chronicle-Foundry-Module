/**
 * The small menus on the Chronicle hero sheet: the look picker and the
 * portrait menu. A list of buttons under the control that opened it, built
 * inside the sheet's own window so the sheet's colours, theme and motion
 * level apply. Keyboard: arrows, Home and End move, Enter or Space picks,
 * Escape closes and returns focus. A pick, a click elsewhere, Tab or the
 * sheet redrawing closes it; Tab then moves on from the control that opened it.
 */

import { menuFocus } from './_hero-looks.mjs';

const OPEN = new WeakMap();

/**
 * Close the menu open in a sheet, if any. Focus inside the menu goes back to
 * the control that opened it, so Tab moves on from there and a closing menu
 * never drops focus to the page.
 * @param {HTMLElement|null|undefined} root  the sheet's element
 * @param {{focus?: boolean}} [opts]  return focus to the control even if it was elsewhere
 * @returns {HTMLElement|null}  that control, when focus was inside the menu
 */
export function closeHeroMenu(root, { focus = false } = {}) {
  const open = root && OPEN.get(root);
  if (!open) return null;
  OPEN.delete(root);
  open.teardown();
  const { menu, anchor } = open;
  const hadFocus = menu.contains(root.ownerDocument?.activeElement);
  anchor?.setAttribute?.('aria-expanded', 'false');
  menu.classList.add('cs-menu-out');
  let gone = false;
  const remove = () => {
    if (gone) return;
    gone = true;
    menu.remove();
  };
  menu.addEventListener('animationend', remove, { once: true });
  setTimeout(remove, 250);
  if (focus || hadFocus) anchor?.focus?.();
  return hadFocus ? anchor : null;
}

/**
 * Open a menu under `anchor`.
 * @param {HTMLElement} root  the sheet's element
 * @param {HTMLElement} anchor  the control that opens it
 * @param {object} spec
 * @param {string} spec.label  the menu's accessible name
 * @param {string} [spec.heading]  a line above the rows
 * @param {{label: string, note?: string|null, tag?: string|null, icon?: string, checked?: boolean, disabled?: boolean, separatorBefore?: boolean}[]} spec.rows
 *   text already localized
 * @param {(index: number, event: Event) => void} spec.onPick
 * @param {'start'|'end'} [spec.align]  which edge of the anchor the menu lines up with
 */
export function openHeroMenu(root, anchor, { label, heading, rows, onPick, align = 'start' }) {
  if (OPEN.get(root)?.anchor === anchor) {
    closeHeroMenu(root, { focus: true });
    return;
  }
  closeHeroMenu(root);
  const doc = root.ownerDocument;
  const menu = doc.createElement('div');
  menu.className = 'cs-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  if (heading) {
    const h = doc.createElement('p');
    h.className = 'cs-menu-head';
    h.setAttribute('role', 'presentation');
    h.textContent = heading;
    menu.append(h);
  }
  const items = rows.map((row, index) => {
    if (row.separatorBefore) {
      const hr = doc.createElement('hr');
      hr.setAttribute('role', 'separator');
      menu.append(hr);
    }
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'cs-menu-item';
    b.tabIndex = -1;
    const radio = typeof row.checked === 'boolean';
    b.setAttribute('role', radio ? 'menuitemradio' : 'menuitem');
    if (radio) b.setAttribute('aria-checked', String(row.checked));
    // Disabled rows stay focusable, so their note can be read.
    if (row.disabled) b.setAttribute('aria-disabled', 'true');
    if (row.icon) {
      const i = doc.createElement('i');
      i.className = `${row.icon} cs-menu-icon`;
      i.setAttribute('inert', '');
      b.append(i);
    }
    const text = doc.createElement('span');
    text.className = 'cs-menu-text';
    const name = doc.createElement('span');
    name.className = 'cs-menu-label';
    name.textContent = row.label;
    if (row.tag) {
      const tag = doc.createElement('span');
      tag.className = 'cs-menu-tag';
      tag.textContent = row.tag;
      name.append(' ', tag);
    }
    text.append(name);
    if (row.note) {
      const note = doc.createElement('small');
      note.textContent = row.note;
      text.append(note);
    }
    b.append(text);
    b.addEventListener('click', (event) => {
      if (row.disabled) return;
      closeHeroMenu(root, { focus: true });
      onPick(index, event);
    });
    menu.append(b);
    return b;
  });

  root.append(menu);
  place(root, anchor, menu, align);
  anchor.setAttribute('aria-expanded', 'true');

  const focusAt = (i) => items[i]?.focus();
  const current = () => items.indexOf(doc.activeElement);
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeHeroMenu(root, { focus: true });
      return;
    }
    if (event.key === 'Tab') {
      // Focus goes back to the button first, so Tab moves on from it.
      closeHeroMenu(root);
      return;
    }
    const next = menuFocus(current(), event.key, items.map(() => false));
    if (next !== current()) {
      event.preventDefault();
      focusAt(next);
    }
  };
  const onDown = (event) => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) closeHeroMenu(root);
  };
  menu.addEventListener('keydown', onKey);
  doc.addEventListener('pointerdown', onDown, true);
  OPEN.set(root, {
    menu,
    anchor,
    teardown: () => doc.removeEventListener('pointerdown', onDown, true),
  });
  const checked = rows.findIndex((r) => r.checked);
  focusAt(checked >= 0 ? checked : 0);
}

/** Under the anchor, inside the window; above it when there is no room below. */
function place(root, anchor, menu, align) {
  const r = root.getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const gap = 6;
  let top = a.bottom - r.top + gap;
  if (top + m.height > r.height && a.top - r.top - gap - m.height >= 0) top = a.top - r.top - gap - m.height;
  let left = align === 'end' ? a.right - r.left - m.width : a.left - r.left;
  left = Math.max(gap, Math.min(left, r.width - m.width - gap));
  menu.style.top = `${Math.max(gap, top)}px`;
  menu.style.left = `${left}px`;
  menu.style.maxHeight = `${Math.max(120, r.height - Math.max(gap, top) - gap)}px`;
}
