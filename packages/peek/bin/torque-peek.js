#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process'); // eslint-disable-line security/detect-child-process
const fs = require('fs');
const http = require('http');
const { once } = require('events');
const {
  DEFAULT_HOST,
  DEFAULT_PORT,
  TOKEN_HEADER,
  createServer,
  getDefaultPidFile,
  normalizePort,
} = require('../src/server');
const { checkDependencies } = require('../src/platform/detect');
const packageInfo = require('../package.json');

const DEFAULT_REQUEST_TIMEOUT_MS = 3000;
const DEFAULT_STOP_TIMEOUT_MS = 5000;
const CLIENT_LOOPBACK_HOST = '127.0.0.1';

const KNOWN_OPTIONS = new Map([
  ['--host', 'host'],
  ['--port', 'port'],
  ['--token', 'token'],
  ['--pid-file', 'pidFile'],
  ['--timeout', 'timeout'],
]);

function createIo(stdout = process.stdout, stderr = process.stderr) {
  return {
    stdout,
    stderr,
    log(message = '') {
      stdout.write(`${message}\n`);
    },
    error(message = '') {
      stderr.write(`${message}\n`);
    },
  };
}

function parseArgs(argv = []) {
  const parsed = {
    command: argv[0] || 'help',
    options: {},
    positionals: [],
  };
  let startIndex = 1;

  if (parsed.command === '--help' || parsed.command === '-h') {
    parsed.command = 'help';
    parsed.options.help = true;
    startIndex = 1;
  } else if (parsed.command === '--version' || parsed.command === '-v') {
    parsed.command = 'version';
    parsed.options.version = true;
    startIndex = 1;
  }

  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      parsed.options.help = true;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      parsed.options.version = true;
      continue;
    }

    if (arg === '--json') {
      parsed.options.json = true;
      continue;
    }

    if (arg === '--daemon' || arg === '-d') {
      parsed.options.daemon = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const equalsIndex = arg.indexOf('=');
      const optionName = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
      const key = KNOWN_OPTIONS.get(optionName);
      if (!key) {
        const error = new Error(`Unknown option: ${optionName}`);
        error.code = 'INVALID_USAGE';
        throw error;
      }

      if (equalsIndex !== -1) {
        parsed.options[key] = arg.slice(equalsIndex + 1);
      } else {
        index += 1;
        if (index >= argv.length) {
          const error = new Error(`Missing value for ${optionName}`);
          error.code = 'INVALID_USAGE';
          throw error;
        }
        parsed.options[key] = argv[index];
      }
      continue;
    }

    parsed.positionals.push(arg);
  }

  return parsed;
}

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    const error = new Error(`${name} must be a positive integer`);
    error.code = 'INVALID_USAGE';
    throw error;
  }
  return number;
}

function resolveConfig(options = {}, env = process.env) {
  const host = options.host || env.TORQUE_PEEK_HOST || DEFAULT_HOST;
  const port = normalizePort(options.port || env.TORQUE_PEEK_PORT || DEFAULT_PORT);
  const token = options.token || env.TORQUE_PEEK_TOKEN || null;
  const pidFile = options.pidFile || env.TORQUE_PEEK_PID_FILE || getDefaultPidFile();
  const timeoutMs = options.timeout
    ? parsePositiveInteger(options.timeout, '--timeout')
    : DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    host,
    port,
    token,
    pidFile,
    timeoutMs,
  };
}

function getClientHost(host) {
  if (!host || host === '0.0.0.0' || host === '::') return CLIENT_LOOPBACK_HOST;
  return host;
}

function formatBaseUrl(config) {
  const host = getClientHost(config.host);
  const needsBrackets = host.includes(':') && !host.startsWith('[');
  return `http://${needsBrackets ? `[${host}]` : host}:${config.port}`;
}

function parseResponseBody(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return raw;
  }
}

