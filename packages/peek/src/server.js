'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createCaptureHandler } = require('./capabilities/capture');
const { createInteractionHandlers } = require('./capabilities/interact');
const { createWindowHandlers } = require('./capabilities/windows');
const { createHealthHandler } = require('./health');
const { createRouter } = require('./router');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9876;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const TOKEN_HEADER = 'x-peek-token';

function getDefaultPidFile() {
  return path.join(os.homedir(), '.torque-peek', 'peek.pid');
}

function writePidFile(pidFile, pid = process.pid) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${pid}\n`, 'utf8');
}

function removePidFile(pidFile, expectedPid = process.pid) {
  try {
    const currentPid = fs.readFileSync(pidFile, 'utf8').trim();
    if (currentPid === '' || currentPid === String(expectedPid)) {
      fs.unlinkSync(pidFile);
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function isLocalAddress(address) {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address === 'localhost';
}

function isAuthorized(req, token) {
  if (!token) return true;
  const header = req.headers[TOKEN_HEADER];
  if (Array.isArray(header)) return header.includes(String(token));
  return header === String(token);
}

function normalizePort(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`Invalid port: ${value}`);
  }

  return port;
}

function normalizePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new RangeError(`Invalid positive integer: ${value}`);
  }

  return number;
}

function parseQuery(searchParams) {
  const query = {};

  for (const [name, value] of searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(query, name)) {
      query[name] = Array.isArray(query[name]) ? [...query[name], value] : [query[name], value];
    } else {
      query[name] = value;
    }
  }

  return query;
}

function sendJson(res, statusCode, body, headers = {}) {
  if (res.writableEnded) return undefined;

  const payload = body === undefined ? null : body;
  const json = JSON.stringify(payload);

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
  return undefined;
}

function sendEmpty(res, statusCode) {
  if (res.writableEnded) return undefined;
  res.writeHead(statusCode);
  res.end();
  return undefined;
}

function readRequestBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      reject(error);
    }

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        const error = new Error('Request body too large');
        error.statusCode = 413;
        fail(error);
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', fail);
  });
}

function shouldReadBody(method) {
  return !['GET', 'HEAD'].includes(String(method || '').toUpperCase());
}

async function parseBody(req, maxBodyBytes) {
  if (!shouldReadBody(req.method)) return null;

  const raw = await readRequestBody(req, maxBodyBytes);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_error) {
    const error = new Error('Invalid JSON request body');
    error.statusCode = 400;
    throw error;
  }
}

function createRequestContext(req, res, parsedUrl, body) {
  return {
    req,
    res,
    method: String(req.method || 'GET').toUpperCase(),
    path: parsedUrl.pathname,
    query: parseQuery(parsedUrl.searchParams),
    body,
    headers: req.headers,
    remoteAddress: req.socket ? req.socket.remoteAddress : null,
    json: (statusCode, payload, headers) => sendJson(res, statusCode, payload, headers),
    empty: (statusCode) => sendEmpty(res, statusCode),
  };
}

function createCapabilityHandlers(options = {}) {
  const handlers = { ...(options.handlers || {}) };
  const adapter = options.adapter || options.platformAdapter || null;

  if (adapter && typeof adapter.capture === 'function') {
    const captureHandler = createCaptureHandler(adapter, options.captureOptions || {});
    if (typeof handlers.peek !== 'function') handlers.peek = captureHandler;
    if (typeof handlers.capture !== 'function') handlers.capture = captureHandler;
  }

  for (const [name, handler] of Object.entries(createInteractionHandlers(adapter))) {
    if (typeof handlers[name] !== 'function') handlers[name] = handler;
  }

  for (const [name, handler] of Object.entries(createWindowHandlers(adapter))) {
    if (typeof handlers[name] !== 'function') handlers[name] = handler;
  }

  return handlers;
}

function createServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = normalizePort(options.port);
  const token = options.token || null;
  const pidFile = options.pidFile || getDefaultPidFile();
  const startedAt = Date.now();
  const maxBodyBytes = normalizePositiveInteger(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  const writePid = options.writePidFile !== false;
  let isListening = false;
  let closePromise = null;
  let removeSignalHandlers = null;

  const healthHandler = createHealthHandler({
    checkDependencies: options.checkDependencies,
    platformOptions: options.platformOptions,
    startedAt,
    version: options.version,
  });

  let closeInstance = async () => undefined;

  const shutdownHandler = async (ctx) => {
    if (!isLocalAddress(ctx.remoteAddress)) {
      return ctx.json(403, {
        success: false,
        error: 'Shutdown is only allowed from localhost',
      });
    }

    ctx.json(200, { success: true, shutting_down: true });
    setImmediate(() => {
      closeInstance().catch(() => {});
    });
    return undefined;
  };

  const router = createRouter({
    handlers: createCapabilityHandlers(options),
    healthHandler,
    shutdownHandler,
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!isAuthorized(req, token)) {
        return sendJson(res, 401, { success: false, error: 'Unauthorized' });
      }

      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || host}`);
      const body = await parseBody(req, maxBodyBytes);
      const ctx = createRequestContext(req, res, parsedUrl, body);
      return await router(ctx);
    } catch (error) {
      if (res.writableEnded) return undefined;

      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return sendJson(res, statusCode, {
        success: false,
        error: error && error.message ? error.message : 'Internal server error',
      });
    }
  });

  function cleanupPidFile() {
    if (!writePid) return;

    try {
      removePidFile(pidFile);
    } catch (_error) {
      // Shutdown cleanup should not mask the original close path.
    }
  }

  closeInstance = function close() {
    if (closePromise) return closePromise;

    if (removeSignalHandlers) {
      removeSignalHandlers();
      removeSignalHandlers = null;
    }

    closePromise = new Promise((resolve, reject) => {
      function finish(error) {
        cleanupPidFile();
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(error);
        } else {
          resolve();
        }
      }

      if (!isListening) {
        finish();
        return;
      }

      server.close(finish);
    });

    return closePromise;
  };

  function installSignalHandlers() {
    const handleSignal = () => {
      closeInstance()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };

    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);

    return () => {
      process.removeListener('SIGINT', handleSignal);
      process.removeListener('SIGTERM', handleSignal);
    };
  }

  server.once('listening', () => {
    isListening = true;
    if (writePid) {
      writePidFile(pidFile);
    }
  });

  server.once('close', () => {
    isListening = false;
    cleanupPidFile();
  });

  if (options.installSignalHandlers !== false) {
    removeSignalHandlers = installSignalHandlers();
  }

  if (options.listen !== false) {
    server.listen(port, host);
  }

  return {
    server,
    router,
    host,
    port,
    pidFile,
    startedAt,
    close: closeInstance,
  };
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  TOKEN_HEADER,
  createServer,
  createCapabilityHandlers,
  getDefaultPidFile,
  isLocalAddress,
  normalizePort,
  parseQuery,
  readRequestBody,
  removePidFile,
  writePidFile,
};
