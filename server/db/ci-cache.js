/**
 * CI cache and watch persistence module.
 */

let _db = null;

function setDb(dbInstance) { _db = dbInstance; }

function normalizeProviderValue(provider) {
  if (typeof provider === 'string' && provider.trim()) {
    return provider.trim();
  }
  return 'github-actions';
}

function serializeJsonColumn(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function normalizeLimit(value) {
  const limit = Number.parseInt(value, 10);
  if (Number.isInteger(limit) && limit > 0) return limit;
  return 20;
}

function upsertCiRunCache(event = {}) {
  const runId = event.run_id;
  const repo = event.repo;
  const provider = normalizeProviderValue(event.provider);
  const stmt = _db.prepare(`
    INSERT OR REPLACE INTO ci_run_cache (
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
      url
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    runId,
    repo,
    provider,
    event.status || null,
    event.conclusion || null,
    event.commit_sha || null,
    event.branch || null,
    serializeJsonColumn(event.jobs_json),
    serializeJsonColumn(event.failures_json),
    serializeJsonColumn(event.triage_json),
    event.diagnosed_at || null,
    event.duration_ms == null ? null : event.duration_ms,
    event.url || null
  );

  return getCiRunCache(runId, provider);
}

function getCiRunCache(runId, provider) {
  return _db.prepare('SELECT * FROM ci_run_cache WHERE run_id = ? AND provider = ?')
    .get(runId, normalizeProviderValue(provider));
}

function listCiRunCache(repo, filters = {}) {
  const normalizedFilters = filters && typeof filters === 'object' ? filters : {};
  const query = ['SELECT * FROM ci_run_cache WHERE repo = ?'];
  const values = [repo];

  if (normalizedFilters.branch !== undefined) {
    query.push('AND branch = ?');
    values.push(normalizedFilters.branch);
  }
  if (normalizedFilters.status !== undefined) {
    query.push('AND status = ?');
    values.push(normalizedFilters.status);
  }

  query.push('ORDER BY created_at DESC LIMIT ?');
  values.push(normalizeLimit(normalizedFilters.limit));

  return _db.prepare(query.join(' ')).all(...values);
}

function pruneCiRunCache(maxAgeDays = 7) {
  const parsedMaxAgeDays = Number(maxAgeDays);
  const safeDays = Number.isFinite(parsedMaxAgeDays) ? Math.max(1, Math.floor(parsedMaxAgeDays)) : 7;
  const result = _db.prepare(`
    DELETE FROM ci_run_cache
    WHERE created_at < datetime('now', ?)
  `).run(`-${safeDays} days`);
  return result.changes;
}

function upsertCiWatch(watch = {}) {
  const id = watch.id;
  const repo = watch.repo;
  const provider = normalizeProviderValue(watch.provider);
  const branch = watch.branch || null;
  const pollIntervalMs = watch.poll_interval_ms == null ? null : watch.poll_interval_ms;

  _db.prepare(`
    INSERT OR REPLACE INTO ci_watches (
      id,
      repo,
      provider,
      branch,
      poll_interval_ms,
      active,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
  `).run(
    id,
    repo,
    provider,
    branch,
    pollIntervalMs
  );

  return getCiWatch(repo, provider);
}

function getCiWatch(repo, provider) {
  return _db.prepare('SELECT * FROM ci_watches WHERE repo = ? AND provider = ?')
    .get(repo, normalizeProviderValue(provider));
}

function deactivateCiWatch(repo, provider) {
  return _db.prepare(`
    UPDATE ci_watches
      SET active = 0,
          updated_at = datetime('now')
    WHERE repo = ? AND provider = ?
  `).run(repo, normalizeProviderValue(provider)).changes > 0;
}

function listActiveCiWatches() {
  return _db.prepare('SELECT * FROM ci_watches WHERE active = 1 ORDER BY created_at DESC').all();
}

/**
 * Factory: create a ci-cache instance with injected db.
 * @param {{ db: object }} deps
 */
function createCiCache({ db: dbInstance }) {
  setDb(dbInstance);
  return {
    upsertCiRunCache,
    getCiRunCache,
    listCiRunCache,
    pruneCiRunCache,
    upsertCiWatch,
    getCiWatch,
    deactivateCiWatch,
    listActiveCiWatches,
  };
}

module.exports = {
  setDb,
  upsertCiRunCache,
  getCiRunCache,
  listCiRunCache,
  pruneCiRunCache,
  upsertCiWatch,
  getCiWatch,
  deactivateCiWatch,
  listActiveCiWatches,
  createCiCache,
};
