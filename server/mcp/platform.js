'use strict';

const { randomUUID } = require('crypto');
const { ToolRegistry } = require('./tool-registry');
const { MCPPlatformTelemetry } = require('./telemetry');

function isPlatformEnabled(env = process.env) {
  const raw = String(env.TORQUE_MCP_PLATFORM_ENABLED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

const REQUEST_STARTS_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REQUEST_STARTS_CLEANUP_INTERVAL_MS = 60 * 1000; // check every minute

class MCPPlatform {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.toolRegistry = options.toolRegistry || new ToolRegistry();
    this.telemetry = options.telemetry || new MCPPlatformTelemetry();
    this._ready = false;
    this._requestStarts = new Map();
    this._cleanupTimer = null;
  }

  _startCleanupTimer() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - REQUEST_STARTS_TTL_MS;
      for (const [id, entry] of this._requestStarts) {
        if (entry.startedAt < cutoff) this._requestStarts.delete(id);
      }
    }, REQUEST_STARTS_CLEANUP_INTERVAL_MS);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  _stopCleanupTimer() {
    if (this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; }
  }

  init() {
    if (!isPlatformEnabled(this.env)) {
      return false;
    }

    this._ready = true;
    this._startCleanupTimer();
    return true;
  }

  start() {
    if (!isPlatformEnabled(this.env)) {
      return false;
    }

    return this.init();
  }

  stop() {
    this._ready = false;
    this._requestStarts.clear();
    this._stopCleanupTimer();
    return isPlatformEnabled(this.env);
  }

  isReady() {
    return isPlatformEnabled(this.env) && this._ready;
  }

  createCorrelationId() {
    return randomUUID();
  }

  wrapRequest(toolName, params) {
    const requestId = this.createCorrelationId();
    const startedAt = Date.now();
    this._requestStarts.set(requestId, {
      startedAt,
      toolName,
    });

    return {
      id: requestId,
      tool: toolName,
      params: params === undefined ? {} : params,
      timestamp: new Date(startedAt).toISOString(),
    };
  }

  wrapResponse(id, result) {
    const finishedAt = Date.now();
    const requestContext = this._requestStarts.get(id);
    if (requestContext) {
      this._requestStarts.delete(id);
    }

    return {
      id,
      result,
      duration_ms: requestContext ? Math.max(0, finishedAt - requestContext.startedAt) : 0,
      timestamp: new Date(finishedAt).toISOString(),
    };
  }
}

module.exports = {
  MCPPlatform,
  isPlatformEnabled,
};
