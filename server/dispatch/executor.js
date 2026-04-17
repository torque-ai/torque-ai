'use strict';

const { isDeepStrictEqual } = require('node:util');

function inferType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function typeMatches(expected, value) {
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'null') return value === null;
  return typeof value === expected;
}

function formatExpectedType(type) {
  return Array.isArray(type) ? type.join(' | ') : type;
}

function validateSchemaNode(schema, value, path) {
  const errors = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return errors;
  }

  if (schema.type !== undefined) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = expectedTypes.some((expected) => typeMatches(expected, value));
    if (!matches) {
      errors.push({
        path,
        message: `Expected ${formatExpectedType(schema.type)}, got ${inferType(value)}`,
      });
      return errors;
    }
  }

  if (schema.const !== undefined && !isDeepStrictEqual(schema.const, value)) {
    errors.push({
      path,
      message: `Value must equal ${JSON.stringify(schema.const)}`,
    });
    return errors;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => isDeepStrictEqual(candidate, value))) {
    errors.push({
      path,
      message: `Value must be one of: ${schema.enum.join(', ')}`,
    });
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path,
        message: `Expected minimum length ${schema.minLength}`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        path,
        message: `Expected maximum length ${schema.maxLength}`,
      });
    }
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern).test(value))) {
      errors.push({
        path,
        message: `Value does not match pattern ${schema.pattern}`,
      });
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({
        path,
        message: `Expected minimum value ${schema.minimum}`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({
        path,
        message: `Expected maximum value ${schema.maximum}`,
      });
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const nestedSchema of schema.allOf) {
      errors.push(...validateSchemaNode(nestedSchema, value, path));
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const branchErrors = schema.anyOf.map((nestedSchema) => validateSchemaNode(nestedSchema, value, path));
    const hasMatch = branchErrors.some((branch) => branch.length === 0);
    if (!hasMatch) {
      errors.push({
        path,
        message: 'Value must match at least one schema in anyOf',
      });
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const branchErrors = schema.oneOf.map((nestedSchema) => validateSchemaNode(nestedSchema, value, path));
    const matchCount = branchErrors.filter((branch) => branch.length === 0).length;
    if (matchCount !== 1) {
      errors.push({
        path,
        message: 'Value must match exactly one schema in oneOf',
      });
    }
  }

  if (Array.isArray(value)) {
    if (schema.items && !Array.isArray(schema.items)) {
      value.forEach((item, index) => {
        errors.push(...validateSchemaNode(schema.items, item, `${path}[${index}]`));
      });
    }
    return errors;
  }

  if (value === null || typeof value !== 'object') {
    return errors;
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = schema.properties || {};

  for (const key of required) {
    if (value[key] === undefined) {
      errors.push({
        path: `${path}.${key}`,
        message: 'Missing required property',
      });
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (value[key] === undefined) {
      continue;
    }
    errors.push(...validateSchemaNode(propertySchema, value[key], `${path}.${key}`));
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push({
          path: `${path}.${key}`,
          message: 'Unknown property is not allowed',
        });
      }
    }
  } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(...validateSchemaNode(schema.additionalProperties, value[key], `${path}.${key}`));
      }
    }
  }

  return errors;
}

function createExecutor({ registry }) {
  async function execute({ surface, action, context = {} }) {
    const registeredSurface = registry.getSurface(surface);
    if (!registeredSurface) return { ok: false, error: `unknown surface: ${surface}` };

    const validationErrors = validateSchemaNode(registeredSurface.schema, action, '$');
    if (validationErrors.length > 0) {
      return {
        ok: false,
        error: 'action schema validation failed',
        details: validationErrors,
      };
    }

    const handler = registeredSurface.handlers[action.actionName];
    if (!handler) return { ok: false, error: `unknown actionName: ${action.actionName}` };

    try {
      const result = await handler(action, context);
      return { ok: true, action_name: action.actionName, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `handler threw: ${message}` };
    }
  }

  return { execute };
}

module.exports = { createExecutor };
