'use strict';

const fs = require('fs');
const path = require('path');

const { createRepoRegistry } = require('./repo-registry');

function requireDb(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createMentionResolver requires a sqlite database handle');
  }
}

function validateRepoRegistry(repoRegistry) {
  if (!repoRegistry || typeof repoRegistry.getByName !== 'function' || typeof repoRegistry.list !== 'function') {
    throw new TypeError('createMentionResolver requires a repoRegistry with getByName() and list()');
  }
}

function normalizeMentionValue(value, label = 'mention') {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${label} mention requires a value`);
  }
  return normalized;
}

function splitExplicitRepo(value) {
  const separatorIndex = String(value || '').indexOf(':');
  if (separatorIndex <= 0) return null;
  return {
    repoName: value.slice(0, separatorIndex).trim(),
    target: value.slice(separatorIndex + 1).trim(),
  };
}

function defaultRepo(repoRegistry) {
  const repos = repoRegistry.list();
  return repos.length === 1 ? repos[0] : null;
}

function normalizeRepoPathInput(value) {
  return normalizeMentionValue(value, 'path')
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '');
}

function resolveRepoScopedTarget(repoRegistry, rawValue) {
  const value = normalizeMentionValue(rawValue);
  const explicit = splitExplicitRepo(value);

  if (explicit) {
    const repo = repoRegistry.getByName(explicit.repoName);
    if (!repo) {
      return { error: `unknown repo: ${explicit.repoName}` };
    }
    return {
      repo,
      repoName: repo.name,
      target: explicit.target,
    };
  }

  const repo = defaultRepo(repoRegistry);
  if (!repo) {
    const repos = repoRegistry.list();
    return {
      error: repos.length === 0
        ? 'no repos registered'
        : 'mention requires an explicit repo when multiple repos are registered',
    };
  }

  return {
    repo,
    repoName: repo.name,
    target: value,
  };
}

function resolvePathWithinRepo(repo, repoPath) {
  const rootPath = String(repo.rootPath || repo.root_path || '').trim();
  if (!rootPath) {
    throw new Error(`registered repo '${repo.name || repo.repo_id}' is missing a root path`);
  }

  const normalizedInput = normalizeRepoPathInput(repoPath);
  const absolutePath = path.resolve(rootPath, ...normalizedInput.split('/'));
  const relativePath = path.relative(rootPath, absolutePath);

  if ((relativePath && relativePath.startsWith('..')) || path.isAbsolute(relativePath)) {
    throw new Error('path escapes repo root');
  }

  return {
    absolutePath,
    repoPath: relativePath ? relativePath.replace(/\\/g, '/') : '',
  };
}

function resolveSymbolLookup(repoRegistry, rawValue) {
  const value = normalizeMentionValue(rawValue, 'symbol');
  const explicit = splitExplicitRepo(value);

  if (!explicit) {
    return { repo: null, symbolName: value };
  }

  const repo = repoRegistry.getByName(explicit.repoName);
  if (!repo) {
    return { error: `unknown repo: ${explicit.repoName}` };
  }

  return {
    repo,
    symbolName: explicit.target,
  };
}

function createMentionResolver({ db, repoRegistry, urlFetcher = null, logger = console } = {}) {
  requireDb(db);

  const registry = repoRegistry || createRepoRegistry({ db });
  validateRepoRegistry(registry);

  const findSymbolAnyRepoStmt = db.prepare(`
    SELECT *
    FROM repo_symbols
    WHERE qualified_name = ? OR name = ?
    ORDER BY CASE WHEN qualified_name = ? THEN 0 ELSE 1 END, repo_id ASC, symbol_id ASC
    LIMIT 1
  `);
  const findSymbolByRepoStmt = db.prepare(`
    SELECT *
    FROM repo_symbols
    WHERE repo_id = ?
      AND (qualified_name = ? OR name = ?)
    ORDER BY CASE WHEN qualified_name = ? THEN 0 ELSE 1 END, symbol_id ASC
    LIMIT 1
  `);

  async function resolve(mentions) {
    const input = Array.isArray(mentions) ? mentions : [];
    const out = [];

    for (const mention of input) {
      try {
        if (mention.kind === 'file') out.push(await resolveFile(mention));
        else if (mention.kind === 'symbol') out.push(resolveSymbol(mention));
        else if (mention.kind === 'repo') out.push(resolveRepo(mention));
        else if (mention.kind === 'dir') out.push(resolveDir(mention));
        else if (mention.kind === 'url') out.push(await resolveUrl(mention));
        else out.push({ ...mention, resolved: false, reason: `unknown mention kind: ${mention.kind}` });
      } catch (err) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`mention resolver failed for ${mention.raw || mention.value || mention.kind || 'unknown'}: ${err.message}`);
        }
        out.push({ ...mention, resolved: false, reason: err.message });
      }
    }

    return out;
  }

  async function resolveFile(mention) {
    const scope = resolveRepoScopedTarget(registry, mention.value);
    if (scope.error) {
      return { ...mention, resolved: false, reason: scope.error };
    }

    const { repo, repoName, target } = scope;
    const { absolutePath, repoPath } = resolvePathWithinRepo(repo, target);

    let stats;
    try {
      stats = fs.statSync(absolutePath);
    } catch {
      return { ...mention, resolved: false, reason: 'not found' };
    }

    if (!stats.isFile()) {
      return { ...mention, resolved: false, reason: 'not found' };
    }

    return {
      ...mention,
      resolved: true,
      repo: repoName,
      repo_id: repo.repo_id,
      file_path: repoPath,
      content: fs.readFileSync(absolutePath, 'utf8'),
    };
  }

  function resolveSymbol(mention) {
    const lookup = resolveSymbolLookup(registry, mention.value);
    if (lookup.error) {
      return { ...mention, resolved: false, reason: lookup.error };
    }

    const row = lookup.repo
      ? findSymbolByRepoStmt.get(lookup.repo.repo_id, lookup.symbolName, lookup.symbolName, lookup.symbolName)
      : findSymbolAnyRepoStmt.get(lookup.symbolName, lookup.symbolName, lookup.symbolName);

    if (!row) {
      return { ...mention, resolved: false, reason: 'symbol not found' };
    }

    const repo = typeof registry.get === 'function' ? registry.get(row.repo_id) : null;

    return {
      ...mention,
      resolved: true,
      repo: repo ? repo.name : undefined,
      repo_id: row.repo_id,
      symbol_id: row.symbol_id,
      symbol_kind: row.kind,
      name: row.name,
      qualified_name: row.qualified_name,
      file_path: row.file_path,
      start_line: row.start_line,
      end_line: row.end_line,
      body_preview: row.body_preview,
    };
  }

  function resolveRepo(mention) {
    const repoName = normalizeMentionValue(mention.value, 'repo');
    const repo = registry.getByName(repoName);
    if (!repo) {
      return { ...mention, resolved: false, reason: 'repo not registered' };
    }

    return {
      ...mention,
      resolved: true,
      ...repo,
    };
  }

  function resolveDir(mention) {
    const scope = resolveRepoScopedTarget(registry, mention.value);
    if (scope.error) {
      return { ...mention, resolved: false, reason: scope.error };
    }

    const { repo, repoName, target } = scope;
    const { absolutePath, repoPath } = resolvePathWithinRepo(repo, target);

    let stats;
    try {
      stats = fs.statSync(absolutePath);
    } catch {
      return { ...mention, resolved: false, reason: 'dir not found' };
    }

    if (!stats.isDirectory()) {
      return { ...mention, resolved: false, reason: 'dir not found' };
    }

    const entries = fs.readdirSync(absolutePath, { withFileTypes: true })
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      ...mention,
      resolved: true,
      repo: repoName,
      repo_id: repo.repo_id,
      dir_path: repoPath,
      entries,
    };
  }

  async function resolveUrl(mention) {
    if (typeof urlFetcher !== 'function') {
      return { ...mention, resolved: false, reason: 'url fetcher not configured' };
    }

    const content = await urlFetcher(mention.value);
    return {
      ...mention,
      resolved: true,
      content,
    };
  }

  return { resolve };
}

module.exports = { createMentionResolver };
