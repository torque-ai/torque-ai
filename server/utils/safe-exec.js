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
  let preserveQuote = false;
  for (const ch of str) {
    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true;
      quoteChar = ch;
      preserveQuote = current.length > 0;
      if (preserveQuote) {
        current += ch;
      }
    } else if (inQuote && ch === quoteChar) {
      if (preserveQuote) {
        current += ch;
      }
      inQuote = false;
      quoteChar = '';
      preserveQuote = false;
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
 * Split a command chain into segments and operators while respecting quotes.
 *
 * @param {string} str - Command string containing `&&` and/or `||`
 * @returns {{ segments: string[], operators: string[] }} Parsed chain
 */
function splitChain(str) {
  const segments = [];
  const operators = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    const next = str[i + 1];

    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true;
      quoteChar = ch;
      current += ch;
      continue;
    }

    if (inQuote && ch === quoteChar) {
      inQuote = false;
      quoteChar = '';
      current += ch;
      continue;
    }

    if (!inQuote && ((ch === '&' && next === '&') || (ch === '|' && next === '|'))) {
      const segment = current.trim();
      if (segment) {
        segments.push(segment);
      }
      operators.push(`${ch}${next}`);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) {
    segments.push(tail);
  }

  if (operators.length >= segments.length) {
    operators.length = Math.max(0, segments.length - 1);
  }

  return { segments, operators };
}

/**
 * Execute a shell-like command chain honoring `&&` and `||` short-circuiting.
 *
 * @param {string} commandStr - Command string (segment-separated by && or ||)
 * @param {object} options - spawnSync options to apply per segment
 * @returns {{ exitCode: number, output: string, error?: string }} Execution result
 */
function safeExecChain(commandStr, options = {}) {
  if (typeof commandStr !== 'string') {
    return { exitCode: 1, output: '', error: 'command must be a string' };
  }

  const { segments, operators } = splitChain(commandStr);

  if (segments.length === 0) {
    return { exitCode: 0, output: '', error: '' };
  }

  let output = '';
  let lastExitCode = 0;
  let lastError;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index > 0) {
      const operator = operators[index - 1];
      const lastSucceeded = lastExitCode === 0 && !lastError;
      if ((operator === '&&' && !lastSucceeded) || (operator === '||' && lastSucceeded)) {
        continue;
      }
    }

    const args = tokenize(segment);
    const cmd = args.shift();

    try {
      const result = spawnSync(cmd, args, {
        ...options,
        shell: false,
      });

      const segmentOutput = `${toText(result.stdout)}${toText(result.stderr)}`;
      output += segmentOutput;

      lastExitCode = typeof result.status === 'number' ? result.status : 1;
      lastError = result.error ? result.error.message : (lastExitCode !== 0 ? toText(result.stderr) : undefined);
    } catch (err) {
      lastExitCode = 1;
      lastError = err.message;
    }
  }

  if (lastExitCode !== 0 || lastError) {
    return {
      exitCode: lastExitCode || 1,
      output,
      error: lastError || '',
    };
  }

  return { exitCode: 0, output };
}

module.exports = {
  toText,
  tokenize,
  safeExecChain,
};
