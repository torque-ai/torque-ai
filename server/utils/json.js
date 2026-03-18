'use strict';

const MAX_JSON_SIZE = 10 * 1024 * 1024; // 10MB

function safeJsonParse(str, defaultValue = null) {
  if (str === null || str === undefined) return defaultValue;
  if (typeof str !== 'string') return typeof str === 'object' ? str : defaultValue;
  const trimmed = str.trim();
  if (!trimmed.length) return defaultValue;
  if (trimmed.length > MAX_JSON_SIZE) return defaultValue;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return defaultValue;
  try {
    return JSON.parse(trimmed);
  } catch {
    return defaultValue;
  }
}

function safeJsonStringify(value, defaultValue = '{}') {
  try {
    return JSON.stringify(value);
  } catch {
    return defaultValue;
  }
}

module.exports = { safeJsonParse, safeJsonStringify };
