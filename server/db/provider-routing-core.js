'use strict';

const path = require('path');
const fs = require('fs');
const logger = require('../logger').child({ component: 'provider-routing' });
const serverConfig = require('../config');
const { safeJsonParse } = require('../utils/json');
const { isSafeRegex } = require('../utils/safe-regex');
const capabilities = require('./provider-capabilities');
const perfTracker = require('./provider-performance');

let resolveEconomyPolicy = null;
let filterProvidersForEconomy = null;
try {
  ({ resolveEconomyPolicy, filterProvidersForEconomy } = require('../economy/policy'));
} catch (error) {
  resolveEconomyPolicy = null;
  filterProvidersForEconomy = null;
}

let categoryClassifier = null;
let templateStore = null;
try {
  categoryClassifier = require('../routing/category-classifier');
  templateStore = require('../routing/template-store');
} catch (error) {
  categoryClassifier = null;
  templateStore = null;
}

// Health check timeout for Ollama connectivity probe (matches constants.js TASK_TIMEOUTS.HEALTH_CHECK)
const OLLAMA_HEALTH_CHECK_TIMEOUT_MS = 5000;

let db;
let getTaskFn;
let hostManagementFns;
let lastEffectiveMaxConcurrentWarningKey = null;
const getDatabaseConfig = (...args) => {
  if (typeof db?.getConfig === 'function') {
    return db.getConfig(...args);
  }
  return require('../database').getConfig(...args);
};

const DEFAULT_GLOBAL_MAX_CONCURRENT = 20;

function setDb(dbInstance) {
  db = dbInstance;
  // Ensure provider_health_history table exists (was ensureTable() in provider-health-history.js)
  if (db && typeof db.exec === 'function') {
    ensureHealthTable();
  }
  // Pass db to template store (table creation and seeding handled by schema-seeds.js)
  if (templateStore && typeof templateStore.setDb === 'function') {
    templateStore.setDb(dbInstance);
  }
}
function setGetTask(fn) { getTaskFn = fn; }
function setHostManagement(fns) { hostManagementFns = fns; }

// Escape a string for use as a Prometheus label value (inside double quotes)
function escapePrometheusLabel(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
}

function setConfig(key, value) {
  if (!db || (db.open === false)) return;
  const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  stmt.run(key, String(value));
}

function getTask(id) {
  return getTaskFn(id);
}

const VALID_PROVIDER_TRANSPORTS = new Set(['api', 'cli', 'hybrid']);

function normalizeProviderTransport(rawTransport, providerId) {
  if (typeof rawTransport === 'string') {
    const normalizedTransport = rawTransport.trim().toLowerCase();
    if (VALID_PROVIDER_TRANSPORTS.has(normalizedTransport)) {
      return normalizedTransport;
    }
  }

  if (providerId === 'codex') return 'hybrid';
  if (providerId === 'claude-cli') return 'cli';
  return 'api';
}

function enrichProviderRow(provider) {
  if (!provider) return null;
  provider.quota_error_patterns = safeJsonParse(provider.quota_error_patterns, []);
  provider.enabled = Boolean(provider.enabled);
  provider.transport = normalizeProviderTransport(provider.transport, provider.provider);
  return provider;
}

/**
 * Get provider configuration
 * @param {any} providerId
 * @returns {any}
 */
function getProvider(providerId) {
  if (!db || (db.open === false)) return null;
  const stmt = db.prepare('SELECT * FROM provider_config WHERE provider = ?');
  return enrichProviderRow(stmt.get(providerId));
}

/**
 * List all configured providers
 * @returns {any}
 */
function listProviders() {
  if (!db || (db.open === false)) return [];
  const stmt = db.prepare('SELECT * FROM provider_config ORDER BY priority ASC');
  return stmt.all().map((p) => enrichProviderRow(p));
}

function parsePositiveInt(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptOutBool(value, fallback = true) {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '0' || normalized === 'false') return false;
  if (normalized === '1' || normalized === 'true') return true;
  return fallback;
}

function getEnabledProviderMaxConcurrentSum() {
  return listProviders().reduce((sum, provider) => {
    if (!provider || !provider.enabled) return sum;
    return sum + parsePositiveInt(provider.max_concurrent, 0);
  }, 0);
}

function getEffectiveMaxConcurrent(options = {}) {
  const configuredMaxConcurrent = parsePositiveInt(
    options.configuredMaxConcurrent ?? getDatabaseConfig('max_concurrent'),
    DEFAULT_GLOBAL_MAX_CONCURRENT,
  );
  const autoComputeMaxConcurrent = options.autoComputeMaxConcurrent !== undefined
    ? Boolean(options.autoComputeMaxConcurrent)
    : parseOptOutBool(getDatabaseConfig('auto_compute_max_concurrent'), true);
  const providerLimitSum = options.providerLimitSum !== undefined
    ? parsePositiveInt(options.providerLimitSum, 0)
    : getEnabledProviderMaxConcurrentSum();
  const effectiveMaxConcurrent = autoComputeMaxConcurrent
    ? Math.max(configuredMaxConcurrent, providerLimitSum)
    : configuredMaxConcurrent;

  if (autoComputeMaxConcurrent && effectiveMaxConcurrent > configuredMaxConcurrent) {
    const warningKey = `${configuredMaxConcurrent}:${providerLimitSum}:${effectiveMaxConcurrent}`;
    if (warningKey !== lastEffectiveMaxConcurrentWarningKey) {
      const targetLogger = options.logger && typeof options.logger.warn === 'function'
        ? options.logger
        : logger;
      targetLogger.warn(
        `[Concurrency] Auto-computed max_concurrent=${effectiveMaxConcurrent} from enabled provider limits (configured=${configuredMaxConcurrent}, provider_sum=${providerLimitSum})`,
      );
      lastEffectiveMaxConcurrentWarningKey = warningKey;
    }
  }

  return {
    configuredMaxConcurrent,
    autoComputeMaxConcurrent,
    providerLimitSum,
    effectiveMaxConcurrent,
  };
}

/**
 * Update provider configuration
 * @param {any} providerId
 * @param {any} config
 * @returns {any}
 */
function updateProvider(providerId, config) {
  const allowed = ['enabled', 'priority', 'cli_path', 'cli_args', 'quota_error_patterns', 'max_concurrent', 'transport'];
  const updates = [];
  const values = [];

  for (const key of allowed) {
    if (config[key] !== undefined) {
      if (key === 'transport') {
        const normalizedTransport = normalizeProviderTransport(config[key], providerId);
        if (!VALID_PROVIDER_TRANSPORTS.has(String(config[key]).trim().toLowerCase())) {
          throw new Error(`Invalid transport: ${config[key]}`);
        }
        updates.push(`${key} = ?`);
        values.push(normalizedTransport);
        continue;
      }
      updates.push(`${key} = ?`);
      if (key === 'quota_error_patterns' && Array.isArray(config[key])) {
        values.push(JSON.stringify(config[key]));
      } else {
        values.push(config[key]);
      }
    }
  }

  if (updates.length === 0) return getProvider(providerId);

  updates.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(providerId);

  const stmt = db.prepare(`UPDATE provider_config SET ${updates.join(', ')} WHERE provider = ?`);
  stmt.run(...values);

  return getProvider(providerId);
}

/**
 * Get the default provider
 * @returns {any}
 */
function getDefaultProvider() {
  return getDatabaseConfig('default_provider') || 'codex';
}

/**
 * Set the default provider
 * @param {any} providerId
 * @returns {any}
 */
function setDefaultProvider(providerId) {
  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  if (!provider.enabled) {
    throw new Error(`Provider ${providerId} is disabled`);
  }
  setConfig('default_provider', providerId);
  return providerId;
}

