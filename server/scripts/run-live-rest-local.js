const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.resolve(__dirname, '..');
const BASE_URL = process.env.TORQUE_INTEGRATION_BASE_URL || 'http://127.0.0.1:3457';
const HEALTH_URL = `${BASE_URL.replace(/\/$/, '')}/healthz`;
const STARTUP_TIMEOUT_MS = Number.parseInt(process.env.TORQUE_LIVE_REST_STARTUP_TIMEOUT_MS || '40000', 10);
const STARTUP_INTERVAL_MS = Number.parseInt(process.env.TORQUE_LIVE_REST_STARTUP_INTERVAL_MS || '1000', 10);
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
const ARTIFACTS_ROOT = process.env.TORQUE_LIVE_REST_ARTIFACTS_DIR || path.join(SERVER_ROOT, 'artifacts', 'live-rest');
const VITEST_REST_ARGS = [
  'node_modules/vitest/vitest.mjs',
  'run',
  '--reporter=verbose',
  'tests/rest-provider-host-routes.integration.test.js',
  'tests/rest-v2-inference-tasks.integration.test.js',
  'tests/rest-v2-async-lifecycle.integration.test.js',
  'tests/rest-v2-concurrency.integration.test.js',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeSummary(summaryPath, summary) {
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

async function isHealthy() {
  try {
    const response = await fetch(HEALTH_URL, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

function startTorqueServer(serverLogStream) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[torque] ${chunk}`);
    serverLogStream?.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[torque] ${chunk}`);
    serverLogStream?.write(chunk);
  });

  return child;
}

async function waitForHealth(timeoutMs, intervalMs) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    if (await isHealthy()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function runIntegrationTests(testLogStream) {
  const integrationEnv = {
    ...process.env,
    TORQUE_INTEGRATION_BASE_URL: BASE_URL,
  };

  if (ENABLE_ASYNC_DEFAULTS) {
    if (!integrationEnv.TORQUE_INTEGRATION_ASYNC_PROVIDER) {
      integrationEnv.TORQUE_INTEGRATION_ASYNC_PROVIDER = DEFAULT_ASYNC_PROVIDER;
    }
    if (!integrationEnv.TORQUE_INTEGRATION_ASYNC_MODEL) {
      integrationEnv.TORQUE_INTEGRATION_ASYNC_MODEL = DEFAULT_ASYNC_MODEL;
    }
  }

  if (ENABLE_CONCURRENCY_CODEX_CLAUDE_DEFAULTS) {
    if (!integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_A) {
      integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_A = DEFAULT_CONCURRENCY_CODEX_PROVIDER_A;
    }
    if (!integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_MODEL_A) {
      integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_MODEL_A = DEFAULT_CONCURRENCY_CODEX_MODEL_A;
    }
    if (!integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_B) {
      integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_B = DEFAULT_CONCURRENCY_CLAUDE_PROVIDER_B;
    }
    if (!integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_MODEL_B) {
      integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_MODEL_B = DEFAULT_CONCURRENCY_CLAUDE_MODEL_B;
    }
  } else if (ENABLE_CONCURRENCY_DEFAULTS) {
    if (!integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_A) {
      integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_A = DEFAULT_CONCURRENCY_PROVIDER_A;
    }
    if (!integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_MODEL_A) {
      integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_MODEL_A = DEFAULT_CONCURRENCY_MODEL_A;
    }
    if (!integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_B) {
      integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_B = DEFAULT_CONCURRENCY_PROVIDER_B;
    }
    if (!integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_MODEL_B) {
      integrationEnv.TORQUE_INTEGRATION_CONCURRENCY_MODEL_B = DEFAULT_CONCURRENCY_MODEL_B;
    }
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, VITEST_REST_ARGS, {
      cwd: SERVER_ROOT,
      env: integrationEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      testLogStream?.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      testLogStream?.write(chunk);
    });
    child.on('exit', (code) => resolve(code || 0));
  });
}

async function stopTorqueServer(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(5000).then(() => false),
  ]);
  if (!exited && !child.killed) {
    child.kill('SIGKILL');
  }
}

async function main() {
  const startedAt = new Date();
  const artifactRunId = runId();
  const artifactDir = path.join(ARTIFACTS_ROOT, artifactRunId);
  ensureDir(artifactDir);

  const summaryPath = path.join(artifactDir, 'summary.json');
  const serverLogPath = path.join(artifactDir, 'torque-server.log');
  const testLogPath = path.join(artifactDir, 'integration.log');

  const summary = {
    run_id: artifactRunId,
    started_at: startedAt.toISOString(),
    ended_at: null,
    base_url: BASE_URL,
    args: Array.from(CLI_ARGS),
    started_server: false,
    health_url: HEALTH_URL,
    exit_code: null,
    artifacts: {
      summary: summaryPath,
      server_log: serverLogPath,
      integration_log: testLogPath,
    },
    error: null,
  };
  writeSummary(summaryPath, summary);

  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: 'a' });
  const testLogStream = fs.createWriteStream(testLogPath, { flags: 'a' });

  let startedByScript = false;
  let torqueProcess = null;

  const alreadyHealthy = await isHealthy();
  if (!alreadyHealthy) {
    startedByScript = true;
    summary.started_server = true;
    writeSummary(summaryPath, summary);
    torqueProcess = startTorqueServer(serverLogStream);
    const ready = await waitForHealth(STARTUP_TIMEOUT_MS, STARTUP_INTERVAL_MS);
    if (!ready) {
      process.stderr.write(`Torque API was not healthy at ${HEALTH_URL} within ${STARTUP_TIMEOUT_MS}ms.\n`);
      summary.ended_at = new Date().toISOString();
      summary.exit_code = 1;
      summary.error = `health timeout after ${STARTUP_TIMEOUT_MS}ms`;
      writeSummary(summaryPath, summary);
      await stopTorqueServer(torqueProcess);
      serverLogStream.end();
      testLogStream.end();
      process.exit(1);
      return;
    }
  }

  const testExitCode = await runIntegrationTests(testLogStream);
  if (startedByScript) {
    await stopTorqueServer(torqueProcess);
  }

  summary.ended_at = new Date().toISOString();
  summary.exit_code = testExitCode;
  writeSummary(summaryPath, summary);
  serverLogStream.end();
  testLogStream.end();

  process.stdout.write(`[live-rest] artifacts: ${artifactDir}\n`);
  process.exit(testExitCode);
}

module.exports = { main };

if (require.main === module) {
  main().catch(async (error) => {
    const artifactRunId = runId();
    const artifactDir = path.join(ARTIFACTS_ROOT, artifactRunId);
    ensureDir(artifactDir);
    const summaryPath = path.join(artifactDir, 'summary.json');
    writeSummary(summaryPath, {
      run_id: artifactRunId,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      base_url: BASE_URL,
      args: Array.from(CLI_ARGS),
      started_server: false,
      health_url: HEALTH_URL,
      exit_code: 1,
      artifacts: {
        summary: summaryPath,
        server_log: path.join(artifactDir, 'torque-server.log'),
        integration_log: path.join(artifactDir, 'integration.log'),
      },
      error: error?.message || String(error || 'unknown'),
    });
    process.stderr.write(`Live REST local runner failed: ${error?.message || error}\n`);
    process.stderr.write(`[live-rest] artifacts: ${artifactDir}\n`);
    process.exit(1);
  });
}
