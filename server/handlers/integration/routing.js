/**
 * Integration task routing and smart submission handlers.
 */

const path = require('path');
const fs = require('fs');
const fsPromises = require('node:fs/promises');
const configCore = require('../../db/config-core');
const hostManagement = require('../../db/host-management');
const providerRoutingCore = require('../../db/provider-routing-core');
const taskCore = require('../../db/task-core');
const workflowEngine = require('../../db/workflow-engine');
const taskManager = require('../../task-manager');
const { PROVIDER_DEFAULTS, DEFAULT_FALLBACK_MODEL } = require('../../constants');
const { ErrorCodes, makeError } = require('../error-codes');
const { MAX_TASK_LENGTH, isPathTraversalSafe, checkProviderAvailability } = require('../shared');
const { CONTEXT_STUFFING_PROVIDERS } = require('../../utils/context-stuffing');
const { resolveContextFiles } = require('../../utils/smart-scan');
const { resolveOllamaModel } = require('../../providers/ollama-shared');
const { shouldDecompose, decomposeTask: buildDecomposedTasks, GUIDED_FILE_THRESHOLD, GUIDED_MIN_FUNCTIONS } = require('../../execution/task-decomposition');
const { enforceVersionIntentForProject } = require('../../versioning/version-intent');
const modelRoles = require('../../db/model-roles');
const modelCaps = require('../../db/model-capabilities');
const logger = require('../../logger').child({ component: 'integration-routing' });
const serverConfig = require('../../config');
serverConfig.init({ db: configCore });

/**
 * Format a routing rule (or result object) as a Markdown table.
 * @param {string} title - Table heading
 * @param {Object} fields - Key-value pairs to display
 * @returns {string} Formatted Markdown
 */
function formatRuleTable(title, fields) {
  let output = `## ${title}\n\n`;
  output += '| Field | Value |\n';
  output += '|-------|-------|\n';
  for (const [key, value] of Object.entries(fields)) {
    output += `| ${key} | ${value ?? 'N/A'} |\n`;
  }
  return output;
}

function normalizeSubscriptionTaskIds(taskIds) {
  if (!Array.isArray(taskIds)) {
    return [];
  }

  const normalizedTaskIds = [];
  const seen = new Set();
  for (const rawTaskId of taskIds) {
    const taskId = rawTaskId == null ? '' : String(rawTaskId).trim();
    if (!taskId || seen.has(taskId)) {
      continue;
    }
    seen.add(taskId);
    normalizedTaskIds.push(taskId);
  }

  return normalizedTaskIds;
}

function buildSubscriptionTarget({ workflowId = null, taskIds = [] } = {}) {
  const normalizedTaskIds = normalizeSubscriptionTaskIds(taskIds);
  const normalizedWorkflowId = workflowId == null ? null : String(workflowId).trim() || null;

  return {
    kind: normalizedWorkflowId ? 'workflow' : 'task',
    workflow_id: normalizedWorkflowId,
    task_id: normalizedWorkflowId ? null : (normalizedTaskIds[0] || null),
    task_ids: normalizedTaskIds,
    subscribe_tool: 'subscribe_task_events',
    subscribe_args: {
      task_ids: normalizedTaskIds,
    },
  };
}

function formatSubscriptionInstructions(subscriptionTarget) {
  if (!subscriptionTarget || !Array.isArray(subscriptionTarget.task_ids) || subscriptionTarget.task_ids.length === 0) {
    return '';
  }

  const taskLabel = subscriptionTarget.kind === 'workflow'
    ? `${subscriptionTarget.task_ids.length} workflow task${subscriptionTarget.task_ids.length === 1 ? '' : 's'}`
    : 'this task';

  return '\n### Subscribe\n'
    + `Use \`${subscriptionTarget.subscribe_tool}\` or an equivalent task-event stream with these task IDs to follow ${taskLabel}:\n\n`
    + '```json\n'
    + `${JSON.stringify(subscriptionTarget.subscribe_args)}\n`
    + '```\n';
}

function buildSplitSuggestions(files, maxSuggestions = 3) {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  const suggestions = [];
  for (const rawFile of files) {
    const file = rawFile == null ? '' : String(rawFile).trim();
    if (!file) {
      continue;
    }

    if (/types?\.|interface/i.test(file)) {
      suggestions.push(`Update type definitions in ${file}`);
    } else if (/test|spec/i.test(file)) {
      suggestions.push(`Write tests in ${file}`);
    } else {
      suggestions.push(`Implement changes in ${file}`);
    }

    if (suggestions.length >= maxSuggestions) {
      break;
    }
  }

  return suggestions;
}

function rejectBlockedSubmission(policyResult) {
  if (!policyResult || policyResult.blocked !== true) {
    return null;
  }
  const message = policyResult.reason || policyResult.error || 'Task blocked by policy';
  return makeError(ErrorCodes.OPERATION_FAILED, message);
}

function resolveSmartSubmitTuning(rawTuning) {
  if (rawTuning === undefined || rawTuning === null) {
    return {};
  }

  if (typeof rawTuning !== 'object' || Array.isArray(rawTuning)) {
    throw Object.assign(new Error('tuning must be an object'), { code: ErrorCodes.INTERNAL_ERROR });
  }

  const toNumber = (value, name) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw Object.assign(new Error(`${name} must be a finite number`), { code: ErrorCodes.INTERNAL_ERROR });
    }
    return numeric;
  };

  const addValidated = (target, key, value, validate) => {
    const parsed = validate(value, key);
    target[key] = parsed;
  };

  const tuning = {};

  if (rawTuning.preset !== undefined) {
    if (typeof rawTuning.preset !== 'string' || !rawTuning.preset.trim()) {
      throw Object.assign(new Error('tuning.preset must be a non-empty string'), { code: ErrorCodes.INTERNAL_ERROR });
    }

    const presetsJson = serverConfig.get('ollama_presets');
    if (!presetsJson) {
      throw Object.assign(new Error('No tuning presets configured'), { code: ErrorCodes.INTERNAL_ERROR });
    }

    let presets;
    try {
      presets = JSON.parse(presetsJson);
    } catch {
      throw Object.assign(new Error('Failed to parse tuning presets'), { code: ErrorCodes.INTERNAL_ERROR });
    }

    const presetConfig = presets[rawTuning.preset];
    if (!presetConfig) {
      throw Object.assign(
        new Error(`Unknown tuning preset: ${rawTuning.preset}. Available: ${Object.keys(presets).join(', ')}`),
        { code: ErrorCodes.INTERNAL_ERROR }
      );
    }

    if (presetConfig.temperature !== undefined) tuning.temperature = presetConfig.temperature;
    if (presetConfig.top_p !== undefined) tuning.top_p = presetConfig.top_p;
    if (presetConfig.top_k !== undefined) tuning.top_k = presetConfig.top_k;
    if (presetConfig.repeat_penalty !== undefined) tuning.repeat_penalty = presetConfig.repeat_penalty;
    if (presetConfig.num_ctx !== undefined) tuning.num_ctx = presetConfig.num_ctx;
    if (presetConfig.num_predict !== undefined) tuning.num_predict = presetConfig.num_predict;
    if (presetConfig.mirostat !== undefined) tuning.mirostat = presetConfig.mirostat;
  }

  if (rawTuning.temperature !== undefined) {
    addValidated(tuning, 'temperature', rawTuning.temperature, (value, name) => {
      const numeric = toNumber(value, name);
      if (numeric < 0.1 || numeric > 1.0) {
        throw Object.assign(new Error('tuning.temperature must be between 0.1 and 1.0'), { code: ErrorCodes.INTERNAL_ERROR });
      }
      return numeric;
    });
  }

  if (rawTuning.num_ctx !== undefined) {
    addValidated(tuning, 'num_ctx', rawTuning.num_ctx, (value, name) => {
      const numeric = toNumber(value, name);
      if (!Number.isInteger(numeric) || numeric < 1024 || numeric > 32768) {
        throw Object.assign(new Error('tuning.num_ctx must be an integer between 1024 and 32768'), { code: ErrorCodes.INTERNAL_ERROR });
      }
      return numeric;
    });
  }

  if (rawTuning.top_p !== undefined) {
    addValidated(tuning, 'top_p', rawTuning.top_p, (value, name) => {
      const numeric = toNumber(value, name);
      if (numeric < 0.1 || numeric > 1.0) {
        throw Object.assign(new Error('tuning.top_p must be between 0.1 and 1.0'), { code: ErrorCodes.INTERNAL_ERROR });
      }
      return numeric;
    });
  }

  if (rawTuning.top_k !== undefined) {
    addValidated(tuning, 'top_k', rawTuning.top_k, (value, name) => {
      const numeric = toNumber(value, name);
      if (!Number.isInteger(numeric) || numeric < 1 || numeric > 100) {
        throw Object.assign(new Error('tuning.top_k must be an integer between 1 and 100'), { code: ErrorCodes.INTERNAL_ERROR });
      }
      return numeric;
    });
  }

  if (rawTuning.repeat_penalty !== undefined) {
    addValidated(tuning, 'repeat_penalty', rawTuning.repeat_penalty, (value, name) => {
      const numeric = toNumber(value, name);
      if (numeric < 1.0 || numeric > 2.0) {
        throw Object.assign(new Error('tuning.repeat_penalty must be between 1.0 and 2.0'), { code: ErrorCodes.INTERNAL_ERROR });
      }
      return numeric;
    });
  }

  if (rawTuning.num_predict !== undefined) {
    addValidated(tuning, 'num_predict', rawTuning.num_predict, (value, name) => {
      const numeric = toNumber(value, name);
      if (numeric !== -1 && (!Number.isInteger(numeric) || numeric < 1 || numeric > 16384)) {
        throw Object.assign(new Error('tuning.num_predict must be -1 (unlimited) or between 1 and 16384'), { code: ErrorCodes.INTERNAL_ERROR });
      }
      return numeric;
    });
  }

  if (rawTuning.mirostat !== undefined) {
    addValidated(tuning, 'mirostat', rawTuning.mirostat, (value, name) => {
      const numeric = toNumber(value, name);
      if (!Number.isInteger(numeric) || ![0, 1, 2].includes(numeric)) {
        throw Object.assign(new Error('tuning.mirostat must be 0, 1, or 2'), { code: ErrorCodes.INTERNAL_ERROR });
      }
      return numeric;
    });
  }

  return tuning;
}