function requestJson({ config, method = 'GET', requestPath = '/health', body = null, timeoutMs }, httpModule = http) {
  const payload = body === null || body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (config.token) headers[TOKEN_HEADER] = String(config.token);
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = httpModule.request(
      {
        hostname: getClientHost(config.host),
        port: config.port,
        path: requestPath,
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
            body: parseResponseBody(raw),
            headers: res.headers,
          });
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS}ms`));
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function probeServer(config, deps = {}) {
  try {
    const response = await (deps.requestJson || requestJson)({
      config,
      method: 'GET',
      requestPath: '/health',
      timeoutMs: config.timeoutMs,
    });
    return { reachable: true, response };
  } catch (error) {
    return { reachable: false, error };
  }
}

function formatList(values) {
  return values && values.length > 0 ? values.join(', ') : 'none';
}

function writeJson(io, value) {
  io.log(JSON.stringify(value, null, 2));
}

function writeDependencyReport(io, report) {
  io.log('Peek dependency check');
  io.log(`  Platform:     ${report.platform || process.platform}`);
  io.log(`  Supported:    ${report.supported ? 'yes' : 'no'}`);
  io.log(`  Adapter:      ${report.adapter || 'none'}`);
  io.log(`  Status:       ${report.ok ? 'ok' : 'degraded'}`);
  io.log(`  Capabilities: ${formatList(report.capabilities)}`);
  io.log(`  Available:    ${formatList(report.available)}`);
  io.log(`  Missing:      ${formatList(report.missing)}`);

  if (report.error) {
    io.log(`  Error:        ${report.error}`);
  }

  if (Array.isArray(report.checks) && report.checks.length > 0) {
    io.log('');
    io.log('Dependency details');
    for (const check of report.checks) {
      const state = check.available ? 'ok' : 'missing';
      const alternatives = Array.isArray(check.anyOf) ? ` (${check.anyOf.join(' or ')})` : '';
      io.log(`  ${state.padEnd(7)} ${check.name}${alternatives}`);
      if (!check.available && check.install) {
        io.log(`          ${check.install}`);
      }
    }
  }
}

function writeStatusReport(io, config, health) {
  io.log('Peek server');
  io.log(`  URL:          ${formatBaseUrl(config)}`);
  io.log(`  Status:       ${health.status || 'unknown'}`);
  io.log(`  Platform:     ${health.platform || 'unknown'}`);
  io.log(`  Supported:    ${health.supported ? 'yes' : 'no'}`);
  io.log(`  Adapter:      ${health.adapter || 'none'}`);
  io.log(`  Version:      ${health.version || packageInfo.version}`);
  io.log(`  Uptime:       ${Math.round(Number(health.uptime_seconds || 0))}s`);
  io.log(`  Capabilities: ${formatList(health.capabilities)}`);

  const dependencies = health.dependencies || {};
  if (dependencies.missing && dependencies.missing.length > 0) {
    io.log(`  Missing:      ${dependencies.missing.join(', ')}`);
  }
}

function loadPlatformAdapter(platform = process.platform) {
  const adapters = {
    win32: '../src/platform/win32',
    darwin: '../src/platform/darwin',
    linux: '../src/platform/linux',
  };
  const adapterPath = adapters[platform];
  if (!adapterPath) return null;

  const Adapter = require(adapterPath);
  return new Adapter();
}

async function waitForServerClose(instance) {
  if (!instance || !instance.server) return;
  if (!instance.server.listening) return;
  await once(instance.server, 'close');
}

async function waitForListening(instance) {
  if (!instance || !instance.server) return;
  if (instance.server.listening) return;
  await Promise.race([
    once(instance.server, 'listening'),
    once(instance.server, 'error').then(([error]) => {
      throw error;
    }),
  ]);
}

function readPid(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_error) {
    return null;
  }
}

function removePidFile(pidFile) {
  try {
    fs.unlinkSync(pidFile);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

async function waitForExit(pid, deps = {}, timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await sleep(250);
  }
  return !processExists(pid);
}

async function waitUntilUnreachable(config, deps = {}, timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const probe = await probeServer(config, deps);
    if (!probe.reachable) return true;
    await sleep(250);
  }

  return false;
}

function buildDaemonArgs(config) {
  const args = [__filename, 'start', '--host', config.host, '--port', String(config.port), '--pid-file', config.pidFile];
  if (config.token) args.push('--token', config.token);
  return args;
}

async function runCheck(parsed, deps) {
  const io = deps.io;
  const report = (deps.checkDependencies || checkDependencies)();
  if (parsed.options.json) writeJson(io, report);
  else writeDependencyReport(io, report);
  return report.ok ? 0 : 1;
}

async function runStatus(parsed, deps) {
  const io = deps.io;
  const config = resolveConfig(parsed.options, deps.env);
  const response = await (deps.requestJson || requestJson)({
    config,
    method: 'GET',
    requestPath: '/health',
    timeoutMs: config.timeoutMs,
  });

  if (!response.ok) {
    io.error(`Peek server returned HTTP ${response.status} from ${formatBaseUrl(config)}/health`);
    if (response.body && response.body.error) io.error(`  ${response.body.error}`);
    return 1;
  }

  if (parsed.options.json) writeJson(io, response.body);
  else writeStatusReport(io, config, response.body || {});
  return 0;
}

async function runStartDaemon(config, deps) {
  const io = deps.io;
  const child = (deps.spawn || spawn)(process.execPath, buildDaemonArgs(config), {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...(deps.env || {}) },
  });

  if (typeof child.unref === 'function') child.unref();

  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const probe = await probeServer(config, deps);
    if (probe.reachable && probe.response.ok) {
      io.log(`Peek server started in background on ${formatBaseUrl(config)} (PID ${child.pid || 'unknown'}).`);
      return 0;
    }
    await sleep(250);
  }

  io.error(`Peek server was started but did not become healthy at ${formatBaseUrl(config)}/health.`);
  return 1;
}

async function runStart(parsed, deps) {
  const io = deps.io;
  const config = resolveConfig(parsed.options, deps.env);
  const probe = await probeServer(config, deps);

  if (probe.reachable) {
    io.log(`Peek server is already reachable at ${formatBaseUrl(config)}.`);
    return probe.response && probe.response.ok ? 0 : 1;
  }

  if (parsed.options.daemon) {
    return runStartDaemon(config, deps);
  }

  const adapter = deps.createPlatformAdapter
    ? deps.createPlatformAdapter(process.platform)
    : loadPlatformAdapter(process.platform);

  const instance = (deps.createServer || createServer)({
    host: config.host,
    port: config.port,
    token: config.token,
    pidFile: config.pidFile,
    adapter,
    version: packageInfo.version,
    installSignalHandlers: deps.installSignalHandlers !== false,
  });

  await waitForListening(instance);

  io.log(`Peek server listening on ${formatBaseUrl(config)}`);
  io.log(`  PID file: ${config.pidFile}`);
  io.log(`  Adapter:  ${adapter ? adapter.platform || process.platform : 'none'}`);

  await waitForServerClose(instance);
  return 0;
}

async function runStop(parsed, deps) {
  const io = deps.io;
  const config = resolveConfig(parsed.options, deps.env);

  try {
    const response = await (deps.requestJson || requestJson)({
      config,
      method: 'POST',
      requestPath: '/shutdown',
      body: { reason: 'cli stop' },
      timeoutMs: config.timeoutMs,
    });

    if (response.ok) {
      io.log('Peek server shutting down.');
      await waitUntilUnreachable(config, deps);
      return 0;
    }
  } catch (_error) {
    // Fall back to the PID file if the HTTP control plane is unavailable.
  }

  const pid = readPid(config.pidFile);
  if (!pid) {
    io.error(`Peek server is not reachable and no PID file was found at ${config.pidFile}.`);
    return 1;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    io.error(`Unable to signal PID ${pid}: ${error.message}`);
    removePidFile(config.pidFile);
    return 1;
  }

  const exited = await waitForExit(pid, deps);
  if (!exited) {
    io.error(`Warning: PID ${pid} did not exit within ${DEFAULT_STOP_TIMEOUT_MS}ms.`);
    return 1;
  }

  removePidFile(config.pidFile);
  io.log(`Stopped peek server PID ${pid}.`);
  return 0;
}

function printHelp(io) {
  io.log(`@torque-ai/peek ${packageInfo.version}

