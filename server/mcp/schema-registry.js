'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../logger').child({ component: 'schema-registry' });

const SCHEMA_DIR = path.join(__dirname, 'schemas', 'v1');
const schemas = new Map();

function loadSchemas() {
  schemas.clear();

  if (!fs.existsSync(SCHEMA_DIR)) {
    return 0;
  }

  const files = fs.readdirSync(SCHEMA_DIR).filter((file) => file.endsWith('.json'));

  for (const file of files) {
    const absolutePath = path.join(SCHEMA_DIR, file);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    } catch (error) {
      logger.warn(`[schema-registry] Failed to parse schema file ${file}: ${error.message}`);
      continue;
    }
    const schemaId = path.basename(file, '.json');
    schemas.set(schemaId, parsed);
  }

  return schemas.size;
}

function inferType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function typeMatches(expected, value) {
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === expected;
}

function validateObject(schema, payload, pathPrefix = '$') {
  const errors = [];

  if (!typeMatches(schema.type || 'object', payload)) {
    errors.push({
      path: pathPrefix,
      message: `Expected ${schema.type || 'object'}, got ${inferType(payload)}`,
    });
    return errors;
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = schema.properties || {};

  for (const key of required) {
    if (payload[key] === undefined) {
      errors.push({ path: `${pathPrefix}.${key}`, message: 'Missing required property' });
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(payload)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push({ path: `${pathPrefix}.${key}`, message: 'Unknown property is not allowed' });
      }
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (payload[key] === undefined) continue;
    const value = payload[key];

    if (propertySchema.type && !typeMatches(propertySchema.type, value)) {
      errors.push({
        path: `${pathPrefix}.${key}`,
        message: `Expected ${propertySchema.type}, got ${inferType(value)}`,
      });
      continue;
    }

    if (propertySchema.minLength && typeof value === 'string' && value.length < propertySchema.minLength) {
      errors.push({
        path: `${pathPrefix}.${key}`,
        message: `Expected minimum length ${propertySchema.minLength}`,
      });
    }

    if (propertySchema.enum && !propertySchema.enum.includes(value)) {
      errors.push({
        path: `${pathPrefix}.${key}`,
        message: `Value must be one of: ${propertySchema.enum.join(', ')}`,
      });
    }
  }

  return errors;
}

function validate(schemaId, payload) {
  const schema = schemas.get(schemaId);
  if (!schema) {
    return {
      valid: false,
      errors: [{ path: '$', message: `Schema not found: ${schemaId}` }],
    };
  }

  const errors = validateObject(schema, payload, '$');
  return {
    valid: errors.length === 0,
    errors,
  };
}

function getLoadedSchemaIds() {
  return [...schemas.keys()];
}

module.exports = {
  loadSchemas,
  validate,
  getLoadedSchemaIds,
  SCHEMA_DIR,
};
