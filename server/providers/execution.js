/**
 * providers/execution.js — Provider execution aggregator
 *
 * Thin aggregator that delegates to sub-modules:
 * - execute-api.js      — executeApiProvider (API-based providers)
 * - execute-ollama.js   — executeOllamaTask, estimateRequiredContext (plain Ollama)
 * - execute-cli.js      — buildAiderOllamaCommand, buildClaudeCliCommand, buildCodexCommand, spawnAndTrackProcess
 *
 * Also hosts the agentic tool-calling pipeline that wraps Ollama and cloud API
 * providers with adapter-agnostic tool calling (Task 8 integration).
 *
 * Agentic tasks now run in isolated worker_threads via spawnAgenticWorker()
 * to prevent the agentic loop from starving the main-thread event loop
 * (4 HTTP servers + synchronous DB ops).
 *
 * Preserves the original init() DI interface — all dependencies are forwarded to sub-modules.
 */

'use strict';

const path = require('path');

const _executeApiModule = require('./execute-api');
const _executeOllamaModule = require('./execute-ollama');
const _executeCliModule = require('./execute-cli');

// Agentic pipeline components
const { runAgenticLoop } = require('./ollama-agentic');
const { isAgenticCapable, needsPromptInjection, init: initCapability } = require('./agentic-capability');
const { createToolExecutor, TOOL_DEFINITIONS, selectToolsForTask } = require('./ollama-tools');
const { captureSnapshot, checkAndRevert, revertScopedChanges } = require('./agentic-git-safety');
const { resolveOllamaModel } = require('./ollama-shared');

const { acquireHostLock } = require('./host-mutex');
const ollamaChatAdapter = require('./adapters/ollama-chat');
const openaiChatAdapter = require('./adapters/openai-chat');
const googleChatAdapter = require('./adapters/google-chat');

const logger = require('../logger').child({ component: 'execution-agentic' });

// ── Lazy reference to recordProviderOutcome from provider-routing-core ──
// Loaded in init() to avoid circular-require during startup.
let _recordProviderOutcome = null;

// ── Cloud provider base URL map (for OpenAI-compatible adapters) ───────
const PROVIDER_HOST_MAP = {
  anthropic: 'https://api.anthropic.com',
  groq: 'https://api.groq.com/openai',
  cerebras: 'https://api.cerebras.ai',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  openrouter: 'https://openrouter.ai/api',
  hyperbolic: 'https://api.hyperbolic.xyz/v1',
  'ollama-cloud': 'https://api.ollama.com',
  'google-ai': 'https://generativelanguage.googleapis.com',
};

// Default models per provider
const PROVIDER_DEFAULT_MODEL = {
  groq: null,
  cerebras: null,
  deepinfra: null,
  openrouter: null,
  hyperbolic: null,
  'ollama-cloud': null,
  'google-ai': 'gemini-2.5-flash-lite',
};

// ── Deps captured at init time for the agentic wrapper ────────────────
let _agenticDeps = null;

/**
 * Initialize all sub-modules with dependencies from task-manager.js.
 * Accepts the same deps object as the original monolithic init().
 */
function init(deps) {
  // Capture deps for the agentic wrapper
  // Issue #6 fix: include apiAbortControllers so _agenticDeps.apiAbortControllers is defined.
  // Without this, cancelTask() cannot abort in-flight agentic API requests — it falls back to
  // _executeApiModule._apiAbortControllers, but that only works if the module ref is live.
  _agenticDeps = {
    db: deps.db,
    dashboard: deps.dashboard,
    runningProcesses: deps.runningProcesses,
    safeUpdateTaskStatus: deps.safeUpdateTaskStatus,
    processQueue: deps.processQueue,
    handleWorkflowTermination: deps.handleWorkflowTermination,
    apiAbortControllers: deps.apiAbortControllers,
  };

  // Import recordProviderOutcome from provider-routing-core if available
  try {
    const routingCore = require('../db/provider-routing-core');
    _recordProviderOutcome = routingCore.recordProviderOutcome;
  } catch { /* module may not be ready */ }

  // Initialize capability detection with DB + serverConfig
  initCapability({ db: deps.db, serverConfig: require('../config') });

  // execute-api.js needs: db, dashboard, apiAbortControllers, processQueue, handleWorkflowTermination
  _executeApiModule.init({
    db: deps.db,
    dashboard: deps.dashboard,
    apiAbortControllers: deps.apiAbortControllers,
    processQueue: deps.processQueue,
    recordTaskStartedAuditEvent: deps.recordTaskStartedAuditEvent,
    handleWorkflowTermination: deps.handleWorkflowTermination,
  });

  // execute-ollama.js needs: db, dashboard, safeUpdateTaskStatus, tryReserveHostSlotWithFallback,
  //   tryOllamaCloudFallback, isLargeModelBlockedOnHost, buildFileContext, processQueue
  _executeOllamaModule.init({
    db: deps.db,
    dashboard: deps.dashboard,
    safeUpdateTaskStatus: deps.safeUpdateTaskStatus,
    recordTaskStartedAuditEvent: deps.recordTaskStartedAuditEvent,
    tryReserveHostSlotWithFallback: deps.tryReserveHostSlotWithFallback,
    tryOllamaCloudFallback: deps.tryOllamaCloudFallback,
    isLargeModelBlockedOnHost: deps.isLargeModelBlockedOnHost,
    buildFileContext: deps.buildFileContext,
    processQueue: deps.processQueue,
  });

   // execute-cli.js needs: db, dashboard, runningProcesses, safeUpdateTaskStatus,
   //   tryReserveHostSlotWithFallback, markTaskCleanedUp, tryOllamaCloudFallback,
   //   tryLocalFirstFallback, attemptFuzzySearchRepair, tryHashlineTieredFallback,
   //   shellEscape, processQueue, isLargeModelBlockedOnHost, helpers, NVM_NODE_PATH,
   //   QUEUE_LOCK_HOLDER_ID, MAX_OUTPUT_BUFFER, pendingRetryTimeouts, taskCleanupGuard,
   //   finalizeTask,
   //   stallRecoveryAttempts
  _executeCliModule.init({
    db: deps.db,
    dashboard: deps.dashboard,
    runningProcesses: deps.runningProcesses,
    safeUpdateTaskStatus: deps.safeUpdateTaskStatus,
    tryReserveHostSlotWithFallback: deps.tryReserveHostSlotWithFallback,
    markTaskCleanedUp: deps.markTaskCleanedUp,
    tryOllamaCloudFallback: deps.tryOllamaCloudFallback,
    tryLocalFirstFallback: deps.tryLocalFirstFallback,
    attemptFuzzySearchRepair: deps.attemptFuzzySearchRepair,
    tryHashlineTieredFallback: deps.tryHashlineTieredFallback,
    shellEscape: deps.shellEscape,
    processQueue: deps.processQueue,
    isLargeModelBlockedOnHost: deps.isLargeModelBlockedOnHost,
    helpers: deps.helpers,
    NVM_NODE_PATH: deps.NVM_NODE_PATH,
    QUEUE_LOCK_HOLDER_ID: deps.QUEUE_LOCK_HOLDER_ID,
    MAX_OUTPUT_BUFFER: deps.MAX_OUTPUT_BUFFER,
    pendingRetryTimeouts: deps.pendingRetryTimeouts,
    taskCleanupGuard: deps.taskCleanupGuard,
    finalizeTask: deps.finalizeTask,
    stallRecoveryAttempts: deps.stallRecoveryAttempts,
  });
}

// ============================================================
// Agentic pipeline helpers
// ============================================================

/**
 * Select the appropriate chat adapter for a provider.
 * Returns null for providers that don't support the agentic pipeline.
 *
 * @param {string} provider
 * @returns {{ chatCompletion: Function }|null}
 */
function selectAdapter(provider) {
  // Ollama-format APIs (NDJSON streaming, /api/chat)
  if (provider === 'ollama' || provider === 'ollama-cloud') return ollamaChatAdapter;
  // Google Gemini API
  if (provider === 'google-ai') return googleChatAdapter;
  // OpenAI-compatible APIs (JSON or SSE, /v1/chat/completions)
  if (['groq', 'cerebras', 'deepinfra', 'openrouter', 'hyperbolic'].includes(provider)) {
    return openaiChatAdapter;
  }
  return null;
}

/**
 * Resolve API key for a cloud provider.
 * Checks DB config first, then environment variables.
 *
 * @param {string} provider
 * @returns {string|null}
 */
function resolveApiKey(provider) {
  // Delegate to config.js getApiKey which handles:
  // 1. Environment variables (highest priority)
  // 2. Encrypted keys in provider_config.api_key_encrypted
  // 3. Legacy DB config table
  const serverConfig = require('../config');
  return serverConfig.getApiKey(provider);
}

/**
 * Build the platform-aware agentic system prompt.
 *
 * @param {string} basePrompt - Model-specific system prompt from config
 * @param {string} workingDir
 * @returns {string}
 */
function buildAgenticSystemPrompt(basePrompt, workingDir) {
  const platformRule = process.platform === 'win32'
    ? '8. This is a WINDOWS environment. NEVER use Unix commands (ls, find, wc, grep, cat, tail, head, sed, awk, chmod). Use PowerShell instead: dir/Get-ChildItem, Select-String, Get-Content, Select-Object. For simple tasks, prefer using the provided tools (list_directory, search_files, read_file) over run_command — they work on all platforms.'
    : '8. This is a Linux/macOS environment. Use bash commands.';

  return basePrompt + `

You are an autonomous coding agent with tool access. Complete the task using ONLY the provided tools.

RULES:
1. Use tools to read files, make edits, list directories, search code, and run commands.
2. NEVER describe what you would do — actually do it with tools.
3. ONLY modify files explicitly mentioned in the task. Do NOT touch unrelated files.
4. If a build/test fails for reasons UNRELATED to your change, report the failure and stop. Do NOT try to fix pre-existing issues.
5. If a tool call fails, try ONE alternative approach. If that also fails, report the error and stop.
6. LARGE FILES: For files over ~300 lines, use read_file with start_line/end_line to read ONLY the section you need (e.g., read_file({path, start_line: 150, end_line: 200})). Then use replace_lines to edit by line number. NEVER read an entire large file — it wastes context and slows inference. Use search_files first to find the right line numbers if needed.
7. EDIT FAILURES: If edit_file fails with "old_text not found", the file may have been modified by a prior edit. Re-read the file with read_file to see the current content, then retry. For large files, switch to replace_lines instead.
8. When done, respond with a COMPLETE summary that includes the actual data from tool results. Do NOT just say "I called list_directory" — include the actual file/folder names, counts, and content you found.
9. Be efficient — you have limited iterations. Do ONLY what the task asks. If the task says "list directory", just call list_directory once and report. Do NOT write files, run commands, or do extra work unless explicitly asked.
${platformRule}
11. INDENTATION: When editing code, match the file's existing indentation EXACTLY. Read the file first to see its indent style (spaces/tabs and width). Your new_text must use the same indentation as the surrounding code.
12. SEARCH: Use search_files and list_directory for finding files and content. NEVER use find, grep, or rg via run_command — they are slow and may timeout on large projects.

Working directory: ${workingDir}`;
}

function normalizeTaskMetadata(task) {
  if (!task?.metadata) return {};
  if (typeof task.metadata === 'string') {
    try {
      return JSON.parse(task.metadata);
    } catch {
      return {};
    }
  }
  return (task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata))
    ? task.metadata
    : {};
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergeUniqueStrings(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const entry of group || []) {
      const normalized = entry.replace(/\\/g, '/').toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(entry);
    }
  }
  return merged;
}

function collectMarkdownBullets(markdown, headings) {
  const targetHeadings = new Set(headings.map((heading) => heading.toLowerCase()));
  const lines = String(markdown || '').split(/\r?\n/);
  const bullets = [];
  let inTargetSection = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const headingMatch = /^##\s+(.+?)\s*$/.exec(trimmed);
    if (headingMatch) {
      const heading = headingMatch[1].trim().toLowerCase();
      if (inTargetSection && !targetHeadings.has(heading)) break;
      inTargetSection = targetHeadings.has(heading);
      continue;
    }
    if (!inTargetSection) continue;
    const bulletMatch = /^\s*[-*]\s+`?(.+?)`?\s*$/.exec(rawLine);
    if (bulletMatch) bullets.push(bulletMatch[1].trim());
  }

  return bullets;
}

function collectMarkdownSectionLines(markdown, headings) {
  const targetHeadings = new Set(headings.map((heading) => heading.toLowerCase()));
  const lines = String(markdown || '').split(/\r?\n/);
  const sectionLines = [];
  let inTargetSection = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const headingMatch = /^##\s+(.+?)\s*$/.exec(trimmed);
    if (headingMatch) {
      const heading = headingMatch[1].trim().toLowerCase();
      if (inTargetSection && !targetHeadings.has(heading)) break;
      inTargetSection = targetHeadings.has(heading);
      continue;
    }
    if (!inTargetSection) continue;
    sectionLines.push(rawLine);
  }

  return sectionLines;
}

