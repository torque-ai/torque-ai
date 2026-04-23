'use strict';

/**
 * Per-worker vitest setup — git process interception.
 *
 * PROBLEM: On Windows, vitest forks don't propagate signals to child processes.
 * Production code (context-enrichment, git-worktree, agentic-git-safety, etc.)
 * calls execFileSync('git', ...) and spawnSync('git', ...). Each spawns a real
 * git.exe that can outlive the worker fork. With 8 workers × 78 test files × 3+
 * git calls per file, hundreds of orphaned git.exe processes accumulate (~190MB
 * each), consuming all system memory.
 *
 * SOLUTION: Monkey-patch child_process.execFileSync and child_process.spawnSync
 * BEFORE any test modules load. When the command is 'git', return a stub
 * response. Zero git processes spawned = zero orphans.
 *
 * Tests needing real git use git-test-utils.js gitSync() which calls
 * childProcess._realExecFileSync (the saved original).
 *
 * Why not vi.mock('child_process')?
 *   vi.mock does NOT work for Node built-ins in pool:forks + CJS mode.
 *   Monkey-patching before require() is the only reliable approach.
 *   (See snapscope-handlers.test.js for prior art.)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const childProcess = require('child_process');

function wireSharedServerNodeModules() {
  // Keep worker setup to path wiring only; importing high fan-out server modules here
  // would cache them before each test file gets its own module graph.
  const sharedServerNodeModules = path.resolve(__dirname, '..', '..', '..', '..', 'server', 'node_modules');
  if (!fs.existsSync(sharedServerNodeModules)) return;

  const nodePathEntries = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  if (!nodePathEntries.includes(sharedServerNodeModules)) {
    process.env.NODE_PATH = [sharedServerNodeModules, ...nodePathEntries].join(path.delimiter);
    Module._initPaths();
  }
}

wireSharedServerNodeModules();

const TEST_DATA_ROOT = path.join(os.tmpdir(), 'torque-vitest-workers');
const workerId = process.env.VITEST_WORKER_ID || process.env.TEST_WORKER_ID || String(process.pid);
const workerDataDir = path.join(TEST_DATA_ROOT, `worker-${workerId}`);

fs.mkdirSync(workerDataDir, { recursive: true });
process.env.TORQUE_TEST_SANDBOX = '1';
process.env.TORQUE_TEST_SANDBOX_DIR = workerDataDir;
process.env.TORQUE_DATA_DIR = workerDataDir;
try {
  require('../data-dir').setDataDir(null);
} catch {
  // data-dir may not have loaded yet in very small test shards
}

// Save originals — git-test-utils.js uses these for real git operations
const _realExecFileSync = childProcess.execFileSync;
const _realSpawn = childProcess.spawn;
const _realSpawnSync = childProcess.spawnSync;
childProcess._realExecFileSync = _realExecFileSync;
childProcess._realSpawn = _realSpawn;
childProcess._realSpawnSync = _realSpawnSync;

function isGitCommand(file) {
  if (typeof file !== 'string') return false;
  const lower = file.toLowerCase();
  return lower === 'git' || lower.endsWith('/git') || lower.endsWith('\\git') || lower.endsWith('git.exe');
}

function getSubcommand(args) {
  if (!Array.isArray(args)) return '';
  for (const a of args) {
    if (typeof a === 'string' && a.length > 0 && !a.startsWith('-')) return a;
  }
  return '';
}

function stubGitOutput(args, encoding) {
  const sub = getSubcommand(args);
  const isUtf8 = encoding === 'utf8' || encoding === 'utf-8';
  const wrap = (s) => isUtf8 ? s : Buffer.from(s);

  if (sub === 'rev-parse') {
    if (args.includes('--abbrev-ref')) return wrap('main\n');
    if (args.includes('--show-toplevel')) return wrap('/mock/repo\n');
    if (args.includes('--git-dir')) return wrap('.git\n');
    return wrap('abcdef1234567890\n');
  }
  if (sub === 'status') return wrap('');
  if (sub === 'diff') return wrap('');
  if (sub === 'log') return wrap('');
  if (sub === 'config') return wrap('');
  if (sub === 'init') return wrap('Initialized empty Git repository\n');
  if (sub === 'add') return wrap('');
  if (sub === 'commit') return wrap('[main abcdef1] test commit\n');
  if (sub === 'checkout') return wrap('');
  if (sub === 'push') return wrap('');
  if (sub === 'show') return wrap('');
  if (sub === 'worktree') return wrap('');
  if (sub === 'apply') return wrap('');
  if (sub === 'check-ignore') {
    // check-ignore returns exit code 1 when file is NOT ignored
    const err = new Error('not ignored');
    err.status = 1;
    err.stdout = isUtf8 ? '' : Buffer.alloc(0);
    err.stderr = isUtf8 ? '' : Buffer.alloc(0);
    throw err;
  }
  return wrap('');
}

function isAgentCliCommand(file) {
  if (typeof file !== 'string') return false;
  const base = path.basename(file).toLowerCase();
  return base === 'codex'
    || base === 'codex.exe'
    || base === 'codex.cmd'
    || base === 'claude'
    || base === 'claude.cmd';
}

function createBlockedAgentChild(command, args) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 0;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };

  process.nextTick(() => {
    const renderedArgs = Array.isArray(args) ? args.join(' ') : '';
    child.stderr.write(`[test-sandbox] blocked real agent CLI spawn: ${command} ${renderedArgs}\n`);
    child.stdin.end();
    child.stderr.end();
    child.stdout.end();
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });

  return child;
}

// Patch execFileSync — intercept git, pass through everything else
childProcess.execFileSync = function(file, args, options) {
  if (isGitCommand(file)) {
    return stubGitOutput(args, options?.encoding);
  }
  return _realExecFileSync.call(this, file, args, options);
};

// Patch spawn — block accidental real agent CLIs in tests. Test files that need
// process behavior should install their own mock spawn; real Codex/Claude runs
// are too slow and can leak child processes on Windows.
childProcess.spawn = function(command, args, options) {
  if (process.env.TORQUE_ALLOW_REAL_AGENT_CLI !== '1' && isAgentCliCommand(command)) {
    return createBlockedAgentChild(command, args);
  }
  return _realSpawn.call(this, command, args, options);
};

// Patch spawnSync — intercept git, pass through everything else
childProcess.spawnSync = function(command, args, options) {
  if (isGitCommand(command)) {
    const stdout = stubGitOutput(args, options?.encoding);
    return {
      stdout: typeof stdout === 'string' ? stdout : stdout.toString(),
      stderr: '',
      status: 0,
      signal: null,
      error: null,
      pid: 0,
      output: [null, stdout, ''],
    };
  }
  return _realSpawnSync.call(this, command, args, options);
};

module.exports = {
  wireSharedServerNodeModules,
  isGitCommand,
  isAgentCliCommand,
  getSubcommand,
  stubGitOutput,
};
