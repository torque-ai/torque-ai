#!/usr/bin/env node
// Smoke test: exercise worktree-manager.mergeWorktree with the fixed
// target-side cleanup path.
//
// 1. Creates an in-memory vc_worktrees DB with a row pointing at the
//    recreated feat/factory-232-... worktree on disk.
// 2. Invokes mergeWorktree.
// 3. The fix path (assertWorktreeIsClean on the main checkout) should
//    detect the CRLF drift on dashboard/src/api.test.js, clean it via
//    a --no-verify commit, then let the merge succeed.
'use strict';

const path = require('path');
const Database = require(path.resolve(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));

const REPO = path.resolve(__dirname, '..');
const WORKTREE = path.join(REPO, '.worktrees', 'feat-factory-232-smoke-test');
const BRANCH = 'feat/factory-232-fabro-99-managed-oauth-behavioral-tool-t';

function initDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS vc_worktrees (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      feature_name TEXT,
      base_branch TEXT DEFAULT 'main',
      status TEXT DEFAULT 'active',
      commit_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      last_activity_at TEXT
    )
  `);
  db.prepare(`
    INSERT INTO vc_worktrees (id, repo_path, worktree_path, branch, feature_name, base_branch, status, commit_count, created_at, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'smoke-232',
    REPO,
    WORKTREE,
    BRANCH,
    'factory-232-smoke',
    'main',
    'active',
    3,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  return db;
}

(async () => {
  const db = initDb();
  const { createWorktreeManager } = require('../server/plugins/version-control/worktree-manager');
  const manager = createWorktreeManager({ db });

  console.log('=== Smoke: mergeWorktree with fixed target-side cleanup ===');
  console.log(`  repo: ${REPO}`);
  console.log(`  worktree: ${WORKTREE}`);
  console.log(`  branch: ${BRANCH}`);
  console.log();

  try {
    const result = manager.mergeWorktree('smoke-232', {
      strategy: 'merge',
      targetBranch: 'main',
      deleteAfter: false,
    });
    console.log('=== Result ===');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.log('=== FAILED ===');
    console.log(`error: ${err.message}`);
    if (err.stderr) console.log(`stderr: ${err.stderr}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