function extractSmartSubmitInputs(args) {
  if (!args || typeof args !== 'object') {
    return { error: makeError(ErrorCodes.INVALID_PARAM, 'Arguments object is required') };
  }

  const {
    task,
    working_directory,
    project,
    tags,
    files: rawFiles,
    model,
    timeout_minutes,
    priority,
    provider,
    override_provider: legacyOverrideProvider,
    tuning,
    context_stuff,
    context_depth,
    prefer_free,
    routing_template,
    version_intent,
    __sessionId,
  } = args;

  // Support both 'provider' (standard) and legacy 'override_provider' alias
  const override_provider = provider || legacyOverrideProvider;
  const files = Array.isArray(rawFiles) ? rawFiles : (rawFiles ? [String(rawFiles)] : undefined);
  if (files) {
    for (const file of files) {
      if (!isPathTraversalSafe(file)) {
        return { error: makeError(ErrorCodes.INVALID_PARAM, 'file path contains path traversal') };
      }
    }
  }

  let tuningOverrides;
  try {
    tuningOverrides = resolveSmartSubmitTuning(tuning);
  } catch (err) {
    return { error: makeError(ErrorCodes.INVALID_PARAM, err.message) };
  }

  if (!task || typeof task !== 'string' || task.trim().length === 0) {
    return { error: makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task must be a non-empty string') };
  }
  if (task.length > MAX_TASK_LENGTH) {
    return {
      error: makeError(
        ErrorCodes.INVALID_PARAM,
        `Task description exceeds maximum length (${task.length} > ${MAX_TASK_LENGTH} characters)`
      ),
    };
  }
  if (working_directory) {
    try {
      let rawDb;
      try {
        const { defaultContainer } = require('../../container');
        rawDb = defaultContainer.get('db');
      } catch {
        rawDb = require('../../database').getDbInstance();
      }
      const versionIntentError = enforceVersionIntentForProject(
        rawDb,
        working_directory,
        version_intent,
        makeError,
        ErrorCodes
      );
      if (versionIntentError) {
        return { error: versionIntentError };
      }
    } catch (_e) { /* version-intent module unavailable — allow */ }
  }

  const estimatedTokens = Math.max(1, Math.ceil(task.length / 4));

  return {
    task,
    working_directory,
    project,
    tags,
    files,
    model,
    timeout_minutes,
    priority,
    override_provider,
    tuning: tuningOverrides,
    estimatedTokens,
    context_stuff,
    context_depth,
    prefer_free,
    routing_template,
    version_intent,
    __sessionId,
  };
}

async function resolveModificationRouting(task, files, routingResult, opts) {
  const {
    selectedProvider: initialSelectedProvider,
    override_provider,
    model,
    complexity,
    working_directory,
    codexExhausted,
  } = opts;

  let selectedProvider = initialSelectedProvider;
  let taskModel = model || null;
  let modRoutingReason = null;
  const estimatedTokens = routingResult?.estimatedTokens || Math.max(1, Math.ceil(task.length / 4));

  // Modification + greenfield routing for the local Ollama provider.
  // Ollama cannot create new files safely, so the greenfield guard applies.
  const _isLocalOllamaProvider = selectedProvider === 'ollama';
  if (!taskModel && _isLocalOllamaProvider) {
    // Detect modification tasks for capability-driven routing decisions.
    // Models with low max_safe_edit_lines cannot safely modify existing files — route to Codex.
    const taskLower = task.toLowerCase();
    // Expanded modification detection to catch implicit patterns (implement, complete, extend, enhance, fill).
    const modificationVerbs = /\b(fill .+ in |add .+ to (?:the |existing )?|modify |update |fix |refactor |change |rename |move |extract |remove .+ from |extend |enhance |complete .+ in |implement .+ in |replace .+ in |insert .+ in |append .+ to |delete .+ from |patch |rewrite )\b/;

    // P102: Extract filenames from task description BEFORE modification detection,
    // so that "Modify string_utils.py ..." counts as having file context.
    const fileNamePattern = /\b([\w.-]+\.(?:py|ts|js|cs|java|go|rs|rb|cpp|c|h|xaml|jsx|tsx|vue|svelte))\b/gi;
    const taskFileNames = task.match(fileNamePattern) || [];
    const hasExistingFileContext = files?.length > 0 || taskFileNames.length > 0 || /\b(?:existing|current|in .+\.\w{1,5}\b)/i.test(taskLower);
    const isModificationTask = modificationVerbs.test(taskLower) && hasExistingFileContext;

    // Model capability check: route large files to codex if model's max_safe_edit_lines is exceeded.
    // Look up the current default model's capabilities to determine safe edit thresholds.
    const codexEnabled = serverConfig.isOptIn('codex_enabled');
    const currentModel = modelRoles.getModelForRole('ollama', 'default') || DEFAULT_FALLBACK_MODEL;
    const caps = modelCaps.getModelCapabilities(currentModel);
    const modSafeLineLimit = caps?.max_safe_edit_lines || PROVIDER_DEFAULTS.MOD_SAFE_LINE_LIMIT;

    // Check file sizes — from explicit files array OR extracted from task description
    let maxFileLines = 0;
    let fileSizeKnown = false;
    const path = require('path');
    const workDir = working_directory || process.cwd();

    // Build list of files to check: explicit files + filenames from task description
    let filesToCheck = files ? [...files] : [];
    if (filesToCheck.length === 0 && taskFileNames.length > 0) {
      filesToCheck = [...new Set(taskFileNames)];
    }

    // Use file resolution to find actual paths for bare filenames
    if (!fileSizeKnown && filesToCheck.length > 0) {
      try {
        const resolution = taskManager.resolveFileReferences(task, workDir);
        if (resolution.resolved.length > 0) {
          filesToCheck = resolution.resolved.map(r => r.actual);
          logger.info(`[SmartRouting] Resolved ${resolution.resolved.length} file path(s) for size check`);
        }
      } catch (err) {
        // Non-fatal — fall through to original behavior
        logger.debug('[integration-routing] non-critical error resolving route size candidates:', err.message || err);
      }
    }

    for (const f of filesToCheck) {
      const absPath = path.isAbsolute(f) ? f : path.join(workDir, f);
      if (!isPathTraversalSafe(absPath, workDir)) {
        return { error: makeError(ErrorCodes.INVALID_PARAM, 'file path contains path traversal') };
      }

      try {
        const content = await fsPromises.readFile(absPath, 'utf-8');
        const lineCount = content.split('\n').length;
        if (lineCount > maxFileLines) maxFileLines = lineCount;
        fileSizeKnown = true;
      } catch (err) {
        logger.debug('[integration-routing] non-critical error counting route file lines:', err.message || err);
      }
    }

    const canUseLocalForMod = fileSizeKnown && maxFileLines < modSafeLineLimit;
    if (isModificationTask && canUseLocalForMod && !override_provider) {
      // Model capability check: local model handles modifications safely within max_safe_edit_lines
      taskModel = modelRoles.getModelForRole('ollama', 'default') || DEFAULT_FALLBACK_MODEL;
      modRoutingReason = `Modification task (${maxFileLines} lines < ${modSafeLineLimit} limit) → local model (safe)`;
      logger.info(`[SmartRouting] R104: ${modRoutingReason}`);
    } else if (isModificationTask && codexEnabled && !override_provider && !codexExhausted) {
      // Large files or unknown size → Codex (surgical patches, any file size)
      const sparkEnabled = serverConfig.isOptIn('codex_spark_enabled');
      selectedProvider = 'codex';
      if (sparkEnabled && (complexity === 'simple' || complexity === 'normal')) {
        taskModel = 'gpt-5.3-codex-spark';
        modRoutingReason = `Modification task (${fileSizeKnown ? maxFileLines + ' lines' : 'unknown size'}) → Codex Spark (fast, ${complexity})`;
        logger.info(`[SmartRouting] Spark: ${modRoutingReason}`);
      } else {
        taskModel = null;
        modRoutingReason = `Modification task (${fileSizeKnown ? maxFileLines + ' lines' : 'unknown size'}) → Codex (safe for any size)`;
        logger.info(`[SmartRouting] P83: ${modRoutingReason}`);
      }
    } else if (isModificationTask && !codexEnabled && !override_provider) {
      // Route modifications to claude-cli when Codex unavailable.
      // Local LLMs with low max_safe_edit_lines destroy existing files during modification.
      // claude-cli can handle modifications safely via diff-based patches.
      const claudeCliEnabled = serverConfig.getBool('claude_cli_enabled');
      if (claudeCliEnabled) {
        selectedProvider = 'claude-cli';
        taskModel = null; // claude-cli uses its own model
        logger.info('[SmartRouting] P86: Modification task (Codex disabled) → claude-cli (safe fallback)');
      } else {
        // Both Codex and claude-cli disabled. Use fallback model as least-bad option.
        // Model capability check: fallback model may have low max_safe_edit_lines,
        // so P95 safeguard detects stub destruction patterns and triggers auto-retry/rejection.
        const fallbackModel = modelRoles.getModelForRole('ollama', 'fallback') || DEFAULT_FALLBACK_MODEL;
        taskModel = fallbackModel;
        const fallbackCaps = modelCaps.getModelCapabilities(fallbackModel);
        const fallbackMaxLines = fallbackCaps?.max_safe_edit_lines || 50;
        logger.warn(`[SmartRouting] Modification task (Codex+claude-cli disabled) → ${fallbackModel} (max_safe_edit_lines=${fallbackMaxLines}, RISK on large files)`);
      }
    } else if (!isModificationTask && codexEnabled && !override_provider && !codexExhausted) {
      // --- Greenfield routing ---
      // EXP1: Ollama CANNOT create new files — all greenfield tasks must go to Codex.
      // Experiment 1 showed 3/3 Ollama greenfield tasks silently fell back to Codex
      // or stalled. Route directly to avoid the fallback latency penalty (~2x slower).
      const sparkEnabled = serverConfig.isOptIn('codex_spark_enabled');
      if (sparkEnabled && complexity !== 'complex') {
        selectedProvider = 'codex';
        taskModel = 'gpt-5.3-codex-spark';
        modRoutingReason = `${complexity} greenfield → Codex Spark (Ollama cannot create files)`;
      } else {
        selectedProvider = 'codex';
        taskModel = null;
        modRoutingReason = `${complexity} greenfield → Codex (Ollama cannot create files)`;
      }
      logger.info(`[SmartRouting] EXP1: ${modRoutingReason}`);
    } else {
      // Smart model selection: score models by task type, language, and complexity
      const taskType = hostManagement.classifyTaskType(task);
      const taskLanguage = hostManagement.detectTaskLanguage(task, files || []);

      // Gather available models from healthy hosts
      const hosts = hostManagement.listOllamaHosts().filter(h => h.enabled && h.status !== 'down');
      const availableModels = [...new Set(
        hosts.flatMap(h => {
          try { return JSON.parse(h.models || '[]'); } catch { return []; }
        })
      )];

      if (availableModels.length > 0) {
        const ranked = hostManagement.selectBestModel(taskType, taskLanguage, complexity, availableModels, { estimatedTokens });
        if (ranked.length > 0) {
          taskModel = ranked[0].model;
          logger.info(`[SmartRouting] Smart selection: ${taskType}/${taskLanguage}/${complexity} → ${taskModel} (score=${ranked[0].score}, ${ranked[0].reason})`);
        } else {
          // All models filtered (e.g., context window too small) — fall back to tier
          const modelTier = hostManagement.getModelTierForComplexity(complexity);
          taskModel = modelTier.modelConfig;
          logger.info(`[SmartRouting] Smart selection filtered all models, falling back to tier: ${modelTier.tier} → ${taskModel}`);
        }
      } else {
        // No hosts available — fall back to tier-based selection
        const modelTier = hostManagement.getModelTierForComplexity(complexity);
        taskModel = modelTier.modelConfig;
        logger.info(`[SmartRouting] No healthy hosts with models, falling back to tier: ${modelTier.tier} → ${taskModel}`);
      }
    }
  }

  return { selectedProvider, taskModel, modRoutingReason };
}





// ============================================
// Smart Routing Handlers
// ============================================

/**
 * Submit a task with automatic provider selection
 */
async function handleSmartSubmitTask(args) {
  try {
  const inputs = extractSmartSubmitInputs(args);
  if (inputs.error) return inputs.error;

  const {
    task,
    working_directory,
    project,
    tags,
    files,
    model,
    timeout_minutes,
    priority,
    override_provider,
    tuning: tuningOverrides,
    estimatedTokens,
    context_stuff,
    context_depth,
    prefer_free,
    routing_template,
    version_intent,
    __sessionId,
  } = inputs;

  let selectedProvider;
  let routingResult;

  // D2.2: Single source — getProviderHealthScore() now lives in provider-routing-core.js
  const getProviderHealthScore = (providerName) => {
    try {
      return providerRoutingCore.getProviderHealthScore(providerName);
    } catch (e) {
      logger.debug('[smart-routing] getProviderHealthScore error:', e.message);
      return 0.5;
    }
  };

  // Single source of truth: provider-routing-core.js owns the fallback chain.
  // No inline fallback list — getProviderFallbackChain() always returns a default.
  const getFallbackProviderChain = (providerName) => {
    if (typeof providerRoutingCore.getProviderFallbackChain === 'function') {
      try {
        return providerRoutingCore.getProviderFallbackChain(providerName);
      } catch (e) { logger.debug('[smart-routing] getProviderFallbackChain error:', e.message); }
    }
    // Defensive: should never reach here since db is always initialized,
    // but return empty to avoid undefined errors.
    return [];
  };

  const resolveFirstEnabledProvider = () => {
    if (typeof providerRoutingCore.listProviders !== 'function') {
      return null;
    }
    try {
      const enabledProvider = providerRoutingCore
        .listProviders()
        .find((candidate) => candidate && candidate.enabled);
      return enabledProvider ? (enabledProvider.provider || enabledProvider.name || null) : null;
    } catch (e) {
      logger.debug('[smart-routing] listProviders error:', e.message);
      return null;
    }
  };

  const resolveSafeSelectedProvider = (providerName) => {
    const normalizedProvider = typeof providerName === 'string' ? providerName.trim() : '';
    try {
      const providerConfig = normalizedProvider ? providerRoutingCore.getProvider(normalizedProvider) : null;
      if (normalizedProvider && providerConfig && providerConfig.enabled) {
        return normalizedProvider;
      }
    } catch (e) {
      logger.debug('[smart-routing] getProvider error:', e.message);
    }

    // Safety net: if routing resolved to a disabled/missing provider or null,
    // fall back to the first enabled provider to prevent tasks sitting in queue forever.
    const fallbackProvider = resolveFirstEnabledProvider();
    if (fallbackProvider) {
      logger.warn(`[SmartRouting] Invalid provider resolved (${normalizedProvider || 'null'}) — falling back to ${fallbackProvider}`);
      return fallbackProvider;
    }
    return normalizedProvider;
  };

  if (override_provider) {
    // User explicitly requested a provider
    selectedProvider = override_provider;
    routingResult = { provider: override_provider, rule: null, reason: 'User override' };
  } else {
    // Run fresh health check before routing (force=true to avoid stale cache)
    await providerRoutingCore.checkOllamaHealth(true);

    // Use smart routing (will use freshly updated health status for fallback decisions)
    routingResult = providerRoutingCore.analyzeTaskForRouting(task, working_directory, files, {
      preferFree: !!prefer_free,
      taskMetadata: routing_template ? { _routing_template: routing_template } : undefined,
    });
    selectedProvider = routingResult.provider;

    // Log routing decision for debugging
    if (routingResult.fallbackApplied) {
      logger.info(`[SmartRouting] Ollama unhealthy, falling back: ${routingResult.originalProvider} → ${selectedProvider}`);
    }
  }

  // Both-providers-down gate: reject if Codex exhausted AND no local LLM available (RB-031)
  const availCheck = checkProviderAvailability({ hasExplicitProvider: !!override_provider });
  if (availCheck) return availCheck.error;

  // Validate provider
  let providerConfig = providerRoutingCore.getProvider(selectedProvider);
  if (!providerConfig || !providerConfig.enabled) {
    // TDA-01: If user explicitly chose this provider, return an error instead of
    // silently falling back. Explicit provider intent is sovereign.
    if (override_provider) {
      if (!providerConfig) {
        return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Selected provider not found: ${selectedProvider}`);
      }
      return makeError(ErrorCodes.PROVIDER_ERROR, `Provider ${selectedProvider} is disabled. Enable it or choose a different provider.`);
    }
    const fallbackProvider = resolveSafeSelectedProvider(providerRoutingCore.getDefaultProvider());
    if (fallbackProvider && fallbackProvider !== selectedProvider) {
      const fallbackReason = providerConfig ? 'original provider disabled' : 'original provider missing';
      selectedProvider = fallbackProvider;
      providerConfig = providerRoutingCore.getProvider(selectedProvider);
      routingResult.reason += ` (${fallbackReason}, falling back to ${selectedProvider})`;
    }
  }
  if (!providerConfig) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Selected provider not found: ${selectedProvider}`);
  }
  if (!providerConfig.enabled) {
    return makeError(ErrorCodes.PROVIDER_ERROR, `Provider ${selectedProvider} is disabled. Enable it or choose a different provider.`);
  }

  // Determine task complexity for routing and review requirements
  const complexity = routingResult.complexity || hostManagement.determineTaskComplexity(task, files);
  const splitAdvisory = typeof hostManagement.getSplitAdvisory === 'function'
    ? hostManagement.getSplitAdvisory(complexity, files)
    : (complexity === 'complex' && files && files.length >= 3);
  const splitSuggestions = splitAdvisory ? buildSplitSuggestions(files) : [];
  const needsReview = complexity === 'complex';
  const workingDirectory = working_directory || process.cwd();
  const defaultTimeout = serverConfig.getInt('default_timeout', 30);

  // Fix F3: Use per-provider timeout defaults when no explicit timeout given
  const providerTimeout = (taskManager.PROVIDER_DEFAULT_TIMEOUTS || {})[selectedProvider] || defaultTimeout;
  const effectiveTimeout = timeout_minutes || providerTimeout;
  const submissionTaskId = require('uuid').v4();
  const autoApproveSimple = serverConfig.isOptIn('auto_approve_simple');
  const requireReviewForComplex = serverConfig.getBool('require_review_for_complex');
  let reviewStatus = null;
  if (complexity === 'complex' && requireReviewForComplex) {
    reviewStatus = 'pending';
  } else if (complexity === 'simple' && !autoApproveSimple) {
    reviewStatus = 'pending';
  } else if (complexity === 'normal') {
    reviewStatus = 'pending';
  }
  const policyResult = typeof taskManager.evaluateTaskSubmissionPolicy === 'function'
    ? taskManager.evaluateTaskSubmissionPolicy({
        id: submissionTaskId,
        task_description: task,
        working_directory: workingDirectory,
        timeout_minutes: effectiveTimeout,
        priority: priority || 0,
        provider: selectedProvider,
        model: model || null,
        complexity,
        review_status: reviewStatus,
        metadata: {
          smart_routing: true,
          user_provider_override: !!override_provider,
          requested_provider: override_provider || null,
          requested_model: model || null,
        },
      })
    : null;
  const blockedError = rejectBlockedSubmission(policyResult);
  if (blockedError) {
    return blockedError;
  }

  // AUTO-DECOMPOSE: Use task-decomposition module to decide whether to split
  // shouldDecompose checks provider class (agentic/guided/prompt-only), complexity,
  // and task patterns — replaces the old inline C# and JS/TS decomposition blocks.
  const decomposeDecision = shouldDecompose(
    { task_description: task, complexity, files },
    routingResult
  );

  if (decomposeDecision.decompose && decomposeDecision.type === 'csharp') {
    // C# decomposition: use hostManagement templates to generate subtask descriptions
    const subtasks = hostManagement.decomposeTask(task, workingDirectory);

    if (subtasks && subtasks.length > 1) {
      // Ensure working directory exists before creating workflow
      // Safety: only create if parent directory exists (prevents arbitrary path creation)
      if (!fs.existsSync(workingDirectory)) {
        const parentDir = path.dirname(workingDirectory);
        if (fs.existsSync(parentDir)) {
          try {
            fs.mkdirSync(workingDirectory, { recursive: false });
            logger.info(`Created working directory for decomposed task: ${workingDirectory}`);
          } catch (mkdirErr) {
            logger.warn(`Failed to create working directory ${workingDirectory}: ${mkdirErr.message}`);
          }
        } else {
          logger.warn(`Working directory parent does not exist: ${parentDir} - decomposed tasks may fail`);
        }
      }

      // Build sub-task definitions with provider locked to routing result
      const { tasks: taskDefs } = buildDecomposedTasks(
        { task, working_directory: workingDirectory, files },
        routingResult,
        { subtasks, version_intent, parent_task_id: submissionTaskId }
      );

      // Create a workflow
      const workflowId = require('uuid').v4();
      const workflowName = `Auto: ${task.substring(0, 60)}${task.length > 60 ? '...' : ''}`;

      workflowEngine.createWorkflow({
        id: workflowId,
        name: workflowName,
        description: `Auto-decomposed from: ${task}`,
        status: 'pending'
      });

      // Determine model for subtasks - use balanced tier since subtasks are simpler
      const subtaskTier = hostManagement.getModelTierForComplexity('normal');
      const subtaskModel = model || subtaskTier.modelConfig;

      let prevTaskId = null;
      const createdTasks = [];

      for (let i = 0; i < taskDefs.length; i++) {
        const def = taskDefs[i];
        const nodeId = `step-${i + 1}`;
        const subtaskId = require('uuid').v4();

        taskCore.createTask({
          id: subtaskId,
          task_description: subtasks[i],
          working_directory: workingDirectory,
          project: project || undefined,
          tags: tags || undefined,
          status: prevTaskId ? 'waiting' : 'queued',
          provider: def.provider,  // locked to routed provider
          model: subtaskModel,
          timeout_minutes: effectiveTimeout,
          priority: priority || 0,
          complexity: 'normal',
          workflow_id: workflowId,
          workflow_node_id: nodeId,
          ollama_host_id: routingResult.selectedHost || routingResult.hostId || null,
          metadata: JSON.stringify({
            smart_routing: true,
            intended_provider: def.provider,
            decomposed_from: task,
            subtask_index: i + 1,
            total_subtasks: subtasks.length,
            tuning_overrides: Object.keys(tuningOverrides).length > 0 ? tuningOverrides : null,
            mcp_session_id: __sessionId || undefined,
          })
        });

        if (prevTaskId) {
          workflowEngine.addTaskDependency({
            workflow_id: workflowId,
            task_id: subtaskId,
            depends_on_task_id: prevTaskId,
            on_fail: 'skip'
          });
        }

        createdTasks.push({ taskId: subtaskId, step: i + 1, description: subtasks[i], nodeId });
        prevTaskId = subtaskId;
      }

      workflowEngine.updateWorkflow(workflowId, {
        status: 'running',
        total_tasks: subtasks.length,
        started_at: new Date().toISOString()
      });

      taskManager.processQueue();

      let output = `## Task Auto-Decomposed into Workflow\n\n`;
      output += `Complex task was automatically split into ${subtasks.length} simpler subtasks for local LLM processing.\n\n`;
      output += `| Field | Value |\n`;
      output += `|-------|-------|\n`;
      output += `| Workflow ID | \`${workflowId}\` |\n`;
      output += `| Subtasks | ${subtasks.length} |\n`;
      output += `| Provider | **${routingResult.provider}** |\n`;
      output += `| Model | ${subtaskModel} |\n`;
      if (routingResult.selectedHost || routingResult.hostId) {
        output += `| Host | ${routingResult.selectedHost || routingResult.hostId} |\n`;
      }
      output += `\n### Subtasks\n\n`;
      output += `| Step | Task ID | Description |\n`;
      output += `|------|---------|-------------|\n`;
      for (const t of createdTasks) {
        output += `| ${t.step} | \`${t.taskId.slice(0, 12)}...\` | ${t.description.slice(0, 50)}${t.description.length > 50 ? '...' : ''} |\n`;
      }
      output += `\n### Why Decomposed?\n`;
      output += `${decomposeDecision.reason}\n\n`;
      output += `Use \`workflow_status\` with id \`${workflowId}\` to check progress.\n`;
      output += `If a subtask fails, it will auto-retry with cloud provider.`;
      const subscriptionTarget = buildSubscriptionTarget({
        workflowId,
        taskIds: createdTasks.map(taskRecord => taskRecord.taskId),
      });
      output += formatSubscriptionInstructions(subscriptionTarget);

      return {
        __subscribe_workflow_id: workflowId,
        __subscribe_task_ids: subscriptionTarget.task_ids,
        workflow_id: workflowId,
        task_ids: subscriptionTarget.task_ids,
        subscription_target: subscriptionTarget,
        content: [{ type: 'text', text: output }],
      };
    }
  }

  if (decomposeDecision.decompose && decomposeDecision.type === 'js') {
    // JS/TS decomposition: resolve files, measure line counts, extract function boundaries
    const jsFilePattern = /\b([\w./-]+\.(?:js|ts|mjs|cjs|jsx|tsx))\b/gi;
    const mentionedFiles = task.match(jsFilePattern) || [];
    const allFiles = [...new Set([...(files || []), ...mentionedFiles])];

    const jsWorkDir = working_directory || process.cwd();
    let resolvedJsFiles = allFiles;
    try {
      const resolution = taskManager.resolveFileReferences(task, jsWorkDir);
      if (resolution.resolved.length > 0) resolvedJsFiles = resolution.resolved.map(r => r.actual);
    } catch (err) {
      logger.debug('[integration-routing] non-critical error resolving file references for route sizing:', err.message || err);
    }

    let largestFile = null;
    let largestLineCount = 0;
    for (const f of resolvedJsFiles) {
      try {
        const absPath = path.isAbsolute(f) ? f : path.join(jsWorkDir, f);
        if (!/\.(?:js|ts|mjs|cjs|jsx|tsx)$/i.test(absPath)) continue;
        if (!isPathTraversalSafe(absPath, jsWorkDir)) continue;
        const content = await fsPromises.readFile(absPath, 'utf-8');
        const lineCount = content.split('\n').length;
        if (lineCount > largestLineCount) { largestLineCount = lineCount; largestFile = f; }
      } catch (err) {
        logger.debug('[integration-routing] non-critical error reading routed file size:', err.message || err);
      }
    }

    if (largestFile && largestLineCount > GUIDED_FILE_THRESHOLD) {
      const absLargest = path.isAbsolute(largestFile) ? largestFile : path.join(jsWorkDir, largestFile);
      let boundaries;
      try { boundaries = await taskManager.extractJsFunctionBoundaries(absLargest); }
      catch (e) { logger.warn(`[JSDecompose] Failed to parse ${largestFile}: ${e.message}`); boundaries = []; }

      if (boundaries.length >= GUIDED_MIN_FUNCTIONS) {
        const BATCH_LINE_LIMIT = PROVIDER_DEFAULTS.BATCH_LINE_LIMIT;
        const batches = [];
        let currentBatch = [], currentLines = 0;
        for (const fn of boundaries) {
          if (currentLines + fn.lineCount > BATCH_LINE_LIMIT && currentBatch.length > 0) { batches.push(currentBatch); currentBatch = []; currentLines = 0; }
          currentBatch.push(fn); currentLines += fn.lineCount;
        }
        if (currentBatch.length > 0) batches.push(currentBatch);

        const actionMatch = task.match(/^(.*?)(?:\s+(?:to|for|in)\s+)/i);
        const action = actionMatch ? actionMatch[1].trim() : task.split(/\s+/).slice(0, 3).join(' ');

        // Build subtask descriptions from batches
        const subtaskDescs = batches.map((batch) => {
          const fnNames = batch.map(fn => fn.name).join(', ');
          const startLine = batch[0].startLine;
          const endLine = batch[batch.length - 1].endLine;
          return `${action} for functions: ${fnNames} in file \`${largestFile}\` (lines ${startLine}-${endLine}). Only modify these specific functions. Do not change any code outside lines ${startLine}-${endLine}.`;
        });

        // Build sub-task definitions with provider locked to routing result
        const { tasks: taskDefs } = buildDecomposedTasks(
          { task, working_directory: jsWorkDir, files },
          routingResult,
          { subtasks: subtaskDescs, version_intent, parent_task_id: submissionTaskId }
        );

        const workflowId = require('uuid').v4();
        workflowEngine.createWorkflow({ id: workflowId, name: `JS Auto: ${task.substring(0, 55)}${task.length > 55 ? '...' : ''}`, description: `Auto-decomposed: ${largestFile} (${largestLineCount} lines, ${boundaries.length} fns, ${batches.length} batches)`, status: 'pending' });

        const subtaskModel = model || resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL;
        let prevTaskId = null;
        const createdTasks = [];

        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i];
          const fnNames = batch.map(fn => fn.name).join(', ');
          const startLine = batch[0].startLine;
          const endLine = batch[batch.length - 1].endLine;
          const nodeId = `step-${i + 1}`;
          const subtaskId = require('uuid').v4();
          const def = taskDefs[i];

          taskCore.createTask({
            id: subtaskId,
            task_description: def.task,
            working_directory: jsWorkDir,
            project: project || undefined,
            tags: tags || undefined,
            status: prevTaskId ? 'waiting' : 'queued',
            provider: def.provider,  // locked to routed provider
            model: subtaskModel,
            timeout_minutes: effectiveTimeout,
            priority: priority || 0,
            complexity: 'normal',
            workflow_id: workflowId,
            workflow_node_id: nodeId,
            ollama_host_id: routingResult.selectedHost || routingResult.hostId || null,
            metadata: JSON.stringify({
              smart_routing: true,
              intended_provider: def.provider,
              decomposed_from: task,
              js_decomposition: true,
              subtask_index: i + 1,
              total_subtasks: batches.length,
              target_file: largestFile,
              function_names: batch.map(fn => fn.name),
              line_range: { start: startLine, end: endLine },
              tuning_overrides: Object.keys(tuningOverrides).length > 0 ? tuningOverrides : null,
              mcp_session_id: __sessionId || undefined,
            })
          });

          if (prevTaskId) { workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: subtaskId, depends_on_task_id: prevTaskId, on_fail: 'continue' }); }
          createdTasks.push({ taskId: subtaskId, step: i + 1, description: def.task, nodeId, functions: batch.map(fn => fn.name), lines: `${startLine}-${endLine}` });
          prevTaskId = subtaskId;
        }

        workflowEngine.updateWorkflow(workflowId, { status: 'running', total_tasks: batches.length, started_at: new Date().toISOString() });
        taskManager.processQueue();

        let output = `## JS File Auto-Decomposed into Workflow\n\n`;
        output += `\`${largestFile}\` (${largestLineCount} lines, ${boundaries.length} functions) split into ${batches.length} batches.\n\n`;
        output += `| Field | Value |\n|-------|-------|\n`;
        output += `| Workflow ID | \`${workflowId}\` |\n| Target File | \`${largestFile}\` |\n| Batches | ${batches.length} |\n| Provider | **${routingResult.provider}** |\n| Model | ${subtaskModel} |\n| On Failure | continue |\n`;
        output += `\n### Batches\n\n| Batch | Lines | Functions |\n|-------|-------|-----------|\n`;
        for (const t of createdTasks) { output += `| ${t.step} | ${t.lines} | ${t.functions.join(', ')} |\n`; }
        output += `\n### Why Decomposed?\n`;
        output += `${decomposeDecision.reason}\n\n`;
        output += `Use \`workflow_status\` with id \`${workflowId}\` to check progress.`;
        const subscriptionTarget = buildSubscriptionTarget({
          workflowId,
          taskIds: createdTasks.map(taskRecord => taskRecord.taskId),
        });
        output += formatSubscriptionInstructions(subscriptionTarget);
        logger.info(`[JSDecompose] ${largestFile}: ${batches.length} batches, ${boundaries.length} fns, ${largestLineCount} lines`);
        return {
          __subscribe_workflow_id: workflowId,
          __subscribe_task_ids: subscriptionTarget.task_ids,
          workflow_id: workflowId,
          task_ids: subscriptionTarget.task_ids,
          subscription_target: subscriptionTarget,
          content: [{ type: 'text', text: output }],
        };
      }
    }
  }

  // Standard single-task path (no decomposition)
  const taskId = submissionTaskId;

  // Determine model - use three-tier selection based on complexity
  let modRoutingReason = null; // P102: Track modification routing reason for response
  // P102: Only skip modification routing if user explicitly set a model.
  // Previously used routingResult.model as default, which meant !taskModel was always
  // false for normal/complex tasks — completely bypassing the modification safety logic.
  let taskModel = model || null;

  // Codex exhaustion gate: when quota is exceeded, skip all Codex routing
  const codexExhausted = providerRoutingCore.isCodexExhausted();
  if (codexExhausted) {
    logger.info(`[SmartRouting] Codex exhausted — all tasks route to local LLM`);
  }

  // Route test-writing tasks to Codex Spark — local LLMs consistently produce tests with
  // hallucinated APIs, wrong assertions, and broken output. Cloud providers (commandos)
  // handle test writing reliably. Only applies when user didn't force a provider/model.
  const testTaskPattern = /\b(write|create|add|generate|replace .+ with)\b.{0,30}\b(tests?|specs?|\.test\.|\.spec\.)/i;
  const explicitTestTaskPattern = /\b(?:test|testing)\s+task\b/i;
  const isTestTask = !override_provider && !model &&
    (testTaskPattern.test(task) || explicitTestTaskPattern.test(task));
  if (isTestTask && selectedProvider !== 'codex' && serverConfig.isOptIn('codex_enabled') && !codexExhausted) {
    selectedProvider = 'codex';
    const sparkEnabled = serverConfig.isOptIn('codex_spark_enabled');
    if (sparkEnabled) {
      taskModel = 'gpt-5.3-codex-spark';
    }
    logger.info(`[SmartRouting] Test task detected → routing to Codex${sparkEnabled ? ' Spark' : ''} (local LLMs unreliable for tests)`);
  }
  const modResult = await resolveModificationRouting(task, files, routingResult, {
    selectedProvider,
    override_provider,
    model,
    complexity,
    working_directory: workingDirectory,
    codexExhausted,
  });
  if (modResult.error) return modResult.error;
  selectedProvider = modResult.selectedProvider;
  // Preserve a previously-set taskModel (e.g. from test-writing promotion) when the
  // modification helper had no opinion (returned null).
  if (modResult.taskModel != null) taskModel = modResult.taskModel;
  modRoutingReason = modResult.modRoutingReason;

  // P71: Multi-host load distribution with smart model fallback
  // When the primary model's host is busy, try next-ranked models from
  // selectBestModel on less-loaded hosts. Falls back to legacy tier-based
  // fallback for non-smart-routed code paths (Codex overrides etc.).
  if (taskModel && !model) { // Only when auto-selected, not user-specified
    const hostCheck = hostManagement.selectOllamaHostForModel(taskModel);
    if (hostCheck.host && hostCheck.host.running_tasks > 0) {
      // P77: Skip fallback for async-heavy tasks
      const asyncPattern = /\b(async|await|Promise\b|\.then\(|\.catch\()\b/i;
      if (asyncPattern.test(task)) {
        logger.info(`[SmartRouting] P77: Async-heavy task detected, skipping fallback — queuing on primary host`);
      } else {
        // Try to find a less-loaded host with a capable model
        let foundFallback = false;

        // If we have a ranked list from smart selection, iterate it
        const taskType = hostManagement.classifyTaskType(task);
        const taskLanguage = hostManagement.detectTaskLanguage(task, files || []);
        const hosts = hostManagement.listOllamaHosts().filter(h => h.enabled && h.status !== 'down');
        const availableModels = [...new Set(
          hosts.flatMap(h => {
            try { return JSON.parse(h.models || '[]'); } catch { return []; }
          })
        )];

        if (availableModels.length > 1) {
          const ranked = hostManagement.selectBestModel(taskType, taskLanguage, complexity, availableModels, { estimatedTokens });
          for (const candidate of ranked) {
            if (candidate.model === taskModel) continue; // Skip current model
            const candidateHost = hostManagement.selectOllamaHostForModel(candidate.model);
            if (candidateHost.host && candidateHost.host.running_tasks === 0) {
              logger.info(`[SmartRouting] Smart fallback: Primary '${hostCheck.host.name}' busy → ${candidate.model} on '${candidateHost.host.name}' (score=${candidate.score})`);
              taskModel = candidate.model;
              foundFallback = true;
              break;
            }
          }
        }

        // Legacy P71 fallback if smart fallback didn't find anything
        if (!foundFallback) {
          const tierName = complexity === 'simple' ? 'fast' : complexity === 'normal' ? 'balanced' : 'quality';
          const fallbackModel = serverConfig.get(`ollama_${tierName}_model_fallback`);
          if (fallbackModel && fallbackModel !== taskModel) {
            const fallbackHost = hostManagement.selectOllamaHostForModel(fallbackModel);
            if (fallbackHost.host && fallbackHost.host.running_tasks === 0) {
              logger.info(`[SmartRouting] P71 legacy fallback: ${taskModel} → ${fallbackModel} on '${fallbackHost.host.name}'`);
              taskModel = fallbackModel;
            }
          }
        }
      }
    }
  }

  // Guard: redirect to the first enabled provider when the selected provider is disabled in provider_config
  // Skip when user explicitly chose the provider — respect their decision
  const selectedProviderConfig = providerRoutingCore.getProvider(selectedProvider);
  if (!override_provider && (!selectedProviderConfig || !selectedProviderConfig.enabled)) {
    const sparkEnabled = serverConfig.isOptIn('codex_spark_enabled');
    const prevProvider = selectedProvider;
    selectedProvider = resolveSafeSelectedProvider(providerRoutingCore.getDefaultProvider()) || 'codex';
    if (selectedProvider === 'codex' && sparkEnabled && (complexity === 'simple' || complexity === 'normal')) {
      taskModel = 'gpt-5.3-codex-spark';
    } else {
      taskModel = null;
    }
    modRoutingReason = `${prevProvider || 'null'} disabled → ${selectedProvider}${taskModel ? ' Spark' : ''} (provider disabled)`;
    logger.info(`[SmartRouting] ${modRoutingReason}`);
  }

  // Guard: deprioritize unhealthy cloud providers (skip when user explicitly chose the provider)
  if (!override_provider && typeof providerRoutingCore.isProviderHealthy === 'function' && !providerRoutingCore.isProviderHealthy(selectedProvider)) {
    const chain = getFallbackProviderChain(selectedProvider);
    const healthyAlternatives = chain
      .map((providerName, idx) => ({ providerName, idx, score: getProviderHealthScore(providerName) }))
      .filter((candidate) => {
        if (!candidate.providerName || candidate.providerName === selectedProvider) {
          return false;
        }
        try {
          const providerConfig = providerRoutingCore.getProvider(candidate.providerName);
          return providerConfig && providerConfig.enabled && providerRoutingCore.isProviderHealthy(candidate.providerName);
        } catch {
          return false;
        }
      })
      .sort((a, b) => {
        if (a.score !== b.score) {
          return b.score - a.score;
        }
        return a.idx - b.idx;
      });

    if (healthyAlternatives.length > 0) {
      const healthyAlt = healthyAlternatives[0].providerName;
      const prevProvider = selectedProvider;
      selectedProvider = healthyAlt;
      taskModel = null;
      modRoutingReason = `${prevProvider} unhealthy → ${healthyAlt}`;
      logger.info(`[SmartRouting] Health gate: ${modRoutingReason}`);
    } else {
      logger.warn(`[SmartRouting] Provider ${selectedProvider} is unhealthy but no healthy alternative available`);
    }
  }

  const schedulingMode = configCore.getConfig ? (configCore.getConfig('scheduling_mode') || 'legacy') : 'legacy';
  const useTierList = schedulingMode === 'slot-pull';
  const tierRoutingResult = useTierList
    ? providerRoutingCore.analyzeTaskForRouting(task, workingDirectory, files, {
        tierList: true,
        isUserOverride: !!override_provider,
        overrideProvider: override_provider || null,
      })
    : null;
  const slotPullEligibleProviders = Array.isArray(tierRoutingResult?.eligible_providers) && tierRoutingResult.eligible_providers.length > 0
    ? tierRoutingResult.eligible_providers
    : [override_provider || selectedProvider].filter(Boolean);
  const slotPullIntendedProvider = override_provider
    || resolveSafeSelectedProvider(slotPullEligibleProviders[0] || selectedProvider)
    || selectedProvider;
  const normalizedSlotPullEligibleProviders = slotPullEligibleProviders
    .filter((providerName, index, providers) => {
      if (typeof providerName !== 'string' || !providerName.trim()) {
        return false;
      }
      return providers.findIndex((candidate) => candidate === providerName) === index;
    })
    .map((providerName) => providerName.trim());
  if (slotPullIntendedProvider && !normalizedSlotPullEligibleProviders.includes(slotPullIntendedProvider)) {
    normalizedSlotPullEligibleProviders.unshift(slotPullIntendedProvider);
  }
  const slotPullCapabilityRequirements = Array.isArray(tierRoutingResult?.capability_requirements)
    ? tierRoutingResult.capability_requirements
    : [];
  const slotPullQualityTier = tierRoutingResult?.quality_tier
    || (complexity === 'complex' ? 'complex' : (complexity === 'simple' ? 'simple' : 'normal'));
  const slotPullMetadata = {
    smart_routing: true,
    eligible_providers: normalizedSlotPullEligibleProviders,
    intended_provider: slotPullIntendedProvider,
    capability_requirements: slotPullCapabilityRequirements,
    quality_tier: slotPullQualityTier,
    user_provider_override: !!override_provider,
    requested_provider: override_provider || null,
    needs_review: needsReview || undefined,
    split_advisory: splitAdvisory || undefined,
    split_suggestions: splitSuggestions.length > 0 ? splitSuggestions : undefined,
    requested_model: model || null,
    routing_rule: routingResult.rule ? routingResult.rule.name : null,
    routing_reason: tierRoutingResult?.reason || routingResult.reason,
    complexity: complexity,
    routing_mode: codexExhausted ? 'codex_exhausted' : (!providerRoutingCore.hasHealthyOllamaHost() ? 'local_offline' : 'normal'),
    tuning_overrides: Object.keys(tuningOverrides).length > 0 ? tuningOverrides : null,
    _routing_chain: routingResult.chain && routingResult.chain.length > 1 ? routingResult.chain : undefined,
    _routing_template: routing_template || undefined,
    mcp_session_id: __sessionId || undefined,
  };

  if (useTierList) {
    taskCore.createTask({
      id: taskId,
      task_description: task,
      working_directory: workingDirectory,
      project: project || undefined,
      tags: tags || undefined,
      status: 'queued',
      provider: override_provider || null,
      model: taskModel,
      timeout_minutes: effectiveTimeout,
      priority: priority || 0,
      complexity: complexity,
      review_status: reviewStatus,
      ollama_host_id: routingResult.selectedHost || routingResult.hostId || null,
      metadata: JSON.stringify(slotPullMetadata)
    });
  } else {
    taskCore.createTask({
      id: taskId,
      task_description: task,
      working_directory: workingDirectory,
      project: project || undefined,
      tags: tags || undefined,
      status: 'queued',
      provider: selectedProvider,  // Use the routing-resolved provider (was null — broke template routing)
      model: taskModel,
      timeout_minutes: effectiveTimeout,
      priority: priority || 0,
      complexity: complexity,
      review_status: reviewStatus,
      ollama_host_id: routingResult.selectedHost || routingResult.hostId || null,
      metadata: JSON.stringify({
        smart_routing: true,
        intended_provider: selectedProvider,
        user_provider_override: !!override_provider,
        requested_provider: override_provider || null,
        needs_review: needsReview || undefined,
        split_advisory: splitAdvisory || undefined,
        split_suggestions: splitSuggestions.length > 0 ? splitSuggestions : undefined,
        requested_model: model || null,
        routing_rule: routingResult.rule ? routingResult.rule.name : null,
        routing_reason: routingResult.reason,
        complexity: complexity,
        routing_mode: codexExhausted ? 'codex_exhausted' : (!providerRoutingCore.hasHealthyOllamaHost() ? 'local_offline' : 'normal'),
        tuning_overrides: Object.keys(tuningOverrides).length > 0 ? tuningOverrides : null,
        _routing_chain: routingResult.chain && routingResult.chain.length > 1 ? routingResult.chain : undefined,
        _routing_template: routing_template || undefined,
        mcp_session_id: __sessionId || undefined,
      })
    });
  }

  if (useTierList && !override_provider && typeof taskCore.patchTaskSlotBinding === 'function') {
    try {
      taskCore.patchTaskSlotBinding(taskId, slotPullMetadata);
    } catch (err) {
      logger.debug(`[SmartRouting] Failed to persist slot-pull late binding for ${taskId}: ${err.message}`);
    }
  }

  // Context-stuff: resolve files for free API providers at submission time
  if (CONTEXT_STUFFING_PROVIDERS.has(selectedProvider) && context_stuff !== false) {
    try {
      const depth = context_depth || 1;
      const scanResult = resolveContextFiles({
        taskDescription: task,
        workingDirectory: workingDirectory,
        files: Array.isArray(files) ? files.filter(f => typeof f === 'string') : [],
        contextDepth: depth,
      });
      if (scanResult.contextFiles.length > 0) {
        const taskRow = taskCore.getTask(taskId);
        const existingMeta = (taskRow && typeof taskRow.metadata === 'object' && taskRow.metadata) ? { ...taskRow.metadata } : {};
        existingMeta.context_files = scanResult.contextFiles;
        existingMeta.context_scan_reasons = Object.fromEntries(scanResult.reasons);
        taskCore.patchTaskMetadata(taskId, existingMeta);
        logger.info(`Context-stuffed ${scanResult.contextFiles.length} files for task ${taskId}`);
      }
    } catch (e) {
      logger.debug(`Context scan failed for task ${taskId}: ${e.message}`);
    }
  }

  // Start the task
  taskManager.processQueue();

  // Auto-activate CI watch for this repo (fire-and-forget)
  if (workingDirectory) {
    try {
      const ciWatcher = require('../../ci/watcher');
      ciWatcher.autoActivateForRepo(workingDirectory);
    } catch (_e) { /* non-fatal */ }
  }

  let output = `## Task Submitted with Smart Routing\n\n`;
  output += `| Field | Value |\n`;
  output += `|-------|-------|\n`;
  output += `| Task ID | \`${taskId}\` |\n`;
  output += `| Status | queued |\n`;
  output += `| Provider | **${selectedProvider}** |\n`;
  output += `| Complexity | ${complexity} |\n`;
  if (taskModel) {
    output += `| Model | ${taskModel} |\n`;
  }
  if (routingResult.selectedHost || routingResult.hostId) {
    output += `| Host | ${routingResult.selectedHost || routingResult.hostId} |\n`;
  }
  output += `| Review Required | ${reviewStatus ? 'Yes' : 'No (auto-approve)'} |\n`;
  output += `| Routing Rule | ${routingResult.rule ? routingResult.rule.name : 'Complexity-based'} |\n`;
  output += `\n### Routing Decision\n`;
  if (modRoutingReason) {
    output += `**Modification routing:** ${modRoutingReason}\n\n`;
  } else {
    output += `${routingResult.reason}\n\n`;
  }
  output += `Use \`get_task_status\` with id \`${taskId}\` to check progress.`;
  if (reviewStatus) {
    output += `\n\n**Note:** This task will require review after completion. Use \`list_pending_reviews\` to check.`;
  }
  const subscriptionTarget = buildSubscriptionTarget({ taskIds: [taskId] });
  output += formatSubscriptionInstructions(subscriptionTarget);

  return {
    __subscribe_task_id: taskId,
    __subscribe_task_ids: subscriptionTarget.task_ids,
    task_id: taskId,
    task_ids: subscriptionTarget.task_ids,
    subscription_target: subscriptionTarget,
    content: [{ type: 'text', text: output }],
  };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}



/**
 * Test which provider would be selected for a task
 */
function handleTestRouting(args) {
  if (!args || typeof args !== 'object') {
    return makeError(ErrorCodes.INVALID_PARAM, 'Arguments object is required');
  }
  const { task, files } = args;
  const safeFiles = Array.isArray(files) ? files : (files ? [String(files)] : files);
  if (safeFiles) {
    for (const file of safeFiles) {
      if (!isPathTraversalSafe(file)) {
        return makeError(ErrorCodes.INVALID_PARAM, 'file path contains path traversal');
      }
    }
  }

  if (!task || typeof task !== 'string' || task.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task must be a non-empty string');
  }

  const result = providerRoutingCore.analyzeTaskForRouting(task, null, safeFiles);

  let text = `## Routing Test Result\n\n`;
  text += `**Task:** "${task.substring(0, 100)}${task.length > 100 ? '...' : ''}"\n\n`;

  if (safeFiles && safeFiles.length > 0) {
    text += `**Files:** ${safeFiles.join(', ')}\n\n`;
  }

  text += `### Decision\n\n`;
  text += formatRuleTable('Decision', {
    'Selected Provider': `**${result.provider}**`,
    'Matched Rule': result.rule ? result.rule.name : 'None',
    'Rule Type': result.rule ? result.rule.rule_type : 'N/A',
    'Rule Priority': result.rule ? result.rule.priority : 'N/A',
  }).replace('## Decision\n\n', '');
  text += `\n**Reason:** ${result.reason}`;

  if (result.rule) {
    text += `\n\n### Matched Rule Details\n`;
    text += `- **Pattern:** \`${result.rule.pattern}\`\n`;
    text += `- **Description:** ${result.rule.description || 'N/A'}`;
  }

  return { content: [{ type: 'text', text }] };
}


/**
 * Create a new routing rule
 */
function handleAddRoutingRule(args) {
  if (!args || typeof args !== 'object') {
    return makeError(ErrorCodes.INVALID_PARAM, 'Arguments object is required');
  }
  const { name, description, rule_type, pattern, target_provider, priority, enabled } = args;

  if (!name || !pattern || !target_provider) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name, pattern, and target_provider are required');
  }

  // Validate provider exists
  const provider = providerRoutingCore.getProvider(target_provider);
  if (!provider) {
    return makeError(ErrorCodes.INVALID_PARAM, `Unknown provider: ${target_provider}. Available: codex, claude-cli, ollama`);
  }

  // Validate rule_type
  const validTypes = ['keyword', 'extension', 'regex'];
  if (rule_type && !validTypes.includes(rule_type)) {
    return makeError(ErrorCodes.INVALID_PARAM, `Invalid rule_type: ${rule_type}. Must be one of: ${validTypes.join(', ')}`);
  }

  const rule = providerRoutingCore.createRoutingRule({
    name,
    description,
    rule_type: rule_type || 'keyword',
    pattern,
    target_provider,
    priority,
    enabled
  });

  let text = formatRuleTable('Routing Rule Created', {
    ID: rule.id,
    Name: rule.name,
    Type: rule.rule_type,
    Pattern: `\`${rule.pattern}\``,
    'Target Provider': rule.target_provider,
    Priority: rule.priority,
    Enabled: rule.enabled ? 'Yes' : 'No',
  });

  if (rule.description) {
    text += `\n**Description:** ${rule.description}`;
  }

  return { content: [{ type: 'text', text }] };
}


