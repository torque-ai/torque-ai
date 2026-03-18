/**
 * Persistent tsserver Daemon Client
 *
 * Manages one tsserver process per project workingDir. Communicates via
 * Content-Length framed JSON on stdin/stdout (the tsserver stdio protocol).
 *
 * Provides: diagnostics, quickInfo, definition, references.
 * All operations are gated by db.getConfig('tsserver_enabled').
 *
 * Sessions are lazily spawned, auto-restart on crash (exponential backoff),
 * and auto-evict after idle timeout.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── Dependency injection ──────────────────────────────────────────────

const serverConfig = require('../config');

let db = null;
let logger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Inject optional dependencies used by this module.
 *
 * @param {{db?: object, logger?: {info?: Function, warn?: Function, error?: Function, debug?: Function}}} deps
 * @returns {void}
 */
function init(deps) {
  if (deps.db) db = deps.db;
  serverConfig.init({ db: deps.db });
  if (deps.logger) logger = deps.logger.child
    ? deps.logger.child({ component: 'tsserver-client' })
    : deps.logger;
}

// ─── Constants ─────────────────────────────────────────────────────────

const {
  TSSERVER_REQUEST_TIMEOUT_MS,
  TSSERVER_SESSION_IDLE_TTL_MS,
  TSSERVER_MAX_RESTARTS,
  TSSERVER_RESTART_BASE_DELAY_MS,
} = require('../constants');

// ─── Content-Length Frame Parser ───────────────────────────────────────

/**
 * Parses Content-Length framed JSON messages from a stream buffer.
 * tsserver sends: Content-Length: NNN\r\n\r\n{JSON}
 */
class ContentLengthFrameParser {
  constructor() {
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
    this.contentLength = -1;
  }

  /**
   * Feed raw data into the parser.
   * Content-Length is in bytes, so we use Buffer for correct slicing.
   * @param {string|Buffer} data
   * @returns {object[]} Parsed JSON messages
   */
  feed(data) {
    const chunk = typeof data === 'string' ? Buffer.from(data) : data;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];

    while (true) {
      if (this.contentLength === -1) {
        // Look for Content-Length header (\r\n\r\n separator)
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const header = this.buffer.slice(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Skip malformed header — advance past it
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      if (this.contentLength >= 0 && this.buffer.length >= this.contentLength) {
        const body = this.buffer.slice(0, this.contentLength).toString('utf8');
        this.buffer = this.buffer.slice(this.contentLength);
        this.contentLength = -1;

        try {
          messages.push(JSON.parse(body));
        } catch {
          // Malformed JSON — skip
        }
      } else {
        break;
      }
    }

    return messages;
  }

  reset() {
    this.buffer = Buffer.alloc(0);
    this.contentLength = -1;
  }
}

// ─── Session Management ────────────────────────────────────────────────

/** @type {Map<string, TsserverSession>} */
const sessions = new Map();

/** Idle eviction interval reference */
let idleCheckInterval = null;

/**
 * One tsserver session per project directory.
 */
class TsserverSession {
  constructor(workingDir) {
    this.workingDir = workingDir;
    this.process = null;
    this.parser = new ContentLengthFrameParser();
    this.seq = 0;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    this.restartCount = 0;
    this.lastActivity = Date.now();
    this.starting = false;
    this.openFiles = new Set();
    /** @type {Map<string, object[]>} filePath → diagnostics cache */
    this.diagnosticCache = new Map();
    this._dead = false;
  }

  /**
   * Ensure tsserver is running, spawn if needed.
   */
  async ensureRunning() {
    if (this.process && !this._dead) return;
    if (this.starting) {
      // Wait for existing startup
      await new Promise(r => setTimeout(r, 500));
      if (this.process && !this._dead) return;
    }
    await this._spawn();
  }

