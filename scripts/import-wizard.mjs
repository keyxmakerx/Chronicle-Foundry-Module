/**
 * Chronicle Sync - Import Wizard
 *
 * Multi-step guided import wizard for first-time Foundry-to-Chronicle setup.
 * Helps users scan their Foundry world, map content to Chronicle entity types,
 * assign tags, configure character mapping, and execute a bulk import.
 *
 * Launched from the "Setup Wizard" button in the sync dashboard Config tab.
 */

import { getSetting, setSetting } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Step definitions for the wizard.
 * Each step has a key, localization label key, icon, and a function that
 * determines whether the step should be shown based on detected capabilities.
 */
const STEPS = Object.freeze([
  { key: 'connect',    labelKey: 'CHRONICLE.Wizard.Steps.Connect',    icon: 'fa-solid fa-plug' },
  { key: 'scan',       labelKey: 'CHRONICLE.Wizard.Steps.Scan',       icon: 'fa-solid fa-magnifying-glass' },
  { key: 'types',      labelKey: 'CHRONICLE.Wizard.Steps.Types',      icon: 'fa-solid fa-layer-group' },
  { key: 'tags',       labelKey: 'CHRONICLE.Wizard.Steps.Tags',       icon: 'fa-solid fa-tags' },
  { key: 'characters', labelKey: 'CHRONICLE.Wizard.Steps.Characters', icon: 'fa-solid fa-users' },
  { key: 'calendar',   labelKey: 'CHRONICLE.Wizard.Steps.Calendar',   icon: 'fa-solid fa-calendar' },
  { key: 'maps',       labelKey: 'CHRONICLE.Wizard.Steps.Maps',       icon: 'fa-solid fa-map' },
  { key: 'review',     labelKey: 'CHRONICLE.Wizard.Steps.Review',     icon: 'fa-solid fa-clipboard-check' },
]);

/**
 * Heuristic mapping from common Foundry folder names to Chronicle entity type
 * slugs.  Keys are lowercased folder name substrings, values are Chronicle
 * type name patterns to match against.
 */
const FOLDER_TYPE_HINTS = Object.freeze({
  'npc':       'character',
  'character': 'character',
  'player':    'character',
  'pc':        'character',
  'person':    'character',
  'people':    'character',
  'location':  'location',
  'place':     'location',
  'region':    'location',
  'city':      'location',
  'town':      'location',
  'item':      'item',
  'equipment': 'item',
  'weapon':    'item',
  'armor':     'item',
  'gear':      'item',
  'lore':      'lore',
  'history':   'lore',
  'legend':    'lore',
  'faction':   'faction',
  'organizat': 'organisation',
  'guild':     'organisation',
  'quest':     'quest',
  'mission':   'quest',
  'event':     'event',
  'creature':  'creature',
  'monster':   'creature',
  'beast':     'creature',
  'race':      'race',
  'species':   'race',
  'religion':  'religion',
  'deity':     'religion',
  'god':       'religion',
});

/** Default color palette for auto-generated tags. */
const TAG_COLORS = Object.freeze([
  '#60a5fa', '#4ade80', '#fb923c', '#f87171', '#a78bfa',
  '#fbbf24', '#2dd4bf', '#f472b6', '#818cf8', '#34d399',
]);

