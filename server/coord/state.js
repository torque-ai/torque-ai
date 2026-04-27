'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUTPUT_BUFFER_CAP_BYTES = 1024 * 1024;

function createStateStore(config) {
  const locks = new Map();
  const byProject = new Map();
  const subscribers = new Map();
  const persistPath = config.persist_path || null;

  function newLockId() { return crypto.randomBytes(8).toString('hex'); }
  function nowIso() { return new Date().toISOString(); }

  function persist() {
    if (!persistPath) return;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      const payload = JSON.stringify({
        version: 1,
        locks: Array.from(locks.values()),
      });
      fs.writeFileSync(persistPath + '.tmp', payload);
      fs.renameSync(persistPath + '.tmp', persistPath);
    } catch (_err) { /* best-effort persistence */ }
  }

  function restoreFromFile() {
    if (!persistPath || !fs.existsSync(persistPath)) {
      return { crashed_count: 0 };
    }
    try {
      const data = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
      const stale = Array.isArray(data.locks) ? data.locks : [];
      const crashed_count = stale.length;
      // Stale locks across daemon restart: never trust them. No way to verify
      // the original holder process is alive without per-host PID introspection.
      locks.clear();
      byProject.clear();
      persist();
      return { crashed_count };
    } catch (err) {
      return { crashed_count: 0, restore_error: err.message };
    }
  }

  function acquire({ project, sha, suite, holder }) {
    if (byProject.has(project)) {
      return { acquired: false, reason: 'project_held', wait_for: byProject.get(project) };
    }
    if (locks.size >= config.max_concurrent_runs) {
      return { acquired: false, reason: 'global_semaphore_full', wait_for: null };
    }
    const lock_id = newLockId();
    const created_at = nowIso();
    const lock = {
      lock_id, project, sha, suite, holder,
      created_at, last_heartbeat_at: created_at,
      output_buffer: '', crashed: false,
    };
    locks.set(lock_id, lock);
    byProject.set(project, lock_id);
    persist();
    return { acquired: true, lock_id };
  }

  function heartbeat(lock_id, { log_chunk = '', now = null } = {}) {
    const lock = locks.get(lock_id);
    if (!lock) return { ok: false, reason: 'unknown_lock' };
    lock.last_heartbeat_at = now ? new Date(now).toISOString() : nowIso();
    if (log_chunk) {
      const combined = lock.output_buffer + log_chunk;
      lock.output_buffer = combined.length > OUTPUT_BUFFER_CAP_BYTES
        ? combined.slice(combined.length - OUTPUT_BUFFER_CAP_BYTES)
        : combined;
    }
    persist();
    return { ok: true };
  }

  function release(lock_id, payload = {}) {
    const lock = locks.get(lock_id);
    if (!lock) return { released: false, reason: 'unknown_lock' };
    locks.delete(lock_id);
    byProject.delete(lock.project);
    persist();
    notify(lock_id, {
      type: 'released',
      exit_code: payload.exit_code,
      suite_status: payload.suite_status,
      output_tail: payload.output_tail || lock.output_buffer.slice(-OUTPUT_BUFFER_CAP_BYTES),
      lock,
    });
    return { released: true, lock };
  }

  function forceRelease(lock_id, { reason }) {
    const lock = locks.get(lock_id);
    if (!lock) return { released: false, reason: 'unknown_lock' };
    lock.crashed = true;
    locks.delete(lock_id);
    byProject.delete(lock.project);
    persist();
    notify(lock_id, { type: 'holder_crashed', reason, lock });
    return { released: true, crashed: true, lock };
  }

  function getLock(lock_id) { return locks.get(lock_id) || null; }
  function listActive() { return Array.from(locks.values()); }

  function subscribe(lock_id, cb) {
    if (!subscribers.has(lock_id)) subscribers.set(lock_id, new Set());
    subscribers.get(lock_id).add(cb);
    return () => {
      const set = subscribers.get(lock_id);
      if (set) {
        set.delete(cb);
        if (set.size === 0) subscribers.delete(lock_id);
      }
    };
  }

  function notify(lock_id, event) {
    const set = subscribers.get(lock_id);
    if (!set) return;
    for (const cb of set) {
      try { cb(event); } catch (_e) { /* swallow */ }
    }
    subscribers.delete(lock_id);
  }

  return {
    acquire, heartbeat, release, forceRelease,
    getLock, listActive, subscribe, restoreFromFile,
  };
}

module.exports = { createStateStore, OUTPUT_BUFFER_CAP_BYTES };
