'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_BASE_BRANCH = 'main';
const DEFAULT_MERGE_STRATEGY = 'merge';
const DEFAULT_STALE_DAYS = 7;
const VALID_MERGE_STRATEGIES = new Set(['merge', 'squash', 'rebase']);

function toTextResponse(payload) {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function normalizeArgs(args) {
  return args && typeof args === 'object' ? args : {};
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

function normalizeOptionalNumber(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }

  return numeric;
}

function resolveMethod(service, serviceName, methodNames) {
  for (const methodName of methodNames) {
    if (service && typeof service[methodName] === 'function') {
      return service[methodName].bind(service);
    }
  }

  throw new Error(`${serviceName} service is missing ${methodNames.join(' or ')}`);
}

function resolveOptionalMethod(service, methodNames) {
  for (const methodName of methodNames) {
    if (service && typeof service[methodName] === 'function') {
      return service[methodName].bind(service);
    }
  }

  return null;
}

function resolveDbHandle(dbService) {
  const handle = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);

  if (!handle || typeof handle.prepare !== 'function') {
    throw new Error('db service with prepare() or getDbInstance() is required');
  }

  return handle;
}

function getArrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeOptionalStringArray(value, fieldName) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }

  return value.map((item, index) => requireString(item, `${fieldName}[${index}]`));
}

function ensureTrailingSlash(prefix) {
  if (typeof prefix !== 'string' || !prefix.trim()) {
    return '';
  }

  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function buildBranchCandidate(featureName, config) {
  if (featureName.includes('/')) {
    return featureName;
  }

  const prefixes = getArrayValue(config?.branch_prefix);
  const preferredPrefix = ensureTrailingSlash(prefixes[0] || 'feat');
  return `${preferredPrefix}${featureName}`;
}

function getBranchNamingMode(config) {
  const mode = config?.branch_policy?.policy_modes?.branch_naming
    || config?.policy_modes?.branch_naming
    || 'warn';
  return String(mode).trim().toLowerCase() === 'block' ? 'block' : 'warn';
}

function getDefaultMergeStrategy(config) {
  const strategy = normalizeOptionalString(config?.merge?.strategy)
    || normalizeOptionalString(config?.merge_strategy)
    || DEFAULT_MERGE_STRATEGY;

  return strategy;
}

function normalizeTimestamp(record) {
  return record.generated_at
    || record.generatedAt
    || record.created_at
    || record.createdAt
    || new Date().toISOString();
}

function extractCommitMessage(result) {
  if (typeof result?.fullMessage === 'string' && result.fullMessage.trim()) {
    return result.fullMessage.trim();
  }

  if (typeof result?.message === 'string' && result.message.trim()) {
    return result.message.trim();
  }

  if (typeof result?.commitMessage === 'string' && result.commitMessage.trim()) {
    return result.commitMessage.trim();
  }

  const type = typeof result?.analysis?.type === 'string' && result.analysis.type.trim()
    ? result.analysis.type.trim()
    : 'chore';
  const scope = typeof result?.analysis?.scope === 'string' && result.analysis.scope.trim()
    ? `(${result.analysis.scope.trim()})`
    : '';
  const subject = 'update tracked changes';
  return `${type}${scope}: ${subject}`;
}

function extractCommitType(result, message) {
  if (typeof result?.analysis?.type === 'string' && result.analysis.type.trim()) {
    return result.analysis.type.trim();
  }

  if (typeof result?.type === 'string' && result.type.trim()) {
    return result.type.trim();
  }

  const match = /^([a-z]+)(?:\([^)]+\))?:/i.exec(message);
  return match ? match[1].toLowerCase() : 'chore';
}

function extractScope(result, message) {
  if (typeof result?.analysis?.scope === 'string' && result.analysis.scope.trim()) {
    return result.analysis.scope.trim();
  }

  if (typeof result?.scope === 'string' && result.scope.trim()) {
    return result.scope.trim();
  }

  const match = /^[a-z]+\(([^)]+)\):/i.exec(message);
  return match ? match[1] : null;
}

function extractOptionalCommitHash(result) {
  const hash = result?.commitHash || result?.commit_hash || result?.hash;
  return typeof hash === 'string' && hash.trim() ? hash.trim() : null;
}