export class ImportWizard extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {ImportWizard|null} */
  static _instance = null;

  static get instance() {
    if (!ImportWizard._instance) {
      ImportWizard._instance = new ImportWizard();
    }
    return ImportWizard._instance;
  }

  static DEFAULT_OPTIONS = {
    id: 'chronicle-import-wizard',
    classes: ['chronicle-wizard'],
    window: {
      title: 'CHRONICLE.Wizard.Title',
      icon: 'fa-solid fa-wand-magic-sparkles',
      resizable: true,
    },
    position: {
      width: 680,
      height: 720,
    },
    actions: {
      'wizard-next': ImportWizard.#onNext,
      'wizard-back': ImportWizard.#onBack,
      'wizard-cancel': ImportWizard.#onCancel,
      'wizard-start-import': ImportWizard.#onStartImport,
      'wizard-cancel-import': ImportWizard.#onCancelImport,
      'create-new-type': ImportWizard.#onCreateNewType,
      'save-new-type': ImportWizard.#onSaveNewType,
      'cancel-new-type': ImportWizard.#onCancelNewType,
      'remove-tag': ImportWizard.#onRemoveTag,
    },
  };

  static PARTS = {
    wizard: {
      template: 'modules/chronicle-sync/templates/import-wizard.hbs',
    },
  };

  constructor(options = {}) {
    super(options);

    /** @type {import('./sync-manager.mjs').SyncManager|null} */
    this._syncManager = null;

    /** Current step index (0-based). */
    this._currentStep = 0;

    /** Highest step the user has reached (enables back-navigation). */
    this._maxVisitedStep = 0;

    // ---- Per-step state ----

    /** Step 1 results: connection test and addon/system detection. */
    this._connectionStatus = null;

    /** Step 2 results: Foundry world document scan. */
    this._worldScan = null;

    /** Step 3: folder/category → Chronicle entity type mappings. */
    this._typeMappings = [];

    /** Step 3: inline "create new type" form state (null when closed). */
    this._newTypeForm = null;

    /** Step 4: planned tag creation and assignment. */
    this._tagPlan = [];

    /** Step 5: character actor import plan. */
    this._characterPlan = [];

    /** Step 6: calendar sync direction choice. */
    this._calendarDirection = 'skip';

    /** Step 7: scene ↔ Chronicle map link plan. */
    this._mapLinkPlan = [];

    /** Step 8: aggregated import plan built from all previous steps. */
    this._importPlan = null;

    /** Step 8: live import progress tracking. */
    this._importProgress = { total: 0, done: 0, errors: 0, log: [] };

    /** Whether an import is currently running. */
    this._importRunning = false;

    /** Flag to cancel a running import after the current item. */
    this._importCancelled = false;
  }

  /**
   * Bind the sync manager to the wizard.
   * @param {import('./sync-manager.mjs').SyncManager} syncManager
   */
  bind(syncManager) {
    this._syncManager = syncManager;
  }

  /** @returns {import('./api-client.mjs').ChronicleAPI|null} */
  get api() {
    return this._syncManager?.api ?? null;
  }

  // ---------------------------------------------------------------------------
  // Step logic helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the list of wizard steps with skip/enabled flags based on the
   * detection results from Step 1.
   * @returns {Array<{key: string, labelKey: string, icon: string, index: number, enabled: boolean}>}
   */
  _getSteps() {
    const addons = this._connectionStatus?.addons ?? [];
    const addonSlugs = new Set(addons.filter((a) => a.enabled).map((a) => a.slug));
    const hasSystemMatch = !!this._connectionStatus?.systemMatch;
    const hasCalendarModule = !!(
      game.modules.get('calendaria')?.active ||
      game.modules.get('foundryvtt-simple-calendar')?.active
    );

    return STEPS.map((step, index) => {
      let enabled = true;
      // Tags step: only if tags are available (tags are always-on widget, but
      // we still skip if the API doesn't support them yet).
      if (step.key === 'tags' && this._connectionStatus && !this._connectionStatus.tagsAvailable) {
        enabled = false;
      }
      // Characters step: only if a game system was matched.
      if (step.key === 'characters' && !hasSystemMatch) {
        enabled = false;
      }
      // Calendar step: only if calendar addon is enabled AND a calendar module is active.
      if (step.key === 'calendar') {
        const calendarAddon = addonSlugs.has('calendar') || addonSlugs.has('calendars');
        enabled = calendarAddon && hasCalendarModule;
      }
      // Maps step: only if maps addon is enabled.
      if (step.key === 'maps') {
        const mapsAddon = addonSlugs.has('maps') || addonSlugs.has('map');
        enabled = mapsAddon;
      }
      return { ...step, index, enabled };
    });
  }

  /**
   * Get the next enabled step index in a given direction.
   * @param {number} from - Current step index.
   * @param {number} delta - Direction (+1 or -1).
   * @returns {number|null} Next enabled step index, or null if at boundary.
   */
  _findNextStep(from, delta) {
    const steps = this._getSteps();
    let idx = from + delta;
    while (idx >= 0 && idx < steps.length) {
      if (steps[idx].enabled) return idx;
      idx += delta;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Step 1: Connect & Detect
  // ---------------------------------------------------------------------------

  /**
   * Test connection and discover Chronicle campaign capabilities.
   * Stores results in `_connectionStatus`.
   */
  async _runStep1() {
    if (!this.api) {
      this._connectionStatus = { connected: false, error: 'No API client available' };
      return;
    }

    const status = {
      connected: false,
      addons: [],
      entityTypes: [],
      systemMatch: null,
      tagsAvailable: false,
      error: null,
    };

    try {
      // Test basic connectivity by fetching entity types (always available).
      const types = await this.api.get('/entity-types');
      status.entityTypes = Array.isArray(types) ? types : (types?.data ?? types?.entity_types ?? []);
      status.connected = true;
    } catch (err) {
      status.error = err.message || 'Connection failed';
      this._connectionStatus = status;
      return;
    }

    // Discover addons (may 404 if endpoint not deployed yet).
    try {
      const addons = await this.api.getAddons();
      status.addons = Array.isArray(addons) ? addons : (addons?.data ?? []);
    } catch {
      // Addon discovery not available — continue without it.
    }

    // Discover tags availability.
    try {
      await this.api.getTags();
      status.tagsAvailable = true;
    } catch {
      // Tags API not available yet.
    }

    // Detect game system match.
    try {
      const systems = await this.api.get('/systems');
      const systemList = Array.isArray(systems) ? systems : (systems?.data ?? []);
      const foundrySystemId = game.system?.id;
      if (foundrySystemId) {
        status.systemMatch = systemList.find(
          (s) => s.identifier === foundrySystemId || s.slug === foundrySystemId
        ) ?? null;
      }
    } catch {
      // Systems endpoint not available.
    }

    this._connectionStatus = status;
  }

  // ---------------------------------------------------------------------------
  // Step 2: Scan Foundry World
  // ---------------------------------------------------------------------------

  /**
   * Scan all Foundry world documents, grouping by folder and filtering out
   * documents that are already synced with Chronicle.
   */
  _runStep2() {
    const scan = {
      journals: [],
      actors: [],
      scenes: [],
      items: [],
      folders: [],
    };

    // Journals: exclude those already linked to Chronicle entities.
    for (const j of game.journal.contents) {
      if (j.getFlag(FLAG_SCOPE, 'entityId')) continue;
      scan.journals.push({
        id: j.id,
        name: j.name,
        folder: j.folder?.name ?? null,
        folderId: j.folder?.id ?? null,
      });
    }

    // Actors: exclude those already linked.
    for (const a of game.actors.contents) {
      if (a.getFlag(FLAG_SCOPE, 'entityId')) continue;
      scan.actors.push({
        id: a.id,
        name: a.name,
        type: a.type,
        folder: a.folder?.name ?? null,
        folderId: a.folder?.id ?? null,
        img: a.img,
      });
    }

    // Scenes: exclude those already linked to Chronicle maps.
    for (const s of game.scenes.contents) {
      if (s.getFlag(FLAG_SCOPE, 'mapId')) continue;
      scan.scenes.push({
        id: s.id,
        name: s.name,
        folder: s.folder?.name ?? null,
        folderId: s.folder?.id ?? null,
        thumb: s.thumb,
      });
    }

    // World-level items.
    for (const i of game.items.contents) {
      if (i.getFlag(FLAG_SCOPE, 'entityId')) continue;
      scan.items.push({
        id: i.id,
        name: i.name,
        type: i.type,
        folder: i.folder?.name ?? null,
        folderId: i.folder?.id ?? null,
      });
    }

    // Collect unique folder names for categorization.
    const folderSet = new Map();
    for (const doc of [...scan.journals, ...scan.actors, ...scan.items]) {
      if (!doc.folder) continue;
      if (!folderSet.has(doc.folder)) {
        folderSet.set(doc.folder, { name: doc.folder, count: 0, docs: [] });
      }
      const entry = folderSet.get(doc.folder);
      entry.count++;
      entry.docs.push(doc);
    }
    // Add an "Ungrouped" virtual folder for documents without a folder.
    const ungrouped = [...scan.journals, ...scan.actors, ...scan.items].filter((d) => !d.folder);
    if (ungrouped.length > 0) {
      folderSet.set('__ungrouped__', { name: 'Ungrouped', count: ungrouped.length, docs: ungrouped });
    }
    scan.folders = [...folderSet.values()];

    this._worldScan = scan;
  }

  // ---------------------------------------------------------------------------
  // Step 3: Entity Type Mapping
  // ---------------------------------------------------------------------------

  /**
   * Build auto-suggested entity type mappings based on folder names and
   * Chronicle entity type names.
   */
  _buildAutoMappings() {
    if (!this._worldScan || !this._connectionStatus) return;

    const types = this._connectionStatus.entityTypes;
    this._typeMappings = this._worldScan.folders.map((folder) => {
      const folderLower = folder.name.toLowerCase();
      let suggestedTypeId = null;

      // Try heuristic matching.
      for (const [hint, typePattern] of Object.entries(FOLDER_TYPE_HINTS)) {
        if (folderLower.includes(hint)) {
          const match = types.find(
            (t) => (t.name || '').toLowerCase().includes(typePattern)
              || (t.slug || '').toLowerCase().includes(typePattern)
          );
          if (match) {
            suggestedTypeId = match.id;
            break;
          }
        }
      }

      return {
        folderName: folder.name,
        count: folder.count,
        docs: folder.docs,
        chronicleTypeId: suggestedTypeId,
        isNew: false,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Step 4: Tag Assignment
  // ---------------------------------------------------------------------------

  /**
   * Build suggested tags from folder names and actor types.
   */
  _buildTagPlan() {
    if (!this._worldScan) return;

    const tagNames = new Set();
    // Folder names as tags.
    for (const folder of this._worldScan.folders) {
      if (folder.name !== 'Ungrouped') tagNames.add(folder.name);
    }
    // Actor types as tags.
    const actorTypes = new Set(this._worldScan.actors.map((a) => a.type));
    for (const t of actorTypes) {
      if (t) tagNames.add(t.charAt(0).toUpperCase() + t.slice(1));
    }

    let colorIdx = 0;
    this._tagPlan = [...tagNames].map((name) => ({
      name,
      color: TAG_COLORS[colorIdx++ % TAG_COLORS.length],
      source: 'auto',
      enabled: true,
    }));
  }

  // ---------------------------------------------------------------------------
  // Step 8: Review & Import
  // ---------------------------------------------------------------------------

  /**
   * Aggregate all step states into a flat import plan.
   * @returns {Array<{type: string, label: string, data: object, status: string}>}
   */
  _buildImportPlan() {
    const plan = [];

    // Tags to create (Step 4).
    for (const tag of this._tagPlan.filter((t) => t.enabled)) {
      plan.push({
        type: 'create-tag',
        label: `Create tag "${tag.name}"`,
        data: { name: tag.name, color: tag.color },
        status: 'pending',
      });
    }

    // Entities to push (Step 3 mappings).
    for (const mapping of this._typeMappings) {
      if (!mapping.chronicleTypeId) continue;
      for (const doc of mapping.docs) {
        plan.push({
          type: 'push-journal',
          label: `Push "${doc.name}" as ${mapping.folderName}`,
          data: { journalId: doc.id, entityTypeId: mapping.chronicleTypeId },
          status: 'pending',
        });
      }
    }

    // Characters to push (Step 5).
    for (const char of this._characterPlan.filter((c) => c.include)) {
      plan.push({
        type: 'push-actor',
        label: `Push character "${char.name}"`,
        data: { actorId: char.actorId, isPC: char.isPC },
        status: 'pending',
      });
    }

    // Map links (Step 7).
    for (const link of this._mapLinkPlan.filter((l) => l.chronicleMapId)) {
      plan.push({
        type: 'link-map',
        label: `Link scene "${link.sceneName}" to Chronicle map`,
        data: { sceneId: link.sceneId, mapId: link.chronicleMapId },
        status: 'pending',
      });
    }

    this._importPlan = plan;
    this._importProgress = { total: plan.length, done: 0, errors: 0, log: [] };
    return plan;
  }

  /**
   * Execute the import plan, calling sync module methods for each item.
   * Updates progress and re-renders after each item.
   */
  async _executeImport() {
    if (!this._importPlan || !this._syncManager) return;

    this._importRunning = true;
    this._importCancelled = false;
    this.render({ force: true });

    let batchCount = 0;
    for (const item of this._importPlan) {
      if (this._importCancelled) {
        item.status = 'skipped';
        continue;
      }

      item.status = 'importing';
      try {
        await this._syncManager.runWizardImport(item);
        item.status = 'done';
        this._importProgress.done++;
        this._importProgress.log.push({ type: 'success', message: item.label });
      } catch (err) {
        item.status = 'error';
        this._importProgress.errors++;
        this._importProgress.log.push({
          type: 'error',
          message: `${item.label}: ${err.message}`,
        });
      }

      // Yield to event loop periodically to prevent UI freezing.
      if (++batchCount % 10 === 0) {
        this.render({ force: true });
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    this._importRunning = false;
    if (!this._importCancelled) {
      await setSetting('wizardCompleted', true);
    }
    this.render({ force: true });
  }

  // ---------------------------------------------------------------------------
  // Data / Render
  // ---------------------------------------------------------------------------

  /** @override */
  async _prepareContext(options = {}) {
    const steps = this._getSteps();
    const current = steps[this._currentStep] ?? steps[0];
    const enabledSteps = steps.filter((s) => s.enabled);
    const currentEnabledIndex = enabledSteps.findIndex((s) => s.index === this._currentStep);

    return {
      steps: steps.map((s) => ({
        ...s,
        stepNumber: s.index + 1,
        isCurrent: s.index === this._currentStep,
        isCompleted: s.index < this._currentStep && s.enabled,
        isSkipped: !s.enabled,
      })),
      currentStep: this._currentStep,
      currentStepKey: current.key,
      currentStepDisplay: currentEnabledIndex + 1,
      totalSteps: enabledSteps.length,
      isFirstStep: this._findNextStep(this._currentStep, -1) === null,
      isLastStep: current.key === 'review',

      // Step-specific data.
      connection: this._connectionStatus,
      worldScan: this._worldScan,
      typeMappings: this._typeMappings,
      entityTypes: this._connectionStatus?.entityTypes ?? [],
      newTypeForm: this._newTypeForm,
      tagPlan: this._tagPlan,
      characterPlan: this._characterPlan,
      calendarDirection: this._calendarDirection,
      mapLinkPlan: this._mapLinkPlan,
      importPlan: this._importPlan,
      importProgress: this._importProgress,
      importRunning: this._importRunning,
    };
  }

  /** @override */
  _onRender(context, options) {
    const el = this.element;
    if (!el) return;

    // Step panel show/hide.
    for (const panel of el.querySelectorAll('.wizard-step')) {
      panel.classList.toggle('active', panel.dataset.step === String(this._currentStep));
    }

    // Step 3: entity type mapping dropdowns.
    for (const select of el.querySelectorAll('.wizard-type-select')) {
      select.addEventListener('change', (e) => {
        const idx = Number(e.target.dataset.mappingIndex);
        if (this._typeMappings[idx]) {
          const val = e.target.value;
          if (val === '__new__') {
            this._newTypeForm = { mappingIndex: idx, name: '', icon: 'fa-solid fa-circle' };
            this.render({ force: true });
          } else {
            this._typeMappings[idx].chronicleTypeId = val ? Number(val) : null;
          }
        }
      });
    }

    // Step 4: tag toggle checkboxes.
    for (const cb of el.querySelectorAll('.wizard-tag-toggle')) {
      cb.addEventListener('change', (e) => {
        const idx = Number(e.target.dataset.tagIndex);
        if (this._tagPlan[idx]) {
          this._tagPlan[idx].enabled = e.target.checked;
        }
      });
    }

    // Step 5: character include checkboxes and PC/NPC toggles.
    for (const cb of el.querySelectorAll('.wizard-char-include')) {
      cb.addEventListener('change', (e) => {
        const idx = Number(e.target.dataset.charIndex);
        if (this._characterPlan[idx]) {
          this._characterPlan[idx].include = e.target.checked;
        }
      });
    }
    for (const cb of el.querySelectorAll('.wizard-char-pc')) {
      cb.addEventListener('change', (e) => {
        const idx = Number(e.target.dataset.charIndex);
        if (this._characterPlan[idx]) {
          this._characterPlan[idx].isPC = e.target.checked;
        }
      });
    }

    // Step 6: calendar direction radio buttons.
    for (const radio of el.querySelectorAll('input[name="calendar-direction"]')) {
      radio.addEventListener('change', (e) => {
        this._calendarDirection = e.target.value;
      });
    }

    // Step 7: map link selects.
    for (const select of el.querySelectorAll('.wizard-map-select')) {
      select.addEventListener('change', (e) => {
        const idx = Number(e.target.dataset.mapIndex);
        if (this._mapLinkPlan[idx]) {
          this._mapLinkPlan[idx].chronicleMapId = e.target.value || null;
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /**
   * Advance the wizard by the given number of steps (+1 or -1), skipping
   * disabled steps.
   * @param {number} delta
   */
  async _advanceStep(delta) {
    if (this._importRunning) return;

    // Run step logic when advancing forward.
    if (delta > 0) {
      await this._onLeaveStep(this._currentStep);
    }

    const next = this._findNextStep(this._currentStep, delta);
    if (next === null) return;

    this._currentStep = next;
    if (next > this._maxVisitedStep) this._maxVisitedStep = next;

    // Run entry logic for the new step.
    if (delta > 0) {
      await this._onEnterStep(this._currentStep);
    }

    this.render({ force: true });
  }

  /**
   * Called when leaving a step (forward only). Validates and processes data.
   * @param {number} stepIndex
   */
  async _onLeaveStep(stepIndex) {
    const step = STEPS[stepIndex];
    if (!step) return;
    // No validation needed in scaffolding — will be added per-step in later PRs.
  }

  /**
   * Called when entering a new step. Initializes step-specific data.
   * @param {number} stepIndex
   */
  async _onEnterStep(stepIndex) {
    const step = STEPS[stepIndex];
    if (!step) return;

    switch (step.key) {
      case 'connect':
        await this._runStep1();
        break;
      case 'scan':
        this._runStep2();
        break;
      case 'types':
        if (this._typeMappings.length === 0) this._buildAutoMappings();
        break;
      case 'tags':
        if (this._tagPlan.length === 0) this._buildTagPlan();
        break;
      case 'characters':
        if (this._characterPlan.length === 0) this._buildCharacterPlan();
        break;
      case 'maps':
        if (this._mapLinkPlan.length === 0) await this._buildMapLinkPlan();
        break;
      case 'review':
        this._buildImportPlan();
        break;
    }
  }

  /**
   * Build the character import plan from scanned actors.
   */
  _buildCharacterPlan() {
    if (!this._worldScan) return;
    this._characterPlan = this._worldScan.actors.map((a) => ({
      actorId: a.id,
      name: a.name,
      type: a.type,
      img: a.img,
      isPC: a.type === 'character' || a.type === 'hero',
      include: true,
    }));
  }

  /**
   * Build the map linking plan by matching Foundry scenes with Chronicle maps.
   */
  async _buildMapLinkPlan() {
    if (!this._worldScan || !this.api) return;

    let chronicleMaps = [];
    try {
      const result = await this.api.get('/maps');
      chronicleMaps = Array.isArray(result) ? result : (result?.data ?? result?.maps ?? []);
    } catch {
      // Maps endpoint not available.
    }

    this._mapLinkPlan = this._worldScan.scenes.map((scene) => {
      // Auto-match by name.
      const nameLower = scene.name.toLowerCase();
      const match = chronicleMaps.find(
        (m) => (m.name || '').toLowerCase() === nameLower
      );
      return {
        sceneId: scene.id,
        sceneName: scene.name,
        chronicleMapId: match?.id ?? null,
        chronicleMaps,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  static #onNext() {
    this._advanceStep(1);
  }

  static #onBack() {
    this._advanceStep(-1);
  }

  static #onCancel() {
    this.close();
  }

  static #onStartImport() {
    this._executeImport();
  }

  static #onCancelImport() {
    this._importCancelled = true;
  }

  static #onCreateNewType(event, target) {
    const idx = Number(target.dataset.mappingIndex);
    this._newTypeForm = { mappingIndex: idx, name: '', icon: 'fa-solid fa-circle' };
    this.render({ force: true });
  }

  static async #onSaveNewType() {
    if (!this._newTypeForm || !this.api) return;
    const { mappingIndex, name } = this._newTypeForm;
    if (!name.trim()) return;

    try {
      const created = await this.api.createEntityType({
        name: name.trim(),
        name_plural: name.trim() + 's',
      });
      // Add to known entity types and select it.
      this._connectionStatus.entityTypes.push(created);
      if (this._typeMappings[mappingIndex]) {
        this._typeMappings[mappingIndex].chronicleTypeId = created.id;
        this._typeMappings[mappingIndex].isNew = true;
      }
    } catch (err) {
      ui.notifications.error(`Failed to create entity type: ${err.message}`);
    }

    this._newTypeForm = null;
    this.render({ force: true });
  }

  static #onCancelNewType() {
    this._newTypeForm = null;
    this.render({ force: true });
  }

  static #onRemoveTag(event, target) {
    const idx = Number(target.dataset.tagIndex);
    if (this._tagPlan[idx]) {
      this._tagPlan.splice(idx, 1);
      this.render({ force: true });
    }
  }
}
