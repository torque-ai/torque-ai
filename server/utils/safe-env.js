/**
 * Safe environment variable builder for child processes.
 * Only passes through known-safe environment variables and
 * provider-specific keys. Blocks dangerous injection vectors.
 */

'use strict';

// Environment variables safe to pass to any child process
const SAFE_ENV_KEYS = new Set([
  // System paths
  'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR',
  // Locale
  'LANG', 'LC_ALL', 'LC_CTYPE',
  // Shell
  'SHELL', 'TERM', 'USER', 'LOGNAME',
  // Windows system
  'COMSPEC', 'SystemRoot', 'windir', 'OS',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'PATHEXT',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles',
  // Node
  'NODE_ENV', 'NODE_PATH', 'NVM_DIR', 'NVM_BIN',
  // Display
  'FORCE_COLOR', 'NO_COLOR',
  // CI
  'CI',
  // Git
  'GIT_TERMINAL_PROMPT',
  // Python
  'PYTHONIOENCODING',
  // SSH (for git operations)
  'SSH_AUTH_SOCK',
]);

// Per-provider keys that are legitimately needed
const PROVIDER_KEYS = {
  'codex':        ['OPENAI_API_KEY'],
  'claude-cli':   ['ANTHROPIC_API_KEY'],
  'aider-ollama': ['OLLAMA_HOST'],
  'anthropic':    ['ANTHROPIC_API_KEY'],
  'deepinfra':    ['DEEPINFRA_API_KEY'],
  'hyperbolic':   ['HYPERBOLIC_API_KEY'],
  'groq':         ['GROQ_API_KEY'],
  'google-ai':    ['GOOGLE_AI_API_KEY', 'GOOGLE_API_KEY'],
};

// Variables that MUST NEVER be passed regardless of provider
const BLOCKED_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_DEBUG',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'PERL5OPT',
  'BASH_ENV',
  'ENV',
  'CDPATH',
]);

/**
 * Build a filtered environment object for a child process.
 *
 * @param {string} [provider] - Provider name (e.g., 'codex', 'claude-cli').
 *   Used to determine which API keys to include.
 * @param {Object} [extras={}] - Additional env vars to merge on top.
 * @returns {Object} Filtered environment variables
 */
function buildSafeEnv(provider, extras = {}) {
  const env = {};

  // Copy only safe keys from process.env
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  // Add provider-specific keys
  if (provider && PROVIDER_KEYS[provider]) {
    for (const key of PROVIDER_KEYS[provider]) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
  }

  // Merge extras (task-specific overrides like TORQUE_TASK_ID)
  for (const [key, value] of Object.entries(extras)) {
    if (BLOCKED_KEYS.has(key)) {
      continue; // Silently drop blocked keys even from extras
    }
    if (value !== undefined && value !== null) {
      env[key] = String(value);
    }
  }

  // Final safety: ensure no blocked key got through
  for (const key of BLOCKED_KEYS) {
    delete env[key];
  }

  return env;
}

module.exports = {
  SAFE_ENV_KEYS,
  PROVIDER_KEYS,
  BLOCKED_KEYS,
  buildSafeEnv,
};
