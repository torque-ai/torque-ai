'use strict';

const childProcess = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(childProcess.execFile);
const {
  evaluateBatchTestFixes,
  resolveChangeSetKey: resolveBatchTestFixesChangeSetKey,
} = require('./rules/batch-test-fixes');
const { GIT_SAFE_ENV, cleanupStaleGitStatusProcesses } = require('../utils/git');
const { findFirstUnroutedCommand } = require('../utils/heavy-validation-guard');

const DEFAULT_VISIBLE_PROVIDERS = Object.freeze(['codex', 'claude-cli']);
const DEFAULT_TEST_COMMANDS = Object.freeze(['vitest', 'jest', 'pytest', 'dotnet test']);
const DEFAULT_REMOTE_BUILD_COMMANDS = Object.freeze([
  'npm test',
  'npx vitest',
  'dotnet build',
  'dotnet test',
  'pwsh scripts/build.ps1',
  'pwsh -file scripts/build.ps1',
  'powershell scripts/build.ps1',
  'powershell -file scripts/build.ps1',
  'bash scripts/build.sh',
  'sh scripts/build.sh',
  './scripts/build.sh',
  'cargo build',
  'go build',
  'make',
]);
const INSPECTION_TOOLS = new Set(['check_status', 'get_result']);
const CODEX_PROVIDERS = new Set(['codex', 'codex-spark']);
const GIT_PROBE_OPTIONS = Object.freeze({
  encoding: 'utf8',
  timeout: 5000,
  windowsHide: true,
});

function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function resolveLogger(logger) {
  if (logger && typeof logger.child === 'function') {
    return logger.child({ component: 'governance-hooks' });
  }

  if (logger && typeof logger.info === 'function' && typeof logger.warn === 'function') {
    return logger;
  }

  return createNoopLogger();
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeCommandText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/\\/g, '/')
    .replace(/(^|\s)\.\//g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Treat malformed metadata/config as absent.
  }

  return {};
}

function normalizeStringList(values, fallback) {
  const source = Array.isArray(values) ? values : fallback;
  const normalized = source
    .map(value => normalizeString(value))
    .filter(Boolean);

  return normalized.length > 0
    ? Array.from(new Set(normalized))
    : Array.from(new Set(fallback.map(value => normalizeString(value)).filter(Boolean)));
}

function mergeNormalizedCommandList(values, fallback) {
  const source = [
    ...fallback,
    ...(Array.isArray(values) ? values : []),
  ];
  return Array.from(new Set(source.map(value => normalizeCommandText(value)).filter(Boolean)));
}

function getTaskMetadata(task) {
  return parseJsonObject(task && task.metadata);
}

function getRuleConfig(rule) {
  return parseJsonObject(rule && rule.config);
}

function safeParseConfig(value, defaults = {}) {
  const parsed = parseJsonObject(value);
  return { ...defaults, ...parsed };
}

function getTaskId(task) {
  return task?.id || task?.task_id || task?.taskId || null;
}

function createGitProbeContext() {
  return {
    unpushedCommits: new Map(),
    dirtyDiffStats: new Map(),
    currentBranches: new Map(),
    worktreeMetadata: new Map(),
  };
}

function getGitProbeContext(context) {
  if (context?.gitProbeCache) {
    return context.gitProbeCache;
  }

  const gitProbeCache = createGitProbeContext();
  if (context && typeof context === 'object') {
    context.gitProbeCache = gitProbeCache;
  }
  return gitProbeCache;
}

function runCachedGitProbe(context, cacheName, cwd, args) {
  const cache = getGitProbeContext(context)[cacheName];
  if (!cache.has(cwd)) {
    cache.set(
      cwd,
      execFileAsync('git', args, {
        cwd,
        ...GIT_PROBE_OPTIONS,
      }).then(({ stdout }) => String(stdout || '').trim()),
    );
  }
  return cache.get(cwd);
}

function getUnpushedCommits(cwd, context) {
  return runCachedGitProbe(context, 'unpushedCommits', cwd, ['log', 'origin/main..HEAD', '--oneline']);
}

