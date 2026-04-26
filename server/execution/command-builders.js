/**
 * CLI command builders for task execution (Phase D4.1)
 * Extracted from task-manager.js — builds command args for claude-cli and codex providers.
 */

const path = require('path');
const fs = require('fs');
const logger = require('../logger').child({ component: 'command-builders' });
const { applyStudyContextPrompt } = require('../integrations/codebase-study-engine');
const { resolveCodexNativeBinary } = require('./codex-native-resolve');

// Git worktrees store per-worktree state at <main>/.git/worktrees/<name>/ and
// the shared object database + refs at <main>/.git/, both outside the
// worktree's cwd. The --full-auto workspace-write sandbox only permits writes
// inside cwd, so `git add`/`git commit` fail with "Permission denied" trying
// to create index.lock or write new objects.
//
// Previous fix widened the sandbox to the entire common .git dir. That let
// Codex accidentally corrupt the main repo's HEAD by running
// `git --git-dir=<common> --work-tree=<worktree> checkout -f master -- .`
// during recovery attempts. This resolver narrows the writable roots to
// just the subdirs commit + push actually need to write, leaving
// <common>/HEAD and other top-level files read-only.
//
// Probe (git commit + git push on a feature branch) writes to:
//   objects/, refs/, logs/, worktrees/<leaf>/
// Not to: HEAD, index, packed-refs, hooks/, info/, config.
function resolveSandboxWritableRoots(workingDirectory) {
  try {
    const gitPath = path.join(workingDirectory, '.git');
    // eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- sandbox writable-roots probe — task startup, single small read each.
    const st = fs.statSync(gitPath);
    if (!st.isFile()) return null;
    // eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- sandbox writable-roots probe — task startup, single small read each.
    const content = fs.readFileSync(gitPath, 'utf8');
    const match = content.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) return null;
    const linked = match[1].trim();
    const perWorktreeGitDir = path.isAbsolute(linked)
      ? linked
      : path.resolve(workingDirectory, linked);
    let commonGitDir;
    try {
      const commondirFile = path.join(perWorktreeGitDir, 'commondir');
      // eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- sandbox writable-roots probe — task startup, single small read each.
      const raw = fs.readFileSync(commondirFile, 'utf8').trim();
      commonGitDir = path.isAbsolute(raw) ? raw : path.resolve(perWorktreeGitDir, raw);
    } catch {
      commonGitDir = path.resolve(perWorktreeGitDir, '..', '..');
    }
    // mkdirSync for logs/ because a fresh repo may not have it yet; Codex's
    // --add-dir must reference an existing dir.
    for (const sub of ['objects', 'refs', 'logs']) {
      const p = path.join(commonGitDir, sub);
      // eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- best-effort sandbox dir creation.
      try { fs.mkdirSync(p, { recursive: true }); } catch { /* best effort */ }
    }
    return {
      perWorktreeGitDir,
      commonObjectsDir: path.join(commonGitDir, 'objects'),
      commonRefsDir: path.join(commonGitDir, 'refs'),
      commonLogsDir: path.join(commonGitDir, 'logs'),
    };
  } catch {
    return null;
  }
}

let _wrapWithInstructions = null;
let _providerCfg = null;
let _contextEnrichment = null;
let _codexIntelligence = null;
let _db = null;
let _nvmNodePath = null;

function getExecutionDescription(task) {
  return typeof task?.execution_description === 'string' && task.execution_description.trim()
    ? task.execution_description
    : task.task_description;
}

function init({ wrapWithInstructions, providerCfg, contextEnrichment, codexIntelligence, db, nvmNodePath }) {
  if (!wrapWithInstructions) throw new Error('command-builders: wrapWithInstructions is required');
  if (!providerCfg) throw new Error('command-builders: providerCfg is required');
  _wrapWithInstructions = wrapWithInstructions;
  _providerCfg = providerCfg;
  _contextEnrichment = contextEnrichment;
  _codexIntelligence = codexIntelligence;
  _db = db;
  _nvmNodePath = nvmNodePath;
}

