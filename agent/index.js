import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load config from env var or default path
function loadConfig() {
  const configPath = process.env.TORQUE_AGENT_CONFIG || path.join(__dirname, 'config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

function getSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus();

  // Calculate CPU percent from cpu times
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    for (const type of Object.keys(cpu.times)) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }
  const cpuPercent = Math.round(((totalTick - totalIdle) / totalTick) * 100 * 100) / 100;

  return {
    memory_total_mb: Math.round(totalMem / (1024 * 1024)),
    memory_available_mb: Math.round(freeMem / (1024 * 1024)),
    cpu_percent: cpuPercent,
  };
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/**
 * Promise-based JSON body parser. Collects request body chunks and parses as JSON.
 * Rejects if body exceeds MAX_BODY_SIZE, is empty, or contains invalid JSON.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        reject(new Error('Empty request body'));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Validates that `cwd` is within the configured `projectRoot`.
 * Normalizes paths (replaces backslashes, case-insensitive on Windows).
 * Returns boolean.
 */
function isPathAllowed(cwd, projectRoot) {
  if (!cwd || !projectRoot) return false;
  const normalize = (p) => p.replace(/\\/g, '/').toLowerCase();
  const normalizedCwd = normalize(path.resolve(cwd));
  const normalizedRoot = normalize(path.resolve(projectRoot));
  // cwd must start with project root (exact match or followed by /)
  return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(normalizedRoot + '/');
}

/**
 * Factory function for creating a server instance with optional config overrides.
 * Returns { server, close() } so tests can start/stop it.
 *
 * When called without overrideConfig (e.g. from direct execution), pass the
 * result of loadConfig(). Tests should pass their own config object.
 */
function createServer(overrideConfig = {}) {
  const mergedConfig = { ...overrideConfig };
  const serverPort = mergedConfig.port ?? 3460;
  const serverHost = mergedConfig.host || '127.0.0.1';

  let serverRunningTasks = 0;
  const serverStartTime = Date.now();

  // Track synced projects: Map<projectName, { path, last_sync, branch }>
  const projects = new Map();

  // Build the allowed commands Set from config
  const allowedCommands = new Set(mergedConfig.allowed_commands || []);

  function serverAuthenticate(req, res) {
    const secret = req.headers['x-torque-secret'];
    if (!secret || typeof secret !== 'string') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid X-Torque-Secret header' }));
      return false;
    }
    // Timing-safe comparison to prevent timing attacks on LAN
    const a = Buffer.from(secret, 'utf8');
    const b = Buffer.from(mergedConfig.secret, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid X-Torque-Secret header' }));
      return false;
    }
    return true;
  }

  async function handleRun(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    const { command, args = [], cwd, env = {}, timeout_ms = 30000 } = body;

    // Validate command against whitelist
    if (!allowedCommands.has(command)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Command not allowed: ${command}` }));
      return;
    }

    // Validate cwd is within project root
    if (!isPathAllowed(cwd, mergedConfig.project_root)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Path not allowed: ${cwd}` }));
      return;
    }

    // Check concurrency limit
    const maxConcurrent = mergedConfig.max_concurrent || 3;
    if (serverRunningTasks >= maxConcurrent) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'At capacity', running: serverRunningTasks, max: maxConcurrent }));
      return;
    }

    serverRunningTasks++;
    const startTime = Date.now();
    let finished = false;

    // Clamp timeout to 10 minutes max
    const effectiveTimeout = Math.min(timeout_ms || 30000, 600000);

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: process.platform === 'win32',
    });

    // Manual timeout since spawn doesn't have a timeout option
    const timer = setTimeout(() => {
      if (!finished) {
        child.kill('SIGTERM');
        // Force kill after 2 seconds if still alive
        setTimeout(() => {
          if (!finished) {
            try { child.kill('SIGKILL'); } catch { /* already dead */ }
          }
        }, 2000);
      }
    }, effectiveTimeout);

    // Stream NDJSON
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
    });

    child.stdout.on('data', (data) => {
      res.write(JSON.stringify({ stream: 'stdout', data: data.toString() }) + '\n');
    });

    child.stderr.on('data', (data) => {
      res.write(JSON.stringify({ stream: 'stderr', data: data.toString() }) + '\n');
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      serverRunningTasks--;
      const durationMs = Date.now() - startTime;
      res.write(JSON.stringify({ exit_code: code ?? 1, duration_ms: durationMs }) + '\n');
      res.end();
    });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      serverRunningTasks--;
      const durationMs = Date.now() - startTime;
      res.write(JSON.stringify({ stream: 'stderr', data: err.message }) + '\n');
      res.write(JSON.stringify({ exit_code: 1, duration_ms: durationMs }) + '\n');
      res.end();
    });
  }

  async function handleSync(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    const { project, branch = 'main', repo_url } = body;

    if (!project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: project' }));
      return;
    }

    const projectPath = path.join(mergedConfig.project_root, project);
    const startTime = Date.now();

    try {
      const dirExists = fs.existsSync(projectPath);

      if (!dirExists && !repo_url) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: `Project not found: ${project}. Provide repo_url to clone.`,
        }));
        return;
      }

      if (!dirExists && repo_url) {
        // Clone the repository
        execFileSync('git', ['clone', repo_url, projectPath], { timeout: 300000 });
        // Install dependencies
        execFileSync('npm', ['install'], { cwd: projectPath, timeout: 300000, windowsHide: true });
      } else {
        // Fetch latest from origin
        execFileSync('git', ['fetch', 'origin'], { cwd: projectPath, timeout: 60000 });
        // Checkout the target branch
        execFileSync('git', ['checkout', branch], { cwd: projectPath, timeout: 10000 });
        // Reset to match remote branch
        execFileSync('git', ['reset', '--hard', 'origin/' + branch], { cwd: projectPath, timeout: 10000 });

        // Check if package-lock.json changed in the last commit
        try {
          const diffOutput = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
            cwd: projectPath,
            encoding: 'utf8',
            timeout: 10000,
          });
          if (diffOutput.includes('package-lock.json')) {
            execFileSync('npm', ['install'], { cwd: projectPath, timeout: 300000, windowsHide: true });
          }
        } catch {
          // diff may fail if only one commit exists — skip npm install check
        }
      }

      // Get the current short commit hash
      const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: projectPath,
        encoding: 'utf8',
        timeout: 10000,
      }).trim();

      const durationMs = Date.now() - startTime;

      // Update the projects tracking map
      projects.set(project, {
        path: projectPath,
        last_sync: new Date().toISOString(),
        branch,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'synced',
        project,
        branch,
        commit,
        duration_ms: durationMs,
      }));
    } catch (err) {
      const durationMs = Date.now() - startTime;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Sync failed: ${err.message}`,
        duration_ms: durationMs,
      }));
    }
  }

  /**
   * Convert the projects Map to a plain object for JSON serialization.
   */
  function projectsToObject() {
    const obj = {};
    for (const [name, info] of projects) {
      obj[name] = info;
    }
    return obj;
  }

  // ── Capability Detection (for /probe) ──────────────────────────────────

  function detectCapabilities() {
    const caps = { command_exec: true, git_sync: isCommandAvailable('git') };

    // Ollama
    try {
      const tagsRaw = execFileSync('curl', ['-s', '--max-time', '2', 'http://127.0.0.1:11434/api/tags'], { timeout: 5000, encoding: 'utf8' });
      const tags = JSON.parse(tagsRaw);
      caps.ollama = { detected: true, port: 11434, models: (tags.models || []).map(m => m.name) };
    } catch { /* no Ollama */ }

    // GPU
    try {
      if (os.platform() === 'win32') {
        const out = execFileSync('wmic', ['path', 'win32_videocontroller', 'get', 'name,adapterram', '/format:csv'], { timeout: 5000, encoding: 'utf8' });
        const lines = out.split('\n').filter(l => l.trim() && !l.startsWith('Node'));
        if (lines.length > 0) {
          const parts = lines[0].split(',');
          caps.gpu = { detected: true, name: (parts[2] || '').trim(), vram_mb: Math.round(parseInt(parts[1] || 0) / 1024 / 1024) };
        }
      } else {
        const out = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 5000, encoding: 'utf8' });
        const [name, mem] = out.trim().split(',').map(s => s.trim());
        caps.gpu = { detected: true, name, vram_mb: parseInt(mem) };
      }
    } catch { /* no GPU */ }

    // Peek server
    try {
      execFileSync('curl', ['-s', '--max-time', '1', 'http://127.0.0.1:9876/'], { timeout: 3000 });
      caps.ui_capture = { detected: true, has_display: true, peek_server: 'running' };
    } catch { /* no peek */ }

    // Build tools
    const buildTools = ['npm', 'dotnet', 'cargo', 'go', 'gradle', 'make'].filter(isCommandAvailable);
    if (buildTools.length) caps.build_tools = buildTools;

    // Test runners
    const testRunners = ['vitest', 'jest', 'pytest', 'mocha'].filter(isCommandAvailable);
    if (testRunners.length) caps.test_runners = testRunners;

    // Platform
    caps.platform = { os: os.platform(), arch: os.arch(), ram_mb: Math.round(os.totalmem() / 1024 / 1024) };

    return caps;
  }

  function isCommandAvailable(cmd) {
    try {
      const whichCmd = os.platform() === 'win32' ? 'where' : 'which';
      execFileSync(whichCmd, [cmd], { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch { return false; }
  }

  // ── Certs Directory ──────────────────────────────────────────────────────

  const CERTS_DIR = path.join(os.homedir(), '.torque-agent', 'certs');

  // ── Request Handler ──────────────────────────────────────────────────────

  function serverHandleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Public endpoints (no auth required — used during registration)
    if (req.method === 'GET' && pathname === '/probe') {
      const caps = detectCapabilities();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ platform: os.platform(), arch: os.arch(), capabilities: caps }));
      return;
    }

    if (req.method === 'GET' && pathname === '/certs') {
      const certPath = path.join(CERTS_DIR, 'agent.crt');
      try {
        const cert = fs.readFileSync(certPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cert }));
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No certificate. Run: torque-agent --init' }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      const uptimeSeconds = Math.round((Date.now() - serverStartTime) / 1000);
      const body = {
        status: 'healthy',
        version: '1.0.0',
        uptime_seconds: uptimeSeconds,
        running_tasks: serverRunningTasks,
        max_concurrent: mergedConfig.max_concurrent || 3,
        system: getSystemMetrics(),
        projects: projectsToObject(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    // Peek proxy (no auth — proxies to local peek_server)
    if (pathname.startsWith('/peek/')) {
      const peekPort = parseInt(process.env.PEEK_PORT || '9876');
      const proxyPath = pathname.replace(/^\/peek/, '') + parsedUrl.search;
      const proxyReq = http.request({
        hostname: '127.0.0.1', port: peekPort,
        path: proxyPath || '/',
        method: req.method, headers: req.headers,
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'peek_server not running on this workstation' }));
      });
      req.pipe(proxyReq);
      return;
    }

    // Authenticated endpoints below
    if (!serverAuthenticate(req, res)) {
      return;
    }

    if (req.method === 'POST' && pathname === '/run') {
      handleRun(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/sync') {
      handleSync(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/projects') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects: projectsToObject() }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  const httpServer = http.createServer(serverHandleRequest);
  httpServer.listen(serverPort, serverHost);

  return {
    server: httpServer,
    config: mergedConfig,
    close() {
      return new Promise((resolve) => {
        httpServer.close(resolve);
      });
    },
    get runningTasks() { return serverRunningTasks; },
    set runningTasks(v) { serverRunningTasks = v; },
  };
}

// When run directly (not imported by tests), start the default server
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

let server = null;
if (isMainModule) {
  const config = loadConfig();
  // Refuse to start with insecure default secret
  if (!config.secret || config.secret === 'test-secret' || config.secret.length < 16) {
    console.error('ERROR: Secret must be at least 16 characters and not the default "test-secret".');
    console.error('Run bootstrap.ps1 or set a strong secret in config.json.');
    process.exit(1);
  }
  const instance = createServer(config);
  const PORT = config.port ?? 3460;
  const HOST = config.host || '127.0.0.1';
  console.log(`TORQUE Agent listening on ${HOST}:${PORT}`);

  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    instance.close().then(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down...');
    instance.close().then(() => process.exit(0));
  });

  server = instance.server;
}

export { server, loadConfig, createServer, readBody, isPathAllowed };
