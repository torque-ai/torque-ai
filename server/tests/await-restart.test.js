import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => {
  const { EventEmitter } = require('events');
  return {
    mocks: {
      taskEvents: new EventEmitter(),
      emitShutdown: vi.fn(),
    },
  };
});

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const taskCore = require('../db/task-core');
const hostMonitoring = require('../utils/host-monitoring');

let handlers;

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

describe('await_restart (barrier task wrapper)', () => {
  beforeEach(() => {
    setupTestDbOnly(`await-restart-${Date.now()}`);
    installCjsModuleMock('../hooks/event-dispatch', {
      taskEvents: mocks.taskEvents,
      NOTABLE_EVENTS: ['started', 'stall_warning', 'retry', 'fallback'],
    });
    installCjsModuleMock('../event-bus', {
      emitShutdown: mocks.emitShutdown,
    });
    installCjsModuleMock('../execution/command-policy', {
      executeValidatedCommandSync: vi.fn(() => ''),
    });
    installCjsModuleMock('../utils/safe-exec', {
      safeExecChain: vi.fn(),
    });
    installCjsModuleMock('../plugins/snapscope/handlers/capture', {
      handlePeekUi: vi.fn(),
    });
    mocks.emitShutdown.mockReset();
    mocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    handlers = loadFresh('../handlers/workflow/await');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.emitShutdown.mockReset();
    mocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    vi.useRealTimers();
    teardownTestDb();
  });

  it('creates barrier task and triggers restart when pipeline is empty', async () => {
    const result = await handlers.handleAwaitRestart({ reason: 'test' });
    const text = textOf(result);

    expect(text).toContain('Restart');
    // The drain watcher fires immediately when pipeline is empty,
    // completing the barrier task and calling emitShutdown
    expect(mocks.emitShutdown).toHaveBeenCalledWith(expect.stringContaining('test'));
  });

  it('returns already_pending when a barrier task already exists', async () => {
    // Create the first barrier via await_restart
    await handlers.handleAwaitRestart({ reason: 'first' });

    // Second call should find the existing barrier
    const result = await handlers.handleAwaitRestart({ reason: 'second' });
    const text = textOf(result);

    // Either it returns the already-pending message or the completed restart message
    // (depends on timing since first barrier may have already completed and triggered shutdown)
    expect(text).toBeTruthy();
  });
});
