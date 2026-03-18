'use strict';

const crypto = require('crypto');
const db = require('../database');
const serverConfig = require('../config');
const { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_CLEANUP_MS } = require('../constants');

// Security headers used by sendJson
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

/** @type {Set<Map<string, { count: number, resetAt: number }>>} */
const rateLimitMaps = new Set();

const DEFAULT_RATE_LIMIT = 200;
const DEFAULT_RATE_WINDOW_MS = RATE_LIMIT_WINDOW_MS;

/**
 * Extract an API key from the request headers.
 * Checks `Authorization: Bearer <key>` and `X-API-Key: <key>` headers.
 * Returns the key string if found, or null if no API key is present.
 */
function extractApiKey(req) {
  // Check Authorization: Bearer <key>
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (typeof raw === 'string' && raw.toLowerCase().startsWith('bearer ')) {
      const key = raw.slice(7).trim();
      if (key) return key;
    }
  }

  // Check X-API-Key header
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey) {
    const raw = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }

  return null;
}

/**
 * Create a sliding-window rate limiter with isolated state.
 * Returns true when request is allowed, false when request is denied.
 *
 * When an API key is present (via Authorization: Bearer or X-API-Key header),
 * rate limiting is keyed by the API key instead of the client IP. This ensures
 * that each API key gets its own independent rate limit bucket, which is
 * important when multiple clients share the same IP (e.g., behind a proxy).
 */
function createRateLimiter(maxRequests, windowMs) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const rateLimitMap = new Map();
  rateLimitMaps.add(rateLimitMap);

  return function checkRateLimitForMap(req, res) {
    const ip = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
    const apiKey = extractApiKey(req);

    // Use API key as bucket identifier when present, otherwise fall back to IP
    const bucketKey = apiKey ? `key:${apiKey}` : `ip:${ip}`;
    const now = Date.now();

    let entry = rateLimitMap.get(bucketKey);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitMap.set(bucketKey, entry);
    }

    entry.count++;

    // Attach rate limit info to request for sendJson to use
    req._rateLimit = {
      limit: maxRequests,
      remaining: Math.max(0, maxRequests - entry.count),
      reset: Math.ceil(entry.resetAt / 1000),
    };

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      req._rateLimit.remaining = 0;
      req._rateLimit.retryAfter = retryAfter;
      req._rateLimit.bucket = bucketKey;
      req._rateLimit.windowMs = windowMs;

      const requestIdHeader = req.headers['x-request-id'];
      const requestId = req.requestId || (Array.isArray(requestIdHeader)
        ? requestIdHeader[0]
        : requestIdHeader);

      sendJson(
        res,
        {
          error: {
            code: 'rate_limit_exceeded',
            message: 'Rate limit exceeded',
            request_id: requestId,
            details: {
              bucket: req._rateLimit.bucket,
              limit: req._rateLimit.limit,
              remaining: req._rateLimit.remaining,
              retry_after: retryAfter,
              reset: req._rateLimit.reset,
            },
          },
        },
        429,
        req,
      );
      return false;
    }

    return true;
  };
}

function getRateLimit(configDb) {
  try {
    const sourceDb = configDb || db;
    const limit = sourceDb?.getConfig ? sourceDb.getConfig('api_rate_limit') : null;
    return limit ? parseInt(limit, 10) : DEFAULT_RATE_LIMIT;
  } catch {
    return DEFAULT_RATE_LIMIT;
  }
}

const UNAUTHENTICATED_HEALTH_ROUTES = ['/healthz', '/readyz', '/livez'];

const globalRateLimiter = createRateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

// Periodic cleanup of stale rate limit entries to prevent memory leak
let rateLimitCleanupTimer = null;

function startRateLimitCleanup() {
  if (rateLimitCleanupTimer) return;
  rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const rateLimitMap of rateLimitMaps) {
      for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetAt) {
          rateLimitMap.delete(ip);
        }
      }
    }
  }, RATE_LIMIT_CLEANUP_MS);
  // Don't keep process alive just for cleanup
  if (rateLimitCleanupTimer.unref) rateLimitCleanupTimer.unref();
}

function stopRateLimitCleanup() {
  if (rateLimitCleanupTimer) {
    clearInterval(rateLimitCleanupTimer);
    rateLimitCleanupTimer = null;
  }
  for (const rateLimitMap of rateLimitMaps) {
    rateLimitMap.clear();
  }
}

/**
 * Check rate limit for a given IP. Returns true if allowed, false if exceeded.
 * When exceeded, sets Retry-After header on the response.
 */
function checkRateLimit(req, res) {
  return globalRateLimiter(req, res);
}

/**
 * Validate that a parsed JSON value does not exceed a maximum nesting depth.
 * Prevents stack-overflow DoS from deeply nested payloads.
 */
function validateJsonDepth(obj, maxDepth = 50, currentDepth = 0) {
  if (currentDepth > maxDepth) throw new Error('JSON nesting too deep');
  if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) {
      validateJsonDepth(val, maxDepth, currentDepth + 1);
    }
  }
}

