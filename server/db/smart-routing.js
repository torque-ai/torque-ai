// Extracted from provider-routing-core.js — Smart Routing Analysis
'use strict';

const logger = require('../logger').child({ component: 'smart-routing' });
const serverConfig = require('../config');
const { safeJsonParse } = require('../utils/json');
const { isSafeRegex } = require('../utils/safe-regex');
const capabilities = require('./provider-capabilities');
const perfTracker = require('./provider-performance');
const eventBus = require('../event-bus');

let categoryClassifier = null;
let templateStore = null;
try {
  categoryClassifier = require('../routing/category-classifier');
  templateStore = require('../routing/template-store');
} catch {
  categoryClassifier = null;
  templateStore = null;
}

let _scoringModuleLocal = null, _smLocalLoaded = false;
function getScoringModuleLocal() {
  if (!_smLocalLoaded) { _smLocalLoaded = true; try { _scoringModuleLocal = require('./provider-scoring'); } catch { _scoringModuleLocal = null; } }
  return _scoringModuleLocal;
}

let _quotaStore = null;
function getQuotaStoreIfAvailable() {
  if (!_quotaStore) {
    try {
      _quotaStore = require('./provider-quotas').getQuotaStore();
    } catch {}
  }
  return _quotaStore;
}

// These are set by the parent module via init()
let _deps = null;

/**
 * Initialize this module with dependencies from provider-routing-core.
 * Must be called before any exported function is used.
 * @param {object} deps
 * @param {function} deps.getDatabaseConfig
 * @param {function} deps.getProvider
 * @param {function} deps.getTask
 * @param {function} deps.setConfig
 * @param {function} deps.getDefaultProvider
 * @param {function} deps.getHostManagementFns - returns current hostManagementFns
 * @param {function} deps.isOllamaHealthy
 * @param {function} deps.getFallbackChain - getProviderFallbackChain
 * @param {function} deps.getDb - returns current db
 */
function init(deps) {
  _deps = deps;
}

// ============================================================
// Smart Routing Analysis
// ============================================================

function resolveRoutingTemplate(taskDescription, files, options, deps) {
  const {
    categoryClassifier,
    templateStore,
    getProvider,
    getQuotaStoreIfAvailable,
    hostManagementFns,
    maybeApplyFallback,
    rankProviderCandidatesByScore,
  } = deps;

  if (!categoryClassifier || !templateStore) {
    return null;
  }

  const getCategory = () => categoryClassifier.classify(taskDescription, files);
  const getComplexity = () => (hostManagementFns?.determineTaskComplexity
    ? hostManagementFns.determineTaskComplexity(taskDescription, files)
    : 'normal');

  const tryResolvedTemplate = (template, reasonPrefix, includeDefaultFallback, chainFallbackLabel) => {
    if (!template) {
      return null;
    }

    const category = getCategory();
    const complexity = getComplexity();
    const resolved = templateStore.resolveProvider(template, category, complexity);
    if (!resolved) {
      return null;
    }

    const originalChain = Array.isArray(resolved.chain) && resolved.chain.length > 0
      ? resolved.chain
      : [{ provider: resolved.provider, model: resolved.model || null }];
    const availableChain = [];
    const quotaStore = getQuotaStoreIfAvailable();

    for (const entry of originalChain) {
      const providerName = typeof entry === 'string' ? entry : entry?.provider;
      if (!providerName) {
        continue;
      }

      const providerConfig = getProvider(providerName);
      if (!providerConfig || !providerConfig.enabled) {
        continue;
      }
      if (quotaStore && quotaStore.isExhausted(providerName)) {
        const label = providerName === resolved.provider ? 'primary ' : '';
        logger.info('[SmartRouting] Skipping ' + label + providerName + ' — quota exhausted');
        continue;
      }

      availableChain.push(typeof entry === 'string' ? { provider: providerName, model: null } : entry);
    }

    if (availableChain.length > 0) {
      const ranked = typeof rankProviderCandidatesByScore === 'function'
        ? rankProviderCandidatesByScore(availableChain, {
            taskMetadata: options?.taskMetadata || {},
            extractProvider: (entry) => (typeof entry === 'string' ? entry : entry?.provider),
          })
        : { candidates: availableChain, applied: false };
      const rankedChain = Array.isArray(ranked.candidates) && ranked.candidates.length > 0
        ? ranked.candidates
        : availableChain;
      const selected = rankedChain[0];
      const selectedProvider = typeof selected === 'string' ? selected : selected.provider;
      const selectedModel = typeof selected === 'string' ? null : (selected.model || null);
      const primaryAvailable = availableChain.some((entry) => {
        const providerName = typeof entry === 'string' ? entry : entry?.provider;
        return providerName === resolved.provider;
      });
      const selectedIsPrimary = selectedProvider === resolved.provider;
      const scoreApplied = ranked.applied && !selectedIsPrimary;
      let reason = `${reasonPrefix}: ${category} -> ${resolved.provider}`;
      if (scoreApplied) {
        reason += `, score-ranked -> ${selectedProvider}`;
      } else if (!selectedIsPrimary) {
        reason += ` (unavailable), ${chainFallbackLabel} ${selectedProvider}`;
      } else if (!primaryAvailable) {
        reason += ` (recovered by availability filter)`;
      }

      return maybeApplyFallback({
        provider: selectedProvider,
        model: selectedModel,
        chain: rankedChain,
        rule: null,
        complexity,
        reason,
        routing_score_applied: ranked.applied || undefined,
        routing_score: ranked.applied ? {
          provider: selectedProvider,
          composite_score: ranked.selectedScore,
          source: 'provider_scores',
        } : undefined,
      });
    }

    if (!includeDefaultFallback) {
      return null;
    }

    const defaultResolved = templateStore.resolveProvider(template, 'default', complexity);
    if (defaultResolved && defaultResolved.provider !== resolved.provider) {
      const defaultConfig = getProvider(defaultResolved.provider);
      if (defaultConfig && defaultConfig.enabled) {
        return maybeApplyFallback({
          provider: defaultResolved.provider,
          model: defaultResolved.model || null,
          chain: defaultResolved.chain,
          rule: null,
          complexity,
          reason: `${reasonPrefix}: ${category} -> ${resolved.provider} (unavailable), fallback to default -> ${defaultResolved.provider}`,
        });
      }
    }

    return null;
  };

  const taskMeta = options?.taskMetadata || {};
  const taskTemplateName = taskMeta._routing_template;
  if (taskTemplateName) {
    const taskTemplate = templateStore.resolveTemplateByNameOrId(taskTemplateName);
    const taskTemplateResult = tryResolvedTemplate(
      taskTemplate,
      `Task template '${taskTemplate?.name}'`,
      false,
      'chain to'
    );
    if (taskTemplateResult) {
      return taskTemplateResult;
    }
  }

  const explicitTemplateId = templateStore.getExplicitActiveTemplateId();
  const activeTemplate = explicitTemplateId ? templateStore.getTemplate(explicitTemplateId) : null;
  return tryResolvedTemplate(activeTemplate, `Template '${activeTemplate?.name}'`, true, 'chain fallback ->');
}

