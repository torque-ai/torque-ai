// server/handlers/diffusion-handlers.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const { ErrorCodes, makeError } = require('./error-codes');
const { validateDiffusionPlan, MAX_RECURSIVE_DEPTH } = require('../diffusion/plan-schema');
const { buildWorkflowTasks } = require('../diffusion/planner');
const { buildPrompt } = require('../orchestrator/prompt-templates');
const { isPathTraversalSafe } = require('./shared');
const logger = require('../logger').child({ component: 'diffusion-handlers' });

// Lazy-load to avoid circular deps
let _taskCore;
function taskCore() { return _taskCore || (_taskCore = require('../db/task-core')); }
let _workflowEngine;
function workflowEngine() { return _workflowEngine || (_workflowEngine = require('../db/workflow-engine')); }
let _taskManager;
function taskManager() { return _taskManager || (_taskManager = require('../task-manager')); }

const FILESYSTEM_PROVIDERS = new Set(['codex', 'codex-spark', 'claude-cli']);
const APPLY_CAPABLE_PROVIDERS = ['ollama', 'codex', 'claude-cli', 'ollama-cloud'];
const DEFAULT_SCOUT_TIMEOUT = 30;
const DEFAULT_SCOUT_PROVIDER = 'codex';

// Providers that can do compute (raw text completion, no filesystem needed).
// Ordered by preference: high concurrency + free/cheap first.
const COMPUTE_CAPABLE_PROVIDERS = [
  'cerebras',       // Free, fast, 3+ concurrent
  'groq',           // Free tier, fast, 128K context
  'ollama-cloud',   // Cloud Ollama endpoint, large context
  'deepinfra',      // Cheap, 50 concurrent, 128K
  'hyperbolic',     // Cheap, 20 concurrent, 128K
  'google-ai',      // Free tier, 800K+ context
  'openrouter',     // Gateway, varies
  'ollama',         // Local, free, but slow
];

function autoSelectComputeProvider() {
  try {
    const providerRoutingCore = require('../db/provider-routing-core');
    const allProviders = providerRoutingCore.listProviders();

    const enabledSet = new Set(
      allProviders
        .filter(p => p.enabled)
        .map(p => p.provider)
    );

    // Walk the preference list and pick the first enabled provider
    // that has API key configured (for cloud providers)
    for (const candidate of COMPUTE_CAPABLE_PROVIDERS) {
      if (!enabledSet.has(candidate)) continue;

      // Check API key availability for cloud providers
      const envVarMap = {
        cerebras: 'CEREBRAS_API_KEY',
        groq: 'GROQ_API_KEY',
        deepinfra: 'DEEPINFRA_API_KEY',
        hyperbolic: 'HYPERBOLIC_API_KEY',
        'google-ai': 'GOOGLE_AI_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        'ollama-cloud': 'OLLAMA_CLOUD_API_KEY',
      };

      const envVar = envVarMap[candidate];
      if (envVar && !process.env[envVar]) continue; // No API key, skip

      // ollama is always available (local)
      return candidate;
    }
  } catch (err) {
    logger.debug(`[Diffusion] Auto-select compute provider failed: ${err.message}`);
  }

  return null; // No compute provider available — fall back to single-stage
}

/**
 * Auto-select available apply providers (filesystem-capable).
 * Returns an array of enabled providers sorted by max_concurrent (highest first).
 * The close-handler hooks round-robin across these when creating apply tasks.
 */
