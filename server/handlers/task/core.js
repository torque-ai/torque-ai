/* eslint-disable torque/no-sync-fs-on-hot-paths -- task/core sync calls are in file sync and working-dir detection at task submission time; Phase 2 async conversion tracked separately. */
/**
 * Task Core — Core lifecycle handlers
 * Extracted from task-handlers.js during decomposition.
 *
 * Handlers: handleSubmitTask, handleQueueTask, handleCheckStatus, handleGetResult,
 *           handleWaitForTask, handleListTasks, handleCancelTask, handleConfigure,
 *           handleGetProgress, handleShareContext, handleSyncFiles
 */

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const configCore = require('../../db/config-core');
const costTracking = require('../../db/cost-tracking');
const taskCore = require('../../db/task-core');
const hostManagement = require('../../db/host-management');
const projectConfigCore = require('../../db/project-config-core');
const providerRoutingCore = require('../../db/provider/routing-core');
const schedulingAutomation = require('../../db/scheduling-automation');
const { recordStudyTaskSubmitted } = require('../../db/study-telemetry');
const taskMetadata = require('../../db/task-metadata');
const webhooksStreaming = require('../../db/webhooks-streaming');
const serverConfig = require('../../config');
const taskManager = require('../../task-manager');
const {
  buildPeekArtifactReferencesFromTaskArtifacts,
} = require('../../contracts/peek');
const { safeLimit, MAX_BATCH_SIZE, MAX_TASK_LENGTH, ErrorCodes, makeError, isPathTraversalSafe, checkProviderAvailability, requireTask } = require('../shared');
const { formatTime, calculateDuration } = require('./utils');
const { summarizeTaskError } = require('../../utils/error-summary');
const { CONTEXT_STUFFING_PROVIDERS } = require('../../utils/context-stuffing');
const { resolveContextFiles } = require('../../utils/smart-scan');
const { buildTaskStudyContextEnvelope } = require('../../integrations/codebase-study-engine');
const { PROVIDER_DEFAULT_TIMEOUTS } = require('../../constants');
const { enforceVersionIntentForProject } = require('../../versioning/version-intent');
const logger = require('../../logger');

/**
 * Validate that an object does not exceed a maximum nesting depth.
 * Prevents stack-overflow DoS from deeply nested metadata payloads.
 */
function checkDepth(obj, max = 20, depth = 0) {
  if (depth > max) throw new Error('Metadata nesting exceeds maximum depth');
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) checkDepth(v, max, depth + 1);
  }
}

function getTaskInfoPressureLevel() {
  try {
    const info = typeof taskManager.getResourcePressureInfo === 'function'
      ? taskManager.getResourcePressureInfo()
      : null;
    return info && typeof info.level === 'string' ? info.level : 'unknown';
  } catch {
    return 'unknown';
  }
}

function rejectBlockedSubmission(policyResult) {
  if (!policyResult || policyResult.blocked !== true) {
    return null;
  }
  const message = policyResult.reason || policyResult.error || 'Task blocked by policy';
  return makeError(ErrorCodes.OPERATION_FAILED, message);
}

function isPromiseLike(value) {
  return Boolean(value) && typeof value.then === 'function';
}

function normalizeGovernanceEvaluationResult(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }

  if (!result.allPassed) {
    const blockedMessages = Array.isArray(result.blocked)
      ? result.blocked.map(entry => entry?.message).filter(Boolean)
      : [];
    return {
      error: makeError(
        ErrorCodes.OPERATION_FAILED,
        blockedMessages.length > 0 ? blockedMessages.join('\n') : 'Task blocked by governance'
      ),
      result,
    };
  }

  return { result };
}

function evaluateTaskSubmissionGovernance(task) {
  try {
    const { defaultContainer } = require('../../container');
    if (!defaultContainer || typeof defaultContainer.get !== 'function') {
      return null;
    }

    const governance = defaultContainer.get('governanceHooks');
    if (!governance || typeof governance.evaluate !== 'function') {
      return null;
    }

    const result = governance.evaluate('task_submit', task);
    if (isPromiseLike(result)) {
      return result
        .then(normalizeGovernanceEvaluationResult)
        .catch(() => null);
    }
    return normalizeGovernanceEvaluationResult(result);
  } catch (_e) {
    return null;
  }
}

function formatGovernanceWarnings(governanceResult) {
  const warnings = Array.isArray(governanceResult?.warned)
    ? governanceResult.warned.map(entry => entry?.message).filter(Boolean)
    : [];

  if (warnings.length === 0) {
    return '';
  }

  return `\n\nGovernance warning${warnings.length === 1 ? '' : 's'}:\n- ${warnings.join('\n- ')}`;
}

function resolveSafeSubmissionProvider(providerName) {
  const normalizedProvider = typeof providerName === 'string' ? providerName.trim() : '';
  try {
    const providerConfig = normalizedProvider ? providerRoutingCore.getProvider(normalizedProvider) : null;
    if (normalizedProvider && providerConfig && providerConfig.enabled) {
      return normalizedProvider;
    }
  } catch (err) {
    logger.debug(`[task-core] getProvider failed while resolving safe provider: ${err.message}`);
  }

  try {
    if (typeof providerRoutingCore.listProviders === 'function') {
      const fallbackProvider = providerRoutingCore
        .listProviders()
        .find((candidate) => candidate && candidate.enabled);
      const fallbackName = fallbackProvider ? (fallbackProvider.provider || fallbackProvider.name || null) : null;
      if (fallbackName) {
        logger.warn(`[TaskSubmission] Invalid provider resolved (${normalizedProvider || 'null'}) — falling back to ${fallbackName}`);
        return fallbackName;
      }
    }
  } catch (err) {
    logger.debug(`[task-core] listProviders failed while resolving safe provider: ${err.message}`);
  }

  return normalizedProvider;

}


function formatTaskStatus(task, progress) {
  let result = `## Task: ${task.id}\n\n`;
  result += `**Status:** ${task.status}\n`;
  result += `**Description:** ${task.task_description}\n`;
  result += `**Working Directory:** ${task.working_directory || '(default)'}\n`;
  result += `**Timeout:** ${task.timeout_minutes} minutes\n`;
  result += `**Auto-approve:** ${task.auto_approve ? 'Yes' : 'No'}\n`;
  result += `**Priority:** ${task.priority}\n`;
  result += `**Resource Pressure:** ${getTaskInfoPressureLevel()}\n`;
  if (task.provider) {
    result += `**Provider:** ${task.provider}\n`;
  }
  if (task.ollama_host_id) {
    let hostName = task.ollama_host_id;
    try {
      const wsModel = require('../../workstation/model');
      const ws = wsModel.getWorkstation(task.ollama_host_id);
      if (ws) {
        hostName = ws.name;
      }
    } catch {
      // Ignore workstation lookup errors and fall back to DB host resolution.
    }
    const host = hostManagement.getOllamaHost(task.ollama_host_id);
    if (host) {
      hostName = host.name;
      result += `**Ollama Host:** ${hostName} (\`${host.url}\`)\n`;
    } else {
      result += `**Ollama Host:** ${hostName}\n`;
    }
  }
  if (task.model) {
    result += `**Model:** ${task.model}\n`;
  }
  result += `**Created:** ${formatTime(task.created_at)}\n`;
  if (task.started_at) {
    result += `**Started:** ${formatTime(task.started_at)}\n`;
  }
  if (task.completed_at) {
    result += `**Completed:** ${formatTime(task.completed_at)}\n`;
    result += `**Duration:** ${calculateDuration(task.started_at, task.completed_at)}\n`;
  }
  if (progress) {
    result += `**Progress:** ${progress.progress}%\n`;
    if (progress.elapsedSeconds) {
      result += `**Elapsed:** ${progress.elapsedSeconds}s\n`;
    }
  }
  if (task.status === 'running') {
    const activity = taskManager.getTaskActivity(task.id, { skipGitCheck: true });
    if (activity) {
      if (activity.isStalled) {
        result += `**Activity:** \u26a0\ufe0f STALLED (no output for ${activity.lastActivitySeconds}s)\n`;
      } else if (activity.lastActivitySeconds > 30) {
        result += `**Activity:** Last output ${activity.lastActivitySeconds}s ago\n`;
      } else {
        result += `**Activity:** \u2713 Active (last output ${activity.lastActivitySeconds}s ago)\n`;
      }
    }
  }
  if (task.exit_code !== null) {
    result += `**Exit Code:** ${task.exit_code}\n`;
  }
  // For terminal failures, append a one-line "Why" so the operator
  // doesn't have to flip to get_result to see what went wrong.
  if (task.status === 'failed' || task.status === 'cancelled') {
    const summary = summarizeTaskError(task);
    if (summary && summary.summary) {
      result += `**Why:** ${summary.summary}\n`;
    }
  }
  return result;
}

