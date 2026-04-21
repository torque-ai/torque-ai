'use strict';

const { VALID_MODES, createGovernanceRules } = require('../db/governance-rules');
const { resolveHandlerDatabase } = require('./shared');

let governanceHandlerDeps = {};

function getGovernanceContainer(deps = governanceHandlerDeps) {
  if (deps && deps.container) {
    return deps.container;
  }
  try {
    return require('../container').defaultContainer;
  } catch (_error) {
    return null;
  }
}

function makeJsonResult(payload, options = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredData: payload,
    status: options.status || 200,
    ...(options.isError ? {
      isError: true,
      ...(options.error_code ? { error_code: options.error_code } : {}),
      ...(typeof payload?.error === 'string' ? { error: payload.error } : {}),
    } : {}),
  };
}

function parseOptionalBoolean(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return { value: undefined };
  }
  if (typeof value === 'boolean') {
    return { value };
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return { value: true };
  }
  if (normalized === 'false' || normalized === '0') {
    return { value: false };
  }

  return {
    error: `${fieldName} must be true or false`,
  };
}

function parseConfigValue(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') {
    return null;
  }

  return {
    ...rule,
    enabled: Boolean(rule.enabled),
    config: parseConfigValue(rule.config),
  };
}

function resolveGovernanceRules(deps = governanceHandlerDeps) {
  const defaultContainer = getGovernanceContainer(deps);
  // Try container first (preferred — registered during boot)
  if (defaultContainer && typeof defaultContainer.get === 'function') {
    try {
      const governanceRules = defaultContainer.get('governanceRules');
      if (governanceRules) return { governanceRules };
    } catch (containerLookupError) {
      void containerLookupError;
    }
  }

  const db = resolveHandlerDatabase(deps, { raw: true, defaultContainer });
  if (db && typeof db.prepare === 'function') {
    const rules = createGovernanceRules({ db });
    rules.seedBuiltinRules();
    return { governanceRules: rules };
  }

  return { error: new Error('governance-handlers database dependency is missing (expected db or dbInstance)') };
}

function withGovernanceHandlerDeps(deps, handler) {
  return (...args) => {
    const previousDeps = governanceHandlerDeps;
    governanceHandlerDeps = deps;
    try {
      const result = handler(...args);
      if (result && typeof result.then === 'function') {
        return result.finally(() => {
          governanceHandlerDeps = previousDeps;
        });
      }
      governanceHandlerDeps = previousDeps;
      return result;
    } catch (error) {
      governanceHandlerDeps = previousDeps;
      throw error;
    }
  };
}

function makeNotInitializedError(error) {
  return makeJsonResult({
    error: 'Governance rules not initialized',
    details: error?.message || 'Unknown initialization error',
  }, {
    isError: true,
    status: 503,
    error_code: 'NOT_INITIALIZED',
  });
}

function validateRuleId(ruleId) {
  if (typeof ruleId !== 'string' || ruleId.trim().length === 0) {
    return {
      error: 'rule_id is required',
    };
  }

  return { value: ruleId.trim() };
}

function validateMode(mode) {
  if (typeof mode !== 'string' || mode.trim().length === 0) {
    return { error: 'mode is required' };
  }

  const normalized = mode.trim().toLowerCase();
  if (!VALID_MODES.includes(normalized)) {
    return {
      error: `mode must be one of: ${VALID_MODES.join(', ')}`,
    };
  }

  return { value: normalized };
}

async function handleGetGovernanceRules(args = {}) {
  try {
    const { governanceRules, error } = resolveGovernanceRules();
    if (error) {
      return makeNotInitializedError(error);
    }

    const parsedEnabledOnly = parseOptionalBoolean(args.enabled_only, 'enabled_only');
    if (parsedEnabledOnly.error) {
      return makeJsonResult({ error: parsedEnabledOnly.error }, {
        isError: true,
        status: 400,
        error_code: 'INVALID_PARAM',
      });
    }

    try {
      const stage = typeof args.stage === 'string' && args.stage.trim().length > 0
        ? args.stage.trim()
        : null;
      const enabledOnly = parsedEnabledOnly.value === true;

      let rules = governanceRules.getAllRules();
      if (stage) {
        rules = rules.filter((rule) => rule.stage === stage);
      }
      if (enabledOnly) {
        rules = rules.filter((rule) => rule.enabled === true);
      }

      const normalizedRules = rules.map(normalizeRule);
      return makeJsonResult({
        rules: normalizedRules,
        count: normalizedRules.length,
        filters: {
          stage,
          enabled_only: enabledOnly,
        },
      });
    } catch (handlerError) {
      return makeJsonResult({ error: handlerError.message }, {
        isError: true,
        status: 500,
        error_code: 'OPERATION_FAILED',
      });
    }
  } catch (handlerError) {
    return makeJsonResult({ error: handlerError.message }, {
      isError: true,
      status: 500,
      error_code: 'OPERATION_FAILED',
    });
  }
}

