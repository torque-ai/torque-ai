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

const CHECKERS = Object.freeze({
  checkVisibleProvider,
  checkInspectedBeforeCancel,
  checkPushedBeforeRemote,
  checkNoLocalTests,
  checkDiffAfterCodex,
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