// ============================================================
// Smart Routing Analysis
// ============================================================

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

  // Check if smart routing is enabled
  const smartRoutingEnabled = getDatabaseConfig('smart_routing_enabled') === '1';
  if (!smartRoutingEnabled) {
    return {
      provider: getDefaultProvider(),
      rule: null,
      reason: 'Smart routing disabled'
    };
  }

  const economyArg = options.economy;
  const workflowId = options.workflowId;
  let economyPolicy = null;

  if (typeof resolveEconomyPolicy === 'function') {
    economyPolicy = resolveEconomyPolicy({ economy: economyArg }, workflowId, workingDirectory);
  }

  if (economyPolicy && economyPolicy.enabled && typeof filterProvidersForEconomy === 'function') {
    const skipEconomyForComplex = economyPolicy.complexity_exempt &&
      hostManagementFns?.determineTaskComplexity &&
      hostManagementFns.determineTaskComplexity(taskDescription, files) === 'complex';

    if (!skipEconomyForComplex) {
      const econFilter = filterProvidersForEconomy(economyPolicy);
      const preferredProviders = Array.isArray(econFilter?.preferred) ? econFilter.preferred : [];
      const allowedProviders = Array.isArray(econFilter?.allowed) ? econFilter.allowed : [];
      const isEconomyProviderAvailable = (providerId) => {
        const providerConfig = getProvider(providerId);
        return providerConfig && providerConfig.enabled && isProviderHealthy(providerId);
      };

      for (const provider of preferredProviders) {
        if (isEconomyProviderAvailable(provider)) {
          return {
            provider,
            rule: null,
            reason: `Economy mode preferred provider: ${provider}`
          };
        }
      }

      for (const provider of allowedProviders) {
        if (isEconomyProviderAvailable(provider)) {
          return {
            provider,
            rule: null,
            reason: `Economy mode allowed provider: ${provider}`
          };
        }
      }

      return { provider: null, rule: null, reason: 'Economy mode: all economy-tier providers exhausted' };
    }
  }

  // Check Ollama health from cache
  const ollamaHealthy = isOllamaHealthy();

  // prefer_free: restrict to $0 providers — local Ollama first, then cloud free tiers
  if (preferFree) {
    // Try local Ollama if healthy (best free option: no rate limits, 24GB VRAM)
    if (ollamaHealthy !== false) {
      const descLower = (taskDescription || '').toLowerCase();
      const hasFileRef = /[\w\-./\\]+\.\w{1,5}\b/.test(taskDescription);
      const isEditTask = hasFileRef && /\b(fix|update|change|modify|add|insert|remove|rename)\b/i.test(descLower);
      const provider = isEditTask ? 'hashline-ollama' : 'ollama';
      const providerConfig = getProvider(provider);
      if (providerConfig && providerConfig.enabled) {
        return { provider, rule: null, reason: `Free routing: local Ollama (${provider})`, complexity: 'normal' };
      }
    }
    // Fallback to cloud free tiers
    const cloudFreeOrder = ['google-ai', 'groq', 'openrouter', 'ollama-cloud', 'cerebras'];
    for (const p of cloudFreeOrder) {
      const apiKey = serverConfig.getApiKey(p);
      if (!apiKey) continue;
      const pConfig = getProvider(p);
      if (pConfig && pConfig.enabled) {
        return { provider: p, rule: null, reason: `Free routing: cloud free tier (${p})`, complexity: 'normal' };
      }
    }
    // No free providers available — fall through to normal routing with a warning
    logger.warn('[SmartRouting] prefer_free requested but no free providers available, falling through to normal routing');
  }
  const ollamaFallbackProvider = getDatabaseConfig('ollama_fallback_provider') || 'codex';

  const descLower = (taskDescription || '').toLowerCase();

  // API provider routing: Groq for docs/explanations, DeepInfra/Hyperbolic for complex
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
    if (diProvider && diProvider.enabled) {
      const matchType = isReasoningTask ? 'complex reasoning' : isLargeCodeTask ? 'large code generation' : 'architectural';
      return {
        provider: 'deepinfra',
        rule: null,
        reason: `API routing: ${matchType} task → deepinfra (large model)`
      };
    }
  }

  // Hyperbolic as fallback for large-model tasks when DeepInfra unavailable
  if ((isReasoningTask || isLargeCodeTask) && hyperbolicApiKey && !deepinfraApiKey) {
    const hProvider = getProvider('hyperbolic');
    if (hProvider && hProvider.enabled) {
      const matchType = isReasoningTask ? 'complex reasoning' : 'large code generation';
      return {
        provider: 'hyperbolic',
        rule: null,
        reason: `API routing: ${matchType} task → hyperbolic (large model)`
      };
    }
  }

  // Ollama Cloud routing: reasoning/analysis/large-code tasks to 480B+ models (free tier)
  // Falls after deepinfra/hyperbolic (paid large models) but before groq/local ollama
  const ollamaCloudApiKey = serverConfig.getApiKey('ollama-cloud');
  if ((isReasoningTask || isLargeCodeTask || isArchitecturalTask) && ollamaCloudApiKey) {
    const ocProvider = getProvider('ollama-cloud');
    if (ocProvider && ocProvider.enabled) {
      const matchType = isReasoningTask ? 'complex reasoning' : isLargeCodeTask ? 'large code generation' : 'architectural';
      return {
        provider: 'ollama-cloud',
        rule: null,
        reason: `API routing: ${matchType} task → ollama-cloud (480B+ model, free)`
      };
    }
  }

  const isDocsTask = /\b(document|explain|summarize|describe|comment|readme|changelog|jsdoc|docstring)\b/i.test(taskDescription);
  const isSimpleGenTask = /\b(commit message|boilerplate|scaffold|template|stub)\b/i.test(taskDescription);

  if ((isDocsTask || isSimpleGenTask) && groqApiKey) {
    const groqProvider = getProvider('groq');
    if (groqProvider && groqProvider.enabled) {
      const matchType = isDocsTask ? 'documentation' : 'simple generation';
      return {
        provider: 'groq',
        rule: null,
        reason: `API routing: ${matchType} task → groq`
      };
    }
  }

  // Collect all file extensions from working directory and explicit files
  const fileExtensions = new Set();
  if (files && Array.isArray(files)) {
    for (const file of files) {
      const ext = file.includes('.') ? '.' + file.split('.').pop().toLowerCase() : '';
      if (ext) fileExtensions.add(ext);
    }
  }

  // Helper to check if provider needs Ollama and handle fallback
  const isOllamaProvider = (provider) => provider === 'ollama' || provider === 'aider-ollama' || provider === 'hashline-ollama';

  const maybeApplyFallback = (result) => {
    if (!skipHealthCheck && isOllamaProvider(result.provider) && ollamaHealthy === false) {
      // TDA-01: Do not silently reroute when the user explicitly chose a provider.
      // Explicit provider intent is sovereign — let the task queue and fail honestly
      // rather than silently executing under a different provider identity.
      if (isUserOverride) {
        logger.info(`[SmartRouting] Ollama unhealthy but user explicitly requested ${result.provider} — preserving intent (TDA-01)`);
        return result;
      }
      return {
        provider: ollamaFallbackProvider,
        rule: result.rule,
        reason: `${result.reason} [Ollama unavailable - falling back to ${ollamaFallbackProvider}]`,
        originalProvider: result.provider,
        fallbackApplied: true
      };
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
        return {
          provider: ollamaFallbackProvider,
          rule: result.rule,
          reason: `${result.reason} [context overflow: ~${estimatedTotal} tokens > ${localCtxLimit} limit, rerouted to ${ollamaFallbackProvider}]`,
          originalProvider: result.provider,
          fallbackApplied: true,
          contextOverflow: true,
        };
      }
    }

    return result;
  };

  // Per-task routing template (overrides global active template)
  // Callers can pass options.taskMetadata._routing_template = "Template Name" or ID
  // to override the globally active template for this specific task.
  const taskMeta = options.taskMetadata || {};
  const taskTemplateName = taskMeta._routing_template;
  if (taskTemplateName && categoryClassifier && templateStore) {
    const taskTemplate = templateStore.resolveTemplateByNameOrId(taskTemplateName);
    if (taskTemplate) {
      const category = categoryClassifier.classify(taskDescription, files);
      const complexity = hostManagementFns?.determineTaskComplexity
        ? hostManagementFns.determineTaskComplexity(taskDescription, files)
        : 'normal';
      const resolved = templateStore.resolveProvider(taskTemplate, category, complexity);
      if (resolved) {
        const provConfig = getProvider(resolved.provider);
        if (provConfig && provConfig.enabled) {
          return maybeApplyFallback({
            provider: resolved.provider,
            model: resolved.model,
            chain: resolved.chain,
            rule: null,
            complexity,
            reason: `Task template '${taskTemplate.name}': ${category} -> ${resolved.provider}`,
          });
        }
        // Primary unavailable — try chain
        if (resolved.chain && resolved.chain.length > 1) {
          for (let i = 1; i < resolved.chain.length; i++) {
            const fb = resolved.chain[i];
            const fbConfig = getProvider(fb.provider);
            if (fbConfig && fbConfig.enabled) {
              return maybeApplyFallback({
                provider: fb.provider, model: fb.model, chain: resolved.chain,
                rule: null, complexity,
                reason: `Task template '${taskTemplate.name}': ${category} -> ${resolved.provider} (unavailable), chain to ${fb.provider}`,
              });
            }
          }
        }
      }
    }
  }

  // Template-based routing (user-configurable category -> provider mapping)
  // Only active when a user has explicitly set a template via activate_routing_template.
  // getActiveTemplate() falls back to System Default — we skip that fallback here
  // so existing users see zero behavior change until they opt in.
  if (categoryClassifier && templateStore) {
    const explicitTemplateId = templateStore.getExplicitActiveTemplateId();
    const activeTemplate = explicitTemplateId ? templateStore.getTemplate(explicitTemplateId) : null;
    if (activeTemplate) {
      const category = categoryClassifier.classify(taskDescription, files);
      const complexity = hostManagementFns?.determineTaskComplexity
        ? hostManagementFns.determineTaskComplexity(taskDescription, files)
        : 'normal';
      const resolved = templateStore.resolveProvider(activeTemplate, category, complexity);
      if (resolved) {
        // resolveProvider returns {provider, model, chain, toString(), valueOf()}
        // Check primary provider availability
        const providerConfig = getProvider(resolved.provider);
        if (providerConfig && providerConfig.enabled) {
          return maybeApplyFallback({
            provider: resolved.provider,
            model: resolved.model || null,
            chain: resolved.chain,
            rule: null,
            complexity,
            reason: `Template '${activeTemplate.name}': ${category} -> ${resolved.provider}`,
          });
        }
        // Primary unavailable — iterate chain to find next enabled provider
        if (resolved.chain && resolved.chain.length > 1) {
          for (let i = 1; i < resolved.chain.length; i++) {
            const entry = resolved.chain[i];
            const entryConfig = getProvider(entry.provider);
            if (entryConfig && entryConfig.enabled) {
              return maybeApplyFallback({
                provider: entry.provider,
                model: entry.model || null,
                chain: resolved.chain,
                rule: null,
                complexity,
                reason: `Template '${activeTemplate.name}': ${category} -> ${resolved.provider} (unavailable), chain fallback -> ${entry.provider}`,
              });
            }
          }
        }
        // Chain exhausted — try default category
        const defaultResolved = templateStore.resolveProvider(activeTemplate, 'default', complexity);
        if (defaultResolved && defaultResolved.provider !== resolved.provider) {
          const defaultConfig = getProvider(defaultResolved.provider);
          if (defaultConfig && defaultConfig.enabled) {
            return maybeApplyFallback({
              provider: defaultResolved.provider,
              model: defaultResolved.model || null,
              chain: defaultResolved.chain,
              rule: null,
              complexity,
              reason: `Template '${activeTemplate.name}': ${category} -> ${resolved.provider} (unavailable), fallback to default -> ${defaultResolved.provider}`,
            });
          }
        }
      }
    }
  }

  // Helper: detect if a task is a targeted file edit (good for hashline-ollama)
  // These are tasks that reference specific files and make bounded changes
  const isTargetedFileEdit = (desc) => {
    // Must reference at least one file
    const hasFileRef = /[\w\-./\\]+\.\w{1,5}\b/.test(taskDescription);
    if (!hasFileRef) return false;
    // Match edit-type verbs applied to specific targets
    const editPatterns = [
      /\b(add|insert|append)\b.{0,30}\b(jsdoc|comment|docstring|annotation|import|export|field|property|method|function|getter|setter|constructor|decorator|attribute|type|param|return)\b/i,
      /\b(fix|update|change|modify|replace|rename|move)\b.{0,40}\b(in|at|on|to)\b/i,
      /\b(remove|delete)\b.{0,30}\b(unused|dead|deprecated|obsolete|import|line|method|function|comment)\b/i,
      /\b(add|write|create)\b.{0,20}\b(test|spec)\b.{0,20}\b(for|to|in)\b/i,
      /\bjsdoc\b|\bdocstring\b|\bxml doc\b|\btsdoc\b/i,
      /\badd\b.{0,15}\b(logging|log statement|console\.log)\b/i,
      /\b(add|update)\b.{0,20}\b(error handling|validation|null check|type guard)\b/i,
    ];
    return editPatterns.some(p => p.test(desc));
  };

  // PRIMARY: Complexity-based routing (Claude workflow)
  // - Simple tasks → Laptop WSL (default host)
  // - Normal tasks → Desktop (desktop-17)
  // - Complex tasks → Codex
  if (hostManagementFns?.determineTaskComplexity && hostManagementFns?.routeTask) {
    const complexity = hostManagementFns.determineTaskComplexity(taskDescription, files);
    const complexityRouting = hostManagementFns.routeTask(complexity);

    if (complexityRouting && complexityRouting.provider) {
      // Build reason string with fallback info if applicable
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

      // HASHLINE-OLLAMA UPGRADE: For simple/normal tasks routed to a local LLM
      // that are targeted file edits, use hashline-ollama instead of aider-ollama.
      // Hashline is faster (no aider overhead) and more reliable (hash-verified edits).
      if ((complexity === 'simple' || complexity === 'normal') &&
          (result.provider === 'aider-ollama' || result.provider === 'ollama') &&
          isTargetedFileEdit(descLower)) {
        const hashlineProvider = getProvider('hashline-ollama');
        if (hashlineProvider && hashlineProvider.enabled) {
          result.provider = 'hashline-ollama';
          result.reason += ` [upgraded to hashline-ollama: targeted file edit]`;
          logger.info(`[SmartRouting] Upgraded to hashline-ollama for targeted file edit`);
        }
      }

      // For ollama providers, include host selection
      if (isOllamaProvider(result.provider) && result.hostId) {
        result.selectedHost = result.hostId;
      }

      return maybeApplyFallback(result);
    }
  }

  // FALLBACK: Legacy keyword/extension rules
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
  const defaultSmartProvider = getDatabaseConfig('smart_routing_default_provider') || 'hashline-ollama';
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

  return result;
}