/**
 * Build claude-cli CLI command and arguments.
 *
 * @param {object} task - Task record from DB
 * @param {object} providerConfig - Provider configuration from DB
 * @param {string} resolvedFileContext - Pre-resolved file context string
 * @returns {{ cliPath: string, finalArgs: string[], stdinPrompt: string }}
 */
function buildClaudeCliCommand(task, providerConfig, resolvedFileContext) {
  const promptDescription = getExecutionDescription(task);
  const effectiveTaskDescription = applyStudyContextPrompt(promptDescription, task.metadata);
  const wrappedDescription = _wrapWithInstructions(
    effectiveTaskDescription,
    'claude-cli',
    null,
    { files: task.files, project: task.project, fileContext: resolvedFileContext }
  );
  const finalArgs = [
    '--dangerously-skip-permissions',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '-p'
  ];
  const stdinPrompt = wrappedDescription;

  let cliPath;
  if (providerConfig && providerConfig.cli_path) {
    cliPath = providerConfig.cli_path;
    if (process.platform === 'win32' && !path.extname(cliPath)) {
      cliPath = cliPath + '.cmd';
    }
  } else if (process.platform === 'win32') {
    cliPath = 'claude.cmd';
  } else {
    cliPath = 'claude';
  }

  return { cliPath, finalArgs, stdinPrompt };
}

/**
 * Build codex CLI command and arguments.
 * Uses codex-intelligence module for enriched prompts with local system analysis.
 *
 * @param {object} task - Task record from DB
 * @param {object} providerConfig - Provider configuration from DB
 * @param {string} resolvedFileContext - Pre-resolved file context string (fallback)
 * @param {Array<{actual: string, mentioned: string}>} resolvedFiles - Resolved file references
 * @returns {Promise<{ cliPath: string, finalArgs: string[], stdinPrompt: string }>}
 */
