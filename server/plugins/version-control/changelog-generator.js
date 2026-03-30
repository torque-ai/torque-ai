'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_CHANGELOG_FILE = 'CHANGELOG.md';
const DEFAULT_CHANGELOG_HEADER = '# Changelog\n\n';
const DEFAULT_VERSION = 'Unreleased';
const DEFAULT_FROM_DATE = '1970-01-01T00:00:00.000Z';
const SECTION_ENTRIES = [
  ['feat', 'Added'],
  ['fix', 'Fixed'],
  ['refactor', 'Changed'],
  ['docs', 'Documentation'],
  ['test', 'Testing'],
  ['chore', 'Maintenance'],
  ['style', 'Styling'],
];
const SECTION_ORDER = SECTION_ENTRIES.map(([, section]) => section);
const TYPE_TO_SECTION = new Map(SECTION_ENTRIES);

function resolveDbHandle(dbService) {
  const handle = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);

  if (!handle || typeof handle.prepare !== 'function') {
    throw new Error('createChangelogGenerator requires a db object with prepare()');
  }

  return handle;
}

function normalizeOptions(options) {
  return options && typeof options === 'object' ? options : {};
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeDateInput(value, fieldName, boundary = 'start') {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const rawValue = value instanceof Date ? value.toISOString() : String(value).trim();
  if (!rawValue) {
    return null;
  }

  const normalizedValue = /^\d{4}-\d{2}-\d{2}$/.test(rawValue)
    ? `${rawValue}T${boundary === 'end' ? '23:59:59.999' : '00:00:00.000'}Z`
    : rawValue;
  const parsedAt = Date.parse(normalizedValue);
  if (!Number.isFinite(parsedAt)) {
    throw new Error(`${fieldName} must be a valid date`);
  }

  return new Date(parsedAt).toISOString();
}

function formatDateOnly(value) {
  const normalized = normalizeDateInput(value, 'date', 'end');
  return normalized.slice(0, 10);
}

function runGit(repoPath, args) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function getTagDate(repoPath, tag) {
  const tagName = requireString(tag, 'tag');
  const output = runGit(repoPath, ['log', '-1', '--format=%cI', tagName]).trim();
  if (!output) {
    throw new Error(`unable to resolve date for tag: ${tagName}`);
  }

  return normalizeDateInput(output, 'tag', 'start');
}

function selectCommits(dbHandle, repoPath, fromDate, toDate) {
  const query = 'SELECT * FROM vc_commits WHERE repo_path = ? AND generated_at BETWEEN ? AND ? ORDER BY generated_at DESC';

  try {
    return dbHandle.prepare(query).all(repoPath, fromDate, toDate);
  } catch (error) {
    if (!/generated_at/i.test(String(error && error.message ? error.message : error))) {
      throw error;
    }

    return dbHandle.prepare(
      'SELECT *, created_at AS generated_at FROM vc_commits WHERE repo_path = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC'
    ).all(repoPath, fromDate, toDate);
  }
}

function stripConventionalPrefix(message) {
  return String(message || '').replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, '');
}