function matchProviderByPattern(taskDescription, files, deps) {
  const {
    serverConfig,
    getProvider,
    getQuotaStoreIfAvailable,
    applyProviderSafetyNet,
    isUserOverride,
  } = deps;

  const groqApiKey = serverConfig.getApiKey('groq');

  const isSecurityTask = /\b(security|vulnerab|audit|penetrat|auth|encrypt|credential|secret|injection|xss|csrf|owasp)\b/i.test(taskDescription);
  const isXamlTask = /\b(xaml|wpf|uwp|maui|avalonia)\b/i.test(taskDescription) ||
    (files && files.some(f => /\.xaml$/i.test(f)));
  const isArchitecturalTask = /\b(architect|refactor.*multi|redesign|migration strategy|system design)\b/i.test(taskDescription);

  // DeepInfra/Hyperbolic routing: complex reasoning and large-scope tasks to big models
  const deepinfraApiKey = serverConfig.getApiKey('deepinfra');
  const hyperbolicApiKey = serverConfig.getApiKey('hyperbolic');

  const isReasoningTask = /\b(reason|analyze|debug complex|root cause|review.*entire|explain.*architecture|deep.*analysis)\b/i.test(taskDescription);
  const isLargeCodeTask = /\b(implement.*system|build.*feature|create.*module|complex.*generation|multi.*file.*refactor)\b/i.test(taskDescription);

  if ((isReasoningTask || isLargeCodeTask || isArchitecturalTask) && deepinfraApiKey) {
    const diProvider = getProvider('deepinfra');
    const qs = getQuotaStoreIfAvailable();
    if (diProvider && diProvider.enabled && !(qs && qs.isExhausted('deepinfra'))) {
      const matchType = isReasoningTask ? 'complex reasoning' : isLargeCodeTask ? 'large code generation' : 'architectural';
      return applyProviderSafetyNet({
        provider: 'deepinfra',
        rule: null,
        reason: `API routing: ${matchType} task → deepinfra (large model)`
      });
    }
  }

  // Hyperbolic as fallback for large-model tasks when DeepInfra unavailable
  if ((isReasoningTask || isLargeCodeTask || isArchitecturalTask) && hyperbolicApiKey) {
    // Only try Hyperbolic if DeepInfra didn't already handle this task
    const diProvider = getProvider('deepinfra');
    const diAvailable = diProvider && diProvider.enabled && deepinfraApiKey;
    if (!diAvailable) {
      const hProvider = getProvider('hyperbolic');
      const qs = getQuotaStoreIfAvailable();
      if (hProvider && hProvider.enabled && !(qs && qs.isExhausted('hyperbolic'))) {
        const matchType = isReasoningTask ? 'complex reasoning' : isLargeCodeTask ? 'large code generation' : 'architectural';
        return applyProviderSafetyNet({
          provider: 'hyperbolic',
          rule: null,
          reason: `API routing: ${matchType} task → hyperbolic (DeepInfra unavailable)`
        });
      }
    }
  }

  // Ollama Cloud routing: reasoning/analysis/large-code tasks to 480B+ models (free tier)
  // Falls after deepinfra/hyperbolic (paid large models) but before groq/local ollama
  const ollamaCloudApiKey = serverConfig.getApiKey('ollama-cloud');
  if ((isReasoningTask || isLargeCodeTask || isArchitecturalTask) && ollamaCloudApiKey) {
    const ocProvider = getProvider('ollama-cloud');
    const qs = getQuotaStoreIfAvailable();
    if (ocProvider && ocProvider.enabled && !(qs && qs.isExhausted('ollama-cloud'))) {
      const matchType = isReasoningTask ? 'complex reasoning' : isLargeCodeTask ? 'large code generation' : 'architectural';
      return applyProviderSafetyNet({
        provider: 'ollama-cloud',
        rule: null,
        reason: `API routing: ${matchType} task → ollama-cloud (480B+ model, free)`
      });
    }
  }

  // Security tasks → anthropic or claude-cli
  if (isSecurityTask && !isUserOverride) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      const anthropicProvider = getProvider('anthropic');
      if (anthropicProvider && anthropicProvider.enabled) {
        return applyProviderSafetyNet({ provider: 'anthropic', rule: null, reason: 'Security task routed to Anthropic' });
      }
    }
    // Fallback to claude-cli for security tasks
    const claudeProvider = getProvider('claude-cli');
    if (claudeProvider && claudeProvider.enabled) {
      return applyProviderSafetyNet({ provider: 'claude-cli', rule: null, reason: 'Security task routed to Claude CLI' });
    }
  }

  // XAML/WPF tasks → cloud (local LLMs struggle with WPF semantics)
  if (isXamlTask && !isUserOverride) {
    const codexProvider = getProvider('codex');
    if (codexProvider && codexProvider.enabled) {
      return applyProviderSafetyNet({ provider: 'codex', rule: null, reason: 'XAML/WPF task routed to Codex' });
    }
  }

  const isDocsTask = /\b(document|summarize|comment|readme|changelog|jsdoc|docstring)\b/i.test(taskDescription);
  // "template" removed — matched routing template names in task descriptions, causing false routing to groq
  const isSimpleGenTask = /\b(commit message|boilerplate|scaffold|stub)\b/i.test(taskDescription);
  // "explain" and "describe" removed from groq routing — these often need multi-file reads
  // which require 2+ tool calls, and groq's tool calling fails on multi-step tasks.
  // They'll route to cerebras or other providers via template-based routing instead.

  // Only route to groq if the task won't need multiple tool calls
  const hasMultipleFileRefs = (taskDescription.match(/\b[\w./\\-]+\.\w{1,5}\b/g) || []).length > 1;
  if ((isDocsTask || isSimpleGenTask) && !hasMultipleFileRefs && groqApiKey) {
    const groqProvider = getProvider('groq');
    const qs = getQuotaStoreIfAvailable();
    if (groqProvider && groqProvider.enabled && !(qs && qs.isExhausted('groq'))) {
      const matchType = isDocsTask ? 'documentation' : 'simple generation';
      return applyProviderSafetyNet({
        provider: 'groq',
        rule: null,
        reason: `API routing: ${matchType} task → groq`
      });
    }
  }

  return null;
}

