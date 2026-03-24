'use strict';

const configCore = require('../db/config-core');
const { ErrorCodes, makeError } = require('./error-codes');
const watcher = require('../ci/watcher');
const GitHubActionsProvider = require('../ci/github-actions');
const diagnostics = require('../ci/diagnostics');
const credentialCrypto = require('../utils/credential-crypto');

const DEFAULT_CI_PROVIDER = 'github-actions';

function resolveRepo(args) {
  if (args.repo) return args.repo;

  const fromConfig = configCore.getConfig('default_ci_repo');
  if (fromConfig) return fromConfig;

  try {
    const { execFileSync } = require('child_process');
    const result = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      {
        timeout: 10000,
        encoding: 'utf8',
        cwd: args.working_directory,
      },
    );
    return result.trim();
  } catch {
    return null;
  }
}

function requireRepo(args) {
  const repo = resolveRepo(args);
  if (!repo) {
    return { error: makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'repo is required (or set default_ci_repo)') };
  }
  return { repo };
}

function getRunId(args) {
  return typeof args.run_id === 'string' ? args.run_id.trim() : (typeof args.runId === 'string' ? args.runId.trim() : '');
}

function parseRunId(args) {
  const runId = getRunId(args);
  if (!runId) {
    return { error: makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'run_id is required') };
  }
  return { runId };
}

function parseProvider(args) {
  if (typeof args.provider === 'string' && args.provider.trim()) {
    return args.provider.trim();
  }
  return DEFAULT_CI_PROVIDER;
}

function parsePollInterval(args) {
  const value = args.poll_interval_ms ?? args.pollIntervalMs;
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function encryptWebhookSecret(secret) {
  const key = credentialCrypto.getOrCreateKey();
  const { encrypted_value, iv, auth_tag } = credentialCrypto.encrypt(secret, key);
  return `ENC:${encrypted_value}:${iv}:${auth_tag}`;
}

function createProvider(args, repo) {
  if (args.provider && typeof args.provider === 'object' && args.provider !== null) {
    return args.provider;
  }

  return new GitHubActionsProvider({
    name: parseProvider(args),
    repo,
  });
}

function redactWebhookSecret(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '<not configured>';
  }
  return '*'.repeat(Math.min(value.length, 12));
}

function formatRunMarkdown(run) {
  const runId = run.id || run.run_id || 'unknown';
  let output = `## CI Run Status\n\n`;
  output += `| Field | Value |\n`;
  output += `|-------|-------|\n`;
  output += `| Run ID | ${runId} |\n`;
  output += `| Status | ${run.status || 'unknown'} |\n`;
  output += `| Conclusion | ${run.conclusion || run.status || 'unknown'} |\n`;
  output += `| Repository | ${run.repository || run.repo || 'unknown'} |\n`;
  output += `| Branch | ${run.branch || 'unknown'} |\n`;
  output += `| SHA | ${run.sha || 'N/A'} |\n`;
  if (run.url) {
    output += `| URL | ${run.url} |\n`;
  }
  if (run.createdAt) {
    output += `| Created | ${run.createdAt} |\n`;
  }
  return output;
}

function formatRunsMarkdown(runs) {
  let output = `## CI Runs\n\n`;
  if (!runs || runs.length === 0) {
    output += `No CI runs found for repository.`;
    return output;
  }

  output += `| Run ID | Status | Conclusion | Branch | SHA | URL |\n`;
  output += `|--------|--------|------------|--------|-----|-----|\n`;
  for (const run of runs) {
    output += `| ${run.id || 'N/A'} | ${run.status || 'N/A'} | ${run.conclusion || 'N/A'} | ${run.branch || 'N/A'} | ${run.sha || 'N/A'} | ${run.url || 'N/A'} |\n`;
  }
  return output;
}