/**
 * Update a routing rule
 */
function handleUpdateRoutingRule(args) {
  if (!args || typeof args !== 'object') {
    return makeError(ErrorCodes.INVALID_PARAM, 'Arguments object is required');
  }
  const { rule: ruleId, ...updates } = args;

  if (!ruleId) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'rule (ID or name) is required');
  }

  // Validate provider if updating
  if (updates.target_provider) {
    const provider = providerRoutingCore.getProvider(updates.target_provider);
    if (!provider) {
      return makeError(ErrorCodes.INVALID_PARAM, `Unknown provider: ${updates.target_provider}`);
    }
  }

  let rule;
  try {
    rule = providerRoutingCore.updateRoutingRule(ruleId, updates);
  } catch {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Routing rule not found: ${ruleId}`);
  }

  if (!rule) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Routing rule not found: ${ruleId}`);
  }

  const text = formatRuleTable('Routing Rule Updated', {
    ID: rule.id,
    Name: rule.name,
    Type: rule.rule_type,
    Pattern: `\`${rule.pattern}\``,
    'Target Provider': rule.target_provider,
    Priority: rule.priority,
    Enabled: rule.enabled ? 'Yes' : 'No',
  });

  return { content: [{ type: 'text', text }] };
}


/**
 * Delete a routing rule
 */
