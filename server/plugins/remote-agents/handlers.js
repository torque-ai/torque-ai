'use strict';

const { ErrorCodes, makeError } = require('../../handlers/error-codes');
const { createRemoteTestRouter } = require('./remote-test-routing');

function _getActivityRunner() {
  try {
    const { defaultContainer } = require('../../container');
    return defaultContainer.get('activityRunner');
  } catch {
    return null;
  }
}

function _getExecutionContext(args = {}) {
  return {
    taskId: typeof args.__taskId === 'string' && args.__taskId.trim()
      ? args.__taskId.trim()
      : null,
    workflowId: typeof args.__workflowId === 'string' && args.__workflowId.trim()
      ? args.__workflowId.trim()
      : null,
  };
}

function _hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function _coerceBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }

  return Boolean(value);
}

function _resolveTlsSettings(args, existingAgent) {
  return {
    tls: _hasOwn(args, 'tls')
      ? _coerceBoolean(args.tls, true)
      : _coerceBoolean(existingAgent && existingAgent.tls, true),
    rejectUnauthorized: _hasOwn(args, 'rejectUnauthorized')
      ? _coerceBoolean(args.rejectUnauthorized, true)
      : _coerceBoolean(existingAgent && existingAgent.rejectUnauthorized, true),
  };
}

function _formatAgentEndpoint(agent) {
  const protocol = _coerceBoolean(agent && agent.tls, true) ? 'https' : 'http';
  return `${protocol}://${agent.host}:${agent.port}`;
}

function _formatAgentTls(agent) {
  const tls = _coerceBoolean(agent && agent.tls, true);
  const rejectUnauthorized = _coerceBoolean(agent && agent.rejectUnauthorized, true);
  return `tls: ${tls ? 'enabled' : 'disabled'} (rejectUnauthorized: ${rejectUnauthorized})`;
}

function _formatAgentSummary(agent) {
  const status = agent.status || 'unknown';
  const enabled = agent.enabled ? 'enabled' : 'disabled';
  const lastCheck = agent.last_health_check || 'never';
  const osPlatform = agent.os_platform ? ` — os: ${agent.os_platform}` : '';
  return `${agent.name} (${agent.id}) — ${_formatAgentEndpoint(agent)} — ${_formatAgentTls(agent)} — ${status} — ${enabled}${osPlatform} — last check: ${lastCheck}`;
}

function _createCoreError(errorCode, error, details = null) {
  return {
    error_code: typeof errorCode === 'string' ? errorCode : errorCode?.code || ErrorCodes.INTERNAL_ERROR.code,
    error,
    ...(details ? { details } : {}),
  };
}

function _isCoreError(result) {
  return Boolean(result && typeof result.error_code === 'string');
}

function _normalizeTimeoutMs(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function _createToolError(errorCode, message) {
  return {
    content: [{
      type: 'text',
      text: `Error: ${message}`,
    }],
    isError: true,
    error_code: typeof errorCode === 'string' ? errorCode : errorCode?.code || ErrorCodes.INTERNAL_ERROR.code,
  };
}

function _toPlainText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (Buffer.isBuffer(entry)) return entry.toString('utf8');
        if (entry && typeof entry === 'object' && typeof entry.data === 'string') {
          return entry.data;
        }
        return '';
      })
      .join('');
  }

  return '';
}

function _mergeExecutionText(output, error) {
  const stdout = _toPlainText(output);
  const stderr = _toPlainText(error);

  if (!stdout) return stderr;
  if (!stderr) return stdout;
  return stdout.endsWith('\n') ? `${stdout}${stderr}` : `${stdout}\n${stderr}`;
}

