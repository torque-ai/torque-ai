'use strict';

const ROUTE_STATUSES = Object.freeze([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

const ERROR_CODES = Object.freeze([
  'validation_error',
  'unauthorized',
  'provider_not_found',
  'model_not_found',
  'task_not_found',
  'stream_not_supported',
  'rate_limit_exceeded',
  'timeout',
  'not_implemented',
  'provider_unavailable',
  // Extended codes used by control-plane handlers and v2-dispatch:
  'operation_failed',  // Generic tool-result error
  'task_blocked',      // Task conflict or block (409)
  'invalid_status',    // Invalid status value or transition (422)
]);

const PROVIDER_TRANSPORTS = Object.freeze([
  'api',
  'cli',
  'hybrid',
]);

const PROVIDER_STATUSES = Object.freeze([
  'healthy',
  'degraded',
  'unavailable',
  'disabled',
]);

const MODEL_SOURCES = Object.freeze([
  'static',
  'runtime',
  'provider_api',
  'provider_api_live',
  'registry',
]);

const STANDARD_ERROR_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'details', 'request_id'],
      properties: {
        code: { type: 'string', enum: ERROR_CODES },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
        request_id: { type: 'string', format: 'uuid' },
      },
    },
  },
});

const STANDARD_SUCCESS_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['data', 'meta'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: true,
    },
    meta: {
      type: 'object',
      required: ['request_id', 'timestamp'],
      properties: {
        request_id: { type: 'string', format: 'uuid' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  },
});

const PROVIDER_DESCRIPTOR_SCHEMA = Object.freeze({
  type: 'object',
  required: ['id', 'name', 'transport', 'enabled', 'default', 'local', 'features', 'limits', 'status'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    transport: { type: 'string', enum: PROVIDER_TRANSPORTS },
    enabled: { type: 'boolean' },
    default: { type: 'boolean' },
    local: { type: 'boolean' },
    features: {
      type: 'array',
      items: { type: 'string' },
    },
    limits: {
      type: 'object',
      additionalProperties: true,
    },
    status: { type: 'string', enum: PROVIDER_STATUSES },
  },
});

const MODEL_DESCRIPTOR_SCHEMA = Object.freeze({
  type: 'object',
  required: ['id', 'name', 'provider_id', 'parameters', 'source', 'refreshed_at'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    provider_id: { type: 'string' },
    parameters: {
      type: 'object',
      additionalProperties: true,
    },
    source: { type: 'string', enum: MODEL_SOURCES },
    refreshed_at: {
      anyOf: [
        { type: 'string', format: 'date-time' },
        { type: 'null' },
      ],
    },
  },
});

const HEALTH_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['provider_id', 'status', 'latency_ms', 'last_error', 'success_ratio', 'checked_at'],
  properties: {
    provider_id: { type: 'string' },
    status: { type: 'string', enum: PROVIDER_STATUSES },
    latency_ms: { type: 'number', minimum: 0 },
    last_error: {
      anyOf: [
        { type: 'string' },
        { type: 'null' },
      ],
    },
    success_ratio: { type: 'number', minimum: 0, maximum: 1 },
    checked_at: { type: 'string', format: 'date-time' },
  },
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function collectValidationError(errors, field, code, message) {
  errors.push({ field, code, message });
}

function normalizeTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMessageContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content.trim();
  if (typeof content === 'number' || typeof content === 'boolean') {
    return String(content).trim();
  }
  return '';
}

function normalizeBooleanQueryValue(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return Boolean(value);
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return null;
}

function validateStringField(payload, field, errors, options = {}) {
  const {
    maxLength = 255,
    required = false,
  } = options;

  if (!hasOwn(payload, field)) {
    if (required) {
      collectValidationError(errors, field, 'missing', `\`${field}\` is required`);
    }
    return undefined;
  }

  const normalized = normalizeTrimmedString(payload[field]);
  if (!normalized) {
    collectValidationError(errors, field, 'type', `\`${field}\` must be a non-empty string`);
    return undefined;
  }

  if (normalized.length > maxLength) {
    collectValidationError(
      errors,
      field,
      'length',
      `\`${field}\` must be no longer than ${maxLength} characters`,
    );
    return undefined;
  }

  return normalized;
}