function maybeAttachStudyContextMetadata(metadata, taskDescription, workingDirectory, files, enabled = true) {
  if (enabled === false || !workingDirectory) {
    return metadata;
  }

  try {
    const envelope = buildTaskStudyContextEnvelope({
      workingDirectory,
      taskDescription,
      files: Array.isArray(files) ? files : [],
    });
    if (envelope) {
      metadata.study_context = envelope.study_context;
      metadata.study_context_prompt = envelope.study_context_prompt;
      metadata.study_context_summary = envelope.study_context_summary;
    }
  } catch (err) {
    logger.debug(`[task-core] Study context build failed: ${err.message}`);
  }

  return metadata;
}

function buildTaskPeekArtifactSection(taskId) {
  if (!taskId || typeof taskMetadata.listArtifacts !== 'function') {
    return '';
  }

  try {
    const artifacts = taskMetadata.listArtifacts(taskId);
    const refs = buildPeekArtifactReferencesFromTaskArtifacts(artifacts, { task_id: taskId });
    if (refs.length === 0) {
      return '';
    }

    const artifactById = new Map(
      artifacts
        .filter((artifact) => artifact && typeof artifact.id === 'string')
        .map((artifact) => [artifact.id, artifact])
    );

    const lines = ['### Bundle Artifacts'];
    for (const ref of refs) {
      const label = ref.task_label ? `${ref.task_label}: ` : '';
      const details = [];
      if (ref.artifact_id) {
        details.push(`artifact ${ref.artifact_id.substring(0, 8)}`);
      }
      if (ref.contract?.name && ref.contract?.version != null) {
        details.push(`${ref.contract.name} v${ref.contract.version}`);
      }

      const artifact = ref.artifact_id ? artifactById.get(ref.artifact_id) : null;
      const signedMetadata = artifact?.metadata?.signed_metadata;
      const integrityValid = artifact?.metadata?.integrity?.valid;
      if (signedMetadata) {
        const integrityLabel = integrityValid === true ? 'valid' : integrityValid === false ? 'invalid' : 'unknown';
        details.push(
          `signed ${signedMetadata.algorithm}:${signedMetadata.checksum} by ${signedMetadata.signer} at ${signedMetadata.signed_at} (${integrityLabel})`
        );
      }

      const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
      lines.push(`- ${label}${ref.name || ref.kind || 'artifact'}: ${ref.path}${suffix}`);
    }

    return `\n${lines.join('\n')}\n`;
  } catch (err) {
    logger.debug('[task-core] non-critical error listing task artifacts:', err.message || err);
    return '';
  }
}


/**
 * Submit and immediately start a task
 */
