'use strict';
// Verify that the routing decisions handler passes raw:true to listTasks.

test('handleRoutingDecisions passes raw:true to listTasks', () => {
  let capturedOpts = null;
  // Intercept the taskCore require before loading the handler
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function(request, _parent, _isMain) {
    if (typeof request === 'string' && (request.endsWith('task-core') || request.endsWith('task-core.js'))) {
      return {
        listTasks: (opts) => { capturedOpts = opts; return []; },
        TASK_ROUTING_DECISION_COLUMNS: ['id', 'provider', 'metadata'],
        TASK_LIST_COLUMNS: ['id', 'status'],
      };
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../api/v2-analytics-handlers')];
  const { handleRoutingDecisions } = require('../api/v2-analytics-handlers');
  Module._load = origLoad;
  const req = { query: { limit: '10' } };
  // sendJson (used by sendSuccess in v2-control-plane.js) calls writeHead +
  // end on res. Provide stubs so the response path completes synchronously
  // — without them the handler's promise rejects asynchronously and trips
  // vitest's unhandled-rejection guard, causing the suite to exit non-zero
  // even though every assertion passes.
  const res = {
    json: () => {},
    writeHead: () => {},
    end: () => {},
    setHeader: () => {},
  };
  handleRoutingDecisions(req, res);
  expect(capturedOpts).not.toBeNull();
  expect(capturedOpts.raw).toBe(true);
});
