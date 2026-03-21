/**
 * Integration task routing and smart submission handlers.
 */

const path = require('path');
const fs = require('fs');
const db = require('../../database');
const taskManager = require('../../task-manager');
const { PROVIDER_DEFAULTS } = require('../../constants');
const { ErrorCodes, makeError } = require('../error-codes');
const { MAX_TASK_LENGTH, isPathTraversalSafe, checkProviderAvailability } = require('../shared');
const { CONTEXT_STUFFING_PROVIDERS } = require('../../utils/context-stuffing');
const { resolveContextFiles } = require('../../utils/smart-scan');
const logger = require('../../logger').child({ component: 'integration-routing' });
const serverConfig = require('../../config');
serverConfig.init({ db });

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





// ============================================
// Smart Routing Handlers
// ============================================

/**
 * Submit a task with automatic provider selection
 */
async function handleSmartSubmitTask(args) {
  try {
  
  if (!args || typeof args !== 'object') {
    return makeError(ErrorCodes.INVALID_PARAM, 'Arguments object is required');
  }
  
  const { task, working_directory, files: rawFiles, model, timeout_minutes, priority, provider, override_provider: legacyOverrideProvider, tuning, context_stuff, context_depth, prefer_free, routing_template, __sessionId } = args;
  // Support both 'provider' (standard) and legacy 'override_provider' alias
  const override_provider = provider || legacyOverrideProvider;
  const files = Array.isArray(rawFiles) ? rawFiles : (rawFiles ? [String(rawFiles)] : undefined);
  if (files) {
    for (const file of files) {
      if (!isPathTraversalSafe(file)) {
        return makeError(ErrorCodes.INVALID_PARAM, 'file path contains path traversal');
      }
    }
  }
  let tuningOverrides;
  try {
    tuningOverrides = resolveSmartSubmitTuning(tuning);
  } catch (err) {
    return makeError(ErrorCodes.INVALID_PARAM, err.message);
  }

  if (!task || typeof task !== 'string' || task.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task must be a non-empty string');
  }
  if (task.length > MAX_TASK_LENGTH) {
    return makeError(ErrorCodes.INVALID_PARAM, `Task description exceeds maximum length (${task.length} > ${MAX_TASK_LENGTH} characters)`);
  }

  const estimatedTokens = Math.max(1, Math.ceil(task.length / 4));

  let selectedProvider;
  let routingResult;

  // D2.2: Single source — getProviderHealthScore() now lives in provider-routing-core.js
  const getProviderHealthScore = (providerName) => {
    try {
      return db.getProviderHealthScore(providerName);
    } catch (e) {
      logger.debug('[smart-routing] getProviderHealthScore error:', e.message);
      return 0.5;
    }
  };

  // Single source of truth: provider-routing-core.js owns the fallback chain.
  // No inline fallback list — getProviderFallbackChain() always returns a default.
  const getFallbackProviderChain = (providerName) => {
    if (typeof db.getProviderFallbackChain === 'function') {
      try {
        return db.getProviderFallbackChain(providerName);
      } catch (e) { logger.debug('[smart-routing] getProviderFallbackChain error:', e.message); }
    }
    // Defensive: should never reach here since db is always initialized,
    // but return empty to avoid undefined errors.
    return [];
  };

  if (override_provider) {
    // User explicitly requested a provider
    selectedProvider = override_provider;
    routingResult = { provider: override_provider, rule: null, reason: 'User override' };
  } else {
    // Run fresh health check before routing (force=true to avoid stale cache)
    await db.checkOllamaHealth(true);

    // Use smart routing (will use freshly updated health status for fallback decisions)
    routingResult = db.analyzeTaskForRouting(task, working_directory, files, {
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
  const availCheck = checkProviderAvailability(db, { hasExplicitProvider: !!override_provider });
  if (availCheck) return availCheck.error;

  // Validate provider
  const providerConfig = db.getProvider(selectedProvider);
  if (!providerConfig) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Selected provider not found: ${selectedProvider}`);
  }
  if (!providerConfig.enabled) {
    // TDA-01: If user explicitly chose this provider, return an error instead of
    // silently falling back. Explicit provider intent is sovereign.
    if (override_provider) {
      return makeError(ErrorCodes.PROVIDER_ERROR, `Provider ${selectedProvider} is disabled. Enable it or choose a different provider.`);
    }
    // Auto-routed: fallback to default
    selectedProvider = db.getDefaultProvider();
    routingResult.reason += ` (original provider disabled, falling back to ${selectedProvider})`;
  }

  // Determine task complexity for routing and review requirements
  const complexity = routingResult.complexity || db.determineTaskComplexity(task, files);
  const splitAdvisory = typeof db.getSplitAdvisory === 'function'
    ? db.getSplitAdvisory(complexity, files)
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

  // AUTO-DECOMPOSE: For complex code-gen tasks, try to decompose into local-friendly subtasks
  // Only applies when: complexity is complex, no override provider, and task matches decomposition patterns
  // P68: Decomposition templates are C#-only. Gate on C#/.NET indicators to avoid
  // generating .cs files for TypeScript/Python/etc tasks.
  const isCSharpTask = /\.cs\b|c#|\.net|csproj|xaml|wpf|winui|maui|blazor|asp\.net|nuget/i.test(task) ||
    (files && files.some(f => /\.cs$|\.csproj$|\.xaml$|\.sln$/i.test(f)));
  if (complexity === 'complex' && !override_provider && isCSharpTask) {
    const subtasks = db.decomposeTask(task, workingDirectory);

    if (subtasks && subtasks.length > 1) {
      // Ensure working directory exists before creating workflow
      // Safety: only create if parent directory exists (prevents arbitrary path creation)
      if (!fs.existsSync(workingDirectory)) {
        const parentDir = path.dirname(workingDirectory);
        if (fs.existsSync(parentDir)) {
          // Parent exists, safe to create the target directory
          try {
            fs.mkdirSync(workingDirectory, { recursive: false });
            logger.info(`Created working directory for decomposed task: ${workingDirectory}`);
          } catch (mkdirErr) {
            logger.warn(`Failed to create working directory ${workingDirectory}: ${mkdirErr.message}`);
            // Continue anyway - the subtasks might still work or fail gracefully
          }
        } else {
          logger.warn(`Working directory parent does not exist: ${parentDir} - decomposed tasks may fail`);
        }
      }

      // Create a workflow instead of a single task
      const workflowId = require('uuid').v4();
      const workflowName = `Auto: ${task.substring(0, 60)}${task.length > 60 ? '...' : ''}`;

      // Create the workflow
      db.createWorkflow({
        id: workflowId,
        name: workflowName,
        description: `Auto-decomposed from: ${task}`,
        status: 'pending'
      });

      // Determine model for subtasks - use balanced tier (14B) since subtasks are simpler
      const subtaskTier = db.getModelTierForComplexity('normal');
      const subtaskModel = model || subtaskTier.modelConfig;
      const subtaskProvider = 'aider-ollama';

      let _prevNodeId = null;
      let prevTaskId = null;
      const createdTasks = [];

      for (let i = 0; i < subtasks.length; i++) {
        const nodeId = `step-${i + 1}`;
        const subtaskId = require('uuid').v4();

        // Create the subtask — provider deferred until slot claim
        db.createTask({
          id: subtaskId,
          task_description: subtasks[i],
          working_directory: workingDirectory,
          status: prevTaskId ? 'waiting' : 'queued',  // First task queued, rest waiting
          provider: null,  // deferred assignment
          model: subtaskModel,
          timeout_minutes: effectiveTimeout,
          priority: priority || 0,
          complexity: 'normal',  // Subtasks are simpler
          workflow_id: workflowId,
          workflow_node_id: nodeId,
          ollama_host_id: routingResult.selectedHost || routingResult.hostId || null,
          metadata: JSON.stringify({
            smart_routing: true,
            intended_provider: subtaskProvider,
            decomposed_from: task,
            subtask_index: i + 1,
            total_subtasks: subtasks.length,
            tuning_overrides: Object.keys(tuningOverrides).length > 0 ? tuningOverrides : null,
            mcp_session_id: __sessionId || undefined,
          })
        });

        // Add task dependency if not the first task
        if (prevTaskId) {
          db.addTaskDependency({
            workflow_id: workflowId,
            task_id: subtaskId,
            depends_on_task_id: prevTaskId,
            on_fail: 'skip'  // Skip subsequent tasks if one fails
          });
        }

        createdTasks.push({
          taskId: subtaskId,
          step: i + 1,
          description: subtasks[i],
          nodeId
        });

        _prevNodeId = nodeId;
        prevTaskId = subtaskId;
      }

      // Update workflow status to running and set task counts
      db.updateWorkflow(workflowId, {
        status: 'running',
        total_tasks: subtasks.length,
        started_at: new Date().toISOString()
      });

      // Start processing
      taskManager.processQueue();

      // Return workflow info instead of single task
      let output = `## Task Auto-Decomposed into Workflow\n\n`;
      output += `Complex task was automatically split into ${subtasks.length} simpler subtasks for local LLM processing.\n\n`;
      output += `| Field | Value |\n`;
      output += `|-------|-------|\n`;
      output += `| Workflow ID | \`${workflowId}\` |\n`;
      output += `| Subtasks | ${subtasks.length} |\n`;
      output += `| Provider | **${subtaskProvider}** |\n`;
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
      output += `The original task "${task.slice(0, 80)}${task.length > 80 ? '...' : ''}" was classified as complex. `;
      output += `By breaking it into focused subtasks, each can be handled by the local 32B model (free, no rate limits).\n\n`;
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

  // AUTO-DECOMPOSE: Large JS/TS files into function-level batches for local LLMs
  {
    const jsDecomposePatterns = /\b(jsdoc|add docs|add documentation|add logging|add error handling|refactor|cleanup|clean up|add types|add comments|lint fix|add tests for)\b/i;

    if (jsDecomposePatterns.test(task) && !override_provider) {
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
          const content = fs.readFileSync(absPath, 'utf-8');
          const lineCount = content.split('\n').length;
          if (lineCount > largestLineCount) { largestLineCount = lineCount; largestFile = f; }
        } catch (err) {
          logger.debug('[integration-routing] non-critical error reading routed file size:', err.message || err);
        }
      }

      if (largestFile && largestLineCount > 500) {
        const absLargest = path.isAbsolute(largestFile) ? largestFile : path.join(jsWorkDir, largestFile);
        let boundaries;
        try { boundaries = taskManager.extractJsFunctionBoundaries(absLargest); }
        catch (e) { logger.warn(`[JSDecompose] Failed to parse ${largestFile}: ${e.message}`); boundaries = []; }

        if (boundaries.length >= 3) {
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
          const workflowId = require('uuid').v4();

          db.createWorkflow({ id: workflowId, name: `JS Auto: ${task.substring(0, 55)}${task.length > 55 ? '...' : ''}`, description: `Auto-decomposed: ${largestFile} (${largestLineCount} lines, ${boundaries.length} fns, ${batches.length} batches)`, status: 'pending' });

          const subtaskModel = 'qwen2.5-coder:32b';
          const subtaskProvider = 'aider-ollama';
          let prevTaskId = null;
          const createdTasks = [];

          for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const fnNames = batch.map(fn => fn.name).join(', ');
            const startLine = batch[0].startLine;
            const endLine = batch[batch.length - 1].endLine;
            const nodeId = `step-${i + 1}`;
            const subtaskId = require('uuid').v4();
            const subtaskDesc = `${action} for functions: ${fnNames} in file \`${largestFile}\` (lines ${startLine}-${endLine}). Only modify these specific functions. Do not change any code outside lines ${startLine}-${endLine}.`;

            db.createTask({
              id: subtaskId,
              task_description: subtaskDesc,
              working_directory: jsWorkDir,
              status: prevTaskId ? 'waiting' : 'queued',
              provider: null,  // deferred assignment
              model: subtaskModel,
              timeout_minutes: effectiveTimeout,
              priority: priority || 0,
              complexity: 'normal',
              workflow_id: workflowId,
              workflow_node_id: nodeId,
              ollama_host_id: routingResult.selectedHost || routingResult.hostId || null,
              metadata: JSON.stringify({
                smart_routing: true,
                intended_provider: subtaskProvider,
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

            if (prevTaskId) { db.addTaskDependency({ workflow_id: workflowId, task_id: subtaskId, depends_on_task_id: prevTaskId, on_fail: 'continue' }); }
            createdTasks.push({ taskId: subtaskId, step: i + 1, description: subtaskDesc, nodeId, functions: batch.map(fn => fn.name), lines: `${startLine}-${endLine}` });
            prevTaskId = subtaskId;
          }

          db.updateWorkflow(workflowId, { status: 'running', total_tasks: batches.length, started_at: new Date().toISOString() });
          taskManager.processQueue();

          let output = `## JS File Auto-Decomposed into Workflow\n\n`;
          output += `\`${largestFile}\` (${largestLineCount} lines, ${boundaries.length} functions) split into ${batches.length} batches.\n\n`;
          output += `| Field | Value |\n|-------|-------|\n`;
          output += `| Workflow ID | \`${workflowId}\` |\n| Target File | \`${largestFile}\` |\n| Batches | ${batches.length} |\n| Provider | **${subtaskProvider}** |\n| Model | ${subtaskModel} |\n| On Failure | continue |\n`;
          output += `\n### Batches\n\n| Batch | Lines | Functions |\n|-------|-------|-----------|\n`;
          for (const t of createdTasks) { output += `| ${t.step} | ${t.lines} | ${t.functions.join(', ')} |\n`; }
          output += `\nUse \`workflow_status\` with id \`${workflowId}\` to check progress.`;
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
  const codexExhausted = db.isCodexExhausted();
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
  // Skip legacy modification routing for hashline-ollama — it uses hashline annotation
  // (line-number-based edits) which handles any file size safely. The 250-line limit
  // only applies to aider-ollama and raw ollama which use SEARCH/REPLACE or whole-file.
  if (!taskModel && (selectedProvider === 'aider-ollama' || selectedProvider === 'ollama')) {
    // Detect modification tasks for routing decisions.
    // R54/P75: codestral:22b best for greenfield (deepseek-r1 over-engineers).
    // P83/R67: codestral:22b CANNOT modify existing files — route modifications to Codex.
    const taskLower = task.toLowerCase();
    // P89: Expanded modification detection to catch implicit patterns.
    // Previous regex missed "implement X in file.ts", "complete the TODO in auth.ts",
    // "extend the class", "enhance the handler". These would fall through to
    // codestral:22b which destroys files during modification.
    // Drill4: Added "fill .+ in " for Artillery stub-fill tasks ("Fill in ALL method bodies in scheduler.js")
    const modificationVerbs = /\b(fill .+ in |add .+ to (?:the |existing )?|modify |update |fix |refactor |change |rename |move |extract |remove .+ from |extend |enhance |complete .+ in |implement .+ in |replace .+ in |insert .+ in |append .+ to |delete .+ from |patch |rewrite )\b/;

    // P102: Extract filenames from task description BEFORE modification detection,
    // so that "Modify string_utils.py ..." counts as having file context.
    const fileNamePattern = /\b([\w.-]+\.(?:py|ts|js|cs|java|go|rs|rb|cpp|c|h|xaml|jsx|tsx|vue|svelte))\b/gi;
    const taskFileNames = task.match(fileNamePattern) || [];
    const hasExistingFileContext = files?.length > 0 || taskFileNames.length > 0 || /\b(?:existing|current|in .+\.\w{1,5}\b)/i.test(taskLower);
    const isModificationTask = modificationVerbs.test(taskLower) && hasExistingFileContext;

    // P83/R102-R104: Route modification tasks based on file size.
    // R102: codestral:22b DESTROYS files >50 lines in whole format (P95 confirmed).
    // R103-R104: qwen2.5-coder:32b is SAFE up to at least 233 lines in whole format.
    // Strategy: Use qwen2.5-coder:32b for small-to-medium modifications (<250 lines),
    // escalate to Codex for large files or when file size is unknown.
    const codexEnabled = serverConfig.isOptIn('codex_enabled');
    const modSafeLineLimit = PROVIDER_DEFAULTS.MOD_SAFE_LINE_LIMIT; // R104: qwen2.5-coder:32b PERFECT at 233 lines

    // Check file sizes — from explicit files array OR extracted from task description
    let maxFileLines = 0;
    let fileSizeKnown = false;
    const fs = require('fs');
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
        return makeError(ErrorCodes.INVALID_PARAM, 'file path contains path traversal');
      }

      try {
        const content = fs.readFileSync(absPath, 'utf-8');
        const lineCount = content.split('\n').length;
        if (lineCount > maxFileLines) maxFileLines = lineCount;
        fileSizeKnown = true;
      } catch (err) {
        logger.debug('[integration-routing] non-critical error counting route file lines:', err.message || err);
      }
    }

    const canUseLocalForMod = fileSizeKnown && maxFileLines < modSafeLineLimit;
    if (isModificationTask && canUseLocalForMod && !override_provider) {
      // R103-R104: qwen2.5-coder:32b handles modifications safely on files <250 lines
      taskModel = 'qwen2.5-coder:32b';
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
      // P86: Route modifications to claude-cli when Codex unavailable.
      // R70 confirmed local LLMs (codestral:22b whole format) DESTROY existing
      // files during modification (4/6 methods deleted from Queue class).
      // claude-cli can handle modifications safely via diff-based patches.
      // P90: Verify claude-cli is actually available before routing to it.
      const claudeCliEnabled = serverConfig.getBool('claude_cli_enabled');
      if (claudeCliEnabled) {
        selectedProvider = 'claude-cli';
        taskModel = null; // claude-cli uses its own model
        logger.info(`[SmartRouting] P86: Modification task (Codex disabled) → claude-cli (safe fallback)`);
      } else {
        // P90/R95: Both Codex and claude-cli disabled. Use codestral:22b as least-bad option.
        // R93-R94: codestral handles modifications on small files (<30 lines).
        // R95: On larger files (85+ lines), codestral replaces unchanged method bodies with
        // stub comments ("// ... rest of the code remains unchanged ..."). P95 safeguard
        // now detects this pattern and triggers auto-retry/rejection.
        taskModel = 'codestral:22b';
        logger.warn(`[SmartRouting] P90/R95: Modification task (Codex+claude-cli disabled) → codestral:22b (RISK: stub destruction on large files)`);
      }
    } else if (!isModificationTask && codexEnabled && !override_provider && !codexExhausted) {
      // EXP1: Ollama CANNOT create new files — all greenfield tasks must go to Codex.
      // Experiment 1 showed 3/3 Ollama greenfield tasks silently fell back to Codex
      // or stalled. Route directly to avoid the fallback latency penalty (~2x slower).
      //
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
      const taskType = db.classifyTaskType(task);
      const taskLanguage = db.detectTaskLanguage(task, files || []);

      // Gather available models from healthy hosts
      const hosts = db.listOllamaHosts().filter(h => h.enabled && h.status !== 'down');
      const availableModels = [...new Set(
        hosts.flatMap(h => {
          try { return JSON.parse(h.models || '[]'); } catch { return []; }
        })
      )];

      if (availableModels.length > 0) {
        const ranked = db.selectBestModel(taskType, taskLanguage, complexity, availableModels, { estimatedTokens });
        if (ranked.length > 0) {
          taskModel = ranked[0].model;
          logger.info(`[SmartRouting] Smart selection: ${taskType}/${taskLanguage}/${complexity} → ${taskModel} (score=${ranked[0].score}, ${ranked[0].reason})`);
        } else {
          // All models filtered (e.g., context window too small) — fall back to tier
          const modelTier = db.getModelTierForComplexity(complexity);
          taskModel = modelTier.modelConfig;
          logger.info(`[SmartRouting] Smart selection filtered all models, falling back to tier: ${modelTier.tier} → ${taskModel}`);
        }
      } else {
        // No hosts available — fall back to tier-based selection
        const modelTier = db.getModelTierForComplexity(complexity);
        taskModel = modelTier.modelConfig;
        logger.info(`[SmartRouting] No healthy hosts with models, falling back to tier: ${modelTier.tier} → ${taskModel}`);
      }
    }

    // P71: Multi-host load distribution with smart model fallback
    // When the primary model's host is busy, try next-ranked models from
    // selectBestModel on less-loaded hosts. Falls back to legacy tier-based
    // fallback for non-smart-routed code paths (Codex overrides etc.).
    if (taskModel && !model) { // Only when auto-selected, not user-specified
      const hostCheck = db.selectOllamaHostForModel(taskModel);
      if (hostCheck.host && hostCheck.host.running_tasks > 0) {
        // P77: Skip fallback for async-heavy tasks
        const asyncPattern = /\b(async|await|Promise\b|\.then\(|\.catch\()\b/i;
        if (asyncPattern.test(task)) {
          logger.info(`[SmartRouting] P77: Async-heavy task detected, skipping fallback — queuing on primary host`);
        } else {
          // Try to find a less-loaded host with a capable model
          let foundFallback = false;

          // If we have a ranked list from smart selection, iterate it
          const taskType = db.classifyTaskType(task);
          const taskLanguage = db.detectTaskLanguage(task, files || []);
          const hosts = db.listOllamaHosts().filter(h => h.enabled && h.status !== 'down');
          const availableModels = [...new Set(
            hosts.flatMap(h => {
              try { return JSON.parse(h.models || '[]'); } catch { return []; }
            })
          )];

          if (availableModels.length > 1) {
            const ranked = db.selectBestModel(taskType, taskLanguage, complexity, availableModels, { estimatedTokens });
            for (const candidate of ranked) {
              if (candidate.model === taskModel) continue; // Skip current model
              const candidateHost = db.selectOllamaHostForModel(candidate.model);
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
              const fallbackHost = db.selectOllamaHostForModel(fallbackModel);
              if (fallbackHost.host && fallbackHost.host.running_tasks === 0) {
                logger.info(`[SmartRouting] P71 legacy fallback: ${taskModel} → ${fallbackModel} on '${fallbackHost.host.name}'`);
                taskModel = fallbackModel;
              }
            }
          }
        }
      }
    }
  }

  // Guard: redirect to codex when the selected provider is disabled in provider_config
  // Skip when user explicitly chose the provider — respect their decision
  const selectedProviderConfig = db.getProvider(selectedProvider);
  if (!override_provider && selectedProviderConfig && !selectedProviderConfig.enabled) {
    const sparkEnabled = serverConfig.isOptIn('codex_spark_enabled');
    const prevProvider = selectedProvider;
    selectedProvider = 'codex';
    if (sparkEnabled && (complexity === 'simple' || complexity === 'normal')) {
      taskModel = 'gpt-5.3-codex-spark';
    } else {
      taskModel = null;
    }
    modRoutingReason = `${prevProvider} disabled → Codex${taskModel ? ' Spark' : ''} (provider disabled)`;
    logger.info(`[SmartRouting] ${modRoutingReason}`);
  }

  // Guard: deprioritize unhealthy cloud providers (skip when user explicitly chose the provider)
  if (!override_provider && typeof db.isProviderHealthy === 'function' && !db.isProviderHealthy(selectedProvider)) {
    const chain = getFallbackProviderChain(selectedProvider);
    const healthyAlternatives = chain
      .map((providerName, idx) => ({ providerName, idx, score: getProviderHealthScore(providerName) }))
      .filter((candidate) => {
        if (!candidate.providerName || candidate.providerName === selectedProvider) {
          return false;
        }
        try {
          const providerConfig = db.getProvider(candidate.providerName);
          return providerConfig && providerConfig.enabled && db.isProviderHealthy(candidate.providerName);
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

  const schedulingMode = db.getConfig ? (db.getConfig('scheduling_mode') || 'legacy') : 'legacy';
  const useTierList = schedulingMode === 'slot-pull';
  const tierRoutingResult = useTierList
    ? db.analyzeTaskForRouting(task, workingDirectory, files, {
        tierList: true,
        isUserOverride: !!override_provider,
        overrideProvider: override_provider || null,
      })
    : null;
  const slotPullEligibleProviders = Array.isArray(tierRoutingResult?.eligible_providers) && tierRoutingResult.eligible_providers.length > 0
    ? tierRoutingResult.eligible_providers
    : [override_provider || selectedProvider].filter(Boolean);
  const slotPullCapabilityRequirements = Array.isArray(tierRoutingResult?.capability_requirements)
    ? tierRoutingResult.capability_requirements
    : [];
  const slotPullQualityTier = tierRoutingResult?.quality_tier
    || (complexity === 'complex' ? 'complex' : (complexity === 'simple' ? 'simple' : 'normal'));
  const slotPullMetadata = {
    smart_routing: true,
    eligible_providers: slotPullEligibleProviders,
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
    routing_mode: codexExhausted ? 'codex_exhausted' : (!db.hasHealthyOllamaHost() ? 'local_offline' : 'normal'),
    tuning_overrides: Object.keys(tuningOverrides).length > 0 ? tuningOverrides : null,
    _routing_chain: routingResult.chain && routingResult.chain.length > 1 ? routingResult.chain : undefined,
    _routing_template: routing_template || undefined,
    mcp_session_id: __sessionId || undefined,
  };

  if (useTierList) {
    db.createTask({
      id: taskId,
      task_description: task,
      working_directory: workingDirectory,
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
    db.createTask({
      id: taskId,
      task_description: task,
      working_directory: workingDirectory,
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
        routing_mode: codexExhausted ? 'codex_exhausted' : (!db.hasHealthyOllamaHost() ? 'local_offline' : 'normal'),
        tuning_overrides: Object.keys(tuningOverrides).length > 0 ? tuningOverrides : null,
        _routing_chain: routingResult.chain && routingResult.chain.length > 1 ? routingResult.chain : undefined,
        _routing_template: routing_template || undefined,
        mcp_session_id: __sessionId || undefined,
      })
    });
  }

  if (useTierList && !override_provider && typeof db.patchTaskSlotBinding === 'function') {
    try {
      db.patchTaskSlotBinding(taskId, slotPullMetadata);
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
        const taskRow = db.getTask(taskId);
        const existingMeta = (taskRow && typeof taskRow.metadata === 'object' && taskRow.metadata) ? { ...taskRow.metadata } : {};
        existingMeta.context_files = scanResult.contextFiles;
        existingMeta.context_scan_reasons = Object.fromEntries(scanResult.reasons);
        db.patchTaskMetadata(taskId, existingMeta);
        logger.info(`Context-stuffed ${scanResult.contextFiles.length} files for task ${taskId}`);
      }
    } catch (e) {
      logger.debug(`Context scan failed for task ${taskId}: ${e.message}`);
    }
  }

  // Start the task
  taskManager.processQueue();

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

  const result = db.analyzeTaskForRouting(task, null, safeFiles);

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
  const provider = db.getProvider(target_provider);
  if (!provider) {
    return makeError(ErrorCodes.INVALID_PARAM, `Unknown provider: ${target_provider}. Available: codex, claude-cli, ollama, aider-ollama`);
  }

  // Validate rule_type
  const validTypes = ['keyword', 'extension', 'regex'];
  if (rule_type && !validTypes.includes(rule_type)) {
    return makeError(ErrorCodes.INVALID_PARAM, `Invalid rule_type: ${rule_type}. Must be one of: ${validTypes.join(', ')}`);
  }

  const rule = db.createRoutingRule({
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
    const provider = db.getProvider(updates.target_provider);
    if (!provider) {
      return makeError(ErrorCodes.INVALID_PARAM, `Unknown provider: ${updates.target_provider}`);
    }
  }

  let rule;
  try {
    rule = db.updateRoutingRule(ruleId, updates);
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
    result = db.deleteRoutingRule(ruleId);
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


module.exports = {
  handleSmartSubmitTask,
  handleTestRouting,
  handleAddRoutingRule,
  handleUpdateRoutingRule,
  handleDeleteRoutingRule,
};
