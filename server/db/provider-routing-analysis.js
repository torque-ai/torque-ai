'use strict';

// Boundary: pure routing-analysis helpers for smart-routing. Keep task
// lifecycle, process management, and retry execution in their owning modules.

const capabilities = require('./provider-capabilities');
const perfTracker = require('./provider-performance');
const { isSafeRegex } = require('../utils/safe-regex');

const CLOUD_FREE_PROVIDER_ORDER = ['google-ai', 'groq', 'openrouter', 'ollama-cloud', 'cerebras'];

function normalizeRoutingInputs(taskDescription, workingDirectory, files = [], options = {}) {
  const { skipHealthCheck = false, isUserOverride = false, preferFree = false } = options;
  const taskMetadata = options?.taskMetadata || {};
  const fileExtensions = new Set();

  if (files && Array.isArray(files)) {
    for (const file of files) {
      const ext = file.includes('.') ? '.' + file.split('.').pop().toLowerCase() : '';
      if (ext) fileExtensions.add(ext);
    }
  }

  return {
    taskDescription,
    workingDirectory,
    files,
    options,
    taskMetadata,
    descLower: (taskDescription || '').toLowerCase(),
    fileExtensions,
    skipHealthCheck,
    isUserOverride,
    preferFree,
    hasRoutingTemplateIntent: typeof taskMetadata._routing_template === 'string'
      && taskMetadata._routing_template.trim() !== '',
  };
}

function createProviderSafetyNet({ getProvider, getDb, logger }) {
  return function applyProviderSafetyNet(routingResult) {
    if (!routingResult || typeof routingResult !== 'object') {
      return routingResult;
    }

    let resolvedProvider = typeof routingResult.provider === 'string' ? routingResult.provider.trim() : '';
    const providerConfig = resolvedProvider ? getProvider(resolvedProvider) : null;
    if (resolvedProvider && providerConfig && providerConfig.enabled) {
      routingResult.provider = resolvedProvider;
      return routingResult;
    }

    try {
      const db = getDb();
      const enabledProviders = db.prepare(
        "SELECT provider FROM provider_config WHERE enabled = 1 ORDER BY priority ASC LIMIT 1"
      ).all();
      if (enabledProviders.length > 0) {
        const invalidProvider = resolvedProvider;
        resolvedProvider = enabledProviders[0].provider;
        routingResult.provider = resolvedProvider;
        logger.warn(`[SmartRouting] Invalid provider resolved (${invalidProvider || 'null'}) — falling back to ${resolvedProvider}`);
      }
    } catch { /* db may not be available */ }

    if (resolvedProvider) {
      routingResult.provider = resolvedProvider;
    }
    return routingResult;
  };
}

function routePreferFreeProvider({
  preferFree,
  ollamaHealthy,
  getProvider,
  serverConfig,
  applyProviderSafetyNet,
  logger,
}) {
  if (!preferFree) {
    return null;
  }

  if (ollamaHealthy !== false) {
    const providerConfig = getProvider('ollama');
    if (providerConfig && providerConfig.enabled) {
      return applyProviderSafetyNet({
        provider: 'ollama',
        rule: null,
        reason: 'Free routing: local Ollama (ollama)',
        complexity: 'normal',
      });
    }
  }

  for (const provider of CLOUD_FREE_PROVIDER_ORDER) {
    const apiKey = serverConfig.getApiKey(provider);
    if (!apiKey) continue;
    const providerConfig = getProvider(provider);
    if (providerConfig && providerConfig.enabled) {
      return applyProviderSafetyNet({
        provider,
        rule: null,
        reason: `Free routing: cloud free tier (${provider})`,
        complexity: 'normal',
      });
    }
  }

  logger.warn('[SmartRouting] prefer_free requested but no free providers available, falling through to normal routing');
  return null;
}

function buildFallbackMetadata(result, provider, reason, options = {}) {
  const base = options.preserveResult ? { ...result } : {};
  return {
    ...base,
    provider,
    rule: result.rule,
    reason,
    originalProvider: result.provider,
    fallbackApplied: true,
    ...(options.extra || {}),
  };
}

