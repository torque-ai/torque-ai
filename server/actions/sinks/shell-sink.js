'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const pExecFile = promisify(execFile);

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function splitArgs(value) {
  if (!value) return [];
  const text = String(value).trim();
  return text ? text.split(/\s+/) : [];
}

// Shell sink runs a single binary with argv - never through a shell.
// Requires the command to be on the configured allowlist; no shell features
// (pipes, redirects, globs, $()) are supported by design.
function createShellSink({ workingDir, allowlist = [], timeoutMs = 30000 }) {
  if (!workingDir) throw new Error('shell sink requires workingDir');
  const root = path.resolve(workingDir);
  const allowed = new Set(allowlist.map((cmd) => String(cmd).trim()).filter(Boolean));

  return async ({ attrs }) => {
    if (!attrs.cmd) throw new Error('shell action requires cmd attribute');
    if (allowed.size === 0 || !allowed.has(attrs.cmd)) {
      throw new Error(`command '${attrs.cmd}' not on allowlist`);
    }

    const args = splitArgs(attrs.args);
    const cwd = attrs.cwd ? path.resolve(root, attrs.cwd) : root;
    if (!isPathInside(root, cwd)) throw new Error('cwd escapes working dir');

    const { stdout, stderr } = await pExecFile(attrs.cmd, args, {
      cwd,
      timeout: timeoutMs,
      shell: false,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  };
}

module.exports = { createShellSink };
