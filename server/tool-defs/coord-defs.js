'use strict';

const tools = [
  {
    name: 'coord_status',
    description: 'Query the workstation Remote Test Coordinator daemon for the current set of active locks. Returns {active:[{lock_id, project, sha, suite, holder, created_at, last_heartbeat_at}], reachable:true|false, error?:string, cached_at}. Use this to see whether tests are currently running on the workstation, who holds the lock, and how long they have held it. Cached for 5s; the response shape is identical to the GET /api/coord/active REST endpoint.',
    inputSchema: { type: 'object', properties: {} },
  },
];

module.exports = { tools };
