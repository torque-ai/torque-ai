const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const BASE_URL = process.env.TORQUE_MCP_GATEWAY_URL
  || `http://127.0.0.1:${Number.parseInt(process.env.TORQUE_MCP_GATEWAY_PORT, 10) || 3459}`;
const TARGET_PORTS = [3456, 3457, 3458, 3459];
const START_TIMEOUT_MS = 20000;
const HEALTH_POLL_MS = 250;
const SHUTDOWN_TIMEOUT_MS = 5000;

function normalizeReportPath(rawPath) {
  if (!rawPath) {
    return null;
  }

  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }

  const adjustedPath = rawPath.replace(/^\.?[\\/]*server[\\/]+/i, '');
  return path.resolve(ROOT_DIR, adjustedPath);
}

const REPORT_PATH = normalizeReportPath(process.env.TORQUE_MCP_LAUNCH_REPORT || null);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getListeningPidsByPort() {
  const result = spawnSync('netstat', ['-ano'], {
    encoding: 'utf8',
  });

  if (result.error) {
    throw new Error(`Unable to run netstat: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`netstat command failed with status ${result.status}`);
  }

  const output = result.stdout || '';
  const byPort = new Map();
  for (const port of TARGET_PORTS) {
    byPort.set(port, new Set());
  }

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) {
      continue;
    }

    const port = Number.parseInt(match[1], 10);
    const pid = Number.parseInt(match[2], 10);
    if (!Number.isFinite(port) || !Number.isFinite(pid)) {
      continue;
    }

    if (!byPort.has(port)) {
      continue;
    }
    byPort.get(port).add(pid);
  }

  return byPort;
}

function getPortConflicts() {
  const portMap = getListeningPidsByPort();
  const conflicts = [];

  for (const [port, pids] of portMap.entries()) {
    if (pids.size > 0) {
      conflicts.push({
        port,
        pids: [...pids].sort((a, b) => a - b),
      });
    }
  }

  return conflicts;
}

function isManagedTorquePid(pid) {
  if (process.env.TORQUE_CLEAN_MCP_FORCE === '1') {
    return true;
  }

  const wmicResult = spawnSync('wmic', [
    'process',
    'where',
    `processid=${pid}`,
    'get',
    'CommandLine',
    '/VALUE',
  ], {
    encoding: 'utf8',
  });

  if (wmicResult.error || wmicResult.status !== 0) {
    return false;
  }

  const payload = (wmicResult.stdout || '').toLowerCase();
  return payload.includes('node') && payload.includes('server/index.js');
}

function splitPidsForReport(portConflicts) {
  return portConflicts.map((conflict) => {
    const managed = [];
    const unmanaged = [];

    for (const pid of conflict.pids) {
      if (isManagedTorquePid(pid)) {
        managed.push(pid);
      } else {
        unmanaged.push(pid);
      }
    }

    return {
      port: conflict.port,
      managed_pids: managed.sort((a, b) => a - b),
      unmanaged_pids: unmanaged.sort((a, b) => a - b),
    };
  });
}

function formatPortConflicts(conflicts) {
  if (conflicts.length === 0) {
    return ['no conflicts detected'];
  }

  const lines = [];
  for (const conflict of conflicts) {
    const managed = conflict.managed_pids || [];
    const unmanaged = conflict.unmanaged_pids || [];

    const formatList = (ids) => ids.length ? ids.join(',') : '<none>';
    lines.push(`port ${conflict.port}: managed=[${formatList(managed)}] unmanaged=[${formatList(unmanaged)}]`);
  }

  return lines;
}

function cleanupConflictedPorts(conflicts) {
  if (conflicts.length === 0 || process.env.TORQUE_CLEAN_MCP_PORTS !== '1') {
    return {
      enabled: false,
      attempted: false,
      skipped_unmanaged: [],
      killed: [],
      failed: [],
      killed_any: false,
    };
  }

  const pidSet = new Set();
  const skippedUnmanaged = [];
  const force = process.env.TORQUE_CLEAN_MCP_FORCE === '1';
  for (const conflict of conflicts) {
    for (const pid of conflict.pids) {
      if (!isManagedTorquePid(pid) && !force) {
        skippedUnmanaged.push(pid);
        continue;
      }
      pidSet.add(pid);
    }
  }

  let killedAny = false;
  const killed = [];
  const failed = [];
  for (const pid of pidSet) {
    const killResult = spawnSync('taskkill', ['/F', '/PID', String(pid)]);
    if (killResult.status === 0) {
      killedAny = true;
      killed.push(pid);
      process.stdout.write(`[mcp-launch-readiness] cleaned pid=${pid} from port usage.\n`);
    } else {
      failed.push(pid);
      process.stdout.write(`[mcp-launch-readiness] failed to clean pid=${pid} from port usage.\n`);
    }
  }

  if (skippedUnmanaged.length) {
    process.stdout.write(
      `[mcp-launch-readiness] skipped cleanup for unmanaged pids=${[...skippedUnmanaged].sort((a, b) => a - b).join(',')}\n`,
    );
  }

  return {
    enabled: true,
    attempted: true,
    skipped_unmanaged: [...skippedUnmanaged].sort((a, b) => a - b),
    killed: killed.sort((a, b) => a - b),
    failed: failed.sort((a, b) => a - b),
    killed_any: killedAny,
  };
}

function guardPorts() {
  const conflicts = getPortConflicts();
  const preflight = splitPidsForReport(conflicts);

  if (conflicts.length === 0) {
    return {
      preflight: [],
      cleanup: null,
      post_cleanup: [],
    };
  }

  process.stderr.write('[mcp-launch-readiness] preflight port audit:\n');
  const details = formatPortConflicts(preflight);
  for (const line of details) {
    process.stderr.write(`  - ${line}\n`);
  }

  const cleanup = cleanupConflictedPorts(conflicts);
  if (!cleanup.attempted) {
    throw new Error(
      'Port conflict requires cleanup. Set TORQUE_CLEAN_MCP_PORTS=1 to clean managed Torque listeners.',
    );
  }

  if (!cleanup.killed_any && cleanup.failed.length === 0) {
    throw new Error(
      'Could not clean any conflicting managed listeners; use TORQUE_CLEAN_MCP_FORCE=1 if unmanaged listeners need cleanup.',
    );
  }

  const remainingConflicts = getPortConflicts();
  const postflight = splitPidsForReport(remainingConflicts);
  if (postflight.length > 0) {
    process.stderr.write('[mcp-launch-readiness] unresolved port conflicts after cleanup:\n');
    const unresolved = formatPortConflicts(postflight);
    for (const line of unresolved) {
      process.stderr.write(`  - ${line}\n`);
    }

    throw new Error('Port conflicts remain after cleanup. Set TORQUE_CLEAN_MCP_FORCE=1 to cleanup all listeners on target ports.');
  }

  return {
    preflight,
    cleanup,
    post_cleanup: postflight,
  };
}

async function waitForHealth() {
  const start = Date.now();

  while (Date.now() - start < START_TIMEOUT_MS) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Gateway not ready yet.
    }
    await sleep(HEALTH_POLL_MS);
  }

  return false;
}

function runScript(scriptPath) {
  const command = process.execPath;
  const result = spawnSync(command, [scriptPath], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: 'inherit',
  });

  return {
    script: scriptPath,
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
  };
}

async function stopServer(processRef) {
  if (!processRef || processRef.exitCode !== null || processRef.killed) {
    return;
  }

  processRef.kill('SIGINT');

  const start = Date.now();
  while (processRef.exitCode === null && Date.now() - start < SHUTDOWN_TIMEOUT_MS) {
    await sleep(200);
  }

  if (processRef.exitCode === null) {
    processRef.kill('SIGKILL');
  }
}

function writeLaunchReport(report) {
  if (!REPORT_PATH) {
    return;
  }

  const payload = {
    ...report,
    report_generated_at: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`[mcp-launch-readiness] wrote report ${path.relative(process.cwd(), REPORT_PATH)}\n`);
}

function writeGitHubStepSummary(report) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }

  const checks = report.checks || {};
  const readiness = checks.readiness_pack;
  const dualAgent = checks.dual_agent_smoke;
  const cleanup = report.port_audit?.cleanup || { enabled: false };
  const preflight = report.port_audit?.preflight || [];

  const line = (text) => `- ${text}`;
  const statusLabel = report.status === 'pass' ? '✅ PASS' : '❌ FAIL';
  const readinessStatus = readiness && readiness.ok ? 'pass' : 'fail';
  const dualAgentStatus = dualAgent && dualAgent.ok ? 'pass' : 'fail';

  const lines = [
    `# MCP Launch Readiness`,
    '',
    `- Status: **${statusLabel}**`,
    `- Gateway URL: \`${report.base_url}\``,
    `- Gateway port: ${report.gateway_port}`,
    '',
    '## Checks',
    line(`readiness-pack: \`${readinessStatus}\``),
    line(`dual-agent-smoke: \`${dualAgentStatus}\``),
    '',
    '## Port Audit',
    line(`preflight_conflicts: ${preflight.length}`),
    line(`cleanup_enabled: ${cleanup.enabled}`),
    line(`cleanup_attempted: ${cleanup.attempted || false}`),
    line(`killed_pids: ${(cleanup.killed || []).join(', ') || '<none>'}`),
    line(`unmanaged_skipped_pids: ${(cleanup.skipped_unmanaged || []).join(', ') || '<none>'}`),
    '',
    `Report artifact: \`${path.relative(process.cwd(), REPORT_PATH || 'N/A')}\``,
  ];

  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${lines.join('\n')}\n`, { encoding: 'utf8' });
}

async function main() {
  const report = {
    started_at: new Date().toISOString(),
    base_url: BASE_URL,
    gateway_port: Number.parseInt(process.env.TORQUE_MCP_GATEWAY_PORT, 10) || 3459,
    status: 'pass',
    checks: {},
  };

  let gatewayProcess;

  try {
    report.port_audit = guardPorts();

    gatewayProcess = spawn(process.execPath, ['index.js'], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        TORQUE_ENABLE_MCP_GATEWAY: '1',
        TORQUE_MCP_GATEWAY_PORT: process.env.TORQUE_MCP_GATEWAY_PORT || '3459',
      },
      stdio: 'pipe',
    });

    const healthy = await waitForHealth();
    if (!healthy) {
      report.status = 'fail';
      throw new Error(`MCP gateway did not become ready at ${BASE_URL}`);
    }
    report.health = { ready: true };

    const readinessPack = runScript('scripts/mcp-readiness-pack.js');
    report.checks.readiness_pack = readinessPack;
    if (!readinessPack.ok) {
      report.status = 'fail';
      throw new Error('ci:mcp-readiness-pack check failed');
    }

    const dualAgent = runScript('scripts/mcp-dual-agent-smoke.js');
    report.checks.dual_agent_smoke = dualAgent;
    if (!dualAgent.ok) {
      report.status = 'fail';
      throw new Error('ci:mcp-dual-agent-smoke check failed');
    }

    process.stdout.write('[mcp-launch-readiness] PASS full gateway readiness checks completed.\n');
  } finally {
    await stopServer(gatewayProcess);
    report.ended_at = new Date().toISOString();

    if (!report.checks.readiness_pack) {
      report.checks.readiness_pack = {
        script: 'scripts/mcp-readiness-pack.js',
        ok: false,
        status: null,
        signal: null,
        error: 'not_run',
      };
    }
    if (!report.checks.dual_agent_smoke) {
      report.checks.dual_agent_smoke = {
        script: 'scripts/mcp-dual-agent-smoke.js',
        ok: false,
        status: null,
        signal: null,
        error: 'not_run',
      };
    }

    if (!report.checks.readiness_pack.ok || !report.checks.dual_agent_smoke.ok) {
      report.status = 'fail';
    }

    writeLaunchReport(report);
    writeGitHubStepSummary(report);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[mcp-launch-readiness] FAIL ${error?.message || error}\n`);
    process.exit(1);
  });
}
