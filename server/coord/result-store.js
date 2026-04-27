'use strict';
const fs = require('fs');
const path = require('path');

function createResultStore(config) {
  const root = config.results_dir;
  const ttlMs = (config.result_ttl_seconds || 3600) * 1000;

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

  function getResult({ project, sha, suite }) {
    const file = path.join(root, project, sha, `${suite}.json`);
    if (!fs.existsSync(file)) return null;
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_err) {
      return null; // corrupt — treat as miss
    }
    if (!record.completed_at) return null;
    const age = Date.now() - Date.parse(record.completed_at);
    if (Number.isNaN(age) || age > ttlMs) return null;
    return record;
  }

  return { writeResult, getResult };
}

module.exports = { createResultStore };
