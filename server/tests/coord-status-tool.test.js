'use strict';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('coord_status MCP tool', () => {
  beforeEach(() => {
    delete require.cache[require.resolve('../coord/coord-poller')];
    delete require.cache[require.resolve('../tools')];
  });

  afterEach(() => {
    delete require.cache[require.resolve('../coord/coord-poller')];
    delete require.cache[require.resolve('../tools')];
  });

  it('returns the poller payload as MCP content text (JSON-stringified)', async () => {
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
    const { handleToolCall } = require('../tools');
    const result = await handleToolCall('coord_status', {});
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const payload = JSON.parse(result.content[0].text);
    expect(payload.reachable).toBe(true);
    expect(payload.active).toHaveLength(1);
    expect(payload.active[0].project).toBe('torque-public');
  });

  it('returns reachable:false when poller reports unreachable (still success — not an MCP error)', async () => {
    require.cache[require.resolve('../coord/coord-poller')] = {
      exports: {
        getActiveLocks: vi.fn(async () => ({
          active: [],
          reachable: false,
          error: 'no_workstation_configured',
          cached_at: '2026-04-27T12:00:00.000Z',
        })),
      },
    };
    const { handleToolCall } = require('../tools');
    const result = await handleToolCall('coord_status', {});
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.reachable).toBe(false);
    expect(payload.error).toBe('no_workstation_configured');
  });
});
