'use strict';

function normalizeTimeout(timeoutMs) {
  if (timeoutMs == null) {
    return undefined;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid timeoutMs: ${timeoutMs}`);
  }
  return Math.trunc(timeoutMs);
}

function shellEscape(value) {
  const text = String(value ?? '');
  if (text.length === 0) {
    return "''";
  }
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function buildPosixCommand(cmd, args = []) {
  return [cmd, ...args].map(shellEscape).join(' ');
}

async function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  if (value && typeof value.arrayBuffer === 'function') {
    return Buffer.from(await value.arrayBuffer());
  }
  if (value && typeof value.getReader === 'function') {
    const chunks = [];
    const reader = value.getReader();
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('unsupported E2B file payload');
}

function loadSandboxCtor() {
  const candidates = ['@e2b/code-interpreter', 'e2b'];
  const errors = [];

  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      const Sandbox =
        mod?.Sandbox
        || mod?.default?.Sandbox
        || mod?.default;
      if (Sandbox && typeof Sandbox.create === 'function') {
        return Sandbox;
      }
      errors.push(`${candidate}: missing Sandbox export`);
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }

  throw new Error(
    `E2B SDK is unavailable. Install @e2b/code-interpreter to enable the e2b backend. ${errors.join('; ')}`
  );
}

function createE2BBackend({ apiKey }) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('createE2BBackend requires an apiKey');
  }

  const Sandbox = loadSandboxCtor();
  const sandboxes = new Map();

  async function connectSandbox(sandboxId) {
    if (!sandboxId || typeof sandboxId !== 'string') {
      throw new Error('sandboxId must be a non-empty string');
    }

    let sandbox = sandboxes.get(sandboxId);
    if (!sandbox) {
      sandbox = await Sandbox.connect(sandboxId, { apiKey });
      sandboxes.set(sandboxId, sandbox);
    }

    return sandbox;
  }

  async function create({ image = null, env = null, timeoutMs = null, timeout_ms = null, name = null } = {}) {
    if (env != null && (typeof env !== 'object' || Array.isArray(env))) {
      throw new Error('create env must be an object when provided');
    }

    const effectiveTimeoutMs = normalizeTimeout(timeoutMs ?? timeout_ms);
    const createOptions = {
      apiKey,
      ...(env && Object.keys(env).length > 0 ? { envs: env } : {}),
      ...(effectiveTimeoutMs ? { timeoutMs: effectiveTimeoutMs } : {}),
      ...(name ? { metadata: { name } } : {}),
    };

    const sandbox = image
      ? await Sandbox.create(image, createOptions)
      : await Sandbox.create(createOptions);

    sandboxes.set(sandbox.sandboxId, sandbox);
    return {
      sandboxId: sandbox.sandboxId,
      backend: 'e2b',
    };
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

    const sandbox = await connectSandbox(sandboxId);
    const stdoutChunks = [];
    const stderrChunks = [];
    const effectiveTimeoutMs = normalizeTimeout(timeoutMs) || 30000;
    const baseCommand = buildPosixCommand(cmd, args);
    const commandText = stdin == null
      ? baseCommand
      : `printf %s ${shellEscape(Buffer.isBuffer(stdin) ? stdin.toString('utf8') : stdin)} | ${baseCommand}`;

    try {
      const result = await sandbox.commands.run(commandText, {
        ...(cwd ? { cwd } : {}),
        ...(env ? { envs: env } : {}),
        timeoutMs: effectiveTimeoutMs,
        onStdout: (chunk) => { stdoutChunks.push(String(chunk)); },
        onStderr: (chunk) => { stderrChunks.push(String(chunk)); },
      });

      return {
        stdout: typeof result?.stdout === 'string' ? result.stdout : stdoutChunks.join(''),
        stderr: typeof result?.stderr === 'string' ? result.stderr : stderrChunks.join(''),
        exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 0,
      };
    } catch (error) {
      if (
        error
        && (typeof error.exitCode === 'number'
          || typeof error.stdout === 'string'
          || typeof error.stderr === 'string')
      ) {
        return {
          stdout: typeof error.stdout === 'string' ? error.stdout : stdoutChunks.join(''),
          stderr: typeof error.stderr === 'string'
            ? error.stderr
            : (error.message || stderrChunks.join('')),
          exitCode: Number.isInteger(error.exitCode) ? error.exitCode : 1,
        };
      }
      throw error;
    }
  }

  const fsApi = {
    async read(sandboxId, targetPath) {
      if (!targetPath || typeof targetPath !== 'string') {
        throw new Error('read requires a targetPath string');
      }

      const sandbox = await connectSandbox(sandboxId);
      try {
        return await toBuffer(await sandbox.files.read(targetPath, { format: 'bytes' }));
      } catch (_error) {
        return toBuffer(await sandbox.files.read(targetPath));
      }
    },

    async write(sandboxId, targetPath, content) {
      if (!targetPath || typeof targetPath !== 'string') {
        throw new Error('write requires a targetPath string');
      }

      const sandbox = await connectSandbox(sandboxId);
      await sandbox.files.write(targetPath, content);
      const size = Buffer.isBuffer(content)
        ? content.length
        : Buffer.byteLength(String(content));
      return { bytes: size };
    },

    async list(sandboxId, targetPath) {
      if (!targetPath || typeof targetPath !== 'string') {
        throw new Error('list requires a targetPath string');
      }

      const sandbox = await connectSandbox(sandboxId);
      const entries = await sandbox.files.list(targetPath);
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.type || 'file',
        size: Number.isFinite(entry.size) ? entry.size : null,
      }));
    },
  };

  async function destroy(sandboxId) {
    const sandbox = await connectSandbox(sandboxId);
    await sandbox.kill();
    sandboxes.delete(sandboxId);
    return { destroyed: true };
  }

  async function snapshot(sandboxId) {
    const sandbox = await connectSandbox(sandboxId);
    const result = await sandbox.createSnapshot();
    return {
      imageId: result?.snapshotId || result?.name || result?.id,
      snapshotId: result?.snapshotId || null,
    };
  }

  return {
    create,
    runCommand,
    fs: fsApi,
    destroy,
    snapshot,
  };
}

module.exports = { createE2BBackend };
