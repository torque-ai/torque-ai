'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.stylus']);
const CHORE_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  'tsconfig.json',
  'jsconfig.json',
]);
const LARGE_CHANGE_THRESHOLD = 80;

function normalizePath(filePath) {
  return String(filePath || '')
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/\\/g, '/');
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function runGit(repoPath, args) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function parseSummary(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    const match = /^(\d+)\s+files?\schanged(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?$/.exec(line);
    if (match) {
      return {
        files: Number(match[1]),
        insertions: Number(match[2] || 0),
        deletions: Number(match[3] || 0),
      };
    }
  }

  return null;
}

function parseFileEntries(lines) {
  const entries = [];

  for (const rawLine of lines) {
    const separatorIndex = rawLine.indexOf('|');
    if (separatorIndex === -1) {
      continue;
    }

    const filePath = normalizePath(rawLine.slice(0, separatorIndex));
    const statText = rawLine.slice(separatorIndex + 1).trim();
    if (!filePath) {
      continue;
    }

    entries.push({ path: filePath, statText });
  }

  return entries;
}

function getDirSegments(filePath) {
  const normalized = normalizePath(filePath);
  if (!normalized) {
    return [];
  }

  const parts = normalized.split('/').filter(Boolean);
  return parts.slice(0, -1);
}

function longestCommonPrefix(listOfSegments) {
  if (listOfSegments.length === 0) {
    return [];
  }

  const prefix = [...listOfSegments[0]];
  for (let index = 1; index < listOfSegments.length; index += 1) {
    const candidate = listOfSegments[index];
    while (prefix.length > 0 && prefix.some((part, partIndex) => candidate[partIndex] !== part)) {
      prefix.pop();
    }

    if (prefix.length === 0) {
      return [];
    }
  }

  return prefix;
}

function detectScope(filePaths) {
  const directories = filePaths.map(getDirSegments).filter((segments) => segments.length > 0);
  if (directories.length === 0) {
    return null;
  }

  if (directories.length === filePaths.length) {
    const sharedPrefix = longestCommonPrefix(directories);
    if (sharedPrefix.length > 0) {
      return sharedPrefix[sharedPrefix.length - 1];
    }
  }

  const counts = new Map();
  for (const segments of directories) {
    const scopeName = segments[segments.length - 1];
    counts.set(scopeName, (counts.get(scopeName) || 0) + 1);
  }

  let highestCount = 0;
  let selectedScope = null;
  let hasTie = false;

  for (const [scopeName, count] of counts.entries()) {
    if (count > highestCount) {
      highestCount = count;
      selectedScope = scopeName;
      hasTie = false;
      continue;
    }

    if (count === highestCount) {
      hasTie = true;
    }
  }

  return hasTie ? null : selectedScope;
}

function allEntriesMatch(entries, predicate) {
  return entries.length > 0 && entries.every((entry) => predicate(entry.path));
}

function isTestPath(filePath) {
  const normalized = normalizePath(filePath).toLowerCase();
  return /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)/.test(normalized)
    || /(^|\/)[^/]+\.(test|spec)\.[^/]+$/.test(normalized);
}

function isDocPath(filePath) {
  const normalized = normalizePath(filePath);
  const lowerPath = normalized.toLowerCase();
  const baseName = path.posix.basename(lowerPath);
  const extension = path.posix.extname(lowerPath);

  return DOC_EXTENSIONS.has(extension)
    || lowerPath.startsWith('docs/')
    || baseName === 'readme'
    || baseName === 'readme.md'
    || baseName === 'changelog'
    || baseName === 'changelog.md';
}

function isStylePath(filePath) {
  const lowerPath = normalizePath(filePath).toLowerCase();
  const extension = path.posix.extname(lowerPath);

  return STYLE_EXTENSIONS.has(extension) || /(^|\/)(style|styles)(\/|$)/.test(lowerPath);
}

function isChorePath(filePath) {
  const lowerPath = normalizePath(filePath).toLowerCase();
  const baseName = path.posix.basename(lowerPath);

  return CHORE_FILES.has(baseName)
    || lowerPath.startsWith('.github/')
    || lowerPath.startsWith('.vscode/');
}

