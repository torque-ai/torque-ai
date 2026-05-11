'use strict';

const TERMINAL_TASK_STATUS_VALUES = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

const ACTIVE_TASK_STATUS_VALUES = Object.freeze([
  'pending',
  'pending_approval',
  'queued',
  'waiting',
  'running',
  'paused',
  'blocked',
  'retry_scheduled',
]);

const VALID_TASK_STATUS_VALUES = Object.freeze([
  ...ACTIVE_TASK_STATUS_VALUES,
  ...TERMINAL_TASK_STATUS_VALUES,
]);

module.exports = {
  ACTIVE_TASK_STATUS_VALUES,
  TERMINAL_TASK_STATUS_VALUES,
  VALID_TASK_STATUS_VALUES,
};