function extractFilesChanged(result) {
  const filesChanged = result?.analysis?.files ?? result?.filesChanged ?? result?.files_changed;
  return Number.isFinite(Number(filesChanged)) ? Number(filesChanged) : null;
}

function runGit(repoPath, args) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function getCurrentBranch(repoPath) {
  return runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

function parsePorcelainStatus(output) {
  const summary = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };

  for (const rawLine of String(output || '').split(/\r?\n/)) {
    if (!rawLine) {
      continue;
    }

    if (rawLine.startsWith('??')) {
      summary.untracked += 1;
      continue;
    }

    if (rawLine.startsWith('!!')) {
      continue;
    }

    const stagedCode = rawLine[0] || ' ';
    const unstagedCode = rawLine[1] || ' ';

    if (stagedCode !== ' ' && stagedCode !== '?') {
      summary.staged += 1;
    }

    if (unstagedCode !== ' ' && unstagedCode !== '?') {
      summary.unstaged += 1;
    }
  }

  return summary;
}

function getTableColumns(dbHandle, tableName) {
  try {
    return dbHandle.prepare(`PRAGMA table_info('${tableName}')`).all().map((column) => column.name);
  } catch {
    return [];
  }
}

function insertCommitRecord(dbHandle, record) {
  const columns = getTableColumns(dbHandle, 'vc_commits');
  const availableColumns = new Set(
    columns.length > 0
      ? columns
      : ['id', 'repo_path', 'worktree_id', 'branch', 'commit_hash', 'commit_type', 'scope', 'message', 'files_changed', 'generated_at'],
  );
  const timestampColumn = availableColumns.has('generated_at') ? 'generated_at' : 'created_at';
  const orderedColumns = [
    'id',
    'repo_path',
    'worktree_id',
    'branch',
    'commit_hash',
    'commit_type',
    'scope',
    'message',
    'files_changed',
    timestampColumn,
  ].filter((column, index, list) => availableColumns.has(column) && list.indexOf(column) === index);
  const placeholders = orderedColumns.map(() => '?').join(', ');
  const values = orderedColumns.map((column) => {
    if (column === 'generated_at' || column === 'created_at') {
      return record.created_at;
    }

    return Object.prototype.hasOwnProperty.call(record, column) ? record[column] : null;
  });

  dbHandle.prepare(`INSERT INTO vc_commits (${orderedColumns.join(', ')}) VALUES (${placeholders})`).run(...values);
}

function isStaleWorktree(worktree, staleDays) {
  if (!worktree || typeof worktree !== 'object') {
    return false;
  }

  if (worktree.isStale === true) {
    return true;
  }

  const status = typeof worktree.status === 'string' ? worktree.status.toLowerCase() : '';
  if (status === 'stale') {
    return true;
  }

  const timestamp = worktree.last_activity_at
    || worktree.lastActivityAt
    || worktree.created_at
    || worktree.createdAt;
  if (!timestamp) {
    return false;
  }

  const lastActivityMs = Date.parse(timestamp);
  if (!Number.isFinite(lastActivityMs)) {
    return false;
  }

  const ageMs = Date.now() - lastActivityMs;
  return ageMs >= staleDays * 24 * 60 * 60 * 1000;
}

function normalizePathKey(filePath) {
  return path.resolve(String(filePath || '')).replace(/\\/g, '/').toLowerCase();
}

function findTrackedWorktreeByPath(dbHandle, checkoutPath) {
  try {
    const directMatch = dbHandle.prepare('SELECT * FROM vc_worktrees WHERE worktree_path = ?').get(checkoutPath);
    if (directMatch) {
      return directMatch;
    }

    const normalizedCheckoutPath = normalizePathKey(checkoutPath);
    const rows = dbHandle.prepare('SELECT * FROM vc_worktrees').all();
    return rows.find((row) => normalizePathKey(row.worktree_path) === normalizedCheckoutPath) || null;
  } catch {
    return null;
  }
}

