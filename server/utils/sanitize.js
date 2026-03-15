/**
 * Unified LLM output sanitization utilities for TORQUE
 *
 * Consolidates artifact stripping, markdown fence removal, and thinking tag
 * cleanup that were previously duplicated in 5+ locations in task-manager.js.
 */

const { LLM_ARTIFACT_PATTERNS } = require('../constants');

/**
 * Strip ANSI escape sequences (colors, cursor, etc.) from text.
 * Handles SGR sequences (\x1b[...m), cursor movement, and OSC sequences.
 * @param {string} text
 * @returns {string}
 */
function stripAnsiEscapes(text) {
  if (!text) return text;
  /* eslint-disable no-control-regex */
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '');
  /* eslint-enable no-control-regex */
}

/**
 * Full sanitization pipeline: strips thinking tags, artifacts, markdown fences, and ANSI escapes.
 * @param {string} text - Raw LLM output
 * @returns {string} Cleaned text
 */
function sanitizeLLMOutput(text) {
  if (!text) return text;
  // Strip thinking model <think>...</think> blocks
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  // Strip hashline artifacts
  text = stripArtifactMarkers(text);
  // Strip markdown fences
  text = stripMarkdownFences(text);
  // Strip ANSI escape sequences
  text = stripAnsiEscapes(text);
  return text;
}

/**
 * Remove markdown code fences (```lang\n ... ```) leaving inner content.
 * @param {string} text
 * @returns {string}
 */
function stripMarkdownFences(text) {
  if (!text) return text;
  return text.replace(/```[\w]*\n/g, '').replace(/```/g, '');
}

/**
 * Remove hashline artifact markers (<<<__newText__>>>, etc.).
 * @param {string} text
 * @returns {string}
 */
function stripArtifactMarkers(text) {
  if (!text) return text;
  for (const pattern of LLM_ARTIFACT_PATTERNS) {
    text = text.replace(pattern, '');
  }
  return text;
}

/**
 * Redact potential secrets from error messages and log output.
 * Uses the same patterns as output-safeguards.js SECRET_PATTERNS.
 * Designed for lightweight use in error paths (no MAX_LENGTH guard needed
 * since error messages are typically short).
 *
 * @param {string} text - Text to redact
 * @returns {string} Text with secrets replaced by [REDACTED]
 */
function redactSecrets(text) {
  if (!text || typeof text !== 'string') return text || '';
  const { SECRET_PATTERNS } = require('../validation/output-safeguards');
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

/**
 * Redact sensitive arguments from a command arg list for safe logging.
 * Replaces values after --message, --api-key, --token, and similar flags
 * with [REDACTED]. Returns a new array (does not mutate input).
 * @param {string[]} args - Command arguments array
 * @returns {string[]} Redacted copy
 */
const REDACT_FLAGS = new Set(['--message', '-m', '--api-key', '--token', '--secret', '--password', '--key']);

/**
 * Returns a copy of args with sensitive flag values redacted.
 *
 * @param {string[]} args - List of CLI arguments.
 * @returns {string[]} New array with secret-adjacent values replaced.
 */
function redactCommandArgs(args) {
  const result = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      result.push('[REDACTED]');
      redactNext = false;
    } else if (REDACT_FLAGS.has(arg)) {
      result.push(arg);
      redactNext = true;
    } else {
      // Handle --flag=value format
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        const flag = arg.substring(0, eqIdx);
        if (REDACT_FLAGS.has(flag)) {
          result.push(flag + '=[REDACTED]');
          continue;
        }
      }
      result.push(arg);
    }
  }
  return result;
}

module.exports = {
  sanitizeLLMOutput,
  stripMarkdownFences,
  stripArtifactMarkers,
  stripAnsiEscapes,
  redactSecrets,
  redactCommandArgs,
};
