/**
 * Pure builder for the Chronicle group in Foundry's scene controls.
 *
 * GMs get Chronicle Sync and the DM Screen; the Satchel and the Calendar are
 * for every user once the world is connected to Chronicle. The GM tools must
 * never reach a player: tools/test-scene-controls.mjs pins that.
 */

/**
 * Add the Chronicle group to `controls` (a v12 array or a v13+ keyed
 * object). Does nothing when the user gets no tools.
 *
 * @param {Array|object} controls - getSceneControlButtons' argument
 * @param {object} opts
 * @param {boolean} opts.isGM
 * @param {boolean} opts.notebook - the world is connected to Chronicle
 * @param {{dashboard: Function, dmScreen: Function, satchel: Function, calendar?: Function}} opts.run
 * @param {{dashboard: string, dmScreen: string, satchel: string, calendar?: string}} opts.titles - localized
 */
export function addChronicleControls(controls, { isGM, notebook, run, titles }) {
  const tools = [];
  if (isGM) {
    tools.push({
      name: 'dashboard',
      title: titles.dashboard,
      icon: 'fa-solid fa-rotate',
      button: true,
      run: run.dashboard,
    }, {
      // The DM Screen's opening rolls its die out of this button.
      name: 'dm-screen',
      title: titles.dmScreen,
      icon: 'fa-solid fa-dice-d20',
      button: true,
      run: run.dmScreen,
    });
  }
  if (notebook) {
    tools.push({
      name: 'satchel',
      title: titles.satchel,
      icon: 'fa-solid fa-briefcase',
      button: true,
      run: run.satchel,
    });
    if (run.calendar) {
      tools.push({
        name: 'calendar',
        title: titles.calendar,
        icon: 'fa-solid fa-calendar-days',
        button: true,
        run: run.calendar,
      });
    }
  }
  if (!tools.length) return;

  const icon = isGM ? 'fa-solid fa-rotate' : 'fa-solid fa-briefcase';
  // v13: controls and tools are keyed objects with onChange callback.
  // v12: controls and tools are arrays with onClick callback.
  if (Array.isArray(controls)) {
    controls.push({
      name: 'chronicle-sync',
      title: 'Chronicle Sync',
      icon,
      layer: 'controls',
      visible: true,
      tools: tools.map(({ run: fn, ...tool }) => ({ ...tool, onClick: fn })),
    });
  } else {
    // v13+ requires an activeTool, and the active tool is drawn pressed and
    // never fires on a press of its own button: "a toggle or button cannot be
    // an active tool" (foundryvtt/foundryvtt#12904). A hidden selectable
    // placeholder holds that slot, so every real button works and Foundry's
    // group-switch and re-render calls land on a tool that does nothing.
    controls['chronicle-sync'] = {
      name: 'chronicle-sync',
      title: 'Chronicle Sync',
      icon,
      visible: true,
      activeTool: IDLE_TOOL,
      tools: {
        [IDLE_TOOL]: { name: IDLE_TOOL, title: 'Chronicle Sync', icon, order: -1, visible: true, onChange: () => {} },
        ...Object.fromEntries(tools.map(({ run: fn, ...tool }, i) => [tool.name, { ...tool, order: i, onChange: pressedOnly(fn) }])),
      },
    };
  }
}

/**
 * The group's placeholder active tool. Kept visible so Foundry always finds
 * it; styles/chronicle-sync.css hides its button.
 */
export const IDLE_TOOL = 'chronicle-idle';

/**
 * Run a button tool on its press. Foundry calls a button's onChange with
 * `active` true when it is clicked; a deactivation call must not open it.
 * @param {Function} fn
 * @returns {Function}
 */
export function pressedOnly(fn) {
  return (_event, active) => (active === false ? undefined : fn());
}
