'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { ensureSchema } = require('./schema');
const { indexRepoAtHead } = require('./index-runner');

(async () => {
  try {
    const db = new Database(workerData.dbPath);
    // Match the main thread's WAL config so concurrent reads (e.g., the parent
    // calling cg_index_status while reindex runs) don't block each other.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 10000');
    ensureSchema(db);
    const result = await indexRepoAtHead({
      db,
      repoPath: workerData.repoPath,
      force: workerData.force,
    });
    db.close();
    parentPort.postMessage({ state: 'done', result });
  } catch (err) {
    parentPort.postMessage({ state: 'error', error: err.message, stack: err.stack });
  }
})();
