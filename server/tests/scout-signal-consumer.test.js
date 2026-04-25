'use strict';

const { installMock } = require('./cjs-mock');

describe('scout signal consumer', () => {
  const CONSUMER_MODULE = '../factory/scout-signal-consumer';

  function loadConsumer({ dispatchTaskEvent = vi.fn(), promoteScoutSignalToIntake = vi.fn() } = {}) {
    for (const modulePath of [
      CONSUMER_MODULE,
      '../hooks/event-dispatch',
      '../factory/scout-output-intake',
    ]) {
      try {
        delete require.cache[require.resolve(modulePath)];
      } catch {
        // ignore unloaded modules
      }
    }

    installMock('../hooks/event-dispatch', { dispatchTaskEvent });
    installMock('../factory/scout-output-intake', { promoteScoutSignalToIntake });

    return {
      dispatchTaskEvent,
      promoteScoutSignalToIntake,
      ...require(CONSUMER_MODULE),
    };
  }

  it('dispatches scout signals and promotes them to intake', () => {
    const promoteScoutSignalToIntake = vi.fn().mockReturnValue({
      created: [{ id: 1 }],
      skipped: [],
    });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const consumer = loadConsumer({ promoteScoutSignalToIntake });

    const result = consumer.processScoutSignal({
      task: {
        id: 'task-1',
        status: 'running',
        provider: 'ollama-cloud',
        metadata: {
          mode: 'scout',
          reason: 'factory_starvation_recovery',
          project_id: 'project-1',
        },
      },
      signalType: 'patterns_ready',
      signalData: { patterns: [{ id: 'p1' }] },
      logger,
    });

    expect(result.dispatched).toBe(true);
    expect(consumer.dispatchTaskEvent).toHaveBeenCalledWith('scout_signal', expect.objectContaining({
      id: 'task-1',
      provider: 'ollama-cloud',
      event_data: expect.objectContaining({
        signal_type: 'patterns_ready',
        patterns: [{ id: 'p1' }],
      }),
    }));
    expect(promoteScoutSignalToIntake).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      'patterns_ready',
      { patterns: [{ id: 'p1' }] },
      expect.objectContaining({ logger }),
    );
  });
});
