'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BaseProvider = require('./base');
const providerRoutingCore = require('../db/provider-routing-core');
const { getDataDir } = require('../data-dir');
const { EventType } = require('../streaming/event-types');
const { buildSafeEnv } = require('../utils/safe-env');
const { createSessionStore } = require('./claude-code/session-store');
const { evaluatePermission } = require('./claude-code/permission-chain');
const { loadSkills } = require('./claude-code/skills-loader');

const DEFAULT_MODE = 'auto';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const SUPPORTED_PERMISSION_MODES = new Set(['auto', 'acceptEdits', 'plan', 'bypassPermissions']);
const DEFAULT_MODELS = Object.freeze([
  'claude-sonnet-4-20250514',
  'claude-haiku-4-20250514',
  'claude-opus-4-20250514',
]);

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = cleanText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizePermissionMode(value) {
  const normalized = cleanText(value);
  return SUPPORTED_PERMISSION_MODES.has(normalized) ? normalized : null;
}

function getSettingsArray(settings, ...keys) {
  for (const key of keys) {
    if (Array.isArray(settings?.[key])) {
      return settings[key];
    }
  }
  return [];
}

function getSettingsValue(settings, ...keys) {
  for (const key of keys) {
    const value = settings?.[key];
    if (value !== undefined && value !== null && `${value}`.trim() !== '') {
      return value;
    }
  }
  return null;
}

function readProjectSettings(workingDir) {
  const settingsPath = path.join(workingDir, '.claude', 'settings.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolvePermissionConfig(projectSettings = {}, options = {}) {
  const allowedTools = uniqueStrings([
    ...getSettingsArray(projectSettings, 'allowed_tools', 'allowedTools'),
    ...uniqueStrings(options.allowed_tools),
  ]);
  const disallowedTools = uniqueStrings([
    ...getSettingsArray(projectSettings, 'disallowed_tools', 'disallowedTools'),
    ...uniqueStrings(options.disallowed_tools),
  ]);

  return {
    settings: {
      allowed_tools: allowedTools,
      disallowed_tools: disallowedTools,
    },
    mode:
      normalizePermissionMode(options.mode)
      || normalizePermissionMode(getSettingsValue(projectSettings, 'permission_mode', 'permissionMode'))
      || DEFAULT_MODE,
  };
}

function readSessionMetaFile(rootDir, sessionId) {
  const metaPath = path.join(rootDir, sessionId, 'meta.json');
  const parsed = safeJsonParse(fs.readFileSync(metaPath, 'utf8'), {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { name: null, metadata: {}, created_at: null };
  }
  return {
    name: parsed.name || null,
    metadata: parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
      ? { ...parsed.metadata }
      : {},
    created_at: parsed.created_at || null,
  };
}

function writeSessionMetaFile(rootDir, sessionId, meta) {
  const metaPath = path.join(rootDir, sessionId, 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  let combined = '';
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.text === 'string') {
      combined += entry.text;
      continue;
    }
    if (entry.type === 'text' && typeof entry.content === 'string') {
      combined += entry.content;
    }
  }
  return combined;
}

function normalizeToolCall(record) {
  if (!record || typeof record !== 'object') return null;

  if ((record.type === 'tool_call' || record.type === EventType.TOOL_CALL) && record.name) {
    return {
      tool_call_id: cleanText(record.tool_call_id) || cleanText(record.id) || `tool_${randomUUID()}`,
      name: cleanText(record.name),
      args: record.args && typeof record.args === 'object' ? record.args : {},
    };
  }

  if ((record.type === 'tool_use' || record.type === 'content_block_start') && record.name) {
    return {
      tool_call_id: cleanText(record.tool_call_id) || cleanText(record.id) || `tool_${randomUUID()}`,
      name: cleanText(record.name),
      args: record.input && typeof record.input === 'object'
        ? record.input
        : (record.args && typeof record.args === 'object' ? record.args : {}),
    };
  }

  const block = record.content_block;
  if (block && block.type === 'tool_use' && block.name) {
    return {
      tool_call_id: cleanText(block.id) || `tool_${randomUUID()}`,
      name: cleanText(block.name),
      args: block.input && typeof block.input === 'object' ? block.input : {},
    };
  }

  return null;
}

function normalizeUsage(record) {
  if (!record || typeof record !== 'object') return null;
  const usage = record.usage && typeof record.usage === 'object' ? record.usage : null;
  if (!usage) return null;

  const promptTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const completionTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || (promptTokens + completionTokens));

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function extractTextDelta(record) {
  if (!record || typeof record !== 'object') return '';

  if (record.type === 'text_delta' && typeof record.delta === 'string') {
    return record.delta;
  }

  if (record.type === 'content_block_delta' && typeof record.delta?.text === 'string') {
    return record.delta.text;
  }

  if (record.delta && typeof record.delta === 'string') {
    return record.delta;
  }

  return '';
}

function extractFallbackText(record) {
  if (!record || typeof record !== 'object') return '';

  if (typeof record.text === 'string') {
    return record.text;
  }

  if (typeof record.output === 'string') {
    return record.output;
  }

  if (typeof record.result === 'string') {
    return record.result;
  }

  if (typeof record.message === 'string') {
    return record.message;
  }

  if (record.message && typeof record.message === 'object') {
    if (typeof record.message.content === 'string') {
      return record.message.content;
    }
    const contentText = extractTextFromContent(record.message.content);
    if (contentText) return contentText;
  }

  const contentText = extractTextFromContent(record.content);
  if (contentText) return contentText;

  return '';
}

function resolveTimeoutMs(options = {}) {
  const timeoutMs = Number(options.timeout_ms || 0);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.max(1000, timeoutMs);
  }
  const timeoutMinutes = Number(options.timeout || 0);
  if (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0) {
    return Math.max(1000, timeoutMinutes * 60 * 1000);
  }
  return DEFAULT_TIMEOUT_MS;
}

