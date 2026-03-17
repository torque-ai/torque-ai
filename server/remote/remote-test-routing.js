'use strict';

const { spawnSync } = require('child_process');

const SENSITIVE_ENV_PATTERNS = [
  /^(TORQUE_AGENT_SECRET|API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/i,
  /^(AWS_|AZURE_|GCP_|GOOGLE_)/i,
  /^(DEEPINFRA_API_KEY|HYPERBOLIC_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)$/i,
  /^(GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|NUGET_API_KEY)$/i,
  /^(DATABASE_URL|DB_PASSWORD|REDIS_URL)$/i,
  /^(SMTP_PASSWORD|MAIL_PASSWORD)$/i,
  /^(TORQUE_AGENT_SECRET_KEY)$/i,
];

function filterSensitiveEnv(env) {
  if (!env) return undefined;
  const filtered = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SENSITIVE_ENV_PATTERNS.some(p => p.test(key))) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function isRemoteAuthError(error) {
  const message = String(error?.message || '');
  return /\b401\b/.test(message)
    || /\b403\b/.test(message)
    || /unauthorized|forbidden|command not allowed/i.test(message);
}

function isRemoteExecutionTimeout(error) {
  const message = String(error?.message || '');
  return /streaming request to \/run timed out/i.test(message);
}

function toRemoteFailureResult(error, startedAt) {
  return {
    success: false,
    output: '',
    error: String(error?.message || error || 'Remote execution failed'),
    exitCode: 1,
    durationMs: Math.max(0, Date.now() - startedAt),
    remote: true,
  };
}

/**
 * Creates a remote test router that can run commands either on a remote agent or locally.
 *
 * The router checks project_config for a configured remote_agent_id and
 * prefer_remote_tests flag.  When a remote agent is available, commands are
 * executed on it (after a git sync).  On any remote failure the router falls
 * back transparently to local spawnSync execution.
 *
 * @param {object} options
 * @param {object} options.agentRegistry - RemoteAgentRegistry instance
 * @param {object} options.db - Database module (needs getProjectFromPath, getProjectConfig)
 * @param {object} options.logger - Logger with .info() and .warn()
 * @returns {{ runRemoteOrLocal, runVerifyCommand, getRemoteConfig, getCurrentBranch }}
 */
function createRemoteTestRouter({ agentRegistry, db, logger }) {

  function getSyncProjectName(cwd, remotePath) {
    let projectName;
    try {
      const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      projectName = toplevel.stdout ? toplevel.stdout.trim().split('/').pop().split('\\').pop() : null;
    } catch {
      projectName = null;
    }

    if (!projectName) {
      projectName = remotePath
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .pop();
    }

    return projectName;
  }

  /**
   * Get remote config for a project by its working directory.
   * Returns null if remote tests are not configured or not enabled.
   *
   * Uses the database module's high-level getProjectFromPath / getProjectConfig
   * API instead of raw SQL so it stays consistent with the rest of the server.
   *
   * @param {string} workingDir - Absolute path to the project directory
   * @returns {{ agentId: string, remotePath: string } | null}
   */
  function getRemoteConfig(workingDir) {
    try {
      if (!db || !workingDir) return null;

      // Resolve project name from working directory
      const project = typeof db.getProjectFromPath === 'function'
        ? db.getProjectFromPath(workingDir)
        : null;
      if (!project) return null;

      // Fetch full project config row
      const config = typeof db.getProjectConfig === 'function'
        ? db.getProjectConfig(project)
        : null;
      if (!config) return null;

      // Must have remote agent id AND prefer_remote_tests enabled
      if (!config.prefer_remote_tests || !config.remote_agent_id) return null;

      // Phase 3: Try workstation lookup for remote agent
      try {
        const wsModel = require('../workstation/model');
        const ws = wsModel.getWorkstationByName(config.remote_agent_id)
          || wsModel.getWorkstation(config.remote_agent_id);
        if (
          ws
          && ws._capabilities
          && (
            ws._capabilities.command_exec === true
            || (ws._capabilities.command_exec && ws._capabilities.command_exec.detected)
          )
        ) {
          // Found a workstation with command_exec capability matching the remote_agent_id.
          // The existing agent-client code will handle the actual execution.
        }
      } catch {
        /* fall through to legacy agent lookup */
      }

      return {
        agentId: config.remote_agent_id,
        remotePath: config.remote_project_path || workingDir,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the current git branch for a working directory.
   * Falls back to 'main' on any error.
   *
   * @param {string} cwd
   * @returns {string}
   */
  function getCurrentBranch(cwd) {
    try {
      const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      return result.stdout ? result.stdout.trim() : 'main';
    } catch {
      return 'main';
    }
  }

  /**
   * Run a command remotely if a remote agent is available, otherwise locally.
   *
   * Flow:
   * 1. Check project config for remote agent preference
   * 2. If remote agent configured and available → sync + run remotely
   * 3. On any remote failure → fall back to local spawnSync
   *
   * @param {string} command - Executable name (e.g. 'npx')
   * @param {string[]} args - Command arguments
   * @param {string} cwd - Working directory
   * @param {object} [options]
   * @param {string} [options.branch] - Override git branch for sync
   * @param {number} [options.timeout=120000] - Execution timeout in ms
   * @returns {Promise<{success: boolean, output: string, error: string, exitCode: number, durationMs: number, remote: boolean}>}
   */
  async function runRemoteOrLocal(command, args, cwd, options = {}) {
    const remoteConfig = getRemoteConfig(cwd);

    if (remoteConfig && agentRegistry) {
      const client = agentRegistry.getClient(remoteConfig.agentId);
      const remoteStartMs = Date.now();

      // If client exists but health cache is stale, run a quick health check
      if (client && !client.isAvailable()) {
        try {
          await client.checkHealth();
        } catch { /* will fall through to local */ }

        if (!client.isAvailable() && isRemoteAuthError(client.lastHealthError)) {
          logger.warn(`[remote-routing] Remote auth failed, not falling back: ${client.lastHealthError.message}`);
          return toRemoteFailureResult(client.lastHealthError, remoteStartMs);
        }
      }

      if (client && client.isAvailable()) {
        try {
          const branch = options.branch || getCurrentBranch(cwd);
          // Extract project name for sync: find the repo root directory name.
          // The remotePath may point to a subdirectory (e.g., "Torque/server"),
          // so we derive the project name from the local cwd's git toplevel.
          const projectName = getSyncProjectName(cwd, remoteConfig.remotePath);

          logger.info(`[remote-routing] Syncing project="${projectName}" branch=${branch}...`);
          await client.sync(projectName, branch);

          // Inject --blame-hang-timeout for dotnet test on headless remote agents
          // to prevent WPF/UI tests from hanging indefinitely
          const remoteArgs = [...args];
          if (command === 'dotnet' && remoteArgs[0] === 'test' && !remoteArgs.includes('--blame-hang-timeout')) {
            remoteArgs.push('--blame-hang-timeout', '30s');
          }

          logger.info(`[remote-routing] Running remotely: ${command} ${remoteArgs.join(' ')}`);
          const safeEnv = filterSensitiveEnv(options.env);
          const result = await client.run(command, remoteArgs, {
            cwd: remoteConfig.remotePath,
            env: safeEnv,
            timeout: options.timeout || 120000,
          });

          logger.info(`[remote-routing] Remote completed: exit=${result.exitCode} duration=${result.durationMs}ms`);
          return { ...result, remote: true };
        } catch (err) {
          if (isRemoteAuthError(err)) {
            logger.warn(`[remote-routing] Remote auth failed, not falling back: ${err.message}`);
            return toRemoteFailureResult(err, remoteStartMs);
          }
          if (isRemoteExecutionTimeout(err)) {
            logger.warn(`[remote-routing] Remote execution timed out, not falling back: ${err.message}`);
            return toRemoteFailureResult(err, remoteStartMs);
          }
          logger.warn(`[remote-routing] Remote failed, falling back to local: ${err.message}`);
          // Fall through to local execution
        }
      }
    }

    // Local fallback
    logger.info(`[remote-routing] Running locally: ${command} ${args.join(' ')}`);
    const startMs = Date.now();
    const spawnResult = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: options.timeout || 120000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      shell: true, // Required on Windows — npx/npm are .cmd files resolved via PATH
    });

    return {
      success: spawnResult.status === 0,
      output: spawnResult.stdout || '',
      error: spawnResult.stderr || '',
      exitCode: spawnResult.status ?? 1,
      durationMs: Date.now() - startMs,
      remote: false,
    };
  }

  /**
   * Run a verify command through the platform shell without re-tokenizing it.
   *
   * This preserves quoted arguments, file paths with spaces, and command chains
   * such as `&&` exactly as authored in project configuration.
   *
   * @param {string} verifyCommand - The compound command string
   * @param {string} cwd - Working directory
   * @param {object} [options] - Passed through to runRemoteOrLocal
   * @returns {Promise<{success: boolean, output: string, error: string, exitCode: number, durationMs: number, remote: boolean}>}
   */
  async function runVerifyCommand(verifyCommand, cwd, options = {}) {
    const command = typeof verifyCommand === 'string' ? verifyCommand.trim() : '';
    if (!command) {
      return {
        success: true,
        output: '',
        error: '',
        exitCode: 0,
        durationMs: 0,
        remote: false,
      };
    }

    const remoteConfig = getRemoteConfig(cwd);

    if (remoteConfig && agentRegistry) {
      const client = agentRegistry.getClient(remoteConfig.agentId);
      const remoteStartMs = Date.now();

      if (client && !client.isAvailable()) {
        try {
          await client.checkHealth();
        } catch { /* will fall through to local */ }

        if (!client.isAvailable() && isRemoteAuthError(client.lastHealthError)) {
          logger.warn(`[remote-routing] Remote auth failed, not falling back: ${client.lastHealthError.message}`);
          return toRemoteFailureResult(client.lastHealthError, remoteStartMs);
        }
      }

      if (client && client.isAvailable()) {
        try {
          const branch = options.branch || getCurrentBranch(cwd);
          const projectName = getSyncProjectName(cwd, remoteConfig.remotePath);

          logger.info(`[remote-routing] Syncing project="${projectName}" branch=${branch}...`);
          await client.sync(projectName, branch);

          logger.info(`[remote-routing] Running remotely: ${command}`);
          const safeEnv = filterSensitiveEnv(options.env);
          const result = await client.run(command, undefined, {
            cwd: remoteConfig.remotePath,
            env: safeEnv,
            timeout: options.timeout || 120000,
          });

          logger.info(`[remote-routing] Remote completed: exit=${result.exitCode} duration=${result.durationMs}ms`);
          return { ...result, remote: true };
        } catch (err) {
          if (isRemoteAuthError(err)) {
            logger.warn(`[remote-routing] Remote auth failed, not falling back: ${err.message}`);
            return toRemoteFailureResult(err, remoteStartMs);
          }
          if (isRemoteExecutionTimeout(err)) {
            logger.warn(`[remote-routing] Remote execution timed out, not falling back: ${err.message}`);
            return toRemoteFailureResult(err, remoteStartMs);
          }
          logger.warn(`[remote-routing] Remote verify failed, falling back to local: ${err.message}`);
        }
      }
    }

    logger.info(`[remote-routing] Running locally: ${command}`);
    const startMs = Date.now();
    const spawnResult = spawnSync(command, {
      cwd,
      encoding: 'utf8',
      timeout: options.timeout || 120000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      shell: true,
    });

    return {
      success: spawnResult.status === 0,
      output: spawnResult.stdout || '',
      error: spawnResult.stderr || spawnResult.error?.message || '',
      exitCode: spawnResult.status ?? 1,
      durationMs: Date.now() - startMs,
      remote: false,
    };
  }

  return { runRemoteOrLocal, runVerifyCommand, getRemoteConfig, getCurrentBranch };
}

module.exports = {
  createRemoteTestRouter,
  filterSensitiveEnv,
  isRemoteAuthError,
  isRemoteExecutionTimeout,
  SENSITIVE_ENV_PATTERNS,
};
