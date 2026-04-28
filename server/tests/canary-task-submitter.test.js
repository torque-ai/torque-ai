'use strict';
/* global describe, it, expect, vi, afterEach */

describe('canary-task-submitter', () => {
  let installedModulePath;
  let originalModule;

  afterEach(() => {
    if (installedModulePath) {
      if (originalModule) {
        require.cache[installedModulePath] = originalModule;
      } else {
        delete require.cache[installedModulePath];
      }
      installedModulePath = null;
      originalModule = null;
    }
    const submitterPath = require.resolve('../factory/canary-task-submitter');
    delete require.cache[submitterPath];
  });

  function installHandlerMock(handlerImpl) {
    const handlerPath = require.resolve('../handlers/integration/routing');
    installedModulePath = handlerPath;
    originalModule = require.cache[handlerPath];
    require.cache[handlerPath] = {
      id: handlerPath,
      filename: handlerPath,
      loaded: true,
      exports: { handleSmartSubmitTask: handlerImpl },
    };
    // Bust the submitter cache so it re-requires the mock
    const submitterPath = require.resolve('../factory/canary-task-submitter');
    delete require.cache[submitterPath];
  }

  it('calls the smart_submit_task handler with codex + is_canary', async () => {
    const handlerSpy = vi.fn().mockResolvedValue({ task_id: 'canary-1' });
    installHandlerMock(handlerSpy);
    const { submitCanaryTask } = require('../factory/canary-task-submitter');
    const result = await submitCanaryTask({ logger: { info() {}, warn() {} } });
    expect(handlerSpy).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      task_metadata: expect.objectContaining({ is_canary: true }),
    }));
    expect(result.task_id).toBe('canary-1');
  });

  it('uses default description when none provided', async () => {
    const handlerSpy = vi.fn().mockResolvedValue({ task_id: 't' });
    installHandlerMock(handlerSpy);
    const { submitCanaryTask, CANARY_DESCRIPTION } = require('../factory/canary-task-submitter');
    await submitCanaryTask({});
    expect(handlerSpy).toHaveBeenCalledWith(expect.objectContaining({
      task: CANARY_DESCRIPTION,
    }));
  });

  it('throws if handler is not found', async () => {
    const handlerPath = require.resolve('../handlers/integration/routing');
    installedModulePath = handlerPath;
    originalModule = require.cache[handlerPath];
    require.cache[handlerPath] = {
      id: handlerPath,
      filename: handlerPath,
      loaded: true,
      exports: {}, // no handleSmartSubmitTask
    };
    const submitterPath = require.resolve('../factory/canary-task-submitter');
    delete require.cache[submitterPath];
    const { submitCanaryTask } = require('../factory/canary-task-submitter');
    await expect(submitCanaryTask({})).rejects.toThrow(/handler/i);
  });
});