function handleSubmitTask(args) {
  const project = typeof args?.project === 'string' && args.project.trim() ? args.project.trim() : 'unassigned';

  // Phase 3.2: auto_route dispatch — default true routes to smart_submit_task
  if (args.auto_route !== false && !args.provider) {
    // Lazy require to avoid circular dependency (integration requires task/core)
    const { handleSmartSubmitTask } = require('../integration/routing');
    return handleSmartSubmitTask({
      task: args.task,
      working_directory: args.working_directory,
      project,
      tags: args.tags,
      timeout_minutes: args.timeout_minutes,
      priority: args.priority,
      model: args.model,
      files: args.files,
      context_stuff: args.context_stuff,
      context_depth: args.context_depth,
      study_context: args.study_context,
      tuning: args.tuning,
      routing_template: args.routing_template,
      version_intent: args.version_intent,
      __sessionId: args.__sessionId,
    });
  }

  // Version intent enforcement for versioned projects
  const workDir = args.working_directory || null;
  if (workDir) {
    try {
      // DI container has the facade registered as 'db' since
      // database.js#init() / resetForTest() both call
      // registerFacadeWithContainer(). The facade exposes getDbInstance()
      // and lazy property getters (e.g., facade.prepare → underlying db),
      // so passing the facade itself is equivalent to passing
      // getDbInstance() for any consumer that calls db.prepare(...).
      const { defaultContainer } = require('../../container');
      const rawDb = defaultContainer.get('db');
      const versionIntentError = enforceVersionIntentForProject(
        rawDb,
        workDir,
        args.version_intent,
        makeError,
        ErrorCodes
      );
      if (versionIntentError) return versionIntentError;
    } catch (_e) { /* version-intent module unavailable — allow */ }
  }

  // Input validation
  if (!args.task || typeof args.task !== 'string' || args.task.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task must be a non-empty string');
  }
  if (args.task.length > MAX_TASK_LENGTH) {
    return makeError(ErrorCodes.INVALID_PARAM, `Task description exceeds maximum length (${args.task.length} > ${MAX_TASK_LENGTH} characters)`);
  }
  if (args.timeout_minutes !== undefined && args.timeout_minutes !== null &&
    (typeof args.timeout_minutes !== 'number' || args.timeout_minutes < 0)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'timeout_minutes must be zero or a positive number');
  }
  if (args.priority !== undefined && typeof args.priority !== 'number') {
    return makeError(ErrorCodes.INVALID_PARAM, 'priority must be a number');
  }

  const taskId = uuidv4();
  const defaultTimeout = serverConfig.getInt('default_timeout', 30);
  const defaultProvider = providerRoutingCore.getDefaultProvider();
  let providerName = args.provider || defaultProvider;

  // Validate provider if specified
  if (args.provider) {
    const providerConfig = providerRoutingCore.getProvider(args.provider);
    if (!providerConfig) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Unknown provider: ${args.provider}`);
    }
    if (!providerConfig.enabled) {
      return makeError(ErrorCodes.PROVIDER_ERROR, `Provider ${args.provider} is disabled`);
    }
  }

  // Provider availability gate — reject if no providers can serve (RB-031)
  const availCheck = checkProviderAvailability({ hasExplicitProvider: !!args.provider });
  if (availCheck) return availCheck.error;

  // Fix F3: Use per-provider timeout defaults when no explicit timeout given
  if (!args.provider) {
    providerName = resolveSafeSubmissionProvider(providerName);
  }
  const providerTimeout = PROVIDER_DEFAULT_TIMEOUTS[providerName] || defaultTimeout;
  const timeout = args.timeout_minutes ?? providerTimeout;
  const taskDescription = args.task.trim();
  const model = args.model || null;
  const schedulingMode = configCore.getConfig ? (configCore.getConfig('scheduling_mode') || 'legacy') : 'legacy';
  const useTierList = schedulingMode === 'slot-pull';
  const routingFiles = Array.isArray(args.files) ? args.files.filter(f => typeof f === 'string') : [];
  const tierResult = useTierList
    ? providerRoutingCore.analyzeTaskForRouting(taskDescription, args.working_directory || null, routingFiles, {
        tierList: true,
        isUserOverride: !!args.provider,
        overrideProvider: args.provider || null,
      })
    : null;
  const slotPullEligibleProviders = Array.isArray(args.eligible_providers) && args.eligible_providers.length > 0
    ? args.eligible_providers
    : (Array.isArray(tierResult?.eligible_providers) && tierResult.eligible_providers.length > 0
      ? tierResult.eligible_providers
      : [args.provider ? providerName : (tierResult?.provider || providerName)].filter(Boolean));
  const normalizedSlotPullEligibleProviders = slotPullEligibleProviders
    .filter((candidate, index, providers) => {
      if (typeof candidate !== 'string' || !candidate.trim()) {
        return false;
      }
      return providers.findIndex((provider) => provider === candidate) === index;
    })
    .map((candidate) => candidate.trim());
  const slotPullIntendedProvider = args.provider
    ? providerName
    : resolveSafeSubmissionProvider(normalizedSlotPullEligibleProviders[0] || providerName) || providerName;
  if (slotPullIntendedProvider && !normalizedSlotPullEligibleProviders.includes(slotPullIntendedProvider)) {
    normalizedSlotPullEligibleProviders.unshift(slotPullIntendedProvider);
  }
  const slotPullCapabilityRequirements = Array.isArray(tierResult?.capability_requirements)
    ? tierResult.capability_requirements
    : [];
  const slotPullQualityTier = tierResult?.quality_tier
    || ((tierResult?.complexity || 'normal') === 'complex'
      ? 'complex'
      : ((tierResult?.complexity || 'normal') === 'simple' ? 'simple' : 'normal'));
  const slotPullMetadata = {
    eligible_providers: normalizedSlotPullEligibleProviders,
    capability_requirements: slotPullCapabilityRequirements,
    quality_tier: slotPullQualityTier,
    user_provider_override: !!args.provider,
    intended_provider: slotPullIntendedProvider,
  };

  if (serverConfig.getBool('budget_check_enabled')) {
    const estimate = costTracking.estimateCost(taskDescription, model || providerName);
    const budgetCheck = costTracking.checkBudgetBeforeSubmission(providerName, estimate.estimated_cost_usd);
    if (!budgetCheck.allowed) {
      return makeError(
        ErrorCodes.BUDGET_EXCEEDED,
        `Budget would be exceeded for ${budgetCheck.budget}: $${budgetCheck.current.toFixed(2)}/$${budgetCheck.limit.toFixed(2)}`
      );
    }
  }

  // When the user explicitly specifies a provider, mark it so overflow won't reroute
  // Store intended_provider in metadata — provider field stays null until slot claim
  const metadata = useTierList
    ? slotPullMetadata
    : (args.provider
      ? { user_provider_override: true, intended_provider: providerName }
      : { intended_provider: providerName });
  if (args.routing_template) {
    metadata._routing_template = args.routing_template;
  }
  if (args.study_context !== undefined) {
    metadata.study_context_enabled = args.study_context !== false;
  }
  maybeAttachStudyContextMetadata(
    metadata,
    taskDescription,
    args.working_directory || null,
    Array.isArray(args.files) ? args.files.filter((file) => typeof file === 'string') : [],
    args.study_context !== false
  );

  // F9: Early model availability check — warn if requested model not found on any host
  if (args.model) {
    try {
      const hosts = hostManagement.listOllamaHosts ? hostManagement.listOllamaHosts() : [];
      const available = hosts.some(h => h.status !== 'down' && h.models_cache && h.models_cache.includes(args.model));
      if (!available && hosts.length > 0) {
        const availableModels = [...new Set(hosts.flatMap(h => (h.models_cache || '').split(',').map(m => m.trim()).filter(Boolean)))];
        metadata.model_warning = `Model '${args.model}' not found on any host. Available: ${availableModels.slice(0, 5).join(', ')}`;
      }
    } catch { /* ignore — hosts table may not exist */ }
  }
  const policyResult = typeof taskManager.evaluateTaskSubmissionPolicy === 'function'
    ? taskManager.evaluateTaskSubmissionPolicy({
        id: taskId,
        task_description: taskDescription,
        working_directory: args.working_directory || null,
        timeout_minutes: timeout,
        auto_approve: Boolean(args.auto_approve),
        priority: args.priority || 0,
        provider: providerName,
        model,
        metadata,
      })
    : null;
  const blockedError = rejectBlockedSubmission(policyResult);
  if (blockedError) {
    return blockedError;
  }
  const submissionTask = {
    id: taskId,
    task_description: taskDescription,
    working_directory: args.working_directory || null,
    timeout_minutes: timeout,
    auto_approve: Boolean(args.auto_approve),
    priority: args.priority || 0,
    provider: providerName,
    model,
    metadata,
  };

  const continueSubmitTask = (governanceEvaluation) => {
    if (governanceEvaluation?.error) {
      return governanceEvaluation.error;
    }

    // Store submitting agent session ID in metadata for coordination tracking
    if (args.__sessionId) {
      metadata.submitted_by_agent = args.__sessionId;
      metadata.mcp_session_id = args.__sessionId;
    }

    checkDepth(metadata);

    if (useTierList) {
      taskCore.createTask({
        id: taskId,
        status: 'pending',
        task_description: taskDescription,
        working_directory: args.working_directory || null,
        project,
        tags: args.tags || undefined,
        timeout_minutes: timeout,
        auto_approve: Boolean(args.auto_approve),
        priority: args.priority || 0,
        provider: args.provider ? providerName : null,
        model: model,  // null = use provider's default model
        metadata: JSON.stringify(metadata)
      });
    } else {
      taskCore.createTask({
        id: taskId,
        status: 'pending',
        task_description: taskDescription,
        working_directory: args.working_directory || null,
        project,
        tags: args.tags || undefined,
        timeout_minutes: timeout,
        auto_approve: Boolean(args.auto_approve),
        priority: args.priority || 0,
        provider: args.provider ? providerName : null,  // preserve user override; null = deferred assignment by tryClaimTaskSlot
        model: model,  // null = use provider's default model
        metadata: JSON.stringify(metadata)
      });
    }
    try {
      recordStudyTaskSubmitted(
        typeof taskCore.getTask === 'function'
          ? (taskCore.getTask(taskId) || {
              id: taskId,
              status: 'pending',
              working_directory: args.working_directory || null,
              project,
              provider: args.provider ? providerName : null,
              model,
              metadata,
            })
          : {
              id: taskId,
              status: 'pending',
              working_directory: args.working_directory || null,
              project,
              provider: args.provider ? providerName : null,
              model,
              metadata,
            }
      );
    } catch (_studyTelemetryErr) {
      // Non-blocking telemetry.
    }

    // Record coordination event
    try {
      const coord = require('../../db/coordination');
      coord.recordCoordinationEvent('task_submitted', args.__sessionId || null, taskId, null);
    } catch (_e) {
      // Non-fatal
    }

    // Check if approval is required for this task
    try {
      const task = taskCore.getTask(taskId);
      if (task && schedulingAutomation.checkApprovalRequired) {
        const approvalResult = schedulingAutomation.checkApprovalRequired(task);
        if (approvalResult && approvalResult.required) {
          // checkApprovalRequired already set approval_status='pending' and created the request
          try {
            const coord = require('../../db/coordination');
            const ruleId = approvalResult.rule ? approvalResult.rule.id : null;
            coord.recordCoordinationEvent('approval_requested', args.__sessionId || null, taskId,
              JSON.stringify({ rule_id: ruleId }));
          } catch (_e) { /* non-fatal */ }
        }
      }
    } catch (_e) {
      // Non-fatal — if approval check fails, task proceeds without gate
    }

    if (useTierList && !args.provider && typeof taskCore.patchTaskSlotBinding === 'function') {
      try {
        taskCore.patchTaskSlotBinding(taskId, slotPullMetadata);
      } catch (_err) {
        logger.debug(`[submit_task] Failed to persist slot-pull late binding for ${taskId}: ${_err.message}`);
      }
    }

    // Context-stuff: resolve files for context-stuffing-eligible providers (even on explicit provider path)
    if (CONTEXT_STUFFING_PROVIDERS.has(providerName) && args.context_stuff !== false) {
      try {
        const depth = args.context_depth || 1;
        // F6: Skip context stuffing when no working_directory is specified
        if (!args.working_directory) {
          logger.debug(`[submit_task] No working_directory specified for ${taskId} — skipping context stuffing`);
        }
        const contextWorkDir = args.working_directory || null;
        if (!contextWorkDir) {
          // No working directory — can't resolve context files; add warning to metadata
          // Parse metadata once and reuse; avoids a second taskCore.getTask call in the scan branch
          const taskRowCtx = taskCore.getTask(taskId);
          const existingMetaCtx = taskRowCtx?.metadata ? (typeof taskRowCtx.metadata === 'string' ? JSON.parse(taskRowCtx.metadata) : { ...taskRowCtx.metadata }) : {};
          existingMetaCtx.warning = 'No working directory specified — file context unavailable';
          taskCore.patchTaskMetadata(taskId, existingMetaCtx);
        }
        const scanResult = contextWorkDir ? resolveContextFiles({
          taskDescription,
          workingDirectory: contextWorkDir,
          files: Array.isArray(args.files) ? args.files.filter(f => typeof f === 'string') : [],
          contextDepth: depth,
        }) : null;
        if (scanResult && scanResult.contextFiles.length > 0) {
          // Fetch task once here (the !contextWorkDir branch above won't have run)
          const taskRowScan = taskCore.getTask(taskId);
          const existingMetaScan = taskRowScan?.metadata ? (typeof taskRowScan.metadata === 'string' ? JSON.parse(taskRowScan.metadata) : { ...taskRowScan.metadata }) : {};
          existingMetaScan.context_files = scanResult.contextFiles;
          existingMetaScan.context_scan_reasons = Object.fromEntries(scanResult.reasons);
          taskCore.patchTaskMetadata(taskId, existingMetaScan);
        }
      } catch (err) {
        logger.debug(`[submit_task] Context scan failed for ${taskId}: ${err.message}`);
      }
    }

    // Restart barrier check — if a system barrier task exists, queue instead of starting.
    // Must run synchronously BEFORE the async startTask call to prevent race conditions.
    let barrierActive = false;
    try {
      const barrierTasks = taskCore.listTasks({ status: 'running', limit: 50 })
        .concat(taskCore.listTasks({ status: 'queued', limit: 50 }))
        .filter(t => t.provider === 'system');
      if (barrierTasks.length > 0) {
        barrierActive = true;
        // Transition to 'queued' so the scheduler picks it up after restart.
        // Mark with restart_hold in error_output so TTL expiry skips it.
        taskCore.updateTaskStatus(taskId, 'queued', {
          error_output: `Restart barrier active (${barrierTasks[0].id.slice(0, 8)}). Will start after restart completes.`,
        });
        logger.info(`[submit_task] Restart barrier active (${barrierTasks[0].id.slice(0, 8)}) — task ${taskId.slice(0, 8)} queued, will start after restart`);
      }
    } catch { /* non-fatal — proceed to start */ }

    let result;
    if (!barrierActive) {
      result = taskManager.startTask(taskId);
    }

    // Auto-activate CI watch for this repo (fire-and-forget)
    if (args.working_directory) {
      try {
        const ciWatcher = require('../../ci/watcher');
        ciWatcher.autoActivateForRepo(args.working_directory);
      } catch (_e) { /* non-fatal */ }
    }

    if (result?.blocked) {
      return makeError(ErrorCodes.OPERATION_FAILED, result.reason || 'Task blocked by policy');
    }

    return {
      __subscribe_task_id: taskId,
      content: [{
        type: 'text',
        text: (barrierActive
          ? `Task queued (ID: ${taskId}, provider: ${providerName}). Restart barrier active — will start after restart completes.`
          : result?.queued
            ? `Task queued (ID: ${taskId}, intended provider: ${providerName}). Provider will be assigned when a slot is available.\nCurrent running tasks: ${taskManager.getRunningTaskCount()}`
            : `Task started (ID: ${taskId}, provider: ${providerName}). Use check_status or get_progress to monitor.`)
          + formatGovernanceWarnings(governanceEvaluation?.result)
      }]
    };
  };

  const governanceEvaluation = evaluateTaskSubmissionGovernance(submissionTask);
  if (isPromiseLike(governanceEvaluation)) {
    return governanceEvaluation.then(continueSubmitTask);
  }
  return continueSubmitTask(governanceEvaluation);
}


/**
 * Add task to queue (always queues first, then triggers queue processing asynchronously)
 */
function handleQueueTask(args) {
  // Input validation (matching handleSubmitTask)
  if (!args.task || typeof args.task !== 'string' || args.task.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task must be a non-empty string');
  }
  if (args.task.length > MAX_TASK_LENGTH) {
    return makeError(ErrorCodes.INVALID_PARAM, `Task description exceeds maximum length (${args.task.length} > ${MAX_TASK_LENGTH} characters)`);
  }
  if (args.timeout_minutes !== undefined && args.timeout_minutes !== null &&
    (typeof args.timeout_minutes !== 'number' || args.timeout_minutes < 0)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'timeout_minutes must be zero or a positive number');
  }
  if (args.priority !== undefined && typeof args.priority !== 'number') {
    return makeError(ErrorCodes.INVALID_PARAM, 'priority must be a number');
  }

  const taskId = uuidv4();
  const defaultTimeout = serverConfig.getInt('default_timeout', 30);
  const defaultProvider = providerRoutingCore.getDefaultProvider();
  let providerName = args.provider || defaultProvider;

  // Validate provider if specified
  if (args.provider) {
    const providerConfig = providerRoutingCore.getProvider(args.provider);
    if (!providerConfig) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Unknown provider: ${args.provider}`);
    }
    if (!providerConfig.enabled) {
      return makeError(ErrorCodes.PROVIDER_ERROR, `Provider ${args.provider} is disabled`);
    }
  }

  // Provider availability gate — reject if no providers can serve (RB-031)
  const availCheck2 = checkProviderAvailability({ hasExplicitProvider: !!args.provider });
  if (availCheck2) return availCheck2.error;

  // Fix F3: Use per-provider timeout defaults when no explicit timeout given
  if (!args.provider) {
    providerName = resolveSafeSubmissionProvider(providerName);
  }
  const providerTimeout = PROVIDER_DEFAULT_TIMEOUTS[providerName] || defaultTimeout;
  const timeout = args.timeout_minutes ?? providerTimeout;
  const taskDescription = args.task.trim();
  const model = args.model || null;

  if (serverConfig.getBool('budget_check_enabled')) {
    const estimate = costTracking.estimateCost(taskDescription, model || providerName);
    const budgetCheck = costTracking.checkBudgetBeforeSubmission(providerName, estimate.estimated_cost_usd);
    if (!budgetCheck.allowed) {
      return makeError(
        ErrorCodes.BUDGET_EXCEEDED,
        `Budget would be exceeded for ${budgetCheck.budget}: $${budgetCheck.current.toFixed(2)}/$${budgetCheck.limit.toFixed(2)}`
      );
    }
  }

  const metadata = args.provider
    ? { user_provider_override: true, intended_provider: providerName }
    : { intended_provider: providerName };
  if (args.study_context !== undefined) {
    metadata.study_context_enabled = args.study_context !== false;
  }
  maybeAttachStudyContextMetadata(
    metadata,
    taskDescription,
    args.working_directory || null,
    Array.isArray(args.files) ? args.files.filter((file) => typeof file === 'string') : [],
    args.study_context !== false
  );
  const policyResult = typeof taskManager.evaluateTaskSubmissionPolicy === 'function'
    ? taskManager.evaluateTaskSubmissionPolicy({
        id: taskId,
        task_description: taskDescription,
        working_directory: args.working_directory || null,
        timeout_minutes: timeout,
        auto_approve: Boolean(args.auto_approve),
        priority: args.priority || 0,
        provider: providerName,
        model,
        metadata,
      })
    : null;
  const blockedError = rejectBlockedSubmission(policyResult);
  if (blockedError) {
    return blockedError;
  }
  const queuedTask = {
    id: taskId,
    task_description: taskDescription,
    working_directory: args.working_directory || null,
    timeout_minutes: timeout,
    auto_approve: Boolean(args.auto_approve),
    priority: args.priority || 0,
    provider: providerName,
    model,
    metadata,
  };

  const continueQueueTask = (governanceEvaluation) => {
    if (governanceEvaluation?.error) {
      return governanceEvaluation.error;
    }

    checkDepth(metadata);

    taskCore.createTask({
      id: taskId,
      status: 'queued',
      task_description: taskDescription,
      working_directory: args.working_directory || null,
      timeout_minutes: timeout,
      auto_approve: Boolean(args.auto_approve),
      priority: args.priority || 0,
      provider: null,  // deferred assignment — set by tryClaimTaskSlot when slot is available
      model: model,
      metadata: JSON.stringify(metadata)
    });
    try {
      recordStudyTaskSubmitted(
        typeof taskCore.getTask === 'function'
          ? (taskCore.getTask(taskId) || {
              id: taskId,
              status: 'queued',
              working_directory: args.working_directory || null,
              provider: null,
              model,
              metadata,
            })
          : {
              id: taskId,
              status: 'queued',
              working_directory: args.working_directory || null,
              provider: null,
              model,
              metadata,
            }
      );
    } catch (_studyTelemetryErr) {
      // Non-blocking telemetry.
    }

    return {
      content: [{
        type: 'text',
        text: `Task queued (ID: ${taskId}, intended provider: ${providerName}). Provider will be assigned when a slot is available.`
          + formatGovernanceWarnings(governanceEvaluation?.result)
      }]
    };
  };

  const governanceEvaluation = evaluateTaskSubmissionGovernance(queuedTask);
  if (isPromiseLike(governanceEvaluation)) {
    return governanceEvaluation.then(continueQueueTask);
  }
  return continueQueueTask(governanceEvaluation);
}


