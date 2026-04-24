'use strict';

const { afterAll, beforeAll, beforeEach, describe, expect, it, vi } = require('vitest');

const { setupTestDbOnly, teardownTestDb, resetTables } = require('./vitest-setup');
const { createWorkerRegistry } = require('../agent-runtime/registry');
const { createRouter } = require('../agent-runtime/router');

describe('runtime router', () => {
  let dbModule;
  let db;
  let registry;
  let router;
  let sendMock;

  beforeAll(() => {
    ({ db: dbModule } = setupTestDbOnly('agent-runtime-router'));
  });

  beforeEach(() => {
    resetTables('runtime_workers');
    db = dbModule.getDbInstance();
    registry = createWorkerRegistry({ db });
    sendMock = vi.fn(async () => ({ ok: true }));
    router = createRouter({ registry, send: sendMock });
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('routes by exact worker_id', async () => {
    registry.register({
      workerId: 'codex-1',
      kind: 'provider',
      capabilities: ['provider:codex'],
      endpoint: 'inline',
    });

    await router.dispatch({ to: 'codex-1', type: 'run_prompt', payload: { prompt: 'hi' } });

    expect(sendMock).toHaveBeenCalledWith('codex-1', expect.objectContaining({ type: 'run_prompt' }));
  });

  it('routes by capability when "to" starts with cap:', async () => {
    registry.register({ workerId: 'a', kind: 'provider', capabilities: ['provider:ollama'], endpoint: 'inline' });
    registry.register({ workerId: 'b', kind: 'provider', capabilities: ['provider:ollama'], endpoint: 'inline' });

    await router.dispatch({ to: 'cap:provider:ollama', type: 'run_prompt', payload: {} });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const calledWorkerId = sendMock.mock.calls[0][0];
    expect(['a', 'b']).toContain(calledWorkerId);
  });

  it('throws when no worker matches', async () => {
    await expect(router.dispatch({ to: 'cap:provider:nope', type: 'x', payload: {} }))
      .rejects.toThrow(/no worker/i);
  });
});