function validateBooleanField(payload, field, errors) {
  if (!hasOwn(payload, field)) {
    return undefined;
  }

  if (typeof payload[field] !== 'boolean') {
    collectValidationError(errors, field, 'type', `\`${field}\` must be a boolean`);
    return undefined;
  }

  return payload[field];
}

function validateEnumField(payload, field, allowedValues, errors, options = {}) {
  if (!hasOwn(payload, field)) {
    return undefined;
  }

  const raw = normalizeTrimmedString(payload[field]).toLowerCase();
  if (!raw) {
    collectValidationError(errors, field, 'type', `\`${field}\` must be a non-empty string`);
    return undefined;
  }

  if (!allowedValues.includes(raw)) {
    const code = options.code || 'value';
    const message = options.message || `\`${field}\` must be one of: ${allowedValues.join(', ')}`;
    collectValidationError(errors, field, code, message);
    return undefined;
  }

  return raw;
}

function validateBooleanQueryField(query, field, errors) {
  if (!hasOwn(query, field)) {
    return undefined;
  }

  const normalized = normalizeBooleanQueryValue(query[field]);
  if (normalized === null) {
    collectValidationError(
      errors,
      field,
      'type',
      `\`${field}\` must be a boolean-compatible value`,
    );
    return undefined;
  }

  return normalized;
}

function validatePromptOrMessages(payload, errors) {
  const hasPrompt = hasOwn(payload, 'prompt');
  const hasMessages = hasOwn(payload, 'messages');

  if (!hasPrompt && !hasMessages) {
    collectValidationError(errors, 'messages', 'missing', 'Either prompt or messages is required');
    return {};
  }

  if (hasPrompt && hasMessages) {
    collectValidationError(errors, 'messages', 'ambiguous', 'Provide either prompt or messages, not both');
    return {};
  }

  if (hasPrompt) {
    const prompt = normalizeTrimmedString(payload.prompt);
    if (!prompt) {
      collectValidationError(errors, 'prompt', 'type', '`prompt` must be a non-empty string');
      return {};
    }
    return { prompt };
  }

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    collectValidationError(errors, 'messages', 'type', '`messages` must be a non-empty array');
    return {};
  }

  const normalizedMessages = [];
  payload.messages.forEach((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      collectValidationError(errors, `messages[${index}]`, 'type', 'Each message must be an object');
      return;
    }

    const role = normalizeTrimmedString(message.role);
    const content = normalizeMessageContent(message.content);

    if (!role) {
      collectValidationError(
        errors,
        `messages[${index}].role`,
        'type',
        'Each message requires a non-empty role',
      );
    }

    if (!content) {
      collectValidationError(
        errors,
        `messages[${index}].content`,
        'type',
        'Each message requires non-empty content',
      );
    }

    normalizedMessages.push({
      role,
      content,
    });
  });

  return { messages: normalizedMessages };
}

