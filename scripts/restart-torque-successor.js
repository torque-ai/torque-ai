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
  return result.status === 0;
}

function npmCommand(nodeExecutable) {
  const nodeDir = path.dirname(nodeExecutable);
  const localNpm = path.join(nodeDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (fs.existsSync(localNpm)) {
    return localNpm;
  }
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
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

  const npm = npmCommand(process.execPath);
  if (fs.existsSync(path.join(serverDir, 'package.json'))) {
    log('rebuilding better-sqlite3');
    let ok = run(npm, ['--prefix', serverDir, 'rebuild', 'better-sqlite3'], { cwd: repoRoot, env });
    if (!ok) {
      log('better-sqlite3 rebuild failed, running npm install');
      ok = run(npm, ['--prefix', serverDir, 'install', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: repoRoot, env });
      if (!ok) {
        throw new Error('npm install failed after better-sqlite3 rebuild failure');
      }
      ok = run(npm, ['--prefix', serverDir, 'rebuild', 'better-sqlite3'], { cwd: repoRoot, env });
      if (!ok) {
        throw new Error('better-sqlite3 rebuild failed after npm install');
      }
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

main().catch((error) => {
  log(`ERROR: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