async function buildCodexCommand(task, providerConfig, resolvedFileContext, resolvedFiles) {
  logger.info(`[BuildCodex PATH=EXECUTION/COMMAND-BUILDERS] entered for task ${task && task.id ? String(task.id).slice(0,8) : '<no-id>'} platform=${process.platform} hasProviderConfigCliPath=${Boolean(providerConfig && providerConfig.cli_path)}`);
  const promptDescription = getExecutionDescription(task);
  const effectiveTaskDescription = applyStudyContextPrompt(promptDescription, task.metadata);
  let stdinPrompt;

  if (resolvedFiles && resolvedFiles.length > 0 && task.working_directory) {
    // Use codex intelligence for enriched, efficient prompt
    const codexEnrichCfg = _providerCfg.getEnrichmentConfig();
    let enrichment = '';
    if (codexEnrichCfg.enabled) {
      try {
        enrichment = await _contextEnrichment.enrichResolvedContextAsync(
          resolvedFiles, task.working_directory, task.task_description, _db, codexEnrichCfg
        );
      } catch (e) {
        logger.info(`[BuildCodex] Non-fatal enrichment error: ${e.message}`);
      }
    }

    stdinPrompt = _codexIntelligence.buildCodexEnrichedPrompt(
      { ...task, task_description: effectiveTaskDescription },
      resolvedFiles,
      task.working_directory,
      enrichment
    );
    logger.info(`[BuildCodex] Using enriched prompt (${stdinPrompt.length} chars) instead of full file context`);
  } else {
    // Fallback: generic wrapping for tasks without file references
    stdinPrompt = _wrapWithInstructions(
      effectiveTaskDescription,
      'codex',
      null,
      {
        files: task.files,
        project: task.project,
        fileContext: resolvedFileContext,
        workingDirectory: task.working_directory,
      }
    );
  }

  const codexArgs = ['exec'];
  codexArgs.push('--skip-git-repo-check');

  // Only pass -m when user specified a real model name.
  // Skip when model matches the provider name (e.g., "codex") — let the CLI
  // use its own configured default, which changes as technology evolves.
  if (task.model && task.model !== 'codex') {
    codexArgs.push('-m', task.model);
  }

  if (task.auto_approve) {
    codexArgs.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    codexArgs.push('--full-auto');
  }

  if (task.working_directory) {
    codexArgs.push('-C', task.working_directory);
    const sandboxRoots = resolveSandboxWritableRoots(task.working_directory);
    if (sandboxRoots) {
      codexArgs.push('--add-dir', sandboxRoots.perWorktreeGitDir);
      codexArgs.push('--add-dir', sandboxRoots.commonObjectsDir);
      codexArgs.push('--add-dir', sandboxRoots.commonRefsDir);
      codexArgs.push('--add-dir', sandboxRoots.commonLogsDir);
    }
  }

  // Read prompt from stdin (use '-' as prompt arg)
  codexArgs.push('-');

  let cliPath;
  if (providerConfig && providerConfig.cli_path) {
    cliPath = providerConfig.cli_path;
    // Even when providerConfig.cli_path is set, prefer the bundled native
    // codex.exe on Windows if the configured path is a bare name (e.g.
    // "codex" or "codex.cmd") — that's the common case and the node-wrapper
    // shim is what's causing pwsh descendant windows to flash. An absolute
    // path in providerConfig means the user deliberately chose a specific
    // binary, so we honor it untouched.
    if (process.platform === 'win32' && !path.isAbsolute(cliPath)) {
      const native = resolveCodexNativeBinary();
      logger.info(`[BuildCodex EXECUTION cli_path-branch] cli_path=${JSON.stringify(cliPath)} native-resolve=${native ? 'OK' : 'NULL'}`);
      if (native) {
        return {
          cliPath: native.binaryPath,
          finalArgs: codexArgs,
          stdinPrompt,
          nativeCodex: {
            pathPrepend: native.vendorPathDir,
            envAdditions: { CODEX_MANAGED_BY_NPM: '1' },
          },
        };
      }
      // Native resolver failed — keep the legacy behavior (append .cmd).
      if (!path.extname(cliPath)) {
        cliPath = cliPath + '.cmd';
      }
    }
    return { cliPath, finalArgs: codexArgs, stdinPrompt };
  } else if (process.platform === 'win32') {
    // Prefer launching the bundled native codex.exe directly. The `codex.cmd`
    // shim invokes `node codex.js` which spawns `codex.exe` which then spawns
    // `pwsh.exe` for its command-safety AST parser. windowsHide:true on our
    // spawn doesn't propagate to descendants, so every task flashes a pwsh
    // console window. Skipping the node shim cuts one layer and puts us in a
    // better position to control descendant-window semantics (the pwsh child
    // is still spawned by codex.exe itself; if that continues to flash, that
    // is codex's own window-flag issue, not ours).
    const native = resolveCodexNativeBinary();
    logger.info(`[BuildCodex EXECUTION] native-resolve result: ${native ? 'OK binary=' + native.binaryPath : 'NULL (will fall back to codex.cmd)'}`);
    if (native) {
      logger.info(`[BuildCodex EXECUTION] RETURN nativeCodex path. cliPath=${native.binaryPath}`);
      return {
        cliPath: native.binaryPath,
        finalArgs: codexArgs,
        stdinPrompt,
        nativeCodex: {
          pathPrepend: native.vendorPathDir,
          envAdditions: { CODEX_MANAGED_BY_NPM: '1' },
        },
      };
    }
    // Native not resolvable — fall back to the npm .cmd shim.
    logger.info('[BuildCodex EXECUTION] RETURN codex.cmd fallback');
    cliPath = 'codex.cmd';
    return { cliPath, finalArgs: codexArgs, stdinPrompt };
  } else if (_nvmNodePath) {
    cliPath = path.join(_nvmNodePath, 'node');
    return { cliPath, finalArgs: [path.join(_nvmNodePath, 'codex'), ...codexArgs], stdinPrompt };
  } else {
    cliPath = 'codex';
    return { cliPath, finalArgs: codexArgs, stdinPrompt };
  }
}

module.exports = {
  init,
  buildClaudeCliCommand,
  buildCodexCommand,
};
