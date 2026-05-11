'use strict';
const fs = require('fs');
const path = require('path');
describe('auto-recovery wiring', () => {
  it('DEFAULT_PLUGIN_NAMES includes auto-recovery-core', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    expect(src).toMatch(/DEFAULT_PLUGIN_NAMES.*auto-recovery-core/s);
  });
  it('factory-tick imports auto-recovery and calls engine.tick', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'factory', 'factory-tick.js'), 'utf8');
    expect(src).toMatch(/auto-recovery/);
    expect(src).toMatch(/autoRecoveryEngine/);
  });
  it('startup-reconciler calls reconcileOnStartup', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'factory', 'startup-reconciler.js'), 'utf8');
    expect(src).toMatch(/reconcileOnStartup/);
  });
  it('registers plugin recovery registries before DI boot', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const classifierIndex = src.indexOf("defaultContainer.registerValue('pluginClassifierRules'");
    const strategyIndex = src.indexOf("defaultContainer.registerValue('pluginRecoveryStrategies'");
    const bootIndex = src.indexOf('defaultContainer.boot()');

    expect(classifierIndex).toBeGreaterThan(-1);
    expect(strategyIndex).toBeGreaterThan(-1);
    expect(classifierIndex).toBeLessThan(bootIndex);
    expect(strategyIndex).toBeLessThan(bootIndex);
    expect(src).not.toContain('central registry registration failed');
  });
  it('verify-stall-recovery adds cooldown skip gate', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'factory', 'verify-stall-recovery.js'), 'utf8');
    expect(src).toMatch(/auto_recovery_last_action_at/);
  });
});
