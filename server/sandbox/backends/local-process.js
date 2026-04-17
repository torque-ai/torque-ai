'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

function createLocalProcessBackend({ workDir }) {
  if (!workDir || typeof workDir !== 'string') {
    throw new Error('createLocalProcessBackend requires a workDir');
  }

  const rootDir = path.resolve(workDir);
  const sandboxes = new Map();

  fs.mkdirSync(rootDir, { recursive: true });

  function resolveIn(sbRoot, candidate) {
    const sandboxRoot = path.resolve(sbRoot);
    const absolutePath = path.resolve(sandboxRoot, candidate || '.');
    const relativePath = path.relative(sandboxRoot, absolutePath);

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`path escape attempt: ${candidate}`);
    }

    return absolutePath;
  }

  function getSandbox(sandboxId) {
    const sandbox = sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`sandbox not found: ${sandboxId}`);
    }
    return sandbox;
  }

  function normalizeTimeout(timeoutMs) {
    if (timeoutMs == null) {
      return 30000;
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid timeoutMs: ${timeoutMs}`);
    }
    return timeoutMs;
  }

  async function create({ name = null } = {}) {
    const sandboxId = `sb_${randomUUID().slice(0, 12)}`;
    const root = path.join(rootDir, sandboxId);
    fs.mkdirSync(root, { recursive: true });
    sandboxes.set(sandboxId, { root, name, createdAt: Date.now() });
    return { sandboxId, backend: 'local-process' };
  }

  async function runCommand(
    sandboxId,
    { cmd, args = [], cwd = null, env = null, stdin = null, timeoutMs = 30000 },
  ) {
    if (!cmd || typeof cmd !== 'string') {
      throw new Error('runCommand requires a cmd string');
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new Error('runCommand args must be an array of strings');
    }
    if (cwd != null && typeof cwd !== 'string') {
      throw new Error('runCommand cwd must be a string when provided');
    }
    if (env != null && (typeof env !== 'object' || Array.isArray(env))) {
      throw new Error('runCommand env must be an object when provided');
    }
    if (stdin != null && !Buffer.isBuffer(stdin) && typeof stdin !== 'string') {
      throw new Error('runCommand stdin must be a string or Buffer when provided');
    }

    const sandbox = getSandbox(sandboxId);
    const effectiveCwd = cwd ? resolveIn(sandbox.root, cwd) : sandbox.root;
    const effectiveTimeoutMs = normalizeTimeout(timeoutMs);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(cmd, args, {
        cwd: effectiveCwd,
        env: { ...process.env, ...(env || {}) },
        stdio: 'pipe',
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, effectiveTimeoutMs);

      const finish = (fn) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.on('error', (error) => {
        finish(() => reject(error));
      });

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        finish(() => {
          if (timedOut) {
            reject(new Error(`runCommand timeout after ${effectiveTimeoutMs}ms`));
            return;
          }

          resolve({
            stdout,
            stderr,
            exitCode: Number.isInteger(code) ? code : 1,
          });
        });
      });

      if (stdin != null) {
        child.stdin.end(stdin);
        return;
      }

      child.stdin.end();
    });
  }

  const fsApi = {
    async read(sandboxId, targetPath) {
      const sandbox = getSandbox(sandboxId);
      return fs.readFileSync(resolveIn(sandbox.root, targetPath));
    },

    async write(sandboxId, targetPath, content) {
      const sandbox = getSandbox(sandboxId);
      const absolutePath = resolveIn(sandbox.root, targetPath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content);
      return {
        bytes: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content)),
      };
    },

    async list(sandboxId, targetPath) {
      const sandbox = getSandbox(sandboxId);
      const directoryPath = resolveIn(sandbox.root, targetPath);
      return fs.readdirSync(directoryPath, { withFileTypes: true })
        .map((entry) => {
          const absolutePath = path.join(directoryPath, entry.name);
          const stats = fs.statSync(absolutePath);
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
            size: stats.size,
          };
        });
    },
  };

  async function destroy(sandboxId) {
    const sandbox = getSandbox(sandboxId);
    fs.rmSync(sandbox.root, { recursive: true, force: true });
    sandboxes.delete(sandboxId);
    return { destroyed: true };
  }

  async function snapshot() {
    throw new Error('local-process backend does not support snapshots');
  }

  return { create, runCommand, fs: fsApi, destroy, snapshot };
}

module.exports = { createLocalProcessBackend };