function getDirtyDiffStat(cwd, context) {
  return runCachedGitProbe(context, 'dirtyDiffStats', cwd, ['diff', '--stat', 'HEAD']);
}

function getCurrentBranch(cwd, context) {
  return runCachedGitProbe(context, 'currentBranches', cwd, ['branch', '--show-current']);
}

function getWorktreeMetadata(cwd, context) {
  return runCachedGitProbe(context, 'worktreeMetadata', cwd, ['worktree', 'list', '--porcelain']);
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }
  return false;
}

function normalizeMode(mode) {
  const normalized = normalizeString(mode);
  if (normalized === 'block' || normalized === 'warn' || normalized === 'shadow' || normalized === 'off') {
    return normalized;
  }
  return 'warn';
}

function isRuleEnabled(rule) {
  if (!rule || !Object.prototype.hasOwnProperty.call(rule, 'enabled')) {
    return true;
  }

  if (typeof rule.enabled === 'boolean') return rule.enabled;
  if (typeof rule.enabled === 'number') return rule.enabled !== 0;
  if (typeof rule.enabled === 'string') {
    const normalized = rule.enabled.trim().toLowerCase();
    return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
  }

  return Boolean(rule.enabled);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCommandPattern(command) {
  const parts = String(command)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegex);

  if (parts.length === 0) {
    return null;
  }

  return new RegExp(`(^|[^\\w-])${parts.join('\\s+')}([^\\w-]|$)`, 'i');
}

function getRecentToolCalls(context) {
  return Array.isArray(context?.recentToolCalls) ? context.recentToolCalls : [];
}

function getToolName(call) {
  return normalizeString(call?.tool_name || call?.tool || call?.name);
}

function getToolArgs(call) {
  if (!call || typeof call !== 'object') return {};

  if (call.args && typeof call.args === 'object') return call.args;
  if (call.arguments && typeof call.arguments === 'object') return call.arguments;
  if (call.params && typeof call.params === 'object') return call.params;
  if (call.input && typeof call.input === 'object') return call.input;
  if (typeof call.args === 'string') return parseJsonObject(call.args);
  if (typeof call.arguments === 'string') return parseJsonObject(call.arguments);
  if (typeof call.params === 'string') return parseJsonObject(call.params);
  if (typeof call.input === 'string') return parseJsonObject(call.input);

  return {};
}

function matchesTaskId(call, taskId) {
  if (!taskId) return false;

  const args = getToolArgs(call);
  const candidates = [
    call?.task_id,
    call?.taskId,
    call?.id,
    args.task_id,
    args.taskId,
    args.id,
  ];

  return candidates.some(candidate => String(candidate || '') === String(taskId));
}

function checkVisibleProvider(task, rule) {
  const config = getRuleConfig(rule);
  const blockedProviders = normalizeStringList(config.providers, DEFAULT_VISIBLE_PROVIDERS);
  const metadata = getTaskMetadata(task);
  const taskProvider = normalizeString(task?.provider);
  const intendedProvider = normalizeString(metadata.intended_provider);
  const violatedProvider = blockedProviders.find(provider => provider === taskProvider || provider === intendedProvider);

  if (!violatedProvider) {
    return { pass: true };
  }

  return {
    pass: false,
    message: `Provider "${violatedProvider}" opens a visible terminal window. Request user consent first.`,
  };
}

function checkInspectedBeforeCancel(task, rule, context) {
  const taskId = getTaskId(task);
  const inspected = getRecentToolCalls(context).some((call) => {
    const toolName = getToolName(call);
    return INSPECTION_TOOLS.has(toolName) && matchesTaskId(call, taskId);
  });

  if (inspected) {
    return { pass: true };
  }

  return {
    pass: false,
    message: 'Check task status before cancelling. Use check_status or get_result first.',
  };
}

