'use strict';

const eventBus = require('../event-bus');

describe('event-bus replan-recovery events', () => {
  it('exposes emitFactoryReplanRecoveryAttempted and onFactoryReplanRecoveryAttempted', () => {
    expect(typeof eventBus.emitFactoryReplanRecoveryAttempted).toBe('function');
    expect(typeof eventBus.onFactoryReplanRecoveryAttempted).toBe('function');
  });

  it('exposes emitFactoryReplanRecoveryExhausted and onFactoryReplanRecoveryExhausted', () => {
    expect(typeof eventBus.emitFactoryReplanRecoveryExhausted).toBe('function');
    expect(typeof eventBus.onFactoryReplanRecoveryExhausted).toBe('function');
  });

  it('attempted event delivers payload to subscribers', () => new Promise((resolve) => {
    eventBus.onFactoryReplanRecoveryAttempted((data) => {
      expect(data).toEqual({ work_item_id: 42, strategy: 'rewrite-description', outcome: 'rewrote' });
      resolve();
    });
    eventBus.emitFactoryReplanRecoveryAttempted({ work_item_id: 42, strategy: 'rewrite-description', outcome: 'rewrote' });
  }));
});
