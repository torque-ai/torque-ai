'use strict';
/* global describe, it, expect, beforeEach */

const { createContainer } = require('../container');

describe('container — circuit breaker wiring', () => {
  it('exposes providerCircuitBreakerStore in the DI registry (pre-boot)', () => {
    const { defaultContainer } = require('../container');
    expect(defaultContainer.has('providerCircuitBreakerStore')).toBe(true);
  });

  it('exposes circuitBreaker in the DI registry (pre-boot)', () => {
    const { defaultContainer } = require('../container');
    expect(defaultContainer.has('circuitBreaker')).toBe(true);
  });

  it('providerCircuitBreakerStore module exports a factory function', () => {
    const mod = require('../db/provider-circuit-breaker-store');
    expect(typeof mod.createProviderCircuitBreakerStore).toBe('function');
  });

  it('circuit-breaker module exports a factory function', () => {
    const mod = require('../execution/circuit-breaker');
    expect(typeof mod.createCircuitBreaker).toBe('function');
  });

  describe('runtime behaviour (fresh container with in-memory db)', () => {
    let container;

    beforeEach(() => {
      const Database = require('better-sqlite3');
      const rawDb = new Database(':memory:');
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS provider_circuit_breaker (
          provider_id        TEXT PRIMARY KEY NOT NULL,
          state              TEXT NOT NULL DEFAULT 'CLOSED',
          tripped_at         TEXT,
          untripped_at       TEXT,
          trip_reason        TEXT,
          last_canary_at     TEXT,
          last_canary_status TEXT
        )
      `);

      container = createContainer();
      container.registerValue('db', rawDb);
      container.registerValue('eventBus', { emit() {} });

      container.register('providerCircuitBreakerStore', ['db'], ({ db }) => {
        const { createProviderCircuitBreakerStore } = require('../db/provider-circuit-breaker-store');
        return createProviderCircuitBreakerStore({ db });
      });
      container.register(
        'circuitBreaker',
        ['eventBus', 'providerCircuitBreakerStore'],
        ({ eventBus, providerCircuitBreakerStore }) => {
          const { createCircuitBreaker } = require('../execution/circuit-breaker');
          return createCircuitBreaker({ eventBus, store: providerCircuitBreakerStore });
        }
      );

      container.boot();
    });

    it('providerCircuitBreakerStore instance exposes the expected API', () => {
      const store = container.get('providerCircuitBreakerStore');
      expect(typeof store.persist).toBe('function');
      expect(typeof store.getState).toBe('function');
      expect(typeof store.listAll).toBe('function');
    });

    it('circuitBreaker instance exposes the expected API', () => {
      const cb = container.get('circuitBreaker');
      expect(typeof cb.recordFailure).toBe('function');
      expect(typeof cb.recordSuccess).toBe('function');
      expect(typeof cb.allowRequest).toBe('function');
      expect(typeof cb.trip).toBe('function');
      expect(typeof cb.untrip).toBe('function');
    });

    it('circuitBreaker writes through to the persisted store', () => {
      const cb = container.get('circuitBreaker');
      const store = container.get('providerCircuitBreakerStore');
      const testProvider = 'codex-test-trip-' + Date.now();
      cb.trip(testProvider, 'unit_test');
      expect(store.getState(testProvider)).toMatchObject({
        state: 'OPEN',
        trip_reason: 'unit_test',
      });
      cb.untrip(testProvider, 'unit_test_cleanup');
    });
  });
});