async function checkPushedBeforeRemote(task, _rule, context) {
  const metadata = getTaskMetadata(task);
  if (!coerceBoolean(metadata.remote_execution)) {
    return { pass: true };
  }

  if (!task?.working_directory) {
    return {
      pass: false,
      message: 'Push to origin/main before remote execution. Working directory is missing.',
    };
  }

  try {
    const output = await getUnpushedCommits(task.working_directory, context);

    if (!output) {
      return { pass: true };
    }

    return {
      pass: false,
      message: 'Push to origin/main before remote execution. Found unpushed commits.',
      unpushed_commits: output,
    };
  } catch (error) {
    return {
      pass: false,
      message: `Unable to verify push status before remote execution: ${error.message}`,
    };
  }
}

function checkNoLocalTests(task, rule) {
  const config = getRuleConfig(rule);
  const commands = normalizeStringList(config.commands, DEFAULT_TEST_COMMANDS);
  const description = String(task?.task_description || task?.description || '');
  const detectedCommand = commands.find((command) => {
    const pattern = buildCommandPattern(command);
    return pattern ? pattern.test(description) : false;
  });

  if (!detectedCommand) {
    return { pass: true };
  }

  return {
    pass: false,
    message: `Task description includes local test command "${detectedCommand}". Route tests to the remote workstation instead.`,
    detected_command: detectedCommand,
  };
}

async function checkDiffAfterCodex(task, _rule, context) {
  const metadata = getTaskMetadata(task);
  const provider = normalizeString(task?.provider || metadata.intended_provider);
  if (!CODEX_PROVIDERS.has(provider)) {
    return { pass: true };
  }

  if (!task?.working_directory) {
    return {
      pass: true,
      diff_stat: '',
      message: 'Working directory is missing; unable to capture git diff stat.',
    };
  }

  try {
    const diffStat = await getDirtyDiffStat(task.working_directory, context);

    return {
      pass: true,
      diff_stat: diffStat,
    };
  } catch (error) {
    return {
      pass: true,
      diff_stat: '',
      message: `Unable to capture git diff stat: ${error.message}`,
    };
  }
}

async function resolveBatchTestFixesChangeSet(task, context) {
  const explicit = resolveBatchTestFixesChangeSetKey(task, context);
  if (context?.change_set || context?.changeSet || context?.commit_range || context?.commitRange) {
    return explicit;
  }

  if (!task?.working_directory) {
    return explicit;
  }

  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=2', '--branch'], {
      cwd: task.working_directory,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: { ...process.env, ...GIT_SAFE_ENV },
    });
    // Use only branch info (# branch.head line), not file status which changes between runs
    const branchLine = stdout.split('\n').find(l => l.startsWith('# branch.head ')) || '';
    const branch = branchLine.replace('# branch.head ', '').trim() || 'unknown';
    const workflowKey = task?.workflow_id || context?.workflow_id || context?.workflowId || 'standalone';
    return `${workflowKey}::${task.working_directory}::${branch}`;
  } catch {
    cleanupStaleGitStatusProcesses({ force: true });
    // Fall back to the explicit/task-derived key when git metadata is unavailable.
  }

  return explicit;
}

async function checkBatchTestFixes(task, rule, context) {
  const changeSet = await resolveBatchTestFixesChangeSet(task, context);
  return evaluateBatchTestFixes({
    task,
    rule,
    context: {
      ...context,
      change_set: changeSet,
    },
  });
}

// ── New checkers for expanded governance rules ──

function checkNoProcessKill(task, rule, _context) {
  const config = safeParseConfig(rule.config, { commands: ['kill', 'taskkill', 'Stop-Process', 'pkill', 'killall'] });
  const desc = (task.task_description || '').toLowerCase();
  const blocked = (config.commands || []);
  const matched = blocked.find(cmd => desc.includes(cmd.toLowerCase()));
  if (matched) {
    return { pass: false, message: `Process kill command detected: "${matched}". Use cancel_task or cancel_workflow instead.` };
  }
  return { pass: true };
}

