'use strict';

/**
 * Build Verification — extracted from post-task.js
 *
 * Contains runBuildVerification: auto-detects build commands and runs
 * build verification after task completion, with scoped error analysis
 * and WSL/Windows cross-environment support.
 *
 * Uses the shared test runner registry so build commands can be routed by
 * the default remote-agents plugin when available and still fall back to
 * local execution when no override is registered.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { createTestRunnerRegistry } = require('../test-runner-registry');

let db;
let parseCommand;
let extractBuildErrorFiles;
let _testRunnerRegistry = null;

function init(deps) {
  if (deps.db) db = deps.db;
  if (deps.parseCommand) parseCommand = deps.parseCommand;
  if (deps.extractBuildErrorFiles) extractBuildErrorFiles = deps.extractBuildErrorFiles;
  if (deps.testRunnerRegistry) _testRunnerRegistry = deps.testRunnerRegistry;
}

function getRouter() {
  if (_testRunnerRegistry) return _testRunnerRegistry;
  _testRunnerRegistry = createTestRunnerRegistry();
  return _testRunnerRegistry;
}

/**
 * Detect the build command for a project, either from config or auto-detection.
 * @returns {{ buildCommand: string|null, projectConfig: object|null, project: string|null }}
 */
function detectBuildCommand(task, workingDir) {
  const project = task.project || db.getProjectFromPath(workingDir);
  if (!project) {
    return { buildCommand: null, projectConfig: null, project: null, skipReason: 'no_project' };
  }

  const projectConfig = db.getProjectConfig(project);
  if (!projectConfig || !projectConfig.build_verification_enabled) {
    return { buildCommand: null, projectConfig, project, skipReason: 'disabled' };
  }

  let buildCommand = projectConfig.build_command;
  if (!buildCommand) {
    if (fs.existsSync(path.join(workingDir, 'package.json'))) {
      buildCommand = 'npm run build';
    } else if (fs.existsSync(path.join(workingDir, 'Cargo.toml'))) {
      buildCommand = 'cargo build';
    } else if (fs.existsSync(path.join(workingDir, 'go.mod'))) {
      buildCommand = 'go build ./...';
    } else if (fs.existsSync(path.join(workingDir, 'pom.xml'))) {
      buildCommand = 'mvn compile -q';
    } else if (fs.existsSync(path.join(workingDir, 'build.gradle'))) {
      buildCommand = 'gradle build -q';
    } else {
      const findCsFiles = (dir, depth = 0) => {
        if (depth > 2) return [];
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          const found = entries
            .filter(e => e.isFile() && (e.name.endsWith('.csproj') || e.name.endsWith('.sln')))
            .map(e => e.name);
          if (found.length > 0) return found;
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
              const nested = findCsFiles(path.join(dir, entry.name), depth + 1);
              if (nested.length > 0) return nested;
            }
          }
        } catch { /* ignore unreadable dirs */ }
        return [];
      };
      const csprojFiles = findCsFiles(workingDir);
      if (csprojFiles.length > 0) {
        buildCommand = 'dotnet build --no-restore';
      }
    }
  }

  return { buildCommand: buildCommand || null, projectConfig, project, skipReason: buildCommand ? null : 'no_build_command' };
}

/**
 * Analyze build output for scoped error detection.
 * Returns a pass-through result if errors are not caused by this task's modified files.
 * Returns null if the task DID cause the errors (caller should fail the build).
 */
