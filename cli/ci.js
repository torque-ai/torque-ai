const { apiGet, apiPost, apiDelete } = require('./api-client');

function normalizeField(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  return value;
}

function compactObject(fields) {
  const cleaned = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

function parseIntField(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function handleCiStatus(args) {
  const raw = await apiPost('/api/tools/ci_run_status', compactObject({
    run_id: args.run_id || args.runId || normalizeField(args.id),
    repo: normalizeField(args.repo),
    provider: normalizeField(args.provider),
  }));

  return {
    command: 'ci_status',
    raw,
  };
}

async function handleCiWatch(args) {
  const raw = await apiPost('/api/tools/watch_ci_repo', compactObject({
    repo: normalizeField(args.repo),
    provider: normalizeField(args.provider),
    branch: normalizeField(args.branch),
    poll_interval_ms: parseIntField(
      args.poll_interval_ms || args.pollIntervalMs || args.pollInterval || args.poll,
    ),
    auto_diagnose: args.auto_diagnose ?? args.autoDiagnose,
  }));

  return {
    command: 'ci_watch',
    raw,
  };
}

async function handleCiStop(args) {
  const raw = await apiPost('/api/tools/stop_ci_watch', compactObject({
    repo: normalizeField(args.repo),
    watch_id: normalizeField(args.watch_id || args.watchId),
    provider: normalizeField(args.provider),
  }));

  return {
    command: 'ci_stop',
    raw,
  };
}

async function handleCiDiagnose(args) {
  const raw = await apiPost('/api/tools/diagnose_ci_failure', compactObject({
    run_id: args.run_id || args.runId || normalizeField(args.id),
    repo: normalizeField(args.repo),
    provider: normalizeField(args.provider),
  }));

  return {
    command: 'ci_diagnose',
    raw,
  };
}

async function handleCiRuns(args) {
  const raw = await apiPost('/api/tools/list_ci_runs', compactObject({
    repo: normalizeField(args.repo),
    branch: normalizeField(args.branch),
    status: normalizeField(args.status),
    limit: parseIntField(args.limit),
    provider: normalizeField(args.provider),
  }));

  return {
    command: 'ci_runs',
    raw,
  };
}

async function handleCiConfigure(args) {
  const raw = await apiPost('/api/tools/configure_ci_provider', compactObject({
    provider: normalizeField(args.provider),
    default_repo: normalizeField(args.default_repo || args.defaultRepo),
    webhook_secret: normalizeField(args.webhook_secret || args.webhookSecret),
    poll_interval_ms: parseIntField(args.poll_interval_ms || args.pollIntervalMs || args.pollInterval),
    auto_diagnose: args.auto_diagnose ?? args.autoDiagnose,
  }));

  return {
    command: 'ci_configure',
    raw,
  };
}

module.exports = {
  handleCiStatus,
  handleCiWatch,
  handleCiStop,
  handleCiDiagnose,
  handleCiRuns,
  handleCiConfigure,
};