function checkNoDirectDbAccess(task, rule, _context) {
  const config = safeParseConfig(rule.config, { patterns: ['sqlite3', '.torque/torque.db', 'better-sqlite3'] });
  const desc = (task.task_description || '').toLowerCase();
  const matched = (config.patterns || []).find(p => desc.includes(p.toLowerCase()));
  if (matched) {
    return { pass: false, message: `Direct database access detected: "${matched}". Use MCP tools or REST API instead.` };
  }
  return { pass: true };
}

function checkNoForegroundBash(_task, _rule, context) {
  // This checker is advisory — it flags when bash is used without run_in_background
  if (context && context.tool === 'bash' && !context.run_in_background) {
    return { pass: false, message: 'Foreground bash detected. Use MCP tools or run_in_background: true.' };
  }
  return { pass: true };
}

async function checkRequireWorktree(task, _rule, _context) {
  if (!task.working_directory) return { pass: true };
  try {
    const branch = await getCurrentBranch(task.working_directory, _context);
    if (branch === 'main' || branch === 'master') {
      // Check if worktrees exist
      const worktrees = await getWorktreeMetadata(task.working_directory, _context);
      const worktreeCount = (worktrees.match(/^worktree /gm) || []).length;
      if (worktreeCount > 1) {
        return { pass: false, message: 'Feature work detected on main/master while worktrees exist. Develop in a worktree instead.' };
      }
    }
  } catch (_) { /* git not available or not a repo */ }
  return { pass: true };
}

function checkNoLargeFileFullRead(task, rule, _context) {
  const config = safeParseConfig(rule.config, { threshold_lines: 300 });
  const desc = (task.task_description || '').toLowerCase();
  // Check for patterns like "read the file" or "read file X" without line range instructions
  if (desc.includes('read the file') || desc.includes('read file')) {
    if (!desc.includes('start_line') && !desc.includes('line_range') && !desc.includes('search_files')) {
      const threshold = config.threshold_lines || 300;
      return { pass: false, message: `Task may instruct full file read. For files over ${threshold} lines, use search_files + line-range reads + replace_lines.` };
    }
  }
  return { pass: true };
}

function checkAnnotationsUpdated(task, _rule, _context) {
  // Informational: check if task output mentions adding/removing tools without mentioning annotations
  const output = (task.output || '').toLowerCase();
  const desc = (task.task_description || '').toLowerCase();
  if ((output.includes('tool-defs') || desc.includes('tool-defs') || desc.includes('mcp tool')) &&
      !output.includes('tool-annotations') && !desc.includes('tool-annotations')) {
    return { pass: false, message: 'MCP tools were added/modified but tool-annotations.js may not have been updated.' };
  }
  return { pass: true };
}

function checkRequireRemoteForBuilds(task, rule, _context) {
  const config = safeParseConfig(rule.config, {});
  const commands = mergeNormalizedCommandList(config.commands, DEFAULT_REMOTE_BUILD_COMMANDS);
  const matched = findFirstUnroutedCommand(task.task_description || '', commands);
  if (matched) {
    return {
      pass: false,
      message: `Build/test command "${matched}" should run via torque-remote, not locally.`,
      detected_command: matched,
    };
  }
  return { pass: true };
}

async function checkPushBeforeSubagentTests(task, _rule, context) {
  const meta = safeParseConfig(task.metadata, {});
  if (!meta.subagent && !meta.dispatched_by_agent) return { pass: true };
  const desc = (task.task_description || '').toLowerCase();
  if (desc.includes('test') || desc.includes('vitest') || desc.includes('jest')) {
    if (task.working_directory) {
      try {
        const unpushed = await getUnpushedCommits(task.working_directory, context);
        if (unpushed.length > 0) {
          return { pass: false, message: 'Subagent test task dispatched with unpushed commits. Push to origin/main first.' };
        }
      } catch (_) { /* git unavailable */ }
    }
  }
  return { pass: true };
}