/**
 * Mark a task as pending provider switch (after quota error)
 * @param {any} taskId
 * @param {any} reason
 * @returns {any}
 */
function markTaskPendingProviderSwitch(taskId, reason) {
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
const LOCAL_PROVIDERS = ['ollama', 'aider-ollama', 'hashline-ollama'];

/**
 * Get the fallback chain for a provider.
 * @param {string} provider - Source provider name
 * @param {Object} [options]
 * @param {boolean} [options.cloudOnly] - If true, filter the chain to cloud providers only
 * @returns {string[]} Ordered fallback provider names
 */
function getProviderFallbackChain(provider, options) {
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
    // hashline-ollama is the primary local edit provider (82% success rate).
    // aider-ollama is legacy (11% success) and demoted in all chains.
    // groq removed from fallback chains — its tool calling fails on multi-step
    // tasks (only reliable for single-tool-call docs/simple tasks via smart routing).
    const defaultChains = {
      'codex':           ['claude-cli', 'deepinfra', 'ollama-cloud', 'hashline-ollama', 'ollama'],
      'claude-cli':      ['codex', 'deepinfra', 'ollama-cloud', 'hashline-ollama', 'ollama'],
      'groq':            ['ollama-cloud', 'cerebras', 'deepinfra', 'claude-cli', 'hashline-ollama'],
      'ollama-cloud':    ['cerebras', 'deepinfra', 'codex', 'claude-cli'],
      'cerebras':        ['google-ai', 'ollama-cloud', 'deepinfra', 'codex'],
      'google-ai':       ['openrouter', 'cerebras', 'ollama-cloud', 'deepinfra', 'codex'],
      'openrouter':      ['google-ai', 'cerebras', 'ollama-cloud', 'deepinfra', 'codex'],
      'hyperbolic':      ['deepinfra', 'ollama-cloud', 'claude-cli', 'codex', 'hashline-ollama'],
      'deepinfra':       ['ollama-cloud', 'hyperbolic', 'claude-cli', 'codex', 'hashline-ollama'],
      'ollama':          ['hashline-ollama', 'ollama-cloud', 'deepinfra', 'codex', 'claude-cli'],
      'aider-ollama':    ['hashline-ollama', 'ollama', 'ollama-cloud', 'deepinfra', 'codex', 'claude-cli'],
      'hashline-ollama': ['ollama', 'ollama-cloud', 'deepinfra', 'codex', 'claude-cli'],
    };
    chain = defaultChains[provider] || ['hashline-ollama', 'ollama', 'deepinfra', 'codex', 'claude-cli'];
  }

  // Filter to cloud-only if requested (used by Ollama→cloud fallback paths)
  if (options && options.cloudOnly) {
    const localSet = new Set(LOCAL_PROVIDERS);
    return chain.filter(p => !localSet.has(p));
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

  // EXP7: Raw ollama cannot create new files — skip it for greenfield tasks.
  const isGreenfield = task.task_description &&
    /\b(create|write|generate|scaffold|build)\s+(a\s+)?(new\s+)?(file|test|module|class|component|spec)\b/i.test(task.task_description);

  for (const candidate of chain) {
    if (triedProviders.has(candidate)) continue;
    if (candidate === 'ollama' && isGreenfield) {
      logger.info(`[FallbackChain] Skipping raw ollama for greenfield task ${taskId} — it produces instructions instead of code`);
      continue;
    }
    const p = getProvider(candidate);
    if (p && p.enabled) return candidate;
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
  currentMetadata.user_provider_override = true;
  delete currentMetadata.free_tier_overflow;
  delete currentMetadata.original_provider;

  const stmt = db.prepare(`
    UPDATE tasks
    SET status = 'queued',
        original_provider = COALESCE(original_provider, provider),
        provider = ?,
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
  const result = stmt.run(newProvider, new Date().toISOString(), JSON.stringify(currentMetadata), taskId);
  if (result && result.changes > 0) {
    process.emit('torque:queue-changed');
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
  return getDatabaseConfig('codex_exhausted') === '1';
}

/**
 * Set or clear the Codex exhaustion flag.
 * @param {boolean} exhausted - true to mark exhausted, false to clear
 */
function setCodexExhausted(exhausted) {
  setConfig('codex_exhausted', exhausted ? '1' : '0');
  if (exhausted) {
    setConfig('codex_exhausted_at', new Date().toISOString());
  }
}

// ============================================================
// Ollama Health Check / Auto-Start / WSL2
// ============================================================

// Ollama health check cache
const ollamaHealthCache = {
  healthy: null,
  checkedAt: null,
  cacheDurationMs: 30000  // Cache for 30 seconds
};

// Prevent concurrent auto-start attempts
let ollamaAutoStartInProgress = false;

/**
 * Detect if running in WSL2 and get the Windows host IP
 * @returns {string|null} Windows host IP or null if not in WSL2
 */
function detectWSL2HostIP() {
  const { execFileSync } = require('child_process');

  // Check if we're in WSL
  try {

    const procVersion = fs.readFileSync('/proc/version', 'utf8');
    if (!procVersion.toLowerCase().includes('microsoft')) {
      return null; // Not WSL
    }
  } catch {
    return null; // Can't read /proc/version, not Linux
  }

  // Get the default gateway IP using ip command with safe arguments
  try {
    const routeOutput = execFileSync('ip', ['route'], { encoding: 'utf8' });
    const lines = routeOutput.split('\n');
    for (const line of lines) {
      if (line.startsWith('default via')) {
        const parts = line.split(' ');
        const idx = parts.indexOf('via');
        if (idx !== -1 && parts[idx + 1]) {
          const hostIP = parts[idx + 1];
          if (/^\d+\.\d+\.\d+\.\d+$/.test(hostIP)) {
            return hostIP;
          }
        }
      }
    }
  } catch (e) {
    logger.warn('[Ollama] Failed to detect WSL2 host IP:', e.message);
  }

  return null;
}

/**
 * Find the Ollama binary, checking common locations and WSL/Windows paths
 * @returns {string|null} Path to Ollama binary or null if not found
 */
function findOllamaBinary() {

  // Check configured path first
  const configuredPath = getDatabaseConfig('ollama_binary_path');
  if (configuredPath && fs.existsSync(configuredPath)) {
    try {
      const stats = fs.statSync(configuredPath);
      if (stats.size > 1000) { // Real binary, not a placeholder
        return configuredPath;
      }
    } catch {
      // Continue to other paths
    }
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  // Common paths to check (Linux/Mac)
  const linuxPaths = [
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
    path.join(homeDir, '.local/bin/ollama'),
    '/opt/ollama/ollama'
  ];

  // Check Linux paths
  for (const p of linuxPaths) {
    if (fs.existsSync(p)) {
      try {
        const stats = fs.statSync(p);
        if (stats.size > 1000) { // Real binary, not a placeholder
          return p;
        }
      } catch {
        continue;
      }
    }
  }

  // Check Windows paths via glob (safe since we control the pattern)
  const windowsPatterns = [
    ['/mnt/c/Users', 'AppData/Local/Programs/Ollama/ollama.exe'],
    ['/mnt/c/Program Files/Ollama', 'ollama.exe']
  ];

  for (const [baseDir, subPath] of windowsPatterns) {
    try {
      if (fs.existsSync(baseDir)) {
        const entries = fs.readdirSync(baseDir);
        for (const entry of entries) {
          const fullPath = path.join(baseDir, entry, subPath);
          if (fs.existsSync(fullPath)) {
            const stats = fs.statSync(fullPath);
            if (stats.size > 1000) {
              return fullPath;
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Also check direct Program Files path
  const programFilesPath = '/mnt/c/Program Files/Ollama/ollama.exe';
  if (fs.existsSync(programFilesPath)) {
    try {
      const stats = fs.statSync(programFilesPath);
      if (stats.size > 1000) {
        return programFilesPath;
      }
    } catch {
      // Continue
    }
  }

  return null;
}

/**
 * Wait for Ollama to become ready by polling the API
 * @param {number} timeoutMs Maximum time to wait
 * @returns {Promise<boolean>} True if Ollama became ready
 */
async function waitForOllamaReady(timeoutMs) {
  const http = require('http');
  const https = require('https');
  const startTime = Date.now();
  const pollInterval = 500; // Check every 500ms

  const ollamaHost = getDatabaseConfig('ollama_host') || 'http://localhost:11434';
  const url = new URL('/api/tags', ollamaHost);
  const client = url.protocol === 'https:' ? https : http;

  while (Date.now() - startTime < timeoutMs) {
    const isReady = await new Promise((resolve) => {
      const req = client.get(url.toString(), { timeout: 2000 }, (res) => {
        // CRITICAL: Must consume response body to prevent memory leak
        // Without this, response data accumulates in memory
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });

    if (isReady) {
      return true;
    }

    // Wait before next poll
    await new Promise(r => setTimeout(r, pollInterval));
  }

  return false;
}

/**
 * Attempt to start Ollama service
 * @param {void} _ - No parameters.
 * @returns {Promise<boolean>} True if Ollama was started successfully
 */
async function attemptOllamaStart() {
  if (ollamaAutoStartInProgress) {
    logger.warn('[Ollama] Auto-start already in progress');
    return false;
  }

  const autoStartEnabled = getDatabaseConfig('ollama_auto_start_enabled') === '1';
  if (!autoStartEnabled) {
    return false;
  }

  ollamaAutoStartInProgress = true;

  try {
    const { spawn, execFileSync } = require('child_process');

    // Check if we're in WSL and Ollama is on Windows
    const wslHostIP = detectWSL2HostIP();
    const binaryPath = findOllamaBinary();

    if (wslHostIP && binaryPath && binaryPath.includes('/mnt/c/')) {
      // Ollama is on Windows - try to start it via Windows
      logger.info('[Ollama] Detected Windows Ollama in WSL2 environment');

      // Convert WSL path to Windows path and start
      const winPath = binaryPath.replace(/^\/mnt\/([a-z])\//, '$1:\\').replace(/\//g, '\\');

      try {
        // Start Ollama on Windows using cmd.exe with safe arguments
        execFileSync('cmd.exe', ['/c', 'start', '""', winPath, 'serve'], {
          stdio: 'ignore',
          windowsHide: true
        });
        logger.info('[Ollama] Started Windows Ollama');
      } catch (e) {
        logger.error('[Ollama] Failed to start Windows Ollama:', e.message);
        return false;
      }

      // Update host to use Windows IP
      const currentHost = getDatabaseConfig('ollama_host') || 'http://localhost:11434';
      if (currentHost.includes('localhost') || currentHost.includes('127.0.0.1')) {
        const newHost = `http://${wslHostIP}:11434`;
        setConfig('ollama_host', newHost);
        logger.info(`[Ollama] Updated host for WSL2: ${newHost}`);
      }
    } else if (binaryPath && !binaryPath.includes('/mnt/c/')) {
      // Native Linux Ollama
      logger.info(`[Ollama] Starting native Ollama: ${binaryPath}`);

      const child = spawn(binaryPath, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } else {
      logger.warn('[Ollama] No Ollama binary found');
      return false;
    }

    // Wait for Ollama to be ready
    const timeoutMs = parseInt(getDatabaseConfig('ollama_auto_start_timeout_ms') || '15000');
    logger.info(`[Ollama] Waiting up to ${timeoutMs}ms for Ollama to start...`);

    const isReady = await waitForOllamaReady(timeoutMs);

    if (isReady) {
      logger.info('[Ollama] Successfully started and ready');
      ollamaHealthCache.healthy = true;
      ollamaHealthCache.checkedAt = Date.now();
      return true;
    } else {
      logger.warn('[Ollama] Start timeout - Ollama did not become ready');
      return false;
    }
  } catch (error) {
    logger.error('[Ollama] Auto-start failed:', error.message);
    return false;
  } finally {
    ollamaAutoStartInProgress = false;
  }
}

/**
 * Auto-detect and configure WSL2 host if enabled
 * @param {void} _ - No parameters.
 * @returns {boolean} True when host settings were updated.
 */
function autoConfigureWSL2Host() {
  const autoDetect = getDatabaseConfig('ollama_auto_detect_wsl_host');
  // Default to enabled if not set
  if (autoDetect !== '0') {
    const wslHostIP = detectWSL2HostIP();
    if (wslHostIP) {
      const currentHost = getDatabaseConfig('ollama_host') || 'http://localhost:11434';
      if (currentHost.includes('localhost') || currentHost.includes('127.0.0.1')) {
        const newHost = `http://${wslHostIP}:11434`;
        setConfig('ollama_host', newHost);
        logger.info(`[Ollama] Auto-configured WSL2 host: ${newHost}`);
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if Ollama is reachable (with caching and auto-start support)
 */
async function checkOllamaHealth(forceCheck = false) {
  const now = Date.now();

  // Return cached result if still valid
  if (!forceCheck && ollamaHealthCache.checkedAt &&
      (now - ollamaHealthCache.checkedAt) < ollamaHealthCache.cacheDurationMs) {
    return ollamaHealthCache.healthy;
  }

  // Auto-detect WSL2 host on first check
  autoConfigureWSL2Host();

  const ollamaHost = getDatabaseConfig('ollama_host') || 'http://localhost:11434';
  const http = require('http');
  const https = require('https');
  const url = new URL('/api/tags', ollamaHost);
  const client = url.protocol === 'https:' ? https : http;

  const healthCheckTimeout = OLLAMA_HEALTH_CHECK_TIMEOUT_MS;

  // First attempt to connect
  const isHealthy = await new Promise((resolve) => {
    const req = client.get(url.toString(), { timeout: healthCheckTimeout }, (res) => {
      // CRITICAL: Must consume response body to prevent memory leak
      res.resume();
      resolve(res.statusCode === 200);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });

  if (isHealthy) {
    ollamaHealthCache.healthy = true;
    ollamaHealthCache.checkedAt = now;
    return true;
  }

  // Not healthy - try auto-start if enabled
  const autoStartEnabled = getDatabaseConfig('ollama_auto_start_enabled') === '1';
  if (autoStartEnabled && !ollamaAutoStartInProgress) {
    logger.warn('[Ollama] Health check failed, attempting auto-start...');
    const started = await attemptOllamaStart();
    if (started) {
      return true; // attemptOllamaStart updates the cache
    }
  }

  // Still not healthy
  ollamaHealthCache.healthy = false;
  ollamaHealthCache.checkedAt = now;
  return false;
}

/**
 * Synchronous check using cached Ollama health status
 * @returns {any}
 */
function isOllamaHealthy() {
  // If we have a recent check, use it
  if (ollamaHealthCache.checkedAt &&
      (Date.now() - ollamaHealthCache.checkedAt) < ollamaHealthCache.cacheDurationMs) {
    return ollamaHealthCache.healthy;
  }

  // In multi-host mode, check if any hosts are marked healthy
  if (hostManagementFns) {
    const hosts = hostManagementFns?.listOllamaHosts?.() || [];
    if (!Array.isArray(hosts)) return false;
    if (hosts.length > 0) {
      const healthyHosts = hosts.filter(h => h.enabled && h.status === 'healthy');
      if (healthyHosts.length > 0) {
        // Found healthy hosts - update cache and return true
        ollamaHealthCache.healthy = true;
        ollamaHealthCache.checkedAt = Date.now();
        return true;
      }
    }
  }

  // If no recent check, assume healthy and let async check update
  return null;  // Unknown
}

/**
 * Clear Ollama health cache (call when Ollama task fails)
 * @returns {any}
 */
function invalidateOllamaHealth() {
  ollamaHealthCache.healthy = false;
  ollamaHealthCache.checkedAt = Date.now();
}

/**
 * Set Ollama health cache status (call from multi-host health checks)
 * @param {boolean} healthy - Whether Ollama is healthy
 * @returns {any}
 */
function setOllamaHealthy(healthy) {
  ollamaHealthCache.healthy = healthy;
  ollamaHealthCache.checkedAt = Date.now();
}

/**
 * Check if any healthy Ollama host has available capacity.
 * Delegates to host-management module via dependency injection.
 * @returns {boolean}
 */
function hasHealthyOllamaHost() {
  if (!hostManagementFns || !hostManagementFns.hasHealthyOllamaHost) {
    return false;
  }
  return hostManagementFns.hasHealthyOllamaHost();
}


// ============================================================
// Provider Stats (merged from provider-routing-stats.js)
// ============================================================

function getPrometheusMetrics() {
  const metrics = [];

  // Task counts by status
  const taskCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM tasks
    GROUP BY status
  `).all();

  for (const { status, count } of taskCounts) {
    metrics.push(`codexbridge_tasks_total{status="${escapePrometheusLabel(status)}"} ${count}`);
  }

  // Active agents
  const agentCount = db.prepare(`
    SELECT COUNT(*) as count FROM agents WHERE status = 'online'
  `).get();
  metrics.push(`codexbridge_active_agents ${agentCount.count}`);

  // Task duration histogram (approximate buckets)
  const durations = db.prepare(`
    SELECT
      CASE
        WHEN julianday(completed_at) - julianday(started_at) <= 1.0/24/60 THEN '60'
        WHEN julianday(completed_at) - julianday(started_at) <= 5.0/24/60 THEN '300'
        WHEN julianday(completed_at) - julianday(started_at) <= 30.0/24/60 THEN '1800'
        ELSE '3600'
      END as bucket,
      COUNT(*) as count
    FROM tasks
    WHERE completed_at IS NOT NULL AND started_at IS NOT NULL
    GROUP BY bucket
  `).all();

  for (const { bucket, count } of durations) {
    metrics.push(`codexbridge_task_duration_seconds_bucket{le="${bucket}"} ${count}`);
  }

  // Workflow counts
  const workflowCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM workflows
    GROUP BY status
  `).all();

  for (const { status, count } of workflowCounts) {
    metrics.push(`codexbridge_workflows_total{status="${escapePrometheusLabel(status)}"} ${count}`);
  }

  // Token usage
  const tokenUsage = db.prepare(`
    SELECT SUM(total_tokens) as total, SUM(estimated_cost_usd) as cost
    FROM token_usage
    WHERE recorded_at >= date('now', '-1 day')
  `).get();

  metrics.push(`codexbridge_tokens_daily_total ${tokenUsage.total || 0}`);
  metrics.push(`codexbridge_cost_daily_usd ${tokenUsage.cost || 0}`);

  // --- Extended metrics ---

  // Queue wait time histogram (time from created_at to started_at)
  const queueWaits = db.prepare(`
    SELECT
      CASE
        WHEN (julianday(started_at) - julianday(created_at)) * 86400 <= 10 THEN '10'
        WHEN (julianday(started_at) - julianday(created_at)) * 86400 <= 30 THEN '30'
        WHEN (julianday(started_at) - julianday(created_at)) * 86400 <= 60 THEN '60'
        WHEN (julianday(started_at) - julianday(created_at)) * 86400 <= 300 THEN '300'
        ELSE '600'
      END as bucket,
      COUNT(*) as count
    FROM tasks
    WHERE created_at IS NOT NULL AND started_at IS NOT NULL
    GROUP BY bucket
  `).all();
  for (const { bucket, count } of queueWaits) {
    metrics.push(`codexbridge_queue_wait_seconds_bucket{le="${bucket}"} ${count}`);
  }

  // Tasks by provider
  const providerTasks = db.prepare(`
    SELECT provider, COUNT(*) as count
    FROM tasks
    WHERE provider IS NOT NULL
    GROUP BY provider
  `).all();
  for (const { provider, count } of providerTasks) {
    metrics.push(`codexbridge_provider_tasks_total{provider="${escapePrometheusLabel(provider)}"} ${count}`);
  }

  // Average duration by provider
  const providerDurations = db.prepare(`
    SELECT provider,
      AVG((julianday(completed_at) - julianday(started_at)) * 86400) as avg_duration
    FROM tasks
    WHERE provider IS NOT NULL AND completed_at IS NOT NULL AND started_at IS NOT NULL
    GROUP BY provider
  `).all();
  for (const { provider, avg_duration } of providerDurations) {
    metrics.push(`codexbridge_provider_duration_seconds{provider="${escapePrometheusLabel(provider)}"} ${(avg_duration || 0).toFixed(2)}`);
  }

  // Host slot usage
  try {
    const hostSlots = db.prepare(`
      SELECT name, running_tasks, max_concurrent
      FROM ollama_hosts
      WHERE enabled = 1
    `).all();
    for (const { name, running_tasks, max_concurrent } of hostSlots) {
      metrics.push(`codexbridge_host_slots_used{host="${escapePrometheusLabel(name)}"} ${running_tasks || 0}`);
      metrics.push(`codexbridge_host_slots_total{host="${escapePrometheusLabel(name)}"} ${max_concurrent || 1}`);
    }
  } catch { /* ollama_hosts table may not exist in test environments */ }

  // Stall count
  const stallCount = db.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE status = 'failed' AND exit_code = -2
  `).get();
  metrics.push(`codexbridge_stall_total ${stallCount.count}`);

  // Retry count
  const retryCount = db.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE retry_count > 0
  `).get();
  metrics.push(`codexbridge_retry_total ${retryCount.count}`);

  // Provider/transport usage telemetry
  try {
    const transportCallCounts = db.prepare(`
      SELECT
        provider,
        transport,
        CASE
          WHEN success = 1 THEN 'success'
          WHEN success = 0 THEN 'failure'
          ELSE 'unknown'
        END as outcome,
        COUNT(*) as count
      FROM provider_usage
      WHERE provider IS NOT NULL
        AND transport IS NOT NULL
      GROUP BY provider, transport, outcome
    `).all();

    for (const { provider, transport, outcome, count } of transportCallCounts) {
      metrics.push(`codexbridge_provider_transport_calls_total{provider="${escapePrometheusLabel(provider)}",transport="${escapePrometheusLabel(transport)}",outcome="${escapePrometheusLabel(outcome)}"} ${count}`);
    }

    const transportDuration = db.prepare(`
      SELECT
        provider,
        transport,
        SUM(elapsed_ms) as elapsed_sum_ms,
        AVG(elapsed_ms) as elapsed_avg_ms
      FROM provider_usage
      WHERE provider IS NOT NULL
        AND transport IS NOT NULL
        AND elapsed_ms IS NOT NULL
      GROUP BY provider, transport
    `).all();
    for (const {
      provider,
      transport,
      elapsed_sum_ms,
      elapsed_avg_ms,
    } of transportDuration) {
      const avgMs = Number(elapsed_avg_ms);
      metrics.push(`codexbridge_provider_transport_elapsed_ms_sum{provider="${escapePrometheusLabel(provider)}",transport="${escapePrometheusLabel(transport)}"} ${(elapsed_sum_ms || 0)}`);
      metrics.push(`codexbridge_provider_transport_elapsed_ms_avg{provider="${escapePrometheusLabel(provider)}",transport="${escapePrometheusLabel(transport)}"} ${Number.isFinite(avgMs) ? avgMs.toFixed(2) : 0}`);
    }

    const transportRetries = db.prepare(`
      SELECT
        provider,
        transport,
        SUM(retry_count) as retry_count_sum,
        AVG(retry_count) as retry_count_avg
      FROM provider_usage
      WHERE provider IS NOT NULL
        AND transport IS NOT NULL
        AND retry_count IS NOT NULL
      GROUP BY provider, transport
    `).all();
    for (const { provider, transport, retry_count_sum, retry_count_avg } of transportRetries) {
      const avgRetries = Number(retry_count_avg);
      metrics.push(`codexbridge_provider_transport_retry_count_sum{provider="${escapePrometheusLabel(provider)}",transport="${escapePrometheusLabel(transport)}"} ${retry_count_sum || 0}`);
      metrics.push(`codexbridge_provider_transport_retry_count_avg{provider="${escapePrometheusLabel(provider)}",transport="${escapePrometheusLabel(transport)}"} ${Number.isFinite(avgRetries) ? avgRetries.toFixed(2) : 0}`);
    }

    const failureReasons = db.prepare(`
      SELECT
        provider,
        transport,
        failure_reason,
        COUNT(*) as count
      FROM provider_usage
      WHERE provider IS NOT NULL
        AND transport IS NOT NULL
        AND failure_reason IS NOT NULL
        AND TRIM(failure_reason) != ''
      GROUP BY provider, transport, failure_reason
    `).all();
    for (const { provider, transport, failure_reason, count } of failureReasons) {
      metrics.push(`codexbridge_provider_transport_failure_reason_total{provider="${escapePrometheusLabel(provider)}",transport="${escapePrometheusLabel(transport)}",failure_reason="${escapePrometheusLabel(failure_reason)}"} ${count}`);
    }
  } catch {
    metrics.push(`codexbridge_provider_transport_metrics_unavailable 1`);
  }

  // Validation failures
  try {
    const validationFails = db.prepare(`
      SELECT COUNT(*) as count FROM task_validations WHERE passed = 0
    `).get();
    metrics.push(`codexbridge_validation_failures_total ${validationFails.count}`);
  } catch {
    metrics.push(`codexbridge_validation_failures_total 0`);
  }

  // Cost by provider
  try {
    const costByProvider = db.prepare(`
      SELECT provider, SUM(estimated_cost_usd) as cost
      FROM token_usage
      WHERE provider IS NOT NULL
      GROUP BY provider
    `).all();
    for (const { provider, cost } of costByProvider) {
      metrics.push(`codexbridge_cost_by_provider{provider="${escapePrometheusLabel(provider)}"} ${(cost || 0).toFixed(6)}`);
    }
  } catch { /* token_usage may not have provider column */ }

  return metrics.join('\n');
}

// ============================================================
// Stale Task Cleanup
// ============================================================

/**
 * Clean up stale tasks - tasks stuck in 'running' or 'queued' state too long
 * This handles orphaned tasks from server restarts or process crashes
 * @param {number} runningMinutes - Mark running tasks as failed after this many minutes (default: 60)
 * @param {number} queuedMinutes - Mark queued tasks as cancelled after this many minutes (default: 1440 = 24h)
 * @returns {object} - Count of cleaned up tasks
 */
function cleanupStaleTasks(runningMinutes = 60, queuedMinutes = 1440) {
  const now = new Date().toISOString();

  // Calculate cutoff times
  const runningCutoff = new Date(Date.now() - runningMinutes * 60 * 1000).toISOString();
  const queuedCutoff = new Date(Date.now() - queuedMinutes * 60 * 1000).toISOString();

  // Mark stale running tasks as failed
  const staleRunning = db.prepare(`
    UPDATE tasks
    SET status = 'failed',
        completed_at = ?,
        error_output = 'Task marked as failed: no heartbeat (stale session cleanup)'
    WHERE status = 'running'
      AND (started_at < ? OR (started_at IS NULL AND created_at < ?))
  `).run(now, runningCutoff, runningCutoff);

  // Mark very old queued tasks as cancelled (likely abandoned)
  const staleQueued = db.prepare(`
    UPDATE tasks
    SET status = 'cancelled',
        completed_at = ?,
        error_output = 'Task cancelled: queued too long (stale session cleanup)'
    WHERE status = 'queued'
      AND created_at < ?
  `).run(now, queuedCutoff);

  return {
    running_cleaned: staleRunning.changes,
    queued_cleaned: staleQueued.changes,
    total: staleRunning.changes + staleQueued.changes
  };
}

/**
 * Prune completed/failed/cancelled tasks beyond a retention count.
 * Keeps the most recent N tasks of each terminal status.
 * @param {number} maxRetained - Maximum completed tasks to keep (default: 5000)
 * @returns {{ pruned: number }} Count of pruned tasks
 */
function pruneOldTasks(maxRetained = 5000) {
  const result = db.prepare(`
    DELETE FROM tasks WHERE id IN (
      SELECT id FROM tasks
      WHERE status IN ('completed', 'failed', 'cancelled')
      ORDER BY created_at DESC
      LIMIT -1 OFFSET ?
    )
  `).run(maxRetained);
  return { pruned: result.changes };
}

/**
 * Record provider usage for a task
 * @param {any} provider
 * @param {any} taskId
 * @param {any} options
 * @returns {any}
 */
function normalizeProviderUsageParams(
  provider,
  taskId,
  optionsOrTokensUsed,
  costEstimate,
  durationSeconds,
  success,
  errorType,
) {
  if (optionsOrTokensUsed === undefined || optionsOrTokensUsed === null) {
    return {
      provider,
      taskId,
      tokens_used: null,
      cost_estimate: null,
      duration_seconds: null,
      elapsed_ms: null,
      transport: null,
      retry_count: null,
      failure_reason: null,
      success: undefined,
      error_type: null,
    };
  }

  if (typeof optionsOrTokensUsed === 'object' && !Array.isArray(optionsOrTokensUsed)) {
    const options = optionsOrTokensUsed;
    return {
      provider,
      taskId,
      tokens_used: options.tokens_used,
      cost_estimate: options.cost_estimate,
      duration_seconds: options.duration_seconds,
      elapsed_ms: options.elapsed_ms,
      transport: options.transport,
      retry_count: options.retry_count,
      failure_reason: options.failure_reason,
      success: options.success,
      error_type: options.error_type,
    };
  }

  return {
    provider,
    taskId,
    tokens_used: optionsOrTokensUsed,
    cost_estimate: costEstimate,
    duration_seconds: durationSeconds,
    elapsed_ms: null,
    transport: null,
    retry_count: null,
    failure_reason: null,
    success,
    error_type: errorType,
  };
}

function recordProviderUsage(
  provider,
  taskId,
  optionsOrTokensUsed,
  costEstimate,
  durationSeconds,
  success,
  errorType,
) {
  const normalized = normalizeProviderUsageParams(
    provider,
    taskId,
    optionsOrTokensUsed,
    costEstimate,
    durationSeconds,
    success,
    errorType,
  );
  const elapsedMs = normalized.elapsed_ms;
  const retryCount = normalized.retry_count;
  const hasValue = (value) => value !== undefined && value !== null;

  const stmt = db.prepare(`
    INSERT INTO provider_usage (provider, task_id, tokens_used, cost_estimate, duration_seconds, elapsed_ms, transport, retry_count, failure_reason, success, error_type, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    normalized.provider,
    normalized.taskId,
    hasValue(normalized.tokens_used) ? normalized.tokens_used : null,
    hasValue(normalized.cost_estimate) ? normalized.cost_estimate : null,
    hasValue(normalized.duration_seconds) ? normalized.duration_seconds : null,
    Number.isFinite(Number(elapsedMs)) ? elapsedMs : null,
    normalized.transport || null,
    Number.isFinite(Number(retryCount)) ? retryCount : null,
    normalized.failure_reason || null,
    normalized.success !== undefined ? (normalized.success ? 1 : 0) : null,
    normalized.error_type || null,
    new Date().toISOString()
  );
}

/**
 * Get provider usage statistics
 * @param {any} providerId
 * @param {any} days
 * @returns {any}
 */
function getProviderStats(providerId, days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const stats = db.prepare(`
    SELECT
      provider,
      COUNT(*) as total_tasks,
      COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successful_tasks,
      COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) as failed_tasks,
      COALESCE(SUM(tokens_used), 0) as total_tokens,
      COALESCE(SUM(cost_estimate), 0) as total_cost,
      COALESCE(AVG(duration_seconds), 0) as avg_duration_seconds
    FROM provider_usage
    WHERE provider = ? AND recorded_at >= ?
    GROUP BY provider
  `).get(providerId, cutoff);

  if (!stats) {
    return {
      provider: providerId,
      total_tasks: 0,
      successful_tasks: 0,
      failed_tasks: 0,
      success_rate: 0,
      total_tokens: 0,
      total_cost: 0,
      avg_duration_seconds: 0
    };
  }

  stats.success_rate = stats.total_tasks > 0
    ? Math.round((stats.successful_tasks / stats.total_tasks) * 100)
    : 0;

  return stats;
}

// ============================================================
// Provider Health Scoring
// ============================================================
// In-memory sliding window for provider success/failure tracking.
// Resets every hour automatically.

const _providerHealth = new Map();
const HEALTH_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function _getOrCreateHealth(provider) {
  if (!_providerHealth.has(provider)) {
    _providerHealth.set(provider, { successes: 0, failures: 0, lastReset: Date.now() });
  }
  const entry = _providerHealth.get(provider);
  // Auto-reset if window expired — persist the expiring window before clearing
  if (Date.now() - entry.lastReset > HEALTH_WINDOW_MS) {
    const total = entry.successes + entry.failures;
    if (total > 0) {
      try {
        persistHealthWindow(provider, {
          window_start: new Date(entry.lastReset).toISOString(),
          window_end: new Date().toISOString(),
          successes: entry.successes,
          failures: entry.failures,
        });
      } catch (_e) { /* DB not initialized yet — skip persistence */ }
    }
    entry.successes = 0;
    entry.failures = 0;
    entry.lastReset = Date.now();
  }
  return entry;
}

function recordProviderOutcome(provider, success) {
  const entry = _getOrCreateHealth(provider);
  if (success) entry.successes++;
  else entry.failures++;
}

function getProviderHealth(provider) {
  const entry = _getOrCreateHealth(provider);
  const total = entry.successes + entry.failures;
  return {
    successes: entry.successes,
    failures: entry.failures,
    failureRate: total > 0 ? entry.failures / total : 0
  };
}

function isProviderHealthy(provider) {
  const entry = _getOrCreateHealth(provider);
  const total = entry.successes + entry.failures;
  if (total < 3) return true; // Not enough data
  return (entry.failures / total) < 0.30;
}

/**
 * Get a normalized health score (0-1) for a provider.
 * 1.0 = perfectly healthy, 0.0 = all failures.
 * Returns 0.5 (neutral) when insufficient data (< 3 samples).
 * @param {string} provider - Provider name
 * @returns {number} Score in [0, 1]
 */
function getProviderHealthScore(provider) {
  const entry = _getOrCreateHealth(provider);
  const total = entry.successes + entry.failures;
  if (total < 3) return 0.5;
  return Math.max(0, Math.min(1, 1 - (entry.failures / total)));
}

function resetProviderHealth() {
  _providerHealth.clear();
}


// ============================================================
// Provider Routing Config (merged from provider-routing-config.js)
// ============================================================

function createTemplateCondition(condition) {
  const stmt = db.prepare(`
    INSERT INTO template_conditions (
      id, template_id, condition_type, condition_expr, then_block, else_block, order_index, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    condition.id,
    condition.template_id,
    condition.condition_type,
    condition.condition_expr,
    condition.then_block || null,
    condition.else_block || null,
    condition.order_index || 0,
    new Date().toISOString()
  );

  return getTemplateCondition(condition.id);
}

/**
 * Get a template condition by ID
 * @param {any} id
 * @returns {any}
 */
function getTemplateCondition(id) {
  const stmt = db.prepare('SELECT * FROM template_conditions WHERE id = ?');
  return stmt.get(id);
}

/**
 * List conditions for a template
 * @param {any} templateId
 * @returns {any}
 */
function listTemplateConditions(templateId) {
  const stmt = db.prepare('SELECT * FROM template_conditions WHERE template_id = ? ORDER BY order_index ASC');
  return stmt.all(templateId);
}

/**
 * Delete a template condition
 */
function deleteTemplateCondition(id) {
  const stmt = db.prepare('DELETE FROM template_conditions WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============================================================
// Task Replay
// ============================================================

/**
 * Create a task replay
 */
function createTaskReplay(replay) {
  const stmt = db.prepare(`
    INSERT INTO task_replays (id, original_task_id, replay_task_id, modified_inputs, diff_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    replay.id,
    replay.original_task_id,
    replay.replay_task_id,
    replay.modified_inputs ? JSON.stringify(replay.modified_inputs) : null,
    replay.diff_summary || null,
    new Date().toISOString()
  );

  return getTaskReplay(replay.id);
}

/**
 * Get a task replay by ID
 * @param {any} id
 * @returns {any}
 */
function getTaskReplay(id) {
  const stmt = db.prepare('SELECT * FROM task_replays WHERE id = ?');
  const row = stmt.get(id);
  if (row && row.modified_inputs) {
    row.modified_inputs = safeJsonParse(row.modified_inputs, {});
  }
  return row;
}

/**
 * List replays for a task
 * @param {any} originalTaskId
 * @returns {any}
 */
function listTaskReplays(originalTaskId) {
  const stmt = db.prepare('SELECT * FROM task_replays WHERE original_task_id = ? ORDER BY created_at DESC');
  const rows = stmt.all(originalTaskId);
  return rows.map(row => {
    if (row.modified_inputs) {
      row.modified_inputs = safeJsonParse(row.modified_inputs, {});
    }
    return row;
  });
}

// ============================================================
// Rate Limits
// ============================================================

/**
 * Create or update a rate limit
 * @param {any} rateLimit
 * @returns {any}
 */
function setRateLimit(rateLimit) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO rate_limits (id, project_id, limit_type, max_value, window_seconds, current_value, window_start, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      max_value = excluded.max_value,
      window_seconds = excluded.window_seconds
  `);

  stmt.run(
    rateLimit.id,
    rateLimit.project_id || null,
    rateLimit.limit_type,
    rateLimit.max_value,
    rateLimit.window_seconds,
    0,
    now,
    now
  );

  return getRateLimit(rateLimit.id);
}

/**
 * Get a rate limit by ID
 * @param {any} id
 * @returns {any}
 */
function getRateLimit(id) {
  const stmt = db.prepare('SELECT * FROM rate_limits WHERE id = ?');
  return stmt.get(id);
}

/**
 * Get rate limits for a project
 * @param {any} projectId
 * @returns {any}
 */
function getProjectRateLimits(projectId) {
  const stmt = db.prepare('SELECT * FROM rate_limits WHERE project_id = ? OR project_id IS NULL');
  return stmt.all(projectId);
}

/**
 * Check and increment rate limit
 */
function checkRateLimit(projectId, limitType) {
  const now = new Date();
  const nowStr = now.toISOString();

  const txn = db.transaction(() => {
    // Get applicable rate limit
    const limit = db.prepare(`
      SELECT * FROM rate_limits
      WHERE (project_id = ? OR project_id IS NULL) AND limit_type = ?
      ORDER BY project_id DESC NULLS LAST
      LIMIT 1
    `).get(projectId, limitType);

    if (!limit) {
      return { allowed: true, reason: 'no_limit_configured' };
    }

    // Check if window has expired
    const windowStart = new Date(limit.window_start);
    const windowEnd = new Date(windowStart.getTime() + limit.window_seconds * 1000);

    if (now > windowEnd) {
      // Reset window
      db.prepare(`
        UPDATE rate_limits SET current_value = 1, window_start = ?
        WHERE id = ?
      `).run(nowStr, limit.id);
      return { allowed: true, remaining: limit.max_value - 1 };
    }

    // Check if within limit
    if (limit.current_value >= limit.max_value) {
      return {
        allowed: false,
        reason: 'rate_limit_exceeded',
        limit: limit.max_value,
        reset_at: windowEnd.toISOString()
      };
    }

    // Increment counter
    db.prepare(`
      UPDATE rate_limits SET current_value = current_value + 1
      WHERE id = ?
    `).run(limit.id);

    return { allowed: true, remaining: limit.max_value - limit.current_value - 1 };
  });

  return txn();
}

/**
 * Delete a rate limit
 */
function deleteRateLimit(id) {
  const stmt = db.prepare('DELETE FROM rate_limits WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============================================================
// Task Quotas
// ============================================================

/**
 * Create or update a task quota
 * @param {any} quota
 * @returns {any}
 */
function setTaskQuota(quota) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO task_quotas (id, project_id, quota_type, max_value, current_value, reset_period, last_reset, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      max_value = excluded.max_value,
      reset_period = excluded.reset_period
  `);

  stmt.run(
    quota.id,
    quota.project_id || null,
    quota.quota_type,
    quota.max_value,
    0,
    quota.reset_period || null,
    now,
    now
  );

  return getTaskQuota(quota.id);
}

/**
 * Get a task quota by ID
 * @param {any} id
 * @returns {any}
 */
function getTaskQuota(id) {
  const stmt = db.prepare('SELECT * FROM task_quotas WHERE id = ?');
  return stmt.get(id);
}

/**
 * Check and increment task quota
 */
function checkTaskQuota(projectId, quotaType, createTaskFn) {
  const now = new Date();
  const nowStr = now.toISOString();
  const shouldCreateTask = typeof createTaskFn === 'function';

  const txn = db.transaction((createTask) => {
    // Get applicable quota
    const quota = db.prepare(`
      SELECT * FROM task_quotas
      WHERE (project_id = ? OR project_id IS NULL) AND quota_type = ?
      ORDER BY project_id DESC NULLS LAST
      LIMIT 1
    `).get(projectId, quotaType);

    if (!quota) {
      const result = { allowed: true, reason: 'no_quota_configured' };
      if (shouldCreateTask) {
        result.task = createTask();
      }
      return result;
    }

    // Check if quota needs reset (based on reset_period)
    if (quota.reset_period) {
      const lastReset = new Date(quota.last_reset);
      let shouldReset = false;

      switch (quota.reset_period) {
        case 'daily':
          shouldReset = now.toDateString() !== lastReset.toDateString();
          break;
        case 'weekly': {
          const weekMs = 7 * 24 * 60 * 60 * 1000;
          shouldReset = now.getTime() - lastReset.getTime() >= weekMs;
          break;
        }
        case 'monthly':
          shouldReset = now.getMonth() !== lastReset.getMonth() ||
            now.getFullYear() !== lastReset.getFullYear();
          break;
      }

      if (shouldReset) {
        db.prepare(`
          UPDATE task_quotas SET current_value = 1, last_reset = ?
          WHERE id = ?
        `).run(nowStr, quota.id);
        const result = { allowed: true, remaining: quota.max_value - 1 };
        if (shouldCreateTask) {
          result.task = createTask();
        }
        return result;
      }
    }

    // Check if within quota
    if (quota.current_value >= quota.max_value) {
      return {
        allowed: false,
        reason: 'quota_exceeded',
        quota: quota.max_value,
        reset_period: quota.reset_period
      };
    }

    // Increment counter
    db.prepare(`
      UPDATE task_quotas SET current_value = current_value + 1
      WHERE id = ?
    `).run(quota.id);

    const remaining = quota.max_value - quota.current_value - 1;
    if (shouldCreateTask) {
      return { allowed: true, remaining, task: createTask() };
    }

    return { allowed: true, remaining };
  });

  return txn(createTaskFn);
}

/**
 * Get all task quotas for a project
 * @param {any} projectId
 * @returns {any}
 */
function getProjectQuotas(projectId) {
  const stmt = db.prepare('SELECT * FROM task_quotas WHERE project_id = ? OR project_id IS NULL');
  return stmt.all(projectId);
}

/**
 * Delete a task quota
 */
function deleteTaskQuota(id) {
  const stmt = db.prepare('DELETE FROM task_quotas WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============================================================
// Integration Config
// ============================================================

/**
 * Save integration configuration
 * @param {any} integration
 * @returns {any}
 */
function saveIntegrationConfig(integration) {
  const stmt = db.prepare(`
    INSERT INTO integration_config (id, integration_type, config, enabled, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      config = excluded.config,
      enabled = excluded.enabled
  `);

  stmt.run(
    integration.id,
    integration.integration_type,
    JSON.stringify(integration.config),
    integration.enabled !== false ? 1 : 0,
    new Date().toISOString()
  );

  return getIntegrationConfig(integration.id);
}

/**
 * Get integration configuration by ID
 * @param {any} id
 * @returns {any}
 */
function getIntegrationConfig(id) {
  const stmt = db.prepare('SELECT * FROM integration_config WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.config = safeJsonParse(row.config, {});
    row.enabled = Boolean(row.enabled);
  }
  return row;
}

/**
 * List all integration configurations
 * @param {any} type
 * @returns {any}
 */
function listIntegrationConfigs(type = null) {
  let stmt;
  if (type) {
    stmt = db.prepare('SELECT * FROM integration_config WHERE integration_type = ?');
    return stmt.all(type).map(row => {
      row.config = safeJsonParse(row.config, {});
      row.enabled = Boolean(row.enabled);
      return row;
    });
  }
  stmt = db.prepare('SELECT * FROM integration_config');
  return stmt.all().map(row => {
    row.config = safeJsonParse(row.config, {});
    row.enabled = Boolean(row.enabled);
    return row;
  });
}

/**
 * Get enabled integration by type
 * @param {any} integrationType
 * @returns {any}
 */
function getEnabledIntegration(integrationType) {
  const stmt = db.prepare('SELECT * FROM integration_config WHERE integration_type = ? AND enabled = 1 LIMIT 1');
  const row = stmt.get(integrationType);
  if (row) {
    row.config = safeJsonParse(row.config, {});
    row.enabled = Boolean(row.enabled);
  }
  return row;
}

/**
 * Delete integration configuration
 */
function deleteIntegrationConfig(id) {
  const stmt = db.prepare('DELETE FROM integration_config WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============================================================
// Workflow Forks
// ============================================================

/**
 * Create a workflow fork
 */
function createWorkflowFork(fork) {
  const stmt = db.prepare(`
    INSERT INTO workflow_forks (id, workflow_id, fork_point_task_id, branch_count, branches, merge_strategy, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    fork.id,
    fork.workflow_id,
    fork.fork_point_task_id || null,
    fork.branch_count || 2,
    JSON.stringify(fork.branches),
    fork.merge_strategy || 'all',
    'pending',
    new Date().toISOString()
  );

  return getWorkflowFork(fork.id);
}

/**
 * Get a workflow fork by ID
 * @param {any} id
 * @returns {any}
 */
function getWorkflowFork(id) {
  const stmt = db.prepare('SELECT * FROM workflow_forks WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.branches = safeJsonParse(row.branches, []);
  }
  return row;
}

/**
 * List forks for a workflow
 * @param {any} workflowId
 * @returns {any}
 */
function listWorkflowForks(workflowId) {
  const stmt = db.prepare('SELECT * FROM workflow_forks WHERE workflow_id = ? ORDER BY created_at ASC');
  const rows = stmt.all(workflowId);
  return rows.map(row => {
    row.branches = safeJsonParse(row.branches, []);
    return row;
  });
}

/**
 * Update workflow fork status
 * @param {any} id
 * @param {any} status
 * @returns {any}
 */
function updateWorkflowForkStatus(id, status) {
  const stmt = db.prepare('UPDATE workflow_forks SET status = ? WHERE id = ?');
  const result = stmt.run(status, id);
  return result.changes > 0 ? getWorkflowFork(id) : null;
}

// ============================================================
// Smart Routing Rules
// ============================================================

/**
 * Get all routing rules
 * @param {any} options
 * @returns {any}
 */
function getRoutingRules(options = {}) {
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

  const stmt = db.prepare(sql);
  return stmt.all(...params).map(r => ({
    ...r,
    enabled: Boolean(r.enabled)
  }));
}

/**
 * Get a specific routing rule by ID or name
 * @param {any} idOrName
 * @returns {any}
 */
function getRoutingRule(idOrName) {
  const stmt = db.prepare('SELECT * FROM routing_rules WHERE id = ? OR name = ?');
  const rule = stmt.get(idOrName, idOrName);
  if (rule) {
    rule.enabled = Boolean(rule.enabled);
  }
  return rule;
}

/**
 * Create a new routing rule
 */
function createRoutingRule({ name, description, rule_type, pattern, target_provider, priority, enabled }) {
  const stmt = db.prepare(`
    INSERT INTO routing_rules (name, description, rule_type, pattern, target_provider, priority, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    name,
    description || null,
    rule_type || 'keyword',
    pattern,
    target_provider,
    priority !== undefined ? priority : 50,
    enabled !== undefined ? (enabled ? 1 : 0) : 1,
    new Date().toISOString()
  );

  return getRoutingRule(result.lastInsertRowid);
}

/**
 * Update a routing rule
 * @param {any} idOrName
 * @param {any} updates
 * @returns {any}
 */
function updateRoutingRule(idOrName, updates) {
  const rule = getRoutingRule(idOrName);
  if (!rule) {
    throw new Error(`Routing rule not found: ${idOrName}`);
  }

  const allowed = ['name', 'description', 'rule_type', 'pattern', 'target_provider', 'priority', 'enabled'];
  const setClause = [];
  const values = [];

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      setClause.push(`${key} = ?`);
      if (key === 'enabled') {
        values.push(updates[key] ? 1 : 0);
      } else {
        values.push(updates[key]);
      }
    }
  }

  if (setClause.length === 0) return rule;

  setClause.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(rule.id);

  const stmt = db.prepare(`UPDATE routing_rules SET ${setClause.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getRoutingRule(rule.id);
}

/**
 * Delete a routing rule
 */
function deleteRoutingRule(idOrName) {
  const rule = getRoutingRule(idOrName);
  if (!rule) {
    throw new Error(`Routing rule not found: ${idOrName}`);
  }

  const stmt = db.prepare('DELETE FROM routing_rules WHERE id = ?');
  stmt.run(rule.id);

  return { deleted: true, rule };
}


// ============================================================
// Provider Health History (merged from provider-health-history.js)
// ============================================================

function ensureHealthTable() {
  if (!db) {
    throw new Error('Database not set');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_health_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT,
      total_checks INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      failure_rate REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_health_history_provider_window
      ON provider_health_history(provider, window_start);
    CREATE INDEX IF NOT EXISTS idx_provider_health_history_window_start
      ON provider_health_history(window_start);
  `);
}

function normalizeIsoDate(value, fieldName) {
  if (!value) {
    if (fieldName) {
      throw new Error(`${fieldName} is required`);
    }
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName || 'date'}: ${value}`);
  }

  return parsed.toISOString();
}

function normalizeWindowData(windowData = {}) {
  const windowStart = normalizeIsoDate(
    windowData.window_start ?? windowData.windowStart,
    'window_start'
  );
  const windowEndValue = windowData.window_end ?? windowData.windowEnd;
  const windowEnd = windowEndValue ? normalizeIsoDate(windowEndValue, 'window_end') : null;

  const successes = Number(
    windowData.successes ?? windowData.success_count ?? windowData.successCount ?? 0
  );
  const failures = Number(
    windowData.failures ?? windowData.failure_count ?? windowData.failureCount ?? 0
  );

  let totalChecks = Number(
    windowData.total_checks ?? windowData.totalChecks ?? windowData.sample_count ?? windowData.sampleCount
  );
  if (!Number.isFinite(totalChecks)) {
    totalChecks = successes + failures;
  }

  let failureRate = Number(windowData.failure_rate ?? windowData.failureRate);
  if (!Number.isFinite(failureRate)) {
    failureRate = totalChecks > 0 ? failures / totalChecks : 0;
  }

  return {
    windowStart,
    windowEnd,
    totalChecks: Math.max(0, totalChecks),
    successes: Math.max(0, successes),
    failures: Math.max(0, failures),
    failureRate,
  };
}

function mapRow(row) {
  if (!row) {
    return row;
  }

  return {
    provider: row.provider,
    window_start: row.window_start,
    window_end: row.window_end,
    total_checks: Number(row.total_checks) || 0,
    successes: Number(row.successes) || 0,
    failures: Number(row.failures) || 0,
    failure_rate: Number(row.failure_rate) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function persistHealthWindow(provider, windowData) {
  if (!provider || typeof provider !== 'string') {
    throw new Error('provider is required');
  }

  ensureHealthTable();
  const normalized = normalizeWindowData(windowData);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO provider_health_history (
      provider,
      window_start,
      window_end,
      total_checks,
      successes,
      failures,
      failure_rate,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, window_start) DO UPDATE SET
      window_end = excluded.window_end,
      total_checks = excluded.total_checks,
      successes = excluded.successes,
      failures = excluded.failures,
      failure_rate = excluded.failure_rate,
      updated_at = excluded.updated_at
  `).run(
    provider,
    normalized.windowStart,
    normalized.windowEnd,
    normalized.totalChecks,
    normalized.successes,
    normalized.failures,
    normalized.failureRate,
    now,
    now
  );

  return mapRow(
    db.prepare(`
      SELECT provider, window_start, window_end, total_checks, successes, failures, failure_rate, created_at, updated_at
      FROM provider_health_history
      WHERE provider = ? AND window_start = ?
    `).get(provider, normalized.windowStart)
  );
}

function getHealthHistory(provider, days = 30) {
  if (!provider || typeof provider !== 'string') {
    return [];
  }

  ensureHealthTable();
  const safeDays = Number.isFinite(Number(days)) ? Number(days) : 30;
  const cutoff = new Date(Date.now() - (safeDays * 24 * 60 * 60 * 1000)).toISOString();

  return db.prepare(`
    SELECT provider, window_start, window_end, total_checks, successes, failures, failure_rate, created_at, updated_at
    FROM provider_health_history
    WHERE provider = ? AND window_start >= ?
    ORDER BY window_start ASC
  `).all(provider, cutoff).map(mapRow);
}

function averageFailureRate(rows) {
  if (!rows.length) {
    return 0;
  }

  const total = rows.reduce((sum, row) => sum + (Number(row.failure_rate) || 0), 0);
  return total / rows.length;
}

function getHealthTrend(provider, days = 30) {
  const history = getHealthHistory(provider, days);
  if (history.length < 2) {
    return {
      provider,
      days,
      trend: 'insufficient_data',
      window_count: history.length,
      previous_failure_rate: null,
      recent_failure_rate: null,
    };
  }

  const splitIndex = Math.max(1, Math.floor(history.length / 2));
  const previousWindows = history.slice(0, splitIndex);
  const recentWindows = history.slice(splitIndex);

  const previousFailureRate = averageFailureRate(previousWindows);
  const recentFailureRate = averageFailureRate(recentWindows);
  const delta = recentFailureRate - previousFailureRate;

  let trend = 'stable';
  if (Math.abs(delta) >= 0.02) {
    trend = delta < 0 ? 'improving' : 'degrading';
  }

  return {
    provider,
    days,
    trend,
    window_count: history.length,
    previous_failure_rate: previousFailureRate,
    recent_failure_rate: recentFailureRate,
  };
}

function pruneHealthHistory(days = 30) {
  ensureHealthTable();
  const safeDays = Number.isFinite(Number(days)) ? Number(days) : 30;
  const cutoff = new Date(Date.now() - (safeDays * 24 * 60 * 60 * 1000)).toISOString();

  const result = db.prepare(`
    DELETE FROM provider_health_history
    WHERE window_start < ?
  `).run(cutoff);

  return result.changes;
}


module.exports = {
  // Canonical provider lists (single source of truth for fallback ordering)
  CLOUD_PROVIDERS,
  LOCAL_PROVIDERS,

  // Dependency injection
  setDb,
  setGetTask,
  setHostManagement,

  // Provider Core
  // Dependency injection
  getProvider,
  listProviders,
  getEnabledProviderMaxConcurrentSum,
  getEffectiveMaxConcurrent,
  updateProvider,
  analyzeTaskForRouting,
  // Provider Defaults
  getDefaultProvider,
  setDefaultProvider,
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
  // Ollama
  detectWSL2HostIP,
  findOllamaBinary,
  waitForOllamaReady,
  attemptOllamaStart,
  autoConfigureWSL2Host,
  checkOllamaHealth,
  isOllamaHealthy,
  invalidateOllamaHealth,
  setOllamaHealthy,
  hasHealthyOllamaHost,
  normalizeProviderTransport,
  enrichProviderRow,

  // Provider Stats (from provider-routing-stats.js)
  // Prometheus
  getPrometheusMetrics,
  // Stale Task Cleanup
  cleanupStaleTasks,
  pruneOldTasks,
  // Provider Management
  recordProviderUsage,
  getProviderStats,
  // Provider Health Scoring
  recordProviderOutcome,
  getProviderHealth,
  getProviderHealthScore,
  isProviderHealthy,
  resetProviderHealth,

  // Provider Routing Config (from provider-routing-config.js)
  // Template Conditions
  createTemplateCondition,
  getTemplateCondition,
  listTemplateConditions,
  deleteTemplateCondition,
  // Task Replay
  createTaskReplay,
  getTaskReplay,
  listTaskReplays,
  // Rate Limits
  setRateLimit,
  getRateLimit,
  getProjectRateLimits,
  checkRateLimit,
  deleteRateLimit,
  // Task Quotas
  setTaskQuota,
  getTaskQuota,
  checkTaskQuota,
  getProjectQuotas,
  deleteTaskQuota,
  // Integration Config
  saveIntegrationConfig,
  getIntegrationConfig,
  listIntegrationConfigs,
  getEnabledIntegration,
  deleteIntegrationConfig,
  // Workflow Forks
  createWorkflowFork,
  getWorkflowFork,
  listWorkflowForks,
  updateWorkflowForkStatus,
  // Smart Routing Rules
  getRoutingRules,
  getRoutingRule,
  createRoutingRule,
  updateRoutingRule,
  deleteRoutingRule,

  // Provider Health History (from provider-health-history.js)
  persistHealthWindow,
  getHealthHistory,
  getHealthTrend,
  pruneHealthHistory,
};
