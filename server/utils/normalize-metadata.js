'use strict';

const { safeJsonParse } = require('./json');

/**
 * Normalize a metadata value to a plain object.
 * Handles null, undefined, arrays, objects, and JSON strings.
 * @param {*} value
 * @returns {Object}
 */
function normalizeMetadata(value) {
  if (value === null || value === undefined) {
    return {};
  }
  if (Array.isArray(value)) {
    return {};
  }
  if (typeof value === 'object') {
    return { ...value };
  }
  if (typeof value === 'string') {
    const parsed = safeJsonParse(value, null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...parsed };
    }
  }
  return {};
}

module.exports = { normalizeMetadata };
