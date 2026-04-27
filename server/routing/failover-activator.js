'use strict';

const FAILOVER_TEMPLATE = 'codex-down-failover';

function createFailoverActivator({ store, eventBus, logger }) {
  if (!store) throw new Error('createFailoverActivator requires store');
  if (!eventBus) throw new Error('createFailoverActivator requires eventBus');
  const log = logger || { info() {}, warn() {} };
  let priorTemplate = null;

  eventBus.on('circuit:tripped', (payload) => {
    if (!payload || payload.provider !== 'codex') return;
    try {
      const current = store.getActiveName();
      if (current === FAILOVER_TEMPLATE) return;
      priorTemplate = current;
      store.setActive(FAILOVER_TEMPLATE);
      log.info('[codex-fallback-2] activated codex-down-failover', { prior: priorTemplate });
    } catch (err) {
      log.warn('[codex-fallback-2] failover activation failed', { error: err.message });
    }
  });

  eventBus.on('circuit:recovered', (payload) => {
    if (!payload || payload.provider !== 'codex') return;
    if (!priorTemplate) return;
    try {
      store.setActive(priorTemplate);
      log.info('[codex-fallback-2] restored prior template', { prior: priorTemplate });
      priorTemplate = null;
    } catch (err) {
      log.warn('[codex-fallback-2] template restore failed', { error: err.message });
    }
  });

  return {};
}

module.exports = { createFailoverActivator, FAILOVER_TEMPLATE };
