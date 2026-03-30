'use strict';

const { randomUUID } = require('crypto');

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

function normalizeTimestamp(record) {
  return record.created_at
    || record.createdAt
    || record.generated_at
    || record.generatedAt
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

  const type = typeof result?.type === 'string' && result.type.trim() ? result.type.trim() : 'chore';
  const scope = typeof result?.scope === 'string' && result.scope.trim() ? `(${result.scope.trim()})` : '';
  const subject = typeof result?.subject === 'string' && result.subject.trim()
    ? result.subject.trim()
    : 'update tracked changes';
  const body = typeof result?.body === 'string' && result.body.trim() ? `\n\n${result.body.trim()}` : '';
  return `${type}${scope}: ${subject}${body}`;
}

function extractCommitType(result, message) {
  if (typeof result?.type === 'string' && result.type.trim()) {
    return result.type.trim();
  }

  const match = /^([a-z]+)(?:\([^)]+\))?:/i.exec(message);
  return match ? match[1].toLowerCase() : 'chore';
}

function extractScope(result, message) {
  if (typeof result?.scope === 'string' && result.scope.trim()) {
    return result.scope.trim();
  }

  const match = /^[a-z]+\(([^)]+)\):/i.exec(message);
  return match ? match[1] : null;
}

function extractCommitHash(result) {
  const hash = result?.commitHash || result?.commit_hash || result?.hash;
  if (typeof hash !== 'string' || !hash.trim()) {
    throw new Error('commit generator did not return a commit hash');
  }

  return hash.trim();
}

function extractBranch(result) {
  const branch = result?.branch || result?.branchName || result?.currentBranch;
  return typeof branch === 'string' && branch.trim() ? branch.trim() : 'unknown';
}

function getCommitTableColumns(dbHandle) {
  try {
    return dbHandle.prepare("PRAGMA table_info('vc_commits')").all().map((column) => column.name);
  } catch {
    return [];
  }
}