/**
 * Check status of one or all tasks
 */
function handleCheckStatus(args) {
  const pressureLevel = getTaskInfoPressureLevel();

  if (args.task_id) {
    const { task, error: taskErr } = requireTask(args.task_id);
    if (taskErr) return taskErr;

    const progress = taskManager.getTaskProgress(args.task_id);

    return {
      pressureLevel,
      content: [{
        type: 'text',
        text: formatTaskStatus(task, progress)
      }],
      structuredData: {
        pressure_level: pressureLevel,
        task: {
          id: task.id,
          status: task.status,
          provider: task.provider || null,
          model: task.model || null,
          progress: progress?.progress || 0,
          exit_code: task.exit_code != null ? task.exit_code : null,
          elapsed_seconds: progress?.elapsedSeconds || null,
          description: (task.task_description || '').slice(0, 200),
          error_summary: (task.status === 'failed' || task.status === 'cancelled')
            ? (summarizeTaskError(task) || null)
            : null,
        },
      },
    };
  }

  // Summary of all tasks
  const running = taskCore.listTasks({ status: 'running' });
  const queued = taskCore.listTasks({ status: 'queued' });
  const recent = taskCore.listTasks({ limit: 5 });

  let summary = `## TORQUE Task Status\n\n`;
  summary += `**Resource Pressure:** ${pressureLevel}\n`;
  // TDA-14: Explicit gating visibility — tell callers when tasks are being deferred
  const gatingEnabled = configCore.getConfig ? configCore.getConfig('resource_gating_enabled') === '1' : false;
  if (gatingEnabled && (pressureLevel === 'high' || pressureLevel === 'critical')) {
    summary += `**Resource Gating:** Active — queued task starts deferred until pressure drops\n`;
  }
  summary += `**Running:** ${running.length}\n`;
  summary += `**Queued:** ${queued.length}\n\n`;

  const structuredRunning = [];
  if (running.length > 0) {
    summary += `### Running Tasks\n`;
    for (const task of running) {
      const progress = taskManager.getTaskProgress(task.id);
      const activity = taskManager.getTaskActivity(task.id, { skipGitCheck: true });
      const modelInfo = task.model ? ` [${task.model}]` : '';

      // Build activity indicator
      let activityInfo = '';
      if (activity) {
        if (activity.isStalled) {
          activityInfo = ` ⚠️ STALLED (no output ${activity.lastActivitySeconds}s)`;
        } else if (activity.lastActivitySeconds > 30) {
          activityInfo = ` (last output ${activity.lastActivitySeconds}s ago)`;
        } else {
          activityInfo = ` ✓`;
        }
      }

      summary += `- ${task.id.slice(0, 8)}...${modelInfo} (${progress?.progress || 0}%)${activityInfo} - ${(task.task_description || '').slice(0, 50)}...\n`;
      structuredRunning.push({
        id: task.id,
        status: task.status,
        provider: task.provider || null,
        model: task.model || null,
        progress: progress?.progress || 0,
        is_stalled: activity?.isStalled || false,
        last_activity_seconds: activity?.lastActivitySeconds || null,
        description: (task.task_description || '').slice(0, 200),
      });
    }
    summary += '\n';
  }

  if (queued.length > 0) {
    summary += `### Queued Tasks\n`;
    for (const task of queued) {
      const modelInfo = task.model ? ` [${task.model}]` : '';
      summary += `- ${task.id.slice(0, 8)}...${modelInfo} (priority: ${task.priority}) - ${(task.task_description || '').slice(0, 50)}...\n`;
    }
    summary += '\n';
  }

  const structuredQueued = queued.map(task => ({
    id: task.id,
    provider: task.provider || null,
    model: task.model || null,
    priority: task.priority || 0,
    description: (task.task_description || '').slice(0, 200),
  }));

  summary += `### Recent Tasks\n`;
  for (const task of recent) {
    const modelInfo = task.model ? ` [${task.model}]` : '';
    summary += `- ${task.id.slice(0, 8)}...${modelInfo} [${task.status}] - ${(task.task_description || '').slice(0, 50)}...\n`;
  }

  const structuredRecent = recent.map(task => ({
    id: task.id,
    status: task.status,
    model: task.model || null,
    description: (task.task_description || '').slice(0, 200),
  }));

  return {
    pressureLevel,
    content: [{ type: 'text', text: summary }],
    structuredData: {
      pressure_level: pressureLevel,
      running_count: running.length,
      queued_count: queued.length,
      running_tasks: structuredRunning,
      queued_tasks: structuredQueued,
      recent_tasks: structuredRecent,
    },
  };
}