async function handleSetGovernanceRuleMode(args = {}) {
  try {
    const { governanceRules, error } = resolveGovernanceRules();
    if (error) {
      return makeNotInitializedError(error);
    }

    const parsedRuleId = validateRuleId(args.rule_id);
    if (parsedRuleId.error) {
      return makeJsonResult({ error: parsedRuleId.error }, {
        isError: true,
        status: 400,
        error_code: 'MISSING_REQUIRED_PARAM',
      });
    }

    const parsedMode = validateMode(args.mode);
    if (parsedMode.error) {
      return makeJsonResult({ error: parsedMode.error }, {
        isError: true,
        status: 400,
        error_code: 'INVALID_PARAM',
      });
    }

    try {
      const existing = governanceRules.getRule(parsedRuleId.value);
      if (!existing) {
        return makeJsonResult({ error: `Governance rule not found: ${parsedRuleId.value}` }, {
          isError: true,
          status: 404,
          error_code: 'RESOURCE_NOT_FOUND',
        });
      }

      const updated = governanceRules.updateRuleMode(parsedRuleId.value, parsedMode.value);
      if (!updated) {
        return makeJsonResult({ error: `Governance rule not found: ${parsedRuleId.value}` }, {
          isError: true,
          status: 404,
          error_code: 'RESOURCE_NOT_FOUND',
        });
      }

      return makeJsonResult({
        rule: normalizeRule(updated),
        changed: existing.mode !== updated.mode,
        previous_mode: existing.mode,
      });
    } catch (handlerError) {
      return makeJsonResult({ error: handlerError.message }, {
        isError: true,
        status: 500,
        error_code: 'OPERATION_FAILED',
      });
    }
  } catch (handlerError) {
    return makeJsonResult({ error: handlerError.message }, {
      isError: true,
      status: 500,
      error_code: 'OPERATION_FAILED',
    });
  }
}

async function handleToggleGovernanceRule(args = {}) {
  try {
    const { governanceRules, error } = resolveGovernanceRules();
    if (error) {
      return makeNotInitializedError(error);
    }

    const parsedRuleId = validateRuleId(args.rule_id);
    if (parsedRuleId.error) {
      return makeJsonResult({ error: parsedRuleId.error }, {
        isError: true,
        status: 400,
        error_code: 'MISSING_REQUIRED_PARAM',
      });
    }

    const parsedEnabled = parseOptionalBoolean(args.enabled, 'enabled');
    if (parsedEnabled.error || parsedEnabled.value === undefined) {
      return makeJsonResult({ error: parsedEnabled.error || 'enabled is required' }, {
        isError: true,
        status: 400,
        error_code: parsedEnabled.error ? 'INVALID_PARAM' : 'MISSING_REQUIRED_PARAM',
      });
    }

    try {
      const existing = governanceRules.getRule(parsedRuleId.value);
      if (!existing) {
        return makeJsonResult({ error: `Governance rule not found: ${parsedRuleId.value}` }, {
          isError: true,
          status: 404,
          error_code: 'RESOURCE_NOT_FOUND',
        });
      }

      const updated = governanceRules.toggleRule(parsedRuleId.value, parsedEnabled.value);
      if (!updated) {
        return makeJsonResult({ error: `Governance rule not found: ${parsedRuleId.value}` }, {
          isError: true,
          status: 404,
          error_code: 'RESOURCE_NOT_FOUND',
        });
      }

      return makeJsonResult({
        rule: normalizeRule(updated),
        changed: existing.enabled !== updated.enabled,
        previous_enabled: Boolean(existing.enabled),
      });
    } catch (handlerError) {
      return makeJsonResult({ error: handlerError.message }, {
        isError: true,
        status: 500,
        error_code: 'OPERATION_FAILED',
      });
    }
  } catch (handlerError) {
    return makeJsonResult({ error: handlerError.message }, {
      isError: true,
      status: 500,
      error_code: 'OPERATION_FAILED',
    });
  }
}

function createGovernanceHandlers(deps = {}) {
  return {
    handleGetGovernanceRules: withGovernanceHandlerDeps(deps, handleGetGovernanceRules),
    handleSetGovernanceRuleMode: withGovernanceHandlerDeps(deps, handleSetGovernanceRuleMode),
    handleToggleGovernanceRule: withGovernanceHandlerDeps(deps, handleToggleGovernanceRule),
  };
}

module.exports = {
  handleGetGovernanceRules,
  handleSetGovernanceRuleMode,
  handleToggleGovernanceRule,
  createGovernanceHandlers,
};
