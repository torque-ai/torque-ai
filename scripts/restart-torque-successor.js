#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key || !key.startsWith('--')) continue;
    result[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const serverScript = args.serverScript;
const repoRoot = args.repoRoot;
const parentPid = Number.parseInt(args.parentPid || '', 10);
const minMajor = Number.parseInt(args.minMajor || '24', 10);
const logDir = path.join(os.homedir(), '.torque');
const logFile = path.join(logDir, 'restart-node24.log');

function log(message) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

function assertNodeVersion() {
  const version = process.version;
  const match = /^v(\d+)\./.exec(version);
  const major = match ? Number.parseInt(match[1], 10) : 0;
  if (major < minMajor) {
    throw new Error(`Restart helper requires Node >= ${minMajor}; running ${version} at ${process.execPath}`);
  }
  return version;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForParentExit(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid parent PID: ${pid}`);
  }

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await wait(250);
    } catch {
      return;
    }
  }

  throw new Error(`Parent PID ${pid} did not exit before timeout`);
}

function run(command, commandArgs, options = {}) {
  const result = childProcess.spawnSync(command, commandArgs, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.status === 0) {
    return true;
  }
  const detail = result.error
    ? result.error.message
    : `status=${result.status} signal=${result.signal || 'none'}`;
  log(`${options.label || command} failed: ${detail}`);
  return false;
}

function npmCommand(nodeExecutable) {
  const nodeDir = path.dirname(nodeExecutable);
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(npmCli)) {
    return { command: nodeExecutable, argsPrefix: [npmCli] };
  }
  const localNpm = path.join(nodeDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (fs.existsSync(localNpm)) {
    return { command: localNpm, argsPrefix: [] };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', argsPrefix: [] };
}

function runNpm(npm, npmArgs, options) {
  return run(npm.command, [...npm.argsPrefix, ...npmArgs], options);
}

const UNLOCK_POLL_BUDGET_MS = Number.parseInt(process.env.RESTART_HELPER_UNLOCK_BUDGET_MS || '30000', 10);
const UNLOCK_POLL_INTERVAL_MS = Number.parseInt(process.env.RESTART_HELPER_UNLOCK_INTERVAL_MS || '1000', 10);
const REBUILD_MAX_ATTEMPTS = Number.parseInt(process.env.RESTART_HELPER_REBUILD_ATTEMPTS || '2', 10);

function getBetterSqliteBinaryPath(serverDir) {
  return path.join(
    serverDir,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
}

// Try to load better-sqlite3 in a fresh child Node process. Spawn a child
// rather than `require()`-ing in the helper itself so we never hold an open
// handle on the .node binary — that would extend the file lock and pessimize
// the rebuild path if we needed to fall through to it.
function tryLoadBetterSqlite3(nodeExec, serverDir, env) {
  const probeScript = `
    try {
      require(${JSON.stringify(path.join(serverDir, 'node_modules', 'better-sqlite3'))});
      process.exit(0);
    } catch (err) {
      process.stderr.write(String(err && err.message ? err.message : err) + '\\n');
      process.exit(1);
    }
  `;
  const result = childProcess.spawnSync(nodeExec, ['-e', probeScript], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    timeout: 15000,
  });
  if (result.status === 0) return { loaded: true };
  const stderr = result.stderr ? String(result.stderr).trim() : '';
  return { loaded: false, error: stderr || `status=${result.status} signal=${result.signal || 'none'}` };
}

// Poll until the .node binary can be opened r+ (i.e. nothing else holds an
// exclusive handle on it). Returns true if the file opens within the budget;
// returns false on timeout but the caller proceeds with the rebuild anyway —
// we'd rather try and fail loudly than introduce a new "never returns" path.
async function waitForFileUnlock(filepath, budgetMs, intervalMs) {
  if (!fs.existsSync(filepath)) {
    // No binary on disk at all — rebuild needs to create it from prebuild
    // anyway, so there's no lock to wait for.
    return true;
  }
  const deadline = Date.now() + budgetMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const fd = fs.openSync(filepath, 'r+');
      fs.closeSync(fd);
      log(`waitForFileUnlock: ${path.basename(filepath)} unlocked after ${attempts} attempt(s)`);
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return true;
      await wait(intervalMs);
    }
  }
  log(`waitForFileUnlock: ${path.basename(filepath)} still locked after ${attempts} attempt(s); proceeding anyway`);
  return false;
}

async function ensureBetterSqliteUsable(npm, serverDir, env, opts = {}) {
  const cwd = opts.cwd || serverDir;
  const probe = tryLoadBetterSqlite3(process.execPath, serverDir, env);
  if (probe.loaded) {
    log('better-sqlite3 loads cleanly; skipping rebuild');
    return { rebuilt: false, usable: true };
  }
  log(`better-sqlite3 load failed (${probe.error}); will attempt rebuild`);

  const binary = getBetterSqliteBinaryPath(serverDir);
  for (let attempt = 1; attempt <= REBUILD_MAX_ATTEMPTS; attempt += 1) {
    await waitForFileUnlock(binary, UNLOCK_POLL_BUDGET_MS, UNLOCK_POLL_INTERVAL_MS);
    log(`rebuilding better-sqlite3 (attempt ${attempt}/${REBUILD_MAX_ATTEMPTS})`);
    const ok = runNpm(npm, ['--prefix', serverDir, 'rebuild', 'better-sqlite3'], {
      cwd,
      env,
      label: `npm rebuild better-sqlite3 attempt ${attempt}`,
    });
    if (ok) {
      const recheck = tryLoadBetterSqlite3(process.execPath, serverDir, env);
      if (recheck.loaded) {
        log(`rebuild attempt ${attempt} succeeded and binary loads`);
        return { rebuilt: true, usable: true };
      }
      log(`rebuild attempt ${attempt} reported success but binary still fails to load: ${recheck.error}`);
    }
  }

  // Last-ditch: full npm install in case node_modules is genuinely corrupted
  // (rather than just a file-lock symptom). Then re-probe.
  log('all rebuild attempts failed; trying npm install --prefer-offline as last resort');
  const installOk = runNpm(npm, ['--prefix', serverDir, 'install', '--prefer-offline', '--no-audit', '--no-fund'], {
    cwd,
    env,
    label: 'npm install (last resort)',
  });
  if (installOk) {
    const recheck = tryLoadBetterSqlite3(process.execPath, serverDir, env);
    if (recheck.loaded) {
      log('npm install fixed better-sqlite3');
      return { rebuilt: true, usable: true };
    }
    log(`npm install ran but binary still fails to load: ${recheck.error}`);
  }

  return { rebuilt: false, usable: false };
}

async function main() {
  if (!serverScript || !repoRoot) {
    throw new Error('Missing --server-script or --repo-root');
  }

  const nodeVersion = assertNodeVersion();
  const nodeDir = path.dirname(process.execPath);
  const serverDir = path.join(repoRoot, 'server');
  const env = {
    ...process.env,
    PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ''}`,
  };

  log(`helper starting under ${process.execPath} ${nodeVersion} for parent PID ${parentPid}`);
  await waitForParentExit(parentPid);
  log(`parent PID ${parentPid} exited`);

  if (fs.existsSync(path.join(serverDir, 'package.json'))) {
    const npm = npmCommand(process.execPath);
    const result = await ensureBetterSqliteUsable(npm, serverDir, env, { cwd: repoRoot });
    if (!result.usable) {
      // Spawn anyway. A truly broken binary will produce a loud, fast,
      // debuggable startup crash on first Database.open() — strictly
      // better than "TORQUE never came back" silent failure that looks
      // identical to a successful restart from the outside. On Windows,
      // EBUSY-from-Defender is the dominant failure mode and the existing
      // binary almost always works; refusing to spawn would extend a
      // 2-second AV scan into a permanent outage.
      log('WARNING: better-sqlite3 is not loading and rebuild attempts failed; spawning server anyway. If TORQUE crashes on startup, run `cd server && npm install` manually.');
    }
  }

  const child = childProcess.spawn(process.execPath, [serverScript], {
    cwd: serverDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
  log(`started TORQUE successor PID ${child.pid}`);
}

if (require.main === module) {
  main().catch((error) => {
    log(`ERROR: ${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  tryLoadBetterSqlite3,
  waitForFileUnlock,
  ensureBetterSqliteUsable,
  getBetterSqliteBinaryPath,
};