function autoSelectApplyProviders() {
  try {
    const providerRoutingCore = require('../db/provider-routing-core');
    const allProviders = providerRoutingCore.listProviders();

    const enabledMap = new Map(
      allProviders
        .filter(p => p.enabled)
        .map(p => [p.provider, p])
    );

    const available = [];
    for (const candidate of APPLY_CAPABLE_PROVIDERS) {
      if (!enabledMap.has(candidate)) continue;
      const config = enabledMap.get(candidate);

      // Cloud providers need API keys
      const envVarMap = {
        'ollama-cloud': 'OLLAMA_CLOUD_API_KEY',
      };
      const envVar = envVarMap[candidate];
      if (envVar && !process.env[envVar]) continue;

      available.push({
        provider: candidate,
        maxConcurrent: config.max_concurrent || 1,
      });
    }

    // Sort by max_concurrent descending — spread load to highest-capacity first
    available.sort((a, b) => b.maxConcurrent - a.maxConcurrent);
    return available.map(a => a.provider);
  } catch (err) {
    logger.debug(`[Diffusion] Auto-select apply providers failed: ${err.message}`);
  }
  return ['ollama']; // Fallback
}

function handleSubmitScout(args) {
  const {
    scope,
    working_directory,
    file_patterns,
    provider,
    timeout_minutes,
    reason,
    project_id,
    project_path,
  } = args || {};

  if (!scope || typeof scope !== 'string' || !scope.trim()) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'scope is required');
  }
  if (!working_directory || typeof working_directory !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }
  if (!isPathTraversalSafe(working_directory)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'working_directory contains path traversal');
  }

  const selectedProvider = provider || DEFAULT_SCOUT_PROVIDER;
  if (!FILESYSTEM_PROVIDERS.has(selectedProvider)) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Provider "${selectedProvider}" does not have filesystem access. Scout tasks require codex or claude-cli.`
    );
  }

  // file_patterns are passed as hints in the prompt, not expanded server-side
  const fileList = Array.isArray(file_patterns) ? file_patterns.join(', ') : '(all files in scope)';

  const { system, user } = buildPrompt('scout', {
    scope: scope.trim(),
    working_directory,
    file_list: fileList,
  });

  const taskDescription = `${system}\n\n---\n\n${user}`;
  const taskId = uuidv4();
  const timeout = Math.min(timeout_minutes || DEFAULT_SCOUT_TIMEOUT, 60);

  taskCore().createTask({
    id: taskId,
    task_description: taskDescription,
    working_directory,
    status: 'queued',
    provider: selectedProvider,
    timeout_minutes: timeout,
    metadata: JSON.stringify({
      mode: 'scout',
      diffusion: true,
      reason: reason || null,
      project_id: project_id || null,
      project_path: project_path || working_directory,
      scope: scope.trim(),
      file_patterns: file_patterns || null,
    }),
  });

  // Start the task
  try {
    taskManager().startTask(taskId);
  } catch (err) {
    logger.warn(`[Diffusion] Failed to auto-start scout task ${taskId}: ${err.message}`);
  }

  return {
    content: [{
      type: 'text',
      text: `## Scout Task Submitted

| Field | Value |
|-------|-------|
| Task ID | \`${taskId}\` |
| Provider | ${selectedProvider} |
| Scope | ${scope.trim()} |
| Timeout | ${timeout} min |

Use \`await_task\` with task ID \`${taskId}\` to wait for the scout to complete.
Then pass the scout's output to \`create_diffusion_plan\` to fan out the work.`,
    }],
  };
}

