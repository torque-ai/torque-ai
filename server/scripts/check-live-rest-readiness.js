const BASE_URL = process.env.TORQUE_INTEGRATION_BASE_URL || 'http://127.0.0.1:3457';
const API_KEY = process.env.TORQUE_INTEGRATION_KEY || '';

const CLI_ARGS = new Set(process.argv.slice(2));
const ENABLE_ASYNC_DEFAULTS = CLI_ARGS.has('--with-async-defaults');
const ENABLE_CONCURRENCY_DEFAULTS = CLI_ARGS.has('--with-concurrency-defaults');
const ENABLE_CONCURRENCY_CODEX_CLAUDE_DEFAULTS = CLI_ARGS.has('--with-concurrency-defaults-codex-claude');

const DEFAULT_ASYNC_PROVIDER = process.env.TORQUE_LIVE_REST_DEFAULT_ASYNC_PROVIDER || 'ollama';
const DEFAULT_ASYNC_MODEL = process.env.TORQUE_LIVE_REST_DEFAULT_ASYNC_MODEL || 'gemma3:4b';
const DEFAULT_CONCURRENCY_PROVIDER_A = process.env.TORQUE_LIVE_REST_DEFAULT_CONCURRENCY_PROVIDER_A || 'ollama';
const DEFAULT_CONCURRENCY_MODEL_A = process.env.TORQUE_LIVE_REST_DEFAULT_CONCURRENCY_MODEL_A || 'gemma3:4b';
const DEFAULT_CONCURRENCY_PROVIDER_B = process.env.TORQUE_LIVE_REST_DEFAULT_CONCURRENCY_PROVIDER_B || 'ollama';
const DEFAULT_CONCURRENCY_MODEL_B = process.env.TORQUE_LIVE_REST_DEFAULT_CONCURRENCY_MODEL_B || 'gemma3:4b';
const DEFAULT_CONCURRENCY_CODEX_PROVIDER_A = process.env.TORQUE_LIVE_REST_DEFAULT_CONCURRENCY_CODEX_PROVIDER_A || 'codex';
const DEFAULT_CONCURRENCY_CODEX_MODEL_A = process.env.TORQUE_LIVE_REST_DEFAULT_CONCURRENCY_CODEX_MODEL_A || 'gpt-5.3-codex-spark';
const DEFAULT_CONCURRENCY_CLAUDE_PROVIDER_B = process.env.TORQUE_LIVE_REST_DEFAULT_CONCURRENCY_CLAUDE_PROVIDER_B || 'claude-cli';
const DEFAULT_CONCURRENCY_CLAUDE_MODEL_B = process.env.TORQUE_LIVE_REST_DEFAULT_CONCURRENCY_CLAUDE_MODEL_B || 'claude-opus-4';

function buildHeaders() {
  const headers = {};
  if (API_KEY) headers['X-Torque-Key'] = API_KEY;
  return headers;
}

async function requestJson(path) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  return { response, payload };
}

function toProviderList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.providers)) return payload.providers;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

function toModelList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.models)) return payload.models;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

function modelKey(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  if (typeof entry.id === 'string') return entry.id;
  if (typeof entry.model === 'string') return entry.model;
  if (typeof entry.name === 'string') return entry.name;
  return '';
}

function normalizeLane(label, provider, model, failures) {
  const trimmedProvider = (provider || '').trim();
  const trimmedModel = (model || '').trim();
  if (!trimmedProvider || !trimmedModel) {
    failures.push(`Lane ${label} is missing provider/model. provider="${trimmedProvider}" model="${trimmedModel}"`);
    return null;
  }
  return { label, provider: trimmedProvider, model: trimmedModel };
}