function checkScopedBuildErrors(taskId, buildCommand, workingDir, taskModifiedFiles, stdout, stderr, exitCode, startTime) {
  if (!taskModifiedFiles || taskModifiedFiles.length === 0) return null;

  const combinedOutput = (stderr || '') + '\n' + (stdout || '');
  const errorFilePaths = extractBuildErrorFiles(combinedOutput, workingDir);

  if (errorFilePaths.length > 0) {
    const normalizedTaskFiles = taskModifiedFiles.map(f =>
      f.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    );
    const taskCausedError = errorFilePaths.some(errorFile => {
      const normError = errorFile.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
      return normalizedTaskFiles.some(tf =>
        normError.endsWith(tf) || tf.endsWith(normError) || normError.includes(tf) || tf.includes(normError)
      );
    });

    if (!taskCausedError) {
      const durationSeconds = (Date.now() - startTime) / 1000;
      logger.info(`[Build Verification] Task ${taskId}: Build failed but errors are in files NOT modified by this task — treating as passed`);
      logger.info(`[Build Verification]   Error files: ${errorFilePaths.slice(0, 5).join(', ')}`);
      logger.info(`[Build Verification]   Task files: ${normalizedTaskFiles.slice(0, 5).join(', ')}`);

      try {
        db.saveBuildResult(taskId, {
          command: buildCommand,
          workingDirectory: workingDir,
          exitCode,
          output: (stdout || '').slice(-10000),
          errorOutput: `[SCOPED-PASS] Build has pre-existing errors not caused by this task`,
          durationSeconds,
          status: 'passed_scoped'
        });
      } catch (saveErr) {
        logger.info(`[Build Verification] Failed to save result: ${saveErr.message}`);
      }

      return {
        success: true,
        output: stdout || '',
        error: '',
        warning: `Build has pre-existing errors (not caused by this task): ${errorFilePaths.slice(0, 3).join(', ')}`
      };
    }
  }

  return null; // task caused the errors
}

/**
 * Run build verification — routes to remote workstation when available,
 * falls back to local execution.
 */