function resolveCliPath(baseName, providerConfig) {
  const configuredPath = cleanText(providerConfig?.cli_path);
  if (configuredPath) {
    if (process.platform === 'win32' && !path.extname(configuredPath)) {
      return `${configuredPath}.cmd`;
    }
    return configuredPath;
  }
  return process.platform === 'win32' ? `${baseName}.cmd` : baseName;
}

class ClaudeCodeSdkProvider extends BaseProvider {
  constructor(config = {}) {
    super({
      name: 'claude-code-sdk',
      enabled: config.enabled !== false,
      maxConcurrent: config.maxConcurrent || 3,
    });

    this.providerId = 'claude-code-sdk';
    this.cliBinary = config.cliBinary || null;
    this.defaultModel = cleanText(config.defaultModel) || DEFAULT_MODEL;
    this.sessionsRoot = config.sessionsRoot || path.join(getDataDir(), 'claude-code-sessions');
    this.sessionStore = createSessionStore({ rootDir: this.sessionsRoot });
    this.activeSessionId = null;
    this.explicitSessionSelection = false;
  }

  get supportsStreaming() {
    return true;
  }

  getProviderConfig() {
    try {
      return providerRoutingCore.getProvider(this.providerId)
        || providerRoutingCore.getProvider('claude-cli')
        || {};
    } catch {
      return {};
    }
  }

  resolveSkill(workingDir, skillName) {
    const normalizedSkillName = cleanText(skillName);
    if (!normalizedSkillName) return null;

    const skills = loadSkills(workingDir);
    const resolved = skills.find((skill) => {
      const directName = cleanText(skill.name);
      if (directName === normalizedSkillName) return true;
      const folderName = path.basename(path.dirname(skill.path));
      return folderName === normalizedSkillName;
    });

    if (!resolved) {
      throw new Error(`Unknown Claude skill: ${normalizedSkillName}`);
    }

    return resolved;
  }

  readSessionMeta(sessionId) {
    return readSessionMetaFile(this.sessionsRoot, sessionId);
  }

  writeSessionMeta(sessionId, meta) {
    writeSessionMetaFile(this.sessionsRoot, sessionId, meta);
    return meta;
  }