function buildExpectedLanes(failures) {
  const lanes = [];

  const hasExplicitAsync = Boolean(process.env.TORQUE_INTEGRATION_ASYNC_PROVIDER || process.env.TORQUE_INTEGRATION_ASYNC_MODEL);
  if (ENABLE_ASYNC_DEFAULTS || hasExplicitAsync) {
    const lane = normalizeLane(
      'async',
      process.env.TORQUE_INTEGRATION_ASYNC_PROVIDER || (ENABLE_ASYNC_DEFAULTS ? DEFAULT_ASYNC_PROVIDER : ''),
      process.env.TORQUE_INTEGRATION_ASYNC_MODEL || (ENABLE_ASYNC_DEFAULTS ? DEFAULT_ASYNC_MODEL : ''),
      failures,
    );
    if (lane) lanes.push(lane);
  }

  const hasExplicitConcurrency = Boolean(
    process.env.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_A
    || process.env.TORQUE_INTEGRATION_CONCURRENCY_MODEL_A
    || process.env.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_B
    || process.env.TORQUE_INTEGRATION_CONCURRENCY_MODEL_B,
  );

  if (ENABLE_CONCURRENCY_CODEX_CLAUDE_DEFAULTS || ENABLE_CONCURRENCY_DEFAULTS || hasExplicitConcurrency) {
    const laneA = normalizeLane(
      'concurrency-A',
      process.env.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_A
        || (ENABLE_CONCURRENCY_CODEX_CLAUDE_DEFAULTS ? DEFAULT_CONCURRENCY_CODEX_PROVIDER_A : DEFAULT_CONCURRENCY_PROVIDER_A),
      process.env.TORQUE_INTEGRATION_CONCURRENCY_MODEL_A
        || (ENABLE_CONCURRENCY_CODEX_CLAUDE_DEFAULTS ? DEFAULT_CONCURRENCY_CODEX_MODEL_A : DEFAULT_CONCURRENCY_MODEL_A),
      failures,
    );
    const laneB = normalizeLane(
      'concurrency-B',
      process.env.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_B
        || (ENABLE_CONCURRENCY_CODEX_CLAUDE_DEFAULTS ? DEFAULT_CONCURRENCY_CLAUDE_PROVIDER_B : DEFAULT_CONCURRENCY_PROVIDER_B),
      process.env.TORQUE_INTEGRATION_CONCURRENCY_MODEL_B
        || (ENABLE_CONCURRENCY_CODEX_CLAUDE_DEFAULTS ? DEFAULT_CONCURRENCY_CLAUDE_MODEL_B : DEFAULT_CONCURRENCY_MODEL_B),
      failures,
    );
    if (laneA) lanes.push(laneA);
    if (laneB) lanes.push(laneB);
  }

  return lanes;
}

async function main() {
  const failures = [];
  const notes = [];

  const health = await requestJson('/healthz');
  if (health.response.status !== 200) {
    failures.push(`Health check failed with HTTP ${health.response.status}`);
  } else {
    const status = health.payload?.status || 'unknown';
    notes.push(`healthz status=${status}`);
  }

  const providersResponse = await requestJson('/api/v2/providers');
  if (providersResponse.response.status !== 200) {
    failures.push(`Provider discovery failed with HTTP ${providersResponse.response.status}`);
  }
  const providerRows = toProviderList(providersResponse.payload);
  const providerMap = new Map(
    providerRows
      .filter((row) => row && typeof row.id === 'string')
      .map((row) => [row.id, row]),
  );

  const lanes = buildExpectedLanes(failures);
  if (lanes.length === 0) {
    notes.push('No lane preflight requested. Use --with-async-defaults and/or concurrency flags to validate provider lanes.');
  }

  for (const lane of lanes) {
    const provider = providerMap.get(lane.provider);
    if (!provider) {
      failures.push(`Lane ${lane.label}: provider "${lane.provider}" was not discovered.`);
      continue;
    }

    if (provider.enabled === false || provider.status === 'disabled') {
      failures.push(`Lane ${lane.label}: provider "${lane.provider}" is disabled.`);
      continue;
    }

    const modelsResponse = await requestJson(`/api/v2/providers/${encodeURIComponent(lane.provider)}/models`);
    if (modelsResponse.response.status !== 200) {
      failures.push(`Lane ${lane.label}: model discovery for "${lane.provider}" failed with HTTP ${modelsResponse.response.status}`);
      continue;
    }

    const modelRows = toModelList(modelsResponse.payload);
    const keys = new Set(modelRows.map(modelKey).filter(Boolean));
    if (!keys.has(lane.model)) {
      failures.push(
        `Lane ${lane.label}: model "${lane.model}" not found for provider "${lane.provider}".`,
      );
    } else {
      notes.push(`lane ${lane.label}: ${lane.provider}/${lane.model} ready`);
    }
  }

  for (const note of notes) {
    process.stdout.write(`[readiness] ${note}\n`);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`[readiness] FAIL ${failure}\n`);
    }
    process.exit(1);
    return;
  }

  process.stdout.write('[readiness] PASS all requested checks completed.\n');
  process.exit(0);
}

module.exports = { main };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[readiness] FAIL ${error?.message || error}\n`);
    process.exit(1);
  });
}