  async _spawn() {
    if (this._dead) return;
    this.starting = true;

    try {
      // Resolve tsserver.js directly — bypass .cmd shim on Windows
      const tsserverJsPath = this._resolveTsserverJs();
      if (!tsserverJsPath) {
        logger.info(`[tsserver] TypeScript not found for ${this.workingDir}`);
        this._dead = true;
        this.starting = false;
        return;
      }

      const args = [
        tsserverJsPath,
        '--useInferredProjectCompilerOptions',
        '--disableAutomaticTypingAcquisition',
      ];

      logger.info(`[tsserver] Spawning for ${this.workingDir}: ${process.execPath} ${args.join(' ')}`);

      this.process = spawn(process.execPath, args, {
        cwd: this.workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.parser.reset();

      this.process.stdout.setEncoding('utf8');
      this.process.stdout.on('data', (data) => this._onData(data));

      this.process.stderr.setEncoding('utf8');
      this.process.stderr.on('data', (data) => {
        // tsserver emits info on stderr — log at debug level
        logger.debug(`[tsserver:stderr] ${data.trim().slice(0, 200)}`);
      });

      this.process.on('exit', (code, signal) => {
        logger.info(`[tsserver] Exited for ${this.workingDir} (code=${code}, signal=${signal})`);
        this.process = null;
        this._rejectAllPending('tsserver exited');
        this._maybeRestart();
      });

      this.process.on('error', (err) => {
        logger.info(`[tsserver] Process error for ${this.workingDir}: ${err.message}`);
        this.process = null;
        this._rejectAllPending(err.message);
      });

      // Wait a moment for tsserver to initialize
      await new Promise(r => setTimeout(r, 300));
      this.restartCount = 0;
      this.lastActivity = Date.now();
    } catch (e) {
      logger.info(`[tsserver] Spawn error for ${this.workingDir}: ${e.message}`);
      this._dead = true;
    } finally {
      this.starting = false;
    }
  }

  _resolveTsserverJs() {
    // Try project-local typescript first
    const localPaths = [
      path.join(this.workingDir, 'node_modules', 'typescript', 'lib', 'tsserver.js'),
      path.join(this.workingDir, 'node_modules', '.pnpm', 'typescript'),
    ];
    for (const p of localPaths) {
      if (p.endsWith('tsserver.js') && fs.existsSync(p)) return p;
    }

    // Try global typescript via require.resolve
    try {
      const tsMain = require.resolve('typescript', { paths: [this.workingDir] });
      const tsserverPath = path.join(path.dirname(tsMain), 'tsserver.js');
      if (fs.existsSync(tsserverPath)) return tsserverPath;
    } catch { /* not found */ }

    // Try common global locations
    const globalPaths = [
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'typescript', 'lib', 'tsserver.js'),
      '/usr/local/lib/node_modules/typescript/lib/tsserver.js',
      '/usr/lib/node_modules/typescript/lib/tsserver.js',
    ];
    for (const p of globalPaths) {
      try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
    }

    return null;
  }

  _onData(data) {
    const messages = this.parser.feed(data);
    for (const msg of messages) {
      this._dispatchMessage(msg);
    }
  }

  _dispatchMessage(msg) {
    this.lastActivity = Date.now();

    if (msg.type === 'response' && msg.request_seq != null) {
      const pending = this.pending.get(msg.request_seq);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.request_seq);
        if (msg.success) {
          pending.resolve(msg.body);
        } else {
          pending.reject(new Error(msg.message || 'tsserver request failed'));
        }
      }
    } else if (msg.type === 'event') {
      this._handleEvent(msg);
    }
  }

