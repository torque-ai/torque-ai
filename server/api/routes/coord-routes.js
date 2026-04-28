'use strict';

const COORD_ROUTES = [
  {
    method: 'GET',
    path: '/api/coord/active',
    handler: async (_req, res) => {
      const { getActiveLocks } = require('../../coord/coord-poller');
      let payload;
      try {
        payload = await getActiveLocks();
      } catch (err) {
        payload = {
          active: [],
          reachable: false,
          error: `poller_threw: ${err && err.message ? err.message : 'unknown'}`,
          cached_at: new Date().toISOString(),
        };
      }
      const body = JSON.stringify(payload);
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    },
  },
];

module.exports = { COORD_ROUTES };
