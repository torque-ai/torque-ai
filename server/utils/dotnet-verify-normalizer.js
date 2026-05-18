'use strict';

const fs = require('fs');
const path = require('path');

function quoteShellArg(value) {
  const text = String(value ?? '');
  if (process.platform === 'win32') {
    if (text === '') return '""';
    if (!/[\s"^&|<>()%]/.test(text)) return text;
    return `"${text.replace(/"/g, '\\"')}"`;
  }
  if (text === '') return "''";
  if (/^[A-Za-z0-9_\-./@:=,+]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function tokenizeShellCommandWithSpans(command) {
  const text = String(command || '');
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;

    const start = i;
    let value = '';
    let quote = null;

    while (i < text.length) {
      const ch = text[i];
      if (!quote && /\s/.test(ch)) break;

      if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
        quote = quote === ch ? null : ch;
        i += 1;
        continue;
      }

      if (ch === '\\' && quote !== "'") {
        if (i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
          continue;
        }
      }

      value += ch;
      i += 1;
    }

    tokens.push({ value, start, end: i });
  }

  return tokens;
}

function isCommandSeparatorToken(value) {
  return ['&&', '||', ';', '|'].includes(value);
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative
    && !relative.startsWith('..')
    && !path.isAbsolute(relative)
  );
}

function findContainingCsproj(sourcePath, cwd) {
  if (!sourcePath || path.extname(sourcePath).toLowerCase() !== '.cs') return null;

  const root = path.resolve(cwd || process.cwd());
  const sourceAbsolute = path.resolve(root, sourcePath);
  if (!isPathInside(root, sourceAbsolute)) return null;

  try {
    const stat = fs.statSync(sourceAbsolute);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }

  let current = path.dirname(sourceAbsolute);
  while (isPathInside(root, current)) {
    let projects = [];
    try {
      projects = fs.readdirSync(current)
        .filter(name => path.extname(name).toLowerCase() === '.csproj')
        .map(name => path.join(current, name));
    } catch {
      return null;
    }

    if (projects.length === 1) return projects[0];

    if (projects.length > 1) {
      const directoryName = path.basename(current).toLowerCase();
      const matching = projects.find(project =>
        path.basename(project, '.csproj').toLowerCase() === directoryName
      );
      return matching || null;
    }

    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }

  return null;
}

function renderProjectPathForCommand(projectPath, cwd) {
  const root = path.resolve(cwd || process.cwd());
  const absoluteProjectPath = path.resolve(projectPath);
  const rendered = isPathInside(root, absoluteProjectPath)
    ? path.relative(root, absoluteProjectPath)
    : absoluteProjectPath;
  return rendered.replace(/\\/g, '/');
}

function normalizeDotnetTestSourceTargets(command, cwd) {
  const text = String(command || '');
  if (!/\bdotnet\s+test\b/i.test(text) || !/\.cs(?:\s|$|["'])/i.test(text)) {
    return text;
  }

  const tokens = tokenizeShellCommandWithSpans(text);
  const replacements = [];

  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i].value.toLowerCase() !== 'dotnet' || tokens[i + 1].value.toLowerCase() !== 'test') continue;

    for (let j = i + 2; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (isCommandSeparatorToken(token.value)) break;
      if (path.extname(token.value).toLowerCase() !== '.cs') continue;

      const projectPath = findContainingCsproj(token.value, cwd);
      if (!projectPath) continue;

      replacements.push({
        start: token.start,
        end: token.end,
        value: quoteShellArg(renderProjectPathForCommand(projectPath, cwd)),
      });
      break;
    }
  }

  if (replacements.length === 0) return text;

  let normalized = text;
  for (const replacement of replacements.reverse()) {
    normalized = `${normalized.slice(0, replacement.start)}${replacement.value}${normalized.slice(replacement.end)}`;
  }
  return normalized;
}

module.exports = {
  normalizeDotnetTestSourceTargets,
};
