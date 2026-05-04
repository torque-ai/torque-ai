'use strict';

const { isSafeRegex } = require('../utils/safe-regex');
const { getAnnotations } = require('../tool-annotations');
const { applyBehavioralTags } = require('../tool-behavioral-tags');

const VALID_NAMESPACES = new Set(['task', 'workflow', 'provider', 'system']);

function cloneSchema(schema) {
  return JSON.parse(JSON.stringify(schema));
}

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

function camelToSnake(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/([A-Z])/g, (match, char, index) => (index > 0 ? '_' : '') + char.toLowerCase());
}

function toBehavioralAnnotationSnapshot(tool) {
  return {
    readOnlyHint: Boolean(tool.readOnlyHint),
    destructiveHint: Boolean(tool.destructiveHint),
    idempotentHint: Boolean(tool.idempotentHint),
    openWorldHint: Boolean(tool.openWorldHint),
  };
}

function cloneAnnotations(annotations) {
  return annotations ? { ...annotations } : undefined;
}

function inferAnnotationName(fullName, metadata = {}) {
  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  if (typeof safeMetadata.annotationName === 'string' && safeMetadata.annotationName.trim()) {
    return safeMetadata.annotationName.trim();
  }

  const parts = String(fullName || '').trim().split('.');
  if (parts.length === 3 && parts[0] === 'torque') {
    const [, namespace, action] = parts;
    return `${camelToSnake(action)}_${namespace}`;
  }

  return camelToSnake(parts[parts.length - 1] || fullName);
}

function normalizeBehavioralMetadata(fullName, metadata = {}) {
  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  const explicitHints = safeMetadata.behavioralHints || safeMetadata.annotations;
  const hintSource = explicitHints && typeof explicitHints === 'object'
    ? explicitHints
    : getAnnotations(inferAnnotationName(fullName, safeMetadata));
  const taggedTool = applyBehavioralTags({ name: fullName }, hintSource);
  const annotations = toBehavioralAnnotationSnapshot(taggedTool);

  return {
    description: typeof safeMetadata.description === 'string' ? safeMetadata.description : '',
    annotations,
    ...annotations,
  };
}

function cloneToolEntry(entry) {
  return {
    schema: cloneSchema(entry.schema),
    handler: entry.handler,
    description: entry.description,
    annotations: cloneAnnotations(entry.annotations),
    readOnlyHint: entry.readOnlyHint,
    destructiveHint: entry.destructiveHint,
    idempotentHint: entry.idempotentHint,
    openWorldHint: entry.openWorldHint,
  };
}

function normalizeNamespace(namespace) {
  if (typeof namespace !== 'string' || !namespace.trim()) {
    throw new TypeError('Tool namespace must be a non-empty string');
  }

  const trimmed = namespace.trim();
  const normalized = trimmed.startsWith('torque.') ? trimmed.slice('torque.'.length) : trimmed;
  if (!VALID_NAMESPACES.has(normalized)) {
    throw new Error(`Unsupported tool namespace: ${namespace}`);
  }

  return normalized;
}

function normalizeToolName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new TypeError('Tool name must be a non-empty string');
  }
  return name.trim();
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

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
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
    if (schema.pattern !== undefined && isSafeRegex(schema.pattern) && !(new RegExp(schema.pattern).test(value))) {
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

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  registerTool(namespace, name, schema, handler, metadata = {}) {
    const normalizedNamespace = normalizeNamespace(namespace);
    const normalizedName = normalizeToolName(name);

    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new TypeError('Tool schema must be a JSON schema object');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('Tool handler must be a function');
    }

    const fullName = `torque.${normalizedNamespace}.${normalizedName}`;
    if (this.tools.has(fullName)) {
      throw new Error(`Tool already registered: ${fullName}`);
    }

    const behavioralMetadata = normalizeBehavioralMetadata(fullName, metadata);
    this.tools.set(fullName, {
      namespace: normalizedNamespace,
      schema: cloneSchema(schema),
      handler,
      ...behavioralMetadata,
    });
    return fullName;
  }

  lookupTool(fullName) {
    return this.getTool(fullName);
  }

  getTool(fullName) {
    const entry = this.tools.get(fullName);
    if (!entry) {
      return null;
    }

    return cloneToolEntry(entry);
  }

  unregisterTool(fullName) {
    return this.tools.delete(normalizeToolName(fullName));
  }

  listTools(namespace) {
    const normalizedNamespace = namespace === undefined ? null : normalizeNamespace(namespace);

    return [...this.tools.entries()]
      .filter(([, entry]) => !normalizedNamespace || entry.namespace === normalizedNamespace)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => ({
        name,
        ...cloneToolEntry(entry),
      }));
  }

  validateParams(fullName, params) {
    const entry = this.tools.get(fullName);
    if (!entry) {
      return {
        valid: false,
        errors: [{ path: '$', message: `Tool not registered: ${fullName}` }],
      };
    }

    const errors = validateSchemaNode(entry.schema, params, '$');
    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

module.exports = {
  cloneSchema,
  inferType,
  typeMatches,
  formatExpectedType,
  normalizeNamespace,
  normalizeToolName,
  validateSchemaNode,
  ToolRegistry,
};