function stripWrappingBackticks(value) {
  const trimmed = String(value || '').trim();
  const backtickMatch = /^`([^`]+)`$/.exec(trimmed);
  return backtickMatch ? backtickMatch[1].trim() : trimmed;
}

function collectMarkdownSectionText(markdown, headings) {
  return collectMarkdownSectionLines(markdown, headings)
    .map((line) => stripWrappingBackticks(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

function collectJsonSpecList(spec, keys) {
  for (const key of keys) {
    const value = spec?.[key];
    if (Array.isArray(value)) {
      return value
        .map((entry) => typeof entry === 'string' ? entry.trim() : '')
        .filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }
  }
  return [];
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNextTaskMarkdownSpec(markdown) {
  return {
    goal: collectMarkdownSectionText(markdown, ['Goal']),
    why_now: collectMarkdownSectionText(markdown, ['Why Now']),
    read_files: collectMarkdownBullets(markdown, ['Read Files', 'Read Paths']),
    specific_actions: collectMarkdownBullets(markdown, ['Specific Actions']),
    allowed_files: collectMarkdownBullets(markdown, ['Allowed Files', 'Allowed Paths', 'Write Files', 'Write Paths']),
    allowed_tools: collectMarkdownBullets(markdown, ['Allowed Tools', 'Tool Allowlist']),
    required_modified_paths: collectMarkdownBullets(markdown, ['Required Modified Paths', 'Required Modified Files']),
    verification_command: collectMarkdownSectionText(markdown, ['Verification Command']),
    actionless_iteration_limit: collectMarkdownSectionText(markdown, ['Actionless Iteration Limit']),
    stop_conditions: collectMarkdownBullets(markdown, ['Stop Conditions']),
  };
}

function normalizeComparableString(value) {
  return stripWrappingBackticks(String(value || ''))
    .replace(/`/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => stripWrappingBackticks(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function normalizeComparableList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeComparableString(entry))
    .filter(Boolean);
}

function compareNextTaskSpecs(markdownSpec, jsonSpec) {
  const fieldComparisons = [
    ['goal', normalizeComparableString(markdownSpec.goal), normalizeComparableString(jsonSpec.goal)],
    ['why_now', normalizeComparableString(markdownSpec.why_now), normalizeComparableString(jsonSpec.why_now)],
    ['read_files', normalizeComparableList(markdownSpec.read_files), normalizeComparableList(collectJsonSpecList(jsonSpec, ['read_files', 'readFiles', 'read_paths', 'readPaths']))],
    ['specific_actions', normalizeComparableList(markdownSpec.specific_actions), normalizeComparableList(collectJsonSpecList(jsonSpec, ['specific_actions', 'specificActions']))],
    ['allowed_files', normalizeComparableList(markdownSpec.allowed_files), normalizeComparableList(collectJsonSpecList(jsonSpec, ['allowed_files', 'allowedFiles', 'write_files', 'writeFiles', 'allowed_paths', 'allowedPaths', 'write_paths', 'writePaths']))],
    ['allowed_tools', normalizeComparableList(markdownSpec.allowed_tools), normalizeComparableList(collectJsonSpecList(jsonSpec, ['allowed_tools', 'allowedTools', 'tool_allowlist', 'toolAllowlist']))],
    ['required_modified_paths', normalizeComparableList(markdownSpec.required_modified_paths), normalizeComparableList(collectJsonSpecList(jsonSpec, ['required_modified_paths', 'requiredModifiedPaths']))],
    ['verification_command', normalizeComparableString(markdownSpec.verification_command), normalizeComparableString(jsonSpec.verification_command ?? jsonSpec.verificationCommand)],
    ['actionless_iteration_limit', normalizeComparableString(markdownSpec.actionless_iteration_limit), normalizeComparableString(jsonSpec.actionless_iteration_limit ?? jsonSpec.actionlessIterationLimit)],
    ['stop_conditions', normalizeComparableList(markdownSpec.stop_conditions), normalizeComparableList(collectJsonSpecList(jsonSpec, ['stop_conditions', 'stopConditions']))],
  ];

  const mismatchedFields = fieldComparisons
    .filter(([, markdownValue, jsonValue]) => JSON.stringify(markdownValue) !== JSON.stringify(jsonValue))
    .map(([fieldName]) => fieldName);

  return {
    synced: mismatchedFields.length === 0,
    comparedFields: fieldComparisons.map(([fieldName]) => fieldName),
    mismatchedFields,
  };
}

function extractNextTaskPathPolicy(nextTaskPath, nextTaskJsonPath, workingDir) {
  const fs = require('fs');
  const baseReadPaths = mergeUniqueStrings(
    nextTaskJsonPath ? [nextTaskJsonPath] : [],
    nextTaskPath ? [nextTaskPath] : [],
  );

  if (nextTaskJsonPath) {
    const resolvedNextTaskJsonPath = path.resolve(workingDir, nextTaskJsonPath);
    if (fs.existsSync(resolvedNextTaskJsonPath)) {
      try {
        const spec = JSON.parse(fs.readFileSync(resolvedNextTaskJsonPath, 'utf-8'));
        const readPaths = collectJsonSpecList(spec, ['read_files', 'readFiles', 'read_paths', 'readPaths']);
        const writePaths = collectJsonSpecList(spec, [
          'allowed_files',
          'allowedFiles',
          'write_files',
          'writeFiles',
          'allowed_paths',
          'allowedPaths',
          'write_paths',
          'writePaths',
        ]);
        return {
          readPaths: mergeUniqueStrings(baseReadPaths, readPaths, writePaths),
          writePaths,
        };
      } catch {
        // Fall back to the markdown task spec if the JSON file is missing or invalid.
      }
    }
  }

  if (!nextTaskPath) {
    return { readPaths: baseReadPaths, writePaths: [] };
  }

  const resolvedNextTaskPath = path.resolve(workingDir, nextTaskPath);
  if (!fs.existsSync(resolvedNextTaskPath)) {
    return { readPaths: baseReadPaths, writePaths: [] };
  }
  const markdown = fs.readFileSync(resolvedNextTaskPath, 'utf-8');
  const readPaths = collectMarkdownBullets(markdown, ['Read Files', 'Read Paths']);
  const writePaths = collectMarkdownBullets(markdown, ['Allowed Files', 'Allowed Paths', 'Write Files', 'Write Paths']);

  return {
    readPaths: mergeUniqueStrings(baseReadPaths, readPaths, writePaths),
    writePaths,
  };
}

function buildTaskAgenticPolicy(task, workingDir, serverConfig) {
  const metadata = buildEffectiveAgenticMetadata(task, workingDir);
  const constraintsFromNextTask = coerceOptionalBoolean(metadata.agentic_constraints_from_next_task, false);
  let readAllowlist = normalizeStringList(metadata.agentic_allowed_read_paths);
  let writeAllowlist = normalizeStringList(metadata.agentic_allowed_write_paths);
  const writeAfterReadPaths = normalizeStringList(
    metadata.agentic_write_after_read_paths ?? metadata.agentic_initial_read_paths
  );
  let toolAllowlist = normalizeStringList(
    metadata.agentic_allowed_tools ?? metadata.allowed_tools ?? metadata.agentic_tool_allowlist ?? metadata.tool_allowlist
  );
  const taskSpec = constraintsFromNextTask ? loadTaskSpecFromMetadata(metadata, workingDir) : null;

  if (constraintsFromNextTask) {
    const nextTaskPath = (typeof metadata.agentic_next_task_path === 'string' && metadata.agentic_next_task_path.trim())
      ? metadata.agentic_next_task_path.trim()
      : 'docs/autodev/NEXT_TASK.md';
    const nextTaskJsonPath = (typeof metadata.agentic_next_task_json_path === 'string' && metadata.agentic_next_task_json_path.trim())
      ? metadata.agentic_next_task_json_path.trim()
      : (nextTaskPath.endsWith('.md') ? `${nextTaskPath.slice(0, -3)}.json` : '');
    const nextTaskPolicy = extractNextTaskPathPolicy(nextTaskPath, nextTaskJsonPath, workingDir);
    readAllowlist = mergeUniqueStrings(readAllowlist, nextTaskPolicy.readPaths);
    writeAllowlist = mergeUniqueStrings(writeAllowlist, nextTaskPolicy.writePaths);
  }

  if (toolAllowlist.length === 0) {
    if (taskSpec?.spec) {
      toolAllowlist = taskSpec.source === 'json'
        ? collectJsonSpecList(taskSpec.spec, ['allowed_tools', 'allowedTools', 'tool_allowlist', 'toolAllowlist'])
        : normalizeStringList(taskSpec.spec.allowed_tools);
    }
  }

  const metadataCommandAllowlist = normalizeStringList(
    metadata.agentic_allowed_commands ?? metadata.agentic_command_allowlist
  );
  let commandMode = typeof metadata.agentic_command_mode === 'string'
    ? metadata.agentic_command_mode
    : (serverConfig.get('agentic_command_mode') || 'unrestricted');
  let commandAllowlist = metadataCommandAllowlist.length > 0 || Array.isArray(metadata.agentic_allowed_commands)
    ? metadataCommandAllowlist
    : (serverConfig.get('agentic_command_allowlist') || '').split(',').filter(Boolean);
  if (Array.isArray(metadata.agentic_allowed_commands)) {
    commandMode = 'allowlist';
  }

  const specMaxIterations = (() => {
    if (!taskSpec?.spec) return null;
    return taskSpec.source === 'json'
      ? parsePositiveInteger(taskSpec.spec.max_iterations ?? taskSpec.spec.maxIterations)
      : parsePositiveInteger(taskSpec.spec.max_iterations);
  })();
  const parsedMaxIterations = parsePositiveInteger(
    metadata.agentic_max_iterations
      ?? metadata.max_iterations
      ?? specMaxIterations
  );
  const specActionlessLimit = (() => {
    if (!taskSpec?.spec) return null;
    return taskSpec.source === 'json'
      ? parsePositiveInteger(taskSpec.spec.actionless_iteration_limit ?? taskSpec.spec.actionlessIterationLimit)
      : parsePositiveInteger(taskSpec.spec.actionless_iteration_limit);
  })();
  const actionlessIterationLimit = parsePositiveInteger(
    metadata.agentic_actionless_iteration_limit
      ?? metadata.actionless_iteration_limit
      ?? specActionlessLimit
  );
  const diagnosticReadLimitAfterFailedCommand = parsePositiveInteger(
    metadata.agentic_diagnostic_read_limit_after_failed_command
      ?? metadata.agentic_read_budget_after_failed_command
  );

  return {
    metadata,
    readAllowlist,
    writeAllowlist,
    writeAfterReadPaths,
    toolAllowlist,
    commandMode,
    commandAllowlist,
    actionlessIterationLimit,
    diagnosticReadLimitAfterFailedCommand,
    maxIterations: parsedMaxIterations,
  };
}

function resolveAutodevSessionLogPath(metadata, nextTaskPath) {
  const explicitPath = typeof metadata?.agentic_session_log_path === 'string' && metadata.agentic_session_log_path.trim()
    ? metadata.agentic_session_log_path.trim()
    : null;
  if (explicitPath) return explicitPath;

  const normalizedNextTaskPath = typeof nextTaskPath === 'string' && nextTaskPath.trim()
    ? nextTaskPath.trim().replace(/\\/g, '/')
    : null;
  if (!normalizedNextTaskPath) return null;

  const nextTaskDir = path.posix.dirname(normalizedNextTaskPath);
  return nextTaskDir && nextTaskDir !== '.'
    ? `${nextTaskDir}/SESSION_LOG.md`
    : 'SESSION_LOG.md';
}

function maybeShortCircuitPlanningTask(task, workingDir, agenticPolicy) {
  const fs = require('fs');
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  if (!metadata.agentic_noop_when_task_spec_synced) return null;
  if (resolveRequiredModifiedPaths(task, workingDir, agenticPolicy).length > 0) return null;

  const nextTaskPath = (typeof metadata.agentic_next_task_path === 'string' && metadata.agentic_next_task_path.trim())
    ? metadata.agentic_next_task_path.trim()
    : 'docs/autodev/NEXT_TASK.md';
  const nextTaskJsonPath = (typeof metadata.agentic_next_task_json_path === 'string' && metadata.agentic_next_task_json_path.trim())
    ? metadata.agentic_next_task_json_path.trim()
    : (nextTaskPath.endsWith('.md') ? `${nextTaskPath.slice(0, -3)}.json` : '');
  if (!nextTaskJsonPath) return null;

  const resolvedMarkdownPath = path.resolve(workingDir, nextTaskPath);
  const resolvedJsonPath = path.resolve(workingDir, nextTaskJsonPath);
  if (!fs.existsSync(resolvedMarkdownPath) || !fs.existsSync(resolvedJsonPath)) return null;

  try {
    const markdown = fs.readFileSync(resolvedMarkdownPath, 'utf-8');
    const jsonSpec = JSON.parse(fs.readFileSync(resolvedJsonPath, 'utf-8'));
    const comparison = compareNextTaskSpecs(parseNextTaskMarkdownSpec(markdown), jsonSpec);
    if (!comparison.synced) return null;

    const sessionLogPath = resolveAutodevSessionLogPath(metadata, nextTaskPath);
    if (sessionLogPath) {
      const resolvedSessionLogPath = path.resolve(workingDir, sessionLogPath);
      if (fs.existsSync(resolvedSessionLogPath)) {
        const sessionLogMtime = fs.statSync(resolvedSessionLogPath).mtimeMs;
        const latestSpecMtime = Math.max(
          fs.statSync(resolvedMarkdownPath).mtimeMs,
          fs.statSync(resolvedJsonPath).mtimeMs,
        );
        if (Number.isFinite(sessionLogMtime) && sessionLogMtime > latestSpecMtime) {
          return null;
        }
      }
    }

    return {
      output: `Planning short-circuit: ${nextTaskPath} already matches ${nextTaskJsonPath}. No planning changes required.`,
      taskMetadata: {
        agentic_noop_planning: true,
        agentic_noop_reason: 'task_spec_synced',
        compared_fields: comparison.comparedFields,
        next_task_path: nextTaskPath,
        next_task_json_path: nextTaskJsonPath,
      },
    };
  } catch {
    return null;
  }
}

function coerceOptionalBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return defaultValue;
}

function resolveNextTaskSpecPaths(metadata) {
  const nextTaskPath = (typeof metadata?.agentic_next_task_path === 'string' && metadata.agentic_next_task_path.trim())
    ? metadata.agentic_next_task_path.trim()
    : 'docs/autodev/NEXT_TASK.md';
  const nextTaskJsonPath = (typeof metadata?.agentic_next_task_json_path === 'string' && metadata.agentic_next_task_json_path.trim())
    ? metadata.agentic_next_task_json_path.trim()
    : (nextTaskPath.endsWith('.md') ? `${nextTaskPath.slice(0, -3)}.json` : '');
  return { nextTaskPath, nextTaskJsonPath };
}

