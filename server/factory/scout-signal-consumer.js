'use strict';

const logger = require('../logger').child({ component: 'scout-signal-consumer' });

function processScoutSignal({
  task = null,
  taskId = null,
  signalType,
  signalData = {},
  logger: injectedLogger = logger,
} = {}) {
  const id = taskId || task?.id || null;
  if (!id || !signalType) {
    return { dispatched: false, intake: null, reason: 'missing_signal_context' };
  }

  let dispatched = false;
  try {
    const { dispatchTaskEvent } = require('../hooks/event-dispatch');
    dispatchTaskEvent('scout_signal', {
      ...(task || {}),
      id,
      status: task?.status || 'running',
      event_data: { signal_type: signalType, ...(signalData || {}) },
    });
    dispatched = true;
  } catch (err) {
    injectedLogger.info?.(`Scout signal dispatch error for task ${id}: ${err.message}`);
  }

  let intake = null;
  try {
    const { promoteScoutSignalToIntake } = require('./scout-output-intake');
    intake = promoteScoutSignalToIntake(task || { id }, signalType, signalData, {
      logger: injectedLogger,
    });
    const createdCount = Array.isArray(intake?.created) ? intake.created.length : 0;
    if (createdCount > 0) {
      injectedLogger.info?.('Scout signal seeded factory intake', {
        task_id: id,
        signal_type: signalType,
        created_count: createdCount,
      });
    }
  } catch (err) {
    injectedLogger.warn?.('Scout signal intake promotion failed', {
      task_id: id,
      signal_type: signalType,
      err: err.message,
    });
  }

  return { dispatched, intake };
}

module.exports = {
  processScoutSignal,
};