function checkNoForceRestart(_task, _rule, context) {
  // Block force-shutdown while the pipeline has in-flight work. The shutdown
  // handler passes { force, running, queued } via context when a force flag
  // is present in the request body; we refuse unless the caller has proof of
  // operator override (context.operator_override === true).
  //
  // Stop-torque.sh and cutover paths should drain via await_restart first.
  // An emergency escape hatch for truly stuck pipelines is the explicit
  // operator_override flag in the request body.
  if (!context || context.force !== true) {
    return { pass: true };
  }
  const running = Number.isFinite(context.running) ? context.running : 0;
  const queued = Number.isFinite(context.queued) ? context.queued : 0;
  if (running === 0 && queued === 0) {
    return { pass: true };
  }
  if (context.operator_override === true) {
    return { pass: true };
  }
  return {
    pass: false,
    message: `Force-shutdown blocked: ${running} running + ${queued} queued task(s). Drain the pipeline via await_restart, or pass operator_override:true for emergency override.`,
  };
}

const CHECKERS = Object.freeze({
  checkVisibleProvider,
  checkInspectedBeforeCancel,
  checkPushedBeforeRemote,
  checkNoLocalTests,
  checkDiffAfterCodex,
  checkNoProcessKill,
  checkNoDirectDbAccess,
  checkNoForegroundBash,
  checkRequireWorktree,
  checkNoLargeFileFullRead,
  checkAnnotationsUpdated,
  checkRequireRemoteForBuilds,
  checkPushBeforeSubagentTests,
  checkNoForceRestart,
  checkBatchTestFixes,
});

function normalizeCheckerResult(result) {
  if (!result || typeof result !== 'object') {
    return { pass: true };
  }

  return {
    ...result,
    pass: result.pass !== false,
  };
}

function createGovernanceHooks({ governanceRules, logger } = {}) {
  if (!governanceRules || typeof governanceRules.getActiveRulesForStage !== 'function') {
    throw new Error('createGovernanceHooks requires governanceRules.getActiveRulesForStage(stage)');
  }

  const log = resolveLogger(logger);
  async function evaluate(stage, task, context = {}) {
    const blocked = [];
    const warned = [];
    const shadowed = [];
    const rules = governanceRules.getActiveRulesForStage(stage);
    const activeRules = Array.isArray(rules) ? rules : [];
    const evaluationContext = {
      ...context,
      gitProbeCache: createGitProbeContext(),
    };

    for (const rule of activeRules) {
      if (!rule || !isRuleEnabled(rule)) {
        continue;
      }

      const mode = normalizeMode(rule.mode);
      if (mode === 'off') {
        continue;
      }

      const checker = CHECKERS[rule.checker_id];
      if (typeof checker !== 'function') {
        continue;
      }

      let checkerResult;
      try {
        checkerResult = normalizeCheckerResult(await checker(task, rule, evaluationContext));
      } catch (error) {
        checkerResult = {
          pass: false,
          message: `Governance checker "${rule.checker_id}" failed: ${error.message}`,
        };
      }

      if (checkerResult.pass) {
        continue;
      }

      if (typeof governanceRules.incrementViolation === 'function' && rule.id) {
        governanceRules.incrementViolation(rule.id);
      }

      const entry = {
        rule_id: rule.id || null,
        checker_id: rule.checker_id,
        mode,
        ...checkerResult,
      };

      if (mode === 'block') {
        blocked.push(entry);
        log.warn(`Governance blocked at ${stage} for rule ${rule.id || rule.checker_id}: ${checkerResult.message || 'blocked'}`);
      } else if (mode === 'warn') {
        warned.push(entry);
        log.warn(`Governance warning at ${stage} for rule ${rule.id || rule.checker_id}: ${checkerResult.message || 'warned'}`);
      } else if (mode === 'shadow') {
        shadowed.push(entry);
        log.info(`Governance shadow result at ${stage} for rule ${rule.id || rule.checker_id}: ${checkerResult.message || 'shadowed'}`);
      }
    }

    return {
      blocked,
      warned,
      shadowed,
      allPassed: blocked.length === 0,
    };
  }

  async function evaluatePreVerify(task, context = {}) {
    return evaluate('pre-verify', task, context);
  }

  return {
    CHECKERS,
    evaluate,
    evaluatePreVerify,
  };
}

module.exports = {
  CHECKERS,
  createGovernanceHooks,
};