function isInsertOnlyStat(statText) {
  const normalized = String(statText || '').trim();
  if (!normalized) {
    return false;
  }

  if (/^Bin\b/i.test(normalized)) {
    return /\b0\s*->\s*[1-9]/.test(normalized);
  }

  const markers = normalized.replace(/^\d+\s+/, '');
  return markers.includes('+') && !markers.includes('-');
}

function detectType(entries, insertions, deletions) {
  if (entries.length === 0) {
    return 'chore';
  }

  if (allEntriesMatch(entries, isTestPath)) {
    return 'test';
  }

  if (allEntriesMatch(entries, isDocPath)) {
    return 'docs';
  }

  if (allEntriesMatch(entries, isStylePath)) {
    return 'style';
  }

  if (allEntriesMatch(entries, isChorePath)) {
    return 'chore';
  }

  const hasLikelyNewSourceFile = entries.some((entry) => isInsertOnlyStat(entry.statText)
    && !isTestPath(entry.path)
    && !isDocPath(entry.path)
    && !isStylePath(entry.path)
    && !isChorePath(entry.path));

  if (hasLikelyNewSourceFile) {
    return 'feat';
  }

  if (insertions + deletions >= LARGE_CHANGE_THRESHOLD || entries.length >= 8) {
    return 'refactor';
  }

  return 'fix';
}

function buildSubject(analysis) {
  const fileCount = Number.isFinite(analysis.files) ? analysis.files : 0;
  const fileLabel = `${fileCount} file${fileCount === 1 ? '' : 's'}`;

  switch (analysis.type) {
    case 'feat':
      return fileCount > 0 ? `add ${fileLabel}` : 'add changes';
    case 'test':
      return fileCount > 0 ? `update ${fileCount} test file${fileCount === 1 ? '' : 's'}` : 'update tests';
    case 'docs':
      return 'update documentation';
    case 'style':
      return fileCount > 0 ? `format ${fileLabel}` : 'format source';
    case 'chore':
      return 'update project configuration';
    case 'refactor':
      return fileCount > 0 ? `refactor ${fileLabel}` : 'refactor code';
    case 'fix':
    default:
      return fileCount > 0 ? `update ${fileLabel}` : 'update tracked changes';
  }
}

function buildCommitMessage(analysis, body, coAuthor) {
  const scope = analysis.scope ? `(${analysis.scope})` : '';
  const sections = [`${analysis.type}${scope}: ${buildSubject(analysis)}`];

  if (body) {
    sections.push(body);
  }

  if (coAuthor) {
    sections.push(`Co-authored-by: ${coAuthor}`);
  }

  return sections.join('\n\n');
}

function analyzeChanges(diffOutput) {
  const text = typeof diffOutput === 'string' ? diffOutput : String(diffOutput || '');
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const entries = parseFileEntries(lines);
  const summary = parseSummary(lines);
  const files = summary ? summary.files : entries.length;
  const insertions = summary ? summary.insertions : 0;
  const deletions = summary ? summary.deletions : 0;

  return {
    type: detectType(entries, insertions, deletions),
    scope: detectScope(entries.map((entry) => entry.path)),
    files,
    insertions,
    deletions,
  };
}

function generateCommitMessage(input = {}) {
  const repoPath = normalizeOptionalString(input.repoPath);
  if (!repoPath) {
    throw new Error('repoPath is required');
  }

  const diffOutput = runGit(repoPath, ['diff', '--cached', '--stat']);
  const analysis = analyzeChanges(diffOutput);
  if (analysis.files === 0) {
    return {
      success: false,
      commitHash: null,
      message: null,
      analysis,
    };
  }

  const message = buildCommitMessage(
    analysis,
    normalizeOptionalString(input.body),
    normalizeOptionalString(input.coAuthor),
  );

  try {
    runGit(repoPath, ['commit', '-m', message]);
    const commitHash = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

    return {
      success: true,
      commitHash,
      message,
      analysis,
    };
  } catch {
    return {
      success: false,
      commitHash: null,
      message,
      analysis,
    };
  }
}

function createCommitGenerator() {
  return {
    analyzeChanges,
    generateCommitMessage,
  };
}

module.exports = { createCommitGenerator };
