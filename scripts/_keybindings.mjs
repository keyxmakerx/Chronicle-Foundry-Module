/**
 * Keyboard shortcuts for Chronicle's windows. They ship with no keys bound:
 * each person picks their own under Configure Controls, so the module never
 * takes a key another module or the user already relies on.
 */

/**
 * The shortcuts, in the order Configure Controls lists them. `gm` ones are
 * restricted to GMs; `connected` ones do nothing until the world is
 * connected to Chronicle.
 */
export const SHORTCUTS = [
  { action: 'openDashboard', gm: true, connected: false },
  { action: 'openDMScreen', gm: true, connected: true },
  { action: 'openSatchel', gm: false, connected: true },
  { action: 'openCalendar', gm: false, connected: true },
];

/**
 * @param {object} keybindings - game.keybindings
 * @param {string} namespace - the module id
 * @param {object} p
 * @param {Record<string, Function>} p.run - one opener per action
 * @param {() => boolean} p.connected - whether the world reaches Chronicle now
 */
export function registerShortcuts(keybindings, namespace, { run, connected }) {
  for (const { action, gm, connected: needsChronicle } of SHORTCUTS) {
    const label = action.charAt(0).toUpperCase() + action.slice(1);
    keybindings.register(namespace, action, {
      // Keys, not text: translations load after init, and Configure Controls
      // localizes them when it draws.
      name: `CHRONICLE.Keybindings.${label}.Name`,
      hint: `CHRONICLE.Keybindings.${label}.Hint`,
      editable: [],
      restricted: gm,
      onDown: () => {
        if (needsChronicle && !connected()) return false;
        run[action]?.();
        return true;
      },
    });
  }
}
