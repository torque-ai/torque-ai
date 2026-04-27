'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { startReindexJob, getJobStatus } = require('../index-runner');
const { setupTinyRepo, destroyTinyRepo } = require('../test-helpers');

describe('codegraph worker-thread indexer', () => {
  let db, repo, dbPath, dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-w-data-'));
    dbPath = path.join(dataDir, 'cg.db');
    db = new Database(dbPath);
    ensureSchema(db);
    repo = setupTinyRepo('cg-w-');
  });
  afterEach(() => {
    db.close();
    destroyTinyRepo(repo);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('startReindexJob returns a jobId and runs in the background', async () => {
    const { jobId } = startReindexJob({ dbPath, repoPath: repo });
    expect(typeof jobId).toBe('string');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const status = getJobStatus(jobId);
      if (status.state === 'done') return;
      if (status.state === 'error') throw new Error(status.error);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('job did not complete');
  });
});
