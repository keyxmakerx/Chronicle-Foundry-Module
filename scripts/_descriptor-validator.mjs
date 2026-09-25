/**
 * Shared validation logic for `chronicle-package.json`, used by both CI
 * (`tools/check-package-descriptor.mjs`) and the Foundry runtime
 * (`scripts/module.mjs::Hooks.once('ready')`, fetching the deployed
 * descriptor). The runtime check is defense-in-depth for drift CI didn't
 * catch (hand-edited release zip, ad-hoc deployment).
 *
 * Pure — no Foundry/Node imports. Callers pass the parsed descriptor +
 * module.json and format the structured result for their own surface.
 */

/**
 * Run every validation rule against the descriptor + module.json pair.
 *
 * @param {object|null} descriptor - Parsed chronicle-package.json (object) or null if not present / parse error.
 * @param {object|null} moduleJson - Parsed module.json (object) or null if not present / parse error.
 * @returns {{errors: string[], warnings: string[]}} Structured result. `errors.length === 0` means valid.
 */
export function validateDescriptor(descriptor, moduleJson) {
  const errors = [];
  const warnings = [];

  if (descriptor == null) {
    errors.push('chronicle-package.json: missing or unparseable');
    return { errors, warnings };
  }
  if (moduleJson == null) {
    errors.push('module.json: missing or unparseable (required for cross-reference checks)');
    return { errors, warnings };
  }

  // --- Schema version ---
  if (descriptor.schemaVersion !== 1) {
    errors.push(`chronicle-package.json: schemaVersion must be 1 (got ${JSON.stringify(descriptor.schemaVersion)})`);
  }

  // --- package.id matches module.json#/id ---
  const descriptorId = descriptor?.package?.id;
  const moduleId = moduleJson?.id;
  if (!descriptorId) {
    errors.push('chronicle-package.json: package.id is required');
  } else if (descriptorId !== moduleId) {
    errors.push(`chronicle-package.json: package.id (${JSON.stringify(descriptorId)}) does not match module.json#/id (${JSON.stringify(moduleId)})`);
  }

  // --- package.kind ---
  if (descriptor?.package?.kind !== 'foundry-module') {
    errors.push(`chronicle-package.json: package.kind must be "foundry-module" (got ${JSON.stringify(descriptor?.package?.kind)})`);
  }

  // --- package.moduleJsonPath (only the field shape is checked here; file
  //     existence is a CI-only concern) ---
  const moduleJsonPathField = descriptor?.package?.moduleJsonPath;
  if (!moduleJsonPathField || typeof moduleJsonPathField !== 'string') {
    errors.push('chronicle-package.json: package.moduleJsonPath is required (string)');
  }

  // --- serving.rewriteFields ---
  const rewriteFields = descriptor?.serving?.rewriteFields;
  if (!Array.isArray(rewriteFields) || rewriteFields.length === 0) {
    errors.push('chronicle-package.json: serving.rewriteFields must be a non-empty array');
  } else {
    for (const field of rewriteFields) {
      if (!(field in moduleJson)) {
        warnings.push(`chronicle-package.json: serving.rewriteFields references "${field}" which is not present in module.json — Chronicle will create the field when serving, which may be intentional but is worth noting`);
      }
    }
  }

  // --- serving.manifestEndpoint + downloadEndpoint ---
  validateEndpoint(errors, descriptor, 'manifestEndpoint', descriptor?.serving?.manifestEndpoint);
  validateEndpoint(errors, descriptor, 'downloadEndpoint', descriptor?.serving?.downloadEndpoint);

  // --- serving.perCampaignSignedToken ---
  if (typeof descriptor?.serving?.perCampaignSignedToken !== 'boolean') {
    errors.push('chronicle-package.json: serving.perCampaignSignedToken must be boolean');
  }

  // --- serving.zipContentRoot ---
  if (typeof descriptor?.serving?.zipContentRoot !== 'string') {
    errors.push('chronicle-package.json: serving.zipContentRoot must be a string (empty string means zip root)');
  }

  return { errors, warnings };
}

/**
 * Validate one of the endpoint URL-template fields.
 * @param {string[]} errors - Mutable error list.
 * @param {object} descriptor - The full descriptor (used to check perCampaignSignedToken).
 * @param {string} field - Field name (`manifestEndpoint` | `downloadEndpoint`) for error messages.
 * @param {*} value - The field's value.
 */
function validateEndpoint(errors, descriptor, field, value) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    errors.push(`chronicle-package.json: serving.${field} must be a path starting with "/" (got ${JSON.stringify(value)})`);
    return;
  }
  if (!value.includes('{campaign_id}')) {
    errors.push(`chronicle-package.json: serving.${field} must include the {campaign_id} placeholder`);
  }
  if (descriptor?.serving?.perCampaignSignedToken === true && !value.includes('{token}')) {
    errors.push(`chronicle-package.json: serving.${field} must include the {token} placeholder when perCampaignSignedToken is true`);
  }
}
