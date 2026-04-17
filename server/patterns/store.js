'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../logger').child({ component: 'patterns-store' });
const { loadPatternsFromDir } = require('./pattern-loader');

function clonePattern(pattern) {
  if (!pattern || typeof pattern !== 'object') {
    return null;
  }

  return {
    ...pattern,
    tags: Array.isArray(pattern.tags) ? [...pattern.tags] : [],
    variables: Array.isArray(pattern.variables) ? [...pattern.variables] : [],
  };
}

function listPatternDirectories(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  let stats;
  try {
    stats = fs.statSync(dir);
  } catch {
    return [];
  }

  if (!stats.isDirectory()) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

function createPatternsStore(options = {}) {
  const cwd = typeof options.cwd === 'string' && options.cwd.trim()
    ? path.resolve(options.cwd)
    : process.cwd();
  const sourceDir = path.resolve(options.dir || path.join(cwd, '.torque', 'patterns'));
  const debounceMs = Number.isFinite(options.debounce_ms) ? Math.max(10, options.debounce_ms) : 75;

  let patterns = loadPatternsFromDir(sourceDir);
  let reloadTimer = null;
  const watchers = new Map();

  function closeWatcher(targetPath) {
    const watcher = watchers.get(targetPath);
    if (!watcher) {
      return;
    }

    watchers.delete(targetPath);
    try {
      watcher.close();
    } catch {
      // Ignore close errors during shutdown or reload churn.
    }
  }

  function attachWatcher(targetPath) {
    if (watchers.has(targetPath) || !fs.existsSync(targetPath)) {
      return;
    }

    try {
      const watcher = fs.watch(targetPath, { persistent: false }, () => {
        scheduleReload(`fs.watch:${targetPath}`);
      });

      watcher.on('error', () => {
        closeWatcher(targetPath);
        scheduleReload(`watcher-error:${targetPath}`);
      });

      watchers.set(targetPath, watcher);
    } catch (error) {
      logger.debug(`[patterns] watcher skipped for ${targetPath}: ${error.message}`);
    }
  }

  function getDesiredWatchTargets() {
    const targets = new Set();
    let cursor = sourceDir;

    for (let depth = 0; depth < 3; depth += 1) {
      if (fs.existsSync(cursor)) {
        targets.add(cursor);
      }

      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }

    for (const patternDir of listPatternDirectories(sourceDir)) {
      targets.add(patternDir);
    }

    return targets;
  }

  function syncWatchers() {
    const desiredTargets = getDesiredWatchTargets();

    for (const targetPath of Array.from(watchers.keys())) {
      if (!desiredTargets.has(targetPath)) {
        closeWatcher(targetPath);
      }
    }

    for (const targetPath of desiredTargets) {
      attachWatcher(targetPath);
    }
  }

  function doReload(reason = 'manual') {
    patterns = loadPatternsFromDir(sourceDir);
    syncWatchers();
    logger.debug(`[patterns] reloaded ${patterns.length} pattern(s) from ${sourceDir} (${reason})`);
    return patterns.length;
  }

  function scheduleReload(reason) {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }

    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      doReload(reason);
    }, debounceMs);

    if (typeof reloadTimer.unref === 'function') {
      reloadTimer.unref();
    }
  }

  syncWatchers();

  return {
    list() {
      return patterns.map(clonePattern);
    },
    get(name) {
      if (typeof name !== 'string' || !name.trim()) {
        return null;
      }

      const pattern = patterns.find((entry) => entry.name === name.trim()) || null;
      return clonePattern(pattern);
    },
    reload() {
      return doReload('explicit');
    },
    shutdown() {
      if (reloadTimer) {
        clearTimeout(reloadTimer);
        reloadTimer = null;
      }

      for (const targetPath of Array.from(watchers.keys())) {
        closeWatcher(targetPath);
      }
    },
    sourceDir,
  };
}

module.exports = {
  createPatternsStore,
};
