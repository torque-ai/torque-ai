/**
 * Context Stuffing Module
 *
 * Reads file contents, estimates token counts, checks budget constraints,
 * and formats context blocks for context-stuffed providers (groq, cerebras,
 * google-ai, openrouter). These providers benefit from having project files
 * embedded directly in the prompt rather than relying on tool-based file access.
 *
 * Called at execution time (in execute-api.js) when a task has context_files
 * in its metadata. The smart-scan module handles discovering which files to
 * include; this module handles reading them and formatting the prompt.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger').child({ component: 'context-stuffing' });

// SECURITY: Files that should NEVER be sent to cloud API providers
const SENSITIVE_FILE_PATTERNS = [
  /^\.env$/i, /^\.env\./i, /\.env\.local$/i, /\.env\.production$/i,
  /\.key$/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /\.cert$/i,
  /\.credentials$/i, /\.secrets?$/i, /\.pgpass$/i, /\.netrc$/i,
  /^id_rsa$/i, /^id_ed25519$/i, /^id_ecdsa$/i, /^id_dsa$/i,
  /^authorized_keys$/i, /^known_hosts$/i,
  /^\.aws\/credentials$/i, /^\.gcloud\/credentials\.json$/i,
  /^\.docker\/config\.json$/i, /^\.kube\/config$/i,
  /^\.npmrc$/i, // may contain authToken
  /^\.pypirc$/i, // may contain passwords
  /^\.git-credentials$/i,
  /secret/i, // catch-all for files with "secret" in name
];

function _isSensitiveFile(filePath) {
  const basename = path.basename(filePath);
  return SENSITIVE_FILE_PATTERNS.some(pattern => pattern.test(basename));
}

/**
 * Token budget limits per provider (in tokens).
 * Conservative estimates leaving room for the model's response.
 */
const PROVIDER_CONTEXT_BUDGETS = {
  groq: 96000,
  cerebras: 6000,       // Cerebras API enforces 8192 token limit; reserve room for response
  'google-ai': 800000,
  openrouter: 96000,    // Conservative default; model-specific overrides below
  'ollama-cloud': 200000, // qwen3-coder:480b has massive context; conservative budget
};

/**
 * Model-specific context budgets for OpenRouter (tokens).
 * Matched by substring — first match wins, so order from most-specific to least.
 * Budget ≈ 75% of context window to leave room for response.
 */
const OPENROUTER_MODEL_BUDGETS = [
  // Large context (200K+)
  { match: 'coder', budget: 200000 },
  { match: 'step-', budget: 190000 },
  { match: 'nemotron', budget: 190000 },
  // 131K context
  { match: 'hermes', budget: 96000 },
  { match: 'trinity', budget: 96000 },
  // 128K context (default for most models)
  { match: 'llama', budget: 96000 },
  { match: 'mistral', budget: 96000 },
  // 32K context
  { match: 'gemma', budget: 24000 },
];

/**
 * Get the context budget for a provider+model combination.
 * For OpenRouter, looks up model-specific budgets; other providers use flat budgets.
 */
function getContextBudget(provider, model) {
  if (provider === 'openrouter' && model) {
    const entry = OPENROUTER_MODEL_BUDGETS.find(e => model.includes(e.match));
    if (entry) return entry.budget;
  }
  return PROVIDER_CONTEXT_BUDGETS[provider] || 96000;
}

/**
 * Set of providers that support context stuffing.
 */
const CONTEXT_STUFFING_PROVIDERS = new Set(Object.keys(PROVIDER_CONTEXT_BUDGETS));

/**
 * Estimate token count from text length.
 * Uses the common ~4 characters per token heuristic.
 *
 * @param {string} text - Input text
 * @returns {number} Estimated token count (0 for empty/null)
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Read project files and format them into a context-enriched prompt.
 *
 * @param {Object} options
 * @param {string[]} options.contextFiles - Absolute paths to files to include
 * @param {string} options.workingDirectory - Project root for relative path computation
 * @param {string} options.taskDescription - Original task description
 * @param {string} options.provider - Provider name (used for budget lookup)
 * @param {string} [options.model] - Model name (used for model-specific budget on OpenRouter)
 * @param {number} [options.contextBudget] - Override token budget
 * @returns {Promise<{enrichedDescription: string}>}
 * @throws {Error} If total estimated tokens exceed the budget
 */
async function stuffContext({ contextFiles, workingDirectory, taskDescription, provider, model, contextBudget }) {
  const fileBlocks = [];

  for (const filePath of (contextFiles || [])) {
    // SECURITY: skip sensitive files that may contain credentials
    if (_isSensitiveFile(filePath)) {
      logger.debug(`Skipping sensitive file: ${path.basename(filePath)}`);
      continue;
    }
    // SECURITY: validate file path is within the working directory
    const resolvedPath = path.resolve(filePath);
    const resolvedWd = path.resolve(workingDirectory || '.');
    if (!resolvedPath.startsWith(resolvedWd + path.sep) && resolvedPath !== resolvedWd) {
      logger.warn(`[context-stuffing] Skipping file outside working directory: ${filePath}`);
      continue;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(workingDirectory, filePath).replace(/\\/g, '/');
      const lines = content.split('\n');
      // Don't count trailing empty line from final newline
      const lineCount = (lines.length > 0 && lines[lines.length - 1] === '') ? lines.length - 1 : lines.length;
      const block = `--- FILE: ${relativePath} (${lineCount} lines) ---\n${content}\n--- END FILE ---`;
      fileBlocks.push(block);
    } catch (err) {
      const relativePath = path.relative(workingDirectory, filePath).replace(/\\/g, '/');
      logger.debug(`Skipping unreadable file: ${relativePath}`, { error: err.message });
    }
  }

  // No readable files — return original description unchanged
  if (fileBlocks.length === 0) {
    return { enrichedDescription: taskDescription };
  }

  // Build the full enriched description
  const contextSection = fileBlocks.join('\n\n');
  const enrichedDescription =
    `### Project Context\n\nThe following files from the project are provided for reference.\n\n${contextSection}\n\n### Task\n\n${taskDescription}`;

  // Check token budget
  const budget = contextBudget || getContextBudget(provider, model);
  const estimatedTokens = estimateTokens(enrichedDescription);

  if (estimatedTokens > budget) {
    throw new Error(
      `Context too large: ${fileBlocks.length} file(s), ~${estimatedTokens} estimated tokens exceeds budget of ${budget}. ` +
      `Consider using google-ai (800K token budget) or narrowing the scope of context files.`
    );
  }

  return { enrichedDescription };
}

module.exports = {
  stuffContext,
  estimateTokens,
  getContextBudget,
  PROVIDER_CONTEXT_BUDGETS,
  OPENROUTER_MODEL_BUDGETS,
  CONTEXT_STUFFING_PROVIDERS,
  SENSITIVE_FILE_PATTERNS,
};