async function handleAwaitCiRun(args) {
  try {
    const repoResult = requireRepo(args);
    if (repoResult.error) {
      return repoResult.error;
    }
    const runIdResult = parseRunId(args);
    if (runIdResult.error) {
      return runIdResult.error;
    }

    if (typeof watcher.awaitRun !== 'function') {
      return makeError(ErrorCodes.OPERATION_FAILED, 'CI await is not available in this build');
    }

    const shouldDiagnose = args.diagnose !== false;
    const provider = createProvider(args, repoResult.repo);
    const run = await watcher.awaitRun({
      repo: repoResult.repo,
      provider: parseProvider(args),
      runId: runIdResult.runId,
      pollIntervalMs: parsePollInterval(args),
      timeoutMs: ((args.timeout_minutes ?? 30) * 60 * 1000),
    });

    if (!run || typeof run !== 'object') {
      return makeError(ErrorCodes.PROVIDER_ERROR, 'Awaited run was missing');
    }

    if (run.status === 'timed_out' || run.timed_out || run.conclusion === 'timed_out') {
      return makeError(ErrorCodes.TIMEOUT, `CI run ${runIdResult.runId} timed out`);
    }

    if (run.status === 'failure' || run.conclusion === 'failure') {
      if (!shouldDiagnose) {
        return { content: [{ type: 'text', text: `## CI Run Failed\n\n${formatRunMarkdown(run)}` }] };
      }
      const logs = await provider.getFailureLogs(String(run.id || runIdResult.runId));
      const diagnosis = diagnostics.diagnoseFailures(logs, {
        conclusion: run.conclusion || run.status || 'failure',
        runId: String(run.id || runIdResult.runId),
      });

      return {
        content: [{ type: 'text', text: diagnosis.triage || `No actionable CI failures found for run ${runIdResult.runId}.` }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: `## CI Run Completed\n\n${formatRunMarkdown(run)}`
      }],
    };
  } catch (err) {
    const message = err.message || String(err);
    if (message.toLowerCase().includes('timed out') || message.toLowerCase().includes('timeout')) {
      return makeError(ErrorCodes.TIMEOUT, message);
    }
    return makeError(ErrorCodes.PROVIDER_ERROR, `Failed to await CI run: ${message}`);
  }
}

async function handleWatchCiRepo(args) {
  try {
    const repoResult = requireRepo(args);
    if (repoResult.error) {
      return repoResult.error;
    }

    const provider = parseProvider(args);
    const watch = await watcher.watchRepo({
      repo: repoResult.repo,
      provider,
      branch: args.branch || null,
      pollIntervalMs: parsePollInterval(args),
    });

    let output = `## CI Watch Started\n\n`;
    output += `Repository **${watch.repo}** is now being watched for provider **${watch.provider}**.\n`;
    output += `**Watch ID:** ${watch.id || 'N/A'}\n`;
    output += `**Branch:** ${watch.branch || 'default'}\n`;
    output += `**Poll Interval:** ${watch.poll_interval_ms || parsePollInterval(args) || 30000}ms`;

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (err) {
    return makeError(ErrorCodes.PROVIDER_ERROR, `Failed to watch CI repo: ${err.message || err}`);
  }
}

function handleStopCiWatch(args) {
  const repoResult = resolveRepo(args);
  const requestedProvider = parseProvider(args);
  let repo = repoResult;
  let provider = requestedProvider;

  if (!repo && args.watch_id) {
    const active = watcher.getActiveWatches?.();
    if (!active || !Array.isArray(active) || active.length === 0) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `No active CI watch found for id ${args.watch_id}`);
    }

    const target = active.find((entry) => String(entry.id) === String(args.watch_id));
    if (!target) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `No active CI watch found for id ${args.watch_id}`);
    }

    repo = target.repo;
    provider = target.provider || provider;
  }

  if (!repo) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'repo or watch_id is required');
  }
  if (!provider) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider is required when stopping by repo');
  }

  const stopped = watcher.stopWatch({
    repo,
    provider,
  });

  return {
    content: [{
      type: 'text',
      text: `## CI Watch Stopped\n\n` +
        `Watch stopped for repository **${repo}** using provider **${provider}**.\n` +
        `Database record updated: ${Boolean(stopped).toString()}`,
    }],
  };
}

async function handleCiRunStatus(args) {
  try {
    const repoResult = requireRepo(args);
    if (repoResult.error) {
      return repoResult.error;
    }
    const runIdResult = parseRunId(args);
    if (runIdResult.error) {
      return runIdResult.error;
    }

    const provider = createProvider(args, repoResult.repo);
    const run = await provider.getRun(runIdResult.runId);
    return {
      content: [{ type: 'text', text: formatRunMarkdown(run) }],
    };
  } catch (err) {
    return makeError(ErrorCodes.PROVIDER_ERROR, `Failed to get CI run status: ${err.message || err}`);
  }
}

