'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_LOCAL_LANES = 4;
const DEFAULT_DASHBOARD_PORT = 3456;
const DEFAULT_GPU_PORT = 9394;
const DEFAULT_DASHBOARD_DEV_PORT = 5173;

const PRESETS = new Set([
  'server-smoke',
  'server-file',
  'dashboard-unit',
  'dashboard-e2e',
  'live-readiness',
]);

function defaultLaneRoot(platform = process.platform, env = process.env) {
  if (env.TORQUE_TEST_LANE_ROOT) return path.resolve(env.TORQUE_TEST_LANE_ROOT);
  if (platform === 'win32') return 'C:\\tmp\\torque-test-lanes';
  return path.join(os.tmpdir(), 'torque-test-lanes');
}

function parseLane(value) {
  const lane = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(lane) || lane < 1 || lane > MAX_LOCAL_LANES) {
    throw new Error(`Lane must be an integer from 1 to ${MAX_LOCAL_LANES}.`);
  }
  return lane;
}

function isAutoLane(value) {
  return value === null
    || value === undefined
    || String(value).trim().toLowerCase() === 'auto';
}

function resolveLaneConfig(laneValue, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const lane = parseLane(laneValue);
  const portOffset = (lane - 1) * 100;
  const laneRoot = path.join(
    options.root || defaultLaneRoot(platform, env),
    `lane-${lane}`
  );

  return {
    lane,
    root: path.dirname(laneRoot),
    laneRoot,
    lockDir: path.join(path.dirname(laneRoot), '.locks'),
    lockPath: path.join(path.dirname(laneRoot), '.locks', `lane-${lane}.json`),
    dataDir: path.join(laneRoot, 'data'),
    sandboxDir: path.join(laneRoot, 'sandbox'),
    tempDir: path.join(laneRoot, 'tmp'),
    cacheDir: path.join(laneRoot, 'cache'),
    coverageDir: path.join(laneRoot, 'coverage'),
    playwrightOutputDir: path.join(laneRoot, 'playwright'),
    logsDir: path.join(laneRoot, 'logs'),
    vitestTemplateDir: path.join(laneRoot, 'vitest-template'),
    vitestWorkerRoot: path.join(laneRoot, 'vitest-workers'),
    dashboardPort: DEFAULT_DASHBOARD_PORT + portOffset,
    apiPort: DEFAULT_DASHBOARD_PORT + portOffset + 1,
    mcpPort: DEFAULT_DASHBOARD_PORT + portOffset + 2,
    gpuMetricsPort: DEFAULT_GPU_PORT + portOffset,
    dashboardDevPort: DEFAULT_DASHBOARD_DEV_PORT + portOffset,
  };
}

function buildLaneEnv(config, baseEnv = process.env) {
  return {
    ...baseEnv,
    TORQUE_TEST_LANE: String(config.lane),
    TORQUE_TEST_LANE_ROOT: config.root,
    TORQUE_TEST_LANE_DIR: config.laneRoot,
    TORQUE_DATA_DIR: config.dataDir,
    TORQUE_TEST_SANDBOX: '1',
    TORQUE_TEST_SANDBOX_DIR: config.sandboxDir,
    TORQUE_VITEST_TEMPLATE_DIR: config.vitestTemplateDir,
    TORQUE_VITEST_WORKER_ROOT: config.vitestWorkerRoot,
    TORQUE_DASHBOARD_PORT: String(config.dashboardPort),
    TORQUE_API_PORT: String(config.apiPort),
    TORQUE_MCP_SSE_PORT: String(config.mcpPort),
    TORQUE_GPU_METRICS_PORT: String(config.gpuMetricsPort),
    TORQUE_DASHBOARD_DEV_PORT: String(config.dashboardDevPort),
    TORQUE_DASHBOARD_PROXY_TARGET: `http://127.0.0.1:${config.dashboardPort}`,
    TORQUE_VITEST_COVERAGE_DIR: config.coverageDir,
    TORQUE_COVERAGE_DIR: config.coverageDir,
    PLAYWRIGHT_OUTPUT_DIR: config.playwrightOutputDir,
    npm_config_cache: path.join(config.cacheDir, 'npm'),
    TMP: config.tempDir,
    TEMP: config.tempDir,
    TMPDIR: config.tempDir,
  };
}

