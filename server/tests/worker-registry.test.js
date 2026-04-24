'use strict';

const Database = require('better-sqlite3');
const { afterEach, beforeEach, describe, expect, it } = require('vitest');

const { createTables } = require('../db/schema-tables');
const { runMigrations } = require('../db/migrations');
const { createWorkerRegistry } = require('../agent-runtime/registry');

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

describe('worker registry', () => {
  let db;
  let registry;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db, createLogger());
    runMigrations(db);
    registry = createWorkerRegistry({ db });
  });

  afterEach(() => {
    db.close();
  });

  it('register persists worker with capabilities', () => {
    registry.register({
      workerId: 'w1',
      kind: 'provider',
      displayName: 'codex',
      capabilities: ['provider:codex', 'model:gpt-5.3-codex-spark'],
      endpoint: 'inline',
    });

    const got = registry.get('w1');
    expect(got.kind).toBe('provider');
    expect(got.display_name).toBe('codex');
    expect(got.capabilities).toContain('provider:codex');
  });

  it('findByCapability returns workers matching prefixes and exact capabilities', () => {
    registry.register({ workerId: 'a', kind: 'provider', capabilities: ['provider:codex'], endpoint: 'inline' });
    registry.register({ workerId: 'b', kind: 'provider', capabilities: ['provider:ollama', 'model:qwen3'], endpoint: 'inline' });
    registry.register({ workerId: 'c', kind: 'mcp_tool', capabilities: ['tool:peek_ui'], endpoint: 'inline' });

    const providers = registry.findByCapability('provider:');
    expect(providers.map((worker) => worker.worker_id).sort()).toEqual(['a', 'b']);

    const peek = registry.findByCapability('tool:peek_ui');
    expect(peek.map((worker) => worker.worker_id)).toEqual(['c']);
  });

  it('heartbeat updates last_heartbeat_at and restores connected status', () => {
    registry.register({ workerId: 'w1', kind: 'provider', capabilities: [], endpoint: 'inline' });

    registry.markUnhealthy('w1');
    expect(registry.get('w1').status).toBe('unhealthy');

    const updated = registry.heartbeat('w1');
    expect(updated.status).toBe('connected');
    expect(updated.last_heartbeat_at).toEqual(expect.any(String));
  });

  it('reapStaleWorkers marks workers without recent heartbeat as disconnected', () => {
    registry.register({ workerId: 'fresh', kind: 'provider', capabilities: [], endpoint: 'inline' });
    registry.register({ workerId: 'stale', kind: 'provider', capabilities: [], endpoint: 'inline' });
    registry.heartbeat('fresh');
    db.prepare(`
      UPDATE runtime_workers
      SET last_heartbeat_at = datetime('now', '-2 hours')
      WHERE worker_id = 'stale'
    `).run();

    const reaped = registry.reapStaleWorkers({ thresholdSeconds: 60 });

    expect(reaped).toContain('stale');
    expect(registry.get('stale').status).toBe('disconnected');
    expect(registry.get('fresh').status).toBe('connected');
  });

  it('register updates existing workers in place', () => {
    registry.register({
      workerId: 'w1',
      kind: 'provider',
      displayName: 'codex',
      capabilities: ['provider:codex'],
      endpoint: 'inline',
    });

    registry.markUnhealthy('w1');
    const updated = registry.register({
      workerId: 'w1',
      kind: 'local',
      displayName: 'local fallback',
      capabilities: ['local:shell'],
      endpoint: 'ws://127.0.0.1:9999',
    });

    expect(updated.kind).toBe('local');
    expect(updated.display_name).toBe('local fallback');
    expect(updated.capabilities).toEqual(['local:shell']);
    expect(updated.endpoint).toBe('ws://127.0.0.1:9999');
    expect(updated.status).toBe('connected');
  });

  it('rejects invalid worker kinds', () => {
    expect(() => registry.register({
      workerId: 'bad',
      kind: 'unsupported',
      capabilities: [],
      endpoint: 'inline',
    })).toThrow(/unsupported worker kind/i);
  });
});
