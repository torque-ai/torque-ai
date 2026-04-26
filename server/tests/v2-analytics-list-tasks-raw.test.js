'use strict';
// Verify that the routing decisions handler passes raw:true to listTasks.

test('getRoutingDecisions passes raw:true to listTasks', () => {
  let capturedOpts = null;
  // Intercept the taskCore require before loading the handler
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (typeof request === 'string' && (request.endsWith('task-core') || request.endsWith('task-core.js'))) {
      return {
        listTasks: (opts) => { capturedOpts = opts; return []; },
        TASK_ROUTING_DECISION_COLUMNS: ['id', 'provider', 'metadata'],
      };
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../api/v2-analytics-handlers')];
  const { getRoutingDecisions } = require('../api/v2-analytics-handlers');
  Module._load = origLoad;
  const req = { query: { limit: '10' } };
  const res = { json: () => {} };
  getRoutingDecisions(req, res);
  expect(capturedOpts).not.toBeNull();
  expect(capturedOpts.raw).toBe(true);
});
