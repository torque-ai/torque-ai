'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const child_process = require('child_process');

const BaseProvider = require('./base');
const hostManagement = require('../db/host/management');
const { getDataDir } = require('../data-dir');
const { EventType } = require('../streaming/event-types');
const { buildSafeEnv } = require('../utils/safe-env');
const { createSessionStore } = require('./claude-code/session-store');
const { evaluatePermission } = require('./claude-code/permission-chain');
const hostMutex = require('./host-mutex');
const {
  cleanText,
  normalizeToolCall,
  normalizeToolResult,
  normalizeUsage,
  extractTextDelta,
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
    // --verbose is required when combining --print with --output-format=stream-json
    args.push(
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
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

  ensureSession({ sessionId = null, workingDirectory = process.cwd() } = {}) {
    let localSessionId = cleanText(sessionId);
    if (!localSessionId) {
      localSessionId = this.sessionStore.create({
        name: 'claude-ollama',
        metadata: {
          claude_session_id: randomUUID(),
          working_directory: workingDirectory,
        },
      });
    }
    if (!this.sessionStore.exists(localSessionId)) {
      throw new Error(`Unknown Claude-Ollama session: ${localSessionId}`);
    }
    this.activeSessionId = localSessionId;
    return localSessionId;
  }

  readSessionMeta(sessionId) {
    const metaPath = path.join(this.sessionsRoot, sessionId, 'meta.json');
    try {
      const parsed = JSON.parse(require('fs').readFileSync(metaPath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : { metadata: {} };
    } catch {
      return { metadata: {} };
    }
  }

  async runPrompt(prompt, model, options = {}) {
    const workingDirectory = cleanText(options.working_directory) || process.cwd();
    const rawPromptText = cleanText(prompt);
    if (!rawPromptText) throw new Error('prompt must be a non-empty string');

    const localSessionId = this.ensureSession({
      sessionId: options.session_id,
      workingDirectory,
    });
    const sessionMeta = this.readSessionMeta(localSessionId);
    const claudeSessionId = cleanText(sessionMeta.metadata?.claude_session_id) || randomUUID();
    const messageCount = this.sessionStore.readAll(localSessionId).length;
    this.sessionStore.append(localSessionId, {
      role: 'user',
      content: rawPromptText,
      timestamp: new Date().toISOString(),
    });

    const permissionMode = SUPPORTED_PERMISSION_MODES.has(cleanText(options.mode))
      ? cleanText(options.mode) : DEFAULT_MODE;
    const allowedTools = Array.isArray(options.allowed_tools) ? options.allowed_tools : [];
    const disallowedTools = Array.isArray(options.disallowed_tools) ? options.disallowed_tools : [];

    const commandArgs = this.buildCommandArgs({
      model, workingDirectory, permissionMode,
      allowedTools, disallowedTools,
      skillPrompt: cleanText(options.skill_prompt),
      claudeSessionId, messageCount,
    });

    const timeoutMs = Number(options.timeout_ms) > 0 ? Number(options.timeout_ms) : DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();

    let selectedHost = null;
    try {
      if (typeof hostManagement.selectOllamaHostForModel === 'function') {
        selectedHost = hostManagement.selectOllamaHostForModel(cleanText(model));
      }
    } catch {
      // host selection unavailable (e.g. DB not initialized in tests) -- fall back to default lock
    }
    const hostId = selectedHost?.id || selectedHost?.host_id || 'default-host';
    const release = await hostMutex.acquireHostLock(hostId);

    let result;
    try {
      result = await new Promise((resolve, reject) => {
      const child = child_process.spawn(this.resolveOllamaBinary(), commandArgs, {
        cwd: workingDirectory,
        env: buildSafeEnv(this.providerId, {
          FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb', CI: '1',
          CLAUDE_NON_INTERACTIVE: '1', PYTHONIOENCODING: 'utf-8',
        }),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdoutRemainder = '';
      let aggregatedText = '';
      const stderrChunks = [];
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let settled = false;
      let timeoutHandle = null;
      let permissionDeniedError = null;
      let processing = Promise.resolve();

      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        fn(v);
      };

      const handleRecord = async (rec) => {
        const u = normalizeUsage(rec);
        if (u) usage = { ...usage, ...u };

        const toolCall = normalizeToolCall(rec);
        if (toolCall) {
          const permission = await evaluatePermission({
            toolName: toolCall.name,
            args: toolCall.args,
            settings: { allowed_tools: allowedTools, disallowed_tools: disallowedTools },
            mode: permissionMode,
            hooks: Array.isArray(options.hooks) ? options.hooks : [],
            canUseTool: typeof options.canUseTool === 'function' ? options.canUseTool : null,
          });
          if (permission.decision !== 'allow') {
            permissionDeniedError = new Error(
              `Claude tool "${toolCall.name}" denied by ${permission.source}: ${permission.reason}`,
            );
            try { child.kill(); } catch { /* ignore */ }
            return;
          }
          if (typeof options.onEvent === 'function') {
            await options.onEvent({
              type: EventType.TOOL_CALL,
              tool_call_id: toolCall.tool_call_id,
              name: toolCall.name,
              args: toolCall.args,
              permission,
            });
          }
        }

        const delta = extractTextDelta(rec);
        if (delta) {
          aggregatedText += delta;
          if (typeof options.onChunk === 'function') await options.onChunk(delta);
        }

        const toolResult = normalizeToolResult(rec);
        if (toolResult && typeof options.onEvent === 'function') {
          await options.onEvent({
            type: EventType.TOOL_RESULT,
            tool_call_id: toolResult.tool_call_id,
            ...(toolResult.error ? { error: toolResult.error } : { result: toolResult.content }),
          });
        }
      };

      child.stdout.on('data', (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        processing = processing.then(async () => {
          stdoutRemainder += text;
          const lines = stdoutRemainder.split(/\r?\n/);
          stdoutRemainder = lines.pop() || '';
          for (const line of lines) {
            const trimmed = cleanText(line);
            if (!trimmed || trimmed === '[DONE]') continue;
            const parsed = safeJsonParse(trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed);
            if (parsed) await handleRecord(parsed);
            if (permissionDeniedError) return;
          }
        });
      });

      child.stderr.on('data', (c) => stderrChunks.push(Buffer.isBuffer(c) ? c.toString('utf8') : String(c)));

      child.once('error', (err) => finish(reject, err));
      child.once('close', (code, signal) => {
        processing = processing.then(async () => {
          if (stdoutRemainder) {
            const parsed = safeJsonParse(stdoutRemainder);
            if (parsed) await handleRecord(parsed);
            stdoutRemainder = '';
          }
          if (permissionDeniedError) {
            finish(reject, permissionDeniedError);
            return;
          }
          if (code !== 0) {
            const stderrText = stderrChunks.join('');
            finish(reject, new Error(`claude-ollama exited with status ${code}${signal ? ` (${signal})` : ''}: ${stderrText || aggregatedText || 'unknown error'}`));
            return;
          }
          finish(resolve, { output: aggregatedText, usage, stderr: stderrChunks.join('') });
        });
      });

      timeoutHandle = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish(reject, new Error(`claude-ollama timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdin.end(rawPromptText, 'utf8');
      });
    } finally {
      release();
    }

    this.sessionStore.append(localSessionId, {
      role: 'assistant',
      content: result.output,
      timestamp: new Date().toISOString(),
    });

    const durationMs = Date.now() - startTime;
    return {
      output: result.output,
      status: 'completed',
      session_id: localSessionId,
      claude_session_id: claudeSessionId,
      usage: {
        input_tokens: result.usage.prompt_tokens || 0,
        output_tokens: result.usage.completion_tokens || 0,
        total_tokens: result.usage.total_tokens || 0,
        tokens: result.usage.total_tokens || 0,
        cost: 0,
        duration_ms: durationMs,
        model: cleanText(model),
      },
    };
  }

  async submit(task, model, options = {}) {
    return this.runPrompt(task, model, options);
  }

  async submitStream(task, model, options = {}) {
    return this.runPrompt(task, model, options);
  }

  async dispatchSubagent(options = {}) {
    const prompt = cleanText(options.prompt);
    if (!prompt) throw new Error('prompt must be a non-empty string');
    const response = await this.submit(prompt, options.model || null, options);
    return {
      session_id: response.session_id,
      claude_session_id: response.claude_session_id,
      output: response.output,
      usage: response.usage,
      mode: SUPPORTED_PERMISSION_MODES.has(cleanText(options.mode)) ? cleanText(options.mode) : DEFAULT_MODE,
    };
  }
}

module.exports = ClaudeOllamaProvider;
