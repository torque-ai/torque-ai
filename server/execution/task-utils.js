'use strict';

/**
 * Task Utilities
 *
 * Extracted from task-manager.js — pure utility functions for task metadata
 * parsing, token estimation, shell escaping, and aider output sanitization.
 *
 * No dependencies — these are stateless pure functions.
 */

/**
 * Parse metadata on task rows into a normalised object.
 * Handles JSON strings, already-parsed objects, and malformed values safely.
 * @param {Object|string|null} rawMetadata
 * @returns {Object}
 */
function parseTaskMetadata(rawMetadata) {
  if (!rawMetadata) return {};
  if (typeof rawMetadata === 'object' && rawMetadata !== null) return rawMetadata;
  if (typeof rawMetadata !== 'string') return {};

  try {
    const parsed = JSON.parse(rawMetadata);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Parse an integer token estimate from metadata or fallback context text.
 * @param {Object|string|number} taskMetadata
 * @param {string|undefined} contextText
 * @returns {number|null}
 */
function getTaskContextTokenEstimate(taskMetadata, contextText) {
  const metadata = parseTaskMetadata(taskMetadata);
  const candidateValues = [
    metadata.contextTokens,
    metadata.context_tokens,
    metadata.contextTokenEstimate,
    metadata.context_token_estimate,
    metadata.estimatedContextTokens,
    metadata.estimated_context_tokens,
    metadata.totalContextTokens,
    metadata.total_context_tokens,
    metadata.inputTokens,
    metadata.input_tokens
  ];

  for (const value of candidateValues) {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  if (typeof contextText === 'string' && contextText.length >= 40000) {
    return Math.round(contextText.length / 4);
  }

  return null;
}

/**
 * SECURITY: Escape a string for safe use as a shell argument.
 * Uses single quotes which are the safest shell quoting mechanism.
 * @param {string} arg - The argument to escape
 * @returns {string} Safely escaped argument for shell use
 */
function shellEscape(arg) {
  if (arg === undefined || arg === null) return "''";
  const str = String(arg);
  // Single quotes are the safest - only single quotes themselves need escaping
  // 'arg' -> 'arg'\''more' (close quote, escaped single quote, reopen quote)
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Strip aider CLI boilerplate noise from task output.
 * Removes the "Detected dumb terminal" + OllamaError + version banner
 * that aider prints before the actual model response.
 * @param {string} output - Raw aider stdout
 * @returns {string}
 */
function sanitizeAiderOutput(output) {
  if (!output) return output;
  // Strip thinking model <think>...</think> blocks (visible when streaming is enabled)
  output = output.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  // Strip everything up to and including "Repo-map: ..." line + blank line
  const repoMapMatch = output.match(/Repo-map:[^\n]*\n\n/);
  if (repoMapMatch && repoMapMatch.index < 1000) {
    return output.slice(repoMapMatch.index + repoMapMatch[0].length);
  }
  // Fallback: strip just the "Detected dumb terminal" + OllamaError lines
  const dumbTerminal = 'Detected dumb terminal, disabling fancy input and pretty output.\n';
  if (output.startsWith(dumbTerminal)) {
    output = output.slice(dumbTerminal.length);
    while (output.startsWith('OllamaError:') || output.startsWith('For more information check:')) {
      const nl = output.indexOf('\n');
      if (nl === -1) break;
      output = output.slice(nl + 1);
    }
  }
  return output.trimStart();
}

module.exports = {
  parseTaskMetadata,
  getTaskContextTokenEstimate,
  shellEscape,
  sanitizeAiderOutput,
};