/**
 * Get full result of a task
 */
function handleGetResult(args) {
  const { task, error: taskErr } = requireTask(args.task_id);
  if (taskErr) return taskErr;

  if (task.status === 'pending_approval') {
    return {
      content: [{
        type: 'text',
        text: 'Task is pending human approval. Approve or reject it before requesting a result.'
      }]
    };
  }

  if (
    task.status === 'running'
    || task.status === 'queued'
    || task.status === 'pending'
  ) {
    return {
      content: [{
        type: 'text',
        text: `Task is still ${task.status}. Use get_progress for running tasks, or wait for completion.`
      }]
    };
  }

  let result = `## Task Result: ${args.task_id}\n\n`;
  result += `**Status:** ${task.status}\n`;
  // Surface a one-line "Why it failed" summary at the top so operators
  // don't have to scroll through kilobytes of prompt-echoed stderr to
  // find the cause. The summarizer is a heuristic — if it produces
  // nothing useful, we silently skip it.
  const errorSummary = summarizeTaskError(task);
  if (errorSummary && errorSummary.summary) {
    result += `**Why:** ${errorSummary.summary}\n`;
  }
  if (task.provider) {
    result += `**Provider:** ${task.provider}\n`;
  }
  if (task.model) {
    result += `**Model:** ${task.model}\n`;
  }
  // Surface model overrides: show when the actual model differs from what was requested
  try {
    const metadata = typeof task.metadata === 'object' && task.metadata !== null ? task.metadata : task.metadata ? JSON.parse(task.metadata) : {};
    if (metadata.requested_model && task.model && metadata.requested_model !== task.model) {
      result += `**Requested Model:** ${metadata.requested_model} → overridden to ${task.model}\n`;
    }
  } catch (err) {
    logger.debug('[task-core] non-critical error parsing task metadata:', err.message || err);
  }
  result += `**Exit Code:** ${task.exit_code}\n`;
  result += `**Duration:** ${calculateDuration(task.started_at, task.completed_at)}\n`;

  // Show which host executed the task
  let hostName = null;
  if (task.ollama_host_id) {
    hostName = task.ollama_host_id;
    try {
      const wsModel = require('../../workstation/model');
      const ws = wsModel.getWorkstation(task.ollama_host_id);
      if (ws) {
        hostName = ws.name;
      }
    } catch {
      // Ignore workstation lookup errors and fall back to DB host resolution.
    }
    const host = hostManagement.getOllamaHost(task.ollama_host_id);
    if (host) {
      hostName = host.name;
      result += `**Host:** ${hostName} (\`${host.url}\`)\n`;
    } else {
      result += `**Host:** ${hostName}\n`;
    }
  }

  if (task.files_modified && task.files_modified.length > 0) {
    result += `**Files Modified:** ${task.files_modified.join(', ')}\n`;
  }

  const peekArtifactSection = buildTaskPeekArtifactSection(task.id);
  if (peekArtifactSection) {
    result += peekArtifactSection;
  }

  result += `\n### Output\n\`\`\`\n${task.output || '(no output)'}\n\`\`\`\n`;

  if (task.error_output) {
    result += `\n### Errors\n\`\`\`\n${task.error_output}\n\`\`\`\n`;
  }

  // Compute raw duration in seconds (calculateDuration returns formatted string)
  let durationSeconds = null;
  if (task.started_at && task.completed_at) {
    durationSeconds = Math.round((new Date(task.completed_at) - new Date(task.started_at)) / 1000);
  }

  // Parse files_modified if stored as JSON string
  let filesModified = task.files_modified || [];
  if (typeof filesModified === 'string') {
    try { filesModified = JSON.parse(filesModified); } catch { filesModified = []; }
  }
  if (!Array.isArray(filesModified)) filesModified = [];

  return {
    content: [{ type: 'text', text: result }],
    structuredData: {
      id: task.id,
      status: task.status,
      provider: task.provider || null,
      model: task.model || null,
      host_name: hostName,
      exit_code: task.exit_code != null ? task.exit_code : null,
      duration_seconds: durationSeconds,
      output: task.output || null,
      error_output: task.error_output || null,
      error_summary: errorSummary || null,
      files_modified: filesModified,
    },
  };
}


