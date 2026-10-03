/**
 * Pure builder for the Chronicle group in Foundry's scene controls.
 *
 * GMs get the Sync Dashboard and Sync Calendar; the Notebook is for every
 * user once the world is connected to Chronicle. The GM tools must never
 * reach a player: tools/test-scene-controls.mjs pins that.
 */

/**
 * Add the Chronicle group to `controls` (a v12 array or a v13+ keyed
 * object). Does nothing when the user gets no tools.
 *
 * @param {Array|object} controls - getSceneControlButtons' argument
 * @param {object} opts
 * @param {boolean} opts.isGM
 * @param {boolean} opts.notebook - the world is connected to Chronicle
 * @param {{dashboard: Function, syncCalendar: Function, notebook: Function}} opts.run
 * @param {{syncCalendar: string, notebook: string}} opts.titles - localized
 */
export function addChronicleControls(controls, { isGM, notebook, run, titles }) {
  const tools = [];
  if (isGM) {
    tools.push({
      name: 'dashboard',
      title: 'Open Chronicle Sync Dashboard',
      icon: 'fa-solid fa-rotate',
      button: true,
      run: run.dashboard,
    }, {
      name: 'sync-calendar',
      title: titles.syncCalendar,
      icon: 'fa-solid fa-calendar-days',
      button: true,
      run: run.syncCalendar,
    });
  }
  if (notebook) {
    tools.push({
      name: 'notebook',
      title: titles.notebook,
      icon: 'fa-solid fa-book',
      button: true,
      run: run.notebook,
    });
  }
  if (!tools.length) return;

  const icon = isGM ? 'fa-solid fa-rotate' : 'fa-solid fa-book';
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
      tools: Object.fromEntries(tools.map(({ run: fn, ...tool }) => [tool.name, { ...tool, onChange: fn }])),
    };
  }
}
