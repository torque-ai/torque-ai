'use strict';
/* eslint-disable torque/no-sync-fs-on-hot-paths -- command-policy sync calls are in capability-detection paths run at task startup; Phase 2 async conversion tracked separately. */

const path = require('path');
const childProcess = require('child_process');
const logger = require('../logger').child({ component: 'command-policy' });

const SHELL_METACHARACTERS = [
  { token: '&&', pattern: /&&/ },
  { token: '||', pattern: /\|\|/ },
  { token: ';', pattern: /;/ },
  { token: '|', pattern: /\|/ },
  { token: '`', pattern: /`/ },
  { token: '$()', pattern: /\$\(/ },
];

const COMMAND_PROFILES = {
  safe_verify: [
    {
      name: 'npx tsc',
      match: (cmd, args) => isExecutable(cmd, 'npx') && matchesArg(args, 0, 'tsc'),
    },
    {
      name: 'npx vitest',
      match: (cmd, args) => isExecutable(cmd, 'npx') && matchesArg(args, 0, 'vitest'),
    },
    {
      name: 'npm test',
      match: (cmd, args) => isExecutable(cmd, 'npm') && matchesArg(args, 0, 'test'),
    },
    {
      name: 'pytest',
      match: (cmd) => isExecutable(cmd, 'pytest'),
    },
    {
      name: 'python -m pytest',
      match: (cmd, args) => isPythonExecutable(cmd) && matchesPythonModule(args, 'pytest'),
    },
    {
      name: 'node --check',
      match: (cmd, args) => isExecutable(cmd, 'node') && matchesArg(args, 0, '--check'),
    },
    {
      name: 'git diff',
      match: (cmd, args) => isExecutable(cmd, 'git') && matchesArg(args, 0, 'diff'),
    },
    {
      name: 'git status',
      match: (cmd, args) => isExecutable(cmd, 'git') && matchesArg(args, 0, 'status'),
    },
    {
      name: 'git log',
      match: (cmd, args) => isExecutable(cmd, 'git') && matchesArg(args, 0, 'log'),
    },
    {
      name: 'gh run view',
      match: (cmd, args) => isExecutable(cmd, 'gh') && matchesArg(args, 0, 'run') && matchesArg(args, 1, 'view'),
    },
    {
      name: 'gh run list',
      match: (cmd, args) => isExecutable(cmd, 'gh') && matchesArg(args, 0, 'run') && matchesArg(args, 1, 'list'),
    },
    {
      name: 'gh run watch',
      match: (cmd, args) => isExecutable(cmd, 'gh') && matchesArg(args, 0, 'run') && matchesArg(args, 1, 'watch'),
    },
    {
      name: 'gh auth status',
      match: (cmd, args) => isExecutable(cmd, 'gh') && matchesArg(args, 0, 'auth') && matchesArg(args, 1, 'status'),
    },
    // .NET ecosystem
    {
      name: 'dotnet',
      match: (cmd) => isExecutable(cmd, 'dotnet'),
    },
    {
      name: 'pwsh',
      match: (cmd) => isExecutable(cmd, 'pwsh'),
    },
  ],
  build: [
    {
      name: 'npm run build',
      match: (cmd, args) => isExecutable(cmd, 'npm') && matchesArg(args, 0, 'run') && matchesArg(args, 1, 'build'),
    },
    {
      name: 'npm install',
      match: (cmd, args) => isExecutable(cmd, 'npm') && matchesArg(args, 0, 'install'),
    },
  ],
  advanced_shell: null,
};

COMMAND_PROFILES.build = [
  ...COMMAND_PROFILES.safe_verify,
  ...COMMAND_PROFILES.build,
];

function tokenizeCommandString(commandString) {
  const tokens = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < commandString.length; i += 1) {
    const char = commandString[i];

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === '\\' && i + 1 < commandString.length) {
        current += commandString[i + 1];
        i += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function normalizeStringArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== undefined && entry !== null)
      .map((entry) => String(entry));
  }
  return [String(value)];
}

function extractCommandRequest(command, args, extraContext = {}) {
  let rawCommand = command;
  let rawArgs = args;
  let context = { ...extraContext };

  if (rawCommand && typeof rawCommand === 'object' && !Array.isArray(rawCommand)) {
    const commandSpec = rawCommand;
    if (typeof commandSpec.cmd === 'string' || typeof commandSpec.command === 'string') {
      rawCommand = commandSpec.cmd || commandSpec.command;
      if (rawArgs === undefined && commandSpec.args !== undefined) {
        rawArgs = commandSpec.args;
      }
      const { cmd, command: ignoredCommand, args: ignoredArgs, ...commandContext } = commandSpec;
      void cmd;
      void ignoredCommand;
      void ignoredArgs;
      context = { ...commandContext, ...context };
    }
  }

  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    const argsSpec = rawArgs;
    rawArgs = argsSpec.args;
    const { args: ignoredArgs, ...argsContext } = argsSpec;
    void ignoredArgs;
    context = { ...argsContext, ...context };
  }

  const commandText = typeof rawCommand === 'string' ? rawCommand.trim() : '';
  if (!commandText) {
    return { error: 'Command is empty or not a string' };
  }

  const commandTokens = tokenizeCommandString(commandText);
  if (commandTokens.length === 0) {
    return { error: 'Command is empty' };
  }

  return {
    commandText,
    cmd: commandTokens[0],
    args: [...commandTokens.slice(1), ...normalizeStringArray(rawArgs)],
    context,
  };
}

function normalizeExecutable(command) {
  return path.basename(String(command || ''))
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
}

function isExecutable(command, expected) {
  return normalizeExecutable(command) === expected;
}

function isPythonExecutable(command) {
  const normalized = normalizeExecutable(command);
  return normalized === 'py'
    || normalized === 'python'
    || normalized === 'python3'
    || /^python\d+(?:\.\d+)*$/.test(normalized);
}

function matchesArg(args, index, expected) {
  return typeof args[index] === 'string' && args[index].toLowerCase() === expected;
}

function matchesPythonModule(args, expectedModule) {
  let index = 0;
  while (typeof args[index] === 'string' && args[index].startsWith('-') && args[index].toLowerCase() !== '-m') {
    index += 1;
  }
  return matchesArg(args, index, '-m') && matchesArg(args, index + 1, expectedModule);
}

function findShellMetacharacter(commandText, args) {
  const values = [commandText, ...args].filter((value) => typeof value === 'string');
  for (const value of values) {
    for (const rule of SHELL_METACHARACTERS) {
      if (rule.pattern.test(value)) {
        return rule.token;
      }
    }
  }
  return null;
}

function getShellScriptFromRequest(request) {
  const shell = normalizeExecutable(request.cmd);
  const args = Array.isArray(request.args) ? request.args : [];

  if (shell === 'cmd') {
    let index = 0;
    while (typeof args[index] === 'string' && ['/d', '/s'].includes(args[index].toLowerCase())) {
      index += 1;
    }
    if (typeof args[index] !== 'string' || args[index].toLowerCase() !== '/c') {
      return { error: 'cmd wrappers must use /c with an allowlisted command' };
    }
    if (args.length !== index + 2 || typeof args[index + 1] !== 'string' || !args[index + 1].trim()) {
      return { error: 'cmd /c requires exactly one command string' };
    }
    return { script: args[index + 1] };
  }

  if (shell === 'sh' || shell === 'bash') {
    if (typeof args[0] !== 'string' || !['-c', '-lc'].includes(args[0].toLowerCase())) {
      return { error: `${shell} wrappers must use -c with an allowlisted command` };
    }
    if (args.length !== 2 || typeof args[1] !== 'string' || !args[1].trim()) {
      return { error: `${shell} ${args[0]} requires exactly one command string` };
    }
    return { script: args[1] };
  }

  return null;
}

function splitAndChain(commandText) {
  const parts = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < commandText.length; i += 1) {
    const char = commandText[i];
    const next = commandText[i + 1];

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '&' && next === '&') {
      const trimmed = current.trim();
      if (!trimmed) {
        return { error: 'Empty command in && chain' };
      }
      parts.push(trimmed);
      current = '';
      i += 1;
      continue;
    }

    current += char;
  }

  if (quote) {
    return { error: 'Unterminated quote in shell command chain' };
  }

  const trimmed = current.trim();
  if (!trimmed) {
    return { error: 'Empty command in && chain' };
  }
  parts.push(trimmed);
  return { parts };
}

function validateAllowlistedShellChain(request, profile) {
  const shellScript = getShellScriptFromRequest(request);
  if (!shellScript) return null;
  if (shellScript.error) return { allowed: false, reason: shellScript.error };

  const split = splitAndChain(shellScript.script);
  if (split.error) return { allowed: false, reason: split.error };

  const rules = COMMAND_PROFILES[profile] || [];
  for (const part of split.parts) {
    const segment = extractCommandRequest(part, [], request.context);
    if (segment.error) return { allowed: false, reason: segment.error };

    if (getShellScriptFromRequest(segment)) {
      return { allowed: false, reason: 'Nested shell wrappers are not allowed for safe verification' };
    }

    const metacharacter = findShellMetacharacter(segment.commandText, segment.args);
    if (metacharacter) {
      return { allowed: false, reason: `Shell metacharacter '${metacharacter}' is not allowed for profile '${profile}'` };
    }

    const matchesProfile = rules.some((rule) => rule.match(segment.cmd, segment.args));
    if (!matchesProfile) {
      return { allowed: false, reason: `Command '${describeCommand(segment.cmd, segment.args)}' is not allowed for profile '${profile}'` };
    }
  }

  return { allowed: true };
}

function describeCommand(cmd, args) {
  return [cmd, ...args].join(' ').trim();
}

function logDecision(level, message, meta) {
  logger[level](`[command-policy] ${message}`, {
    source: meta.source || 'unknown',
    caller: meta.caller || 'unknown',
    profile: meta.profile,
    dangerous: meta.dangerous === true,
    command: meta.command,
    args: meta.args,
    reason: meta.reason,
  });
}

function validateCommand(command, args, profile = 'safe_verify', extraContext = {}) {
  const request = extractCommandRequest(command, args, extraContext);
  if (request.error) {
    return { allowed: false, reason: request.error };
  }

  const meta = {
    source: request.context.source,
    caller: request.context.caller,
    profile,
    dangerous: request.context.dangerous === true,
    command: request.cmd,
    args: request.args,
  };

  if (!Object.prototype.hasOwnProperty.call(COMMAND_PROFILES, profile)) {
    meta.reason = `Unknown command profile '${profile}'`;
    logDecision('warn', 'blocked command validation', meta);
    return { allowed: false, reason: meta.reason };
  }

  if (profile === 'advanced_shell') {
    if (!meta.dangerous) {
      meta.reason = 'advanced_shell requires dangerous: true';
      logDecision('warn', 'blocked command validation', meta);
      return { allowed: false, reason: meta.reason };
    }

    logDecision('debug', 'allowed advanced command', meta);
    return { allowed: true };
  }

  const shellChainValidation = validateAllowlistedShellChain(request, profile);
  if (shellChainValidation) {
    if (shellChainValidation.allowed) {
      logDecision('debug', 'allowed shell command chain', meta);
      return { allowed: true };
    }
    meta.reason = shellChainValidation.reason;
    logDecision('warn', 'blocked command validation', meta);
    return { allowed: false, reason: meta.reason };
  }

  const metacharacter = findShellMetacharacter(request.commandText, request.args);
  if (metacharacter) {
    meta.reason = `Shell metacharacter '${metacharacter}' is not allowed for profile '${profile}'`;
    logDecision('warn', 'blocked command validation', meta);
    return { allowed: false, reason: meta.reason };
  }

  const rules = COMMAND_PROFILES[profile] || [];
  const matchesProfile = rules.some((rule) => rule.match(request.cmd, request.args));
  if (!matchesProfile) {
    meta.reason = `Command '${describeCommand(request.cmd, request.args)}' is not allowed for profile '${profile}'`;
    logDecision('warn', 'blocked command validation', meta);
    return { allowed: false, reason: meta.reason };
  }

  logDecision('debug', 'allowed command', meta);
  return { allowed: true };
}

function buildExecOptions(options) {
  return {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  };
}

function createRejectedCommandError(reason) {
  const error = new Error(reason);
  error.code = 'COMMAND_POLICY_REJECTED';
  return error;
}

async function executeValidatedCommand(command, args = [], options = {}) {
  const {
    profile = 'safe_verify',
    dangerous = false,
    source,
    caller,
    ...execOptions
  } = options || {};

  // Pass options as the 'args' parameter to validateCommand — extractCommandRequest
  // accepts an object shape `{ args, ...context }` and destructures it internally,
  // promoting dangerous/source/caller into the validation context. This coupling
  // is intentional; the function signature is designed for both array and object forms.
  const validation = validateCommand(command, { args, dangerous, source, caller }, profile);
  if (!validation.allowed) {
    throw createRejectedCommandError(validation.reason);
  }

  const request = extractCommandRequest(command, args);
  if (request.error) {
    throw createRejectedCommandError(request.error);
  }

  return new Promise((resolve, reject) => {
    childProcess.execFile(
      request.cmd,
      request.args,
      buildExecOptions(execOptions),
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr, cmd: request.cmd, args: request.args });
      }
    );
  });
}

function executeValidatedCommandSync(command, args = [], options = {}) {
  const {
    profile = 'safe_verify',
    dangerous = false,
    source,
    caller,
    ...execOptions
  } = options || {};

  const validation = validateCommand(command, { args, dangerous, source, caller }, profile);
  if (!validation.allowed) {
    throw createRejectedCommandError(validation.reason);
  }

  const request = extractCommandRequest(command, args);
  if (request.error) {
    throw createRejectedCommandError(request.error);
  }

  return childProcess.execFileSync(
    request.cmd,
    request.args,
    buildExecOptions(execOptions)
  );
}

module.exports = {
  COMMAND_PROFILES,
  validateCommand,
  executeValidatedCommand,
  executeValidatedCommandSync,
};
