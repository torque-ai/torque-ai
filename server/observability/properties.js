'use strict';

const HEADER_PROPERTY_PREFIX = 'x-torque-property-';
const HEADER_USER = 'x-torque-user';
const HEADER_FEATURE = 'x-torque-feature';

const MAX_PROPERTY_COUNT = 64;
const MAX_PROPERTY_KEY_LENGTH = 64;
const MAX_PROPERTY_VALUE_LENGTH = 512;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function normalizeTorquePropertyKey(key) {
  if (key === null || key === undefined) return '';

  const normalized = String(key)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, MAX_PROPERTY_KEY_LENGTH)
    .replace(/^_+|_+$/g, '');

  return normalized;
}

function normalizeTorquePropertyValue(value) {
  if (value === null || value === undefined) {
    return { valid: false, value: null };
  }
  if (Array.isArray(value) || isObject(value)) {
    return { valid: false, value: null };
  }

  const type = typeof value;
  if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'bigint') {
    return { valid: false, value: null };
  }
  if (type === 'number' && !Number.isFinite(value)) {
    return { valid: false, value: null };
  }

  const normalized = (type === 'string' ? value.trim() : String(value))
    .slice(0, MAX_PROPERTY_VALUE_LENGTH);
  return { valid: true, value: normalized };
}

function addProperty(properties, rawKey, rawValue) {
  const key = normalizeTorquePropertyKey(rawKey);
  if (!key) return;

  const normalizedValue = normalizeTorquePropertyValue(rawValue);
  if (!normalizedValue.valid) return;

  if (!hasOwn(properties, key) && Object.keys(properties).length >= MAX_PROPERTY_COUNT) {
    return;
  }

  properties[key] = normalizedValue.value;
}

function getHeaderPropertyKey(headerName) {
  const lowerName = String(headerName || '').toLowerCase();
  if (lowerName.startsWith(HEADER_PROPERTY_PREFIX)) {
    return String(headerName).slice(HEADER_PROPERTY_PREFIX.length);
  }
  if (lowerName === HEADER_USER) {
    return 'user';
  }
  if (lowerName === HEADER_FEATURE) {
    return 'feature';
  }
  return null;
}

function addHeaderProperties(properties, headers) {
  if (!isObject(headers) || Array.isArray(headers)) return;

  for (const [headerName, headerValue] of Object.entries(headers)) {
    const propertyKey = getHeaderPropertyKey(headerName);
    if (!propertyKey) continue;
    if (Array.isArray(headerValue) || isObject(headerValue)) continue;
    addProperty(properties, propertyKey, headerValue);
  }
}

function addBodyProperties(properties, body) {
  const bodyProperties = body?.properties;
  if (!isObject(bodyProperties) || Array.isArray(bodyProperties)) return;

  for (const [key, value] of Object.entries(bodyProperties)) {
    addProperty(properties, key, value);
  }
}

function extractTorqueProperties(input = {}) {
  const { headers = {}, body = {} } = input || {};
  const properties = {};
  addHeaderProperties(properties, headers);
  addBodyProperties(properties, body);
  return properties;
}

module.exports = {
  HEADER_PROPERTY_PREFIX,
  MAX_PROPERTY_COUNT,
  MAX_PROPERTY_KEY_LENGTH,
  MAX_PROPERTY_VALUE_LENGTH,
  addBodyProperties,
  addHeaderProperties,
  addProperty,
  extractTorqueProperties,
  getHeaderPropertyKey,
  hasOwn,
  isObject,
  normalizeTorquePropertyKey,
  normalizeTorquePropertyValue,
};
