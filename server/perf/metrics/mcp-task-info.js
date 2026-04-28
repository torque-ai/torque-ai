'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

// Measures handleToolCall('task_info', {task_id}) wall time. This represents
// the MCP tool dispatch path: argument validation, route lookup, handler
// invocation, result shaping. The DB lookup work is small relative to the
// dispatch overhead, so this metric tracks dispatch cost more than DB cost.
//
// CAUTION: this metric calls taskCore.setDb. See task-core-create.js for the
// global-state contention notes — only one metric per perf-run process owns
// the taskCore handle. Currently 2 metrics use setDb: task-core-create and
// this one. They each set up + use the handle within their own run, so the
// stomping is benign in practice (each lazyLoad is independent and idempotent).

let cached = null;

async function setup() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 100 });
  const taskCore = require('../../db/task-core');
  if (typeof taskCore.setDb === 'function') {
    taskCore.setDb(fx.db);
  }
  // Pick a real task id from the fixture.
  const row = fx.db.prepare('SELECT id FROM tasks LIMIT 1').get();
  if (!row || !row.id) throw new Error('mcp-task-info fixture has no tasks');
  const { handleToolCall } = require('../../tools');
  cached = { fx, handleToolCall, taskId: row.id };
  return cached;
}

async function run(_ctx) {
  const { handleToolCall, taskId } = await setup();
  const start = performance.now();
  // Use mode:'result' to stay within the task-core.js path (requireTask only).
  // mode:'status' (the default) calls taskManager.getTaskProgress which pulls
  // in task-startup.js and requires its init(deps) to have been called first —
  // a dependency we don't wire in the perf fixture. mode:'result' on a
  // completed fixture task returns the full result text without touching
  // task-startup, giving us a clean measure of the MCP dispatch path.
  const result = await handleToolCall('task_info', { task_id: taskId, mode: 'result' });
  const elapsed = performance.now() - start;
  // Sanity check: result must be success, not an error
  if (result && result.isError) {
    throw new Error(`mcp-task-info: handleToolCall returned an error: ${JSON.stringify(result)}`);
  }
  return { value: elapsed };
}

module.exports = {
  id: 'mcp-task-info',
  name: 'MCP tool round-trip: task_info',
  category: 'request-latency',
  units: 'ms',
  warmup: 5,
  runs: 100,
  run
};
