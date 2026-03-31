'use strict';

const childProcess = require('child_process');

const DEFAULT_VISIBLE_PROVIDERS = Object.freeze(['codex', 'claude-cli']);
const DEFAULT_TEST_COMMANDS = Object.freeze(['vitest', 'jest', 'pytest', 'dotnet test']);
const INSPECTION_TOOLS = new Set(['check_status', 'get_result']);
const CODEX_PROVIDERS = new Set(['codex', 'codex-spark']);

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

function checkInspectedBeforeCancel(task, rule, context) { // eslint-disable-line no-unused-vars
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

function checkPushedBeforeRemote(task) {
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
    const output = childProcess.execFileSync('git', ['log', 'origin/main..HEAD', '--oneline'], {
      cwd: task.working_directory,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim();

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

function checkDiffAfterCodex(task) {
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
    const diffStat = childProcess.execFileSync('git', ['diff', '--stat', 'HEAD'], {
      cwd: task.working_directory,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim();

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

function checkRequireWorktree(task, _rule, _context) {
  if (!task.working_directory) return { pass: true };
  try {
    const branch = childProcess.execFileSync('git', ['branch', '--show-current'], {
      cwd: task.working_directory, encoding: 'utf8', timeout: 5000, windowsHide: true,
    }).trim();
    if (branch === 'main' || branch === 'master') {
      // Check if worktrees exist
      const worktrees = childProcess.execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: task.working_directory, encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
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
  const config = safeParseConfig(rule.config, { commands: ['npm test', 'npx vitest', 'dotnet build', 'cargo build', 'go build', 'make'] });
  const desc = (task.task_description || '').toLowerCase();
  const matched = (config.commands || []).find(cmd => desc.includes(cmd.toLowerCase()));
  if (matched) {
    return { pass: false, message: `Build/test command "${matched}" should run via torque-remote, not locally.` };
  }
  return { pass: true };
}

function checkPushBeforeSubagentTests(task, _rule, _context) {
  const meta = safeParseConfig(task.metadata, {});
  if (!meta.subagent && !meta.dispatched_by_agent) return { pass: true };
  const desc = (task.task_description || '').toLowerCase();
  if (desc.includes('test') || desc.includes('vitest') || desc.includes('jest')) {
    if (task.working_directory) {
      try {
        const unpushed = childProcess.execFileSync('git', ['log', 'origin/main..HEAD', '--oneline'], {
          cwd: task.working_directory, encoding: 'utf8', timeout: 5000, windowsHide: true,
        }).trim();
        if (unpushed.length > 0) {
          return { pass: false, message: 'Subagent test task dispatched with unpushed commits. Push to origin/main first.' };
        }
      } catch (_) { /* git unavailable */ }
    }
  }
  return { pass: true };
}

function checkNoForceRestart(_task, _rule, context) {
  // Block force-restart/shutdown when tasks are running in the pipeline.
  // context.force: true means the caller requested a forced shutdown.
  // context.running: number of running tasks at the time of the request.
  if (context && context.force === true) {
    const running = context.running || 0;
    const queued = context.queued || 0;
    if (running > 0 || queued > 0) {
      return {
        pass: false,
        message: `Force-restart blocked: ${running} running, ${queued} queued tasks would be killed. Use await_restart to drain the pipeline first.`,
      };
    }
  }
  return { pass: true };
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

  function evaluate(stage, task, context = {}) {
    const blocked = [];
    const warned = [];
    const shadowed = [];
    const rules = governanceRules.getActiveRulesForStage(stage);
    const activeRules = Array.isArray(rules) ? rules : [];

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
        checkerResult = normalizeCheckerResult(checker(task, rule, context));
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

  return {
    CHECKERS,
    evaluate,
  };
}

module.exports = {
  CHECKERS,
  createGovernanceHooks,
};