  _handleEvent(event) {
    if (event.event === 'semanticDiag' || event.event === 'syntaxDiag' || event.event === 'suggestionDiag') {
      const rawFile = event.body?.file;
      const diagnostics = event.body?.diagnostics || [];
      if (rawFile) {
        // Normalize to forward slashes so cache lookups are consistent
        const file = rawFile.replace(/\\/g, '/');
        // Merge into cache
        const existing = this.diagnosticCache.get(file) || [];
        const merged = [...existing, ...diagnostics];
        // Deduplicate by start position + code
        const seen = new Set();
        const deduped = merged.filter(d => {
          const key = `${d.start?.line}:${d.start?.offset}:${d.code}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        this.diagnosticCache.set(file, deduped);
      }
    }
  }

  /**
   * Send a request to tsserver and wait for the response.
   * @param {string} command - tsserver command name
   * @param {object} args - command arguments
   * @param {number} [timeoutMs] - override timeout
   * @returns {Promise<object>}
   */
  sendRequest(command, args, timeoutMs = TSSERVER_REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.process || this._dead) {
        return reject(new Error('tsserver not running'));
      }

      const seq = ++this.seq;
      const request = { seq, type: 'request', command, arguments: args };
      const payload = JSON.stringify(request);
      // tsserver stdin expects newline-delimited JSON (NOT Content-Length framing)
      // Content-Length framing is only used on tsserver's stdout output
      const message = payload + '\n';

      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`tsserver request timeout: ${command}`));
      }, timeoutMs);

      this.pending.set(seq, { resolve, reject, timer });

      try {
        this.process.stdin.write(message);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(new Error(`tsserver write error: ${e.message}`));
      }
    });
  }

  /**
   * Open a file in tsserver (required before queries).
   */
  async openFile(filePath) {
    if (this.openFiles.has(filePath)) return;
    const normalizedPath = filePath.replace(/\\/g, '/');

    // Clear cached diagnostics for this file
    this.diagnosticCache.delete(normalizedPath);
    this.diagnosticCache.delete(filePath);

    try {
      await this.sendRequest('open', { file: normalizedPath });
      this.openFiles.add(filePath);
    } catch (e) {
      logger.debug(`[tsserver] Failed to open ${filePath}: ${e.message}`);
    }
  }

  /**
   * Close a file in tsserver.
   */
  async closeFile(filePath) {
    if (!this.openFiles.has(filePath)) return;
    const normalizedPath = filePath.replace(/\\/g, '/');
    try {
      await this.sendRequest('close', { file: normalizedPath });
    } catch { /* ignore */ }
    this.openFiles.delete(filePath);
  }

  _rejectAllPending(reason) {
    for (const [_seq, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  _maybeRestart() {
    if (this._dead) return;
    if (this.restartCount >= TSSERVER_MAX_RESTARTS) {
      logger.info(`[tsserver] Max restarts reached for ${this.workingDir}, marking dead`);
      this._dead = true;
      return;
    }

    const delay = TSSERVER_RESTART_BASE_DELAY_MS * Math.pow(2, this.restartCount);
    this.restartCount++;
    logger.info(`[tsserver] Restarting for ${this.workingDir} in ${delay}ms (attempt ${this.restartCount})`);

    setTimeout(() => {
      if (!this._dead) {
        this.openFiles.clear();
        this.diagnosticCache.clear();
        this._spawn().catch(e => {
          logger.info(`[tsserver] Restart failed: ${e.message}`);
        });
      }
    }, delay);
  }

  kill() {
    this._dead = true;
    this._rejectAllPending('session killed');
    if (this.process) {
      try { this.process.kill(); } catch { /* ignore */ }
      this.process = null;
    }
    this.openFiles.clear();
    this.diagnosticCache.clear();
  }
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Get or create a session for the given working directory.
 * Returns null if tsserver is disabled or TypeScript is unavailable.
 * @param {string} workingDir
 * @returns {Promise<TsserverSession|null>}
 */
async function getSession(workingDir) {
  if (!isEnabled()) return null;

  const key = path.resolve(workingDir);
  let session = sessions.get(key);

  if (session && session._dead) {
    sessions.delete(key);
    session = null;
  }

  if (!session) {
    session = new TsserverSession(key);
    sessions.set(key, session);
    startIdleCheck();
  }

  await session.ensureRunning();

  if (session._dead) {
    sessions.delete(key);
    return null;
  }

  return session;
}

/**
 * Get diagnostics for one or more files.
 * Opens files, requests geterr, waits for diagnostic events.
 * @param {string} workingDir
 * @param {string[]} filePaths - absolute paths
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<Array<{file: string, diagnostics: object[]}>>}
 */
async function getDiagnostics(workingDir, filePaths, timeoutMs = TSSERVER_REQUEST_TIMEOUT_MS) {
  const session = await getSession(workingDir);
  if (!session) return [];

  const normalizedPaths = filePaths.map(f => f.replace(/\\/g, '/'));

  // Open all files
  for (const fp of filePaths) {
    await session.openFile(fp);
  }

  const results = [];

  // Strategy: try synchronous diagnostic commands first (fast, request-response).
  // If those timeout (project not yet initialized), fall back to geterr event flow.
  // Per-file timeout is half of total to leave room for retries.
  const perFileTimeout = Math.max(Math.floor(timeoutMs / normalizedPaths.length / 2), 3000);

  for (let i = 0; i < normalizedPaths.length; i++) {
    const fp = normalizedPaths[i];
    const allDiags = [];
    let _gotSync = false;

    // Try syntacticDiagnosticsSync (fast, doesn't need full project load)
    try {
      const syntaxDiags = await session.sendRequest('syntacticDiagnosticsSync', { file: fp }, perFileTimeout);
      if (Array.isArray(syntaxDiags)) {
        allDiags.push(...syntaxDiags);
        _gotSync = true;
      }
    } catch (e) {
      logger.debug(`[tsserver] syntacticDiagnosticsSync failed for ${fp}: ${e.message}`);
    }

    // Try semanticDiagnosticsSync (needs full project initialization)
    try {
      const semanticDiags = await session.sendRequest('semanticDiagnosticsSync', { file: fp }, perFileTimeout);
      if (Array.isArray(semanticDiags)) {
        allDiags.push(...semanticDiags);
        _gotSync = true;
      }
    } catch (e) {
      logger.debug(`[tsserver] semanticDiagnosticsSync failed for ${fp}: ${e.message}`);
    }

    // Cache the results for getCachedDiagnostics
    session.diagnosticCache.set(fp, allDiags);
    results.push({ file: fp, diagnostics: allDiags });
  }

  return results;
}

/**
 * Get type info / quick info at a position.
 * @param {string} workingDir
 * @param {string} filePath
 * @param {number} line - 1-based
 * @param {number} offset - 1-based
 * @returns {Promise<{displayString: string, documentation: string}|null>}
 */
async function getQuickInfo(workingDir, filePath, line, offset) {
  const session = await getSession(workingDir);
  if (!session) return null;

  await session.openFile(filePath);
  const normalizedPath = filePath.replace(/\\/g, '/');

  try {
    const body = await session.sendRequest('quickinfo', {
      file: normalizedPath,
      line,
      offset,
    });
    return {
      displayString: body.displayString || '',
      documentation: body.documentation || '',
    };
  } catch (e) {
    logger.debug(`[tsserver] quickinfo failed: ${e.message}`);
    return null;
  }
}

/**
 * Go-to-definition.
 * @param {string} workingDir
 * @param {string} filePath
 * @param {number} line - 1-based
 * @param {number} offset - 1-based
 * @returns {Promise<Array<{file: string, start: object, end: object}>>}
 */
async function getDefinition(workingDir, filePath, line, offset) {
  const session = await getSession(workingDir);
  if (!session) return [];

  await session.openFile(filePath);
  const normalizedPath = filePath.replace(/\\/g, '/');

  try {
    const body = await session.sendRequest('definition', {
      file: normalizedPath,
      line,
      offset,
    });
    // body is an array of definition locations
    const defs = Array.isArray(body) ? body : (body?.definitions || body || []);
    return defs.map(d => ({
      file: d.file,
      start: d.start || d.textSpan?.start,
      end: d.end || d.textSpan?.end,
    }));
  } catch (e) {
    logger.debug(`[tsserver] definition failed: ${e.message}`);
    return [];
  }
}

/**
 * Find all references.
 * @param {string} workingDir
 * @param {string} filePath
 * @param {number} line - 1-based
 * @param {number} offset - 1-based
 * @returns {Promise<Array<{file: string, start: object, end: object}>>}
 */
async function getReferences(workingDir, filePath, line, offset) {
  const session = await getSession(workingDir);
  if (!session) return [];

  await session.openFile(filePath);
  const normalizedPath = filePath.replace(/\\/g, '/');

  try {
    const body = await session.sendRequest('references', {
      file: normalizedPath,
      line,
      offset,
    });
    const refs = body?.refs || [];
    return refs.map(r => ({
      file: r.file,
      start: r.start,
      end: r.end,
      lineText: r.lineText,
    }));
  } catch (e) {
    logger.debug(`[tsserver] references failed: ${e.message}`);
    return [];
  }
}

/**
 * Get cached diagnostics for a file (synchronous).
 * Used by post-task validation to avoid async propagation.
 * @param {string} filePath - absolute path
 * @returns {object[]|null} Diagnostics array or null if no cached data
 */
function getCachedDiagnostics(filePath) {
  if (!isEnabled()) return null;

  const normalizedPath = filePath.replace(/\\/g, '/');
  for (const [, session] of sessions) {
    const diags = session.diagnosticCache.get(normalizedPath) ||
                  session.diagnosticCache.get(filePath);
    if (diags) return diags;
  }
  return null;
}

/**
 * Get status info for all sessions.
 */
function getSessionStatus() {
  const status = [];
  for (const [dir, session] of sessions) {
    status.push({
      workingDir: dir,
      alive: !!(session.process && !session._dead),
      dead: session._dead,
      openFiles: session.openFiles.size,
      cachedDiagFiles: session.diagnosticCache.size,
      pendingRequests: session.pending.size,
      restartCount: session.restartCount,
      idleSeconds: Math.round((Date.now() - session.lastActivity) / 1000),
    });
  }
  return status;
}

/**
 * Kill all sessions (for graceful shutdown).
 */
function shutdownAll() {
  for (const [_key, session] of sessions) {
    session.kill();
  }
  sessions.clear();

  if (idleCheckInterval) {
    clearInterval(idleCheckInterval);
    idleCheckInterval = null;
  }

  logger.info(`[tsserver] All sessions shut down`);
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Whether tsserver support is enabled via config.
 *
 * @returns {boolean} True when db is present and tsserver_enabled is "1".
 */
function isEnabled() {
  if (!db) return false;
  return serverConfig.isOptIn('tsserver_enabled');
}

/**
 * Start periodic cleanup that evicts idle tsserver sessions.
 *
 * @returns {void}
 */
function startIdleCheck() {
  if (idleCheckInterval) return;
  idleCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (now - session.lastActivity > TSSERVER_SESSION_IDLE_TTL_MS) {
        logger.info(`[tsserver] Evicting idle session for ${key}`);
        session.kill();
        sessions.delete(key);
      }
    }
    // Stop checking if no sessions remain
    if (sessions.size === 0 && idleCheckInterval) {
      clearInterval(idleCheckInterval);
      idleCheckInterval = null;
    }
  }, 60000); // Check every minute
  idleCheckInterval.unref();
}

// ─── Exports ───────────────────────────────────────────────────────────

module.exports = {
  init,
  getDiagnostics,
  getQuickInfo,
  getDefinition,
  getReferences,
  getCachedDiagnostics,
  getSessionStatus,
  shutdownAll,
  // Exposed for testing
  ContentLengthFrameParser,
  TsserverSession,
  _sessions: sessions,
};