/**
 * Wait for a task to complete (blocks until done or timeout).
 * Polls the database at increasing intervals instead of requiring the caller to loop.
 */
async function handleWaitForTask(args) {
  try {
  
  const taskId = args.task_id;
  if (!taskId) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }
  

  const { task, error: taskErr } = requireTask(taskId);
  if (taskErr) return taskErr;

  const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'skipped'];
  const rawTimeout = Number(args.timeout_seconds);
  const timeoutMs = Math.min((rawTimeout > 0 ? rawTimeout : 300), 600) * 1000;
  const startTime = Date.now();

  // If already terminal, return immediately
  if (TERMINAL_STATUSES.includes(task.status)) {
    return handleGetResult({ task_id: taskId });
  }

  // Poll with increasing intervals: 1s, 2s, 3s, ... capped at 5s
  let pollInterval = 1000;
  const MAX_POLL = 5000;

  return new Promise((resolve) => {
    const check = () => {
      try {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeoutMs) {
          const current = taskCore.getTask(taskId);
          resolve({
            content: [{
              type: 'text',
              text: `## Timeout waiting for task ${taskId}\n\n` +
                `**Status:** ${current?.status || 'unknown'}\n` +
                `**Elapsed:** ${Math.round(elapsed / 1000)}s\n` +
                `**Progress:** ${current?.progress_percent || 0}%\n\n` +
                `Task is still ${current?.status || 'unknown'}. Use \`get_result\` or \`get_progress\` to check later.`
            }]
          });
          return;
        }

        const current = taskCore.getTask(taskId);
        if (!current) {
          resolve(makeError(ErrorCodes.TASK_NOT_FOUND, `Task ${taskId} was deleted while waiting.`));
          return;
        }

        if (TERMINAL_STATUSES.includes(current.status)) {
          // Task finished — return full result
          resolve(handleGetResult({ task_id: taskId }));
          return;
        }

        // Not done yet — schedule next poll
        pollInterval = Math.min(pollInterval + 1000, MAX_POLL);
        setTimeout(check, pollInterval);
      } catch (err) {
        resolve(makeError(ErrorCodes.OPERATION_FAILED, `Error while waiting for task: ${err.message}`));
      }
    };

    // Start first check after 1s
    setTimeout(check, pollInterval);
  });
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * List tasks with filtering
 */
