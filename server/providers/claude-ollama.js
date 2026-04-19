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

  async listModels() {
    const hosts = hostManagement.listOllamaHosts({ enabled: true }) || [];
    const union = new Set();
    for (const host of hosts) {
      const url = cleanText(host.url);
      if (!url) continue;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!resp.ok) continue;
        const data = await resp.json();
        const models = Array.isArray(data?.models) ? data.models : [];
        for (const m of models) {
          const name = cleanText(m?.name);
          if (!name) continue;
          if (name.endsWith('-cloud')) continue;
          union.add(name);
        }
      } catch {
        // host unreachable -- skip, don't fail the whole listing
      }
    }
    return Array.from(union).sort();
  }

  buildCommandArgs({
    model,
    workingDirectory,
    permissionMode,
    allowedTools,
    disallowedTools,
    skillPrompt,
    claudeSessionId,
    messageCount,
  }) {
    const args = ['launch', 'claude', '--model', cleanText(model), '--'];

    // claude-cli flags follow the -- boundary
    args.push(
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--strict-mcp-config',
    );

    if (cleanText(permissionMode) && SUPPORTED_PERMISSION_MODES.has(permissionMode)) {
      args.push('--permission-mode', permissionMode);
    }
    if (allowedTools && allowedTools.length > 0) {
      args.push('--allowed-tools', allowedTools.join(','));
    }
    if (disallowedTools && disallowedTools.length > 0) {
      args.push('--disallowed-tools', disallowedTools.join(','));
    }
    if (cleanText(skillPrompt)) {
      args.push('--append-system-prompt', skillPrompt);
    }
    if (cleanText(workingDirectory)) {
      args.push('--add-dir', workingDirectory);
    }

    const sid = cleanText(claudeSessionId);
    if (messageCount > 0) {
      args.push('--resume', sid);
    } else {
      args.push('--session-id', sid);
    }

    return args;
  }
}

module.exports = ClaudeOllamaProvider;
