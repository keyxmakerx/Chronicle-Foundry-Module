/**
 * The shared empty / can't-reach block, built with DOM APIs so any text is
 * inert (see "SHARED STATES" in the stylesheet for the look).
 */

/**
 * @param {string} icon - Font Awesome name without the `fa-` prefix
 * @param {string} title
 * @param {string} [text] - one-sentence explanation
 * @param {boolean} [error] - draw it as a failure
 * @param {Document} [doc]
 * @returns {HTMLElement}
 */
export function stateBlock(icon, title, text = '', error = false, doc = globalThis.document) {
  const box = doc.createElement('div');
  box.className = error ? 'cs-state is-error' : 'cs-state';
  if (error) box.setAttribute('role', 'alert');
  const i = doc.createElement('i');
  i.className = `fa-solid fa-${icon}`;
  i.setAttribute('aria-hidden', 'true');
  const b = doc.createElement('b');
  b.textContent = title;
  box.append(i, b);
  if (text) {
    const p = doc.createElement('p');
    p.textContent = text;
    box.append(p);
  }
  return box;
}
