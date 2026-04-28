'use strict';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const http = require('http');

describe('GET /api/coord/active', () => {
  let server, port;

  beforeEach(async () => {
    delete require.cache[require.resolve('../coord/coord-poller')];
    require.cache[require.resolve('../coord/coord-poller')] = {
      exports: {
        getActiveLocks: vi.fn(async () => ({
          active: [{
            lock_id: 'abc123',
            project: 'torque-public',
            sha: 'deadbeef',
            suite: 'gate',
            holder: { host: 'omenhost', pid: 1, user: 'k' },
            created_at: '2026-04-27T12:00:00.000Z',
            last_heartbeat_at: '2026-04-27T12:01:00.000Z',
          }],
          reachable: true,
          cached_at: '2026-04-27T12:01:30.000Z',
        })),
      },
    };
    const { COORD_ROUTES } = require('../api/routes/coord-routes');
    server = http.createServer((req, res) => {
      const route = COORD_ROUTES.find(r => r.method === req.method && r.path === req.url);
      if (!route) { res.writeHead(404).end(); return; }
      route.handler(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    delete require.cache[require.resolve('../coord/coord-poller')];
    delete require.cache[require.resolve('../api/routes/coord-routes')];
  });

  function get(urlPath) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }));
      }).on('error', reject);
    });
  }

  it('returns 200 with the poller payload (active + reachable + cached_at)', async () => {
    const res = await get('/api/coord/active');
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(true);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.active[0]).toMatchObject({
      project: 'torque-public', sha: 'deadbeef', suite: 'gate',
    });
    expect(res.body.cached_at).toBeDefined();
  });

  it('returns 200 with reachable:false when poller reports unreachable', async () => {
    const cordPoller = require('../coord/coord-poller');
    cordPoller.getActiveLocks = vi.fn(async () => ({
      active: [],
      reachable: false,
      error: 'no_workstation_configured',
      cached_at: '2026-04-27T12:00:00.000Z',
    }));
    const res = await get('/api/coord/active');
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(false);
    expect(res.body.error).toBe('no_workstation_configured');
    expect(res.body.active).toEqual([]);
  });
});