function createFallbackHandler({
  skipHealthCheck,
  hasPreservedIntent,
  ollamaHealthy,
  ollamaFallbackProvider,
  taskDescription,
  files,
  getProvider,
  getFallbackChain,
  getCircuitBreaker,
  isOllamaProvider,
  applyProviderSafetyNet,
  logger,
  serverConfig,
}) {
  return function maybeApplyFallback(result) {
    if (!skipHealthCheck && isOllamaProvider(result.provider) && ollamaHealthy === false) {
      if (hasPreservedIntent) {
        logger.info(`[SmartRouting] Ollama unhealthy but explicit intent requested ${result.provider} — preserving intent (TDA-01)`);
        return applyProviderSafetyNet(result);
      }

      return applyProviderSafetyNet(buildFallbackMetadata(
        result,
        ollamaFallbackProvider,
        `${result.reason} [Ollama unavailable - falling back to ${ollamaFallbackProvider}]`,
      ));
    }

    if (isOllamaProvider(result.provider) && !hasPreservedIntent) {
      const descTokens = Math.ceil((taskDescription || '').length / 4);
      const fileCount = (files || []).length;
      const estimatedFileTokens = fileCount * 800;
      const estimatedTotal = descTokens + estimatedFileTokens;
      const localCtxLimit = serverConfig.getInt('ollama_max_ctx', 32768);

      if (estimatedTotal > localCtxLimit * 0.7) {
        logger.info(`[SmartRouting] Context overflow guard: ~${estimatedTotal} estimated tokens exceeds 70% of ${localCtxLimit} limit for ${result.provider} — rerouting to ${ollamaFallbackProvider}`);
        return applyProviderSafetyNet(buildFallbackMetadata(
          result,
          ollamaFallbackProvider,
          `${result.reason} [context overflow: ~${estimatedTotal} tokens > ${localCtxLimit} limit, rerouted to ${ollamaFallbackProvider}]`,
          { extra: { contextOverflow: true } },
        ));
      }
    }

    const cb = getCircuitBreaker();
    if (cb && !cb.allowRequest(result.provider) && !hasPreservedIntent) {
      logger.info(`[SmartRouting] Circuit breaker OPEN for ${result.provider} — applying fallback`);
      const fbChain = getFallbackChain(result.provider);
      for (const fallbackProvider of fbChain) {
        if (cb.allowRequest(fallbackProvider) && getProvider(fallbackProvider)?.enabled) {
          return applyProviderSafetyNet(buildFallbackMetadata(
            result,
            fallbackProvider,
            `${result.reason} [circuit breaker: ${result.provider} tripped, rerouted to ${fallbackProvider}]`,
            { preserveResult: true },
          ));
        }
      }
    }

    return applyProviderSafetyNet(result);
  };
}

function matchLegacyRoutingRule(rule, inputs, deps) {
  if (rule.complexity) return null;
  if (typeof rule.pattern !== 'string') return null;

  const patterns = (rule.pattern || '').split('|').map(p => p.trim().toLowerCase());

  if (rule.rule_type === 'keyword') {
    for (const pattern of patterns) {
      if (inputs.descLower.includes(pattern)) {
        return deps.maybeApplyFallback({
          provider: rule.target_provider,
          rule,
          reason: `Matched keyword rule '${rule.name}': pattern '${pattern}'`,
        });
      }
    }
  } else if (rule.rule_type === 'extension') {
    for (const pattern of patterns) {
      if (inputs.fileExtensions.has(pattern)) {
        return deps.maybeApplyFallback({
          provider: rule.target_provider,
          rule,
          reason: `Matched extension rule '${rule.name}': extension '${pattern}'`,
        });
      }
    }
  } else if (rule.rule_type === 'regex') {
    try {
      if (!isSafeRegex(rule.pattern)) {
        deps.logger.warn('Unsafe regex pattern skipped: ' + rule.pattern);
        return null;
      }
      const regex = new RegExp(rule.pattern, 'i');
      if (regex.test(inputs.taskDescription)) {
        return deps.maybeApplyFallback({
          provider: rule.target_provider,
          rule,
          reason: `Matched regex rule '${rule.name}'`,
        });
      }
    } catch {
      return null;
    }
  }

  return null;
}

function routeByLegacyRules({ db, inputs, logger, maybeApplyFallback }) {
  let sql = 'SELECT * FROM routing_rules WHERE 1=1';
  const params = [];

  if (inputs.options.enabled !== undefined) {
    sql += ' AND enabled = ?';
    params.push(inputs.options.enabled ? 1 : 0);
  }
  if (inputs.options.rule_type) {
    sql += ' AND rule_type = ?';
    params.push(inputs.options.rule_type);
  }

  sql += ' ORDER BY priority ASC';
  const rules = db.prepare(sql).all(...params);

  for (const rule of rules) {
    const matched = matchLegacyRoutingRule(rule, inputs, { logger, maybeApplyFallback });
    if (matched) return matched;
  }

  return null;
}

function finalizeRoutingResult(result, inputs, applyProviderSafetyNet) {
  if (inputs.options && inputs.options.tierList) {
    const capabilityRequirements = capabilities.inferCapabilityRequirements(inputs.taskDescription);
    const complexity = result.complexity || 'normal';
    const qualityTier = complexity === 'complex' ? 'complex' : (complexity === 'simple' ? 'simple' : 'normal');
    const taskType = perfTracker.inferTaskType(inputs.taskDescription);
    const eligibleProviders = capabilities.generateEligibleProviders({
      capabilityRequirements,
      qualityTier,
      getEmpiricalRank: (provider) => perfTracker.getEmpiricalRank(provider, taskType),
    });
    result.eligible_providers = eligibleProviders;
    result.capability_requirements = capabilityRequirements;
    result.quality_tier = qualityTier;
  }

  if (inputs.options && inputs.options.isUserOverride && inputs.options.overrideProvider) {
    result.eligible_providers = [inputs.options.overrideProvider];
    result.provider = inputs.options.overrideProvider;
  }

  return applyProviderSafetyNet(result);
}

module.exports = {
  normalizeRoutingInputs,
  createProviderSafetyNet,
  routePreferFreeProvider,
  createFallbackHandler,
  routeByLegacyRules,
  finalizeRoutingResult,
};