function loadTaskSpecFromMetadata(metadata, workingDir) {
  const fs = require('fs');
  const { nextTaskPath, nextTaskJsonPath } = resolveNextTaskSpecPaths(metadata);

  if (nextTaskJsonPath) {
    const resolvedJsonPath = path.resolve(workingDir, nextTaskJsonPath);
    if (fs.existsSync(resolvedJsonPath)) {
      try {
        return {
          source: 'json',
          path: nextTaskJsonPath,
          spec: JSON.parse(fs.readFileSync(resolvedJsonPath, 'utf-8')),
        };
      } catch {
        // Fall through to markdown when the JSON spec is invalid.
      }
    }
  }

  if (nextTaskPath) {
    const resolvedMarkdownPath = path.resolve(workingDir, nextTaskPath);
    if (fs.existsSync(resolvedMarkdownPath)) {
      return {
        source: 'markdown',
        path: nextTaskPath,
        spec: parseNextTaskMarkdownSpec(fs.readFileSync(resolvedMarkdownPath, 'utf-8')),
      };
    }
  }

  return null;
}

function buildEffectiveAgenticMetadata(task, workingDir) {
  const metadata = normalizeTaskMetadata(task);
  const effectiveMetadata = { ...metadata };
  if (!coerceOptionalBoolean(metadata.agentic_constraints_from_next_task, false)) {
    return effectiveMetadata;
  }

  const { nextTaskPath, nextTaskJsonPath } = resolveNextTaskSpecPaths(metadata);
  const nextTaskPolicy = extractNextTaskPathPolicy(nextTaskPath, nextTaskJsonPath, workingDir);
  const taskSpec = loadTaskSpecFromMetadata(metadata, workingDir);

  const readAllowlist = mergeUniqueStrings(
    normalizeStringList(metadata.agentic_allowed_read_paths),
    nextTaskPolicy.readPaths,
  );
  const writeAllowlist = mergeUniqueStrings(
    normalizeStringList(metadata.agentic_allowed_write_paths),
    nextTaskPolicy.writePaths,
  );
  if (readAllowlist.length > 0 || Array.isArray(metadata.agentic_allowed_read_paths)) {
    effectiveMetadata.agentic_allowed_read_paths = readAllowlist;
  }
  if (writeAllowlist.length > 0 || Array.isArray(metadata.agentic_allowed_write_paths)) {
    effectiveMetadata.agentic_allowed_write_paths = writeAllowlist;
  }

  const explicitToolAllowlist = normalizeStringList(
    metadata.agentic_allowed_tools ?? metadata.allowed_tools ?? metadata.agentic_tool_allowlist ?? metadata.tool_allowlist
  );
  const specToolAllowlist = !taskSpec?.spec
    ? []
    : (taskSpec.source === 'json'
      ? collectJsonSpecList(taskSpec.spec, ['allowed_tools', 'allowedTools', 'tool_allowlist', 'toolAllowlist'])
      : normalizeStringList(taskSpec.spec.allowed_tools));
  if (explicitToolAllowlist.length > 0) {
    effectiveMetadata.agentic_allowed_tools = explicitToolAllowlist;
  } else if (specToolAllowlist.length > 0) {
    effectiveMetadata.agentic_allowed_tools = specToolAllowlist;
  }

  const explicitRequiredPaths = normalizeStringList(
    metadata.agentic_required_modified_paths ?? metadata.required_modified_paths
  );
  const specRequiredPaths = !taskSpec?.spec
    ? []
    : (taskSpec.source === 'json'
      ? collectJsonSpecList(taskSpec.spec, ['required_modified_paths', 'requiredModifiedPaths'])
      : normalizeStringList(taskSpec.spec.required_modified_paths));
  if (
    explicitRequiredPaths.length > 0
    || specRequiredPaths.length > 0
    || Array.isArray(metadata.agentic_required_modified_paths)
  ) {
    effectiveMetadata.agentic_required_modified_paths = mergeUniqueStrings(explicitRequiredPaths, specRequiredPaths);
  }

  const explicitVerificationCommand = typeof metadata.agentic_verification_command === 'string'
    ? metadata.agentic_verification_command
    : metadata.verification_command;
  const specVerificationCommand = !taskSpec?.spec
    ? ''
    : (taskSpec.source === 'json'
      ? (taskSpec.spec.verification_command ?? taskSpec.spec.verificationCommand ?? '')
      : (taskSpec.spec.verification_command || ''));
  const verificationCommand = stripWrappingBackticks(explicitVerificationCommand || specVerificationCommand || '');
  if (verificationCommand) {
    effectiveMetadata.agentic_verification_command = verificationCommand;
  }

  const explicitCommandAllowlist = normalizeStringList(
    metadata.agentic_allowed_commands ?? metadata.agentic_command_allowlist
  );
  if (explicitCommandAllowlist.length > 0 || Array.isArray(metadata.agentic_allowed_commands)) {
    effectiveMetadata.agentic_allowed_commands = explicitCommandAllowlist;
    effectiveMetadata.agentic_command_mode = 'allowlist';
  } else if (verificationCommand) {
    // Constrained NEXT_TASK executors should not get arbitrary shell access.
    effectiveMetadata.agentic_allowed_commands = [verificationCommand];
    effectiveMetadata.agentic_command_mode = 'allowlist';
  }

  const explicitActionlessLimit = parsePositiveInteger(
    metadata.agentic_actionless_iteration_limit ?? metadata.actionless_iteration_limit
  );
  const specActionlessLimit = !taskSpec?.spec
    ? null
    : (taskSpec.source === 'json'
      ? parsePositiveInteger(taskSpec.spec.actionless_iteration_limit ?? taskSpec.spec.actionlessIterationLimit)
      : parsePositiveInteger(taskSpec.spec.actionless_iteration_limit));
  if (explicitActionlessLimit) {
    effectiveMetadata.agentic_actionless_iteration_limit = explicitActionlessLimit;
  } else if (specActionlessLimit) {
    effectiveMetadata.agentic_actionless_iteration_limit = specActionlessLimit;
  }

  return effectiveMetadata;
}

function maybePersistEffectiveAgenticMetadata(task, db, workingDir) {
  const originalMetadata = normalizeTaskMetadata(task);
  const effectiveMetadata = buildEffectiveAgenticMetadata(task, workingDir);
  task.metadata = effectiveMetadata;

  if (!db || typeof db.updateTask !== 'function' || !task?.id) {
    return effectiveMetadata;
  }
  if (JSON.stringify(originalMetadata) === JSON.stringify(effectiveMetadata)) {
    return effectiveMetadata;
  }

  try {
    db.updateTask(task.id, { metadata: effectiveMetadata });
  } catch (err) {
    logger.info(`[Agentic] Failed to persist synced metadata for task ${task.id}: ${err.message}`);
  }

  return effectiveMetadata;
}

function normalizeChangedFileList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergeChangedFiles(...groups) {
  return mergeUniqueStrings(...groups.map((group) => normalizeChangedFileList(group)));
}

function toRelativeDisplayPath(filePath, workingDir) {
  if (typeof filePath !== 'string' || !filePath.trim()) return '';
  const absolutePath = path.resolve(workingDir, filePath);
  const relativePath = path.relative(workingDir, absolutePath);
  return (relativePath && !relativePath.startsWith('..'))
    ? relativePath.replace(/\\/g, '/')
    : absolutePath.replace(/\\/g, '/');
}

function resolveAgenticSessionLogTarget(task, workingDir, agenticPolicy) {
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  const writeAllowlist = normalizeStringList(agenticPolicy?.writeAllowlist);
  const explicitPath = typeof metadata.agentic_session_log_path === 'string' && metadata.agentic_session_log_path.trim()
    ? metadata.agentic_session_log_path.trim()
    : null;
  const normalizedExplicitPath = explicitPath ? explicitPath.replace(/\\/g, '/').toLowerCase() : null;

  let relativePath = null;
  if (normalizedExplicitPath && writeAllowlist.some((entry) => entry.replace(/\\/g, '/').toLowerCase() === normalizedExplicitPath)) {
    relativePath = explicitPath;
  }
  if (!relativePath) {
    relativePath = writeAllowlist.find((entry) => /(^|\/)session_log\.md$/i.test(entry.replace(/\\/g, '/'))) || null;
  }
  if (!relativePath) return null;

  return {
    relativePath,
    absolutePath: path.resolve(workingDir, relativePath),
  };
}

function summarizeVerificationStatus(verificationCommand, toolLog) {
  if (!verificationCommand) {
    return 'not required';
  }
  const verificationResult = inspectVerificationToolLog(toolLog, verificationCommand);
  if (!verificationResult) {
    return 'passed';
  }
  if (verificationResult.status === 'missing') {
    return 'not run';
  }
  return 'failed';
}

function appendAgenticOutputSection(result, title, message) {
  if (!result || typeof result !== 'object' || !title || !message) return;
  const prefix = typeof result.output === 'string' && result.output.length > 0 ? `${result.output}\n\n` : '';
  result.output = `${prefix}--- ${title} ---\n${message}`;
}

function maybeAppendAgenticSessionLog(task, workingDir, agenticPolicy, result, summary, sessionLogTarget = null) {
  const target = sessionLogTarget || resolveAgenticSessionLogTarget(task, workingDir, agenticPolicy);
  if (!target) return null;

  const fs = require('fs');
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  const taskSpec = loadTaskSpecFromMetadata(metadata, workingDir);
  const goal = stripWrappingBackticks(taskSpec?.spec?.goal || '') || stripWrappingBackticks(task.task_description || '');
  const verificationCommand = summary?.verificationCommand || resolveTaskVerificationCommand(task, workingDir, agenticPolicy);
  const verificationStatus = summarizeVerificationStatus(verificationCommand, result?.toolLog);
  const changedFiles = mergeChangedFiles(result?.changedFiles).filter((entry) => normalizeComparablePath(entry, workingDir) !== normalizeComparablePath(target.absolutePath, workingDir));
  const changedFilesSummary = changedFiles.length > 0
    ? changedFiles.map((entry) => toRelativeDisplayPath(entry, workingDir)).join(', ')
    : 'none';
  const status = summary?.status === 'failed' ? 'failed' : 'completed';
  const outcomeMessage = stripWrappingBackticks(String(summary?.outcomeMessage || (status === 'failed' ? 'Task failed.' : 'Task completed.')))
    .replace(/\s+/g, ' ')
    .trim();
  const marker = `<!-- torque-autodev-log:${task.id} -->`;
  const entryLines = [
    marker,
    `## ${summary?.timestamp || new Date().toISOString()} | ${status} | ${task.id}`,
    `- Goal: ${goal}`,
    `- Files Changed: ${changedFilesSummary}`,
    `- Verification Command: ${verificationCommand || 'not required'}`,
    `- Verification Result: ${verificationStatus}`,
    `- Outcome: ${outcomeMessage}`,
  ];
  if (summary?.revertReport) {
    entryLines.push(`- Notes: ${String(summary.revertReport).replace(/\s+/g, ' ').trim()}`);
  }
  const entry = `${entryLines.join('\n')}\n`;

  try {
    fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
    const existingContent = fs.existsSync(target.absolutePath)
      ? fs.readFileSync(target.absolutePath, 'utf-8')
      : '';
    if (existingContent.includes(marker)) {
      return { appended: false, alreadyPresent: true, ...target };
    }
    const baseContent = existingContent.trim().length > 0
      ? `${existingContent.replace(/\s*$/, '')}\n\n`
      : '# Session Log\n\n';
    fs.writeFileSync(target.absolutePath, `${baseContent}${entry}`, 'utf-8');
    return { appended: true, ...target };
  } catch (error) {
    return {
      appended: false,
      error: error.message,
      ...target,
    };
  }
}

function resolveTaskVerificationCommand(task, workingDir, agenticPolicy) {
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  const explicitCommand = typeof metadata.agentic_verification_command === 'string'
    ? metadata.agentic_verification_command
    : metadata.verification_command;
  if (typeof explicitCommand === 'string' && explicitCommand.trim()) {
    return stripWrappingBackticks(explicitCommand);
  }

  const taskSpec = loadTaskSpecFromMetadata(metadata, workingDir);
  if (!taskSpec?.spec) return null;
  if (taskSpec.source === 'json') {
    return stripWrappingBackticks(taskSpec.spec.verification_command ?? taskSpec.spec.verificationCommand ?? '');
  }
  return stripWrappingBackticks(taskSpec.spec.verification_command || '');
}

function resolveRequiredModifiedPaths(task, workingDir, agenticPolicy) {
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  const explicitPaths = normalizeStringList(
    metadata.agentic_required_modified_paths ?? metadata.required_modified_paths
  );
  const taskSpec = loadTaskSpecFromMetadata(metadata, workingDir);
  const specPaths = !taskSpec?.spec
    ? []
    : (taskSpec.source === 'json'
      ? collectJsonSpecList(taskSpec.spec, ['required_modified_paths', 'requiredModifiedPaths'])
      : normalizeStringList(taskSpec.spec.required_modified_paths));

  if (coerceOptionalBoolean(metadata.agentic_constraints_from_next_task, false)) {
    return mergeUniqueStrings(explicitPaths, specPaths);
  }
  if (explicitPaths.length > 0 || Array.isArray(metadata.agentic_required_modified_paths)) {
    return explicitPaths;
  }
  return specPaths;
}

