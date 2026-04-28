'use strict';
/* global describe, it, expect, beforeEach, vi */

const { createFailoverActivator } = require('../routing/failover-activator');

function makeEventBus() {
  const subs = new Map();
  return {
    on(event, fn) {
      const arr = subs.get(event) || [];
      arr.push(fn);
      subs.set(event, arr);
    },
    emit(event, payload) {
      (subs.get(event) || []).forEach((fn) => fn(payload));
    },
  };
}

describe('failover-activator', () => {
  let store, eventBus, logger;

  beforeEach(() => {
    store = {
      getActiveName: vi.fn(() => 'system-default'),
      setActive: vi.fn(),
    };
    eventBus = makeEventBus();
    logger = { info: vi.fn(), warn: vi.fn() };
  });

  it('on circuit:tripped for codex, swaps to codex-down-failover', () => {
    createFailoverActivator({ store, eventBus, logger });
    eventBus.emit('circuit:tripped', { provider: 'codex' });
    expect(store.setActive).toHaveBeenCalledWith('preset-codex-down-failover');
  });

  it('ignores non-codex circuit:tripped', () => {
    createFailoverActivator({ store, eventBus, logger });
    eventBus.emit('circuit:tripped', { provider: 'groq' });
    expect(store.setActive).not.toHaveBeenCalled();
  });

  it('on circuit:recovered for codex, restores prior template', () => {
    store.getActiveName.mockReturnValueOnce('quality-first'); // prior
    createFailoverActivator({ store, eventBus, logger });
    eventBus.emit('circuit:tripped', { provider: 'codex' });
    eventBus.emit('circuit:recovered', { provider: 'codex' });
    expect(store.setActive).toHaveBeenLastCalledWith('quality-first');
  });

  it('ignores duplicate trip while already on codex-down-failover', () => {
    store.getActiveName.mockReturnValue('preset-codex-down-failover');
    createFailoverActivator({ store, eventBus, logger });
    eventBus.emit('circuit:tripped', { provider: 'codex' });
    expect(store.setActive).not.toHaveBeenCalled();
  });

  it('does not throw when store.setActive throws', () => {
    store.setActive.mockImplementation(() => { throw new Error('disk full'); });
    createFailoverActivator({ store, eventBus, logger });
    expect(() => eventBus.emit('circuit:tripped', { provider: 'codex' })).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('handles null payload without throwing', () => {
    createFailoverActivator({ store, eventBus, logger });
    expect(() => eventBus.emit('circuit:tripped', null)).not.toThrow();
    expect(() => eventBus.emit('circuit:recovered', undefined)).not.toThrow();
  });

  it('throws on missing store or eventBus', () => {
    expect(() => createFailoverActivator({ eventBus, logger })).toThrow(/store/);
    expect(() => createFailoverActivator({ store, logger })).toThrow(/eventBus/);
  });

  it('on recovered without prior trip, no-op (no setActive call)', () => {
    createFailoverActivator({ store, eventBus, logger });
    eventBus.emit('circuit:recovered', { provider: 'codex' });
    expect(store.setActive).not.toHaveBeenCalled();
  });
});
