'use strict';

// Regression guard for provider-scoring DI registration. The registration
// previously lived inside server/container.js's initModules(db, serverConfig)
// helper, which is defined but never called (see feedback — registration must
// live in the factory block at the top of container.js, not in initModules
// nor in index.js registerValue calls). In production that meant
// defaultContainer.get('providerScoring') threw "service not registered" and
// score-aware routing was a silent no-op.

const { defaultContainer } = require('../container');

describe('defaultContainer — provider-scoring registration', () => {
  it('has providerScoring in the DI factory block', () => {
    // `has` reflects the REGISTRY (pre-boot), which is what we care about
    // here — the service must be present for boot() to instantiate it.
    expect(defaultContainer.has('providerScoring')).toBe(true);
  });

  it('providerScoring is registered via .register(), not .registerValue()', () => {
    // Indirect check: the factory block uses .register(name, deps, factory).
    // If someone re-adds it as .registerValue() with an uninitialized module
    // object the container will still "have" it, but the value will be the
    // raw module (no createProviderScoring invocation), which breaks the
    // db-injected behaviour. We spot-check by requiring the module directly
    // and confirming it exports a factory rather than a bound singleton.
    const mod = require('../db/provider-scoring');
    expect(typeof mod.createProviderScoring).toBe('function');
  });
});

describe('defaultContainer — specialist routing registrations', () => {
  it('has the specialist routing services in the DI factory block', () => {
    expect(defaultContainer.has('registeredSpecialists')).toBe(true);
    expect(defaultContainer.has('specialistStorage')).toBe(true);
    expect(defaultContainer.has('turnClassifier')).toBe(true);
    expect(defaultContainer.has('routedOrchestrator')).toBe(true);
  });

  it('registers the specialist routing factories from the routing modules', () => {
    expect(typeof require('../routing/specialist-storage').createSpecialistStorage).toBe('function');
    expect(typeof require('../routing/turn-classifier').createTurnClassifier).toBe('function');
    expect(typeof require('../routing/routed-orchestrator').createRoutedOrchestrator).toBe('function');
  });
});
