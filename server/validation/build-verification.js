'use strict';

/**
 * Build Verification — extracted from post-task.js
 *
 * Contains runBuildVerification: auto-detects build commands and runs
 * build verification after task completion, with scoped error analysis
 * and WSL/Windows cross-environment support.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const logger = require('../logger').child({ component: 'build-verification' });

let db;
let parseCommand;
let extractBuildErrorFiles;

function init(deps) {
  if (deps.db) db = deps.db;
  if (deps.parseCommand) parseCommand = deps.parseCommand;
  if (deps.extractBuildErrorFiles) extractBuildErrorFiles = deps.extractBuildErrorFiles;
}

function runBuildVerification(taskId, task, workingDir, taskModifiedFiles) {
  const project = task.project || db.getProjectFromPath(workingDir);
  if (!project) {
    return { success: true, output: '', error: '', skipped: true, reason: 'no_project' };
  }

  const projectConfig = db.getProjectConfig(project);
  if (!projectConfig || !projectConfig.build_verification_enabled) {
    return { success: true, output: '', error: '', skipped: true, reason: 'disabled' };
  }

  // Determine build command - use project-specific or auto-detect
  let buildCommand = projectConfig.build_command;
  if (!buildCommand) {
    // Auto-detect based on project files
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
      // Check for .NET projects — scan recursively (up to 2 levels) to catch
      // solutions where .csproj files are nested under a src/ subdirectory.
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

  if (!buildCommand) {
    return { success: true, output: '', error: '', skipped: true, reason: 'no_build_command' };
  }

  const timeout = (projectConfig.build_timeout || 120) * 1000; // Convert to ms
  const startTime = Date.now();

  logger.info(`[Build Verification] Task ${taskId}: Running "${buildCommand}" in ${workingDir}`);

  try {
    // Parse command into executable and args (supports quoted segments)
    const parsed = parseCommand(buildCommand);
    let executable = parsed.executable;
    const args = parsed.args;

    // Handle WSL environment - use Windows executable paths for common tools
    const isWSL = process.platform === 'linux' && workingDir.startsWith('/mnt/');
    if (isWSL) {
      if (executable === 'dotnet') {
        executable = '/mnt/c/Program Files/dotnet/dotnet.exe';
      } else if (executable === 'npm') {
        // Try Windows npm if available
        const winNpm = '/mnt/c/Program Files/nodejs/npm.cmd';
        if (fs.existsSync(winNpm)) {
          executable = winNpm;
        }
      }
    }

    // Use spawnSync - handle WSL + Windows executables properly
    let spawnResult;

    if (isWSL && executable.endsWith('.exe')) {
      // For Windows executables in WSL, spawn directly without shell
      // Node's spawnSync handles paths with spaces correctly when shell=false
      spawnResult = spawnSync(executable, args, {
        cwd: workingDir,
        encoding: 'utf8',
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
        windowsHide: true
      });
    } else if (isWSL && (executable.endsWith('.cmd') || executable.endsWith('.bat'))) {
      // For Windows batch files, use cmd.exe
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
      // Normal Unix execution without shell
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
      // Scoped build verification: if we know which files this task modified,
      // only fail if the build errors are in those files. This prevents
      // cross-task contamination when parallel tasks share a working directory.
      if (taskModifiedFiles && taskModifiedFiles.length > 0) {
        const combinedOutput = (spawnResult.stderr || '') + '\n' + (spawnResult.stdout || '');
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
            const endTime = Date.now();
            const durationSeconds = (endTime - startTime) / 1000;
            logger.info(`[Build Verification] Task ${taskId}: Build failed but errors are in files NOT modified by this task — treating as passed`);
            logger.info(`[Build Verification]   Error files: ${errorFilePaths.slice(0, 5).join(', ')}`);
            logger.info(`[Build Verification]   Task files: ${normalizedTaskFiles.slice(0, 5).join(', ')}`);

            try {
              db.saveBuildResult(taskId, {
                command: buildCommand,
                workingDirectory: workingDir,
                exitCode: spawnResult.status,
                output: (spawnResult.stdout || '').slice(-10000),
                errorOutput: `[SCOPED-PASS] Build has pre-existing errors not caused by this task`,
                durationSeconds,
                status: 'passed_scoped'
              });
            } catch (saveErr) {
              logger.info(`[Build Verification] Failed to save result: ${saveErr.message}`);
            }

            return {
              success: true,
              output: spawnResult.stdout || '',
              error: '',
              warning: `Build has pre-existing errors (not caused by this task): ${errorFilePaths.slice(0, 3).join(', ')}`
            };
          }
        }
      }

      const err = new Error('Build failed');
      err.stdout = spawnResult.stdout;
      err.stderr = spawnResult.stderr;
      throw err;
    }

    const result = spawnResult.stdout;
    const endTime = Date.now();
    const durationSeconds = (endTime - startTime) / 1000;

    // Save build result to database
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
    const endTime = Date.now();
    const durationSeconds = (endTime - startTime) / 1000;

    // Save build result to database
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
