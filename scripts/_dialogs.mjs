/**
 * Centralizes the module's confirm/prompt dialogs on
 * `foundry.applications.api.DialogV2` (Foundry v13+), falling back to the V1
 * `Dialog` global when DialogV2 is absent (v12 floor) or a DialogV2 call
 * throws — keeps the module working across the v12-v16 range in one place.
 *
 * Both helpers treat dismissal as "cancel" (confirm → false, prompt → null)
 * and never reject, so callers can use `if (!result) return;` uniformly.
 *
 * The rendered dialog can only be exercised in a live Foundry client;
 * `tools/test-dialogs.mjs` pins the branching and option shapes only.
 */

/** @returns {any|null} DialogV2 class if available (v13+), else null. */
function _DialogV2() {
  return globalThis.foundry?.applications?.api?.DialogV2 ?? null;
}

/**
 * Yes/No confirmation.
 * @param {{title?: string, content?: string, defaultYes?: boolean}} [opts]
 * @returns {Promise<boolean>} true only on explicit confirm; false on No/dismiss.
 */
export async function confirmDialog({ title = '', content = '', defaultYes = true } = {}) {
  const DialogV2 = _DialogV2();
  if (DialogV2?.confirm) {
    try {
      // Per Foundry docs: DialogV2.confirm resolves true (yes) / false (no), or
      // null when dismissed with rejectClose:false. Do NOT pass yes/no overrides
      // — that replaces their built-in true/false callbacks and the result would
      // become the button's action string instead of a boolean. `defaultYes`
      // (which button is focused) is a V1-only nicety, omitted here.
      const res = await DialogV2.confirm({
        window: { title },
        content,
        rejectClose: false, // dismissal resolves null instead of throwing
      });
      return res === true;
    } catch (err) {
      console.warn('Chronicle Sync [dialogs]: DialogV2.confirm failed; falling back to V1 Dialog', err);
    }
  }
  // v12 / safety fallback: V1 Dialog.confirm.
  const Dialog = globalThis.Dialog;
  if (Dialog?.confirm) {
    try {
      return (await Dialog.confirm({ title, content, defaultYes, rejectClose: false })) === true;
    } catch { return false; }
  }
  return false;
}

/**
 * A dialog with several buttons. Resolves to `{action, value}` for the button
 * pressed, where `value` is `read(root)` (the dialog's root HTMLElement), or
 * null when dismissed.
 * @param {{title?: string, content?: string, buttons: Array<{action: string, label: string, icon?: string, default?: boolean}>, read?: (root: any) => any}} opts
 * @returns {Promise<{action: string, value: any}|null>}
 */
export async function choiceDialog({ title = '', content = '', buttons = [], read } = {}) {
  const DialogV2 = _DialogV2();
  if (DialogV2?.wait) {
    try {
      const res = await DialogV2.wait({
        window: { title },
        content,
        rejectClose: false,
        // DialogV2.wait resolves to the pressed button's callback result.
        buttons: buttons.map((b) => ({
          action: b.action,
          label: b.label,
          icon: b.icon,
          default: !!b.default,
          callback: (_event, _button, dialog) => ({ action: b.action, value: read?.(dialog?.element ?? dialog) }),
        })),
      });
      return res && typeof res === 'object' ? res : null;
    } catch (err) {
      console.warn('Chronicle Sync [dialogs]: DialogV2.wait failed; falling back to V1 Dialog', err);
    }
  }
  const Dialog = globalThis.Dialog;
  if (!Dialog) return null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      new Dialog({
        title,
        content,
        buttons: Object.fromEntries(buttons.map((b) => [b.action, {
          label: b.label,
          icon: b.icon ? `<i class="${b.icon}"></i>` : undefined,
          callback: (html) => finish({ action: b.action, value: read?.(html?.[0] ?? html) }),
        }])),
        default: buttons.find((b) => b.default)?.action,
        close: () => finish(null),
      }).render({ force: true }); // V1 takes any truthy first argument as force
    } catch { finish(null); }
  });
}

/**
 * Prompt with custom form content. Resolves to the callback's return value, or
 * null/undefined if dismissed. The callback receives the dialog's root
 * HTMLElement (so existing `root.querySelector('form')` logic keeps working).
 * @param {{title?: string, content?: string, label?: string, callback: (root: any) => any}} opts
 * @returns {Promise<any>}
 */
export async function promptDialog({ title = '', content = '', label, callback } = {}) {
  const okLabel = label || globalThis.game?.i18n?.localize?.('Confirm') || 'OK';
  const DialogV2 = _DialogV2();
  if (DialogV2?.prompt) {
    try {
      return await DialogV2.prompt({
        window: { title },
        content,
        rejectClose: false,
        ok: {
          label: okLabel,
          // DialogV2 button callback signature is (event, button, dialog). Pass
          // the dialog's ROOT element so the caller's root.querySelector('form')
          // keeps working — note button.form is the form element itself, on
          // which querySelector('form') would return null.
          callback: (_event, _button, dialog) => callback?.(dialog?.element ?? dialog),
        },
      });
    } catch (err) {
      console.warn('Chronicle Sync [dialogs]: DialogV2.prompt failed; falling back to V1 Dialog', err);
    }
  }
  // v12 / safety fallback: V1 Dialog.prompt (callback receives jQuery; pass the
  // underlying element so the caller's querySelector logic is unchanged).
  const Dialog = globalThis.Dialog;
  if (Dialog?.prompt) {
    try {
      return await Dialog.prompt({
        title,
        content,
        label: okLabel,
        callback: (html) => callback?.(html?.[0] ?? html),
        rejectClose: false,
      });
    } catch { return null; }
  }
  return null;
}
