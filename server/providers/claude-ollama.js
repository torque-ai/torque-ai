'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const child_process = require('child_process');

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

  resolveOllamaBinary() {
    if (this.ollamaBinary) return this.ollamaBinary;
    return process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  }

  resolveClaudeBinary() {
    if (this.claudeBinary) return this.claudeBinary;
    return process.platform === 'win32' ? 'claude.exe' : 'claude';
  }

  async checkHealth() {
    const ollamaResult = child_process.spawnSync(this.resolveOllamaBinary(), ['--version'], {
      timeout: 5000, encoding: 'utf8', windowsHide: true,
    });
    if (!ollamaResult || ollamaResult.status !== 0) {
      return {
        available: false,
        models: [],
        error: `ollama binary not reachable: ${cleanText(ollamaResult?.stderr) || cleanText(ollamaResult?.stdout) || 'unknown error'}`,
      };
    }

    const claudeResult = child_process.spawnSync(this.resolveClaudeBinary(), ['--version'], {
      timeout: 5000, encoding: 'utf8', windowsHide: true,
    });
    if (!claudeResult || claudeResult.status !== 0) {
      return {
        available: false,
        models: [],
        error: `claude binary not reachable: ${cleanText(claudeResult?.stderr) || cleanText(claudeResult?.stdout) || 'unknown error'}`,
      };
    }

    const hosts = hostManagement.listOllamaHosts({ enabled: true }) || [];
    if (hosts.length === 0) {
      return { available: false, models: [], error: 'no active Ollama host registered' };
    }

    const models = await this.listModels();
    if (models.length === 0) {
      return { available: false, models: [], error: 'no local models available on any host' };
    }

    return { available: true, models, version: `${cleanText(ollamaResult.stdout)} / ${cleanText(claudeResult.stdout)}` };
  }
}

module.exports = ClaudeOllamaProvider;
