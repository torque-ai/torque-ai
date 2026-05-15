'use strict';

const MAX_VALUE_LENGTH = 2000;
const FENCE_BEGIN = '--- BEGIN EXTERNAL WEBHOOK DATA ---';
const FENCE_END = '--- END EXTERNAL WEBHOOK DATA ---';
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Fullwidth ASCII range U+FF01–U+FF5E maps to ASCII U+0021–U+007E.
// Replace fullwidth braces that could visually mimic {{ / }} template delimiters.
const FULLWIDTH_CONFUSABLE_MAP = {
  '\uFF5B': '{', // fullwidth left curly bracket
  '\uFF5D': '}', // fullwidth right curly bracket
  '\uFF1C': '<', // fullwidth less-than
  '\uFF1E': '>', // fullwidth greater-than
};
const CONFUSABLE_REGEX = new RegExp(
  '[' + Object.keys(FULLWIDTH_CONFUSABLE_MAP).join('') + ']',
  'g'
);

/**
 * Sanitize a single webhook payload substitution value.
 *
 * Contract:
 * - Strips null bytes (\0).
 * - Normalizes unicode fullwidth confusables (e.g. fullwidth `{` / `}`) to their
 *   ASCII equivalents so they cannot visually mimic template delimiters.
 * - Collapses sequences of 3+ newlines to 2.
 * - Truncates the result to 2000 characters.
 * - Non-string values are coerced via JSON.stringify before processing.
 *
 * @param {*} value - The substitution value (string or other).
 * @returns {string} The cleaned string, safe for storage and prompt construction.
 */
function sanitizePayloadValue(value) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (value === null || value === undefined) {
    return '';
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  // Strip null bytes
  text = text.replace(/\0/g, '');

  // Normalize fullwidth confusables to ASCII equivalents
  text = text.replace(CONFUSABLE_REGEX, (ch) => FULLWIDTH_CONFUSABLE_MAP[ch] || ch);

  // Collapse 3+ consecutive newlines to exactly 2
  text = text.replace(/\n{3,}/g, '\n\n');

  // Truncate to max length
  if (text.length > MAX_VALUE_LENGTH) {
    text = text.slice(0, MAX_VALUE_LENGTH);
  }

  return text;
}

/**
 * Sanitize a full webhook request payload object.
 *
 * Contract:
 * - Iterates own-enumerable keys of the input object.
 * - Rejects keys matching `__proto__`, `constructor`, or `prototype` (prototype-pollution guard).
 * - Calls `sanitizePayloadValue` on each leaf value.
 * - Recurses one level into nested plain objects (non-array, non-null objects).
 * - Returns a new shallow-cloned object with sanitized values. Never mutates the input.
 * - Non-object input returns an empty object.
 *
 * @param {Object} payload - The webhook req.body payload object.
 * @returns {Object} A new object with all values sanitized.
 */
function sanitizePayloadObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }

  const result = {};

  for (const key of Object.keys(payload)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      continue;
    }

    const value = payload[key];

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse one level into nested plain objects
      const nested = {};
      for (const nestedKey of Object.keys(value)) {
        if (PROTOTYPE_POLLUTION_KEYS.has(nestedKey)) {
          continue;
        }
        nested[nestedKey] = sanitizePayloadValue(value[nestedKey]);
      }
      result[key] = nested;
    } else {
      result[key] = sanitizePayloadValue(value);
    }
  }

  return result;
}

/**
 * Wrap a fully-substituted description string in a delimiter fence that marks it
 * as external/untrusted data for downstream prompt construction.
 *
 * Contract:
 * - The fence format is deterministic and machine-parseable by `server/audit/prompt-builder.js`
 *   and `server/factory/architect-prompt.js` so they can distinguish webhook-originated
 *   content from operator-authored prompt text.
 * - Non-string input is coerced to string.
 *
 * @param {string} text - A fully-substituted description string.
 * @returns {string} The text wrapped in BEGIN/END EXTERNAL WEBHOOK DATA delimiters.
 */
function fenceWebhookContent(text) {
  const safeText = typeof text === 'string' ? text : String(text ?? '');
  return `\n${FENCE_BEGIN}\n${safeText}\n${FENCE_END}\n`;
}

module.exports = {
  sanitizePayloadValue,
  sanitizePayloadObject,
  fenceWebhookContent,
};