function handleDeleteRoutingRule(args) {
  if (!args || typeof args !== 'object') {
    return makeError(ErrorCodes.INVALID_PARAM, 'Arguments object is required');
  }
  const { rule: ruleId } = args;

  if (!ruleId) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'rule (ID or name) is required');
  }

  // Delete the rule — some DB implementations throw, others return {changes: 0}
  let result;
  try {
    result = providerRoutingCore.deleteRoutingRule(ruleId);
  } catch {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Routing rule not found: ${ruleId}`);
  }

  // Handle DB implementations that return RunResult {changes: 0} instead of throwing
  if (result && typeof result.changes === 'number' && result.changes === 0) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Routing rule not found: ${ruleId}`);
  }
  // Handle DB implementations that return boolean false
  if (result === false) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Routing rule not found: ${ruleId}`);
  }

  const rule = result && result.rule;
  let text = `## Routing Rule Deleted\n\n`;
  text += `Successfully deleted rule: **${rule ? rule.name : ruleId}**\n\n`;
  if (rule) {
    text += formatRuleTable('Deleted Rule', {
      Pattern: `\`${rule.pattern}\``,
      'Target Provider': rule.target_provider,
    }).replace('## Deleted Rule\n\n', '');
  }

  return { content: [{ type: 'text', text }] };
}


function createIntegrationRoutingHandlers(_deps) {
  return {
    handleSmartSubmitTask,
    handleTestRouting,
    handleAddRoutingRule,
    handleUpdateRoutingRule,
    handleDeleteRoutingRule,
  };
}

module.exports = {
  handleSmartSubmitTask,
  handleTestRouting,
  handleAddRoutingRule,
  handleUpdateRoutingRule,
  handleDeleteRoutingRule,
  createIntegrationRoutingHandlers,
};
