'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// SECURITY: default to localhost only. Set TORQUE_AGENT_HOST=0.0.0.0 to expose to network.
const DEFAULT_HOST = process.env.TORQUE_AGENT_HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.TORQUE_AGENT_PORT || 3460);
const DEFAULT_TIMEOUT_MS = 300000;
const FORCE_KILL_DELAY_MS = 5000;
const MAX_BODY_BYTES = 1024 * 1024;

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeComparablePath(targetPath) {
  const resolvedPath = path.resolve(String(targetPath));
  let comparablePath = resolvedPath;
  try {
    comparablePath = typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(resolvedPath)
      : fs.realpathSync(resolvedPath);
  } catch {
    comparablePath = resolvedPath;
  }

  comparablePath = path.normalize(comparablePath);
  const root = path.parse(comparablePath).root;
  if (comparablePath !== root) {
    comparablePath = comparablePath.replace(/[\\/]+$/, '');
  }
  return process.platform === 'win32'
    ? comparablePath.toLowerCase()
    : comparablePath;
}

function getProjectsBaseDir(env = process.env) {
  const configured = env.TORQUE_AGENT_PROJECTS;
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(os.homedir(), 'torque-agent-projects');
}

function getHealthPayload(load = 0, capacity = os.cpus().length, startedAt = Date.now()) {
  const normalizedCapacity = Number.isFinite(Number(capacity)) && Number(capacity) > 0
    ? Number(capacity)
    : Math.max(1, os.cpus().length);

  const normalizedLoad = Number.isFinite(Number(load)) && Number(load) >= 0
    ? Number(load)
    : 0;

  return {
    status: 'ok',
    capacity: normalizedCapacity,
    load: normalizedLoad,
    uptime: Math.max(0, (Date.now() - startedAt) / 1000),
    running_tasks: normalizedLoad,
    max_concurrent: normalizedCapacity,
    system: {
      platform: os.platform(),
      memory_available_mb: Math.round(os.freemem() / (1024 * 1024)),
      memory_total_mb: Math.round(os.totalmem() / (1024 * 1024)),
    },
  };
}

function writeJson(res, statusCode, payload) {
  if (res.writableEnded) {
    return;
  }

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(createHttpError('Request body too large', 400));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        reject(createHttpError('Request body is required', 400));
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(createHttpError(`Invalid JSON: ${error.message}`, 400));
      }
    });

    req.on('error', reject);
  });
}

function isAuthorized(req, secret) {
  // SECURITY: auth is now mandatory. If no secret configured, always reject.
  if (!secret) return false;
  const received = req.headers['x-torque-secret'];
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received, 'utf-8');
  const b = Buffer.from(secret, 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const BLOCKED_ENV_VARS = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PYTHONSTARTUP', 'RUBYOPT',
]);
const ALLOWED_ENV_VARS = new Set([
  'NODE_ENV', 'DEBUG', 'HOME', 'USERPROFILE', 'TEMP', 'TMP',
]);
const ALLOWED_PREFIXES = ['TORQUE_', 'OLLAMA_'];

function normalizeEnv(extraEnv = {}) {
  const merged = { ...process.env };
  for (const key of BLOCKED_ENV_VARS) {
    delete merged[key];
  }
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (BLOCKED_ENV_VARS.has(key)) continue;
    if (!ALLOWED_ENV_VARS.has(key) && !ALLOWED_PREFIXES.some(p => key.startsWith(p))) continue;
    if (value === undefined || value === null) { delete merged[key]; continue; }
    merged[key] = String(value);
  }
  return merged;
}

const DEFAULT_ALLOWED_COMMANDS = new Set([
  'node', 'npm', 'npx', 'git', 'dotnet', 'cargo', 'python', 'pip', 'python3',
]);

function normalizeCommandName(command) {
  const commandText = String(command || '').trim();
  const baseName = commandText.split(/[\\/]/).pop();
  return baseName.replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();
}

function addAllowedCommands(target, commands) {
  if (!commands) {
    return;
  }

  const values = typeof commands === 'string'
    ? [commands]
    : Array.from(commands);

  for (const command of values) {
    const normalized = normalizeCommandName(command);
    if (normalized) {
      target.add(normalized);
    }
  }
}

function getAllowedCommands(state = {}) {
  const allowedCommands = new Set(DEFAULT_ALLOWED_COMMANDS);
  addAllowedCommands(allowedCommands, state && state.allowedCommands);
  addAllowedCommands(allowedCommands, state && state.config && state.config.allowed_commands);
  addAllowedCommands(allowedCommands, state && state.config && state.config.allowedCommands);
  return allowedCommands;
}