function handleListTasks(args) {
  // Determine project filter
  let projectFilter = null;
  if (!args.all_projects) {
    // Use specified project or detect from current working directory
    projectFilter = args.project || projectConfigCore.getCurrentProject(process.cwd());
  }

  const tasks = taskCore.listTasks({
    status: args.status,
    tags: args.tags,
    project: projectFilter,
    project_id: args.project_id,
    limit: safeLimit(args.limit, 20),
    // Opt-in column projection — this handler only reads 9 summary fields. Without
    // projection, `SELECT *` pulls multi-MB error_output/output/context blobs off
    // disk (~35 MB total for the Kanban fan-out on a 3.7 GB tasks.db) just to
    // throw them away during serialization.
    columns: [
      'id', 'status', 'provider', 'model', 'priority',
      'task_description', 'created_at', 'tags', 'ollama_host_id',
    ],
  });

  if (tasks.length === 0) {
    let msg = 'No tasks found';
    if (args.status) msg = `No tasks with status: ${args.status}`;
    if (args.tags && Array.isArray(args.tags) && args.tags.length > 0) msg = `No tasks with tags: ${args.tags.join(', ')}`;
    if (projectFilter) msg += ` in project: ${projectFilter}`;
    if (!args.all_projects) msg += '\n\n*Tip: Use `all_projects: true` to see tasks from all projects.*';
    return {
      content: [{ type: 'text', text: msg }],
      structuredData: { count: 0, tasks: [] },
    };
  }

  let title = '## Tasks';
  const filters = [];
  if (projectFilter) filters.push(`project: ${projectFilter}`);
  if (args.all_projects) filters.push('all projects');
  if (args.status) filters.push(args.status);
  if (args.tags && Array.isArray(args.tags) && args.tags.length > 0) filters.push(`tags: ${args.tags.join(', ')}`);
  if (filters.length > 0) title += ` (${filters.join(', ')})`;

  let result = `${title}\n\n`;
  result += `| ID | Status | Model | Host | Description | Created |\n`;
  result += `|----|--------|-------|------|-------------|--------|\n`;

  for (const task of tasks) {
    // Get host name if available
    let hostName = '-';
    if (task.ollama_host_id) {
      const host = hostManagement.getOllamaHost(task.ollama_host_id);
      hostName = host ? host.name.slice(0, 10) : task.ollama_host_id.slice(0, 10);
    }
    // Get model name, truncate if needed
    const modelName = task.model ? task.model.slice(0, 15) : '-';
    result += `| ${task.id.slice(0, 8)}... | ${task.status} | ${modelName} | ${hostName} | ${(task.task_description || '').slice(0, 20)}... | ${formatTime(task.created_at)} |\n`;
  }

  return {
    content: [{ type: 'text', text: result }],
    structuredData: {
      count: tasks.length,
      tasks: tasks.map(task => ({
        id: task.id,
        status: task.status,
        provider: task.provider || null,
        model: task.model || null,
        priority: task.priority || 0,
        description: (task.task_description || '').slice(0, 200),
        created_at: task.created_at || null,
        tags: Array.isArray(task.tags) ? task.tags : [],
      })),
    },
  };
}


/**
 * Cancel a task.
 * Safety: For running/queued tasks, returns task details and requires confirm=true
 * to actually cancel. This prevents accidental cancellation of tasks owned by
 * other sessions.
 */