function routeByComplexity(taskDescription, files, deps) {
  const { hostManagementFns, maybeApplyFallback, isOllamaProvider } = deps;

  if (!hostManagementFns?.determineTaskComplexity || !hostManagementFns?.routeTask) {
    return null;
  }

  const complexity = hostManagementFns.determineTaskComplexity(taskDescription, files);
  const complexityRouting = hostManagementFns.routeTask(complexity);

  if (!complexityRouting || !complexityRouting.provider) {
    return null;
  }

  let reason = `Complexity-based routing: ${complexity} → ${complexityRouting.provider}`;
  if (complexityRouting.hostId) {
    reason += ` (${complexityRouting.hostId})`;
  }
  if (complexityRouting.fallbackApplied) {
    reason += ` [fallback from ${complexityRouting.originalHost}]`;
  }

  const result = {
    provider: complexityRouting.provider,
    rule: complexityRouting.rule,
    complexity: complexity,
    hostId: complexityRouting.hostId,
    model: complexityRouting.model,
    reason: reason,
    fallbackApplied: complexityRouting.fallbackApplied,
    originalHost: complexityRouting.originalHost
  };

  if (isOllamaProvider(result.provider) && result.hostId) {
    result.selectedHost = result.hostId;
  }

  return maybeApplyFallback(result);
}

/**
 * Analyze a task and determine the best provider based on routing rules
 * @param {string} taskDescription - Task description text.
 * @param {string} workingDirectory - Task working directory.
 * @param {Array<string>} [files=[]] - Related file paths.
 * @param {object} [options={}] - Routing options.
 * @returns {object} Routing decision.
 */
