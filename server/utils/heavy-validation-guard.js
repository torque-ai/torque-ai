'use strict';

const HEAVY_LOCAL_VALIDATION_PATTERNS = Object.freeze([
  { label: 'dotnet build', re: /\bdotnet\s+build\b/i },
  { label: 'dotnet test', re: /\bdotnet\s+test\b/i },
  { label: 'pwsh scripts/build.ps1', re: /\b(?:pwsh|powershell(?:\.exe)?)(?:\s+-file)?\s+(?:\.?[\\/])?scripts[\\/](?:build|test)\.ps1\b/i },
  { label: 'bash scripts/build.sh', re: /\b(?:bash|sh)\s+(?:\.?[\\/])?scripts[\\/](?:build|test)\.sh\b/i },
]);

function normalizeCommandText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/\\/g, '/')
    .replace(/(^|\s)\.\//g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCommandRoutedRemotely(line, commandIndex) {
  if (commandIndex < 0) return false;
  const prefix = line.slice(0, commandIndex);
  return prefix.lastIndexOf('torque-remote') !== -1;
}

function findFirstUnroutedCommand(text, commands) {
  const normalizedCommands = Array.from(new Set(
    (Array.isArray(commands) ? commands : [])
      .map(value => normalizeCommandText(value))
      .filter(Boolean)
  ));
  if (normalizedCommands.length === 0) {
    return null;
  }

  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = normalizeCommandText(rawLine);
    if (!line) continue;

    for (const command of normalizedCommands) {
      let commandIndex = line.indexOf(command);
      while (commandIndex !== -1) {
        if (!isCommandRoutedRemotely(line, commandIndex)) {
          return command;
        }
        commandIndex = line.indexOf(command, commandIndex + command.length);
      }
    }
  }

  return null;
}

function findHeavyLocalValidationCommand(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = normalizeCommandText(rawLine);
    if (!line) continue;

    for (const pattern of HEAVY_LOCAL_VALIDATION_PATTERNS) {
      const match = pattern.re.exec(line);
      if (!match) {
        continue;
      }

      if (isCommandRoutedRemotely(line, match.index)) {
        continue;
      }

      return rawLine.trim() || pattern.label;
    }
  }

  return null;
}

module.exports = {
  findFirstUnroutedCommand,
  findHeavyLocalValidationCommand,
};
