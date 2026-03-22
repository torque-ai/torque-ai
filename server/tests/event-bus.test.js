'use strict';
import { describe, it, expect, vi } from 'vitest';

const { createEventBus } = require('../event-bus');

describe('createEventBus', () => {
  it('creates independent event bus instances', () => {
    const bus1 = createEventBus();
    const bus2 = createEventBus();

    const fn1 = vi.fn();
    const fn2 = vi.fn();

    bus1.onQueueChanged(fn1);
    bus2.onQueueChanged(fn2);

    bus1.emitQueueChanged();

    expect(fn1).toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('supports all event types', () => {
    const bus = createEventBus();
    const events = [
      ['onQueueChanged', 'emitQueueChanged', undefined],
      ['onShutdown', 'emitShutdown', 'test-reason'],
      ['onTaskUpdated', 'emitTaskUpdated', { id: '1' }],
      ['onTaskEvent', 'emitTaskEvent', { type: 'cancel' }],
      ['onModelDiscovered', 'emitModelDiscovered', { model: 'test' }],
      ['onModelRemoved', 'emitModelRemoved', { model: 'test' }],
    ];

    for (const [onMethod, emitMethod, data] of events) {
      const fn = vi.fn();
      bus[onMethod](fn);
      bus[emitMethod](data);
      expect(fn).toHaveBeenCalled();
    }
  });

  it('has removeAllListeners', () => {
    const bus = createEventBus();
    const fn = vi.fn();
    bus.onTaskUpdated(fn);
    bus.removeAllListeners();
    bus.emitTaskUpdated({});
    expect(fn).not.toHaveBeenCalled();
  });
});