  ensureSession({
    sessionId = null,
    workingDirectory = process.cwd(),
    preferActiveSession = false,
  } = {}) {
    let localSessionId = cleanText(sessionId);
    if (
      !localSessionId
      && preferActiveSession
      && this.activeSessionId
      && this.sessionStore.exists(this.activeSessionId)
    ) {
      localSessionId = this.activeSessionId;
    }

    if (!localSessionId) {
      localSessionId = this.sessionStore.create({
        name: 'claude-subagent',
        metadata: {
          claude_session_id: randomUUID(),
          working_directory: workingDirectory,
        },
      });
    }

    if (!this.sessionStore.exists(localSessionId)) {
      throw new Error(`Unknown Claude session: ${localSessionId}`);
    }

    const meta = this.readSessionMeta(localSessionId);
    const metadata = meta.metadata && typeof meta.metadata === 'object'
      ? { ...meta.metadata }
      : {};

    if (!cleanText(metadata.claude_session_id)) {
      metadata.claude_session_id = randomUUID();
    }
    if (!cleanText(metadata.working_directory)) {
      metadata.working_directory = workingDirectory;
    }

    this.writeSessionMeta(localSessionId, {
      ...meta,
      metadata,
    });

    this.activeSessionId = localSessionId;

    return {
      session_id: localSessionId,
      meta: this.readSessionMeta(localSessionId),
    };
  }

  getSessionSummary(sessionId) {
    const meta = this.readSessionMeta(sessionId);
    const messages = this.sessionStore.readAll(sessionId);
    return {
      session_id: sessionId,
      active: sessionId === this.activeSessionId,
      name: meta.name || null,
      created_at: meta.created_at || null,
      message_count: messages.length,
      metadata: meta.metadata || {},
    };
  }

  listSessions() {
    return this.sessionStore.list()
      .map((entry) => this.getSessionSummary(entry.session_id))
      .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')));
  }

  resumeSession(sessionId) {
    const normalizedSessionId = cleanText(sessionId);
    if (!normalizedSessionId || !this.sessionStore.exists(normalizedSessionId)) {
      throw new Error(`Unknown Claude session: ${sessionId}`);
    }
    this.activeSessionId = normalizedSessionId;
    this.explicitSessionSelection = true;
    return this.getSessionSummary(normalizedSessionId);
  }

  forkSession(sourceSessionId, { name = null } = {}) {
    const normalizedSourceId = cleanText(sourceSessionId);
    if (!normalizedSourceId || !this.sessionStore.exists(normalizedSourceId)) {
      throw new Error(`Unknown Claude session: ${sourceSessionId}`);
    }

    const sourceMeta = this.readSessionMeta(normalizedSourceId);
    const forkId = this.sessionStore.fork(normalizedSourceId, {
      name: cleanText(name) || `fork-of-${normalizedSourceId}`,
    });
    const forkMeta = this.readSessionMeta(forkId);
    const metadata = {
      ...(forkMeta.metadata || {}),
      claude_session_id: randomUUID(),
      working_directory: sourceMeta.metadata?.working_directory || process.cwd(),
      fork_from_claude_session_id: sourceMeta.metadata?.claude_session_id || null,
    };
    this.writeSessionMeta(forkId, {
      ...forkMeta,
      metadata,
    });
    this.activeSessionId = forkId;
    this.explicitSessionSelection = true;
    return {
      source_session_id: normalizedSourceId,
      ...this.getSessionSummary(forkId),
    };
  }

  buildCommandArgs({
    model,
    workingDirectory,
    permissionMode,
    allowedTools,
    disallowedTools,
    skillPrompt,
    localSessionId,
    sessionMeta,
  }) {
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--strict-mcp-config',
    ];

    const selectedModel = cleanText(model) || cleanText(sessionMeta.metadata?.default_model) || this.defaultModel;
    if (selectedModel) {
      args.push('--model', selectedModel);
    }

    if (cleanText(permissionMode)) {
      args.push('--permission-mode', permissionMode);
    }

    if (allowedTools.length > 0) {
      args.push('--allowed-tools', allowedTools.join(','));
    }

    if (disallowedTools.length > 0) {
      args.push('--disallowed-tools', disallowedTools.join(','));
    }

    if (cleanText(skillPrompt)) {
      args.push('--append-system-prompt', skillPrompt);
    }

    if (cleanText(workingDirectory)) {
      args.push('--add-dir', workingDirectory);
    }

    const claudeSessionId = cleanText(sessionMeta.metadata?.claude_session_id);
    const forkFromClaudeSessionId = cleanText(sessionMeta.metadata?.fork_from_claude_session_id);
    const messageCount = this.sessionStore.readAll(localSessionId).length;
    if (forkFromClaudeSessionId) {
      args.push('--resume', forkFromClaudeSessionId, '--fork-session', '--session-id', claudeSessionId);
    } else if (messageCount > 0) {
      args.push('--resume', claudeSessionId);
    } else {
      args.push('--session-id', claudeSessionId);
    }

