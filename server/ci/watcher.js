/**
 * Background CI watch utilities.
 */
'use strict';

const { randomUUID } = require('crypto');
const GitHubActionsProvider = require('./github-actions');
const { diagnoseFailures } = require('./diagnostics');
const database = require('../database');

// Lazy require to break circular dependency: mcp-sse → tools → ci-handlers → watcher → mcp-sse
let _mcpSse;
function getMcpSse() {
  if (!_mcpSse) _mcpSse = require('../mcp-sse');
  return _mcpSse;
}

const _activeTimers = new Map();
const MAX_WATCHES = 10;

function _getDb() {
  if (typeof database.getDbInstance === 'function') {
    return database.getDbInstance();
  }

  if (typeof database.getDb === 'function') {
    return database.getDb();
  }

  throw new Error('Database handle is not available');
}

function _normalizeRunTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function _parseRunCreatedAt(run) {
  if (!run || typeof run !== 'object') return Number.NaN;
  return _normalizeRunTimestamp(run.created_at || run.createdAt || run.created_at_time || run.created);
}

function _runKey(repo, provider) {
  return `${repo}:${provider}`;
}

function _validateOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('watchRepo options must be an object');
  }

  if (typeof options.repo !== 'string' || !options.repo.trim()) {
    throw new Error('watchRepo requires a non-empty repo');
  }

  if (!options.provider) {
    throw new Error('watchRepo requires a provider');
  }
}

function _resolveProvider(provider, repo) {
  if (typeof provider === 'string') {
    if (provider === 'github-actions') {
      return {
        name: provider,
        providerInstance: new GitHubActionsProvider({ name: provider, repo }),
      };
    }

    throw new Error(`Unsupported provider "${provider}"`);
  }

  if (!provider || typeof provider !== 'object') {
    throw new Error('provider must be a provider object or provider name');
  }

  const name = typeof provider.name === 'string' && provider.name.trim() ? provider.name.trim() : 'mock';

  if (typeof provider.listRuns !== 'function') {
    throw new Error('provider must implement listRuns');
  }

  if (typeof provider.getFailureLogs !== 'function') {
    throw new Error('provider must implement getFailureLogs');
  }

  return {
    name,
    providerInstance: provider,
  };
}

function _getWatch(repo, provider) {
  const db = _getDb();
  return db.prepare('SELECT * FROM ci_watches WHERE repo = ? AND provider = ?').get(repo, provider);
}

function _upsertWatchRecord({
  repo,
  provider,
  branch,
  pollIntervalMs,
}) {
  const db = _getDb();
  const now = new Date().toISOString();
  const existing = _getWatch(repo, provider);

  if (existing) {
    db.prepare(`
      UPDATE ci_watches
      SET branch = ?,
          poll_interval_ms = ?,
          active = 1,
          updated_at = ?
      WHERE repo = ? AND provider = ?
    `).run(branch, pollIntervalMs, now, repo, provider);
  } else {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO ci_watches (id, repo, provider, branch, poll_interval_ms, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, repo, provider, branch, pollIntervalMs, now, now);
  }

  return _getWatch(repo, provider);
}

function _deactivateWatchRow(repo, provider) {
  const db = _getDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE ci_watches
    SET active = 0, updated_at = ?
    WHERE repo = ? AND provider = ?
  `).run(now, repo, provider);

  return result.changes > 0;
}

function deactivateCiWatch(repo, provider) {
  return _deactivateWatchRow(repo, provider);
}

function _hasRunBeenDiagnosed(runId, repo, provider) {
  const db = _getDb();
  const row = db.prepare(`
    SELECT diagnosed_at
    FROM ci_run_cache
    WHERE run_id = ? AND repo = ? AND provider = ?
  `).get(String(runId), repo, provider);

  return Boolean(row && row.diagnosed_at);
}

function _cacheRunDiagnostic({
  run,
  watch,
  provider,
  failures,
  triage,
}) {
  const db = _getDb();
  const createdAt = run.created_at || run.createdAt || null;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO ci_run_cache (
      run_id,
      repo,
      provider,
      status,
      conclusion,
      commit_sha,
      branch,
      jobs_json,
      failures_json,
      triage_json,
      diagnosed_at,
      duration_ms,
      url,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, provider) DO UPDATE SET
      status = excluded.status,
      conclusion = excluded.conclusion,
      commit_sha = excluded.commit_sha,
      branch = excluded.branch,
      jobs_json = excluded.jobs_json,
      failures_json = excluded.failures_json,
      triage_json = excluded.triage_json,
      diagnosed_at = excluded.diagnosed_at,
      duration_ms = excluded.duration_ms,
      url = excluded.url
  `).run(
    String(run.id),
    watch.repo,
    provider,
    run.status || null,
    run.conclusion || run.status || null,
    run.sha || run.commit_sha || null,
    run.branch || watch.branch || null,
    JSON.stringify(Array.isArray(failures) ? failures : []),
    JSON.stringify({ triage: triage || '' }),
    now,
    null,
    run.url || null,
    createdAt,
  );
}

function _isFailedRun(run) {
  const status = String(run?.status || '').toLowerCase();
  const conclusion = String(run?.conclusion || '').toLowerCase();

  if (status === 'failure') {
    return true;
  }

  if (status === 'completed') {
    return conclusion === 'failure' || conclusion === 'timed_out';
  }

  return conclusion === 'failure' || conclusion === 'timed_out';
}

function _getConclusion(run) {
  if (typeof run.conclusion === 'string' && run.conclusion.trim()) {
    return run.conclusion.trim();
  }

  if (run.status === 'failure') {
    return 'failure';
  }

  return run.status || 'unknown';
}

