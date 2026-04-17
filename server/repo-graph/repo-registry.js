'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function requireDb(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createRepoRegistry requires a sqlite database handle');
  }
}

function normalizeName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) {
    throw new Error('Repo registration requires a non-empty name');
  }
  return normalized;
}

function normalizeOptionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeDefaultBranch(value) {
  return normalizeOptionalString(value) || 'main';
}

function normalizeRootPath(rootPath) {
  const rawPath = String(rootPath || '').trim();
  if (!rawPath) {
    throw new Error('Repo registration requires a rootPath');
  }

  const resolved = path.resolve(rawPath);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(`Repo root path not found: ${resolved}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Repo root path is not a directory: ${resolved}`);
  }

  return resolved;
}

function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    rootPath: row.root_path,
    remoteUrl: row.remote_url,
    defaultBranch: row.default_branch,
    registeredAt: row.registered_at,
    lastIndexedAt: row.last_indexed_at,
  };
}

function createRepoRegistry({ db }) {
  requireDb(db);

  const getByIdStmt = db.prepare(`
    SELECT *
    FROM registered_repos
    WHERE repo_id = ?
  `);
  const getByNameStmt = db.prepare(`
    SELECT *
    FROM registered_repos
    WHERE name = ?
  `);
  const listStmt = db.prepare(`
    SELECT *
    FROM registered_repos
    ORDER BY name COLLATE NOCASE ASC, registered_at ASC, repo_id ASC
  `);
  const insertStmt = db.prepare(`
    INSERT INTO registered_repos (
      repo_id,
      name,
      root_path,
      remote_url,
      default_branch
    )
    VALUES (?, ?, ?, ?, ?)
  `);
  const deleteStmt = db.prepare(`
    DELETE FROM registered_repos
    WHERE repo_id = ?
  `);
  const markIndexedStmt = db.prepare(`
    UPDATE registered_repos
    SET last_indexed_at = ?
    WHERE repo_id = ?
  `);

  function get(repoId) {
    const normalizedRepoId = String(repoId || '').trim();
    if (!normalizedRepoId) return null;
    return mapRow(getByIdStmt.get(normalizedRepoId));
  }

  function getByName(name) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) return null;
    return mapRow(getByNameStmt.get(normalizedName));
  }

  function register(input = {}) {
    const normalizedName = normalizeName(input.name);
    const existing = getByNameStmt.get(normalizedName);
    if (existing) {
      return mapRow(existing);
    }

    const repoId = normalizeOptionalString(input.repoId || input.repo_id) || randomUUID();
    const rootPath = normalizeRootPath(input.rootPath || input.root_path);
    const remoteUrl = normalizeOptionalString(input.remoteUrl || input.remote_url);
    const defaultBranch = normalizeDefaultBranch(input.defaultBranch || input.default_branch);

    insertStmt.run(repoId, normalizedName, rootPath, remoteUrl, defaultBranch);
    return get(repoId);
  }

  function list() {
    return listStmt.all().map(mapRow);
  }

  function unregister(repoId) {
    const normalizedRepoId = String(repoId || '').trim();
    if (!normalizedRepoId) return false;
    return deleteStmt.run(normalizedRepoId).changes > 0;
  }

  function markIndexed(repoId, indexedAt = new Date().toISOString()) {
    const normalizedRepoId = String(repoId || '').trim();
    if (!normalizedRepoId) {
      throw new Error('markIndexed requires a repoId');
    }

    markIndexedStmt.run(String(indexedAt || '').trim() || new Date().toISOString(), normalizedRepoId);
    return get(normalizedRepoId);
  }

  return {
    register,
    getByName,
    get,
    list,
    unregister,
    markIndexed,
  };
}

module.exports = { createRepoRegistry };