function normalizeCommandForComparison(value) {
  return stripWrappingBackticks(String(value || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractLoggedCommand(toolEntry) {
  if (typeof toolEntry?.command === 'string' && toolEntry.command.trim()) {
    return toolEntry.command.trim();
  }
  if (typeof toolEntry?.arguments_preview !== 'string') return '';
  try {
    const parsed = JSON.parse(toolEntry.arguments_preview);
    return typeof parsed?.command === 'string' ? parsed.command.trim() : '';
  } catch {
    return '';
  }
}

function inspectVerificationToolLog(toolLog, verificationCommand) {
  const normalizedVerificationCommand = normalizeCommandForComparison(verificationCommand);
  if (!normalizedVerificationCommand) return null;

  const verificationEntries = Array.isArray(toolLog)
    ? toolLog.filter((entry) => entry?.name === 'run_command'
        && normalizeCommandForComparison(extractLoggedCommand(entry)) === normalizedVerificationCommand)
    : [];

  if (verificationEntries.length === 0) {
    return {
      status: 'missing',
      message: `Verification command was required but never executed: ${verificationCommand}`,
    };
  }

  const failedVerification = verificationEntries.find((entry) => {
    if (entry?.error) return true;
    const preview = String(entry?.result_preview || '');
    return /Command failed \(exit|Build FAILED|error CS\d+|MSBUILD : error|Test Run Failed|Unhandled exception/i.test(preview);
  });

  if (failedVerification) {
    return {
      status: 'failed',
      message: `Verification command failed: ${verificationCommand}`,
    };
  }

  return null;
}

function buildGitSafetyOptions(agenticPolicy) {
  return {
    authorizedPaths: Array.isArray(agenticPolicy?.writeAllowlist) ? agenticPolicy.writeAllowlist : [],
  };
}

function shouldRevertFailedAgenticChanges(task, agenticPolicy) {
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  const strictExecution = coerceOptionalBoolean(
    metadata.agentic_strict_completion,
    coerceOptionalBoolean(metadata.agentic_constraints_from_next_task, false),
  );
  return coerceOptionalBoolean(metadata.agentic_revert_changes_on_failure, strictExecution);
}

function maybeRevertFailedAgenticChanges(task, workingDir, agenticPolicy, snapshot, result) {
  if (!shouldRevertFailedAgenticChanges(task, agenticPolicy)) {
    return null;
  }
  if (!snapshot?.isGitRepo) {
    return null;
  }
  const changedFiles = mergeChangedFiles(result?.changedFiles);
  const preservedFiles = new Set(
    mergeChangedFiles(result?.frameworkPreservedFiles)
      .map((entry) => normalizeComparablePath(entry, workingDir))
  );
  const revertCandidates = changedFiles.filter((entry) => !preservedFiles.has(normalizeComparablePath(entry, workingDir)));
  if (revertCandidates.length === 0) {
    return null;
  }
  return revertScopedChanges(workingDir, snapshot, revertCandidates);
}

function normalizeComparablePath(value, workingDir) {
  const resolved = path.resolve(workingDir, String(value || '').trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function inspectRequiredModifiedPaths(changedFiles, requiredPaths, workingDir) {
  if (!Array.isArray(requiredPaths) || requiredPaths.length === 0) return null;
  const changedSet = new Set(
    (Array.isArray(changedFiles) ? changedFiles : [])
      .map((entry) => normalizeComparablePath(entry, workingDir))
  );
  const missing = requiredPaths.filter((entry) => !changedSet.has(normalizeComparablePath(entry, workingDir)));
  if (missing.length === 0) return null;
  return {
    missing,
    message: `Required files were not modified: ${missing.join(', ')}`,
  };
}

function evaluateAgenticCompletion(task, workingDir, agenticPolicy, result, maxIterations, gitReport, options = {}) {
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  const strictExecution = coerceOptionalBoolean(
    metadata.agentic_strict_completion,
    coerceOptionalBoolean(metadata.agentic_constraints_from_next_task, false),
  );
  if (!strictExecution) return null;

  const failOnMaxIterations = coerceOptionalBoolean(metadata.agentic_fail_on_max_iterations, true);
  const failOnVerification = coerceOptionalBoolean(metadata.agentic_fail_on_verification_error, true);
  const failOnGitRevert = coerceOptionalBoolean(metadata.agentic_fail_on_git_revert, true);
  const failOnMissingRequiredPaths = coerceOptionalBoolean(metadata.agentic_fail_on_missing_required_paths, true);

  const failureMessages = [];
  const verificationCommand = resolveTaskVerificationCommand(task, workingDir, agenticPolicy);
  const requiredModifiedPaths = resolveRequiredModifiedPaths(task, workingDir, agenticPolicy);
  const changedFiles = Array.isArray(options.changedFilesOverride)
    ? options.changedFilesOverride
    : result?.changedFiles;

  if (failOnVerification && verificationCommand) {
    const verificationResult = inspectVerificationToolLog(result?.toolLog, verificationCommand);
    if (verificationResult) failureMessages.push(verificationResult.message);
  }

  const stoppedForActionlessIterations = result?.stopReason === 'actionless_iterations';
  if (stoppedForActionlessIterations) {
    const limit = agenticPolicy?.actionlessIterationLimit;
    const limitSuffix = Number.isFinite(limit) && limit > 0 ? ` (${limit})` : '';
    failureMessages.push(`Agentic task stopped after hitting the actionless iteration limit${limitSuffix} without any write or verification attempt.`);
  }

  const reachedMaxIterations = result?.stopReason === 'max_iterations'
    || /Task reached maximum iterations/i.test(String(result?.output || ''));
  if (failOnMaxIterations && reachedMaxIterations) {
    failureMessages.push(`Agentic task exhausted its iteration budget (${maxIterations}) without converging.`);
  }

  if (failOnGitRevert && Array.isArray(gitReport?.reverted) && gitReport.reverted.length > 0) {
    failureMessages.push(`Git Safety reverted unauthorized changes: ${gitReport.reverted.join(', ')}`);
  }

  if (failOnMissingRequiredPaths && !options.skipRequiredModifiedPaths) {
    const requiredPathResult = inspectRequiredModifiedPaths(changedFiles, requiredModifiedPaths, workingDir);
    if (requiredPathResult) failureMessages.push(requiredPathResult.message);
  }

  if (failureMessages.length === 0) return null;

  return {
    message: failureMessages.join('\n'),
    verificationCommand,
  };
}

function appendTaskPolicyGuidance(systemPrompt, agenticPolicy) {
  const guidance = [];
  if (Array.isArray(agenticPolicy.readAllowlist) && agenticPolicy.readAllowlist.length > 0) {
    guidance.push(`Read scope is restricted to: ${agenticPolicy.readAllowlist.join(', ')}`);
  }
  if (Array.isArray(agenticPolicy.writeAllowlist) && agenticPolicy.writeAllowlist.length > 0) {
    guidance.push(`Write scope is restricted to: ${agenticPolicy.writeAllowlist.join(', ')}`);
  }
  if (Array.isArray(agenticPolicy.writeAfterReadPaths) && agenticPolicy.writeAfterReadPaths.length > 0) {
    guidance.push(`After you read all of these paths, your next tool call must be write_file, edit_file, or replace_lines before any more reads or commands: ${agenticPolicy.writeAfterReadPaths.join(', ')}`);
  }
  if (Number.isFinite(agenticPolicy.diagnosticReadLimitAfterFailedCommand) && agenticPolicy.diagnosticReadLimitAfterFailedCommand > 0) {
    guidance.push(`After a failed run_command, you may use at most ${agenticPolicy.diagnosticReadLimitAfterFailedCommand} diagnostic read_file call(s) before your next tool call must be write_file, edit_file, or replace_lines.`);
  }
  if (agenticPolicy.commandMode === 'allowlist') {
    const commandSummary = agenticPolicy.commandAllowlist.length > 0
      ? agenticPolicy.commandAllowlist.join(', ')
      : 'no commands are allowed';
    guidance.push(`Commands must match this allowlist: ${commandSummary}`);
  }
  if (Array.isArray(agenticPolicy.toolAllowlist) && agenticPolicy.toolAllowlist.length > 0) {
    guidance.push(`Only these tools may be used: ${agenticPolicy.toolAllowlist.join(', ')}`);
  }
  if (Number.isFinite(agenticPolicy.actionlessIterationLimit) && agenticPolicy.actionlessIterationLimit > 0) {
    guidance.push(`Stop after ${agenticPolicy.actionlessIterationLimit} consecutive iterations without any write or verification attempt`);
  }
  if (guidance.length === 0) return systemPrompt;
  return `${systemPrompt}\n\nTask-specific hard constraints:\n- ${guidance.join('\n- ')}`;
}

/**
 * Pre-stuff file contents into the task prompt for agentic providers.
 * Extracts file paths from the task description, reads them, and appends
 * their contents. Converts multi-iteration exploration into single-shot analysis.
 * @param {string} taskDescription - Original task description
 * @param {string} workingDir - Working directory for file resolution
 * @param {number} budgetChars - Max characters to stuff (default: 200000 ≈ 50K tokens)
 * @returns {string} Enriched task prompt
 */
function preStuffFileContents(taskDescription, workingDir, budgetChars = 200000) {
  if (!taskDescription || !workingDir) return taskDescription;
  try {
    const fs = require('fs');
    const filePattern = /\b((?:src|tests?|server|lib|app|docs|scripts?|config|build)\/[\w./-]+\.(?:cs|ts|js|py|java|go|rs|xaml|json|md|sh|yaml|yml|toml))\b/gi;
    const referencedFiles = [...new Set((taskDescription.match(filePattern) || []))];
    if (referencedFiles.length === 0) return taskDescription;

    const stuffedParts = [];
    let totalChars = 0;
    for (const relPath of referencedFiles) {
      const absPath = path.resolve(workingDir, relPath);
      if (!absPath.startsWith(path.resolve(workingDir))) continue;
      try {
        const content = fs.readFileSync(absPath, 'utf-8');
        if (content.length > 100000) continue; // ~25K tokens max per file
        if (totalChars + content.length > budgetChars) continue; // would exceed budget
        stuffedParts.push(`\n--- FILE: ${relPath} ---\n${content}\n--- END FILE ---`);
        totalChars += content.length;
      } catch { /* file doesn't exist, skip */ }
    }
    if (stuffedParts.length > 0) {
      logger.info(`[Agentic] Pre-stuffed ${stuffedParts.length}/${referencedFiles.length} files (${Math.round(totalChars/1024)}KB)`);
      return taskDescription +
        `\n\n[PRE-LOADED FILES — you do NOT need to call read_file for these, their contents are below]\n` +
        stuffedParts.join('\n');
    }
  } catch (err) {
    logger.info(`[Agentic] Pre-stuff failed (non-fatal): ${err.message}`);
  }
  return taskDescription;
}

// ============================================================
// Worker-based agentic execution
// ============================================================

/**
 * Spawn a worker_threads worker that runs the agentic loop in isolation.
 *
 * The worker communicates back via postMessage with a typed protocol:
 *   progress, toolCall, chunk, log, result, error
 *
 * @param {Object} config - workerData passed to agentic-worker.js
 * @param {Object} [callbacks] - optional message handlers
 * @param {Function} [callbacks.onProgress]
 * @param {Function} [callbacks.onToolCall]
 * @param {Function} [callbacks.onChunk]
 * @param {Function} [callbacks.onLog]
 * @returns {{ promise: Promise, abort: Function, terminate: Function, worker: Worker }}
 */
function spawnAgenticWorker(config, callbacks = {}) {
  const { onProgress, onToolCall, onChunk, onLog } = callbacks;
  let settled = false;

  // Lazy lookup — allows vi.spyOn(require('worker_threads'), 'Worker') to intercept
  const { Worker } = require('worker_threads');
  const worker = new Worker(
    path.join(__dirname, 'agentic-worker.js'),
    { workerData: config }
  );

  const abort = () => worker.postMessage({ type: 'abort' });
  const terminate = () => worker.terminate();

  const promise = new Promise((resolve, reject) => {
    worker.on('message', (msg) => {
      if (settled) return;
      if (msg.type === 'result' || msg.type === 'error') logger.debug(`[MAIN-RECV] ${msg.type} from worker`);
      switch (msg.type) {
        case 'progress': if (onProgress) onProgress(msg); break;
        case 'toolCall': if (onToolCall) onToolCall(msg); break;
        case 'chunk': if (onChunk) onChunk(msg); break;
        case 'log': if (onLog) onLog(msg); break;
        case 'quotaHeaders':
          try {
            const { getQuotaStore } = require('../db/provider-quotas');
            getQuotaStore().updateFromHeaders(msg.provider, msg.headers);
          } catch { /* non-critical */ }
          break;
        case 'result': settled = true; resolve(msg); break;
        case 'error': settled = true; reject(new Error(msg.message)); break;
      }
    });
    worker.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        settled = true;
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });

  return { promise, abort, terminate, worker };
}

function getAgenticRunningProcesses() {
  return _agenticDeps?.runningProcesses || null;
}

function appendTrackedOutput(entry, chunk, maxChars = 8192) {
  if (!entry || !chunk) return;
  const next = `${entry.output || ''}${chunk}`;
  entry.output = next.length > maxChars ? next.slice(-maxChars) : next;
}

function touchTrackedAgenticWorker(taskId, mutate) {
  const runningProcesses = getAgenticRunningProcesses();
  const entry = runningProcesses?.get?.(taskId);
  if (!entry) return;
  if (typeof mutate === 'function') mutate(entry);
  entry.lastOutputAt = Date.now();
}

function buildTrackedAgenticCallbacks(taskId, callbacks = {}) {
  return {
    onProgress: (msg) => {
      touchTrackedAgenticWorker(taskId, (entry) => {
        entry.lastProgress = msg.iteration;
        entry.output = `[Agentic: iteration ${msg.iteration}/${msg.maxIterations}, last tool: ${msg.lastTool || 'none'}]`;
      });
      callbacks.onProgress?.(msg);
    },
    onToolCall: (msg) => {
      touchTrackedAgenticWorker(taskId, (entry) => {
        appendTrackedOutput(entry, `[tool:${msg.name}] `);
      });
      callbacks.onToolCall?.(msg);
    },
    onChunk: (msg) => {
      touchTrackedAgenticWorker(taskId, (entry) => {
        appendTrackedOutput(entry, msg.text || '');
      });
      callbacks.onChunk?.(msg);
    },
    onLog: (msg) => callbacks.onLog?.(msg),
  };
}

function trackAgenticWorkerTask(taskId, {
  workerHandle,
  abortController = null,
  provider = null,
  model = null,
  workingDir = null,
  timeoutHandle = null,
}) {
  const runningProcesses = getAgenticRunningProcesses();
  const worker = workerHandle?.worker;
  if (!runningProcesses?.set || !worker) return () => {};

  const originalKill = typeof worker.kill === 'function' ? worker.kill.bind(worker) : null;
  if (typeof worker.kill !== 'function') {
    worker.kill = (signal = 'SIGTERM') => {
      if (signal === 'SIGTERM') {
        try { abortController?.abort?.(); } catch { /* ignore */ }
        try { workerHandle.abort?.(); } catch { /* ignore */ }
        return true;
      }
      try { workerHandle.terminate?.(); } catch { /* ignore */ }
      return true;
    };
  }

  const now = Date.now();
  const procRecord = {
    process: worker,
    output: '',
    errorOutput: '',
    startTime: now,
    lastOutputAt: now,
    stallWarned: false,
    timeoutHandle,
    provider,
    model,
    workingDirectory: workingDir,
    isAgenticWorker: true,
  };

  runningProcesses.set(taskId, procRecord);

  return () => {
    const current = runningProcesses.get(taskId);
    if (current === procRecord) {
      if (current.timeoutHandle) clearTimeout(current.timeoutHandle);
      if (current.startupTimeoutHandle) clearTimeout(current.startupTimeoutHandle);
      if (current.completionGraceHandle) clearTimeout(current.completionGraceHandle);
      runningProcesses.delete(taskId);
      runningProcesses.stallAttempts?.delete?.(taskId);
    }

    if (originalKill) worker.kill = originalKill;
    else delete worker.kill;
  };
}

/**
 * Run the full agentic pipeline: create executor, capture git snapshot,
 * run the agentic loop, check/revert unauthorized changes, store metadata.
 *
 * @deprecated Use spawnAgenticWorker() instead. Retained for backward compatibility
 * with any code that references runAgenticPipeline directly.
 *
 * @param {Object} params
 * @param {Object} params.adapter - Chat adapter
 * @param {string} params.systemPrompt - Full system prompt (already built)
 * @param {Object} params.task - Task record
 * @param {Object} params.adapterOptions - Options to pass to adapter (host, apiKey, model, providerName, plus tuning)
 * @param {string} params.workingDir - Working directory
 * @param {number} params.timeoutMs - Timeout in ms
 * @param {number} params.maxIterations - Max loop iterations
 * @param {number} params.contextBudget - Context budget for truncation
 * @param {string} params.ollamaStreamId - Stream ID for output
 * @param {AbortSignal} params.signal - Abort signal
 * @returns {Promise<{ output: string, toolLog: Array, changedFiles: string[], iterations: number, tokenUsage: Object }>}
 */
async function runAgenticPipeline({
  adapter, systemPrompt, task, adapterOptions, workingDir,
  timeoutMs, maxIterations, contextBudget, ollamaStreamId, signal,
  promptInjectedTools = false,
}) {
  const serverConfig = require('../config');
  const { db, dashboard } = _agenticDeps;
  const taskId = task.id;
  const agenticPolicy = buildTaskAgenticPolicy(task, workingDir, serverConfig);

  // Create tool executor
  const executor = createToolExecutor(workingDir, {
    commandMode: agenticPolicy.commandMode,
    commandAllowlist: agenticPolicy.commandAllowlist,
    readAllowlist: agenticPolicy.readAllowlist,
    writeAllowlist: agenticPolicy.writeAllowlist,
    writeAfterReadPaths: agenticPolicy.writeAfterReadPaths,
    diagnosticReadLimitAfterFailedCommand: agenticPolicy.diagnosticReadLimitAfterFailedCommand,
  });

  // Capture git snapshot (non-git repos return null)
  let snapshot = null;
  try {
    snapshot = captureSnapshot(workingDir);
  } catch (e) {
    logger.info(`[Agentic] Git snapshot failed (non-git repo?): ${e.message}`);
  }

  // Pre-stuff referenced files
  const enrichedPromptInline = preStuffFileContents(task.task_description, workingDir);

  // Run agentic loop
  // For prompt-injected tools: pass empty tools array (tools are in the system prompt)
  const result = await runAgenticLoop({
    adapter,
    systemPrompt: appendTaskPolicyGuidance(systemPrompt, agenticPolicy),
    taskPrompt: enrichedPromptInline,
    tools: promptInjectedTools ? [] : selectToolsForTask(task.task_description, {
      commandMode: agenticPolicy.commandMode,
      commandAllowlist: agenticPolicy.commandAllowlist,
      toolAllowlist: agenticPolicy.toolAllowlist,
    }),
    promptInjectedTools,
    toolExecutor: executor,
    options: adapterOptions,
    workingDir,
    timeoutMs,
    maxIterations: agenticPolicy.maxIterations || maxIterations,
    contextBudget,
    actionlessIterationLimit: agenticPolicy.actionlessIterationLimit,
    onProgress: (iteration, max, lastTool) => {
      const pct = Math.min(85, 10 + Math.floor((iteration / max) * 75));
      try {
        db.updateTaskStatus(taskId, 'running', {
          progress_percent: pct,
          output: `[Agentic: iteration ${iteration}/${max}, last tool: ${lastTool || 'none'}]`,
        });
        dashboard.notifyTaskUpdated(taskId);
      } catch { /* ignore */ }
    },
    onToolCall: (name, args, execResult) => {
      try {
        const status = execResult.error ? 'ERROR' : 'OK';
        db.addStreamChunk(ollamaStreamId, `[tool:${name}] ${status}\n`, 'stdout');
        dashboard.notifyTaskOutput(taskId, `[tool:${name}] ${status}\n`);
      } catch { /* ignore */ }
    },
    signal,
  });

  // Check and revert unauthorized git changes
  logger.info(`[Agentic] Pipeline complete, checking git safety`);
  if (snapshot && snapshot.isGitRepo) {
    const safetyMode = serverConfig.get('agentic_git_safety') || 'on';
    // Map 'on' to 'enforce' for the git safety module
    const mode = safetyMode === 'on' ? 'enforce' : safetyMode === 'warn' ? 'warn' : 'off';
    const gitReport = checkAndRevert(workingDir, snapshot, task.task_description, mode, buildGitSafetyOptions(agenticPolicy));
    if (gitReport.report) {
      result.output += `\n\n--- Git Safety ---\n${gitReport.report}`;
    }
  }

  logger.info(`[Agentic] Returning: output=${result.output?.length || 0} bytes, tools=${result.toolLog?.length || 0}, files=${result.changedFiles?.length || 0}`);
  return result;
}

// ============================================================
// Agentic wrappers
// ============================================================

/**
 * Agentic wrapper around executeOllamaTask.
 * When the model is agentic-capable and the pipeline is enabled,
 * intercepts the task and runs it through /api/chat with tool calling.
 * Falls back to legacy /api/generate via executeOllamaTask otherwise.
 */
async function executeOllamaTaskWithAgentic(task) {
  const serverConfig = require('../config');
  const provider = task.provider || 'ollama';

  // Check capability (handles excluded providers, kill switch, whitelist, probe cache)
  const model = resolveOllamaModel(task, null) || '';
  const capability = isAgenticCapable(provider, model);

  if (!capability.capable || !_agenticDeps) {
    logger.info(`[Agentic] Skipping agentic for ${provider}/${model}: ${capability.reason}`);
    return _executeOllamaModule.executeOllamaTask(task);
  }

  // Diffusion compute tasks need raw text output, not agentic tool-calling.
  try {
    const taskMeta = task.metadata ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata) : {};
    if (taskMeta.diffusion_role === 'compute') {
      logger.info(`[Agentic] Ollama compute task ${task.id} — bypassing agentic loop for raw text output`);
      return _executeOllamaModule.executeOllamaTask(task);
    }
  } catch (_e) { /* non-fatal — continue to agentic */ }

  // Legacy kill switch backward compat
  if (serverConfig.get('ollama_agentic_enabled') === '0') {
    return _executeOllamaModule.executeOllamaTask(task);
  }

  // Select adapter
  const adapter = selectAdapter(provider);
  if (!adapter) {
    logger.info(`[Agentic] No adapter for provider ${provider}, falling back to legacy`);
    return _executeOllamaModule.executeOllamaTask(task);
  }

  const { db, dashboard, safeUpdateTaskStatus, processQueue, handleWorkflowTermination } = _agenticDeps;
  const providerConfig = require('./config');
  const ollamaShared = require('./ollama-shared');
  const taskId = task.id;

  // Resolve working directory
  let workingDir = task.working_directory;
  if (!workingDir) workingDir = process.cwd();
  maybePersistEffectiveAgenticMetadata(task, db, workingDir);
  const agenticPolicy = buildTaskAgenticPolicy(task, workingDir, serverConfig);

  const noopPlanningResult = maybeShortCircuitPlanningTask(task, workingDir, agenticPolicy);
  if (noopPlanningResult) {
    const completedAt = new Date().toISOString();
    safeUpdateTaskStatus(taskId, 'completed', {
      output: noopPlanningResult.output,
      exit_code: 0,
      progress_percent: 100,
      started_at: completedAt,
      completed_at: completedAt,
      task_metadata: JSON.stringify(noopPlanningResult.taskMetadata),
    });

    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent('completed', db.getTask(taskId));
    } catch { /* non-fatal */ }

    logger.info(`[Agentic] Ollama task ${taskId} short-circuited: ${noopPlanningResult.taskMetadata.agentic_noop_reason}`);
    dashboard.notifyTaskUpdated(taskId);
    if (typeof handleWorkflowTermination === 'function') {
      try { handleWorkflowTermination(taskId); } catch (e) {
        logger.info(`[Agentic] handleWorkflowTermination error for Ollama task ${taskId}: ${e.message}`);
      }
    }
    processQueue();
    return;
  }

  // Resolve model
  let resolvedModel = task.model;
  if (!resolvedModel) {
    try {
      const registry = require('../models/registry');
      const best = registry.selectBestApprovedModel('ollama');
      if (best) resolvedModel = best.model_name;
    } catch { /* ignore */ }
  }
  if (!resolvedModel) resolvedModel = resolveOllamaModel(task, null) || '';
  if (!resolvedModel || !ollamaShared.hasModelOnAnyHost(resolvedModel)) {
    const best = ollamaShared.findBestAvailableModel();
    if (best) resolvedModel = best;
  }
  if (!resolvedModel) {
    try {
      const modelRoles = require('../db/model-roles');
      resolvedModel = modelRoles.getModelForRole('ollama', 'default') || null;
    } catch { resolvedModel = null; }
  }

  // Resolve host
  const hosts = db.listOllamaHosts ? db.listOllamaHosts() : [];
  let ollamaHost = null;
  let selectedHostId = null;

  if (hosts.length > 0) {
    const selection = db.selectOllamaHostForModel(resolvedModel);
    if (selection.host) {
      ollamaHost = selection.host.url;
      selectedHostId = selection.host.id;
    }
  }
  if (!ollamaHost) {
    // Check if there's a configured host before falling back to localhost
    const configuredHost = serverConfig.get('ollama_host');
    if (configuredHost) {
      ollamaHost = configuredHost;
    } else {
      // No host found for model — fail with clear error instead of trying localhost
      const availableModels = ollamaShared.findBestAvailableModel();
      const errorMsg = `No Ollama host has model '${resolvedModel}'${availableModels ? `. Available: ${availableModels}` : ' and no models are available on any host'}. Check that the model is pulled on a registered host.`;
      logger.info(`[Agentic] ${errorMsg}`);
      safeUpdateTaskStatus(taskId, 'failed', {
        error_output: errorMsg,
        exit_code: 1,
        completed_at: new Date().toISOString(),
      });
      try {
        const { dispatchTaskEvent } = require('../hooks/event-dispatch');
        dispatchTaskEvent('failed', db.getTask(taskId));
      } catch { /* non-fatal */ }
      dashboard.notifyTaskUpdated(taskId);
      processQueue();
      return;
    }
  }

  let releaseSelectedHostSlot = null;
  if (selectedHostId && typeof db.tryReserveHostSlot === 'function') {
    const reservation = db.tryReserveHostSlot(selectedHostId, resolvedModel);
    if (!reservation?.acquired) {
      const reason = reservation?.error
        || reservation?.vramReason
        || (reservation?.maxCapacity
          ? `Ollama host at capacity (${reservation.currentLoad || 0}/${reservation.maxCapacity})`
          : 'Unable to reserve Ollama host slot');
      throw new Error(reason);
    }

    releaseSelectedHostSlot = () => {
      if (typeof db.releaseHostSlot === 'function') {
        db.releaseHostSlot(selectedHostId);
      } else if (typeof db.decrementHostTasks === 'function') {
        db.decrementHostTasks(selectedHostId);
      }
    };
  }

  // Resolve tuning
  const tuning = providerConfig.resolveOllamaTuning({
    hostId: selectedHostId,
    model: resolvedModel,
    task,
    adaptiveCtx: null,
    includeAutoTuning: true,
    includeHardware: true,
  });
  // Agentic tasks need larger context than single-shot — multi-turn tool conversations
  // accumulate messages fast. Scale the minimum to 50% of the configured max context,
  // floored at 16K. This way upgrading VRAM and raising ollama_max_ctx automatically
  // gives agentic tasks more room without code changes.
  const maxCtxConfig = parseInt(serverConfig.get('ollama_max_ctx') || '32768', 10);
  const AGENTIC_MIN_CTX = Math.max(16384, Math.floor(maxCtxConfig / 2));
  const effectiveNumCtx = Math.max(tuning.numCtx || AGENTIC_MIN_CTX, AGENTIC_MIN_CTX);
  const tuningOptions = {
    temperature: tuning.temperature,
    num_ctx: effectiveNumCtx,
    num_predict: tuning.numPredict,
    num_keep: 1024, // Preserve system prompt + tool definitions during context sliding
    top_p: tuning.topP,
    top_k: tuning.topK,
    repeat_penalty: tuning.repeatPenalty,
  };

  // Check if model needs prompt-injected tools
  const usePromptInjection = needsPromptInjection(resolvedModel);

  // Build system prompt
  const basePrompt = providerConfig.resolveSystemPrompt(resolvedModel);
  let systemPrompt = appendTaskPolicyGuidance(
    buildAgenticSystemPrompt(basePrompt, workingDir),
    agenticPolicy
  );

  // For prompt-injected tools: append tool definitions to system prompt
  if (usePromptInjection) {
    const selectedTools = selectToolsForTask(task.task_description, {
      commandMode: agenticPolicy.commandMode,
      commandAllowlist: agenticPolicy.commandAllowlist,
      toolAllowlist: agenticPolicy.toolAllowlist,
    });
    const toolDefs = selectedTools.map(t => JSON.stringify({
      type: t.type, function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters }
    })).join(',');
    systemPrompt = `[AVAILABLE_TOOLS][${toolDefs}][/AVAILABLE_TOOLS]\n${systemPrompt}\nTo call a tool, respond with ONLY a JSON array: [{"name":"tool_name","arguments":{}}]\nAfter receiving [TOOL_RESULTS], give a clear summary with the ACTUAL data returned.`;
    logger.info(`[Agentic] Model ${resolvedModel} uses prompt-injected tools`);
  }

  // Update status — persist the resolved model so performance tracking works
  db.updateTaskStatus(taskId, 'running', {
    started_at: new Date().toISOString(),
    progress_percent: 10,
    ollama_host_id: selectedHostId,
    model: resolvedModel,
  });
  dashboard.notifyTaskUpdated(taskId);

  const ollamaStreamId = db.getOrCreateTaskStream(taskId, 'output');
  // timeout_minutes === 0 means "no timeout enforcement" (opt-in). Preserve
  // the explicit zero via `??` + isFinite check and skip the setTimeout so
  // the abort controller only aborts on cancelTask / cancelled-task sweep.
  const parsedTimeout = parseInt(task.timeout_minutes, 10);
  const timeoutMinutes = Number.isFinite(parsedTimeout) ? parsedTimeout : 30;
  const abortController = new AbortController();
  // Register abort controller so cancelTask() can find and abort agentic tasks
  const apiAbortControllers = _agenticDeps.apiAbortControllers;
  if (apiAbortControllers) apiAbortControllers.set(taskId, abortController);
  const timeoutHandle = timeoutMinutes === 0
    ? null
    : setTimeout(() => abortController.abort(), timeoutMinutes * 60 * 1000);
  const cancelCheckInterval = setInterval(() => {
    try {
      const t = db.getTask(taskId);
      if (t && t.status === 'cancelled') {
        abortController.abort();
        clearInterval(cancelCheckInterval);
      }
    } catch { /* ignore */ }
  }, 2000);
  // Hoisted so the finally block can call removeEventListener for cleanup
  let origAbortHandler = null;
  let cleanupTrackedWorker = null;

  // Per-host mutex — wait for any prior task on this host to finish.
  // Prevents GPU contention when multi-instance scheduling races occur.
  let releaseHostLock = null;
  if (selectedHostId) {
    releaseHostLock = await acquireHostLock(selectedHostId);
  }

  try {
    logger.info(`[Agentic] Starting Ollama task ${taskId} with model ${resolvedModel} on ${ollamaHost}`);

    // Category-aware max iterations: complex tasks get more room
    const baseMaxIter = parseInt(serverConfig.get('agentic_max_iterations') || '15', 10);
    const taskComplexity = task.complexity || 'normal';
    const defaultMaxIterations = taskComplexity === 'complex' ? Math.max(baseMaxIter, 20) : baseMaxIter;
    const maxIterations = agenticPolicy.maxIterations || defaultMaxIterations;
    const contextBudget = Math.floor(effectiveNumCtx * 0.8);

    // Capture git snapshot in main thread (git ops need main process context)
    let snapshot = null;
    try {
      snapshot = captureSnapshot(workingDir);
    } catch (e) {
      logger.info(`[Agentic] Git snapshot failed (non-git repo?): ${e.message}`);
    }

    // Pre-stuff referenced files into the prompt so the model doesn't
    // burn iterations calling read_file for files already mentioned in the task.
    const enrichedTaskPrompt = preStuffFileContents(task.task_description, workingDir, contextBudget * 3);

    // Spawn worker thread for the agentic loop
    logger.debug(`[WORKER-DEBUG] Spawning worker for Ollama task ${taskId}, model=${resolvedModel}, host=${ollamaHost}`);
    const workerHandle = spawnAgenticWorker({
      adapterType: 'ollama',
      adapterOptions: {
        host: ollamaHost,
        apiKey: resolveApiKey(provider),
        providerName: provider,
        model: resolvedModel,
        ...tuningOptions,
      },
      systemPrompt,
      taskPrompt: enrichedTaskPrompt,
      workingDir,
      timeoutMs,
      maxIterations,
      contextBudget,
      promptInjectedTools: usePromptInjection,
      commandMode: agenticPolicy.commandMode,
      commandAllowlist: agenticPolicy.commandAllowlist,
      toolAllowlist: agenticPolicy.toolAllowlist,
      actionlessIterationLimit: agenticPolicy.actionlessIterationLimit,
      readAllowlist: agenticPolicy.readAllowlist,
      writeAllowlist: agenticPolicy.writeAllowlist,
      writeAfterReadPaths: agenticPolicy.writeAfterReadPaths,
      diagnosticReadLimitAfterFailedCommand: agenticPolicy.diagnosticReadLimitAfterFailedCommand,
    }, buildTrackedAgenticCallbacks(taskId, {
      onProgress: (msg) => {
        try {
          db.updateTaskStatus(taskId, 'running', {
            progress_percent: Math.min(85, 10 + Math.floor((msg.iteration / msg.maxIterations) * 75)),
            output: `[Agentic: iteration ${msg.iteration}/${msg.maxIterations}, last tool: ${msg.lastTool || 'none'}]`,
          });
          dashboard.notifyTaskUpdated(taskId);
        } catch { /* ignore */ }
      },
      onToolCall: (msg) => {
        try {
          dashboard.notifyTaskOutput(taskId, `[tool:${msg.name}] ${msg.result?.slice(0, 50) || 'ok'}\n`);
        } catch { /* ignore */ }
      },
      onChunk: (msg) => {
        try {
          db.addStreamChunk(ollamaStreamId, msg.text, 'stdout');
          dashboard.notifyTaskOutput(taskId, msg.text);
        } catch { /* ignore */ }
      },
      onLog: (msg) => {
        logger[msg.level || 'info'](msg.message);
      },
    }));
    cleanupTrackedWorker = trackAgenticWorkerTask(taskId, {
      workerHandle,
      abortController,
      provider,
      model: resolvedModel,
      workingDir,
      timeoutHandle,
    });

    // Wire abort: forward AbortController.abort() → worker abort message
    origAbortHandler = () => workerHandle.abort();
    abortController.signal.addEventListener('abort', origAbortHandler);

    const result = await workerHandle.promise;
    let gitReport = null;

    // Git safety check in main thread (after worker completes)
    if (snapshot && snapshot.isGitRepo) {
      const safetyMode = serverConfig.get('agentic_git_safety') || 'on';
      const mode = safetyMode === 'on' ? 'enforce' : safetyMode === 'warn' ? 'warn' : 'off';
      gitReport = checkAndRevert(workingDir, snapshot, task.task_description, mode, buildGitSafetyOptions(agenticPolicy));
      if (gitReport.report) {
        result.output += '\n\n--- Git Safety ---\n' + gitReport.report;
      }
    }

    const sessionLogTarget = resolveAgenticSessionLogTarget(task, workingDir, agenticPolicy);
    const reviewedChangedFiles = sessionLogTarget
      ? mergeChangedFiles(result?.changedFiles, [sessionLogTarget.absolutePath])
      : mergeChangedFiles(result?.changedFiles);
    const completionFailure = evaluateAgenticCompletion(
      task,
      workingDir,
      agenticPolicy,
      result,
      maxIterations,
      gitReport,
      { changedFilesOverride: reviewedChangedFiles }
    );
    const revertResult = completionFailure
      ? maybeRevertFailedAgenticChanges(task, workingDir, agenticPolicy, snapshot, result)
      : null;
    let failureMessage = completionFailure?.message || '';
    if (revertResult?.report) {
      failureMessage = failureMessage ? `${failureMessage}\n${revertResult.report}` : revertResult.report;
    }
    const completedAt = new Date().toISOString();
    const sessionLogResult = maybeAppendAgenticSessionLog(task, workingDir, agenticPolicy, result, {
      status: completionFailure ? 'failed' : 'completed',
      outcomeMessage: failureMessage || 'Task completed successfully.',
      verificationCommand: completionFailure?.verificationCommand || resolveTaskVerificationCommand(task, workingDir, agenticPolicy),
      revertReport: revertResult?.report || '',
      timestamp: completedAt,
    }, sessionLogTarget);
    if (sessionLogResult?.appended) {
      result.changedFiles = reviewedChangedFiles;
      result.frameworkPreservedFiles = mergeChangedFiles(result?.frameworkPreservedFiles, [sessionLogResult.absolutePath]);
      appendAgenticOutputSection(result, 'Framework Session Log', `Appended ${sessionLogResult.relativePath}`);
    } else if (sessionLogTarget && sessionLogResult?.error) {
      const sessionLogError = `Framework session log append failed: ${sessionLogResult.relativePath} (${sessionLogResult.error})`;
      failureMessage = failureMessage ? `${failureMessage}\n${sessionLogError}` : sessionLogError;
      appendAgenticOutputSection(result, 'Framework Session Log', `Failed to append ${sessionLogResult.relativePath}: ${sessionLogResult.error}`);
    }
    if (completionFailure || (sessionLogTarget && sessionLogResult?.error)) {
      safeUpdateTaskStatus(taskId, 'failed', {
        output: result.output,
        error_output: failureMessage,
        exit_code: 1,
        progress_percent: 100,
        completed_at: completedAt,
        task_metadata: JSON.stringify({
          agentic_log: result.toolLog,
          agentic_token_usage: result.tokenUsage,
          agentic_failure_reason: failureMessage,
          ...(revertResult ? { agentic_reverted_changes: revertResult.reverted, agentic_revert_report: revertResult.report } : {}),
          ...(completionFailure?.verificationCommand ? { verification_command: completionFailure.verificationCommand } : {}),
        }),
      });

      try {
        const { dispatchTaskEvent } = require('../hooks/event-dispatch');
        dispatchTaskEvent('failed', db.getTask(taskId));
      } catch { /* non-fatal */ }

      logger.info(`[Agentic] Ollama task ${taskId} marked failed after completion review: ${failureMessage}`);
      return;
    }

    // Store result + metadata in a single status update (avoid double-complete race)
    safeUpdateTaskStatus(taskId, 'completed', {
      output: result.output,
      exit_code: 0,
      progress_percent: 100,
      completed_at: completedAt,
      task_metadata: JSON.stringify({
        agentic_log: result.toolLog,
        agentic_token_usage: result.tokenUsage,
      }),
    });

    // Dispatch completion event so await_task/await_workflow wake up immediately
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent('completed', db.getTask(taskId));
    } catch { /* non-fatal */ }

    logger.info(`[Agentic] Ollama task ${taskId} completed: ${result.iterations} iterations, ${(result.toolLog || []).length} tool calls, ${(result.changedFiles || []).length} files changed`);

  } catch (error) {
    logger.info(`[Agentic] Ollama task ${taskId} failed: ${error.message}`);
    safeUpdateTaskStatus(taskId, 'failed', {
      error_output: error.message,
      exit_code: 1,
      completed_at: new Date().toISOString(),
    });

    // Dispatch failure event so await_task/await_workflow wake up immediately
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent('failed', db.getTask(taskId));
    } catch { /* non-fatal */ }
  } finally {
    if (origAbortHandler) abortController.signal.removeEventListener('abort', origAbortHandler);
    clearInterval(cancelCheckInterval);
    clearTimeout(timeoutHandle);
    if (apiAbortControllers) apiAbortControllers.delete(taskId);
    cleanupTrackedWorker?.();
    if (typeof releaseSelectedHostSlot === 'function') {
      try { releaseSelectedHostSlot(); } catch { /* ignore */ }
    }
    // Release per-host mutex so the next queued task can proceed
    if (releaseHostLock) releaseHostLock();
    dashboard.notifyTaskUpdated(taskId);
    // Workflow termination in both success and failure paths
    if (typeof handleWorkflowTermination === 'function') {
      try { handleWorkflowTermination(taskId); } catch (e) {
        logger.info(`[Agentic] handleWorkflowTermination error for Ollama task ${taskId}: ${e.message}`);
      }
    }
    processQueue();
  }
}

/**
 * Agentic wrapper around executeApiProvider.
 * When the provider+model is agentic-capable, intercepts the task and runs it
 * through the adapter-agnostic agentic loop with tool calling.
 * Falls back to the standard API provider execution otherwise.
 */
async function executeApiProviderWithAgentic(task, providerInstance) {
  const serverConfig = require('../config');
  const provider = task.provider || '';
  const model = task.model || PROVIDER_DEFAULT_MODEL[provider] || '';
  logger.debug(`[API-WRAP] provider=${provider} model=${model} taskId=${task.id}`);

  // Check capability
  const capability = isAgenticCapable(provider, model);
  logger.debug(`[API-WRAP] capable=${capability.capable} reason=${capability.reason} hasDeps=${!!_agenticDeps}`);

  if (!capability.capable || !_agenticDeps) {
    logger.debug(`[API-WRAP] FALLBACK to legacy`);
    return _executeApiModule.executeApiProvider(task, providerInstance);
  }

  // Diffusion compute tasks need raw text output, not agentic tool-calling.
  // Bypass the agentic loop and use the legacy API path which returns the
  // LLM response as plain text — exactly what the compute→apply pipeline needs.
  try {
    const taskMeta = task.metadata ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata) : {};
    if (taskMeta.diffusion_role === 'compute') {
      logger.info(`[API-WRAP] Compute task ${task.id} — bypassing agentic loop for raw text output`);
      return _executeApiModule.executeApiProvider(task, providerInstance);
    }
  } catch (_e) { /* non-fatal — continue to agentic */ }

  // Select adapter
  const adapter = selectAdapter(provider);
  if (!adapter) {
    return _executeApiModule.executeApiProvider(task, providerInstance);
  }

  // Resolve API key
  const apiKey = resolveApiKey(provider);
  if (!apiKey && provider !== 'ollama') {
    logger.info(`[Agentic] No API key for provider ${provider}, falling back to standard API execution`);
    return _executeApiModule.executeApiProvider(task, providerInstance);
  }

  const { db, dashboard, safeUpdateTaskStatus, processQueue, handleWorkflowTermination } = _agenticDeps;
  const providerConfig = require('./config');
  const taskId = task.id;

  // Resolve working directory
  let workingDir = task.working_directory;
  if (!workingDir) workingDir = process.cwd();
  maybePersistEffectiveAgenticMetadata(task, db, workingDir);
  const agenticPolicy = buildTaskAgenticPolicy(task, workingDir, serverConfig);

  const noopPlanningResult = maybeShortCircuitPlanningTask(task, workingDir, agenticPolicy);
  if (noopPlanningResult) {
    const completedAt = new Date().toISOString();
    safeUpdateTaskStatus(taskId, 'completed', {
      output: noopPlanningResult.output,
      exit_code: 0,
      progress_percent: 100,
      started_at: completedAt,
      completed_at: completedAt,
      task_metadata: JSON.stringify(noopPlanningResult.taskMetadata),
    });

    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent('completed', db.getTask(taskId));
    } catch { /* non-fatal */ }

    logger.info(`[Agentic] API task ${taskId} short-circuited: ${noopPlanningResult.taskMetadata.agentic_noop_reason}`);
    dashboard.notifyTaskUpdated(taskId);
    if (typeof handleWorkflowTermination === 'function') {
      try { handleWorkflowTermination(taskId); } catch (e) {
        logger.info(`[Agentic] handleWorkflowTermination error for API task ${taskId}: ${e.message}`);
      }
    }
    processQueue();
    return;
  }

  // Resolve host URL for the provider
  const host = PROVIDER_HOST_MAP[provider] || '';

  // Build system prompt (use default for cloud providers)
  const basePrompt = providerConfig.resolveSystemPrompt(model);
  const systemPrompt = appendTaskPolicyGuidance(
    buildAgenticSystemPrompt(basePrompt, workingDir),
    agenticPolicy
  );

  // Update status
  db.updateTaskStatus(taskId, 'running', {
    started_at: new Date().toISOString(),
    progress_percent: 10,
  });
  dashboard.notifyTaskUpdated(taskId);

  const ollamaStreamId = db.getOrCreateTaskStream(taskId, 'output');
  // timeout_minutes === 0 → no enforced timeout (opt-in unbounded). Preserve
  // 0, skip the setTimeout; abort still fires on cancelTask / cancelled-sweep.
  const parsedTimeout = parseInt(task.timeout_minutes, 10);
  const timeoutMinutes = Number.isFinite(parsedTimeout) ? parsedTimeout : 30;
  const abortController = new AbortController();
  // Register abort controller for cancellation support
  const apiAbortControllers2 = _agenticDeps.apiAbortControllers || (_executeApiModule && _executeApiModule._apiAbortControllers);
  if (apiAbortControllers2) apiAbortControllers2.set(taskId, abortController);
  const timeoutHandle = timeoutMinutes === 0
    ? null
    : setTimeout(() => abortController.abort(), timeoutMinutes * 60 * 1000);
  const cancelCheckInterval = setInterval(() => {
    try {
      const t = db.getTask(taskId);
      if (t && t.status === 'cancelled') {
        abortController.abort();
        clearInterval(cancelCheckInterval);
      }
    } catch { /* ignore */ }
  }, 2000);
  // Hoisted so the finally block can call removeEventListener for cleanup
  let origAbortHandler2 = null;
  let cleanupTrackedWorker = null;

  try {
    logger.info(`[Agentic] Starting API task ${taskId} with provider ${provider}, model ${model}`);

    // Category-aware max iterations: complex tasks get more room
    const baseMaxIter2 = parseInt(serverConfig.get('agentic_max_iterations') || '15', 10);
    const taskComplexity2 = task.complexity || 'normal';
    const defaultMaxIterations = taskComplexity2 === 'complex' ? Math.max(baseMaxIter2, 20) : baseMaxIter2;
    const maxIterations = agenticPolicy.maxIterations || defaultMaxIterations;

    // Derive context budget from provider capabilities
    const PROVIDER_CONTEXT_BUDGETS = {
      'google-ai': 200000, 'deepinfra': 64000, 'hyperbolic': 64000,
      'groq': 32000, 'cerebras': 32000, 'openrouter': 64000, 'ollama-cloud': 64000,
    };
    const contextBudget = PROVIDER_CONTEXT_BUDGETS[provider] || 16000;

    // Check if task has a routing chain (set by smart routing template resolution)
    let chain = null;
    try {
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}') : (task.metadata || {});
      chain = meta._routing_chain;
    } catch { /* ignore parse errors */ }

    // Shared callbacks for both single-provider and fallback-chain paths
    const workerCallbacks = {
      onProgress: (msg) => {
        try {
          db.updateTaskStatus(taskId, 'running', {
            progress_percent: Math.min(85, 10 + Math.floor((msg.iteration / msg.maxIterations) * 75)),
            output: `[Agentic: iteration ${msg.iteration}/${msg.maxIterations}, last tool: ${msg.lastTool || 'none'}]`,
          });
          dashboard.notifyTaskUpdated(taskId);
        } catch { /* ignore */ }
      },
      onToolCall: (msg) => {
        try {
          dashboard.notifyTaskOutput(taskId, `[tool:${msg.name}] ${msg.result?.slice(0, 50) || 'ok'}\n`);
        } catch { /* ignore */ }
      },
      onChunk: (msg) => {
        try {
          db.addStreamChunk(ollamaStreamId, msg.text, 'stdout');
          dashboard.notifyTaskOutput(taskId, msg.text);
        } catch { /* ignore */ }
      },
      onLog: (msg) => {
        logger[msg.level || 'info'](msg.message);
      },
    };

    let result;
    let snapshot = null;
    let completionGitReport = null;

    // Capture git snapshot ONCE before chain/single-provider branch so the
    // completion-failure revert path always has access to it (fixes null-snapshot
    // bug where chain-routed tasks never reverted on failure).
    try {
      snapshot = captureSnapshot(workingDir);
    } catch (e) {
      logger.info(`[Agentic] Git snapshot failed (non-git repo?): ${e.message}`);
    }

    if (chain && Array.isArray(chain) && chain.length > 1) {
      // Multi-provider fallback chain — delegate to executeWithFallback
      logger.info(`[Agentic] API task ${taskId} using fallback chain (${chain.length} entries): ${chain.map(e => e.provider).join(' -> ')}`);

      const buildConfig = (entry) => {
        const entryAdapterType = entry.provider === 'ollama-cloud' ? 'ollama'
          : entry.provider === 'google-ai' ? 'google'
          : 'openai';
        return {
          adapterType: entryAdapterType,
          adapterOptions: {
            host: PROVIDER_HOST_MAP[entry.provider] || '',
            apiKey: resolveApiKey(entry.provider),
            providerName: entry.provider,
            model: entry.model || PROVIDER_DEFAULT_MODEL[entry.provider] || '',
            temperature: 0.3,
          },
          systemPrompt,
          taskPrompt: preStuffFileContents(task.task_description, workingDir, (PROVIDER_CONTEXT_BUDGETS[entry.provider] || contextBudget) * 3),
          workingDir,
          timeoutMs,
          maxIterations,
          contextBudget: PROVIDER_CONTEXT_BUDGETS[entry.provider] || contextBudget,
          promptInjectedTools: needsPromptInjection(entry.model || ''),
          commandMode: agenticPolicy.commandMode,
          commandAllowlist: agenticPolicy.commandAllowlist,
          toolAllowlist: agenticPolicy.toolAllowlist,
          actionlessIterationLimit: agenticPolicy.actionlessIterationLimit,
          readAllowlist: agenticPolicy.readAllowlist,
          writeAllowlist: agenticPolicy.writeAllowlist,
          writeAfterReadPaths: agenticPolicy.writeAfterReadPaths,
          diagnosticReadLimitAfterFailedCommand: agenticPolicy.diagnosticReadLimitAfterFailedCommand,
        };
      };

      result = await executeWithFallback(task, chain, buildConfig, workerCallbacks, agenticPolicy);
      logger.info(`[Agentic] API task ${taskId} completed via chain position ${result.chainPosition}: ${result.provider}/${result.model || 'default'}`);
    } else {
      // Single-provider path (no chain or single-entry chain)
      // Resolve adapter type for the worker
      const adapterType = provider === 'ollama-cloud' ? 'ollama'
        : provider === 'google-ai' ? 'google'
        : 'openai';

      // Spawn worker thread for the agentic loop
      logger.debug(`[WORKER-DEBUG] Spawning worker for API task ${taskId}, provider=${provider}, model=${model}, adapterType=${adapterType}`);
      const workerHandle = spawnAgenticWorker({
        adapterType,
        adapterOptions: {
          host,
          apiKey,
          providerName: provider,
          model,
          temperature: 0.3,
        },
        systemPrompt,
        taskPrompt: preStuffFileContents(task.task_description, workingDir, contextBudget * 3),
        workingDir,
        timeoutMs,
        maxIterations,
        contextBudget,
        promptInjectedTools: false,
        commandMode: agenticPolicy.commandMode,
        commandAllowlist: agenticPolicy.commandAllowlist,
        toolAllowlist: agenticPolicy.toolAllowlist,
        actionlessIterationLimit: agenticPolicy.actionlessIterationLimit,
        readAllowlist: agenticPolicy.readAllowlist,
        writeAllowlist: agenticPolicy.writeAllowlist,
        writeAfterReadPaths: agenticPolicy.writeAfterReadPaths,
        diagnosticReadLimitAfterFailedCommand: agenticPolicy.diagnosticReadLimitAfterFailedCommand,
      }, buildTrackedAgenticCallbacks(taskId, workerCallbacks));
      cleanupTrackedWorker = trackAgenticWorkerTask(taskId, {
        workerHandle,
        abortController,
        provider,
        model,
        workingDir,
        timeoutHandle,
      });

      // Wire abort: forward AbortController.abort() → worker abort message
      origAbortHandler2 = () => workerHandle.abort();
      abortController.signal.addEventListener('abort', origAbortHandler2);

      result = await workerHandle.promise;

      // Git safety check in main thread (after worker completes)
      if (snapshot && snapshot.isGitRepo) {
        const safetyMode = serverConfig.get('agentic_git_safety') || 'on';
        const mode = safetyMode === 'on' ? 'enforce' : safetyMode === 'warn' ? 'warn' : 'off';
        const gitReport = checkAndRevert(workingDir, snapshot, task.task_description, mode, buildGitSafetyOptions(agenticPolicy));
        completionGitReport = gitReport;
        if (gitReport.report) {
          result.output += '\n\n--- Git Safety ---\n' + gitReport.report;
        }
      }
    }

    const sessionLogTarget = resolveAgenticSessionLogTarget(task, workingDir, agenticPolicy);
    const reviewedChangedFiles = sessionLogTarget
      ? mergeChangedFiles(result?.changedFiles, [sessionLogTarget.absolutePath])
      : mergeChangedFiles(result?.changedFiles);
    const completionFailure = evaluateAgenticCompletion(
      task,
      workingDir,
      agenticPolicy,
      result,
      maxIterations,
      result?.gitReport || completionGitReport,
      { changedFilesOverride: reviewedChangedFiles }
    );
    const revertResult = completionFailure
      ? maybeRevertFailedAgenticChanges(task, workingDir, agenticPolicy, snapshot, result)
      : null;
    let failureMessage = completionFailure?.message || '';
    if (revertResult?.report) {
      failureMessage = failureMessage ? `${failureMessage}\n${revertResult.report}` : revertResult.report;
    }
    const completedAt = new Date().toISOString();
    const sessionLogResult = maybeAppendAgenticSessionLog(task, workingDir, agenticPolicy, result, {
      status: completionFailure ? 'failed' : 'completed',
      outcomeMessage: failureMessage || 'Task completed successfully.',
      verificationCommand: completionFailure?.verificationCommand || resolveTaskVerificationCommand(task, workingDir, agenticPolicy),
      revertReport: revertResult?.report || '',
      timestamp: completedAt,
    }, sessionLogTarget);
    if (sessionLogResult?.appended) {
      result.changedFiles = reviewedChangedFiles;
      result.frameworkPreservedFiles = mergeChangedFiles(result?.frameworkPreservedFiles, [sessionLogResult.absolutePath]);
      appendAgenticOutputSection(result, 'Framework Session Log', `Appended ${sessionLogResult.relativePath}`);
    } else if (sessionLogTarget && sessionLogResult?.error) {
      const sessionLogError = `Framework session log append failed: ${sessionLogResult.relativePath} (${sessionLogResult.error})`;
      failureMessage = failureMessage ? `${failureMessage}\n${sessionLogError}` : sessionLogError;
      appendAgenticOutputSection(result, 'Framework Session Log', `Failed to append ${sessionLogResult.relativePath}: ${sessionLogResult.error}`);
    }
    if (completionFailure || (sessionLogTarget && sessionLogResult?.error)) {
      safeUpdateTaskStatus(taskId, 'failed', {
        output: result.output || '',
        error_output: failureMessage,
        exit_code: 1,
        progress_percent: 100,
        completed_at: completedAt,
        task_metadata: JSON.stringify({
          agentic_log: result.toolLog,
          agentic_token_usage: result.tokenUsage,
          agentic_failure_reason: failureMessage,
          ...(revertResult ? { agentic_reverted_changes: revertResult.reverted, agentic_revert_report: revertResult.report } : {}),
          ...(result.chainPosition ? { chain_provider: result.provider, chain_position: result.chainPosition } : {}),
          ...(completionFailure?.verificationCommand ? { verification_command: completionFailure.verificationCommand } : {}),
        }),
      });

      try {
        const { dispatchTaskEvent } = require('../hooks/event-dispatch');
        dispatchTaskEvent('failed', db.getTask(taskId));
      } catch { /* non-fatal */ }

      logger.info(`[Agentic] API task ${taskId} marked failed after completion review: ${failureMessage}`);
      return;
    }

    // Store result + metadata in a single status update (avoid double-complete race)
    safeUpdateTaskStatus(taskId, 'completed', {
      output: result.output || '',
      exit_code: 0,
      progress_percent: 100,
      completed_at: completedAt,
      task_metadata: JSON.stringify({
        agentic_log: result.toolLog,
        agentic_token_usage: result.tokenUsage,
        ...(result.chainPosition ? { chain_provider: result.provider, chain_position: result.chainPosition } : {}),
      }),
    });

    // Dispatch completion event so await_task/await_workflow wake up immediately
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent('completed', db.getTask(taskId));
    } catch { /* non-fatal */ }

    logger.info(`[Agentic] API task ${taskId} completed: ${result.iterations} iterations, ${(result.toolLog || []).length} tool calls, ${(result.changedFiles || []).length} files changed`);

    // Diffusion compute→apply: if this is a compute task, create the apply task dynamically
    try {
      const completedTask = db.getTask(taskId);
      const meta = completedTask?.metadata ? (typeof completedTask.metadata === 'string' ? JSON.parse(completedTask.metadata) : completedTask.metadata) : {};
      if (meta.diffusion_role === 'compute') {
        const computeRawOutput = result.output || '';
        logger.info(`[Diffusion] Agentic compute task ${taskId} output: ${computeRawOutput.length} chars`);
        const { parseComputeOutput, validateComputeSchema, semanticValidateEdits } = require('../diffusion/compute-output-parser');
        const { expandApplyTaskDescription } = require('../diffusion/planner');
        const parsed = parseComputeOutput(computeRawOutput);
        logger.info(`[Diffusion] Compute parse result: ${parsed ? `valid (${parsed.file_edits?.length} edits)` : 'null (parse failed)'}`);
        if (parsed) {
          const validation = validateComputeSchema(parsed);
          if (validation.valid) {
            // Semantic validation: filter out unsafe edits, log warnings
            const semantic = semanticValidateEdits(parsed, (filePath) => {
              const fullPath = require('path').resolve(completedTask.working_directory, filePath);
              return require('fs').readFileSync(fullPath, 'utf-8');
            });
            if (semantic.warnings.length > 0) {
              logger.info(`[Diffusion] Semantic warnings for compute ${taskId}: ${semantic.warnings.join('; ')}`);
            }
            const filteredOutput = { ...parsed, file_edits: semantic.file_edits };
            if (filteredOutput.file_edits.length === 0) {
              logger.info(`[Diffusion] All edits filtered by semantic validation for compute ${taskId} — skipping apply`);
            } else {
            const applyId = require('uuid').v4();
            // Round-robin across available apply providers
            const applyProviderList = Array.isArray(meta.apply_providers) && meta.apply_providers.length > 0
              ? meta.apply_providers
              : [meta.apply_provider || 'ollama'];
            const applyIndex = parseInt(taskId.replace(/[^0-9a-f]/g, '').slice(-4), 16) % applyProviderList.length;
            const applyProvider = applyProviderList[applyIndex];
            const applyDesc = expandApplyTaskDescription(filteredOutput, completedTask.working_directory);
            db.createTask({
              id: applyId,
              status: 'queued',
              task_description: applyDesc,
              working_directory: completedTask.working_directory,
              workflow_id: completedTask.workflow_id,
              provider: applyProvider,
              metadata: JSON.stringify({
                diffusion: true,
                diffusion_role: 'apply',
                compute_task_id: taskId,
                compute_output: parsed,
                // auto_verify_on_completion: false — verify runs at workflow level, not per-task
                verify_command: meta.verify_command || null,
                user_provider_override: true,
                requested_provider: applyProvider,
              }),
            });
            logger.info(`[Diffusion] Created apply task ${applyId} from agentic compute ${taskId}`);
            // Update workflow counts so await_workflow tracks the new apply task
            if (completedTask.workflow_id) {
              try {
                const workflowEngine = require('../db/workflow-engine');
                workflowEngine.updateWorkflowCounts(completedTask.workflow_id);
                // Reset workflow to running if it completed prematurely (all computes done but applies pending)
                const wf = workflowEngine.getWorkflow(completedTask.workflow_id);
                if (wf && wf.status === 'completed') {
                  workflowEngine.updateWorkflow(completedTask.workflow_id, { status: 'running' });
                  logger.info(`[Diffusion] Reopened workflow ${completedTask.workflow_id} — apply tasks still pending`);
                }
              } catch (wfErr) {
                logger.info(`[Diffusion] Workflow count update error: ${wfErr.message}`);
              }
            }
            try {
              const startPromise = require('../task-manager').startTask(applyId);
              if (startPromise && typeof startPromise.catch === 'function') {
                startPromise.catch(err => logger.info(`[Diffusion] Async failure starting apply task ${applyId}: ${err.message}`));
              }
            } catch (startErr) {
              logger.info(`[Diffusion] Failed to auto-start apply task ${applyId}: ${startErr.message}`);
            }
            } // close: if (filteredOutput.file_edits.length > 0)
          } else {
            logger.info(`[Diffusion] Agentic compute ${taskId} schema invalid: ${validation.errors.join('; ')}`);
          }
        }
      }
    } catch (diffusionErr) {
      logger.debug(`[Diffusion] Agentic compute→apply hook error: ${diffusionErr.message}`);
    }

  } catch (error) {
    logger.info(`[Agentic] API task ${taskId} failed: ${error.message}`);
    safeUpdateTaskStatus(taskId, 'failed', {
      error_output: error.message,
      exit_code: 1,
      completed_at: new Date().toISOString(),
    });

    // Dispatch failure event so await_task/await_workflow wake up immediately
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent('failed', db.getTask(taskId));
    } catch { /* non-fatal */ }
  } finally {
    if (origAbortHandler2) abortController.signal.removeEventListener('abort', origAbortHandler2);
    clearInterval(cancelCheckInterval);
    clearTimeout(timeoutHandle);
    if (apiAbortControllers2) apiAbortControllers2.delete(taskId);
    cleanupTrackedWorker?.();
    dashboard.notifyTaskUpdated(taskId);
    // Workflow termination in both success and failure paths
    if (typeof handleWorkflowTermination === 'function') {
      try { handleWorkflowTermination(taskId); } catch (e) {
        logger.info(`[Agentic] handleWorkflowTermination error for API task ${taskId}: ${e.message}`);
      }
    }
    processQueue();
  }
}

