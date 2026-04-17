'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { HOME_DATA_DIR } = require('../data-dir');

function createTranscriptLog({ filePath }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function append(message) {
    const row = {
      message_id: message.message_id || `msg_${randomUUID().slice(0, 12)}`,
      timestamp: message.timestamp || new Date().toISOString(),
      ...message,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
    return row.message_id;
  }

  function read() {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // Skip malformed rows so the remaining transcript stays readable.
      }
    }
    return out;
  }

  function replace(messages) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${messages.map(message => JSON.stringify(message)).join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
  }

  return { append, read, replace, filePath };
}

function normalizeTaskId(taskId) {
  const value = typeof taskId === 'string' ? taskId.trim() : '';
  if (!value) {
    throw new Error('taskId must be a non-empty string');
  }
  if (path.isAbsolute(value) || /[/\\]/.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid taskId: ${taskId}`);
  }
  return value;
}

function resolveFallbackDataDir() {
  if (typeof process.env.TORQUE_DATA_DIR === 'string' && process.env.TORQUE_DATA_DIR.trim()) {
    return path.resolve(process.env.TORQUE_DATA_DIR.trim());
  }

  if (process.env.TORQUE_TEST_SANDBOX === '1') {
    if (typeof process.env.TORQUE_TEST_SANDBOX_DIR === 'string' && process.env.TORQUE_TEST_SANDBOX_DIR.trim()) {
      return path.resolve(process.env.TORQUE_TEST_SANDBOX_DIR.trim());
    }

    const workerId = process.env.VITEST_WORKER_ID || process.env.TEST_WORKER_ID || String(process.pid);
    return path.join(os.tmpdir(), 'torque-vitest-workers', `worker-${workerId}`);
  }

  return HOME_DATA_DIR;
}

function resolveTranscriptFilePath({ taskId, runDir = null, runDirManager = null, filePath = null } = {}) {
  if (typeof filePath === 'string' && filePath.trim()) {
    return path.resolve(filePath.trim());
  }

  if (typeof runDir === 'string' && runDir.trim()) {
    return path.join(path.resolve(runDir.trim()), 'transcript.jsonl');
  }

  const normalizedTaskId = normalizeTaskId(taskId);
  if (runDirManager && typeof runDirManager.runDirFor === 'function') {
    return path.join(runDirManager.runDirFor(normalizedTaskId), 'transcript.jsonl');
  }

  return path.join(resolveFallbackDataDir(), 'runs', normalizedTaskId, 'transcript.jsonl');
}

function createTaskTranscriptLog(options = {}) {
  return createTranscriptLog({
    filePath: resolveTranscriptFilePath(options),
  });
}

module.exports = {
  createTranscriptLog,
  createTaskTranscriptLog,
  resolveTranscriptFilePath,
};
