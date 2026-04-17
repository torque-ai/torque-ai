'use strict';

/**
 * api/v2-provider-registry.js — Single source of truth for V2 provider metadata.
 *
 * Extracted from api-server.core.js and api/v2-router.js where it was
 * duplicated (and drifting). Contains provider capabilities, transport
 * types, rate limits, and feature flags for the V2 API layer.
 */

const DEFAULT_REQUEST_RATE_PER_MINUTE = 120;

const PROVIDER_REGISTRY = {
  codex: {
    name: 'OpenAI Codex',
    transport: 'hybrid',
    local: false,
    request_rate_per_minute: DEFAULT_REQUEST_RATE_PER_MINUTE,
    features: {
      chat: true,
      stream: true,
      tools: false,
      vision: false,
      embeddings: true,
      image_input: false,
      file_edit: true,
      reasoning: true,
    },
  },
  'claude-cli': {
    name: 'Claude CLI',
    transport: 'cli',
    local: false,
    request_rate_per_minute: 60,
    features: {
      chat: true,
      stream: true,
      tools: false,
      vision: false,
      embeddings: false,
      image_input: false,
      file_edit: true,
      reasoning: true,
    },
  },
  'claude-code-sdk': {
    name: 'Claude Code SDK',
    transport: 'cli',
    local: false,
    request_rate_per_minute: 60,
    features: {
      chat: true,
      stream: true,
      tools: true,
      vision: false,
      embeddings: false,
      image_input: false,
      file_edit: true,
      reasoning: true,
    },
  },
  ollama: {
    name: 'Ollama (Local)',
    transport: 'api',
    local: true,
    request_rate_per_minute: DEFAULT_REQUEST_RATE_PER_MINUTE,
    features: {
      chat: true,
      stream: true,
      tools: true,
      vision: false,
      embeddings: false,
      image_input: false,
      file_edit: true,
      code_interpretation: true,
    },
  },
  anthropic: {
    name: 'Anthropic',
    transport: 'api',
    local: false,
    request_rate_per_minute: 60,
    features: {
      chat: true,
      stream: true,
      tools: true,
      vision: false,
      embeddings: true,
      image_input: false,
      reasoning: true,
    },
  },
  groq: {
    name: 'Groq',
    transport: 'api',
    local: false,
    request_rate_per_minute: DEFAULT_REQUEST_RATE_PER_MINUTE,
    features: {
      chat: true,
      stream: true,
      tools: true,
      vision: false,
      embeddings: false,
      image_input: false,
      reasoning: false,
    },
  },
  hyperbolic: {
    name: 'Hyperbolic',
    transport: 'api',
    local: false,
    request_rate_per_minute: DEFAULT_REQUEST_RATE_PER_MINUTE,
    features: {
      chat: true,
      stream: true,
      tools: true,
      vision: false,
      embeddings: false,
      image_input: false,
      reasoning: false,
    },
  },
  cerebras: {
    name: 'Cerebras',
    transport: 'api',
    local: false,
    request_rate_per_minute: 30,
    features: {
      chat: true,
      stream: true,
      tools: false,
      vision: false,
      embeddings: false,
      image_input: false,
      reasoning: false,
    },
  },
  'ollama-cloud': {
    name: 'Ollama Cloud',
    transport: 'api',
    local: false,
    request_rate_per_minute: 30,
    features: {
      chat: true,
      stream: true,
      tools: false,
      vision: false,
      embeddings: false,
      image_input: false,
      reasoning: true,
    },
  },
  'google-ai': {
    name: 'Google AI Studio',
    transport: 'api',
    local: false,
    request_rate_per_minute: 15,
    features: {
      chat: true,
      stream: true,
      tools: false,
      vision: true,
      embeddings: false,
      image_input: true,
      reasoning: true,
    },
  },
  openrouter: {
    name: 'OpenRouter',
    transport: 'api',
    local: false,
    request_rate_per_minute: 60,
    features: {
      chat: true,
      stream: true,
      tools: true,
      vision: true,
      embeddings: false,
      image_input: true,
      reasoning: true,
    },
  },
  deepinfra: {
    name: 'DeepInfra',
    transport: 'api',
    local: false,
    request_rate_per_minute: 200,
    features: {
      chat: true,
      stream: true,
      tools: true,
      vision: false,
      embeddings: false,
      image_input: false,
      reasoning: true,
    },
  },
};

const PROVIDER_LOCAL_IDS = new Set(['ollama']);
const V2_TRANSPORTS = new Set(['api', 'cli', 'hybrid']);

module.exports = {
  DEFAULT_REQUEST_RATE_PER_MINUTE,
  PROVIDER_REGISTRY,
  PROVIDER_LOCAL_IDS,
  V2_TRANSPORTS,
};