// ============================================================
// Fallback retry loop
// ============================================================

/**
 * Internal helper — delegates to _recordProviderOutcome when loaded.
 * Silently no-ops if the module is not available yet.
 *
 * @param {string} provider
 * @param {boolean} success
 */
function recordProviderOutcome(provider, success) {
  if (_recordProviderOutcome) _recordProviderOutcome(provider, success);
}

/**
 * Returns true for transient / rate-limit / infrastructure errors that should
 * trigger a provider fallback retry.  Returns false for permanent errors (bad
 * request, auth failure, tool logic errors) where retrying the same prompt on
 * another provider would not help.
 *
 * @param {Error} error
 * @returns {boolean}
 */
function isRetryableError(error) {
  const msg = (error.message || '').toLowerCase();
  // Auth errors are permanent — retrying on another provider won't help
  if (/invalid api key|unauthorized|authentication|forbidden/.test(msg)) return false;
  // Network-layer TypeErrors (e.g. "Failed to fetch", "fetch failed") are transient
  if (error instanceof TypeError && /fetch|network|connect/i.test(msg)) return true;
  // Use word-bounded status code matching to avoid false positives like "429 items" or "500 records"
  return /\b429\b|\b503\b|timeout|timed out|econnrefused|econnreset|quota|rate.?limit|overloaded|provider returned error|failed to fetch/.test(msg);
}