function handleCreateDiffusionPlan(args) {
  const { plan, working_directory, batch_size, provider, convergence, depth, auto_run, verify_command, compute_provider, apply_provider } = args || {};

  if (!plan || typeof plan !== 'object') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'plan (diffusion plan JSON) is required');
  }
  if (!working_directory || typeof working_directory !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }
  if (!isPathTraversalSafe(working_directory)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'working_directory contains path traversal');
  }

  const currentDepth = depth || 0;
  if (currentDepth > MAX_RECURSIVE_DEPTH) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Recursive diffusion depth ${currentDepth} exceeds max of ${MAX_RECURSIVE_DEPTH}. Review the plan manually.`
    );
  }

  const validation = validateDiffusionPlan(plan);
  if (!validation.valid) {
    return makeError(ErrorCodes.INVALID_PARAM, `Invalid diffusion plan: ${validation.errors.join('; ')}`);
  }

  // Resolve verify_command: explicit param → project defaults → error
  let resolvedVerifyCommand = verify_command;
  if (!resolvedVerifyCommand) {
    try {
      const projectConfigCore = require('../db/project-config-core');
      const defaults = projectConfigCore.getProjectDefaults(working_directory);
      resolvedVerifyCommand = defaults?.verify_command;
    } catch (_e) {
      void _e;
    }
  }
  if (!resolvedVerifyCommand) {
    return makeError(
      ErrorCodes.MISSING_REQUIRED_PARAM,
      'Diffusion workflows require a verify_command (e.g., "dotnet build", "npx tsc --noEmit"). Set one via the parameter or via set_project_defaults.'
    );
  }

  // Auto-discover compute and apply providers if not explicitly set
  let resolvedComputeProvider = compute_provider || null;
  let resolvedApplyProviders = apply_provider ? [apply_provider] : null;
  if (!resolvedComputeProvider) {
    resolvedComputeProvider = autoSelectComputeProvider();
    if (resolvedComputeProvider) {
      logger.info(`[Diffusion] Auto-selected compute provider: ${resolvedComputeProvider}`);
    }
  }
  if (!resolvedApplyProviders) {
    resolvedApplyProviders = autoSelectApplyProviders();
    logger.info(`[Diffusion] Auto-selected apply providers: ${resolvedApplyProviders.join(', ')}`);
  }

  const workflowPlan = buildWorkflowTasks(plan, {
    batchSize: batch_size,
    workingDirectory: working_directory,
    provider,
    convergence,
    depth: currentDepth,
    verifyCommand: resolvedVerifyCommand,
    computeProvider: resolvedComputeProvider,
    applyProvider: resolvedApplyProviders[0] || 'ollama',
    applyProviders: resolvedApplyProviders,
  });

  // Create the TORQUE workflow — use `context` column for diffusion metadata
  // (workflows table has no `metadata` column; `context` is JSON TEXT)
  const workflowId = uuidv4();
  workflowEngine().createWorkflow({
    id: workflowId,
    name: `Diffusion — ${plan.summary.substring(0, 60)}`,
    working_directory,
    context: {
      diffusion: true,
      strategy: workflowPlan.strategy,
      depth: currentDepth,
      summary: plan.summary,
      exemplars: workflowPlan.exemplars,
      pattern_count: plan.patterns.length,
      manifest_count: plan.manifest.length,
      verify_command: resolvedVerifyCommand,
    },
  });

  // Create tasks + dependency edges following createSeededWorkflowTasks pattern
  // (see server/handlers/workflow/index.js:462-523)
  const nodeToTaskMap = {};
  for (const task of workflowPlan.tasks) {
    const taskId = uuidv4();
    nodeToTaskMap[task.id] = taskId;

    taskCore().createTask({
      id: taskId,
      status: task.depends_on.length > 0 ? 'blocked' : 'pending',
      task_description: task.description,
      working_directory: task.working_directory || working_directory,
      workflow_id: workflowId,
      workflow_node_id: task.id,
      provider: task.provider || provider || null,
      metadata: JSON.stringify(task.metadata),
    });
  }

  // Wire up dependency edges
  for (const task of workflowPlan.tasks) {
    if (task.depends_on.length === 0) continue;
    const taskId = nodeToTaskMap[task.id];
    for (const depNodeId of task.depends_on) {
      const depTaskId = nodeToTaskMap[depNodeId];
      if (depTaskId) {
        workflowEngine().addTaskDependency({
          workflow_id: workflowId,
          task_id: taskId,
          depends_on_task_id: depTaskId,
        });
      }
    }
  }

  workflowEngine().updateWorkflowCounts(workflowId);

  // Start the workflow
  const shouldRun = auto_run !== false;
  if (shouldRun) {
    try {
      workflowEngine().updateWorkflow(workflowId, {
        status: 'running',
        started_at: new Date().toISOString(),
      });
      // Start root tasks (no dependencies)
      for (const task of workflowPlan.tasks) {
        if (task.depends_on.length === 0) {
          const realTaskId = nodeToTaskMap[task.id];
          taskCore().updateTaskStatus(realTaskId, 'queued');
          try { taskManager().startTask(realTaskId); } catch (err) {
            logger.warn(`[Diffusion] Failed to start task ${realTaskId}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.warn(`[Diffusion] Failed to auto-start workflow ${workflowId}: ${err.message}`);
    }
  }

  const anchorCount = workflowPlan.tasks.filter(t => t.metadata.diffusion_role === 'anchor').length;
  const fanoutCount = workflowPlan.tasks.filter(t => t.metadata.diffusion_role === 'fanout').length;
  const computeCount = workflowPlan.tasks.filter(t => t.metadata.diffusion_role === 'compute').length;
  const isComputePipeline = computeCount > 0;

  return {
    content: [{
      type: 'text',
      text: `## Diffusion Workflow Created

| Field | Value |
|-------|-------|
| Workflow ID | \`${workflowId}\` |
| Strategy | ${workflowPlan.strategy} |
| Anchor tasks | ${anchorCount} |
| Fan-out tasks | ${fanoutCount} |
| Total tasks | ${workflowPlan.tasks.length} |
| Depth | ${currentDepth} |
| Auto-started | ${shouldRun} |${isComputePipeline ? `\n| Pipeline mode | compute→apply (compute: ${resolvedComputeProvider}, apply: ${resolvedApplyProviders.join(', ')}) |` : ''}

${workflowPlan.strategy === 'dag' ? '**DAG mode:** anchor tasks run first, fan-out tasks start after anchors complete.' : '**Optimistic parallel:** all tasks run simultaneously.'}

Use \`await_workflow\` with workflow ID \`${workflowId}\` to monitor progress.
After completion, verify with: \`${resolvedVerifyCommand}\`
Run \`detect_file_conflicts\` after completion to check for conflicts.`,
    }],
  };
}