function toSentenceCase(text) {
  if (!text) {
    return 'Update repository state';
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeCommitMessage(message) {
  const firstLine = String(message || '')
    .split(/\r?\n/)
    .find((line) => line.trim());

  return toSentenceCase(stripConventionalPrefix(firstLine || '').trim());
}

function groupCommitsBySection(rows) {
  const grouped = new Map(SECTION_ORDER.map((section) => [section, []]));

  for (const row of rows) {
    const commitType = String(row && row.commit_type ? row.commit_type : '').trim().toLowerCase();
    const sectionName = TYPE_TO_SECTION.get(commitType);
    if (!sectionName) {
      continue;
    }

    grouped.get(sectionName).push(normalizeCommitMessage(row.message));
  }

  return grouped;
}

function buildChangelogText(version, dateText, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }

  const grouped = groupCommitsBySection(rows);
  const visibleSections = SECTION_ORDER.filter((section) => grouped.get(section).length > 0);
  if (visibleSections.length === 0) {
    return '';
  }

  const lines = [`## [${version}] - ${dateText}`, ''];
  for (const sectionName of visibleSections) {
    lines.push(`### ${sectionName}`);
    for (const entry of grouped.get(sectionName)) {
      lines.push(`- ${entry}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function extractSectionNames(changelogText) {
  return String(changelogText || '')
    .split(/\r?\n/)
    .map((line) => {
      const match = /^###\s+(.+?)\s*$/.exec(line.trim());
      return match ? match[1] : null;
    })
    .filter(Boolean);
}

function normalizeLineEndings(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

function resolveChangelogPath(repoPath, filePath) {
  const relativeOrAbsolutePath = normalizeOptionalString(filePath) || DEFAULT_CHANGELOG_FILE;
  return path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(repoPath, relativeOrAbsolutePath);
}

function findInsertionIndex(content) {
  const headerMatch = /^#\s+.+(?:\n|$)/m.exec(content);
  if (!headerMatch) {
    return 0;
  }

  let index = headerMatch.index + headerMatch[0].length;
  while (content[index] === '\n') {
    index += 1;
  }

  return index;
}

function createChangelogGenerator({ db } = {}) {
  const dbHandle = resolveDbHandle(db);

  function generateChangelog(repoPath, options = {}) {
    const repositoryPath = requireString(repoPath, 'repoPath');
    const config = normalizeOptions(options);
    const resolvedFromDate = normalizeDateInput(config.fromDate, 'fromDate', 'start')
      || (config.fromTag ? getTagDate(repositoryPath, config.fromTag) : DEFAULT_FROM_DATE);
    const resolvedToDate = normalizeDateInput(config.toDate, 'toDate', 'end')
      || (config.toTag ? getTagDate(repositoryPath, config.toTag) : new Date().toISOString());

    if (resolvedFromDate > resolvedToDate) {
      return '';
    }

    const version = normalizeOptionalString(config.version) || DEFAULT_VERSION;
    const headerDate = formatDateOnly(resolvedToDate);
    const commits = selectCommits(dbHandle, repositoryPath, resolvedFromDate, resolvedToDate);

    return buildChangelogText(version, headerDate, commits);
  }

  function updateChangelogFile(repoPath, version, changelogText, options = {}) {
    const repositoryPath = requireString(repoPath, 'repoPath');
    const normalizedVersion = requireString(version, 'version');
    const config = normalizeOptions(options);
    const filePath = resolveChangelogPath(repositoryPath, config.filePath);
    const createIfMissing = config.createIfMissing !== false;
    const nextBlock = normalizeLineEndings(changelogText).trim();

    if (!fs.existsSync(filePath)) {
      if (!createIfMissing) {
        throw new Error(`changelog file not found: ${filePath}`);
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, DEFAULT_CHANGELOG_HEADER, 'utf8');
    }

    if (!nextBlock) {
      return {
        path: filePath,
        version: normalizedVersion,
        sections: [],
      };
    }

    let existingContent = normalizeLineEndings(fs.readFileSync(filePath, 'utf8'));
    if (!existingContent.trim()) {
      existingContent = DEFAULT_CHANGELOG_HEADER;
    }

    if (!/^#\s+.+/m.test(existingContent)) {
      existingContent = `${DEFAULT_CHANGELOG_HEADER}${existingContent.replace(/^\n+/, '')}`;
    }

    const insertionIndex = findInsertionIndex(existingContent);
    const before = existingContent.slice(0, insertionIndex).replace(/\n*$/, '\n\n');
    const after = existingContent.slice(insertionIndex).replace(/^\n+/, '');
    let updatedContent = `${before}${nextBlock}`;

    if (after) {
      updatedContent += `\n\n${after}`;
    }

    if (!updatedContent.endsWith('\n')) {
      updatedContent += '\n';
    }

    fs.writeFileSync(filePath, updatedContent, 'utf8');

    return {
      path: filePath,
      version: normalizedVersion,
      sections: extractSectionNames(nextBlock),
    };
  }

  function getChangelogSinceTag(repoPath, tag) {
    const repositoryPath = requireString(repoPath, 'repoPath');
    const fromDate = getTagDate(repositoryPath, tag);
    return generateChangelog(repositoryPath, { fromDate });
  }

  return {
    generateChangelog,
    updateChangelogFile,
    getChangelogSinceTag,
  };
}

module.exports = { createChangelogGenerator };
