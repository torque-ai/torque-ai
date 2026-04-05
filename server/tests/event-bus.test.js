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

  it('does not throw when emitting without listeners', () => {
    const bus = createEventBus();

    expect(() => bus.emitQueueChanged()).not.toThrow();
    expect(() => bus.emitShutdown('test-reason')).not.toThrow();
    expect(() => bus.emitTaskUpdated({ id: '1' })).not.toThrow();
    expect(() => bus.emitTaskEvent({ type: 'cancel' })).not.toThrow();
    expect(() => bus.emitModelDiscovered({ model: 'test' })).not.toThrow();
    expect(() => bus.emitModelRemoved({ model: 'test' })).not.toThrow();
  });

  it('removeListener removes a specific listener without affecting others', () => {
    const bus = createEventBus();
    const removedListener = vi.fn();
    const retainedListener = vi.fn();
    const payload = { id: '1' };

    bus.onTaskUpdated(removedListener);
    bus.onTaskUpdated(retainedListener);
    bus.removeListener('task-updated', removedListener);

    bus.emitTaskUpdated(payload);

    expect(removedListener).not.toHaveBeenCalled();
    expect(retainedListener).toHaveBeenCalledWith(payload);
  });

  it('calls the same listener for each emit when once-style behavior is not exposed', () => {
    const bus = createEventBus();
    const fn = vi.fn();

    bus.onTaskUpdated(fn);
    bus.emitTaskUpdated({ id: '1' });
    bus.emitTaskUpdated({ id: '2' });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates listener errors and does not call later listeners', () => {
    const bus = createEventBus();
    const error = new Error('listener failed');
    const secondListener = vi.fn();

    bus.onTaskUpdated(() => {
      throw error;
    });
    bus.onTaskUpdated(secondListener);

    expect(() => bus.emitTaskUpdated({ id: '1' })).toThrow(error);
    expect(secondListener).not.toHaveBeenCalled();
  });

  it('returns registered listener functions for an event', () => {
    const bus = createEventBus();
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    bus.onTaskEvent(fn1);
    bus.onTaskEvent(fn2);

    expect(bus.listeners('task-event')).toEqual([fn1, fn2]);
  });

  it('passes the shutdown reason to shutdown listeners', () => {
    const bus = createEventBus();
    const fn = vi.fn();

    bus.onShutdown(fn);
    bus.emitShutdown('maintenance');

    expect(fn).toHaveBeenCalledWith('maintenance');
  });

  it('passes task event data to listeners', () => {
    const bus = createEventBus();
    const fn = vi.fn();
    const event = { type: 'cancel', taskId: '123' };

    bus.onTaskEvent(fn);
    bus.emitTaskEvent(event);

    expect(fn).toHaveBeenCalledWith(event);
  });

  it('notifies all listeners registered for the same event', () => {
    const bus = createEventBus();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const payload = { id: '1' };

    bus.onTaskUpdated(fn1);
    bus.onTaskUpdated(fn2);
    bus.emitTaskUpdated(payload);

    expect(fn1).toHaveBeenCalledWith(payload);
    expect(fn2).toHaveBeenCalledWith(payload);
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