function ensureLaneDirs(config) {
  for (const dir of [
    config.laneRoot,
    config.lockDir,
    config.dataDir,
    config.sandboxDir,
    config.tempDir,
    config.cacheDir,
    config.coverageDir,
    config.playwrightOutputDir,
    config.logsDir,
    config.vitestTemplateDir,
    config.vitestWorkerRoot,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function releaseLaneLock(lockPath, pid = process.pid) {
  const current = readJson(lockPath);
  if (!current || Number(current.pid) !== Number(pid)) return false;
  fs.unlinkSync(lockPath);
  return true;
}

function acquireLaneLock(config, options = {}) {
  const pid = options.pid || process.pid;
  const alive = options.isPidAlive || isPidAlive;
  const now = options.now || (() => new Date());
  fs.mkdirSync(config.lockDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(config.lockPath, 'wx');
      const payload = {
        lane: config.lane,
        pid,
        command: options.command || null,
        started_at: now().toISOString(),
      };
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
      fs.closeSync(fd);
      return () => releaseLaneLock(config.lockPath, pid);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      const existing = readJson(config.lockPath);
      if (existing && alive(existing.pid)) {
        throw new Error(
          `Lane ${config.lane} is already locked by PID ${existing.pid}` +
          (existing.command ? ` (${existing.command})` : '') +
          `. Lock: ${config.lockPath}`
        );
      }
      try {
        fs.unlinkSync(config.lockPath);
      } catch (unlinkErr) {
        if (!unlinkErr || unlinkErr.code !== 'ENOENT') throw unlinkErr;
      }
    }
  }

  throw new Error(`Could not acquire lane ${config.lane} lock: ${config.lockPath}`);
}

function acquireSelectedLaneLock(laneValue, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const root = options.root;
  const lanes = isAutoLane(laneValue)
    ? Array.from({ length: MAX_LOCAL_LANES }, (_unused, index) => index + 1)
    : [parseLane(laneValue)];
  const busy = [];

  for (const lane of lanes) {
    const config = resolveLaneConfig(lane, { env, platform, root });
    ensureLaneDirs(config);
    try {
      const release = acquireLaneLock(config, options);
      return { config, release };
    } catch (err) {
      if (!isAutoLane(laneValue) || !String(err && err.message || '').includes('already locked by PID')) {
        throw err;
      }
      busy.push(err.message);
    }
  }

  throw new Error(`No test lanes are available. ${busy.join(' ')}`.trim());
}

function repoRootFromScript() {
  return path.resolve(__dirname, '..');
}

function quoteForShell(value, platform = process.platform) {
  const text = String(value);
  if (platform === 'win32') return `'${text.replace(/'/g, "''")}'`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function normalizeServerFile(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return normalized.startsWith('server/') ? normalized.slice('server/'.length) : normalized;
}

function getPresetCommand(preset, options = {}) {
  const repoRoot = options.repoRoot || repoRootFromScript();
  if (!PRESETS.has(preset)) {
    throw new Error(`Unknown preset "${preset}". Expected one of: ${[...PRESETS].join(', ')}`);
  }
  if (preset === 'server-smoke') {
    return { cwd: repoRoot, command: 'npm run test:smoke' };
  }
  if (preset === 'server-file') {
    if (!options.file) throw new Error('Preset "server-file" requires --file <path>.');
    const file = quoteForShell(normalizeServerFile(options.file), options.platform);
    return { cwd: path.join(repoRoot, 'server'), command: `npx vitest run ${file}` };
  }
  if (preset === 'dashboard-unit') {
    return { cwd: path.join(repoRoot, 'dashboard'), command: 'npm run test' };
  }
  if (preset === 'dashboard-e2e') {
    return { cwd: path.join(repoRoot, 'dashboard'), command: 'npm run test:e2e' };
  }
  return { cwd: path.join(repoRoot, 'server'), command: 'npm run ci:mcp-launch-readiness' };
}

function runShellCommand(command, options = {}) {
  const platform = options.platform || process.platform;
  const cwd = options.cwd || repoRootFromScript();
  const env = options.env || process.env;
  const stdio = options.stdio || 'inherit';
  const candidates = platform === 'win32'
    ? [
        { shell: 'pwsh', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command] },
        { shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command] },
      ]
    : [{ shell: 'bash', args: ['-lc', command] }];

  let lastResult = null;
  for (const candidate of candidates) {
    const result = spawnSync(candidate.shell, candidate.args, { cwd, env, stdio });
    lastResult = result;
    if (!result.error || result.error.code !== 'ENOENT') return result;
  }
  return lastResult;
}

function parseArgs(argv) {
  const parsed = { lane: 'auto', preset: null, command: null, commandBase64: null, file: null, root: null, printEnv: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--lane' || arg === '-Lane') parsed.lane = next();
    else if (arg === '--preset' || arg === '-Preset') parsed.preset = next();
    else if (arg === '--command' || arg === '-Command') parsed.command = next();
    else if (arg === '--command-base64') parsed.commandBase64 = next();
    else if (arg === '--file' || arg === '-File') parsed.file = next();
    else if (arg === '--root' || arg === '-LaneRoot') parsed.root = next();
    else if (arg === '--print-env' || arg === '-PrintEnv') parsed.printEnv = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command && args.commandBase64) {
    throw new Error('Use only one of --command or --command-base64.');
  }
  const decodedCommand = args.commandBase64
    ? Buffer.from(args.commandBase64, 'base64').toString('utf8')
    : args.command;
  const selected = decodedCommand
    ? { cwd: repoRootFromScript(), command: decodedCommand }
    : getPresetCommand(args.preset || 'server-smoke', { file: args.file });

  if (args.printEnv) {
    const config = resolveLaneConfig(isAutoLane(args.lane) ? 1 : args.lane, { root: args.root });
    const env = buildLaneEnv(config);
    process.stdout.write(JSON.stringify({ config, env: {
      TORQUE_TEST_LANE: env.TORQUE_TEST_LANE,
      TORQUE_DATA_DIR: env.TORQUE_DATA_DIR,
      TORQUE_DASHBOARD_PORT: env.TORQUE_DASHBOARD_PORT,
      TORQUE_API_PORT: env.TORQUE_API_PORT,
      TORQUE_MCP_SSE_PORT: env.TORQUE_MCP_SSE_PORT,
      TORQUE_DASHBOARD_DEV_PORT: env.TORQUE_DASHBOARD_DEV_PORT,
    } }, null, 2) + '\n');
    return 0;
  }

  const { config, release } = acquireSelectedLaneLock(args.lane, {
    root: args.root,
    command: selected.command,
  });
  const env = buildLaneEnv(config);
  try {
    process.stderr.write(`[test-lane] lane=${config.lane} data=${config.dataDir}\n`);
    process.stderr.write(`[test-lane] ports dashboard=${config.dashboardPort} api=${config.apiPort} mcp=${config.mcpPort} vite=${config.dashboardDevPort}\n`);
    process.stderr.write(`[test-lane] command=${selected.command}\n`);
    const result = runShellCommand(selected.command, { cwd: selected.cwd, env });
    if (result.error) throw result.error;
    return result.status == null ? 1 : result.status;
  } finally {
    release();
  }
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`[test-lane] ERROR: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MAX_LOCAL_LANES,
  PRESETS,
  acquireLaneLock,
  acquireSelectedLaneLock,
  buildLaneEnv,
  defaultLaneRoot,
  ensureLaneDirs,
  getPresetCommand,
  isPidAlive,
  isAutoLane,
  parseArgs,
  releaseLaneLock,
  resolveLaneConfig,
  runShellCommand,
};
