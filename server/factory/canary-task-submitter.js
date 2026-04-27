'use strict';

const CANARY_DESCRIPTION =
  'Read-only canary check: confirm Codex CLI is reachable. Run `git status` (or equivalent read-only command) and report exit code only. Do not modify any files.';

async function submitCanaryTask({ description, logger } = {}) {
  const log = logger || { info() {}, warn() {} };
  const desc = description || CANARY_DESCRIPTION;

  const routingModule = require('../handlers/integration/routing');
  const handler = routingModule.handleSmartSubmitTask;

  if (typeof handler !== 'function') {
    throw new Error('No smart_submit_task handler found in expected location (handlers/integration/routing)');
  }

  const args = {
    task: desc,
    provider: 'codex',
    timeout_minutes: 5,
    version_intent: 'internal',
    task_metadata: {
      is_canary: true,
    },
  };

  const result = await handler(args);
  log.info('[codex-fallback-3] canary task submitted', {
    task_id: result?.task_id || 'unknown',
  });
  return result;
}

module.exports = { submitCanaryTask, CANARY_DESCRIPTION };
