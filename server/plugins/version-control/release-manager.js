'use strict';

const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_START_VERSION = '0.1.0';
const NO_TAGS_ERROR_PATTERN = /no names found|cannot describe anything|no tags can describe/i;
const BREAKING_CHANGE_PATTERN = /BREAKING CHANGE|BREAKING:/i;
const MESSAGE_TYPE_PATTERN = /^([a-z]+)(?:\([^)]+\))?!?:/i;
const PRERELEASE_PATTERN = /^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/;
const TAG_EXISTS_PATTERN = /tag ['"][^'"]+['"] already exists|already exists/i;

function resolveDbHandle(dbService) {
  const handle = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);

  if (!handle || typeof handle.prepare !== 'function') {
    throw new Error('createReleaseManager requires a db object with prepare()');
  }

  return handle;
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function normalizeOptions(options) {
  return options && typeof options === 'object' ? options : {};
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

function isNoTagsError(error) {
  const details = [
    typeof error?.message === 'string' ? error.message : '',
    typeof error?.stderr === 'string' ? error.stderr : '',
    typeof error?.stdout === 'string' ? error.stdout : '',
  ].join('\n');

  return NO_TAGS_ERROR_PATTERN.test(details);
}

function isTagAlreadyExistsError(error) {
  const details = [
    typeof error?.message === 'string' ? error.message : '',
    typeof error?.stderr === 'string' ? error.stderr : '',
    typeof error?.stdout === 'string' ? error.stdout : '',
  ].join('\n');

  return TAG_EXISTS_PATTERN.test(details);
}

function parseSemver(value, fieldName, options = {}) {
  const allowPrerelease = options.allowPrerelease === true;
  const normalized = requireString(value, fieldName);
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(normalized);
  if (!match) {
    throw new Error(`${fieldName} must be a semantic version like 1.2.3`);
  }

  if (match[4] && !allowPrerelease) {
    throw new Error(`${fieldName} must be a semantic version like 1.2.3`);
  }

  const parsed = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
  };

  return {
    text: `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ''}`,
    version: parsed,
  };
}

function formatBaseVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function bumpPatchVersionText(versionText) {
  const parsed = parseSemver(versionText, 'version');
  return formatBaseVersion({
    major: parsed.version.major,
    minor: parsed.version.minor,
    patch: parsed.version.patch + 1,
  });
}

function normalizePrerelease(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }

  if (!PRERELEASE_PATTERN.test(normalized)) {
    throw new Error('prerelease must contain only alphanumeric, dash, and dot characters');
  }

  return normalized;
}

function applyBump(version, bump) {
  if (bump === 'major') {
    return {
      major: version.major + 1,
      minor: 0,
      patch: 0,
    };
  }

  if (bump === 'minor') {
    return {
      major: version.major,
      minor: version.minor + 1,
      patch: 0,
    };
  }

  return {
    major: version.major,
    minor: version.minor,
    patch: version.patch + 1,
  };
}

function normalizeCommitType(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }

  const match = /^[a-z]+/i.exec(normalized);
  return match ? match[0].toLowerCase() : normalized.toLowerCase();
}

function inferCommitTypeFromMessage(message) {
  const normalized = normalizeOptionalString(message);
  if (!normalized) {
    return null;
  }

  const match = MESSAGE_TYPE_PATTERN.exec(normalized);
  return match ? match[1].toLowerCase() : null;
}

function getVcCommitColumns(dbHandle) {
  try {
    return dbHandle.prepare("PRAGMA table_info('vc_commits')").all().map((column) => column.name);
  } catch {
    return [];
  }
}

function getCommitTimestampColumn(dbHandle) {
  const columns = getVcCommitColumns(dbHandle);
  if (columns.includes('generated_at')) {
    return 'generated_at';
  }

  if (columns.includes('created_at')) {
    return 'created_at';
  }

  return 'generated_at';
}

function getLatestTagDate(repoPath, tag) {
  const trimmedTag = requireString(tag, 'tag');
  const output = runGit(repoPath, ['for-each-ref', `refs/tags/${trimmedTag}`, '--format=%(creatordate:iso-strict)']).trim();
  if (output) {
    return output;
  }

  return runGit(repoPath, ['log', '-1', '--format=%cI', trimmedTag]).trim();
}

function collectCommitRows(dbHandle, repoPath, sinceTimestamp) {
  const timestampColumn = getCommitTimestampColumn(dbHandle);
  return dbHandle
    .prepare(`SELECT commit_type, message FROM vc_commits WHERE repo_path = ? AND ${timestampColumn} > ?`)
    .all(repoPath, sinceTimestamp);
}

function analyzeCommits(rows) {
  const relevantRows = Array.isArray(rows)
    ? rows.filter((row) => normalizeCommitType(row?.commit_type) !== 'release')
    : [];
  const breakdown = {};

  let hasBreakingChange = false;
  let hasFeature = false;

  for (const row of relevantRows) {
    const message = typeof row?.message === 'string' ? row.message : '';
    const commitType = normalizeCommitType(row?.commit_type) || inferCommitTypeFromMessage(message) || 'unknown';
    breakdown[commitType] = (breakdown[commitType] || 0) + 1;

    if (BREAKING_CHANGE_PATTERN.test(message)) {
      hasBreakingChange = true;
    }

    if (commitType === 'feat') {
      hasFeature = true;
    }
  }

  return {
    bump: hasBreakingChange ? 'major' : (hasFeature ? 'minor' : 'patch'),
    commitCount: relevantRows.length,
    breakdown,
  };
}