async function _notifyFailure({
  run,
  watch,
  _provider,
  failures,
  triage,
}) {
  const payload = {
    type: 'ci:run:failed',
    data: {
      run_id: String(run.id),
      repo: run.repository || watch.repo,
      branch: run.branch || watch.branch || null,
      conclusion: _getConclusion(run),
      failure_count: Array.isArray(failures) ? failures.length : 0,
      triage_summary: (triage || '').slice(0, 500),
      url: run.url || null,
    },
  };

  const mcpSse = getMcpSse();
  if (typeof mcpSse.pushNotification === 'function') {
    const result = mcpSse.pushNotification(payload);
    if (result && typeof result.then === 'function') {
      await result;
    }
  }
}

function _updateLastCheckedAt(repo, provider) {
  const db = _getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE ci_watches
    SET last_checked_at = ?, updated_at = ?
    WHERE repo = ? AND provider = ?
  `).run(now, now, repo, provider);
}

async function _pollWatch(watch, providerObj) {
  if (!_activeTimers.has(_runKey(watch.repo, watch.provider))) {
    return;
  }

  const currentWatch = _getWatch(watch.repo, watch.provider);
  if (!currentWatch || Number(currentWatch.active) !== 1) {
    return;
  }

  let runs = [];
  try {
    runs = await providerObj.listRuns({ branch: currentWatch.branch });
  } catch (_err) {
    _updateLastCheckedAt(watch.repo, watch.provider);
    return;
  }

  if (!Array.isArray(runs)) {
    _updateLastCheckedAt(watch.repo, watch.provider);
    return;
  }

  const lastCheckedMs = _normalizeRunTimestamp(currentWatch.last_checked_at);
  const cutoffMs = Number.isFinite(lastCheckedMs) ? lastCheckedMs : Number.NEGATIVE_INFINITY;

  for (const run of runs) {
    const createdMs = _parseRunCreatedAt(run);
    if (!Number.isFinite(createdMs) || createdMs <= cutoffMs) {
      continue;
    }

    if (!_isFailedRun(run)) {
      continue;
    }

    if (_hasRunBeenDiagnosed(run.id, currentWatch.repo, currentWatch.provider)) {
      continue;
    }

    let rawLog = '';
    try {
      rawLog = await providerObj.getFailureLogs(String(run.id));
    } catch (_err) {
      rawLog = '';
    }

    const diagnosis = diagnoseFailures(rawLog, {
      conclusion: _getConclusion(run),
      runId: String(run.id),
    });
    const failures = Array.isArray(diagnosis.failures) ? diagnosis.failures : [];
    const triage = typeof diagnosis.triage === 'string' ? diagnosis.triage : '';

    _cacheRunDiagnostic({
      run,
      watch: currentWatch,
      provider: currentWatch.provider,
      failures,
      triage,
    });
    await _notifyFailure({
      run,
      watch: currentWatch,
      provider: currentWatch.provider,
      failures,
      triage,
    });
  }

  _updateLastCheckedAt(watch.repo, watch.provider);
}

function _startWatchTimer({
  watch,
  providerObj,
  pollIntervalMs,
}) {
  const key = _runKey(watch.repo, watch.provider);
  const existing = _activeTimers.get(key);
  if (existing && existing.timer) {
    clearInterval(existing.timer);
  }

  const timer = setInterval(() => {
    void _pollWatch(watch, providerObj);
  }, pollIntervalMs);

  _activeTimers.set(key, {
    timer,
    watch,
  });
}

/**
 * Starts/restarts a repository CI watch.
 */
async function watchRepo(options) {
  _validateOptions(options);

  const repo = options.repo.trim();
  const resolved = _resolveProvider(options.provider, repo);
  const provider = resolved.providerInstance;
  const providerName = resolved.name;
  const parsedPollInterval = Number.parseInt(options.pollIntervalMs || options.poll_interval_ms || 30000, 10);
  const pollIntervalMs = Number.isFinite(parsedPollInterval) && parsedPollInterval > 0
    ? parsedPollInterval
    : 30000;
  const branch = typeof options.branch === 'string' ? options.branch : null;

  const current = _getWatch(repo, providerName);
  if (!current && _activeTimers.size >= MAX_WATCHES) {
    throw new Error(`Maximum concurrent CI watches (${MAX_WATCHES}) exceeded`);
  }

  const watch = _upsertWatchRecord({
    repo,
    provider: providerName,
    branch,
    pollIntervalMs,
  });

  _startWatchTimer({
    watch,
    providerObj: provider,
    pollIntervalMs,
  });

  return watch;
}

function stopWatch(options) {
  _validateOptions(options);

  const repo = options.repo.trim();
  const provider = _resolveProvider(options.provider, repo).name;
  const key = _runKey(repo, provider);
  const entry = _activeTimers.get(key);
  if (entry?.timer) {
    clearInterval(entry.timer);
  }
  _activeTimers.delete(key);

  return deactivateCiWatch(repo, provider);
}

function shutdownAll() {
  for (const [, entry] of _activeTimers) {
    if (entry?.timer) {
      clearInterval(entry.timer);
    }
  }

  _activeTimers.clear();
}

function getActiveWatches() {
  return Array.from(_activeTimers.values()).map((entry) => ({
    ...entry.watch,
    status: 'active',
  }));
}

module.exports = {
  _activeTimers,
  MAX_WATCHES,
  watchRepo,
  stopWatch,
  shutdownAll,
  getActiveWatches,
  deactivateCiWatch,
  _deactivateWatchRow: _deactivateWatchRow,
};
