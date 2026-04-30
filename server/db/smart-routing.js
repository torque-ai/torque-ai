// Extracted from provider-routing-core.js — Smart Routing Analysis
'use strict';

const logger = require('../logger').child({ component: 'smart-routing' });
const serverConfig = require('../config');
const { safeJsonParse } = require('../utils/json');
const { prependResumeContextToPrompt } = require('../utils/resume-context');
const eventBus = require('../event-bus');
const routingAnalysis = require('./provider-routing-analysis');

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

/**
 * Failover chain identifiers. The codex-down-failover template is the one auto-
 * activated by the failover-activator on circuit:tripped. When this template is
 * active, the resolver walks each per-category chain through the live circuit
 * breaker so providers with open circuits are skipped at routing time, not
 * after the fact.
 */
const FAILOVER_TEMPLATE_IDS = new Set(['preset-codex-down-failover']);
const FAILOVER_TEMPLATE_NAMES = new Set(['Codex-Down Failover', 'codex-down-failover']);

function isFailoverTemplate(template) {
  if (!template) return false;
  if (template.id && FAILOVER_TEMPLATE_IDS.has(template.id)) return true;
  if (template.name && FAILOVER_TEMPLATE_NAMES.has(template.name)) return true;
  return false;
}

/**
 * Pure helper: walk a per-category provider chain and return the first link
 * the breaker says is reachable.
 *
 * @param {object} args
 * @param {Array<{provider: string, model?: string|null}>} args.chain
 * @param {{ allowRequest: (provider: string) => boolean }|null} [args.breaker]
 * @returns {{ provider: string, model: string|null }|null} first allowed link, or null on exhaustion / empty / null chain
 */
