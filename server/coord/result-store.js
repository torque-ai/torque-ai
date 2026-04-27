'use strict';
const fs = require('fs');
const path = require('path');

function createResultStore(config) {
  const root = config.results_dir;

  function writeResult(record) {
    if (record.crashed) return; // never share crashed runs
    const dir = path.join(root, record.project, record.sha);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${record.suite}.json`);
    const payload = {
      project: record.project,
      sha: record.sha,
      suite: record.suite,
      exit_code: record.exit_code,
      suite_status: record.suite_status,
      output_tail: record.output_tail || '',
      package_lock_hashes: record.package_lock_hashes || {},
      completed_at: new Date().toISOString(),
    };
    fs.writeFileSync(file + '.tmp', JSON.stringify(payload));
    fs.renameSync(file + '.tmp', file);
  }

  // Phase 1: read path stubbed. Phase 2 will check TTL + recompute hashes.
  function getResult(_query) {
    return null;
  }

  return { writeResult, getResult };
}

module.exports = { createResultStore };