/**
 * Execute a task against a provider chain, falling back to the next entry
 * whenever a retryable error occurs.
 *
 * A git snapshot is captured ONCE before the first attempt.  Any partial
 * changes are reverted between attempts so each provider starts from a clean
 * state.  On success the normal git-safety check is applied (warn/enforce/off
 * per server config).
 *
 * @param {Object} task                          — task record
 * @param {Array<{provider:string,model?:string}>} chain — ordered fallback list
 * @param {function(entry): Object} buildWorkerConfig — builds workerData for spawnAgenticWorker
 * @param {Object} callbacks                     — {onProgress, onToolCall, onChunk, onLog}
 * @returns {Promise<Object>} result augmented with .provider, .model, .chainPosition
 */
async function executeWithFallback(task, chain, buildWorkerConfig, callbacks, agenticPolicy = null) {
  const workingDir = task.working_directory || process.cwd();

  // Capture git snapshot ONCE before any attempts
  let snapshot = null;
  try { snapshot = captureSnapshot(workingDir); } catch { /* non-git dir */ }

  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const config = buildWorkerConfig(entry);

    logger.info(`[Routing] Trying ${entry.provider}/${entry.model || 'default'} (${i + 1}/${chain.length})`);

    let workerHandle;
    let cleanupTrackedWorker = null;
    try {
      workerHandle = spawnAgenticWorker(config, buildTrackedAgenticCallbacks(task.id, callbacks));
      cleanupTrackedWorker = trackAgenticWorkerTask(task.id, {
        workerHandle,
        provider: entry.provider,
        model: entry.model || null,
        workingDir,
      });
      const result = await workerHandle.promise;
      let gitReport = null;

      // Success — run git safety and return
      if (snapshot && snapshot.isGitRepo) {
        const serverConfig = require('../config');
        const safetyMode = serverConfig.get('agentic_git_safety') || 'on';
        const mode = safetyMode === 'warn' ? 'warn' : safetyMode === 'off' ? 'off' : 'enforce';
        gitReport = checkAndRevert(workingDir, snapshot, task.task_description, mode, buildGitSafetyOptions(agenticPolicy));
        if (gitReport.report) result.output += '\n\n--- Git Safety ---\n' + gitReport.report;
      }

      // Record success
      try { recordProviderOutcome(entry.provider, true); } catch { /* non-critical */ }

      return { ...result, provider: entry.provider, model: entry.model, chainPosition: i + 1, gitReport };

    } catch (error) {
      lastError = error;

      // Terminate the stuck worker
      if (workerHandle) try { workerHandle.terminate(); } catch { /* ignore */ }

      // Revert any partial changes before retrying
      if (snapshot && snapshot.isGitRepo) {
        try { checkAndRevert(workingDir, snapshot, task.task_description, 'enforce', buildGitSafetyOptions(agenticPolicy)); } catch { /* ignore */ }
      }

      // Record failure
      try { recordProviderOutcome(entry.provider, false); } catch { /* non-critical */ }

      if (!isRetryableError(error) || i === chain.length - 1) {
        logger.info(`[Routing] ${entry.provider} failed (non-retryable or last in chain): ${error.message}`);
        throw error;
      }

      logger.info(`[Routing] Fallback: ${entry.provider}/${entry.model || 'default'} failed (${error.message.slice(0, 80)}), trying next (${i + 2}/${chain.length})`);
    } finally {
      cleanupTrackedWorker?.();
    }
  }

  throw lastError || new Error('All providers in chain failed');
}

// ============================================================
// Module exports — re-export all functions from sub-modules
// ============================================================

module.exports = {
  init,
  // Worker spawner (for tests and direct use)
  spawnAgenticWorker,
  // Fallback retry loop
  isRetryableError,
  executeWithFallback,
  // From execute-ollama.js (wrapped with agentic interceptor)
  estimateRequiredContext: _executeOllamaModule.estimateRequiredContext,
  executeOllamaTask: executeOllamaTaskWithAgentic,
  // From execute-api.js (wrapped with agentic interceptor for capable providers)
  executeApiProvider: executeApiProviderWithAgentic,
  // Hashline compatibility now routes through plain Ollama execution.
  executeHashlineOllamaTask: executeOllamaTaskWithAgentic,
  // From execute-cli.js
  buildAiderOllamaCommand: _executeCliModule.buildAiderOllamaCommand,
  buildClaudeCliCommand: _executeCliModule.buildClaudeCliCommand,
  buildCodexCommand: _executeCliModule.buildCodexCommand,
  spawnAndTrackProcess: _executeCliModule.spawnAndTrackProcess,
  // Legacy backward compat
  runAgenticPipeline,
};