    if (cleanText(sessionMeta.name)) {
      args.push('--name', sessionMeta.name);
    }

    args.push('-p');
    return args;
  }

  async runPrompt(prompt, model, options = {}) {
    const workingDirectory = cleanText(options.working_directory) || process.cwd();
    const projectSettings = readProjectSettings(workingDirectory);
    const { settings, mode } = resolvePermissionConfig(projectSettings, options);
    const sessionInfo = this.ensureSession({
      sessionId: options.session_id,
      workingDirectory,
      preferActiveSession: options.prefer_active_session === true,
    });
    const localSessionId = sessionInfo.session_id;
    const sessionMeta = this.readSessionMeta(localSessionId);
    const skill = this.resolveSkill(workingDirectory, options.skill);
    const promptText = cleanText(prompt);

    if (!promptText) {
      throw new Error('prompt must be a non-empty string');
    }

    const skillPrompt = skill
      ? [
        `Use the project skill "${skill.name}".`,
        cleanText(skill.description),
        cleanText(skill.body),
      ].filter(Boolean).join('\n\n')
      : '';

    const providerConfig = this.getProviderConfig();
    const cliPath = this.cliBinary || resolveCliPath('claude', providerConfig);
    const timeoutMs = resolveTimeoutMs(options);
    const useShell = process.platform === 'win32' && /\.cmd$/i.test(cliPath);
    const commandArgs = this.buildCommandArgs({
      model,
      workingDirectory,
      permissionMode: mode,
      allowedTools: settings.allowed_tools,
      disallowedTools: settings.disallowed_tools,
      skillPrompt,
      localSessionId,
      sessionMeta,
    });

    const userMessage = {
      role: 'user',
      content: cleanText(prompt),
      timestamp: new Date().toISOString(),
    };
    this.sessionStore.append(localSessionId, userMessage);

    const startTime = Date.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(cliPath, commandArgs, {
        cwd: workingDirectory,
        env: buildSafeEnv(this.providerId, {
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          TERM: 'dumb',
          CI: '1',
          CLAUDE_NON_INTERACTIVE: '1',
          PYTHONIOENCODING: 'utf-8',
        }),
        shell: useShell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stderrChunks = [];
      const fallbackTexts = [];
      let stdoutRemainder = '';
      let aggregatedText = '';
      let sawTextDelta = false;
      let settled = false;
      let streamError = null;
      let permissionDeniedError = null;
      let usage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
      let processing = Promise.resolve();
      let timeoutHandle = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        fn(value);
      };

      const onRecord = async (record) => {
        const usagePatch = normalizeUsage(record);
        if (usagePatch) {
          usage = {
            ...usage,
            ...usagePatch,
          };
          if (typeof options.onEvent === 'function') {
            await options.onEvent({ type: EventType.USAGE, ...usagePatch });
          }
        }

        const toolCall = normalizeToolCall(record);
        if (toolCall) {
          const permission = await evaluatePermission({
            toolName: toolCall.name,
            args: toolCall.args,
            settings,
            mode,
            hooks: Array.isArray(options.hooks) ? options.hooks : [],
            canUseTool: typeof options.canUseTool === 'function' ? options.canUseTool : null,
          });

          if (typeof options.onEvent === 'function') {
            await options.onEvent({
              type: EventType.TOOL_CALL,
              tool_call_id: toolCall.tool_call_id,
              name: toolCall.name,
              args: toolCall.args,
              permission,
            });
          }

          if (permission.decision !== 'allow') {
            permissionDeniedError = new Error(
              `Claude tool "${toolCall.name}" denied by ${permission.source}: ${permission.reason}`,
            );
            child.kill();
            return;
          }
        }

        const textDelta = extractTextDelta(record);
        if (textDelta) {
          sawTextDelta = true;
          aggregatedText += textDelta;
          if (typeof options.onChunk === 'function') {
            await options.onChunk(textDelta);
          }
          if (typeof options.onEvent === 'function') {
            await options.onEvent({ type: EventType.TEXT_DELTA, delta: textDelta });
          }
          return;
        }

        const fallbackText = extractFallbackText(record);
        if (fallbackText) {
          fallbackTexts.push(fallbackText);
        }
      };

      const queueRecord = async (recordText) => {
        const trimmed = cleanText(recordText);
        if (!trimmed) return;
        if (trimmed === '[DONE]') return;
        const normalizedRecord = trimmed.startsWith('data:') ? cleanText(trimmed.slice(5)) : trimmed;
        if (!normalizedRecord || normalizedRecord === '[DONE]') return;

        const parsed = safeJsonParse(normalizedRecord, null);
        if (parsed) {
          await onRecord(parsed);
          return;
        }

        if (!sawTextDelta) {
          fallbackTexts.push(trimmed);
        }
      };

      child.stdout?.on('data', (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        processing = processing.then(async () => {
          stdoutRemainder += text;
          const lines = stdoutRemainder.split(/\r?\n/);
          stdoutRemainder = lines.pop() || '';
          for (const line of lines) {
            await queueRecord(line);
            if (permissionDeniedError) return;
          }
        }).catch((error) => {
          streamError = error;
          child.kill();
        });
      });

      child.stderr?.on('data', (chunk) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      });

      child.once('error', (error) => {
        finish(reject, error);
      });

      child.once('close', (code, signal) => {
        processing = processing.then(async () => {
          if (stdoutRemainder) {
            await queueRecord(stdoutRemainder);
            stdoutRemainder = '';
          }

          if (streamError) {
            finish(reject, streamError);
            return;
          }

          if (permissionDeniedError) {
            finish(reject, permissionDeniedError);
            return;
          }

          const stderrText = cleanText(stderrChunks.join(''));
          if (code !== 0) {
            const failureText = stderrText || cleanText(aggregatedText) || cleanText(fallbackTexts.join('\n'));
            const signalSuffix = signal ? ` (${signal})` : '';
            finish(reject, new Error(`claude-code-sdk exited with status ${code}${signalSuffix}: ${failureText || 'unknown error'}`));
            return;
          }

          const output = cleanText(aggregatedText) || cleanText(fallbackTexts.join('\n'));
          finish(resolve, {
            output,
            usage,
            stderr: stderrText,
          });
        }).catch((error) => finish(reject, error));
      });

      timeoutHandle = setTimeout(() => {
        child.kill();
        finish(reject, new Error(`claude-code-sdk timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdin?.end(promptText, 'utf8');
    });

    const assistantMessage = {
      role: 'assistant',
      content: result.output,
      timestamp: new Date().toISOString(),
    };
    this.sessionStore.append(localSessionId, assistantMessage);

    const updatedMeta = this.readSessionMeta(localSessionId);
    if (cleanText(updatedMeta.metadata?.fork_from_claude_session_id)) {
      this.writeSessionMeta(localSessionId, {
        ...updatedMeta,
        metadata: {
          ...updatedMeta.metadata,
          fork_from_claude_session_id: null,
        },
      });
    }

    const durationMs = Date.now() - startTime;
    return {
      output: result.output,
      status: 'completed',
      session_id: localSessionId,
      claude_session_id: sessionMeta.metadata?.claude_session_id || null,
      usage: {
        input_tokens: result.usage.prompt_tokens || 0,
        output_tokens: result.usage.completion_tokens || 0,
        total_tokens: result.usage.total_tokens || 0,
        tokens: result.usage.total_tokens || 0,
        cost: 0,
        duration_ms: durationMs,
        model: cleanText(model) || this.defaultModel,
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
    if (!prompt) {
      throw new Error('prompt must be a non-empty string');
    }

    const response = await this.submit(prompt, options.model || null, {
      ...options,
      prefer_active_session: this.explicitSessionSelection === true,
    });
    return {
      session_id: response.session_id,
      claude_session_id: response.claude_session_id,
      output: response.output,
      usage: response.usage,
      mode: normalizePermissionMode(options.mode) || DEFAULT_MODE,
      skill: cleanText(options.skill) || null,
    };
  }

  async checkHealth() {
    const providerConfig = this.getProviderConfig();
    const cliPath = this.cliBinary || resolveCliPath('claude', providerConfig);
    const result = spawnSync(cliPath, ['--version'], {
      timeout: DEFAULT_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
    });

    if (result.status !== 0) {
      return {
        available: false,
        models: [],
        error: cleanText(result.stderr) || cleanText(result.stdout) || 'claude command unavailable',
      };
    }

    return {
      available: true,
      models: [...DEFAULT_MODELS],
      version: cleanText(result.stdout) || cleanText(result.stderr) || null,
    };
  }

  async listModels() {
    return [...DEFAULT_MODELS];
  }
}

module.exports = ClaudeCodeSdkProvider;