async function runBuildVerification(taskId, task, workingDir, taskModifiedFiles) {
  const { buildCommand, projectConfig, skipReason } = detectBuildCommand(task, workingDir);
  if (skipReason) {
    return { success: true, output: '', error: '', skipped: true, reason: skipReason };
  }

  const timeout = (projectConfig.build_timeout || 120) * 1000;
  const startTime = Date.now();
  const provider = (task.provider || '').toLowerCase();

  logger.info(`[Build Verification] Task ${taskId}: Running "${buildCommand}" in ${workingDir}`);

  // Try remote execution first
  const router = getRouter();
  const remoteConfig = router.getRemoteConfig(workingDir, { provider });

  if (remoteConfig) {
    try {
      logger.info(`[Build Verification] Task ${taskId}: Routing to remote workstation`);
      const result = await router.runVerifyCommand(buildCommand, workingDir, {
        timeout,
        provider,
      });

      const stdout = result.output || '';
      const stderr = result.error || '';
      const durationSeconds = (Date.now() - startTime) / 1000;

      if (result.exitCode === 0) {
        try {
          db.saveBuildResult(taskId, {
            command: buildCommand,
            workingDirectory: workingDir,
            exitCode: 0,
            output: stdout.slice(-10000),
            errorOutput: '',
            durationSeconds,
            status: 'passed',
            remote: result.remote || false,
          });
        } catch (saveErr) {
          logger.info(`[Build Verification] Failed to save result: ${saveErr.message}`);
        }

        logger.info(`[Build Verification] Task ${taskId}: Build PASSED (remote=${result.remote})`);
        return { success: true, output: stdout, error: '' };
      }

      // Non-zero exit — check scoped errors
      const scopedResult = checkScopedBuildErrors(taskId, buildCommand, workingDir, taskModifiedFiles, stdout, stderr, result.exitCode, startTime);
      if (scopedResult) return scopedResult;

      // Build failed and task caused it
      try {
        db.saveBuildResult(taskId, {
          command: buildCommand,
          workingDirectory: workingDir,
          exitCode: result.exitCode,
          output: stdout.slice(-10000),
          errorOutput: stderr.slice(-10000),
          durationSeconds,
          status: 'failed',
          remote: result.remote || false,
        });
      } catch (saveErr) {
        logger.info(`[Build Verification] Failed to save result: ${saveErr.message}`);
      }

      logger.info(`[Build Verification] Task ${taskId}: Build FAILED (remote=${result.remote})`);
      logger.info(`[Build Verification] Error: ${stderr.substring(0, 500)}`);
      return { success: false, output: stdout, error: stderr || 'Build failed' };
    } catch (remoteErr) {
      logger.warn(`[Build Verification] Task ${taskId}: Remote execution failed, falling back to local: ${remoteErr.message}`);
      // Fall through to local execution
    }
  }

  // Local execution (original path)
  try {
    const parsed = parseCommand(buildCommand);
    let executable = parsed.executable;
    const args = parsed.args;

    const isWSL = process.platform === 'linux' && workingDir.startsWith('/mnt/');
    if (isWSL) {
      if (executable === 'dotnet') {
        executable = '/mnt/c/Program Files/dotnet/dotnet.exe';
      } else if (executable === 'npm') {
        const winNpm = '/mnt/c/Program Files/nodejs/npm.cmd';
        if (fs.existsSync(winNpm)) {
          executable = winNpm;
        }
      }
    }

    let spawnResult;

    if (isWSL && executable.endsWith('.exe')) {
      spawnResult = spawnSync(executable, args, {
        cwd: workingDir,
        encoding: 'utf8',
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
        windowsHide: true
      });
    } else if (isWSL && (executable.endsWith('.cmd') || executable.endsWith('.bat'))) {
      const winPath = workingDir.replace(/^\/mnt\/([a-z])/, '$1:').replace(/\//g, '\\');
      spawnResult = spawnSync('cmd.exe', ['/c', executable, ...args], {
        cwd: workingDir,
        encoding: 'utf8',
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
        windowsHide: true,
        env: { ...process.env, CD: winPath }
      });
    } else {
      spawnResult = spawnSync(executable, args, {
        cwd: workingDir,
        encoding: 'utf8',
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
        windowsHide: true
      });
    }

    if (spawnResult.error) {
      throw spawnResult.error;
    }
    if (spawnResult.status !== 0) {
      const scopedResult = checkScopedBuildErrors(
        taskId, buildCommand, workingDir, taskModifiedFiles,
        spawnResult.stdout, spawnResult.stderr, spawnResult.status, startTime
      );
      if (scopedResult) return scopedResult;

      const err = new Error('Build failed');
      err.stdout = spawnResult.stdout;
      err.stderr = spawnResult.stderr;
      throw err;
    }

    const result = spawnResult.stdout;
    const durationSeconds = (Date.now() - startTime) / 1000;

    try {
      db.saveBuildResult(taskId, {
        command: buildCommand,
        workingDirectory: workingDir,
        exitCode: 0,
        output: result ? result.slice(-10000) : '',
        errorOutput: '',
        durationSeconds,
        status: 'passed'
      });
    } catch (saveErr) {
      logger.info(`[Build Verification] Failed to save result: ${saveErr.message}`);
    }

    logger.info(`[Build Verification] Task ${taskId}: Build PASSED`);
    return { success: true, output: result, error: '' };
  } catch (err) {
    const output = err.stdout || '';
    const error = err.stderr || err.message || 'Build failed';
    const durationSeconds = (Date.now() - startTime) / 1000;

    try {
      db.saveBuildResult(taskId, {
        command: buildCommand,
        workingDirectory: workingDir,
        exitCode: err.status || 1,
        output: output ? output.slice(-10000) : '',
        errorOutput: error ? error.slice(-10000) : '',
        durationSeconds,
        status: 'failed'
      });
    } catch (saveErr) {
      logger.info(`[Build Verification] Failed to save result: ${saveErr.message}`);
    }

    logger.info(`[Build Verification] Task ${taskId}: Build FAILED`);
    logger.info(`[Build Verification] Error: ${error.substring(0, 500)}`);

    return { success: false, output, error };
  }
}

module.exports = {
  init,
  runBuildVerification,
};
