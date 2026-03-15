const fs = require('fs');
const path = require('path');

const MCPPort = parseInt(process.env.TORQUE_MCP_GATEWAY_PORT, 10);
const BASE_URL = process.env.TORQUE_MCP_GATEWAY_URL
  || (Number.isFinite(MCPPort) && MCPPort > 0 ? `http://127.0.0.1:${MCPPort}` : 'http://127.0.0.1:3459');
const CONCURRENCY = Math.max(1, parseInt(process.env.TORQUE_MCP_DUAL_AGENT_CONCURRENCY, 10) || 12);
const TOOL = process.env.TORQUE_MCP_DUAL_AGENT_TOOL || 'torque.task.list';
const TIMEOUT_MS = Math.max(500, parseInt(process.env.TORQUE_MCP_SMOKE_TIMEOUT_MS, 10) || 10000);
function normalizeReportPath(rawPath) {
  if (!rawPath) return null;
  if (path.isAbsolute(rawPath)) return rawPath;

  // Allow callers to pass `server/...` when running from repo root.
  const adjustedPath = rawPath.replace(/^\.?[\\/]*server[\\/]+/i, '');
  return path.resolve(__dirname, '..', adjustedPath);
}

const REPORT_PATH = normalizeReportPath(process.env.TORQUE_MCP_DUAL_AGENT_REPORT || null);
const LANE_SIZE = Math.max(1, Math.floor(CONCURRENCY / 2));

const TARGET_INFO = BASE_URL === 'http://127.0.0.1:3459'
  ? 'default gateway endpoint (127.0.0.1:3459)'
  : 'custom gateway endpoint';

function buildPayload(callIndex, lane) {
  return {
    tool: TOOL,
    arguments: {
      limit: 5,
    },
  };
}

function buildHeaders(actor, role, correlationId) {
  return {
    'Content-Type': 'application/json',
    'x-mcp-actor': actor,
    'x-mcp-role': role,
    'x-correlation-id': correlationId,
  };
}

async function requestTool(payload, actor, role, correlationId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const start = Date.now();
  let status = 0;
  let body = null;
  try {
    const response = await fetch(`${BASE_URL}/tools/call`, {
      method: 'POST',
      headers: buildHeaders(actor, role, correlationId),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    status = response.status;
    body = await response.json().catch(() => ({}));
  } catch (error) {
    return {
      status: 0,
      latencyMs: Date.now() - start,
      body: {},
      actor,
      role,
      correlationId,
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timeout);
  }

  return {
    status,
    latencyMs: Date.now() - start,
    body,
    actor,
    role,
    correlationId,
  };
}

async function runLane(name, actor, role, startIndex, count) {
  const requests = [];
  for (let i = 0; i < count; i += 1) {
    const idx = startIndex + i;
    const payload = buildPayload(idx, name);
    requests.push(
      requestTool(
        payload,
        actor,
        role,
        `dual-agent-${name}-${idx}`,
      ).then((result) => ({ ...result, lane: name, ordinal: idx })),
    );
  }
  return Promise.all(requests);
}

function summarize(results) {
  const groupedByLane = new Map();
  let totalMs = 0;
  let slowest = 0;

  for (const result of results) {
    totalMs += result.latencyMs;
    slowest = Math.max(slowest, result.latencyMs);
    const bucket = groupedByLane.get(result.lane) || [];
    bucket.push(result);
    groupedByLane.set(result.lane, bucket);
  }

  const avgMs = Math.max(1, totalMs / Math.max(1, results.length));
  const notes = [];
  const checks = [];

  for (const [lane, laneResults] of groupedByLane.entries()) {
    const failures = laneResults.filter((item) => item.status !== 200);
    notes.push(`${lane}: total=${laneResults.length}, ok=${laneResults.length - failures.length}, status_err=${failures.length}`);
    checks.push({
      lane,
      total: laneResults.length,
      errors: failures.length,
      slowestMs: laneResults.reduce((max, item) => Math.max(max, item.latencyMs), 0),
    });
  }

  return { avgMs, slowest, groupedByLane, checks, notes };
}

function writeReport(result, path, config, summary) {
  if (!path) return;

  const payload = {
    feature: 'MCP-026',
    date: new Date().toISOString(),
    status: result.ok ? 'pass' : 'fail',
    config,
    notes: summary.notes,
    checks: summary.checks.map((check) => ({
      name: `${check.lane}-lane`,
      component: 'gateway',
      expected: 'lane completes all concurrent calls',
      ...check,
    })),
    failures: result.failures,
    totals: {
      calls: summary.checks.reduce((acc, check) => acc + check.total, 0),
      avgMs: summary.avgMs,
      slowestMs: summary.slowest,
      timeoutMs: TIMEOUT_MS,
      concurrency: CONCURRENCY,
      tool: TOOL,
    },
  };

  fs.writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  process.stdout.write(`[mcp-dual-agent-smoke] target=${BASE_URL} (${TARGET_INFO}); dashboard remains on 127.0.0.1:3456\n`);

  const codex = runLane('codex', 'codex', 'operator', 0, LANE_SIZE);
  const claude = runLane('claude', 'claude', 'operator', LANE_SIZE, CONCURRENCY - LANE_SIZE);

  const resultBuckets = await Promise.all([codex, claude]);
  const allResults = resultBuckets.flat();
  const failures = allResults.filter((result) => result.status !== 200);

  const summary = summarize(allResults);
  for (const note of summary.notes) {
    process.stdout.write(`[mcp-dual-agent-smoke] ${note}\n`);
  }
  process.stdout.write(`[mcp-dual-agent-smoke] calls=${allResults.length}, avgMs=${summary.avgMs.toFixed(2)}, slowestMs=${summary.slowest}\n`);

  const report = {
    ok: failures.length === 0 && summary.slowest <= TIMEOUT_MS && summary.checks.length === 2,
    failures: failures.map((fail) => ({
      lane: fail.lane,
      ordinal: fail.ordinal,
      status: fail.status,
      error: fail.error || null,
      correlationId: fail.correlationId,
    })),
    summary,
  };
  writeReport(
    report,
    REPORT_PATH,
    {
      baseUrl: BASE_URL,
      concurrency: CONCURRENCY,
      tool: TOOL,
      timeoutMs: TIMEOUT_MS,
      actorRoles: ['codex/operator', 'claude/operator'],
      laneSize: LANE_SIZE,
    },
    summary,
  );

  if (failures.length > 0) {
    for (const fail of failures.slice(0, 12)) {
      const msg = `lane=${fail.lane} correlation=${fail.correlationId} status=${fail.status}`;
      process.stderr.write(`[mcp-dual-agent-smoke] FAIL ${msg}\n`);
      if (fail.error) {
        process.stderr.write(`[mcp-dual-agent-smoke] ERROR ${fail.error}\n`);
      }
    }
    process.exit(1);
    return;
  }

  if (summary.slowest > TIMEOUT_MS) {
    process.stderr.write('[mcp-dual-agent-smoke] FAIL slowest response exceeded timeout budget\n');
    process.exit(1);
    return;
  }

  if (summary.checks.length !== 2) {
    process.stderr.write('[mcp-dual-agent-smoke] FAIL expected two lanes (codex, claude)\n');
    process.exit(1);
    return;
  }

  process.stdout.write('[mcp-dual-agent-smoke] PASS dual-agent request lanes completed without errors.\n');
  process.exit(0);
}

module.exports = { main };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[mcp-dual-agent-smoke] FAIL ${error?.message || error}\n`);
    process.exit(1);
  });
}
