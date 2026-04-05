/**
 * CLI-backed providers for v2 REST transport parity.
 *
 * These adapters intentionally support the v2 adapter contract for
 * sync submission while leaving stream/async unimplemented at this stage.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const BaseProvider = require('./base');
const configCore = require('../db/config-core');
const providerRoutingCore = require('../db/provider-routing-core');
const prompts = require('./prompts');
const logger = require('../logger').child({ component: 'v2-cli-providers' });
const { TASK_TIMEOUTS, PROVIDER_DEFAULT_TIMEOUTS } = require('../constants');
const { buildSafeEnv } = require('../utils/safe-env');

prompts.init({ db: { getConfig: configCore.getConfig } });

function resolveCliPath(baseName, providerConfig) {
  if (providerConfig && providerConfig.cli_path) {
    const configuredPath = String(providerConfig.cli_path);
    if (process.platform === 'win32' && !path.extname(configuredPath)) {
      return `${configuredPath}.cmd`;
    }
    return configuredPath;
  }

  return process.platform === 'win32' ? `${baseName}.cmd` : baseName;
}

function resolveTimeoutMinutes(options, providerName) {
  const defaultMinutes = PROVIDER_DEFAULT_TIMEOUTS[providerName] || PROVIDER_DEFAULT_TIMEOUTS.groq || 10;
  const requested = Number(options?.timeout);
  const requestedMinutes = Number.isFinite(requested) ? requested : null;
  return Math.max(1, Math.min(requestedMinutes || defaultMinutes, 480));
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function truncateErrorText(text, max = 280) {
  const normalized = cleanText(text);
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function resolveCodexApiToken() {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  try {
    const codexHome = path.join(os.homedir(), '.codex');
    const apiAuthPath = path.join(codexHome, 'api.auth.json');
    if (fs.existsSync(apiAuthPath)) {
      const apiAuth = JSON.parse(fs.readFileSync(apiAuthPath, 'utf8'));
      if (apiAuth?.OPENAI_API_KEY) {
        return String(apiAuth.OPENAI_API_KEY);
      }
    }

    const authPath = path.join(codexHome, 'auth.json');
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (auth?.tokens?.access_token) {
        return String(auth.tokens.access_token);
      }
    }
  } catch {
    // Best-effort auth discovery only.
  }

  return '';
}

function extractResponsesOutput(payload) {
  if (!payload || typeof payload !== 'object') return '';

  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (Array.isArray(payload.output)) {
    let combined = '';
    for (const item of payload.output) {
      if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const contentBlock of item.content) {
        if (contentBlock?.type === 'output_text' && typeof contentBlock.text === 'string') {
          combined += contentBlock.text;
        }
      }
    }
    if (combined.trim()) return combined.trim();
  }

  const chatChoice = payload?.choices?.[0]?.message?.content;
  if (typeof chatChoice === 'string' && chatChoice.trim()) {
    return chatChoice.trim();
  }

  return '';
}

class CliProviderAdapter extends BaseProvider {
  constructor(providerId, options = {}) {
    super({
      name: providerId,
      enabled: options.enabled !== false,
      maxConcurrent: options.maxConcurrent || 3,
    });
    this.providerId = providerId;
    this.cliBinary = options.cliBinary;
    this.defaultModel = options.defaultModel;
  }

  get supportsStreaming() {
    return false;
  }

  getProviderConfig() {
    try {
      return providerRoutingCore.getProvider(this.providerId) || {};
    } catch {
      return {};
    }
  }

  getTransport(options = {}) {
    const transport = options?.transport;
    return transport === 'api' ? 'api' : 'cli';
  }

  buildPrompt(task, _model) {
    return cleanText(task);
  }

  async submit(task, model, options = {}) {
    const transport = this.getTransport(options);
    if (transport !== 'cli') {
      throw new Error(`${this.providerId} API transport is not available for v2 adapter`);
    }

    const providerConfig = this.getProviderConfig();
    const cliPath = this.cliBinary || resolveCliPath(this.providerId, providerConfig);
    const { finalArgs, stdinPrompt } = this.buildCommand(task, model, options, providerConfig);
    const startTime = Date.now();
    const timeoutMs = resolveTimeoutMinutes(options, this.providerId) * 60 * 1000;
    const useShell = process.platform === 'win32' && /\.cmd$/i.test(cliPath);

    const maxBuffer = 10 * 1024 * 1024;
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        const child = spawn(cliPath, finalArgs, {
          cwd: options.working_directory || process.cwd(),
          env: buildSafeEnv(this.providerId, {
            FORCE_COLOR: '0',
            NO_COLOR: '1',
            TERM: 'dumb',
            CI: '1',
            CODEX_NON_INTERACTIVE: '1',
            CLAUDE_NON_INTERACTIVE: '1',
            PYTHONIOENCODING: 'utf-8',
          }),
          shell: useShell,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const stdoutChunks = [];
        const stderrChunks = [];
        let totalBytes = 0;
        let settled = false;
        let timeoutHandle = null;

        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          fn(value);
        };

        const appendChunk = (chunks, chunk) => {
          if (settled) return;
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          totalBytes += Buffer.byteLength(text);
          if (totalBytes > maxBuffer) {
            const maxBufferError = new Error('stdout/stderr maxBuffer length exceeded');
            maxBufferError.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
            child.kill();
            finish(reject, maxBufferError);
            return;
          }
          chunks.push(text);
        };

        timeoutHandle = setTimeout(() => {
          const timeoutError = new Error(`Command timed out after ${timeoutMs}ms`);
          timeoutError.code = 'ETIMEDOUT';
          child.kill();
          finish(reject, timeoutError);
        }, timeoutMs);

        child.stdout?.on('data', (chunk) => appendChunk(stdoutChunks, chunk));
        child.stderr?.on('data', (chunk) => appendChunk(stderrChunks, chunk));
        child.once('close', (code, signal) => {
          finish(resolve, {
            stdout: stdoutChunks.join(''),
            stderr: stderrChunks.join(''),
            status: code,
            signal,
          });
        });
        child.once('error', (error) => finish(reject, error));

        if (child.stdin) {
          child.stdin.write(stdinPrompt);
          child.stdin.end();
        }
      });
    } catch (error) {
      logger.info(`[v2 ${this.providerId}] spawn error: ${error.message}`);
      throw error;
    }

    const elapsedMs = Date.now() - startTime;

    const stdoutText = cleanText(result.stdout);
    const stderrText = cleanText(result.stderr);
    const output = stdoutText || stderrText || 'No output returned';

    if (result.status !== 0) {
      const reason = `v2 ${this.providerId} CLI exited with status ${result.status}${stderrText ? `: ${stderrText}` : ''}`;
      const err = new Error(reason);
      logger.info(`[v2 ${this.providerId}] command failed: ${reason}`);
      throw err;
    }

    const selectedModel = model || this.defaultModel || null;
    return {
      output,
      status: 'completed',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost: 0,
        duration_ms: elapsedMs,
        model: selectedModel,
      },
    };
  }

  async checkHealth() {
    const providerConfig = this.getProviderConfig();
    const cliPath = this.cliBinary || resolveCliPath(this.providerId, providerConfig);

    try {
      const result = spawnSync(cliPath, ['--version'], {
        timeout: TASK_TIMEOUTS.PROVIDER_CHECK,
        encoding: 'utf8',
        windowsHide: true,
      });

      if (result.error || result.status !== 0) {
        return {
          available: false,
          models: [],
          error: result.error
            ? String(result.error.message || result.error)
            : cleanText(result.stderr) || `Command exited with status ${result.status}`,
        };
      }

      return {
        available: true,
        models: [],
        version: cleanText(result.stdout) || undefined,
      };
    } catch (err) {
      return {
        available: false,
        models: [],
        error: String(err.message || err),
      };
    }
  }

  async listModels() {
    return [];
  }
}

class CodexCliProvider extends CliProviderAdapter {
  constructor(config = {}) {
    super('codex', {
      cliBinary: config.cliBinary,
      defaultModel: config.defaultModel,
      ...config,
    });
  }

  buildPrompt(task, model) {
    return prompts.wrapWithInstructions(cleanText(task), 'codex', model);
  }

  async submit(task, model, options = {}) {
    const transport = this.getTransport(options);
    if (transport === 'api') {
      return this.submitViaApi(task, model, options);
    }
    return super.submit(task, model, options);
  }

  async submitViaApi(task, model, options = {}) {
    // TODO(issue-5): The API transport path has no worktree isolation. The CLI transport
    // runs inside a sandboxed git worktree (if configured), but submitViaApi() sends the
    // prompt directly to the OpenAI Codex API without any filesystem isolation.  If the
    // Codex API response writes files back through a post-processing hook, those writes
    // land in the working directory without the sandbox protections that the CLI path has.
    // Fix: integrate WorktreeManager here, or explicitly block file-write responses.
    if (options.working_directory && typeof options._worktreeIsolated !== 'boolean') {
      logger.warn(`[CodexAPI] submitViaApi: no worktree isolation active for working_directory='${options.working_directory}'. File writes from API response land directly in the repo.`);
    }
    const apiToken = resolveCodexApiToken();
    if (!apiToken) {
      throw new Error('codex API transport is unavailable: no OPENAI_API_KEY or Codex auth token found');
    }

    const startTime = Date.now();
    const timeoutMs = resolveTimeoutMinutes(options, this.providerId) * 60 * 1000;
    const baseUrl = cleanText(configCore.getConfig?.('openai_base_url')) || 'https://api.openai.com';
    const selectedModel = cleanText(model)
      || cleanText(configCore.getConfig?.('codex_api_model'))
      || cleanText(configCore.getConfig?.('codex_model'))
      || this.defaultModel
      || 'gpt-5.3-codex';

    const requestBody = {
      model: selectedModel,
      input: this.buildPrompt(task, selectedModel),
    };

    if (Number.isFinite(Number(options?.maxTokens))) {
      requestBody.max_output_tokens = Math.max(1, Math.floor(Number(options.maxTokens)));
    }

    if (Number.isFinite(Number(options?.tuning?.temperature))) {
      requestBody.temperature = Number(options.tuning.temperature);
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      const errorBody = truncateErrorText(await response.text());
      throw new Error(`OpenAI API error (${response.status})${errorBody ? `: ${errorBody}` : ''}`);
    }

    const payload = await response.json();
    const output = extractResponsesOutput(payload);
    if (!output) {
      throw new Error('OpenAI API returned empty response content');
    }

    const elapsedMs = Date.now() - startTime;
    const usage = payload?.usage || {};
    const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
    const outputTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
    const totalTokens = Number(usage.total_tokens || (inputTokens + outputTokens));
    const resolvedModel = payload?.model || selectedModel;
    // Codex API pricing: gpt-5.3-codex/gpt-5.3-codex-spark at ~$0.003/1K tokens (estimate)
    const costPerMToken = resolvedModel && /codex-spark|codex-mini/i.test(resolvedModel) ? 1.50 : 3.00;
    const estimatedCost = totalTokens > 0 ? (totalTokens / 1_000_000) * costPerMToken : 0;

    return {
      output,
      status: 'completed',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost: estimatedCost,
        duration_ms: elapsedMs,
        model: resolvedModel,
      },
    };
  }

  buildCommand(task, model, options) {
    const prompt = this.buildPrompt(task, model);
    const args = ['exec', '--skip-git-repo-check'];

    if (model) {
      args.push('-m', model);
    }

    if (options && options.auto_approve) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--full-auto');
    }

    if (options?.working_directory) {
      args.push('-C', options.working_directory);
    }

    args.push('-');

    return {
      finalArgs: args,
      stdinPrompt: prompt,
    };
  }
}

class ClaudeCliProvider extends CliProviderAdapter {
  constructor(config = {}) {
    super('claude-cli', {
      cliBinary: config.cliBinary,
      ...config,
    });
  }

  buildPrompt(task, model) {
    return prompts.wrapWithInstructions(cleanText(task), 'claude-cli', model);
  }

  buildCommand(task, model, _options) {
    return {
      finalArgs: [
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
        '--strict-mcp-config',
        '-p',
      ],
      stdinPrompt: this.buildPrompt(task, model),
    };
  }
}

// ── DI factory ──────────────────────────────────────────────────────────────

function createV2CliProviders({ db: dbInstance } = {}) {
  if (dbInstance) {
    prompts.init({ db: dbInstance });
  }
  return module.exports;
}

module.exports = {
  createV2CliProviders,
  CodexCliProvider,
  ClaudeCliProvider,
};
