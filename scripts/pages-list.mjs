/**
 * The Pages list's own controls: the search box, folding a type, the row and
 * type menus, and the checkboxes of select mode. They change what is on
 * screen without asking the window to draw itself again, so typing in the
 * search box never loses a letter. Everything is built with createElement.
 */

import { matchesSearch } from './_page-rows.mjs';

const MENU_CLASS = 'cs-pages-menu';

/** Close the open row or type menu, if any. Returns the button that opened it. */
export function closePagesMenu(root) {
  const menu = root?.querySelector(`.${MENU_CLASS}`);
  if (!menu) return null;
  const opener = root.querySelector('[data-pages-menu-open]');
  opener?.removeAttribute('data-pages-menu-open');
  opener?.setAttribute('aria-expanded', 'false');
  menu._release?.();
  menu.remove();
  return opener ?? null;
}

/**
 * Open a menu under a row's or a type's "more" button. Each item is a button
 * carrying a `data-action`, so the window's own click handling runs it; the
 * menu only has to close itself afterwards.
 *
 * @param {HTMLElement} root - the window's element
 * @param {HTMLElement} opener - the button that was pressed
 * @param {Array<{action: string, label: string, data?: Record<string, string>}>} items
 */
export function openPagesMenu(root, opener, items) {
  const wasOpen = opener.hasAttribute('data-pages-menu-open');
  closePagesMenu(root);
  if (wasOpen || !items.length) return;

  const menu = document.createElement('div');
  menu.className = MENU_CLASS;
  menu.setAttribute('role', 'menu');
  if (opener.getAttribute('aria-label')) menu.setAttribute('aria-label', opener.getAttribute('aria-label'));
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.dataset.action = item.action;
    for (const [key, value] of Object.entries(item.data ?? {})) button.dataset[key] = value;
    button.textContent = item.label;
    menu.append(button);
  }
  root.append(menu);

  // Kept inside the window, which clips what leaves it: under the button
  // when there is room, above it when there is not. Offsets are measured
  // from whatever the menu is positioned against.
  const frame = root.getBoundingClientRect();
  const base = (menu.offsetParent ?? root).getBoundingClientRect();
  const at = opener.getBoundingClientRect();
  const below = at.bottom + 4 + menu.offsetHeight <= frame.bottom - 8;
  const top = below ? at.bottom + 4 : at.top - 4 - menu.offsetHeight;
  const left = Math.max(frame.left + 8, at.right - menu.offsetWidth);
  menu.style.top = `${Math.max(frame.top + 8, top) - base.top}px`;
  menu.style.left = `${left - base.left}px`;

  opener.setAttribute('data-pages-menu-open', '');
  opener.setAttribute('aria-expanded', 'true');

  const entries = () => [...menu.querySelectorAll('[role="menuitem"]')];
  const close = (refocus) => {
    const from = closePagesMenu(root);
    if (refocus) from?.focus();
  };
  menu.addEventListener('keydown', (event) => {
    const list = entries();
    const index = list.indexOf(document.activeElement);
    const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: list.length - 1 }[event.key];
    if (move !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      list[(move + list.length) % list.length]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    }
  });
  // An item's click is handled by the window first; the menu then goes.
  menu.addEventListener('click', () => setTimeout(() => close(true), 0));

  const outside = (event) => {
    if (menu.contains(event.target) || opener.contains(event.target)) return;
    close(false);
  };
  const scrolled = () => close(false);
  document.addEventListener('pointerdown', outside, true);
  root.addEventListener('scroll', scrolled, true);
  menu._release = () => {
    document.removeEventListener('pointerdown', outside, true);
    root.removeEventListener('scroll', scrolled, true);
  };

  entries()[0]?.focus();
}