function handleDiffusionStatus(args) {
  const { workflow_id } = args || {};

  let workflows = [];
  try {
    if (workflow_id) {
      const wf = workflowEngine().getWorkflow(workflow_id);
      if (wf) workflows = [wf];
    } else if (typeof workflowEngine().listWorkflows === 'function') {
      const all = workflowEngine().listWorkflows() || [];
      workflows = all.filter(wf => {
        // Diffusion metadata is in the `context` column (parsed by getWorkflow)
        const ctx = wf.context || {};
        return ctx.diffusion === true;
      });
    }
  } catch (err) {
    logger.debug(`[Diffusion] Error listing workflows: ${err.message}`);
  }

  if (workflows.length === 0) {
    return {
      content: [{ type: 'text', text: 'No active diffusion sessions found.' }],
    };
  }

  let output = '## Diffusion Sessions\n\n';
  for (const wf of workflows) {
    const ctx = wf.context || {};
    output += `### ${wf.name || wf.id}\n`;
    output += `| Field | Value |\n|-------|-------|\n`;
    output += `| ID | \`${wf.id}\` |\n`;
    output += `| Status | ${wf.status || 'unknown'} |\n`;
    output += `| Strategy | ${ctx.strategy || 'N/A'} |\n`;
    output += `| Depth | ${ctx.depth ?? 'N/A'} |\n`;
    output += `| Patterns | ${ctx.pattern_count ?? 'N/A'} |\n`;
    output += `| Manifest files | ${ctx.manifest_count ?? 'N/A'} |\n\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

module.exports = {
  handleSubmitScout,
  handleCreateDiffusionPlan,
  handleDiffusionStatus,
};