function walkFailoverChain({ chain, breaker } = {}) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  for (const link of chain) {
    if (!link || typeof link.provider !== 'string') continue;
    if (!breaker || typeof breaker.allowRequest !== 'function' || breaker.allowRequest(link.provider)) {
      return { provider: link.provider, model: link.model || null };
    }
  }
  return null;
}

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

  const tryResolvedTemplate = (template, reasonPrefix, includeDefaultFallback, chainFallbackLabel, honorChainOrder = false) => {
    if (!template) {
      return null;
    }

    const category = getCategory();
    const complexity = getComplexity();
    const resolved = templateStore.resolveProvider(template, category, complexity);
    if (!resolved) {
      return null;
    }

    // Codex-Down Failover branch: when this template is active, walk the
    // category chain through the live circuit breaker. Skip providers whose
    // breaker is open. On exhaustion, return null so the task parks (the
    // failover template intentionally has empty chains for codex-only
    // categories like architectural / large_code_gen).
    if (isFailoverTemplate(template)) {
      const breaker = (typeof deps?.getCircuitBreaker === 'function')
        ? deps.getCircuitBreaker()
        : null;
      const chain = Array.isArray(resolved.chain) ? resolved.chain : null;
      const choice = walkFailoverChain({ chain, breaker });
      if (!choice) {
        logger.info(`[SmartRouting] codex-down-failover: chain exhausted for category=${category} — parking task`);
        return null;
      }
      const providerConfig = getProvider(choice.provider);
      if (!providerConfig || !providerConfig.enabled) {
        logger.info(`[SmartRouting] codex-down-failover: ${choice.provider} not enabled — chain walker selected disabled provider, parking`);
        return null;
      }
      return maybeApplyFallback({
        provider: choice.provider,
        model: choice.model,
        chain,
        rule: null,
        complexity,
        reason: `${reasonPrefix} [codex-down-failover]: ${category} -> ${choice.provider}`,
      });
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
      const ranked = !honorChainOrder && typeof rankProviderCandidatesByScore === 'function'
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
      'chain to',
      true
    );
    if (taskTemplateResult) {
      return taskTemplateResult;
    }
  }

  const explicitTemplateId = templateStore.getExplicitActiveTemplateId();
  const activeTemplate = explicitTemplateId ? templateStore.getTemplate(explicitTemplateId) : null;
  return tryResolvedTemplate(activeTemplate, `Template '${activeTemplate?.name}'`, true, 'chain fallback ->', true);
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

  // Bare `auth` removed — matches `auth.js` filenames, wrongly steering testing
  // tasks like "Write unit tests for auth.js" into security routing (claude-cli).
  // Real auth-security contexts still match via other keywords (injection, credential, encrypt, owasp).
  const isSecurityTask = /\b(security|vulnerab|audit|penetrat|encrypt|credential|secret|injection|xss|csrf|owasp)\b/i.test(taskDescription);
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
  const inputs = routingAnalysis.normalizeRoutingInputs(taskDescription, workingDirectory, files, options);
  const getDatabaseConfig = _deps.getDatabaseConfig;
  const getProvider = _deps.getProvider;
  const getDefaultProvider = _deps.getDefaultProvider;
  const hostManagementFns = _deps.getHostManagementFns();
  const isOllamaHealthy = _deps.isOllamaHealthy;
  const getFallbackChain = _deps.getFallbackChain;
  const applyProviderSafetyNet = routingAnalysis.createProviderSafetyNet({
    getProvider,
    getDb: () => _deps.getDb(),
    logger,
  });

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
  const freeRoutingResult = routingAnalysis.routePreferFreeProvider({
    preferFree: inputs.preferFree,
    ollamaHealthy,
    getProvider,
    serverConfig,
    applyProviderSafetyNet,
    logger,
  });
  if (freeRoutingResult) {
    return freeRoutingResult;
  }
  const ollamaFallbackProvider = getDatabaseConfig('ollama_fallback_provider') || 'codex';

  // ─── Lazy-loaded optional integrations ────────────────────────────────
  function getCircuitBreaker() {
    if (typeof _deps?.getCircuitBreaker === 'function') return _deps.getCircuitBreaker();
    return null;
  }

  // Helper to check if provider needs Ollama and handle fallback
  const isOllamaProvider = (provider) => provider === 'ollama';

  const maybeApplyFallback = routingAnalysis.createFallbackHandler({
    skipHealthCheck: inputs.skipHealthCheck,
    hasPreservedIntent: inputs.isUserOverride || inputs.hasRoutingTemplateIntent,
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
  });

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
    getCircuitBreaker,
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
    isUserOverride: inputs.isUserOverride
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
  const legacyResult = routingAnalysis.routeByLegacyRules({ db, inputs, logger, maybeApplyFallback });
  if (legacyResult) return legacyResult;

  // No rule matched, use default smart routing provider
  const defaultSmartProvider = getDatabaseConfig('smart_routing_default_provider') || 'ollama';
  const result = maybeApplyFallback({
    provider: defaultSmartProvider,
    rule: null,
    reason: `No rule matched, using smart routing default: ${defaultSmartProvider}`
  });

  return routingAnalysis.finalizeRoutingResult(result, inputs, applyProviderSafetyNet);
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
      'ollama-cloud':    ['cerebras', 'deepinfra', 'claude-cli'],
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

    const providerConfig = getProvider(candidate);
    if (!providerConfig || !providerConfig.enabled) {
      return false;
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
  const taskDescription = task.resume_context
    ? prependResumeContextToPrompt(task.task_description, task.resume_context)
    : task.task_description;

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
        metadata = ?,
        task_description = ?
    WHERE id = ?
  `);
  const result = stmt.run(new Date().toISOString(), JSON.stringify(currentMetadata), taskDescription, taskId);
  if (result && result.changes > 0) {
    eventBus.emitQueueChanged();
    try {
      const { emitTaskEvent } = require('../events/event-emitter');
      const { EVENT_TYPES } = require('../events/event-types');
      emitTaskEvent({
        task_id: taskId,
        type: EVENT_TYPES.PROVIDER_FAILOVER,
        actor: 'smart-routing',
        payload: { from: task.provider, to: newProvider, reason: 'quota_or_failure' },
      });
    } catch { /* non-critical */ }
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
  if (
    /\bunauthori[sz]ed\b/.test(text)
    || /\b401\b/.test(text)
    || /\bauthentication failed\b/.test(text)
    || /\binvalid (?:api key|credentials?)\b/.test(text)
    || /\bapi key (?:not found|missing|invalid)\b/.test(text)
  ) {
    return false;
  }

  return patterns.some(pattern => typeof pattern === 'string' && text.includes(pattern.toLowerCase()));
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

  // Codex Fallback Phase 2: failover chain walker
  walkFailoverChain,

  // Test hook (not part of the public API): expose resolveRoutingTemplate
  // so the failover-branch integration can be unit-tested without the full
  // analyzeTaskForRouting harness.
  _resolveRoutingTemplateForTest: resolveRoutingTemplate,
};
