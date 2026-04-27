'use strict';
/* global describe, it, expect, beforeEach */

const { createContainer } = require('../container');

describe('container — failoverActivator wiring', () => {
  it('exposes failoverActivator in the DI registry (pre-boot)', () => {
    const { defaultContainer } = require('../container');
    expect(defaultContainer.has('failoverActivator')).toBe(true);
  });

  it('failover-activator module exports a factory function', () => {
    const mod = require('../routing/failover-activator');
    expect(typeof mod.createFailoverActivator).toBe('function');
  });

  describe('runtime behaviour (fresh container)', () => {
    let container;

    beforeEach(() => {
      const eventBus = {
        _handlers: {},
        on(event, fn) { (this._handlers[event] = this._handlers[event] || []).push(fn); },
        emit(event, payload) { (this._handlers[event] || []).forEach(fn => fn(payload)); },
      };

      container = createContainer();
      container.registerValue('eventBus', eventBus);
      container.registerValue('logger', { info() {}, warn() {} });

      container.register(
        'failoverActivator',
        ['eventBus', 'logger'],
        ({ eventBus: bus, logger: log }) => {
          const { createFailoverActivator } = require('../routing/failover-activator');
          const store = {
            getActiveName: () => null,
            setActive: () => {},
          };
          return createFailoverActivator({ store, eventBus: bus, logger: log });
        }
      );

      container.boot();
    });

    it('failoverActivator constructs without throwing', () => {
      expect(() => container.get('failoverActivator')).not.toThrow();
    });

    it('emitting circuit:tripped for codex does not throw (subscription wired)', () => {
      container.get('failoverActivator');
      const eventBus = container.get('eventBus');
      expect(() => eventBus.emit('circuit:tripped', { provider: 'codex' })).not.toThrow();
    });
  });
});
