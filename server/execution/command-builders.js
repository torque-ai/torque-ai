/**
 * CLI command builders for task execution (Phase D4.1)
 * Extracted from task-manager.js — builds command args for claude-cli and codex providers.
 */

const path = require('path');
const logger = require('../logger').child({ component: 'command-builders' });
const { applyStudyContextPrompt } = require('../integrations/codebase-study-engine');

let _wrapWithInstructions = null;
let _providerCfg = null;
let _contextEnrichment = null;
let _codexIntelligence = null;
let _db = null;
let _nvmNodePath = null;

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
  const effectiveTaskDescription = applyStudyContextPrompt(task.task_description, task.metadata);
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
  const effectiveTaskDescription = applyStudyContextPrompt(task.task_description, task.metadata);
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
      { files: task.files, project: task.project, fileContext: resolvedFileContext }
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
  }

  // Read prompt from stdin (use '-' as prompt arg)
  codexArgs.push('-');

  let cliPath;
  if (providerConfig && providerConfig.cli_path) {
    cliPath = providerConfig.cli_path;
    if (process.platform === 'win32' && !path.extname(cliPath)) {
      cliPath = cliPath + '.cmd';
    }
    return { cliPath, finalArgs: codexArgs, stdinPrompt };
  } else if (process.platform === 'win32') {
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