function validateInferenceRequest(payload, options = {}) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    collectValidationError(errors, 'body', 'type', 'Request body must be an object');
    return { valid: false, errors, value: {} };
  }

  const value = {};
  const promptOrMessages = validatePromptOrMessages(payload, errors);
  if (promptOrMessages.prompt !== undefined) {
    value.prompt = promptOrMessages.prompt;
  }
  if (promptOrMessages.messages !== undefined) {
    value.messages = promptOrMessages.messages;
  }

  const provider = validateStringField(payload, 'provider', errors, { maxLength: 64 });
  const model = validateStringField(payload, 'model', errors, { maxLength: 255 });
  const stream = validateBooleanField(payload, 'stream', errors);
  const asyncFlag = validateBooleanField(payload, 'async', errors);
  const transport = validateEnumField(payload, 'transport', PROVIDER_TRANSPORTS, errors);

  if (hasOwn(payload, 'timeout_ms')) {
    if (!Number.isInteger(payload.timeout_ms)) {
      collectValidationError(errors, 'timeout_ms', 'type', '`timeout_ms` must be an integer');
    } else if (payload.timeout_ms <= 0 || payload.timeout_ms > 600000) {
      collectValidationError(errors, 'timeout_ms', 'range', '`timeout_ms` must be between 1 and 600000');
    } else {
      value.timeout_ms = payload.timeout_ms;
    }
  }

  if (hasOwn(payload, 'max_tokens')) {
    if (typeof payload.max_tokens !== 'number' || !Number.isFinite(payload.max_tokens)) {
      collectValidationError(errors, 'max_tokens', 'type', '`max_tokens` must be a number');
    } else if (payload.max_tokens < 1 || payload.max_tokens > 1000000) {
      collectValidationError(errors, 'max_tokens', 'range', '`max_tokens` must be between 1 and 1000000');
    } else {
      value.max_tokens = payload.max_tokens;
    }
  }

  if (hasOwn(payload, 'temperature')) {
    if (typeof payload.temperature !== 'number' || !Number.isFinite(payload.temperature)) {
      collectValidationError(errors, 'temperature', 'type', '`temperature` must be a number');
    } else if (payload.temperature < 0 || payload.temperature > 2) {
      collectValidationError(errors, 'temperature', 'range', '`temperature` must be between 0 and 2');
    } else {
      value.temperature = payload.temperature;
    }
  }

  if (hasOwn(payload, 'top_p')) {
    if (typeof payload.top_p === 'number' && Number.isFinite(payload.top_p)) {
      value.top_p = payload.top_p;
    }
  }

  if (provider !== undefined) value.provider = provider;
  if (model !== undefined) value.model = model;
  if (stream !== undefined) value.stream = stream;
  if (asyncFlag !== undefined) value.async = asyncFlag;
  if (transport !== undefined) value.transport = transport;

  const defaultProvider = normalizeTrimmedString(options.defaultProvider);
  if (!value.provider) {
    if (defaultProvider) {
      value.provider = defaultProvider;
    } else {
      collectValidationError(
        errors,
        'provider',
        'missing',
        'A provider is required or default provider must be configured',
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    value,
  };
}

function validateProviderQuery(query, options = {}) {
  const errors = [];

  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    collectValidationError(errors, 'query', 'type', 'Query parameters must be an object');
    return { valid: false, errors, value: {} };
  }

  const value = {};
  const id = validateStringField(query, 'id', errors, { maxLength: 64 });
  const providerId = validateStringField(query, 'provider_id', errors, { maxLength: 64 });

  if (id && providerId && id !== providerId) {
    collectValidationError(
      errors,
      'provider_id',
      'ambiguous',
      '`id` and `provider_id` must match when both are supplied',
    );
  }

  const canonicalProviderId = providerId || id;
  if (canonicalProviderId) {
    value.provider_id = canonicalProviderId;
  } else if (options.requireId === true) {
    collectValidationError(errors, 'provider_id', 'missing', '`provider_id` is required');
  }

  const transport = validateEnumField(query, 'transport', PROVIDER_TRANSPORTS, errors);
  const status = validateEnumField(query, 'status', PROVIDER_STATUSES, errors);
  const enabled = validateBooleanQueryField(query, 'enabled', errors);
  const defaultFlag = validateBooleanQueryField(query, 'default', errors);
  const local = validateBooleanQueryField(query, 'local', errors);
  const includeDisabled = validateBooleanQueryField(query, 'include_disabled', errors);

  if (transport !== undefined) value.transport = transport;
  if (status !== undefined) value.status = status;
  if (enabled !== undefined) value.enabled = enabled;
  if (defaultFlag !== undefined) value.default = defaultFlag;
  if (local !== undefined) value.local = local;
  if (includeDisabled !== undefined) value.include_disabled = includeDisabled;

  return {
    valid: errors.length === 0,
    errors,
    value,
  };
}

module.exports = {
  ROUTE_STATUSES,
  ERROR_CODES,
  PROVIDER_TRANSPORTS,
  PROVIDER_STATUSES,
  MODEL_SOURCES,
  STANDARD_ERROR_RESPONSE_SCHEMA,
  STANDARD_SUCCESS_RESPONSE_SCHEMA,
  PROVIDER_DESCRIPTOR_SCHEMA,
  MODEL_DESCRIPTOR_SCHEMA,
  HEALTH_RESPONSE_SCHEMA,
  validateInferenceRequest,
  validateProviderQuery,
};
