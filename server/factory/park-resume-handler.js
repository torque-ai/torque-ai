'use strict';

const { resumeAllCodexParked } = require('../db/factory-intake');

function createParkResumeHandler({ db, eventBus, logger }) {
  if (!db) throw new Error('createParkResumeHandler requires db');
  if (!eventBus) throw new Error('createParkResumeHandler requires eventBus');
  const log = logger || { info() {}, warn() {} };

  eventBus.on('circuit:recovered', (payload) => {
    if (!payload || payload.provider !== 'codex') return;
    try {
      const resumed = resumeAllCodexParked({ db });
      log.info('[codex-fallback] park-resume completed', { resumed, reason: payload.reason });
    } catch (err) {
      log.warn('[codex-fallback] park-resume failed', { error: err.message });
    }
  });

  return {};
}

module.exports = { createParkResumeHandler };