/** Show the rows and types that match the search, and say so when none do. */
export function applyPagesSearch(root, search) {
  const list = root?.querySelector('[data-pages-list]');
  if (!list) return;
  const searching = !!String(search || '').trim();
  let shown = 0;
  for (const group of list.querySelectorAll('[data-page-group]')) {
    let matches = 0;
    for (const row of group.querySelectorAll('[data-page-row]')) {
      const match = matchesSearch(row.dataset.pageName, search);
      row.hidden = !match;
      if (match) matches++;
    }
    group.hidden = searching && matches === 0;
    // A search looks inside folded types too.
    const rows = group.querySelector('[data-page-rows]');
    if (rows) rows.hidden = !searching && group.dataset.folded === 'true';
    shown += matches;
  }
  const none = list.querySelector('[data-pages-nomatch]');
  if (none) none.hidden = !searching || shown > 0;
}

/** Fold or unfold one type's rows. Returns whether it is now folded. */
export function togglePagesFold(root, typeId) {
  const group = root?.querySelector(`[data-page-group][data-type-id="${CSS.escape(String(typeId))}"]`);
  if (!group) return false;
  const folded = group.dataset.folded !== 'true';
  group.dataset.folded = String(folded);
  group.querySelector('[data-action="pages-fold"]')?.setAttribute('aria-expanded', String(!folded));
  return folded;
}

/** Show a row as being brought up to date, before the work starts. */
export function markCatchingUp(root, ids, label) {
  for (const id of ids) {
    const row = root?.querySelector(`[data-page-row][data-page-id="${CSS.escape(String(id))}"]`);
    if (!row) continue;
    row.className = row.className.replace(/\bis-[a-z-]+/g, '').trim() + ' is-catching-up';
    const word = row.querySelector('.cs-page-state');
    if (word) { word.textContent = label; word.removeAttribute('title'); }
    for (const control of row.querySelectorAll('.cs-page-btn, [data-action="pages-menu"]')) control.hidden = true;
  }
}

/**
 * Wire the list after each draw.
 *
 * @param {HTMLElement} root - the window's element
 * @param {object} host
 * @param {() => string} host.getSearch
 * @param {(value: string) => void} host.setSearch
 * @param {Set<string>} host.selected - page ids ticked in select mode
 * @param {(count: number) => string} host.selectedLabel
 */
export function wirePagesList(root, host) {
  closePagesMenu(root);
  const list = root.querySelector('[data-pages-list]');
  if (!list) return;

  const search = root.querySelector('[data-pages-search]');
  if (search) {
    // A draw that lands while the GM is typing must not put older text back.
    if (search.value !== host.getSearch()) search.value = host.getSearch();
    search.addEventListener('input', () => {
      host.setSearch(search.value);
      applyPagesSearch(root, search.value);
    });
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !search.value) return;
      event.preventDefault();
      event.stopPropagation();
      search.value = '';
      host.setSearch('');
      applyPagesSearch(root, '');
    });
  }
  applyPagesSearch(root, host.getSearch());

  const count = root.querySelector('[data-pages-selected-count]');
  const all = root.querySelector('[data-pages-select-all]');
  const boxes = () => [...list.querySelectorAll('[data-page-row]:not([hidden]) [data-page-select]')];
  const sync = () => {
    if (count) count.textContent = host.selectedLabel(host.selected.size);
    for (const control of root.querySelectorAll('[data-pages-needs-selection]')) control.disabled = host.selected.size === 0;
    if (all) {
      const visible = boxes();
      all.checked = visible.length > 0 && visible.every((box) => box.checked);
    }
  };
  for (const box of list.querySelectorAll('[data-page-select]')) {
    box.addEventListener('change', () => {
      if (box.checked) host.selected.add(box.dataset.entityId);
      else host.selected.delete(box.dataset.entityId);
      box.closest('[data-page-row]')?.classList.toggle('is-selected', box.checked);
      sync();
    });
  }
  all?.addEventListener('change', () => {
    for (const box of boxes()) {
      box.checked = all.checked;
      if (all.checked) host.selected.add(box.dataset.entityId);
      else host.selected.delete(box.dataset.entityId);
      box.closest('[data-page-row]')?.classList.toggle('is-selected', all.checked);
    }
    sync();
  });
  sync();
}