async function handleDiagnoseCiFailure(args) {
  try {
    const repoResult = requireRepo(args);
    if (repoResult.error) {
      return repoResult.error;
    }
    const runIdResult = parseRunId(args);
    if (runIdResult.error) {
      return runIdResult.error;
    }

    const provider = createProvider(args, repoResult.repo);
    const log = await provider.getFailureLogs(runIdResult.runId);
    const report = diagnostics.diagnoseFailures(log, { runId: runIdResult.runId });

    return {
      content: [{ type: 'text', text: report.triage || `No actionable CI failures found for run ${runIdResult.runId}.` }],
    };
  } catch (err) {
    return makeError(ErrorCodes.PROVIDER_ERROR, `Failed to diagnose CI failure: ${err.message || err}`);
  }
}

async function handleListCiRuns(args) {
  try {
    const repoResult = requireRepo(args);
    if (repoResult.error) {
      return repoResult.error;
    }

    const provider = createProvider(args, repoResult.repo);
    const filters = {
      branch: args.branch,
      status: args.status,
      limit: args.limit,
    };
    const runs = await provider.listRuns(filters);

    return {
      content: [{ type: 'text', text: formatRunsMarkdown(Array.isArray(runs) ? runs : []) }],
    };
  } catch (err) {
    return makeError(ErrorCodes.PROVIDER_ERROR, `Failed to list CI runs: ${err.message || err}`);
  }
}

function handleConfigureCiProvider(args) {
  const updates = {};

  if (args.default_repo !== undefined) {
    if (typeof args.default_repo !== 'string' || !args.default_repo.trim()) {
      return makeError(ErrorCodes.INVALID_PARAM, 'default_repo must be a non-empty string');
    }
    updates.default_repo = args.default_repo.trim();
  }

  if (args.webhook_secret !== undefined) {
    if (typeof args.webhook_secret !== 'string') {
      return makeError(ErrorCodes.INVALID_PARAM, 'webhook_secret must be a string');
    }
    updates.webhook_secret = args.webhook_secret;
  }

  if (args.poll_interval_ms !== undefined) {
    const parsed = Number.parseInt(args.poll_interval_ms, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return makeError(ErrorCodes.INVALID_PARAM, 'poll_interval_ms must be a positive integer');
    }
    updates.poll_interval_ms = String(parsed);
  }

  if (Object.keys(updates).length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'At least one of default_repo, webhook_secret, or poll_interval_ms is required');
  }

  if (updates.default_repo !== undefined) {
    configCore.setConfig('default_ci_repo', updates.default_repo);
  }
  if (updates.webhook_secret !== undefined) {
    try {
      updates.webhook_secret = encryptWebhookSecret(updates.webhook_secret);
      configCore.setConfig('webhook_secret', updates.webhook_secret);
    } catch (err) {
      return makeError(ErrorCodes.OPERATION_FAILED, `Failed to encrypt webhook_secret: ${err.message || err}`);
    }
  }
  if (updates.poll_interval_ms !== undefined) {
    configCore.setConfig('poll_interval_ms', updates.poll_interval_ms);
  }

  let output = `## CI Provider Configured\n\n`;
  if (updates.default_repo !== undefined) {
    output += `- **default_repo:** ${updates.default_repo}\n`;
  }
  if (updates.webhook_secret !== undefined) {
    output += `- **webhook_secret:** ${redactWebhookSecret(updates.webhook_secret)}\n`;
  }
  if (updates.poll_interval_ms !== undefined) {
    output += `- **poll_interval_ms:** ${updates.poll_interval_ms}\n`;
  }

  return {
    content: [{ type: 'text', text: output }],
  };
}

function createCiHandlers() {
  return {
    resolveRepo,
    handleAwaitCiRun,
    handleWatchCiRepo,
    handleStopCiWatch,
    handleCiRunStatus,
    handleDiagnoseCiFailure,
    handleListCiRuns,
    handleConfigureCiProvider,
  };
}

module.exports = {
  resolveRepo,
  handleAwaitCiRun,
  handleWatchCiRepo,
  handleStopCiWatch,
  handleCiRunStatus,
  handleDiagnoseCiFailure,
  handleListCiRuns,
  handleConfigureCiProvider,
  createCiHandlers,
};
