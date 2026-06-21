/**
 * Chronicle Sync — dialog helpers (Foundry V1 → V2 shim).
 *
 * Centralizes the module's confirm/prompt dialogs on
 * `foundry.applications.api.DialogV2` (Foundry v13+), falling back to the V1
 * `Dialog` global when DialogV2 is absent (v12 floor) OR if a DialogV2 call
 * throws. This:
 *   - removes the "V1 Application framework is deprecated" warnings on v13/v14,
 *   - keeps the module working when V1 `Dialog` is removed in v16,
 *   - preserves the declared v12 compatibility floor, and
 *   - gives one place to evolve dialog behavior.
 *
 * Both helpers treat dialog dismissal as "cancel" (confirm → false, prompt →
 * null) and never reject, so callers can use `if (!result) return;` uniformly.
 *
 * NOTE: the actual rendered dialog can only be exercised inside a live Foundry
 * client; the unit tests (tools/test-dialogs.mjs) pin the branching, the
 * option shape passed to DialogV2, the close→cancel coercion, and the V1
 * fallback. A v14 smoke-test of the real dialogs is still recommended.
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
