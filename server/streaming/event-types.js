'use strict';

// All possible events emitted by stream-run. Each has a type tag + shared fields.
const EventType = {
  RUN_STARTED: 'run_started',
  STEP_STARTED: 'step_started',
  TEXT_DELTA: 'text_delta',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  STEP_COMPLETED: 'step_completed',
  USAGE: 'usage',
  ERROR: 'error',
  DONE: 'done',
};

module.exports = { EventType };