// Only block characters that enable command chaining/injection.
// With shell: false, parentheses/braces/redirects are harmless literal characters.
const SHELL_METACHAR_RE = /[;|&`$]/;

function prepareShellArgs(args) {
  if (!Array.isArray(args)) {
    return [];
  }
  return args.map((arg) => {
    const str = String(arg);
    if (SHELL_METACHAR_RE.test(str)) {
      throw createHttpError(`Argument contains disallowed shell metacharacter: ${str.substring(0, 50)}`, 400);
    }
    return str;
  });
}

function terminateChild(child) {
  if (!child || child.exitCode != null || child.killed) {
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // Fall through to Windows tree termination when available.
  }

  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    try {
      const gracefulTreeKill = spawn('taskkill', ['/pid', String(child.pid), '/t'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      if (typeof gracefulTreeKill.unref === 'function') {
        gracefulTreeKill.unref();
      }
    } catch {
      // Ignore taskkill failures and rely on the fallback force step.
    }
  }

  const killTimer = setTimeout(() => {
    if (child.exitCode != null || child.killed) {
      return;
    }

    if (process.platform === 'win32' && Number.isInteger(child.pid)) {
      try {
        const forceTreeKill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        if (typeof forceTreeKill.unref === 'function') {
          forceTreeKill.unref();
        }
      } catch {
        // Fall through to the generic SIGKILL path.
      }
    }

    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore late kill failures after the process exits.
    }
  }, FORCE_KILL_DELAY_MS);

  if (typeof killTimer.unref === 'function') {
    killTimer.unref();
  }
}

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024; // 10MB

function spawnAndCapture(command, args, options = {}) {
  const timeout = Number(options.timeout ?? DEFAULT_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    let child;

    try {
      child = spawn(command, prepareShellArgs(args), {
        cwd: options.cwd,
        env: normalizeEnv(options.env),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, timeout);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_CAPTURE_BYTES) {
        stdout = '[...truncated...]\n' + stdout.slice(-MAX_CAPTURE_BYTES);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_CAPTURE_BYTES) {
        stderr = '[...truncated...]\n' + stderr.slice(-MAX_CAPTURE_BYTES);
      }
    });

    child.on('error', (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve({
        exitCode: code == null ? (timedOut ? 124 : 1) : code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function runGit(args, options = {}) {
  const result = await spawnAndCapture('git', args, {
    ...options,
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      ...options.env,
    },
  });

  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  }

  return result;
}

function resolveProjectDir(baseDir, project) {
  if (typeof project !== 'string' || !project.trim()) {
    throw createHttpError('Missing required field: project', 400);
  }

  const trimmed = project.trim();
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
    throw createHttpError('Project must be a single path segment', 400);
  }

  const projectDir = path.resolve(baseDir, trimmed);
  const relative = path.relative(baseDir, projectDir);

  if (!relative || relative === '.') {
    return projectDir;
  }

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw createHttpError('Project path escapes base directory', 400);
  }

  return projectDir;
}

function hasGitMetadata(projectDir) {
  return fs.existsSync(path.join(projectDir, '.git'));
}

async function syncProject({ baseDir, project, branch = 'main', repoUrl }) {
  const projectDir = resolveProjectDir(baseDir, project);
  fs.mkdirSync(baseDir, { recursive: true });

  if (!fs.existsSync(projectDir)) {
    if (repoUrl) {
      if (!repoUrl.startsWith('https://')) {
        return { success: false, error: 'Only https:// repository URLs are allowed' };
      }
      await runGit(['clone', '--branch', branch, repoUrl, projectDir], {
        timeout: DEFAULT_TIMEOUT_MS,
      });
    } else {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    return {
      success: true,
      path: projectDir,
      branch,
    };
  }

  if (!hasGitMetadata(projectDir)) {
    return {
      success: true,
      path: projectDir,
      branch,
    };
  }

  await runGit(['fetch', 'origin'], {
    cwd: projectDir,
    timeout: 120000,
  });

  const localBranch = await spawnAndCapture('git', ['rev-parse', '--verify', branch], {
    cwd: projectDir,
    timeout: 10000,
  });

  if (localBranch.exitCode === 0) {
    await runGit(['checkout', branch], {
      cwd: projectDir,
      timeout: 30000,
    });
  } else {
    const remoteBranch = await spawnAndCapture('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], {
      cwd: projectDir,
      timeout: 20000,
    });

    if (remoteBranch.exitCode === 0) {
      await runGit(['checkout', '-b', branch, '--track', `origin/${branch}`], {
        cwd: projectDir,
        timeout: 30000,
      });
    } else {
      await runGit(['checkout', '-B', branch], {
        cwd: projectDir,
        timeout: 30000,
      });

      return {
        success: true,
        path: projectDir,
        branch,
      };
    }
  }

  const pullTarget = await spawnAndCapture('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], {
    cwd: projectDir,
    timeout: 20000,
  });

  if (pullTarget.exitCode === 0) {
    await runGit(['pull', '--ff-only', 'origin', branch], {
      cwd: projectDir,
      timeout: 120000,
    });
  }

  return {
    success: true,
    path: projectDir,
    branch,
  };
}

function validateRunRequest(body, state) {
  const bodyCommand = body && typeof body.command === 'string'
    ? body.command.trim()
    : '';
  const argsCommand = !bodyCommand && Array.isArray(body && body.args)
    ? String(body.args[0] || '').trim()
    : '';
  const command = bodyCommand || argsCommand;

  if (!command) {
    throw createHttpError('Missing required field: command', 400);
  }

  const executable = normalizeCommandName(command);
  const allowedCommands = getAllowedCommands(state);
  if (!allowedCommands.has(executable)) {
    throw createHttpError(`Command not allowed: ${executable}. Allowed: ${[...allowedCommands].join(', ')}`, 403);
  }

  if (body.args !== undefined && !Array.isArray(body.args)) {
    throw createHttpError('args must be an array', 400);
  }

  if (body.env !== undefined && (!body.env || typeof body.env !== 'object' || Array.isArray(body.env))) {
    throw createHttpError('env must be an object', 400);
  }

  const cwd = body.cwd ? path.resolve(String(body.cwd)) : process.cwd();
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw createHttpError(`cwd does not exist or is not a directory: ${cwd}`, 400);
  }

  const allowedRoots = (state && state.config && state.config.allowed_roots)
    ? state.config.allowed_roots
    : (state && state.projectsDir ? [state.projectsDir] : []);

  if (allowedRoots.length > 0) {
    const resolvedCwd = normalizeComparablePath(cwd);
    const isAllowed = allowedRoots.some((root) => {
      const resolvedRoot = normalizeComparablePath(root);
      const rootPrefix = resolvedRoot === path.parse(resolvedRoot).root
        ? resolvedRoot
        : `${resolvedRoot}${path.sep}`;
      return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(rootPrefix);
    });
    if (!isAllowed) {
      throw createHttpError(`cwd is outside allowed directories: ${cwd}`, 403);
    }
  }

  const rawTimeout = body.timeout_ms ?? body.timeout ?? DEFAULT_TIMEOUT_MS;
  const timeout = Number(rawTimeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw createHttpError('timeout must be a positive number', 400);
  }

  const requestArgs = bodyCommand ? (body.args || []) : (body.args || []).slice(1);

  return {
    command,
    args: prepareShellArgs(requestArgs),
    cwd,
    env: body.env || {},
    timeout,
  };
}

function writeNdjson(res, payload) {
  if (res.writableEnded) {
    return;
  }
  res.write(`${JSON.stringify(payload)}\n`);
}

function streamRun(req, res, body, state) {
  let runRequest;
  try {
    runRequest = validateRunRequest(body, state);
  } catch (error) {
    writeJson(res, error.statusCode || 400, { error: error.message });
    return;
  }

  let child;
  try {
    child = spawn(runRequest.command, runRequest.args, {
      cwd: runRequest.cwd,
      env: normalizeEnv(runRequest.env),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    writeJson(res, 500, { error: error.message });
    return;
  }

  state.load += 1;

  const startedAt = Date.now();
  let finished = false;
  let timedOut = false;

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'Transfer-Encoding': 'chunked',
  });

  const finish = (exitCode) => {
    if (finished) {
      return;
    }

    finished = true;
    clearTimeout(timer);
    state.load = Math.max(0, state.load - 1);
    writeNdjson(res, {
      exit_code: exitCode,
      duration_ms: Date.now() - startedAt,
    });
    try {
      if (!res.writableEnded) res.end();
    } catch (_e) { /* connection already closed */ }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    writeNdjson(res, {
      stream: 'stderr',
      data: `Process timed out after ${runRequest.timeout}ms\n`,
    });
    terminateChild(child);
    finish(124);
  }, runRequest.timeout);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  child.stdout.on('data', (chunk) => {
    writeNdjson(res, {
      stream: 'stdout',
      data: chunk.toString('utf8'),
    });
  });

  child.stderr.on('data', (chunk) => {
    writeNdjson(res, {
      stream: 'stderr',
      data: chunk.toString('utf8'),
    });
  });

  child.on('error', (error) => {
    if (finished) {
      return;
    }
    writeNdjson(res, {
      stream: 'stderr',
      data: `${error.message}\n`,
    });
    finish(1);
  });

  child.on('close', (code) => {
    const exitCode = code == null ? (timedOut ? 124 : 1) : code;
    finish(exitCode);
  });

  res.on('close', () => {
    if (!finished) {
      terminateChild(child);
    }
  });
}

function createServer(options = {}) {
  const env = options.env || process.env;
  const secret = options.secret !== undefined
    ? options.secret
    : env.TORQUE_AGENT_SECRET;
  const projectsDir = path.resolve(options.projectsDir || options.project_root || getProjectsBaseDir(env));

  const configuredCapacity = Number(
    options.capacity
    ?? options.maxConcurrent
    ?? options.max_concurrent
    ?? os.cpus().length
  );

  const state = {
    capacity: Number.isFinite(configuredCapacity) && configuredCapacity > 0
      ? configuredCapacity
      : Math.max(1, os.cpus().length),
    load: 0,
    secret,
    projectsDir,
    startedAt: Date.now(),
    config: options.config || {},
    allowedCommands: getAllowedCommands({
      allowedCommands: options.allowedCommands ?? options.allowed_commands,
      config: options.config || {},
    }),
  };

  const handler = async (req, res) => {
    const pathname = String(req.url || '/').split('?')[0];

    if (!isAuthorized(req, state.secret)) {
      writeJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      writeJson(res, 200, getHealthPayload(state.load, state.capacity, state.startedAt));
      return;
    }

    if (req.method === 'POST' && pathname === '/sync') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        writeJson(res, error.statusCode || 400, { error: error.message });
        return;
      }

      try {
        const payload = await syncProject({
          baseDir: state.projectsDir,
          project: body.project,
          branch: body.branch || 'main',
          repoUrl: body.repoUrl || body.repo_url,
        });
        writeJson(res, 200, payload);
      } catch (error) {
        writeJson(res, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/run') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        writeJson(res, error.statusCode || 400, { error: error.message });
        return;
      }

      streamRun(req, res, body, state);
      return;
    }

    writeJson(res, 404, { error: 'Not found' });
  };

  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      writeJson(res, error.statusCode || 500, {
        error: error.message || 'Internal Server Error',
      });
    });
  });

  server.torqueAgent = {
    config: {
      host: options.host || DEFAULT_HOST,
      port: options.port == null ? DEFAULT_PORT : options.port,
      secret,
      projectsDir,
      capacity: state.capacity,
    },
    state,
  };

  return server;
}

function createAgentServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port == null ? DEFAULT_PORT : options.port;
  const server = createServer(options);

  server.listen(port, host);

  return {
    server,
    config: {
      host,
      port,
      projectsDir: server.torqueAgent.config.projectsDir,
      hasSecret: Boolean(server.torqueAgent.config.secret),
    },
    close() {
      return new Promise((resolve) => {
        server.close(resolve);
      });
    },
  };
}

function startFromEnv() {
  return createAgentServer();
}

if (require.main === module) {
  const server = createServer();
  const host = DEFAULT_HOST;
  const port = DEFAULT_PORT;

  server.listen(port, host, () => {
    console.log(`TORQUE remote agent listening on ${host}:${port}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  ALLOWED_ENV_VARS,
  ALLOWED_PREFIXES,
  BLOCKED_ENV_VARS,
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  FORCE_KILL_DELAY_MS,
  MAX_BODY_BYTES,
  MAX_CAPTURE_BYTES,
  createAgentServer,
  createHttpError,
  createServer,
  getHealthPayload,
  getProjectsBaseDir,
  isAuthorized,
  normalizeEnv,
  normalizeCommandName,
  prepareShellArgs,
  readJsonBody,
  resolveProjectDir,
  runGit,
  spawnAndCapture,
  startFromEnv,
  streamRun,
  syncProject,
  terminateChild,
  validateRunRequest,
  writeJson,
};
