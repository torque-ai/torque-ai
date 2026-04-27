'use strict';

// Templates are seeded with id = `preset-<filename>` by template-store.seedPresets,
// so the codex-down-failover.json file becomes id 'preset-codex-down-failover'.
// setActiveTemplate validates by id, not by filename slug or human name —
// using the bare slug throws 'Template not found: codex-down-failover' on trip.
const FAILOVER_TEMPLATE = 'preset-codex-down-failover';

function createFailoverActivator({ store, eventBus, logger, breaker }) {
  if (!store) throw new Error('createFailoverActivator requires store');
  if (!eventBus) throw new Error('createFailoverActivator requires eventBus');
  const log = logger || { info() {}, warn() {} };
  let priorTemplate = null;

  // Startup reconcile: if the breaker reloaded as OPEN from persisted DB
  // state (TORQUE restarted while Codex was tripped), no circuit:tripped
  // event fires on construction — the breaker's seed loop just sets
  // entry.state directly. Without this reconcile, the active template
  // sits at whatever it was before restart, which is usually the prior
  // (codex-primary) template — defeating the failover routing entirely.
  // 23 plan_generation tasks failed against local ollama on 2026-04-27
  // because of exactly this gap.
  if (breaker && typeof breaker.allowRequest === 'function' && !breaker.allowRequest('codex')) {
    try {
      const current = store.getActiveName();
      if (current !== FAILOVER_TEMPLATE) {
        priorTemplate = current;
        store.setActive(FAILOVER_TEMPLATE);
        log.info('[codex-fallback-2] startup reconcile: breaker is OPEN, activated codex-down-failover', { prior: priorTemplate });
      }
    } catch (err) {
      log.warn('[codex-fallback-2] startup reconcile failed', { error: err.message });
    }
  }

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
