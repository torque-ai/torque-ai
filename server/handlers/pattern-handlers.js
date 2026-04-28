'use strict';

const { defaultContainer } = require('../container');
const { runPattern } = require('../patterns/pattern-runner');
const { createPatternsStore } = require('../patterns/store');
const { ErrorCodes, makeError, requireString } = require('./shared');

let fallbackPatternsStore = null;

function buildToolResult(payload) {
  return {
    ...payload,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredData: payload,
  };
}

function resolvePatternsStore() {
  try {
    if (defaultContainer?.has?.('patternsStore')) {
      return defaultContainer.get('patternsStore');
    }
  } catch (error) {
    void error;
    // Fall back to a local store when the DI container is not booted.
  }

  if (!fallbackPatternsStore) {
    fallbackPatternsStore = createPatternsStore();
  }

  return fallbackPatternsStore;
}

function resolveProviderRegistry() {
  try {
    if (defaultContainer?.has?.('providerRegistry')) {
      return defaultContainer.get('providerRegistry');
    }
  } catch (error) {
    void error;
    // Fall back to the module singleton when the DI container is not booted.
  }

  return require('../providers/registry');
}

function createPatternHandlerError(message, code = ErrorCodes.INTERNAL_ERROR) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureProviderRegistration(providerRegistry, providerName) {
  if (!providerRegistry || typeof providerRegistry.getProviderInstance !== 'function') {
    return;
  }

  if (providerName !== 'codex') {
    return;
  }

  try {
    const db = defaultContainer?.has?.('db') ? defaultContainer.get('db') : null;
    if (db?.isReady?.()) {
      require('../config').init({ db });
      if (typeof providerRegistry.init === 'function') {
        providerRegistry.init({ db });
      }
    }
  } catch (error) {
    void error;
    // Best-effort bootstrap only.
  }

  try {
    providerRegistry.registerProviderClass('codex', require('../providers/v2-cli-providers').CodexCliProvider);
  } catch (error) {
    void error;
    // Ignore duplicate or unavailable registration paths.
  }
}

async function callProviderPrompt(provider, prompt, options = {}) {
  if (!provider) {
    throw createPatternHandlerError('Provider instance is unavailable', ErrorCodes.NO_HOSTS_AVAILABLE);
  }

  if (typeof provider.runPrompt === 'function') {
    const result = await provider.runPrompt({
      prompt,
      max_tokens: options.maxTokens,
      transport: options.transport,
      working_directory: options.workingDirectory,
    });
    return typeof result === 'string' ? result : (result?.output ?? result);
  }

  if (typeof provider.submit === 'function') {
    const result = await provider.submit(prompt, null, {
      transport: options.transport || 'api',
      maxTokens: options.maxTokens,
      working_directory: options.workingDirectory,
      raw_prompt: true,
    });
    return result?.output ?? result;
  }

  throw createPatternHandlerError(
    `Provider "${provider.name || 'unknown'}" does not support prompt execution`,
    ErrorCodes.INVALID_PARAM,
  );
}

function createPatternHandlers(deps = {}) {
  const getPatternsStore = () => deps.patternsStore || resolvePatternsStore();
  const getProviderRegistry = () => deps.providerRegistry || resolveProviderRegistry();

  async function handleListPatterns() {
    const patterns = getPatternsStore().list().map((pattern) => ({
      name: pattern.name,
      description: pattern.description,
      tags: pattern.tags,
      variables: pattern.variables,
      source_dir: pattern.source_dir,
    }));

    return buildToolResult({
      count: patterns.length,
      patterns,
      source_dir: getPatternsStore().sourceDir,
    });
  }

  async function handleDescribePattern(args = {}) {
    const nameError = requireString(args, 'name', 'name');
    if (nameError) return nameError;

    const pattern = getPatternsStore().get(args.name);
    if (!pattern) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Pattern not found: ${args.name}`);
    }

    return buildToolResult({
      pattern,
    });
  }

  async function handleRunPattern(args = {}) {
    const nameError = requireString(args, 'name', 'name');
    if (nameError) return nameError;

    if (args.input !== undefined && typeof args.input !== 'string') {
      return makeError(ErrorCodes.INVALID_PARAM, 'input must be a string');
    }

    if (args.vars !== undefined && (!args.vars || typeof args.vars !== 'object' || Array.isArray(args.vars))) {
      return makeError(ErrorCodes.INVALID_PARAM, 'vars must be an object');
    }

    const pattern = getPatternsStore().get(args.name);
    if (!pattern) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Pattern not found: ${args.name}`);
    }

    const providerName = typeof args.provider === 'string' && args.provider.trim()
      ? args.provider.trim()
      : 'codex';
    const providerRegistry = getProviderRegistry();
    ensureProviderRegistration(providerRegistry, providerName);
    const provider = providerRegistry?.getProviderInstance?.(providerName);
    if (!provider) {
      return makeError(ErrorCodes.NO_HOSTS_AVAILABLE, `Provider not available: ${providerName}`);
    }

    try {
      const output = await runPattern({
        pattern,
        input: typeof args.input === 'string' ? args.input : '',
        vars: args.vars || {},
        callModel: async ({ system, user }) => {
          const prompt = `${system}\n\n${user}`.trim();
          return callProviderPrompt(provider, prompt, {
            maxTokens: 2000,
            transport: args.transport,
            workingDirectory: args.working_directory,
          });
        },
      });

      return buildToolResult({
        ok: true,
        pattern: pattern.name,
        provider: providerName,
        output,
      });
    } catch (error) {
      return makeError(ErrorCodes.PROVIDER_ERROR, error.message || String(error));
    }
  }

  return {
    handleListPatterns,
    handleDescribePattern,
    handleRunPattern,
  };
}

module.exports = {
  createPatternHandlers,
  ...createPatternHandlers(),
};
