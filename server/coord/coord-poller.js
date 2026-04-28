'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CACHE_TTL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 5000;
const REMOTE_URL = 'http://127.0.0.1:9395/active';

let _cache = { at: 0, value: null };

function resolveTarget({ home, env }) {
  const fromEnv = (env && env.TORQUE_COORD_REMOTE_HOST && env.TORQUE_COORD_REMOTE_USER)
    ? { host: env.TORQUE_COORD_REMOTE_HOST, user: env.TORQUE_COORD_REMOTE_USER }
    : null;
  if (fromEnv) return fromEnv;
  const cfgPath = path.join(home, '.torque-remote.local.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg && cfg.host && cfg.user) return { host: cfg.host, user: cfg.user };
  } catch (_e) { /* fall through */ }
  return null;
}

function runSshCurl(target, timeout_ms) {
  return new Promise((resolve) => {
    const args = [
      '-o', 'ConnectTimeout=2',
      '-o', 'StrictHostKeyChecking=accept-new',
      `${target.user}@${target.host}`,
      'curl', '-s', '--max-time', '3', REMOTE_URL,
    ];
    let stdout = '';
    let stderr = '';
    let settled = false;
    const proc = spawn('ssh', args, { windowsHide: true });
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch (_e) { /* best effort */ }
      resolve({ ok: false, error: 'timeout' });
    }, timeout_ms);
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const reason = stderr.trim().slice(-200) || `ssh_exit_${code}`;
        return resolve({ ok: false, error: reason });
      }
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch (_e) { return resolve({ ok: false, error: 'invalid_json' }); }
      resolve({ ok: true, body: parsed });
    });
  });
}

async function getActiveLocks(opts = {}) {
  const home = opts.home || require('os').homedir();
  const env = opts.env || process.env;
  const timeout_ms = opts.timeout_ms || DEFAULT_TIMEOUT_MS;
  const force = opts.force === true;
  const now = Date.now();

  if (!force && _cache.value && now - _cache.at < CACHE_TTL_MS) {
    return { ..._cache.value, served_from_cache: true };
  }

  const target = resolveTarget({ home, env });
  if (!target) {
    return {
      active: [],
      reachable: false,
      error: 'no_workstation_configured',
      cached_at: new Date(now).toISOString(),
    };
  }

  const result = await runSshCurl(target, timeout_ms);
  let value;
  if (!result.ok) {
    value = {
      active: [],
      reachable: false,
      error: result.error,
      cached_at: new Date(now).toISOString(),
    };
  } else {
    value = {
      active: Array.isArray(result.body && result.body.active) ? result.body.active : [],
      reachable: true,
      cached_at: new Date(now).toISOString(),
    };
  }
  _cache = { at: now, value };
  return value;
}

function _resetCacheForTests() {
  _cache = { at: 0, value: null };
}

module.exports = { getActiveLocks, _resetCacheForTests };