function handleCancelTask(args) {
  if (!args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  // Look up the task first to show what's about to be cancelled
  const { task, error: taskErr } = requireTask(args.task_id);
  if (taskErr) return taskErr;

  const force = Boolean(args.force);
  const abandon = Boolean(args.abandon);

  // For running, queued, or retry_scheduled tasks, require explicit confirm=true
  // This gives the caller a chance to see what they're cancelling
  if ((task.status === 'running' || task.status === 'queued' || task.status === 'retry_scheduled') && !args.confirm) {
    const desc = (task.description || '').substring(0, 300);
    const age = task.created_at ? Math.round((Date.now() - new Date(task.created_at).getTime()) / 60000) : '?';
    const project = task.project || 'unknown';
    const provider = task.provider || 'unknown';
    const modeNote = abandon
      ? '\n**Mode:** abandon — TORQUE will mark this task cancelled but leave the subprocess running.'
      : (force ? '\n**Mode:** force — immediate SIGKILL (no SIGTERM grace).' : '');
    return {
      content: [{ type: 'text', text:
        `## Cancel Safety Check\n\n` +
        `**Task:** ${args.task_id}\n` +
        `**Status:** ${task.status}\n` +
        `**Project:** ${project}\n` +
        `**Provider:** ${provider}\n` +
        `**Age:** ${age} minutes\n` +
        `**Description:** ${desc}${(task.description || '').length > 300 ? '...' : ''}${modeNote}\n\n` +
        `⚠️ **This task is ${task.status}. Cancellation is irreversible.**\n\n` +
        `To confirm, call again with \`confirm: true\`. ` +
        `To inspect further, use \`check_status\` or \`get_progress\`.`
      }]
    };
  }

  let success;
  try {
    success = taskManager.cancelTask(
      args.task_id,
      args.reason || 'Cancelled by user',
      { force, abandon },
    );
  } catch {
    // cancelTask throws when task not found by prefix match
    if (task) {
      return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Cannot cancel task ${args.task_id} - status is ${task.status}`);
    }
    return makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${args.task_id}`);
  }

  if (success) {
    const desc = (task.description || '').substring(0, 200);
    const modeSuffix = abandon
      ? ' (abandoned — subprocess left alive)'
      : (force ? ' (force — immediate kill)' : '');
    return {
      content: [{ type: 'text', text: `Task ${args.task_id} cancelled${modeSuffix}.\n\n**Was:** ${desc}` }]
    };
  }

  if (task) {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Cannot cancel task ${args.task_id} - status is ${task.status}`);
  }

  return makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${args.task_id}`);
}


/**
 * Get or set configuration
 */
function handleConfigure(args) {
  let changed = false;

  if (args.max_concurrent !== undefined) {
    const num = Number(args.max_concurrent);
    if (!Number.isFinite(num)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'max_concurrent must be a finite number');
    }
    const value = Math.max(1, Math.min(10, num));
    configCore.setConfig('max_concurrent', value);
    changed = true;
  }

  if (args.default_timeout !== undefined) {
    const num = Number(args.default_timeout);
    if (!Number.isFinite(num)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'default_timeout must be a finite number');
    }
    const value = Math.max(1, Math.min(120, num));
    configCore.setConfig('default_timeout', value);
    changed = true;
  }

  if (args.scheduling_mode !== undefined) {
    const mode = String(args.scheduling_mode).trim();
    if (!['legacy', 'slot-pull'].includes(mode)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'scheduling_mode must be "legacy" or "slot-pull"');
    }
    configCore.setConfig('scheduling_mode', mode);
    changed = true;
  }

  const config = configCore.getAllConfig();

  let result = `## Configuration\n\n`;
  result += `**Max Concurrent Tasks:** ${config.max_concurrent}\n`;
  result += `**Default Timeout:** ${config.default_timeout} minutes\n`;
  result += `**Scheduling Mode:** ${config.scheduling_mode || 'legacy'}\n`;
  result += `**Currently Running:** ${taskManager.getRunningTaskCount()}\n`;

  if (changed) {
    result += `\n*Configuration updated.*`;
    // Process queue in case we increased concurrency
    taskManager.processQueue();
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Get progress of a running task
 */
function handleGetProgress(args) {
  if (!args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const progress = taskManager.getTaskProgress(args.task_id);

  if (!progress) {
    return makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${args.task_id}`);
  }

  // Bound tail_lines to prevent memory issues with huge values
  const MAX_TAIL_LINES = 10000;
  const tailLines = Math.min(Math.max(1, parseInt(args.tail_lines, 10) || 50), MAX_TAIL_LINES);

  // Try stream chunks first for live output, fall back to DB output field
  let outputText = progress.output || '';
  if (progress.running && (!outputText || outputText.startsWith('[Streaming:'))) {
    try {
      const chunks = webhooksStreaming.getLatestStreamChunks(args.task_id, 0, 200);
      if (chunks.length > 0) {
        outputText = chunks.map(c => c.chunk_data).join('');
      }
    } catch (err) {
      // Fall back to progress.output
      logger.debug('[task-core] non-critical error parsing progress chunks:', err.message || err);
    }
  }

  const outputLines = outputText.split('\n');
  const tailOutput = outputLines.slice(-tailLines).join('\n');

  let result = `## Task Progress: ${(args.task_id || '').slice(0, 8)}...\n\n`;
  result += `**Status:** ${progress.running ? 'running' : 'finished'}\n`;
  result += `**Progress:** ${progress.progress}%\n`;

  if (progress.elapsedSeconds) {
    result += `**Elapsed:** ${progress.elapsedSeconds}s\n`;
  }

  result += `\n### Latest Output (last ${tailLines} lines)\n\`\`\`\n${tailOutput || '(no output yet)'}\n\`\`\`\n`;

  return {
    content: [{ type: 'text', text: result }],
    structuredData: {
      id: args.task_id,
      status: progress.running ? 'running' : 'finished',
      progress: progress.progress || 0,
      elapsed_seconds: progress.elapsedSeconds || null,
      output_tail: tailOutput || null,
    },
  };
}


/**
 * Share context with a task
 */
function handleShareContext(args) {
  // Input validation
  if (!args.task_id || typeof args.task_id !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id must be a non-empty string');
  }
  if (!args.content || typeof args.content !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'content must be a non-empty string');
  }

  const { task, error: taskErr } = requireTask(args.task_id);
  if (taskErr) return taskErr;

  // Sanitize context type - only allow alphanumeric, dash, underscore
  const rawContextType = args.context_type || 'custom';
  const contextType = rawContextType.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (contextType.length === 0 || contextType.length > 64) {
    return makeError(ErrorCodes.INVALID_PARAM, 'context_type must be 1-64 alphanumeric characters');
  }

  // F6: Require working_directory for context sharing — don't fall back to server cwd
  const workDir = task.working_directory;
  if (!workDir) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Task has no working_directory set — cannot share context. Specify working_directory when submitting the task.');
  }
  try {
    const workDirStats = fs.lstatSync(workDir);
    // Ensure it's a real directory, not a symlink (which could point anywhere)
    if (!workDirStats.isDirectory()) {
      return makeError(ErrorCodes.INVALID_PARAM, `Working directory is not a directory: ${workDir}`);
    }
    // Check if it's a symlink (lstat returns symlink info, not target info)
    if (workDirStats.isSymbolicLink()) {
      return makeError(ErrorCodes.INVALID_PARAM, `Working directory is a symlink: ${workDir}`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return makeError(ErrorCodes.INVALID_PARAM, `Working directory does not exist: ${workDir}`);
    }
    return makeError(ErrorCodes.INTERNAL_ERROR, `Failed to validate working directory: ${err.message || String(err)}`);
  }

  const contextDir = path.join(workDir, '.codex-context');

  // Create context directory if needed
  if (!fs.existsSync(contextDir)) {
    fs.mkdirSync(contextDir, { recursive: true });
  }

  const contextFile = path.join(contextDir, `${contextType}.md`);
  fs.writeFileSync(contextFile, args.content);

  // Update task context in database — re-read current state to avoid stale context overwrite
  const currentTask = taskCore.getTask(args.task_id);
  const currentStatus = currentTask ? currentTask.status : task.status;
  const freshContext = currentTask?.context;
  const existingContext = (typeof freshContext === 'object' && freshContext !== null) ? freshContext : {};
  existingContext[contextType] = contextFile;
  taskCore.updateTaskStatus(args.task_id, currentStatus, { context: existingContext });

  return {
    content: [{
      type: 'text',
      text: `Context shared. File created at: ${contextFile}\nCodex can reference this file during the task.`
    }]
  };
}


/**
 * Sync files between workspaces
 */
function handleSyncFiles(args) {
  // Input validation
  if (!args.task_id || typeof args.task_id !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id must be a non-empty string');
  }
  if (!args.files || !Array.isArray(args.files) || args.files.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'files must be a non-empty array');
  }
  if (args.files.length > MAX_BATCH_SIZE) {
    return makeError(ErrorCodes.INVALID_PARAM, `files array cannot exceed ${MAX_BATCH_SIZE} items`);
  }
  if (args.direction && !['push', 'pull'].includes(args.direction)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'direction must be "push" or "pull"');
  }

  const { task, error: taskErr2 } = requireTask(args.task_id);
  if (taskErr2) return taskErr2;

  // F6: Require working_directory for file sync — don't fall back to server cwd
  if (!task.working_directory) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Task has no working_directory set — cannot sync files. Specify working_directory when submitting the task.');
  }
  const taskDir = path.resolve(task.working_directory);
  const results = [];

  for (const file of args.files) {
    // Validate each file path is a string
    if (typeof file !== 'string' || file.trim().length === 0) {
      results.push(`✗ Invalid file path: ${file}`);
      continue;
    }
    if (!isPathTraversalSafe(file)) {
      results.push(`✗ Path traversal blocked: ${file}`);
      continue;
    }

    try {
      if (args.direction === 'push') {
        // Copy from Claude's workspace to task workspace
        // Use basename to prevent overwriting arbitrary paths
        const dest = path.join(taskDir, path.basename(file));
        if (!fs.existsSync(file)) {
          results.push(`✗ Source not found: ${file}`);
          continue;
        }
        fs.copyFileSync(file, dest);
        results.push(`✓ Pushed: ${file} → ${dest}`);
      } else {
        // Copy from task workspace to Claude's workspace
        // Normalize and validate path stays within taskDir
        const normalizedFile = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
        const src = path.resolve(taskDir, normalizedFile);

        // Security check: ensure resolved path is within taskDir (case-insensitive on Windows)
        const srcNorm = process.platform === 'win32' ? src.toLowerCase() : src;
        const basNorm = process.platform === 'win32' ? taskDir.toLowerCase() : taskDir;
        if (!srcNorm.startsWith(basNorm + path.sep) && srcNorm !== basNorm) {
          results.push(`✗ Path traversal blocked: ${file}`);
          continue;
        }

        if (fs.existsSync(src)) {
          // Just report the file exists - Claude can read it directly
          results.push(`✓ Available: ${src}`);
        } else {
          results.push(`✗ Not found: ${src}`);
        }
      }
    } catch (err) {
      results.push(`✗ Error with ${file}: ${err.message}`);
    }
  }

  return {
    content: [{
      type: 'text',
      text: `## File Sync Results\n\n${results.join('\n')}`
    }]
  };
}


// ── Unified task_info dispatcher (Phase 3.2) ──

function handleTaskInfo(args) {
  const mode = args.mode || 'status';
  let result;

  switch (mode) {
    case 'status':
      result = handleCheckStatus(args);
      break;
    case 'result':
      if (!args.task_id) {
        return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required for mode=result');
      }
      result = handleGetResult(args);
      break;
    case 'progress':
      if (!args.task_id) {
        return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required for mode=progress');
      }
      result = handleGetProgress(args);
      break;
    default:
      return makeError(ErrorCodes.INVALID_PARAM, `Unknown mode: ${mode}. Valid: status, result, progress`);
  }

  if (result && !result.isError && result.pressureLevel === undefined) {
    result.pressureLevel = getTaskInfoPressureLevel();
  }

  // Tag structuredData with mode for task_info superset schema
  if (result && result.structuredData && !result.isError) {
    result.structuredData.mode = mode;
  }

  return result;
}

function createTaskCoreHandlers(_deps) {
  return {
    handleSubmitTask,
    handleQueueTask,
    handleCheckStatus,
    handleGetResult,
    handleWaitForTask,
    handleListTasks,
    handleCancelTask,
    handleConfigure,
    handleGetProgress,
    handleShareContext,
    handleSyncFiles,
    handleTaskInfo,
    getTaskInfoPressureLevel,
  };
}

module.exports = {
  handleSubmitTask,
  handleQueueTask,
  handleCheckStatus,
  handleGetResult,
  handleWaitForTask,
  handleListTasks,
  handleCancelTask,
  handleConfigure,
  handleGetProgress,
  handleShareContext,
  handleSyncFiles,
  handleTaskInfo,
  getTaskInfoPressureLevel,  // exported for context-handler.js
  createTaskCoreHandlers,
};
