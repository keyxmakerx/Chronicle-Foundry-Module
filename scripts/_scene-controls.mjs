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
    // v13 requires activeTool even for button-only controls, and does not
    // use the v12 `layer` property. See foundryvtt/foundryvtt#12803.
    controls['chronicle-sync'] = {
      name: 'chronicle-sync',
      title: 'Chronicle Sync',
      icon,
      visible: true,
      activeTool: tools[0].name,
      tools: Object.fromEntries(tools.map(({ run: fn, ...tool }) => [tool.name, { ...tool, onChange: pressedOnly(tool.name, fn) }])),
    };
  }
}

/**
 * Run a button tool only when the GM pressed that button. Foundry v13+ also
 * calls a group's active tool's onChange when switching control groups and
 * re-rendering the toolbar, which opened the dashboard on unrelated clicks.
 * A real press arrives as an event from inside `[data-tool="<name>"]`.
 * @param {string} name
 * @param {Function} fn
 * @returns {Function}
 */
export function pressedOnly(name, fn) {
  return (event, active) => {
    if (active === false) return undefined;
    const button = event?.target?.closest?.('[data-tool]');
    if (button?.dataset?.tool !== name) return undefined;
    return fn();
  };
}
