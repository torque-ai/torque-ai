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
    if (schema.pattern !== undefined) {
      try {
        if (!(new RegExp(schema.pattern).test(value))) {
          errors.push({
            path,
            message: `Value does not match pattern ${schema.pattern}`,
          });
        }
      } catch {
        // Ignore invalid schema regex definitions and leave validation to callers.
      }
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

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function escapeDoubleQuotedText(value) {
  return String(value)
    .replace(/\\'/g, '\'')
    .replace(/"/g, '\\"');
}

function normalizeSingleQuotedJson(text) {
  if (typeof text !== 'string' || !text.includes('\'')) {
    return text;
  }

  let normalized = text;
  normalized = normalized.replace(
    /([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g,
    (_, prefix, key) => `${prefix}"${escapeDoubleQuotedText(key)}":`,
  );
  normalized = normalized.replace(
    /((?::|,|\[)\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(?=\s*[,}\]])/g,
    (_, prefix, value) => `${prefix}"${escapeDoubleQuotedText(value)}"`,
  );
  return normalized;
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function selectBestBranch(value, schemas, matchMode) {
  const candidates = schemas.map((branch) => {
    const coerced = coerceToSchema(cloneJsonValue(value), branch);
    const errors = validateSchemaNode(branch, coerced, '$');
    return { coerced, errors };
  });

  const valid = candidates.filter((candidate) => candidate.errors.length === 0);
  if (matchMode === 'oneOf' && valid.length === 1) {
    return valid[0].coerced;
  }
  if (matchMode === 'anyOf' && valid.length > 0) {
    return valid[0].coerced;
  }

  candidates.sort((left, right) => left.errors.length - right.errors.length);
  return candidates[0] ? candidates[0].coerced : value;
}

function coerceScalar(value, schema) {
  if (schema.type === 'array') {
    const values = Array.isArray(value) ? value : [value];
    return schema.items ? values.map((item) => coerceToSchema(item, schema.items)) : values;
  }

  if (schema.type === 'number' && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }

  if (schema.type === 'integer' && typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }

  if (schema.type === 'boolean' && typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }

  return value;
}

function coerceObject(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const output = { ...value };
  const properties = schema.properties || {};

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (output[key] !== undefined) {
      output[key] = coerceToSchema(output[key], propertySchema);
    }
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    for (const key of Object.keys(output)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        output[key] = coerceToSchema(output[key], schema.additionalProperties);
      }
    }
  }

  return output;
}

function coerceToSchema(value, schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return value;
  }

  if (Array.isArray(schema.allOf)) {
    let current = value;
    for (const nestedSchema of schema.allOf) {
      current = coerceToSchema(current, nestedSchema);
    }
    return current;
  }

  if (Array.isArray(schema.oneOf)) {
    return selectBestBranch(value, schema.oneOf, 'oneOf');
  }

  if (Array.isArray(schema.anyOf)) {
    return selectBestBranch(value, schema.anyOf, 'anyOf');
  }

  if (schema.type === 'object' || schema.properties) {
    return coerceObject(value, schema);
  }

  return coerceScalar(value, schema);
}

function extractBalancedJsonish(text, startIndex, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let quoteChar = null;
  let escapeNext = false;

  for (let index = startIndex; index < text.length; index++) {
    const char = text[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if ((char === '"' || char === '\'') && (!inString || quoteChar === char)) {
      inString = !inString;
      quoteChar = inString ? char : null;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === openChar) {
      depth += 1;
      continue;
    }

    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1).trim();
      }
    }
  }

  return null;
}

function extractJsonish(rawOutput) {
  if (typeof rawOutput !== 'string') {
    return null;
  }

  const text = rawOutput.trim();
  if (!text) {
    return null;
  }

  const fenced = text.match(/```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/i);
  if (fenced) {
    return fenced[1].trim();
  }

  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const hasObject = objectStart !== -1;
  const hasArray = arrayStart !== -1;

  if (!hasObject && !hasArray) {
    return null;
  }

  const useObject = hasObject && (!hasArray || objectStart < arrayStart);
  if (useObject) {
    return extractBalancedJsonish(text, objectStart, '{', '}');
  }

  return extractBalancedJsonish(text, arrayStart, '[', ']');
}

function formatErrors(errors) {
  return errors.map((error) => `${error.path}: ${error.message}`);
}

function parseAlignedToSchema(rawOutput, schema) {
  let parsed;

  if (typeof rawOutput === 'string') {
    const cleaned = extractJsonish(rawOutput);
    if (!cleaned) {
      return { ok: false, errors: ['no JSON-ish content found'] };
    }

    parsed = safeJsonParse(cleaned);
    if (parsed === undefined) {
      parsed = safeJsonParse(normalizeSingleQuotedJson(cleaned));
    }
    if (parsed === undefined) {
      return { ok: false, errors: ['JSON parse failed'] };
    }
  } else if (rawOutput && typeof rawOutput === 'object') {
    parsed = rawOutput;
  } else {
    return { ok: false, errors: ['no JSON-ish content found'] };
  }

  const coerced = coerceToSchema(parsed, schema);
  const errors = formatErrors(validateSchemaNode(schema, coerced, '$'));
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: coerced };
}

module.exports = {
  parseAlignedToSchema,
  extractJsonish,
};