function _buildPrefixedToolResult(prefix, result, extra = {}) {
  const exitCode = Number.isFinite(result?.exitCode)
    ? result.exitCode
    : (Number.isFinite(result?.exit_code) ? result.exit_code : (result?.success === false ? 1 : 0));
  const durationMs = Number.isFinite(result?.durationMs)
    ? result.durationMs
    : (Number.isFinite(result?.duration_ms) ? result.duration_ms : undefined);
  const output = _toPlainText(result?.output);
  const error = _toPlainText(result?.error);
  const combined = _mergeExecutionText(output, error);

  return {
    success: exitCode === 0,
    output,
    error,
    exitCode,
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
    remote: Boolean(result?.remote),
    ...extra,
    content: [{
      type: 'text',
      text: combined
        ? `${prefix} Exit code: ${exitCode}\n\n${combined}`
        : `${prefix} Exit code: ${exitCode}`,
    }],
  };
}

function _isHttpResponseLike(value) {
  return Boolean(value)
    && typeof value.writeHead === 'function'
    && typeof value.end === 'function';
}

function _isHttpInvocation(req, res) {
  return Boolean(req)
    && typeof req === 'object'
    && typeof req.method === 'string'
    && _isHttpResponseLike(res);
}

function _getRemoteExecutionErrorStatus(result) {
  switch (result?.error_code) {
    case ErrorCodes.MISSING_REQUIRED_PARAM.code:
    case ErrorCodes.INVALID_PARAM.code:
      return 400;
    default:
      return 500;
  }
}

function _serializeRemoteExecutionResult(result) {
  return {
    success: Boolean(result?.success),
    output: typeof result?.output === 'string' ? result.output : '',
    exitCode: Number.isFinite(result?.exitCode) ? result.exitCode : 0,
    durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : 0,
    remote: Boolean(result?.remote),
    warning: typeof result?.warning === 'string' && result.warning.trim()
      ? result.warning
      : null,
  };
}

async function _handleRemoteExecutionHttpRequest(req, res, coreHandler) {
  const { parseBody, sendJson } = require('../../api/middleware');
  const body = Object.prototype.hasOwnProperty.call(req, 'body')
    ? req.body
    : await parseBody(req);
  const result = await coreHandler(body || {});

  if (_isCoreError(result)) {
    sendJson(res, {
      error: result.error,
      errorCode: result.error_code,
    }, _getRemoteExecutionErrorStatus(result), req);
    return;
  }

  sendJson(res, _serializeRemoteExecutionResult(result), 200, req);
}

function _findHealthyAgent(registry) {
  if (!registry) {
    return null;
  }

  if (typeof registry.getAvailable === 'function') {
    const available = registry.getAvailable();
    if (Array.isArray(available) && available.length > 0) {
      return available[0];
    }
  }

  if (typeof registry.getAll !== 'function') {
    return null;
  }

  const agents = registry.getAll();
  if (!Array.isArray(agents)) {
    return null;
  }

  return agents.find((agent) => {
    if (!agent) return false;
    if (agent.enabled === false || agent.enabled === 0) return false;
    const status = typeof agent.status === 'string' ? agent.status.toLowerCase() : '';
    return status === 'healthy' || status === 'ok';
  }) || null;
}

function _buildShellInvocation(commandString) {
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', commandString],
    };
  }

  return {
    command: '/bin/sh',
    args: ['-lc', commandString],
  };
}

function _runLocalCommand(commandString, workingDirectory, timeout) {
  const { execSync } = require('child_process');
  const startedAt = Date.now();

  try {
    const output = execSync(commandString, {
      cwd: workingDirectory,
      timeout,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });

    return {
      success: true,
      output,
      error: '',
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      remote: false,
    };
  } catch (error) {
    return {
      success: false,
      output: _toPlainText(error?.stdout),
      error: _toPlainText(error?.stderr),
      exitCode: Number.isFinite(error?.status) ? error.status : 1,
      durationMs: Date.now() - startedAt,
      remote: false,
    };
  }
}

function _resolveProjectConfigCore(db) {
  if (db && typeof db.getProjectFromPath === 'function' && typeof db.getProjectConfig === 'function') {
    return db;
  }

  return require('../../db/project-config-core');
}

