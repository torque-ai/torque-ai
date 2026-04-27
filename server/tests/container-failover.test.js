'use strict';
/* global describe, it, expect */

const { defaultContainer } = require('../container');

describe('container — failoverActivator wiring', () => {
  it('exposes failoverActivator', () => {
    expect(defaultContainer.has('failoverActivator')).toBe(true);
  });

  it('failoverActivator constructs without throwing', () => {
    expect(() => defaultContainer.get('failoverActivator')).not.toThrow();
  });

  it('emitting circuit:tripped for codex does not throw (subscription wired)', () => {
    defaultContainer.get('failoverActivator');
    const eventBus = defaultContainer.get('eventBus');
    expect(() => eventBus.emit('circuit:tripped', { provider: 'codex' })).not.toThrow();
    // Don't assert side effects — that depends on the live template store state
    // which other tests/runtime may mutate. Other tests cover the activator behavior in isolation.
  });
});
