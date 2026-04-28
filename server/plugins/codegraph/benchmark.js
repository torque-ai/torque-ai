#!/usr/bin/env node
'use strict';

// Standalone benchmark for the codegraph indexer. Run against any repo path
// to time a full reindex; useful when tuning TORQUE_CG_INDEX_CONCURRENCY or
// after parser/extractor changes that might regress throughput.
//
// Usage:
//   node server/plugins/codegraph/benchmark.js <repo-path>
//   TORQUE_CG_INDEX_CONCURRENCY=16 node server/plugins/codegraph/benchmark.js .
//
// Reports: file count, indexable count, total wall time, files/sec, and the
// resulting symbol/reference counts. Uses an in-memory SQLite db so the
// benchmark doesn't touch any persistent codegraph state.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { ensureSchema } = require('./schema');
const { indexRepoAtHead } = require('./index-runner');

function fmt(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  const repoArg = process.argv[2];
  if (!repoArg) {
    console.error('Usage: node benchmark.js <repo-path>');
    process.exit(2);
  }
  const repoPath = path.resolve(repoArg);
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    console.error(`Not a git repo: ${repoPath}`);
    process.exit(2);
  }

  const concurrency = parseInt(process.env.TORQUE_CG_INDEX_CONCURRENCY || '8', 10);
  console.log(`repo:        ${repoPath}`);
  console.log(`concurrency: ${concurrency}`);

  const db = new Database(':memory:');
  ensureSchema(db);

  const t0 = Date.now();
  const result = await indexRepoAtHead({ db, repoPath, force: true });
  const elapsed = Date.now() - t0;

  const filesIndexed = db.prepare('SELECT COUNT(*) AS n FROM cg_files').get().n;
  const symbolsIndexed = db.prepare('SELECT COUNT(*) AS n FROM cg_symbols').get().n;
  const refsIndexed = db.prepare('SELECT COUNT(*) AS n FROM cg_references').get().n;

  console.log('');
  console.log(`Result:      ${result.skipped ? 'skipped (already indexed)' : 'reindexed'}`);
  console.log(`Wall time:   ${fmt(elapsed)}`);
  console.log(`Files:       ${filesIndexed}`);
  console.log(`Symbols:     ${symbolsIndexed}`);
  console.log(`References:  ${refsIndexed}`);
  if (filesIndexed > 0 && elapsed > 0) {
    const fps = (filesIndexed / (elapsed / 1000)).toFixed(1);
    console.log(`Throughput:  ${fps} files/sec`);
  }

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