/**
 * Parse JSON body from request
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    const MAX_BODY = 10 * 1024 * 1024; // 10MB
    req.on('data', chunk => {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalSize += chunkBuffer.length;
      if (totalSize > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunkBuffer);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) return resolve({});
      try {
        const parsed = JSON.parse(body);
        validateJsonDepth(parsed);
        resolve(parsed);
      } catch (err) {
        reject(new Error(err.message === 'JSON nesting too deep' ? err.message : 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response with security headers and localhost-restricted CORS
 */
function sendJson(res, data, status = 200, req = null) {
  const body = JSON.stringify(data);
  const dashboardPort = process.env.TORQUE_DASHBOARD_PORT || '3456';
  const corsOrigin = `http://127.0.0.1:${dashboardPort}`;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Torque-Key, X-Request-ID',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    ...SECURITY_HEADERS,
  };
  if (req?._rateLimit) {
    headers['X-RateLimit-Limit'] = String(req._rateLimit.limit);
    headers['X-RateLimit-Remaining'] = String(req._rateLimit.remaining);
    headers['X-RateLimit-Reset'] = String(req._rateLimit.reset);
    if (req._rateLimit.retryAfter !== undefined) {
      headers['Retry-After'] = String(req._rateLimit.retryAfter);
    }
  }
  if (req?.requestId) {
    headers['X-Request-ID'] = req.requestId;
  }
  if (req?._authChallenge) {
    headers['WWW-Authenticate'] = req._authChallenge;
  }
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * Check API key authentication
 * @param {boolean} options.requireApiKey If true, authentication is required even when no key is configured.
 */
function checkAuth(req, options = {}) {
  const expectedKey = serverConfig.get('api_key');
  const requireApiKey = options.requireApiKey === true;

  if (requireApiKey && !expectedKey) {
    return false;
  }

  if (!expectedKey) return true; // No key configured = auth disabled

  const apiKey = req.headers['x-torque-key'];
  const a = crypto.createHash('sha256').update(apiKey || '').digest();
  const b = crypto.createHash('sha256').update(expectedKey || '').digest();

  if (!crypto.timingSafeEqual(a, b)) {
    return false;
  }

  return true;
}

/**
 * Parse URL query parameters
 */
function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = {};
  const searchParams = new URLSearchParams(url.slice(idx + 1));
  for (const [key, value] of searchParams) {
    params[key] = value;
  }
  return params;
}

/**
 * Compose middleware helpers for API route handling.
 */
function applyMiddleware(_server, deps = {}) {
  const {
    getV2RatePolicy: getV2RatePolicyFn = null,
    getV2RateLimiter: getV2RateLimiterFn = null,
    getRateLimit: getRateLimitFn = getRateLimit,
    unauthenticatedHealthRoutes = UNAUTHENTICATED_HEALTH_ROUTES,
  } = deps;

  const effectiveGetRateLimit = typeof getRateLimitFn === 'function'
    ? getRateLimitFn
    : () => 200;
  const effectiveGetV2RatePolicy = typeof getV2RatePolicyFn === 'function'
    ? getV2RatePolicyFn
    : () => 'enforced';
  const effectiveGetV2RateLimiter = typeof getV2RateLimiterFn === 'function'
    ? getV2RateLimiterFn
    : null;

  const shutdownRateLimiter = createRateLimiter(5, RATE_LIMIT_WINDOW_MS);
  const tasksRateLimiter = createRateLimiter(effectiveGetRateLimit(), DEFAULT_RATE_WINDOW_MS);
  const metricsRateLimiter = createRateLimiter(30, RATE_LIMIT_WINDOW_MS);
  const defaultEndpointRateLimiter = createRateLimiter(effectiveGetRateLimit(), DEFAULT_RATE_WINDOW_MS);

  function getEndpointRateLimiter(url) {
    if (url.startsWith('/api/v2/')) {
      if (effectiveGetV2RatePolicy() === 'disabled') {
        return () => true;
      }
      if (!effectiveGetV2RateLimiter) return checkRateLimit;
      return effectiveGetV2RateLimiter();
    }
    if (url === '/api/shutdown') return shutdownRateLimiter;
    if (url === '/api/metrics') return metricsRateLimiter;
    if (url === '/api/tasks' || url.startsWith('/api/tasks/')) return tasksRateLimiter;

    if (url.startsWith('/api/') || unauthenticatedHealthRoutes.includes(url)) {
      return defaultEndpointRateLimiter;
    }

    return null;
  }

  function handleCorsPreflight(req, res) {
    if (req?.method === 'OPTIONS') {
      sendJson(res, {}, 204, req);
      return true;
    }
    return false;
  }

  return {
    getEndpointRateLimiter,
    handleCorsPreflight,
    unauthenticatedHealthRoutes,
  };
}

module.exports = {
  createRateLimiter,
  extractApiKey,
  getRateLimit,
  startRateLimitCleanup,
  stopRateLimitCleanup,
  checkRateLimit,
  parseBody,
  sendJson,
  checkAuth,
  parseQuery,
  applyMiddleware,
  UNAUTHENTICATED_HEALTH_ROUTES,
  DEFAULT_RATE_WINDOW_MS,
  SECURITY_HEADERS,
};
