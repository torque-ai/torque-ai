'use strict';
const path = require('path');
const os = require('os');
const { loadConfig, DEFAULTS } = require('./config');
const { createStateStore } = require('./state');
const { createResultStore } = require('./result-store');
const { createServer } = require('./http');
const { startReaper } = require('./reaper');

function resolveDirs(config) {
  const home = os.homedir();
  const root = path.join(home, '.torque-coord');
  return {
    state_dir: config.state_dir || path.join(root, 'state'),
    results_dir: config.results_dir || path.join(root, 'results'),
  };
}

async function startDaemon(overrides = {}) {
  const fileConfig = overrides.config_file ? loadConfig(overrides.config_file) : { ...DEFAULTS };
  const config = { ...fileConfig, ...overrides };
  const { state_dir, results_dir } = resolveDirs(config);

  const state = createStateStore({
    max_concurrent_runs: config.max_concurrent_runs,
    persist_path: path.join(state_dir, 'active.json'),
  });
  const reconciled = state.restoreFromFile();
  if (reconciled.crashed_count > 0) {
    process.stdout.write(`[coord] reconciled ${reconciled.crashed_count} stale locks across restart\n`);
  }

  const results = createResultStore({
    results_dir,
    result_ttl_seconds: config.result_ttl_seconds,
  });

  const server = createServer({ state, results, config });
  const reaper = startReaper(state, {
    stale_lock_threshold_ms: config.stale_lock_threshold_ms,
    reaper_tick_ms: config.reaper_tick_ms,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bind, () => resolve());
  });

  const port = server.address().port;
  process.stdout.write(`[coord] listening on ${config.bind}:${port}\n`);

  async function stop() {
    reaper.stop();
    await new Promise((r) => server.close(r));
  }

  return { port, stop, state, results, server };
}

if (require.main === module) {
  const configFile = process.env.TORQUE_COORD_CONFIG || null;
  startDaemon({ config_file: configFile }).catch((err) => {
    process.stderr.write(`[coord] failed to start: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { startDaemon };