function insertCommitRecord(dbHandle, record) {
  const columns = getVcCommitColumns(dbHandle);
  const availableColumns = new Set(
    columns.length > 0
      ? columns
      : ['id', 'repo_path', 'branch', 'commit_hash', 'message', 'commit_type', 'scope', 'created_at'],
  );
  const timestampColumn = availableColumns.has('generated_at') ? 'generated_at' : 'created_at';
  const orderedColumns = [
    'id',
    'repo_path',
    'branch',
    'commit_hash',
    'message',
    'commit_type',
    'scope',
    'created_at',
    'generated_at',
  ].filter((column, index, list) => availableColumns.has(column) && list.indexOf(column) === index);
  const placeholders = orderedColumns.map(() => '?').join(', ');
  const values = orderedColumns.map((column) => {
    if (column === 'created_at' || column === 'generated_at') {
      return record[timestampColumn];
    }

    return Object.prototype.hasOwnProperty.call(record, column) ? record[column] : null;
  });

  dbHandle.prepare(`INSERT INTO vc_commits (${orderedColumns.join(', ')}) VALUES (${placeholders})`).run(...values);
}

function createReleaseManager({ db } = {}) {
  const dbHandle = resolveDbHandle(db);

  function getLatestTag(repoPath) {
    const normalizedRepoPath = requireString(repoPath, 'repoPath');

    try {
      const tag = runGit(normalizedRepoPath, ['describe', '--tags', '--abbrev=0']).trim();
      const parsed = parseSemver(tag, 'tag');

      return {
        tag,
        version: {
          major: parsed.version.major,
          minor: parsed.version.minor,
          patch: parsed.version.patch,
        },
      };
    } catch (error) {
      if (isNoTagsError(error)) {
        return null;
      }

      throw error;
    }
  }

  function inferNextVersion(repoPath, options = {}) {
    const normalizedRepoPath = requireString(repoPath, 'repoPath');
    const normalizedOptions = normalizeOptions(options);
    const startVersion = parseSemver(normalizedOptions.startVersion || DEFAULT_START_VERSION, 'startVersion');
    const prerelease = normalizePrerelease(normalizedOptions.prerelease);
    const latestTag = getLatestTag(normalizedRepoPath);
    const currentVersion = latestTag ? latestTag.version : startVersion.version;
    const current = formatBaseVersion(currentVersion);
    const sinceTimestamp = latestTag
      ? getLatestTagDate(normalizedRepoPath, latestTag.tag)
      : '1970-01-01T00:00:00.000Z';
    const analysis = analyzeCommits(collectCommitRows(dbHandle, normalizedRepoPath, sinceTimestamp));
    const nextBaseVersion = applyBump(currentVersion, analysis.bump);
    const next = `${formatBaseVersion(nextBaseVersion)}${prerelease ? `-${prerelease}.0` : ''}`;

    return {
      current,
      next,
      bump: analysis.bump,
      commitCount: analysis.commitCount,
      breakdown: analysis.breakdown,
    };
  }

  function createRelease(repoPath, options = {}) {
    const normalizedRepoPath = requireString(repoPath, 'repoPath');
    const normalizedOptions = normalizeOptions(options);
    const push = normalizedOptions.push === true;
    const releaseInfo = normalizedOptions.version
      ? {
        next: parseSemver(normalizedOptions.version, 'version', { allowPrerelease: true }).text,
        bump: null,
        commitCount: 0,
      }
      : inferNextVersion(normalizedRepoPath, normalizedOptions);
    let version = releaseInfo.next;
    let tag = `v${version}`;

    while (true) {
      try {
        runGit(normalizedRepoPath, ['tag', '-a', tag, '-m', `Release ${version}`]);
        break;
      } catch (error) {
        if (normalizedOptions.version || !isTagAlreadyExistsError(error)) {
          throw error;
        }
        version = bumpPatchVersionText(version);
        tag = `v${version}`;
      }
    }

    if (push) {
      runGit(normalizedRepoPath, ['push', 'origin', tag]);
    }

    const timestampColumn = getCommitTimestampColumn(dbHandle);
    const timestamp = new Date().toISOString();
    insertCommitRecord(dbHandle, {
      id: randomUUID(),
      repo_path: normalizedRepoPath,
      branch: null,
      commit_hash: tag,
      message: `Release ${version}`,
      commit_type: 'release',
      scope: null,
      [timestampColumn]: timestamp,
    });

    return {
      version,
      tag,
      bump: releaseInfo.bump,
      pushed: push,
      commitCount: releaseInfo.commitCount,
    };
  }

  return {
    getLatestTag,
    inferNextVersion,
    createRelease,
  };
}

module.exports = { createReleaseManager };
