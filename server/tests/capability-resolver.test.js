'use strict';

const { resolveMethod, tryResolveMethod } = require('../execution/capability-resolver');
const { createContainer } = require('../container');

describe('capability-resolver', () => {
  describe('resolveMethod', () => {
    it('throws if spec.method is missing', () => {
      expect(() => resolveMethod({}, {})).toThrow(/spec\.method/);
    });

    it('prefers explicit localDeps[legacyKey] when provided', () => {
      const calls = [];
      const fn = resolveMethod(
        { cancelTask: (id) => calls.push(['direct', id]) },
        { capability: 'taskCanceller', method: 'cancelTask', legacyHandle: 'taskManager', legacyKey: 'cancelTask' }
      );
      fn('t1');
      expect(calls).toEqual([['direct', 't1']]);
    });

    it('falls back to legacyHandle.method when no explicit override', () => {
      const calls = [];
      const tm = { cancelTask: (id) => calls.push(['tm', id]) };
      const fn = resolveMethod(
        { taskManager: tm },
        { capability: 'taskCanceller', method: 'cancelTask', legacyHandle: 'taskManager', legacyKey: 'cancelTask' }
      );
      fn('t2');
      expect(calls).toEqual([['tm', 't2']]);
    });

    it('throws with descriptive resolution chain when nothing resolves', () => {
      const fn = resolveMethod({}, {
        capability: 'missingCapability',
        method: 'cancelTask',
        legacyHandle: 'taskManager',
        legacyKey: 'cancelTask',
      });
      expect(() => fn('t3')).toThrow(/cancelTask.*localDeps\.cancelTask.*missingCapability.*localDeps\.taskManager/);
    });

    it('resolves dynamically — registration after factory construction is honored', () => {
      // Pilot for the lazy-resolution architecture: each call to fn()
      // re-checks the container, so a capability registered AFTER fn
      // was created still wins.
      const calls = [];
      const tm = { cancelTask: (id) => calls.push(['tm-fallback', id]) };

      // Factory built before any container registration
      const fn = resolveMethod(
        { taskManager: tm },
        { capability: 'taskCanceller', method: 'cancelTask', legacyHandle: 'taskManager', legacyKey: 'cancelTask' }
      );

      // First call: routes through taskManager fallback
      fn('a');

      // Now register a taskCanceller in the default container —
      // simulating boot ordering or a test swapping in a mock mid-flight.
      const { defaultContainer } = require('../container');
      const hadPriorRegistration = defaultContainer.has && defaultContainer.has('taskCanceller');
      const priorValue = hadPriorRegistration ? defaultContainer.peek('taskCanceller') : null;
      try {
        const mockTaskCanceller = {
          cancelTask: (id) => calls.push(['canceller', id]),
        };
        // override() is the post-boot test seam — works without a fresh boot
        defaultContainer.override('taskCanceller', mockTaskCanceller);

        // Second call to the same fn: now routes through the registered capability
        fn('b');

        expect(calls).toEqual([
          ['tm-fallback', 'a'],
          ['canceller', 'b'],
        ]);
      } finally {
        // Restore prior state
        if (hadPriorRegistration && priorValue !== undefined) {
          defaultContainer.override('taskCanceller', priorValue);
        }
      }
    });

    it('isolated container: lookups walk the default container only', () => {
      // resolveMethod always reaches the defaultContainer (that's the
      // architectural decision). A test using an isolated container
      // can still test the override path via the legacyKey or
      // legacyHandle paths.
      const isolated = createContainer();
      isolated.registerValue('taskCanceller', { cancelTask: () => 'isolated-cancel' });

      // The resolver doesn't see isolated — so explicit overrides win.
      const fn = resolveMethod(
        { cancelTask: () => 'explicit-direct' },
        { capability: 'taskCanceller', method: 'cancelTask', legacyHandle: 'taskManager', legacyKey: 'cancelTask' }
      );
      expect(fn()).toBe('explicit-direct');
    });
  });

  describe('tryResolveMethod', () => {
    it('returns undefined instead of throwing when nothing resolves', () => {
      const fn = tryResolveMethod({}, {
        capability: 'missingX',
        method: 'doThing',
        legacyHandle: 'noHandle',
        legacyKey: 'doThing',
      });
      expect(fn()).toBeUndefined();
    });
  });
});