function analyzeTaskForRouting(taskDescription, workingDirectory, files = [], options = {}) {
  const { skipHealthCheck = false, isUserOverride = false, preferFree = false } = options;

  const getDatabaseConfig = _deps.getDatabaseConfig;
  const getProvider = _deps.getProvider;
  const getDefaultProvider = _deps.getDefaultProvider;
  const hostManagementFns = _deps.getHostManagementFns();
  const isOllamaHealthy = _deps.isOllamaHealthy;
  const getFallbackChain = _deps.getFallbackChain;
  const applyProviderSafetyNet = (routingResult) => {
    if (!routingResult || typeof routingResult !== 'object') {
      return routingResult;
    }

    let resolvedProvider = typeof routingResult.provider === 'string' ? routingResult.provider.trim() : '';
    const providerConfig = resolvedProvider ? getProvider(resolvedProvider) : null;
    if (resolvedProvider && providerConfig && providerConfig.enabled) {
      routingResult.provider = resolvedProvider;
      return routingResult;
    }

    // Safety net: if routing resolved to a disabled/missing provider or null,
    // fall back to the first enabled provider to prevent tasks sitting in queue forever.
    const invalidProvider = resolvedProvider;
    try {
      const db = _deps.getDb();
      const enabledProviders = db.prepare(
        "SELECT provider FROM provider_config WHERE enabled = 1 ORDER BY priority ASC LIMIT 1"
      ).all();
      if (enabledProviders.length > 0) {
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

  // Check if smart routing is enabled
  const smartRoutingEnabled = getDatabaseConfig('smart_routing_enabled') === '1';
  if (!smartRoutingEnabled) {
    return applyProviderSafetyNet({
      provider: getDefaultProvider(),
      rule: null,
      reason: 'Smart routing disabled'
    });
  }

  // Check Ollama health from cache
  const ollamaHealthy = isOllamaHealthy();

  // prefer_free: restrict to $0 providers — local Ollama first, then cloud free tiers
  if (preferFree) {
    // Try local Ollama if healthy (best free option: no rate limits, 24GB VRAM)
    if (ollamaHealthy !== false) {
      const providerConfig = getProvider('ollama');
      if (providerConfig && providerConfig.enabled) {
        return applyProviderSafetyNet({ provider: 'ollama', rule: null, reason: 'Free routing: local Ollama (ollama)', complexity: 'normal' });
      }
    }
    // Fallback to cloud free tiers
    const cloudFreeOrder = ['google-ai', 'groq', 'openrouter', 'ollama-cloud', 'cerebras'];
    for (const p of cloudFreeOrder) {
      const apiKey = serverConfig.getApiKey(p);
      if (!apiKey) continue;
      const pConfig = getProvider(p);
      if (pConfig && pConfig.enabled) {
        return applyProviderSafetyNet({ provider: p, rule: null, reason: `Free routing: cloud free tier (${p})`, complexity: 'normal' });
      }
    }
    // No free providers available — fall through to normal routing with a warning
    logger.warn('[SmartRouting] prefer_free requested but no free providers available, falling through to normal routing');
  }
  const ollamaFallbackProvider = getDatabaseConfig('ollama_fallback_provider') || 'codex';

  const descLower = (taskDescription || '').toLowerCase();

  // Collect all file extensions from working directory and explicit files
  const fileExtensions = new Set();
  if (files && Array.isArray(files)) {
    for (const file of files) {
      const ext = file.includes('.') ? '.' + file.split('.').pop().toLowerCase() : '';
      if (ext) fileExtensions.add(ext);
    }
  }

  // ─── Lazy-loaded optional integrations ────────────────────────────────
  function getCircuitBreaker() {
    if (typeof _deps?.getCircuitBreaker === 'function') return _deps.getCircuitBreaker();
    return null;
  }

  // Helper to check if provider needs Ollama and handle fallback
  const isOllamaProvider = (provider) => provider === 'ollama';

  const maybeApplyFallback = (result) => {
    if (!skipHealthCheck && isOllamaProvider(result.provider) && ollamaHealthy === false) {
      // TDA-01: Do not silently reroute when the user explicitly chose a provider.
      // Explicit provider intent is sovereign — let the task queue and fail honestly
      // rather than silently executing under a different provider identity.
      if (isUserOverride) {
        logger.info(`[SmartRouting] Ollama unhealthy but user explicitly requested ${result.provider} — preserving intent (TDA-01)`);
        return applyProviderSafetyNet(result);
      }
      return applyProviderSafetyNet({
        provider: ollamaFallbackProvider,
        rule: result.rule,
        reason: `${result.reason} [Ollama unavailable - falling back to ${ollamaFallbackProvider}]`,
        originalProvider: result.provider,
        fallbackApplied: true
      });
    }

    // Context overflow guard: estimate prompt size and reroute if it would exceed
    // local LLM context window. The desc + file count is a rough proxy for the
    // full prompt that execute-hashline/execute-ollama will build.
    if (isOllamaProvider(result.provider) && !isUserOverride) {
      const descTokens = Math.ceil((taskDescription || '').length / 4);
      const fileCount = (files || []).length;
      // Each referenced file adds ~500–2000 tokens of context (path + relevant content).
      // Conservative estimate: 800 tokens per file for context stuffing.
      const estimatedFileTokens = fileCount * 800;
      const estimatedTotal = descTokens + estimatedFileTokens;
      const localCtxLimit = serverConfig.getInt('ollama_max_ctx', 32768);
      // Reroute if estimated tokens would exceed 70% of context (leave room for response)
      if (estimatedTotal > localCtxLimit * 0.7) {
        logger.info(`[SmartRouting] Context overflow guard: ~${estimatedTotal} estimated tokens exceeds 70% of ${localCtxLimit} limit for ${result.provider} — rerouting to ${ollamaFallbackProvider}`);
        return applyProviderSafetyNet({
          provider: ollamaFallbackProvider,
          rule: result.rule,
          reason: `${result.reason} [context overflow: ~${estimatedTotal} tokens > ${localCtxLimit} limit, rerouted to ${ollamaFallbackProvider}]`,
          originalProvider: result.provider,
          fallbackApplied: true,
          contextOverflow: true,
        });
      }
    }

    // Circuit breaker guard: if selected provider has an open circuit, apply fallback
    const cb = getCircuitBreaker();
    if (cb && !cb.allowRequest(result.provider) && !isUserOverride) {
      logger.info(`[SmartRouting] Circuit breaker OPEN for ${result.provider} — applying fallback`);
      const fbChain = getFallbackChain(result.provider);
      for (const fb of fbChain) {
        if (cb.allowRequest(fb) && getProvider(fb)?.enabled) {
          return applyProviderSafetyNet({
            ...result,
            provider: fb,
            originalProvider: result.provider,
            reason: `${result.reason} [circuit breaker: ${result.provider} tripped, rerouted to ${fb}]`,
            fallbackApplied: true,
          });
        }
      }
      // All fallbacks also tripped — let it through and fail honestly
    }

    return applyProviderSafetyNet(result);
  };

  // ─── ROUTING EVALUATION ORDER ──────────────────────────────────────────
  // 1. Per-task routing template (explicit user override per task)
  // 2. Global active routing template (explicit user activation)
  // 3. Hard-coded API provider rules (pattern-based fallback)
  // 4. Complexity-based routing
  // 5. Legacy keyword/extension rules
  // 6. Default provider

  // ─── 1. Per-task routing template ──────────────────────────────────────
  // Callers can pass options.taskMetadata._routing_template = "Template Name" or ID
  // to override the globally active template for this specific task.
  const templateResult = resolveRoutingTemplate(taskDescription, files, options, {
    categoryClassifier,
    templateStore,
    getProvider,
    getQuotaStoreIfAvailable: getQuotaStoreIfAvailable,
    hostManagementFns,
    maybeApplyFallback,
    rankProviderCandidatesByScore: _deps.rankProviderCandidatesByScore,
  });
  if (templateResult) return templateResult;

  // ─── 3. Hard-coded API provider routing ────────────────────────────────
  // Pattern-based routing to cloud providers when no template is active.
  // Each block checks quota exhaustion before routing.
  const patternResult = matchProviderByPattern(taskDescription, files, {
    serverConfig,
    getProvider,
    getQuotaStoreIfAvailable: getQuotaStoreIfAvailable,
    applyProviderSafetyNet,
    isUserOverride
  });
  if (patternResult) return patternResult;

  // PRIMARY: Complexity-based routing (Claude workflow)
  // - Simple tasks → Laptop WSL (default host)
  // - Normal tasks → Desktop (desktop-17)
  // - Complex tasks → Codex
  const complexityResult = routeByComplexity(taskDescription, files, {
    hostManagementFns,
    maybeApplyFallback,
    isOllamaProvider
  });
  if (complexityResult) return complexityResult;

  // FALLBACK: Legacy keyword/extension rules
  const db = _deps.getDb();
  let sql = 'SELECT * FROM routing_rules WHERE 1=1';
  const params = [];

  if (options.enabled !== undefined) {
    sql += ' AND enabled = ?';
    params.push(options.enabled ? 1 : 0);
  }
  if (options.rule_type) {
    sql += ' AND rule_type = ?';
    params.push(options.rule_type);
  }

  sql += ' ORDER BY priority ASC';

  const rules = db.prepare(sql).all(...params);

  // Check rules in priority order
  for (const rule of rules) {
    // Skip complexity rules (already handled above)
    if (rule.complexity) continue;

    if (typeof rule.pattern !== 'string') continue;
    const patterns = (rule.pattern || '').split('|').map(p => p.trim().toLowerCase());

    if (rule.rule_type === 'keyword') {
      // Check if any keyword pattern matches the description
      for (const pattern of patterns) {
        if (descLower.includes(pattern)) {
          return maybeApplyFallback({
            provider: rule.target_provider,
            rule: rule,
            reason: `Matched keyword rule '${rule.name}': pattern '${pattern}'`
          });
        }
      }
    } else if (rule.rule_type === 'extension') {
      // Check if any file extension matches
      for (const pattern of patterns) {
        if (fileExtensions.has(pattern)) {
          return maybeApplyFallback({
            provider: rule.target_provider,
            rule: rule,
            reason: `Matched extension rule '${rule.name}': extension '${pattern}'`
          });
        }
      }
    } else if (rule.rule_type === 'regex') {
      // Full regex matching
      try {
        if (!isSafeRegex(rule.pattern)) {
          logger.warn('Unsafe regex pattern skipped: ' + rule.pattern);
          continue;
        }
        const regex = new RegExp(rule.pattern, 'i');
        if (regex.test(taskDescription)) {
          return maybeApplyFallback({
            provider: rule.target_provider,
            rule: rule,
            reason: `Matched regex rule '${rule.name}'`
          });
        }
      } catch {
        // Invalid regex, skip
      }
    }
  }

  // No rule matched, use default smart routing provider
  const defaultSmartProvider = getDatabaseConfig('smart_routing_default_provider') || 'ollama';
  const result = maybeApplyFallback({
    provider: defaultSmartProvider,
    rule: null,
    reason: `No rule matched, using smart routing default: ${defaultSmartProvider}`
  });

  if (options && options.tierList) {
    const capReqs = capabilities.inferCapabilityRequirements(taskDescription);
    const complexity = result.complexity || 'normal';
    const qualityTier = complexity === 'complex' ? 'complex' : (complexity === 'simple' ? 'simple' : 'normal');
    const eligibleProviders = capabilities.generateEligibleProviders({
      capabilityRequirements: capReqs,
      qualityTier,
      getEmpiricalRank: (provider) => perfTracker.getEmpiricalRank(provider, perfTracker.inferTaskType(taskDescription)),
    });
    result.eligible_providers = eligibleProviders;
    result.capability_requirements = capReqs;
    result.quality_tier = qualityTier;
  }

  if (options && options.isUserOverride && options.overrideProvider) {
    result.eligible_providers = [options.overrideProvider];
    result.provider = options.overrideProvider;
  }

  return applyProviderSafetyNet(result);
}

/**
 * Mark a task as pending provider switch (after quota error)
 * @param {any} taskId
 * @param {any} reason
 * @returns {any}
 */
function markTaskPendingProviderSwitch(taskId, reason) {
  const db = _deps.getDb();
  const getTask = _deps.getTask;

  const task = getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const stmt = db.prepare(`
    UPDATE tasks
    SET status = 'pending_provider_switch',
        error_output = COALESCE(error_output, '') || ?
    WHERE id = ?
  `);
  stmt.run(`\n[Provider Switch Pending] ${reason}`, taskId);

  return getTask(taskId);
}

/**
 * Get ordered fallback chain for a provider.
 * Returns array of provider names to try in order.
 * @param {any} provider
 * @returns {any}
 */
// Canonical ordered list of cloud/API fallback providers.
// All other modules MUST use getProviderFallbackChain() instead of maintaining
// their own inline lists.  The order here defines the priority when falling back
// from local (Ollama) providers to cloud.
const CLOUD_PROVIDERS = [
  'codex', 'claude-cli',
  'deepinfra', 'hyperbolic', 'anthropic',
  'groq', 'cerebras', 'google-ai', 'openrouter', 'ollama-cloud',
];

// Providers that run locally (Ollama-backed).
const LOCAL_PROVIDERS = ['ollama'];

/**
 * Get the fallback chain for a provider.
 * @param {string} provider - Source provider name
 * @param {Object} [options]
 * @param {boolean} [options.cloudOnly] - If true, filter the chain to cloud providers only
 * @returns {string[]} Ordered fallback provider names
 */
function getProviderFallbackChain(provider, options) {
  const getDatabaseConfig = _deps.getDatabaseConfig;

  // Check for user-configured fallback chain first
  const customChainJson = getDatabaseConfig(`fallback_chain_${provider}`);
  let chain;
  if (customChainJson) {
    try {
      const parsed = JSON.parse(customChainJson);
      if (Array.isArray(parsed) && parsed.length > 0) chain = parsed;
    } catch { /* fall through to defaults */ }
  }

  if (!chain) {
    // Local-first fallback chains — try local providers before cloud
    // groq removed from fallback chains — its tool calling fails on multi-step
    // tasks (only reliable for single-tool-call docs/simple tasks via smart routing).
    const defaultChains = {
      'codex':           ['claude-cli', 'deepinfra', 'ollama-cloud', 'ollama'],
      'claude-cli':      ['codex', 'deepinfra', 'ollama-cloud', 'ollama'],
      'groq':            ['ollama-cloud', 'cerebras', 'deepinfra', 'claude-cli', 'ollama'],
      'ollama-cloud':    ['cerebras', 'deepinfra', 'codex', 'claude-cli'],
      'cerebras':        ['google-ai', 'ollama-cloud', 'deepinfra', 'codex'],
      'google-ai':       ['openrouter', 'cerebras', 'ollama-cloud', 'deepinfra', 'codex'],
      'openrouter':      ['google-ai', 'cerebras', 'ollama-cloud', 'deepinfra', 'codex'],
      'hyperbolic':      ['deepinfra', 'ollama-cloud', 'claude-cli', 'codex', 'ollama'],
      'deepinfra':       ['ollama-cloud', 'hyperbolic', 'claude-cli', 'codex', 'ollama'],
      'ollama':          ['ollama-cloud', 'deepinfra', 'codex', 'claude-cli'],
    };
    chain = defaultChains[provider] || ['ollama', 'deepinfra', 'codex', 'claude-cli'];
  }

  // Filter to cloud-only if requested (used by Ollama→cloud fallback paths)
  if (options && options.cloudOnly) {
    const localSet = new Set(LOCAL_PROVIDERS);
    chain = chain.filter(p => !localSet.has(p));
  }

  // Score-aware reordering: if trusted provider scores exist, sort the chain
  // so higher-scored providers are tried first (preserves chain membership,
  // only changes order). Unscored providers stay in their original position.
  const sm = getScoringModuleLocal();
  if (sm && chain.length > 1) {
    try {
      const backupCore = require('./backup-core');
      const inst = backupCore.getDbInstance ? backupCore.getDbInstance() : null;
      if (inst) {
        sm.init(inst);
        const scores = sm.getAllProviderScores({ trustedOnly: true });
        if (scores.length > 0) {
          const scoreMap = new Map(scores.map(s => [s.provider, s.composite_score]));
          // Stable sort: scored providers first by composite desc, unscored keep relative order
          chain.sort((a, b) => {
            const aScore = scoreMap.get(a) || 0;
            const bScore = scoreMap.get(b) || 0;
            if (aScore && !bScore) return -1;
            if (!aScore && bScore) return 1;
            return bScore - aScore;
          });
        }
      }
    } catch { /* scoring not available — use default order */ }
  }

  return chain;
}

/**
 * Set a custom fallback chain for a provider
 * @param {any} provider
 * @param {any} chain
 * @returns {any}
 */
function setProviderFallbackChain(provider, chain) {
  const getProvider = _deps.getProvider;
  const setConfig = _deps.setConfig;

  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error('chain must be a non-empty array of provider names');
  }
  // Validate: reject self-loops and unknown providers
  const seen = new Set();
  for (const candidate of chain) {
    if (typeof candidate !== 'string' || !candidate) {
      throw new Error(`Invalid provider name in chain: ${candidate}`);
    }
    if (candidate === provider) {
      throw new Error(`Self-loop detected: provider "${provider}" cannot be in its own fallback chain`);
    }
    if (seen.has(candidate)) {
      throw new Error(`Duplicate provider in chain: ${candidate}`);
    }
    seen.add(candidate);
    const p = getProvider(candidate);
    if (!p) {
      throw new Error(`Unknown provider in chain: ${candidate}`);
    }
  }
  setConfig(`fallback_chain_${provider}`, JSON.stringify(chain));
}

/**
 * Get next available fallback provider for a task.
 * Tracks which providers have already been tried via failover_events.
 * Returns provider name or null if chain is exhausted.
 * @param {any} taskId
 * @returns {any}
 */
function getNextFallbackProvider(taskId) {
  const db = _deps.getDb();
  const getTask = _deps.getTask;
  const getProvider = _deps.getProvider;
  const getDatabaseConfig = _deps.getDatabaseConfig;

  const task = getTask(taskId);
  if (!task) return null;

  const originalProvider = task.original_provider || task.provider || 'codex';
  const chain = getProviderFallbackChain(originalProvider);

  const triedProviders = new Set([originalProvider]);
  const triedRows = db.prepare(`
    SELECT DISTINCT to_provider
    FROM failover_events
    WHERE task_id = ?
      AND to_provider IS NOT NULL
      AND TRIM(to_provider) != ''
  `).all(taskId);
  for (const row of triedRows) {
    triedProviders.add(row.to_provider);
  }

  // Also add current provider
  if (task.provider) triedProviders.add(task.provider);

  // EXP7: Raw ollama cannot create new files — skip it for greenfield tasks
  // UNLESS the current default model is agentic-capable (e.g., qwen3-coder)
  // which can use write_file tool to create files natively.
  const isGreenfield = task.task_description &&
    /\b(create|write|generate|scaffold|build)\s+(a\s+)?(new\s+)?(file|test|module|class|component|spec)\b/i.test(task.task_description);
  let ollamaIsAgentic = false;
  try {
    const { isAgenticCapable } = require('../providers/agentic-capability');
    const { resolveOllamaModel } = require('../providers/ollama-shared');
    const { DEFAULT_FALLBACK_MODEL } = require('../constants');
    const ollamaModel = task.model || (typeof getDatabaseConfig === 'function' ? getDatabaseConfig('ollama_model') : null) || resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL;
    ollamaIsAgentic = isAgenticCapable('ollama', ollamaModel).capable;
  } catch { /* non-fatal — default to skipping */ }

  const isFallbackCandidateEnabled = (candidate) => {
    if (!candidate) return false;

    if (candidate !== 'codex' && candidate !== 'claude-cli') {
      const providerConfig = getProvider(candidate);
      if (!providerConfig || !providerConfig.enabled) {
        return false;
      }
    }

    const configKey = `${candidate.replace(/-/g, '_')}_enabled`;
    const registryEntry = serverConfig.REGISTRY?.[configKey];
    if (registryEntry) {
      return registryEntry.type === 'bool-optin'
        ? serverConfig.isOptIn(configKey)
        : serverConfig.getBool(configKey);
    }

    const rawFlag = serverConfig.get(configKey);
    if (rawFlag !== null && rawFlag !== undefined) {
      return serverConfig.getBool(configKey);
    }

    return true;
  };

  for (const candidate of chain) {
    if (triedProviders.has(candidate)) continue;
    if (candidate === 'ollama' && isGreenfield && !ollamaIsAgentic) {
      logger.info(`[FallbackChain] Skipping raw ollama for greenfield task ${taskId} — model is not agentic-capable`);
      continue;
    }
    if (isFallbackCandidateEnabled(candidate)) return candidate;
  }

  return null; // Chain exhausted
}

/**
 * Approve provider switch - retry task with new provider
 * @param {string} taskId - Task identifier.
 * @param {string} [newProvider='claude-cli'] - Provider to switch to.
 * @returns {object} Updated task.
 */
function approveProviderSwitch(taskId, newProvider = 'claude-cli') {
  const db = _deps.getDb();
  const getTask = _deps.getTask;
  const getProvider = _deps.getProvider;

  const task = getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  if (task.status !== 'pending_provider_switch') {
    throw new Error(`Task ${taskId} is not pending provider switch (status: ${task.status})`);
  }

  const provider = getProvider(newProvider);
  if (!provider || !provider.enabled) {
    throw new Error(`Provider ${newProvider} is not available`);
  }

  const currentMetadata = task.metadata && typeof task.metadata === 'object'
    ? { ...task.metadata }
    : (safeJsonParse(task.metadata, {}) || {});
  // ALWAYS clear user_provider_override on failover. The flag means "the user
  // chose THIS provider" — once we switch away from the user's chosen provider,
  // the flag no longer applies to the new provider. Without clearing it,
  // resolveProviderRouting treats the fallback target as an immutable user
  // choice, causing mislabeling (task shows "ollama-cloud" when codex ran it).
  //
  // The original intent is preserved in original_requested_provider for audit.
  if (!currentMetadata.original_requested_provider && currentMetadata.requested_provider) {
    currentMetadata.original_requested_provider = currentMetadata.requested_provider;
  }
  currentMetadata.failover_provider = newProvider;
  currentMetadata.failover_from = task.provider || null;
  // Point intended_provider at the fallback target so resolveProviderRouting
  // picks it up when the provider column is NULL (deferred assignment).
  currentMetadata.intended_provider = newProvider;
  delete currentMetadata.user_provider_override;
  delete currentMetadata.quota_overflow;
  delete currentMetadata.original_provider;

  const stmt = db.prepare(`
    UPDATE tasks
    SET status = 'queued',
        original_provider = COALESCE(original_provider, provider),
        provider = NULL,
        provider_switched_at = ?,
        retry_count = retry_count + 1,
        started_at = NULL,
        completed_at = NULL,
        exit_code = NULL,
        pid = NULL,
        progress_percent = 0,
        model = NULL,
        ollama_host_id = NULL,
        metadata = ?
    WHERE id = ?
  `);
  const result = stmt.run(new Date().toISOString(), JSON.stringify(currentMetadata), taskId);
  if (result && result.changes > 0) {
    eventBus.emitQueueChanged();
  }

  return getTask(taskId);
}

/**
 * Reject provider switch - mark task as failed
 * @param {any} taskId
 * @param {any} reason
 * @returns {any}
 */
function rejectProviderSwitch(taskId, reason = 'User rejected provider switch') {
  const db = _deps.getDb();
  const getTask = _deps.getTask;

  const task = getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  if (task.status !== 'pending_provider_switch') {
    throw new Error(`Task ${taskId} is not pending provider switch (status: ${task.status})`);
  }

  const stmt = db.prepare(`
    UPDATE tasks
    SET status = 'failed',
        completed_at = ?,
        error_output = COALESCE(error_output, '') || ?
    WHERE id = ?
  `);
  stmt.run(new Date().toISOString(), `\n[Provider Switch Rejected] ${reason}`, taskId);

  return getTask(taskId);
}

/**
 * Check if error output indicates a quota error for a provider
 * @param {any} providerId
 * @param {any} errorOutput
 * @returns {any}
 */
function isProviderQuotaError(providerId, errorOutput) {
  const getProvider = _deps.getProvider;

  const provider = getProvider(providerId);
  if (!provider || !provider.quota_error_patterns) return false;

  const patterns = provider.quota_error_patterns;
  const text = (errorOutput || '').toLowerCase();

  return patterns.some(pattern => text.includes(pattern.toLowerCase()));
}

/**
 * Check if Codex is in exhausted state (quota exceeded, awaiting recovery).
 * @returns {boolean}
 */
function isCodexExhausted() {
  return _deps.getDatabaseConfig('codex_exhausted') === '1';
}

/**
 * Set or clear the Codex exhaustion flag.
 * @param {boolean} exhausted - true to mark exhausted, false to clear
 */
function setCodexExhausted(exhausted) {
  const setConfig = _deps.setConfig;
  setConfig('codex_exhausted', exhausted ? '1' : '0');
  if (exhausted) {
    setConfig('codex_exhausted_at', new Date().toISOString());
  }
}

module.exports = {
  init,

  // Canonical provider lists
  CLOUD_PROVIDERS,
  LOCAL_PROVIDERS,

  // Smart Routing
  analyzeTaskForRouting,

  // Provider switch/fallback
  markTaskPendingProviderSwitch,
  getProviderFallbackChain,
  setProviderFallbackChain,
  getNextFallbackProvider,
  approveProviderSwitch,
  rejectProviderSwitch,
  isProviderQuotaError,

  // Codex Exhaustion
  isCodexExhausted,
  setCodexExhausted,
};
