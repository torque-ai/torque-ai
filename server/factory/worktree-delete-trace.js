'use strict';

// Diagnostic instrumentation for locating what deletes factory worktree
// directories between `worktree_created` and `executor.execute`.
//
// On load, monkey-patches the two syscalls that can remove a worktree:
//   - fs.rmSync  (used by worktree-manager pre-add cleanup, retry cleanup,
//     and by worktree-reconcile's forceRmDir)
//   - childProcess.execFileSync  (used for `git worktree remove --force`
//     and `git branch -D`)
//
// For calls touching `.worktrees/feat-factory-*/` paths, writes a timestamped
// event with a full stack trace to `${TORQUE_DATA_DIR}/worktree-delete-trace.log`.
// All other calls pass through unchanged.
//
// Delete this file once the race is diagnosed — it's pure diagnostic code,
// not production logic.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const DATA_DIR = process.env.TORQUE_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', '.torque');
const TRACE_FILE = path.join(DATA_DIR, 'worktree-delete-trace.log');

const WORKTREE_PATH_MATCH = /[\\/]\.worktrees[\\/]feat-factory-/i;

function matchesFactoryWorktree(value) {
  if (typeof value !== 'string') return false;
  return WORKTREE_PATH_MATCH.test(value);
}

function argsMatchFactoryWorktree(args) {
  if (!Array.isArray(args)) return false;
  return args.some(matchesFactoryWorktree);
}

function appendTrace(event) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...event,
    }) + '\n';
    fs.appendFileSync(TRACE_FILE, line, 'utf8');
  } catch {
    // swallow — diagnostic must not affect production behavior
  }
}

let installed = false;

function install() {
  if (installed) return;
  installed = true;

  const origRmSync = fs.rmSync;
  fs.rmSync = function tracedRmSync(target, options) {
    if (matchesFactoryWorktree(target)) {
      appendTrace({
        kind: 'fs.rmSync',
        target,
        recursive: !!(options && options.recursive),
        force: !!(options && options.force),
        stack: new Error('fs.rmSync trace').stack,
      });
    }
    return origRmSync.call(this, target, options);
  };

  const origExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function tracedExecFileSync(file, args, opts) {
    if (file === 'git' && Array.isArray(args)) {
      const isWorktreeRemove = args[0] === 'worktree' && args[1] === 'remove';
      const isBranchDelete = args[0] === 'branch' && (args[1] === '-D' || args[1] === '-d');
      if ((isWorktreeRemove || isBranchDelete) && argsMatchFactoryWorktree(args)) {
        appendTrace({
          kind: 'git ' + args.slice(0, 2).join(' '),
          args,
          cwd: opts && opts.cwd,
          stack: new Error('git delete trace').stack,
        });
      }
    }
    return origExecFileSync.call(this, file, args, opts);
  };

  appendTrace({ kind: 'tracer_installed', traceFile: TRACE_FILE });
}

module.exports = { install, TRACE_FILE };
