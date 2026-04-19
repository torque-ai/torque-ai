'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BaseProvider = require('./base');
const hostManagement = require('../db/host-management');
const { getDataDir } = require('../data-dir');
const { EventType } = require('../streaming/event-types');
const { buildSafeEnv } = require('../utils/safe-env');
const { createSessionStore } = require('./claude-code/session-store');
const { evaluatePermission } = require('./claude-code/permission-chain');
const { acquireHostLock } = require('./host-mutex');
const {
  cleanText,
  normalizeToolCall,
  normalizeToolResult,
  normalizeUsage,
  extractTextDelta,
  extractFallbackText,
} = require('./claude-code/stream-parser');

const DEFAULT_MODE = 'auto';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const SUPPORTED_PERMISSION_MODES = new Set(['auto', 'acceptEdits', 'plan', 'bypassPermissions']);

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

class ClaudeOllamaProvider extends BaseProvider {
  constructor(config = {}) {
    super({
      name: 'claude-ollama',
      enabled: config.enabled === true,
      maxConcurrent: config.maxConcurrent || 1,
    });
    this.providerId = 'claude-ollama';
    this.ollamaBinary = config.ollamaBinary || null;
    this.claudeBinary = config.claudeBinary || null;
    this.sessionsRoot = config.sessionsRoot || path.join(getDataDir(), 'claude-ollama-sessions');
    this.sessionStore = createSessionStore({ rootDir: this.sessionsRoot });
    this.activeSessionId = null;
  }

  get supportsStreaming() {
    return true;
  }
}

module.exports = ClaudeOllamaProvider;