function updateWorktreeActivity(dbHandle, id, options = {}) {
  const worktreeId = normalizeOptionalString(id);
  if (!worktreeId) {
    return false;
  }

  const columns = getTableColumns(dbHandle, 'vc_worktrees');
  const assignments = [];
  const values = [];
  const timestamp = options.timestamp || new Date().toISOString();

  if (columns.length === 0 || columns.includes('last_activity_at')) {
    assignments.push('last_activity_at = ?');
    values.push(timestamp);
  }

  if (options.incrementCommitCount === true && (columns.length === 0 || columns.includes('commit_count'))) {
    assignments.push('commit_count = COALESCE(commit_count, 0) + 1');
  }

  if (assignments.length === 0) {
    return false;
  }

  try {
    dbHandle.prepare(`UPDATE vc_worktrees SET ${assignments.join(', ')} WHERE id = ?`).run(...values, worktreeId);
    return true;
  } catch {
    return false;
  }
}

async function resolveDefaultStaleDays(getEffectiveConfig, getGlobalDefaults, repoPath) {
  if (repoPath) {
    const effectiveConfig = (await Promise.resolve(getEffectiveConfig(repoPath))) || {};
    if (Number.isFinite(Number(effectiveConfig.stale_threshold_days))) {
      return Number(effectiveConfig.stale_threshold_days);
    }
  }

  if (getGlobalDefaults) {
    const defaults = (await Promise.resolve(getGlobalDefaults())) || {};
    if (Number.isFinite(Number(defaults.stale_threshold_days))) {
      return Number(defaults.stale_threshold_days);
    }
  }

  return DEFAULT_STALE_DAYS;
}

function extractUrl(output) {
  const match = String(output || '').match(/https?:\/\/\S+/);
  return match ? match[0].replace(/[),.;\]}]+$/, '') : null;
}

async function handleVcPreparePr(args, services = {}) {
  const payload = normalizeArgs(args);
  const repoPath = requireString(payload.repo_path, 'repo_path');
  const sourceBranch = normalizeOptionalString(payload.source_branch);
  const targetBranch = normalizeOptionalString(payload.target_branch);
  const preparePr = resolveMethod(services.prPreparer, 'prPreparer', ['preparePr']);
  const result = await Promise.resolve(preparePr(repoPath, sourceBranch, targetBranch));

  return toTextResponse({
    title: normalizeOptionalString(result?.title) || '',
    body: typeof result?.body === 'string' ? result.body : '',
    labels: getArrayValue(result?.labels),
  });
}

async function handleVcCreatePr(args) {
  const payload = normalizeArgs(args);
  const repoPath = requireString(payload.repo_path, 'repo_path');
  const title = requireString(payload.title, 'title');
  const body = requireString(payload.body, 'body');
  const targetBranch = normalizeOptionalString(payload.target_branch) || DEFAULT_BASE_BRANCH;
  const labels = normalizeOptionalStringArray(payload.labels, 'labels');
  const output = execFileSync('gh', [
    'pr',
    'create',
    '--title',
    title,
    '--body',
    body,
    '--base',
    targetBranch,
    ...(payload.draft === true ? ['--draft'] : []),
    ...labels.flatMap((label) => ['--label', label]),
  ], {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true,
  });
  const message = String(output || '').trim() || 'Pull request created';
  const url = extractUrl(message);

  return toTextResponse({ url, message });
}

async function handleVcGenerateChangelog(args, services = {}) {
  const payload = normalizeArgs(args);
  const repoPath = requireString(payload.repo_path, 'repo_path');
  const fromTag = normalizeOptionalString(payload.from_tag);
  const toTag = normalizeOptionalString(payload.to_tag);
  const fromDate = normalizeOptionalString(payload.from_date);
  const toDate = normalizeOptionalString(payload.to_date);
  const version = normalizeOptionalString(payload.version);
  const generateChangelog = resolveMethod(services.changelogGenerator, 'changelogGenerator', ['generateChangelog']);
  const markdown = await Promise.resolve(generateChangelog(repoPath, {
    ...payload,
    fromTag,
    toTag,
    fromDate,
    toDate,
    version,
  }));

  return toTextResponse({
    markdown: typeof markdown === 'string' ? markdown : '',
  });
}