Usage: torque-peek <command> [options]

Commands:
  start              Start the local peek HTTP server in the foreground
  start --daemon     Start the local peek HTTP server in the background
  stop               Stop the local peek HTTP server
  status             Show server health from /health
  check              Check platform dependencies without starting the server

Options:
  --host <host>      Bind or connect host (default: ${DEFAULT_HOST})
  --port <port>      Bind or connect port (default: ${DEFAULT_PORT})
  --token <token>    Require or send X-Peek-Token
  --pid-file <path>  PID file path (default: ${getDefaultPidFile()})
  --timeout <ms>     HTTP request timeout (default: ${DEFAULT_REQUEST_TIMEOUT_MS})
  --json             Emit JSON for status and check
  --help             Show this help
  --version          Show package version`);
}

async function runCli(argv = process.argv.slice(2), deps = {}) {
  const io = deps.io || createIo();
  let parsed;

  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.error(error.message || String(error));
    return 2;
  }

  if (parsed.options.version || parsed.command === 'version') {
    io.log(packageInfo.version);
    return 0;
  }

  if (parsed.options.help || parsed.command === 'help') {
    printHelp(io);
    return 0;
  }

  try {
    if (parsed.command === 'check') return await runCheck(parsed, { ...deps, io });
    if (parsed.command === 'status') return await runStatus(parsed, { ...deps, io });
    if (parsed.command === 'start') return await runStart(parsed, { ...deps, io });
    if (parsed.command === 'stop') return await runStop(parsed, { ...deps, io });

    io.error(`Unknown command: ${parsed.command}`);
    io.error("Run 'torque-peek --help' for usage.");
    return 2;
  } catch (error) {
    io.error(error.message || String(error));
    return error && error.code === 'INVALID_USAGE' ? 2 : 1;
  }
}

if (require.main === module) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  buildDaemonArgs,
  createIo,
  formatBaseUrl,
  loadPlatformAdapter,
  parseArgs,
  requestJson,
  resolveConfig,
  runCli,
};
