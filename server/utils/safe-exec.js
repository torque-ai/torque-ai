const { spawnSync } = require('child_process');

/**
 * Convert a command result value to a printable string.
 *
 * @param {*} value - Input value from child process output/error channels
 * @returns {string} Safe string representation
 */
function toText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return value.toString();
}

/**
 * Split a command string respecting quoted strings.
 * Handles both single and double quotes.
 *
 * @param {string} str - Command string to tokenize
 * @returns {string[]} Array of tokens
 */
function tokenize(str) {
  const tokens = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  for (const ch of str) {
    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true; quoteChar = ch;
    } else if (inQuote && ch === quoteChar) {
      inQuote = false;
    } else if (!inQuote && /\s/.test(ch)) {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Execute a shell-like command chain split on `&&` or `||`, stopping on first failure.
 *
 * @param {string} commandStr - Command string (segment-separated by && or ||)
 * @param {object} options - spawnSync options to apply per segment
 * @returns {{ exitCode: number, output: string, error?: string }} Execution result
 */
function safeExecChain(commandStr, options = {}) {
  if (typeof commandStr !== 'string') {
    return { exitCode: 1, output: '', error: 'command must be a string' };
  }

  const segments = commandStr
    .split(/\s*(?:&&|\|\|)\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return { exitCode: 0, output: '', error: '' };
  }

  let output = '';

  for (const segment of segments) {
    const args = tokenize(segment);
    const cmd = args.shift();

    try {
      const result = spawnSync(cmd, args, {
        ...options,
        shell: false,
      });

      const segmentOutput = `${toText(result.stdout)}${toText(result.stderr)}`;
      output += segmentOutput;

      const exitCode = typeof result.status === 'number' ? result.status : 1;
      if (result.error || exitCode !== 0) {
        return {
          exitCode,
          output,
          error: result.error ? result.error.message : toText(result.stderr),
        };
      }
    } catch (err) {
      return {
        exitCode: 1,
        output,
        error: err.message,
      };
    }
  }

  return { exitCode: 0, output };
}

module.exports = {
  safeExecChain,
};