async function handleVcUpdateChangelogFile(args, services = {}) {
  const payload = normalizeArgs(args);
  const repoPath = requireString(payload.repo_path, 'repo_path');
  const version = requireString(payload.version, 'version');
  const updateChangelogFile = resolveMethod(services.changelogGenerator, 'changelogGenerator', ['updateChangelogFile']);
  let changelogText = typeof payload.changelog_text === 'string' ? payload.changelog_text : null;

  if (!changelogText || !changelogText.trim()) {
    const generateChangelog = resolveMethod(services.changelogGenerator, 'changelogGenerator', ['generateChangelog']);
    changelogText = await Promise.resolve(generateChangelog(repoPath, {
      ...payload,
      version,
    }));
  }

  const result = await Promise.resolve(updateChangelogFile(repoPath, version, changelogText));
  return toTextResponse({
    path: result?.path,
    version: result?.version || version,
  });
}

async function handleVcCreateRelease(args, services = {}) {
  const payload = normalizeArgs(args);
  const repoPath = requireString(payload.repo_path, 'repo_path');
  const version = normalizeOptionalString(payload.version);
  const push = payload.push === true;
  const createRelease = resolveMethod(services.releaseManager, 'releaseManager', ['createRelease']);
  const result = await Promise.resolve(createRelease(repoPath, { version, push }));

  return toTextResponse({
    version: result?.version || version,
    tag: result?.tag || (result?.version ? `v${result.version}` : null),
    bump: Object.prototype.hasOwnProperty.call(result || {}, 'bump') ? result.bump : null,
    pushed: result?.pushed ?? push,
  });
}