function createHandlers({ agentRegistry, db } = {}) {
  const projectConfigCore = _resolveProjectConfigCore(db);

  function _getRemoteRouter() {
    const logger = require('../../logger').child({ component: 'remote-agent-handlers' });

    return createRemoteTestRouter({
      agentRegistry,
      db: projectConfigCore,
      logger,
    });
  }

  function _parseCommandString(commandString) {
    const { parseCommand } = require('../../validation/post-task');
    return parseCommand(commandString);
  }

  function handleRegisterRemoteAgent(args = {}) {
    const { name, host, port = 3460, secret, max_concurrent = 3 } = args;

    if (!name || !host || !secret) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Required: name, host, secret');
    }

    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');

    if (!agentRegistry) {
      return makeError(ErrorCodes.OPERATION_FAILED, 'Agent registry not initialized');
    }

    const existingAgent = typeof agentRegistry.get === 'function' ? agentRegistry.get(id) : null;
    const { tls, rejectUnauthorized } = _resolveTlsSettings(args, existingAgent);

    agentRegistry.register({ id, name, host, port, secret, max_concurrent, tls, rejectUnauthorized });

    return {
      content: [{
        type: 'text',
        text: `Registered agent "${name}" at ${_formatAgentEndpoint({ host, port, tls })} (id: ${id}, ${_formatAgentTls({ tls, rejectUnauthorized })})`,
      }],
    };
  }

  function handleListRemoteAgents() {
    if (!agentRegistry) {
      return makeError(ErrorCodes.OPERATION_FAILED, 'Agent registry not initialized');
    }

    const agents = agentRegistry.getAll();
    if (agents.length === 0) {
      return { content: [{ type: 'text', text: 'No remote agents registered' }] };
    }

    const lines = agents.map(_formatAgentSummary);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  function handleRemoveRemoteAgent(args = {}) {
    const { agent_id } = args;

    if (!agent_id) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Required: agent_id');
    }

    if (!agentRegistry) {
      return makeError(ErrorCodes.OPERATION_FAILED, 'Agent registry not initialized');
    }

    const existing = agentRegistry.get(agent_id);
    if (!existing) {
      return makeError(ErrorCodes.AGENT_NOT_FOUND, `Agent not found: ${agent_id}`);
    }

    agentRegistry.remove(agent_id);
    return { content: [{ type: 'text', text: `Removed agent ${agent_id}` }] };
  }

  async function handleCheckRemoteAgentHealth(args = {}) {
    try {
      const { agent_id } = args;

      if (!agentRegistry) {
        return makeError(ErrorCodes.OPERATION_FAILED, 'Agent registry not initialized');
      }

      if (agent_id) {
        const client = agentRegistry.getClient(agent_id);
        if (!client) {
          return makeError(ErrorCodes.AGENT_NOT_FOUND, `Agent not found or disabled: ${agent_id}`);
        }

        const result = await client.checkHealth();
        const agent = agentRegistry.get(agent_id);

        if (result) {
          const mem = result.system && result.system.memory_available_mb
            ? `${result.system.memory_available_mb}MB free`
            : 'N/A';
          const platform = result.system && result.system.platform ? `, os: ${result.system.platform}` : '';
          return {
            content: [{
              type: 'text',
              text: `${agent.name}: healthy (running: ${result.running_tasks}/${result.max_concurrent}, mem: ${mem}${platform})`,
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `${agent.name}: ${agent.status} (${agent.consecutive_failures} consecutive failures)`,
          }],
        };
      }

      const results = await agentRegistry.runHealthChecks();
      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No agents to check' }] };
      }

      const lines = results.map((result) =>
        `${result.id}: ${result.status}${result.failures ? ` (${result.failures} failures)` : ''}`
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
    }
  }

  function handleGetRemoteAgent(args = {}) {
    const { agent_id } = args;

    if (!agent_id) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Required: agent_id');
    }

    if (!agentRegistry) {
      return makeError(ErrorCodes.OPERATION_FAILED, 'Agent registry not initialized');
    }

    const agent = agentRegistry.get(agent_id);
    if (!agent) {
      return makeError(ErrorCodes.AGENT_NOT_FOUND, `Agent not found: ${agent_id}`);
    }

    return {
      content: [{
        type: 'text',
        text: _formatAgentSummary(agent),
      }],
    };
  }

  async function runRemoteCommandCore(args = {}) {
    try {
      const commandString = typeof args.command === 'string' ? args.command.trim() : '';
      const workingDirectory = typeof args.working_directory === 'string'
        ? args.working_directory.trim()
        : '';
      const timeout = _normalizeTimeoutMs(args.timeout, 300000);

      if (!commandString) {
        return _createCoreError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Required: command');
      }

      if (!workingDirectory) {
        return _createCoreError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Required: working_directory');
      }

      const parsed = _parseCommandString(commandString);
      if (!parsed.executable) {
        return _createCoreError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Required: command');
      }

      const router = _getRemoteRouter();
      const result = await router.runRemoteOrLocal(
        parsed.executable,
        parsed.args,
        workingDirectory,
        { timeout },
      );

      return {
        ...result,
        command: commandString,
        parsed_command: parsed.executable,
        parsed_args: parsed.args,
        working_directory: workingDirectory,
        ...(result.remote ? {} : {
          warning: 'Remote agent unavailable or not configured; command ran locally.',
        }),
      };
    } catch (err) {
      return _createCoreError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
    }
  }

  async function handleRunRemoteCommand(args = {}) {
    try {
      if (_isHttpInvocation(args, arguments[1])) {
        return _handleRemoteExecutionHttpRequest(args, arguments[1], runRemoteCommandCore);
      }

      const commandString = typeof args.command === 'string' ? args.command.trim() : '';
      const workingDirectory = typeof args.working_directory === 'string'
        ? args.working_directory.trim()
        : '';
      const timeout = _normalizeTimeoutMs(args.timeout, 300000);

      if (!commandString || !workingDirectory) {
        return _createToolError(ErrorCodes.MISSING_REQUIRED_PARAM, 'command and working_directory are required');
      }

      const healthyAgent = _findHealthyAgent(agentRegistry);
      const client = healthyAgent && typeof agentRegistry?.getClient === 'function'
        ? agentRegistry.getClient(healthyAgent.id)
        : null;
      const executeRemoteShell = async () => {
        if (!healthyAgent || !client || typeof client.run !== 'function') {
          return {
            result: _runLocalCommand(commandString, workingDirectory, timeout),
            agent: null,
          };
        }

        const invocation = _buildShellInvocation(commandString);
        const result = await client.run(invocation.command, invocation.args, {
          cwd: workingDirectory,
          timeout,
        });

        return {
          result: { ...result, remote: true },
          agent: {
            id: healthyAgent.id,
            name: healthyAgent.name || healthyAgent.id,
          },
        };
      };
      const { taskId, workflowId } = _getExecutionContext(args);
      const activityRunner = (taskId || workflowId) ? _getActivityRunner() : null;
      const activityName = healthyAgent && client && typeof client.run === 'function'
        ? (healthyAgent.name || healthyAgent.id)
        : 'local-fallback';
      const execution = activityRunner && typeof activityRunner.runActivity === 'function'
        ? await activityRunner.runActivity({
          workflowId,
          taskId,
          kind: 'remote_shell',
          name: activityName,
          input: {
            command: commandString,
            working_directory: workingDirectory,
            timeout,
          },
          fn: executeRemoteShell,
          options: {
            max_attempts: 2,
            retry_policy: {
              initial_ms: 500,
              max_ms: 5000,
            },
            start_to_close_timeout_ms: timeout,
          },
        })
        : { ok: true, value: await executeRemoteShell() };

      if (!execution.ok) {
        return {
          content: [{
            type: 'text',
            text: `Remote execution failed: ${execution.error}. Use local execution as fallback.`,
          }],
          isError: true,
          error_code: ErrorCodes.OPERATION_FAILED.code,
        };
      }

      const executionResult = execution.value?.result || execution.value || {};
      const executionAgent = execution.value?.agent || null;

      if (!executionAgent) {
        return _buildPrefixedToolResult('[local fallback]', executionResult, {
          command: commandString,
          working_directory: workingDirectory,
          warning: 'Remote agent unavailable; command ran locally.',
        });
      }

      return _buildPrefixedToolResult(`[remote: ${executionAgent.name}]`, executionResult, {
        command: commandString,
        working_directory: workingDirectory,
        agent_id: executionAgent.id,
        agent_name: executionAgent.name,
      });
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `Remote execution failed: ${err.message}. Use local execution as fallback.`,
        }],
        isError: true,
        error_code: ErrorCodes.OPERATION_FAILED.code,
      };
    }
  }

  async function runTestsCore(args = {}) {
    try {
      const workingDirectory = typeof args.working_directory === 'string'
        ? args.working_directory.trim()
        : '';

      if (!workingDirectory) {
        return _createCoreError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Required: working_directory');
      }

      const project = typeof projectConfigCore.getProjectFromPath === 'function'
        ? projectConfigCore.getProjectFromPath(workingDirectory)
        : null;
      const config = project && typeof projectConfigCore.getProjectConfig === 'function'
        ? projectConfigCore.getProjectConfig(project)
        : null;
      const verifyCommand = typeof config?.verify_command === 'string'
        ? config.verify_command.trim()
        : '';

      if (!verifyCommand) {
        return _createCoreError(ErrorCodes.INVALID_PARAM, `No verify_command configured for ${workingDirectory}`);
      }

      const router = _getRemoteRouter();
      const result = await router.runVerifyCommand(verifyCommand, workingDirectory);

      return {
        ...result,
        verify_command: verifyCommand,
        working_directory: workingDirectory,
        ...(project ? { project } : {}),
        ...(result.remote ? {} : {
          warning: 'Remote agent unavailable or not configured; tests ran locally.',
        }),
      };
    } catch (err) {
      return _createCoreError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
    }
  }

  async function handleRunTests(args = {}) {
    try {
      if (_isHttpInvocation(args, arguments[1])) {
        return _handleRemoteExecutionHttpRequest(args, arguments[1], runTestsCore);
      }

      const workingDirectory = typeof args.working_directory === 'string'
        ? args.working_directory.trim()
        : '';

      if (!workingDirectory) {
        return _createToolError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
      }

      const project = typeof projectConfigCore.getProjectFromPath === 'function'
        ? projectConfigCore.getProjectFromPath(workingDirectory)
        : null;
      const config = project && typeof projectConfigCore.getProjectConfig === 'function'
        ? projectConfigCore.getProjectConfig(project.id || project)
        : {};
      const verifyCommand = typeof config?.verify_command === 'string'
        ? config.verify_command.trim()
        : '';

      if (!verifyCommand) {
        return _createToolError(ErrorCodes.INVALID_PARAM, 'No verify_command configured. Set it with set_project_defaults.');
      }

      return handleRunRemoteCommand({
        command: verifyCommand,
        working_directory: workingDirectory,
        timeout: 600000,
      });
    } catch (err) {
      return _createToolError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
    }
  }

  return {
    register_remote_agent: handleRegisterRemoteAgent,
    list_remote_agents: handleListRemoteAgents,
    get_remote_agent: handleGetRemoteAgent,
    remove_remote_agent: handleRemoveRemoteAgent,
    check_remote_agent_health: handleCheckRemoteAgentHealth,
    run_remote_command: handleRunRemoteCommand,
    run_tests: handleRunTests,
  };
}

module.exports = { createHandlers };
