'use strict';

const { randomUUID } = require('crypto');
const { ToolRegistry } = require('./tool-registry');
const { MCPPlatformTelemetry } = require('./telemetry');

function isPlatformEnabled(env = process.env) {
  const raw = String(env.TORQUE_MCP_PLATFORM_ENABLED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

class MCPPlatform {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.toolRegistry = options.toolRegistry || new ToolRegistry();
    this.telemetry = options.telemetry || new MCPPlatformTelemetry();
    this._ready = false;
    this._requestStarts = new Map();
  }

  init() {
    if (!isPlatformEnabled(this.env)) {
      return false;
    }

    this._ready = true;
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
