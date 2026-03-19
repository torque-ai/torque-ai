/**
 * Shell command policy — allowlist-based validation for user-provided shell commands.
 *
 * Prevents shell injection in verify_command, test_count_command, and similar
 * user-supplied strings that are passed to execSync/exec.
 */

'use strict';

// Allowed command prefixes (must appear at the start of a command segment)
const ALLOWED_PREFIXES = [
  'npm', 'npx', 'node', 'tsc', 'vitest', 'jest', 'pytest',
  'cargo', 'go', 'dotnet', 'gradle', 'mvn', 'make', 'cmake',
  'pnpm', 'yarn', 'bun', 'deno', 'ruby', 'python', 'python3',
  'eslint', 'prettier', 'mocha', 'tap',
];

// Dangerous shell metacharacters (reject if found outside of allowed `&&`)
const DANGEROUS_PATTERNS = [
  /;/,              // command chaining
  /\|/,             // pipe
  /`/,              // backtick execution
  /\$\(/,           // subshell
  /\$\{/,           // variable expansion
  />>/,             // append redirect
  /(?:^|[^&])>/,    // output redirect (but not &&>)
  /</,              // input redirect
];

/**
 * Split a command string on `&&` only when outside of single- or double-quoted strings.
 * Handles the common case of: npm run test -- --name "a && b"
 * @param {string} str
 * @returns {string[]}
 */
function splitOnAmpAmp(str) {
  const parts = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true;
      quoteChar = ch;
      current += ch;
    } else if (inQuote && ch === quoteChar) {
      inQuote = false;
      current += ch;
    } else if (!inQuote && ch === '&' && str[i + 1] === '&') {
      parts.push(current);
      current = '';
      i++; // skip second &
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Validate a shell command against the allowlist policy.
 *
 * Allows `&&` between allowlisted segments (e.g., "npx tsc --noEmit && npx vitest run").
 * Rejects shell metacharacters: `;`, `|`, backticks, `$()`, `>>`, `<`.
 *
 * @param {string} cmd - The command string to validate
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateShellCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') {
    return { ok: false, reason: 'Command is empty or not a string' };
  }

  const trimmed = cmd.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Command is empty' };
  }

  // Length sanity check
  if (trimmed.length > 2000) {
    return { ok: false, reason: 'Command exceeds maximum length (2000 chars)' };
  }

  // Split on && only outside quoted strings to avoid splitting on && inside arguments.
  // A naive .split('&&') would incorrectly split e.g. `npm run test -- --name "a && b"`.
  const segments = splitOnAmpAmp(trimmed).map(s => s.trim());

  for (const segment of segments) {
    if (segment.length === 0) {
      return { ok: false, reason: 'Empty command segment (double &&)' };
    }

    // Check for dangerous metacharacters within each segment
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(segment)) {
        return { ok: false, reason: `Shell metacharacter not allowed: ${pattern.source}` };
      }
    }

    // Extract the command name (first token)
    const firstToken = segment.split(/\s+/)[0].toLowerCase();

    // Check if it starts with an allowed prefix
    const isAllowed = ALLOWED_PREFIXES.some(prefix =>
      firstToken === prefix || firstToken.endsWith('/' + prefix) || firstToken.endsWith('\\' + prefix)
    );

    if (!isAllowed) {
      return { ok: false, reason: `Command '${firstToken}' is not in the allowlist. Allowed: ${ALLOWED_PREFIXES.join(', ')}` };
    }
  }

  return { ok: true };
}

module.exports = {
  validateShellCommand,
  ALLOWED_PREFIXES,
};
