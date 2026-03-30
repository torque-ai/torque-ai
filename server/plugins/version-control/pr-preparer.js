'use strict';

const { execFileSync } = require('child_process');

const DEFAULT_TARGET_BRANCH = 'main';
const TYPE_ORDER = ['feat', 'fix', 'docs', 'test', 'refactor', 'chore'];
const TYPE_TITLES = {
  feat: 'Features',
  fix: 'Fixes',
  docs: 'Documentation',
  test: 'Tests',
  refactor: 'Refactoring',
  chore: 'Maintenance',
};
const LABEL_BY_TYPE = {
  feat: 'enhancement',
  fix: 'bug',
  docs: 'documentation',
  test: 'testing',
  refactor: 'refactoring',
  chore: 'maintenance',
};
const BRANCH_PREFIX_PATTERN = /^(?:feat|fix|docs|doc|test|tests|refactor|chore|perf|style|ci|build|hotfix|feature|bugfix|release)\//i;
const CONVENTIONAL_SUBJECT_PATTERN = /^([a-z]+)(?:\([^)]+\))?(!)?:\s*(.+)$/i;

function requireRepoPath(repoPath) {
  if (typeof repoPath !== 'string' || !repoPath.trim()) {
    throw new Error('repoPath is required');
  }

  return repoPath.trim();
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

function getCurrentBranch(repoPath) {
  return runGit(repoPath, ['branch', '--show-current']).trim();
}

function parseSubject(subject) {
  const trimmed = String(subject || '').trim();
  const match = CONVENTIONAL_SUBJECT_PATTERN.exec(trimmed);
  if (!match) {
    return {
      type: 'other',
      description: trimmed,
    };
  }

  return {
    type: match[1].toLowerCase(),
    description: match[3].trim(),
  };
}

function parseCommitLine(line) {
  const separatorIndex = line.indexOf('|');
  if (separatorIndex === -1) {
    return null;
  }

  const hash = line.slice(0, separatorIndex).trim();
  const subject = line.slice(separatorIndex + 1).trim();
  if (!hash || !subject) {
    return null;
  }

  const parsedSubject = parseSubject(subject);
  return {
    hash,
    subject,
    type: parsedSubject.type,
  };
}

function parseCommits(logOutput) {
  return String(logOutput || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseCommitLine)
    .filter(Boolean);
}

function humanizeBranchName(branchName) {
  const trimmed = normalizeOptionalString(branchName) || '';
  const withoutPrefix = trimmed.replace(BRANCH_PREFIX_PATTERN, '');
  const text = withoutPrefix
    .replace(/[\/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return 'Update';
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildLabels(commits) {
  const seen = new Set();
  const labels = [];

  for (const commit of commits) {
    const label = LABEL_BY_TYPE[commit.type];
    if (!label || seen.has(label)) {
      continue;
    }

    seen.add(label);
    labels.push(label);
  }

  return labels;
}

function getGroupHeading(type) {
  if (TYPE_TITLES[type]) {
    return TYPE_TITLES[type];
  }

  if (!type || type === 'other') {
    return 'Other';
  }

  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatCommitLine(commit, includeCommitHashes) {
  const parsedSubject = parseSubject(commit.subject);
  const description = parsedSubject.description || commit.subject;

  if (includeCommitHashes && commit.hash) {
    return `- \`${commit.hash}\` ${description}`;
  }

  return `- ${description}`;
}

function buildDiffStat(repoPath, sourceBranch, targetBranch) {
  const diffArgs = ['diff', '--stat'];
  if (sourceBranch) {
    diffArgs.push(`${targetBranch}..${sourceBranch}`);
  }

  return runGit(repoPath, diffArgs).trim();
}

function getOrderedTypes(groupedCommits) {
  const remainingTypes = Array.from(groupedCommits.keys())
    .filter((type) => !TYPE_ORDER.includes(type))
    .sort();

  return TYPE_ORDER.filter((type) => groupedCommits.has(type)).concat(remainingTypes);
}

function indentCodeBlock(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => `    ${line}`)
    .join('\n');
}

function formatPrBody(commits, options = {}) {
  const includeCommitHashes = options.includeCommitHashes !== false;
  const includeDiffStat = options.includeDiffStat !== false;
  const commitList = Array.isArray(commits) ? commits.filter(Boolean) : [];

  if (commitList.length === 0) {
    return '';
  }

  const groupedCommits = new Map();
  for (const commit of commitList) {
    const type = normalizeOptionalString(commit.type) || parseSubject(commit.subject).type;
    if (!groupedCommits.has(type)) {
      groupedCommits.set(type, []);
    }

    groupedCommits.get(type).push(commit);
  }

  const sections = [];
  for (const type of getOrderedTypes(groupedCommits)) {
    const lines = groupedCommits.get(type).map((commit) => formatCommitLine(commit, includeCommitHashes));
    sections.push(`### ${getGroupHeading(type)}\n${lines.join('\n')}`);
  }

  const repoPath = normalizeOptionalString(options.repoPath);
  if (includeDiffStat && repoPath) {
    const sourceBranch = normalizeOptionalString(options.sourceBranch);
    const targetBranch = normalizeOptionalString(options.targetBranch) || DEFAULT_TARGET_BRANCH;
    const diffStat = buildDiffStat(repoPath, sourceBranch, targetBranch);

    if (diffStat) {
      sections.push(`### Diff Stat\n${indentCodeBlock(diffStat)}`);
    }
  }

  return sections.join('\n\n').trim();
}

function preparePr(repoPath, sourceBranch, targetBranch) {
  const repositoryPath = requireRepoPath(repoPath);
  const resolvedSourceBranch = normalizeOptionalString(sourceBranch) || getCurrentBranch(repositoryPath);
  const resolvedTargetBranch = normalizeOptionalString(targetBranch) || DEFAULT_TARGET_BRANCH;
  const range = `${resolvedTargetBranch}..${resolvedSourceBranch}`;
  const logOutput = runGit(repositoryPath, ['log', range, '--oneline', '--format=%H|%s']);
  const commits = parseCommits(logOutput);

  return {
    title: humanizeBranchName(resolvedSourceBranch),
    body: formatPrBody(commits, {
      includeCommitHashes: true,
      includeDiffStat: true,
      repoPath: repositoryPath,
      sourceBranch: resolvedSourceBranch,
      targetBranch: resolvedTargetBranch,
    }),
    labels: buildLabels(commits),
    commits,
  };
}

function createPrPreparer() {
  return {
    preparePr,
    formatPrBody,
  };
}

module.exports = { createPrPreparer };