function createHandlers(services = {}) {
  const {
    worktreeManager,
    commitGenerator,
    policyEngine,
    configResolver,
    db,
    prPreparer,
    changelogGenerator,
    releaseManager,
  } = services;

  const createWorktree = resolveMethod(worktreeManager, 'worktreeManager', ['createWorktree']);
  const listWorktrees = resolveMethod(worktreeManager, 'worktreeManager', ['listWorktrees']);
  const getWorktree = resolveMethod(worktreeManager, 'worktreeManager', ['getWorktree']);
  const mergeWorktree = resolveMethod(worktreeManager, 'worktreeManager', ['mergeWorktree']);
  const cleanupWorktree = resolveMethod(worktreeManager, 'worktreeManager', ['cleanupWorktree']);
  const cleanupStale = resolveOptionalMethod(worktreeManager, ['cleanupStale']);

  const generateCommit = resolveMethod(commitGenerator, 'commitGenerator', ['generateCommitMessage', 'generateCommit']);

  const validateBeforeCommit = resolveOptionalMethod(policyEngine, ['validateBeforeCommit']);
  const validateBranchName = resolveOptionalMethod(policyEngine, ['validateBranchName']);
  const validateBeforeMerge = resolveOptionalMethod(policyEngine, ['validateBeforeMerge']);

  const getEffectiveConfig = resolveMethod(configResolver, 'configResolver', ['getEffectiveConfig', 'getPolicy']);
  const getGlobalDefaults = resolveOptionalMethod(configResolver, ['getGlobalDefaults']);

  const dbHandle = resolveDbHandle(db);

  return {
    async vc_create_worktree(args) {
      const payload = normalizeArgs(args);
      const repoPath = requireString(payload.repo_path, 'repo_path');
      const featureName = requireString(payload.feature_name, 'feature_name');
      const config = (await Promise.resolve(getEffectiveConfig(repoPath))) || {};
      const baseBranch = normalizeOptionalString(payload.base_branch) || DEFAULT_BASE_BRANCH;
      const worktreeDir = normalizeOptionalString(config.worktree_dir) || normalizeOptionalString(config?.worktree?.dir);
      const branchCandidate = buildBranchCandidate(featureName, config);

      let branchPolicy = null;
      if (validateBranchName) {
        branchPolicy = await Promise.resolve(validateBranchName({
          repoPath,
          branchName: branchCandidate,
        }));

        if (branchPolicy?.valid === false && getBranchNamingMode(config) === 'block') {
          return toTextResponse({
            created: false,
            blocked: true,
            branch: branchCandidate,
            policy: branchPolicy,
          });
        }
      }

      const result = await Promise.resolve(createWorktree(repoPath, featureName, {
        baseBranch,
        base_branch: baseBranch,
        worktreeDir,
        worktree_dir: worktreeDir,
      }));

      return toTextResponse({
        ...result,
        branch_policy: branchPolicy,
      });
    },

    async vc_list_worktrees(args) {
      const payload = normalizeArgs(args);
      const repoPath = normalizeOptionalString(payload.repo_path);
      const includeStale = payload.include_stale === true;
      const staleDays = await resolveDefaultStaleDays(getEffectiveConfig, getGlobalDefaults, repoPath);
      const worktrees = (await Promise.resolve(listWorktrees(repoPath))) || [];
      const filtered = includeStale
        ? worktrees
        : worktrees.filter((worktree) => !isStaleWorktree(worktree, staleDays));

      return toTextResponse({
        repo_path: repoPath,
        include_stale: includeStale,
        count: filtered.length,
        worktrees: filtered,
      });
    },

    async vc_switch_worktree(args) {
      const payload = normalizeArgs(args);
      const id = requireString(payload.id, 'id');
      const worktree = await Promise.resolve(getWorktree(id));
      if (!worktree) {
        throw new Error(`worktree not found: ${id}`);
      }

      updateWorktreeActivity(dbHandle, id);

      const refreshed = (await Promise.resolve(getWorktree(id))) || worktree;
      return toTextResponse({
        id,
        repo_path: refreshed.repo_path || refreshed.repoPath,
        branch: refreshed.branch,
        worktree_path: refreshed.worktree_path || refreshed.worktreePath,
      });
    },

    async vc_merge_worktree(args) {
      const payload = normalizeArgs(args);
      const id = requireString(payload.id, 'id');
      const worktree = await Promise.resolve(getWorktree(id));
      if (!worktree) {
        throw new Error(`worktree not found: ${id}`);
      }

      const repoPath = worktree.repo_path || worktree.repoPath;
      const config = repoPath ? ((await Promise.resolve(getEffectiveConfig(repoPath))) || {}) : {};
      const strategy = normalizeOptionalString(payload.strategy) || getDefaultMergeStrategy(config);
      if (!VALID_MERGE_STRATEGIES.has(strategy)) {
        throw new Error('strategy must be one of: merge, squash, rebase');
      }

      const targetBranch = normalizeOptionalString(payload.target_branch)
        || normalizeOptionalString(worktree.base_branch || worktree.baseBranch)
        || DEFAULT_BASE_BRANCH;

      let policy = null;
      if (validateBeforeMerge) {
        policy = await Promise.resolve(validateBeforeMerge({
          repoPath,
          branch: worktree.branch,
          targetBranch,
        }));

        if (policy?.allowed === false) {
          return toTextResponse({
            merged: false,
            blocked: true,
            target_branch: targetBranch,
            policy,
          });
        }
      }

      const result = await Promise.resolve(mergeWorktree(id, {
        strategy,
        targetBranch,
        target_branch: targetBranch,
      }));

      return toTextResponse({
        ...result,
        target_branch: targetBranch,
        policy,
      });
    },

    async vc_cleanup_stale(args) {
      const payload = normalizeArgs(args);
      const repoPath = normalizeOptionalString(payload.repo_path);
      const configuredStaleDays = await resolveDefaultStaleDays(getEffectiveConfig, getGlobalDefaults, repoPath);
      const staleDays = normalizeOptionalNumber(payload.stale_days, 'stale_days') ?? configuredStaleDays;
      const dryRun = payload.dry_run === true;

      if (cleanupStale) {
        const result = (await Promise.resolve(cleanupStale({
          repoPath,
          repo_path: repoPath,
          staleDays,
          stale_days: staleDays,
          dryRun,
          dry_run: dryRun,
        }))) || {};

        return toTextResponse({
          dry_run: result.dry_run ?? result.dryRun ?? dryRun,
          repo_path: result.repo_path ?? repoPath,
          stale_days: result.stale_days ?? staleDays,
          count: result.count ?? getArrayValue(result.worktrees).length,
          worktrees: getArrayValue(result.worktrees),
        });
      }

      const worktrees = (await Promise.resolve(listWorktrees(repoPath))) || [];
      const staleWorktrees = worktrees.filter((worktree) => isStaleWorktree(worktree, staleDays));

      if (dryRun) {
        return toTextResponse({
          dry_run: true,
          repo_path: repoPath,
          stale_days: staleDays,
          count: staleWorktrees.length,
          worktrees: staleWorktrees,
        });
      }

      const cleaned = [];
      for (const worktree of staleWorktrees) {
        cleaned.push(await Promise.resolve(cleanupWorktree(worktree.id)));
      }

      return toTextResponse({
        dry_run: false,
        repo_path: repoPath,
        stale_days: staleDays,
        count: cleaned.length,
        worktrees: cleaned,
      });
    },

    async vc_generate_commit(args) {
      const payload = normalizeArgs(args);
      const repoPath = requireString(payload.repo_path, 'repo_path');
      const body = normalizeOptionalString(payload.body);
      const coAuthor = normalizeOptionalString(payload.co_author);
      const branch = getCurrentBranch(repoPath);

      let policy = null;
      if (validateBeforeCommit) {
        policy = await Promise.resolve(validateBeforeCommit({
          repoPath,
          branch,
        }));

        if (policy?.allowed === false) {
          return toTextResponse({
            success: false,
            blocked: true,
            repo_path: repoPath,
            branch,
            policy,
          });
        }
      }

      const result = await Promise.resolve(generateCommit({
        repoPath,
        body,
        coAuthor,
      }));
      const commitHash = extractOptionalCommitHash(result);

      if (!commitHash || result?.success !== true) {
        return toTextResponse({
          ...result,
          repo_path: repoPath,
          branch,
          policy,
          recorded: false,
        });
      }

      const trackedWorktree = findTrackedWorktreeByPath(dbHandle, repoPath);
      const createdAt = normalizeTimestamp(result || {});
      const message = extractCommitMessage(result || {});
      const commitRecord = {
        id: randomUUID(),
        repo_path: trackedWorktree?.repo_path || repoPath,
        worktree_id: trackedWorktree?.id || null,
        branch,
        commit_hash: commitHash,
        message,
        commit_type: extractCommitType(result || {}, message),
        scope: extractScope(result || {}, message),
        files_changed: extractFilesChanged(result || {}),
        created_at: createdAt,
      };

      insertCommitRecord(dbHandle, commitRecord);
      if (trackedWorktree) {
        updateWorktreeActivity(dbHandle, trackedWorktree.id, {
          timestamp: createdAt,
          incrementCommitCount: true,
        });
      }

      return toTextResponse({
        ...result,
        repo_path: commitRecord.repo_path,
        branch,
        worktree_id: commitRecord.worktree_id,
        policy,
        recorded: true,
        record_id: commitRecord.id,
      });
    },

    async vc_commit_status(args) {
      const payload = normalizeArgs(args);
      const repoPath = requireString(payload.repo_path, 'repo_path');
      const statusOutput = runGit(repoPath, ['status', '--porcelain']);
      const summary = parsePorcelainStatus(statusOutput);

      return toTextResponse({
        repo_path: repoPath,
        ...summary,
        clean: summary.staged === 0 && summary.unstaged === 0 && summary.untracked === 0,
        ready: summary.staged > 0,
      });
    },

    async vc_get_policy(args) {
      const payload = normalizeArgs(args);
      const repoPath = requireString(payload.repo_path, 'repo_path');
      const policy = await Promise.resolve(getEffectiveConfig(repoPath));
      return toTextResponse(policy || {});
    },

    async vc_prepare_pr(args) {
      return handleVcPreparePr(args, { prPreparer });
    },

    async vc_create_pr(args) {
      return handleVcCreatePr(args);
    },

    async vc_generate_changelog(args) {
      return handleVcGenerateChangelog(args, { changelogGenerator });
    },

    async vc_update_changelog_file(args) {
      return handleVcUpdateChangelogFile(args, { changelogGenerator });
    },

    async vc_create_release(args) {
      return handleVcCreateRelease(args, { releaseManager });
    },
  };
}

module.exports = {
  createHandlers,
  toTextResponse,
  normalizeArgs,
  requireString,
  normalizeOptionalString,
  normalizeOptionalNumber,
  resolveMethod,
  resolveOptionalMethod,
  resolveDbHandle,
  getArrayValue,
  ensureTrailingSlash,
  buildBranchCandidate,
  getBranchNamingMode,
  getDefaultMergeStrategy,
  normalizeTimestamp,
  extractCommitMessage,
  handleVcPreparePr,
  handleVcCreatePr,
  handleVcGenerateChangelog,
  handleVcUpdateChangelogFile,
  handleVcCreateRelease,
};