function insertCommitRecord(dbHandle, record) {
  const columns = getCommitTableColumns(dbHandle);
  const timestampColumn = columns.includes('created_at')
    ? 'created_at'
    : (columns.includes('generated_at') ? 'generated_at' : 'created_at');

  const explicitColumns = [
    'id',
    'repo_path',
    'branch',
    'commit_hash',
    'message',
    'commit_type',
    'scope',
    timestampColumn,
  ];

  const values = [
    record.id,
    record.repo_path,
    record.branch,
    record.commit_hash,
    record.message,
    record.commit_type,
    record.scope,
    record.created_at,
  ];

  if (columns.includes('worktree_id') && Object.prototype.hasOwnProperty.call(record, 'worktree_id')) {
    explicitColumns.splice(2, 0, 'worktree_id');
    values.splice(2, 0, record.worktree_id);
  }

  if (columns.includes('files_changed') && Object.prototype.hasOwnProperty.call(record, 'files_changed')) {
    explicitColumns.splice(explicitColumns.length - 1, 0, 'files_changed');
    values.splice(values.length - 1, 0, record.files_changed);
  }

  const placeholders = explicitColumns.map(() => '?').join(', ');
  const sql = `INSERT INTO vc_commits (${explicitColumns.join(', ')}) VALUES (${placeholders})`;
  dbHandle.prepare(sql).run(...values);
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

async function resolveEffectiveConfig(configResolver, repoPath) {
  const getEffectiveConfig = resolveOptionalMethod(configResolver, ['getEffectiveConfig', 'getPolicy']);
  if (!getEffectiveConfig) {
    return {};
  }

  return (await getEffectiveConfig(repoPath)) || {};
}

async function resolveDefaultStaleDays(configResolver, repoPath) {
  const effectiveConfig = repoPath
    ? await resolveEffectiveConfig(configResolver, repoPath)
    : null;
  if (effectiveConfig && Number.isFinite(Number(effectiveConfig.stale_threshold_days))) {
    return Number(effectiveConfig.stale_threshold_days);
  }

  const getGlobalDefaults = resolveOptionalMethod(configResolver, ['getGlobalDefaults']);
  if (getGlobalDefaults) {
    const defaults = (await getGlobalDefaults()) || {};
    if (Number.isFinite(Number(defaults.stale_threshold_days))) {
      return Number(defaults.stale_threshold_days);
    }
  }

  return DEFAULT_STALE_DAYS;
}

function createHandlers(services = {}) {
  const {
    worktreeManager,
    commitGenerator,
    policyEngine,
    configResolver,
    db,
  } = services;

  const createWorktree = resolveMethod(worktreeManager, 'worktreeManager', ['createWorktree']);
  const listWorktrees = resolveMethod(worktreeManager, 'worktreeManager', ['listWorktrees']);
  const getWorktree = resolveMethod(worktreeManager, 'worktreeManager', ['getWorktree']);
  const mergeWorktree = resolveMethod(worktreeManager, 'worktreeManager', ['mergeWorktree']);
  const cleanupWorktree = resolveMethod(worktreeManager, 'worktreeManager', ['cleanupWorktree']);
  const recordActivity = resolveOptionalMethod(worktreeManager, ['recordActivity']);

  const generateCommit = resolveMethod(commitGenerator, 'commitGenerator', ['generateCommitMessage', 'generateCommit']);
  const getCommitStatus = resolveMethod(commitGenerator, 'commitGenerator', ['getCommitStatus', 'commitStatus', 'getStatus']);

  const validateBranchName = resolveOptionalMethod(policyEngine, ['validateBranchName']);
  const validateBeforeMerge = resolveOptionalMethod(policyEngine, ['validateBeforeMerge']);

  const getEffectiveConfig = resolveMethod(configResolver, 'configResolver', ['getEffectiveConfig', 'getPolicy']);
  const dbHandle = resolveDbHandle(db);

  return {
    async vc_create_worktree(args) {
      const payload = normalizeArgs(args);
      const repoPath = requireString(payload.repo_path, 'repo_path');
      const featureName = requireString(payload.feature_name, 'feature_name');
      const baseBranch = normalizeOptionalString(payload.base_branch) || DEFAULT_BASE_BRANCH;

      const policyConfig = await resolveEffectiveConfig(configResolver, repoPath);
      let branchValidation = null;
      if (validateBranchName) {
        const allowedPrefixes = getArrayValue(policyConfig.branch_prefix);
        if (allowedPrefixes.length > 0) {
          branchValidation = await validateBranchName(buildBranchCandidate(featureName, policyConfig), allowedPrefixes);
          const branchMode = policyConfig?.policy_modes?.branch_naming || 'warn';
          if (branchValidation && branchValidation.valid === false && branchMode === 'block') {
            return toTextResponse({
              created: false,
              blocked: true,
              policy: branchValidation,
            });
          }
        }
      }

      const result = await createWorktree(repoPath, featureName, {
        baseBranch,
        base_branch: baseBranch,
      });
      return toTextResponse({
        ...result,
        branch_policy: branchValidation,
      });
    },

    async vc_list_worktrees(args) {
      const payload = normalizeArgs(args);
      const repoPath = normalizeOptionalString(payload.repo_path);
      const includeStale = payload.include_stale === true;
      const staleDays = await resolveDefaultStaleDays(configResolver, repoPath);
      const worktrees = (await listWorktrees(repoPath)) || [];

      const filtered = includeStale
        ? worktrees
        : worktrees.filter((worktree) => !isStaleWorktree(worktree, staleDays));

      return toTextResponse({
        count: filtered.length,
        worktrees: filtered,
      });
    },

    async vc_switch_worktree(args) {
      const payload = normalizeArgs(args);
      const id = requireString(payload.id, 'id');
      const worktree = await getWorktree(id);
      if (!worktree) {
        throw new Error(`worktree not found: ${id}`);
      }

      if (recordActivity) {
        await recordActivity(id);
      }

      return toTextResponse({
        id,
        worktree_path: worktree.worktree_path || worktree.worktreePath,
      });
    },

    async vc_merge_worktree(args) {
      const payload = normalizeArgs(args);
      const id = requireString(payload.id, 'id');
      const strategy = normalizeOptionalString(payload.strategy) || DEFAULT_MERGE_STRATEGY;
      if (!VALID_MERGE_STRATEGIES.has(strategy)) {
        throw new Error('strategy must be one of: merge, squash, rebase');
      }

      const worktree = await getWorktree(id);
      if (!worktree) {
        throw new Error(`worktree not found: ${id}`);
      }

      const targetBranch = normalizeOptionalString(payload.target_branch)
        || worktree.base_branch
        || worktree.baseBranch
        || DEFAULT_BASE_BRANCH;

      let policy = null;
      if (validateBeforeMerge) {
        policy = await validateBeforeMerge(
          worktree.repo_path || worktree.repoPath,
          worktree.branch,
          targetBranch,
        );
        if (policy && policy.allowed === false) {
          return toTextResponse({
            merged: false,
            blocked: true,
            target_branch: targetBranch,
            policy,
          });
        }
      }

      const result = await mergeWorktree(id, {
        strategy,
        targetBranch,
        target_branch: targetBranch,
      });

      return toTextResponse({
        ...result,
        target_branch: targetBranch,
        policy,
      });
    },

    async vc_cleanup_stale(args) {
      const payload = normalizeArgs(args);
      const repoPath = normalizeOptionalString(payload.repo_path);
      const configuredStaleDays = await resolveDefaultStaleDays(configResolver, repoPath);
      const staleDays = normalizeOptionalNumber(payload.stale_days, 'stale_days') ?? configuredStaleDays;
      const dryRun = payload.dry_run === true;

      const worktrees = (await listWorktrees(repoPath)) || [];
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
        cleaned.push(await cleanupWorktree(worktree.id));
      }

      return toTextResponse({
        dry_run: false,
        repo_path: repoPath,
        stale_days: staleDays,
        count: cleaned.length,
        cleaned,
      });
    },

    async vc_generate_commit(args) {
      const payload = normalizeArgs(args);
      const repoPath = requireString(payload.repo_path, 'repo_path');
      const body = normalizeOptionalString(payload.body);
      const coAuthor = normalizeOptionalString(payload.co_author);

      const result = await generateCommit(repoPath, {
        body,
        coAuthor,
        co_author: coAuthor,
      });

      const createdAt = normalizeTimestamp(result || {});
      const message = extractCommitMessage(result || {});
      const commitRecord = {
        id: randomUUID(),
        repo_path: repoPath,
        worktree_id: result?.worktreeId || result?.worktree_id || null,
        branch: extractBranch(result || {}),
        commit_hash: extractCommitHash(result || {}),
        message,
        commit_type: extractCommitType(result || {}, message),
        scope: extractScope(result || {}, message),
        files_changed: result?.filesChanged ?? result?.files_changed ?? null,
        created_at: createdAt,
      };

      insertCommitRecord(dbHandle, commitRecord);

      return toTextResponse({
        ...result,
        recorded: true,
        record_id: commitRecord.id,
      });
    },

    async vc_commit_status(args) {
      const payload = normalizeArgs(args);
      const repoPath = requireString(payload.repo_path, 'repo_path');
      const result = await getCommitStatus(repoPath);
      return toTextResponse(result);
    },

    async vc_get_policy(args) {
      const payload = normalizeArgs(args);
      const repoPath = requireString(payload.repo_path, 'repo_path');
      const policy = await getEffectiveConfig(repoPath);
      return toTextResponse(policy || {});
    },
  };
}

module.exports = { createHandlers };
