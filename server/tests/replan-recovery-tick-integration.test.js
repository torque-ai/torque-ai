'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

describe('factory-tick wires runReplanRecoverySweep', () => {
  beforeEach(() => { setupTestDbOnly(`replan-tick-${Date.now()}`); });
  afterEach(() => { teardownTestDb(); });

  it('CLOSED_FACTORY_WORK_ITEM_STATUSES includes needs_review and superseded', () => {
    const factoryTick = require('../factory/factory-tick');
    if (factoryTick.CLOSED_FACTORY_WORK_ITEM_STATUSES) {
      expect(factoryTick.CLOSED_FACTORY_WORK_ITEM_STATUSES.has('needs_review')).toBe(true);
      expect(factoryTick.CLOSED_FACTORY_WORK_ITEM_STATUSES.has('superseded')).toBe(true);
    } else {
      // Set is module-private; assert by reading the source.
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(path.join(__dirname, '..', 'factory', 'factory-tick.js'), 'utf8');
      expect(src).toMatch(/CLOSED_FACTORY_WORK_ITEM_STATUSES[\s\S]*needs_review/);
      expect(src).toMatch(/CLOSED_FACTORY_WORK_ITEM_STATUSES[\s\S]*superseded/);
    }
  });
});

describe('rejected-recovery non-recoverable patterns', () => {
  it('treats dismissed_from_inbox as non-recoverable', () => {
    const { isAutoRejectedReason } = require('../factory/rejected-recovery');
    expect(isAutoRejectedReason('dismissed_from_inbox: user does not want this')).toBe(false);
  });
});

describe('startup disjointness assertion', () => {
  it('passes when replan reasons and rejected-recovery patterns are disjoint', () => {
    const { defaultRegistry } = require('../factory/recovery-strategies/registry');
    const rewriteStrategy = require('../factory/recovery-strategies/rewrite-description');
    const decomposeStrategy = require('../factory/recovery-strategies/decompose');
    const escalateStrategy = require('../factory/recovery-strategies/escalate-architect');
    defaultRegistry.clear();
    defaultRegistry.register(rewriteStrategy);
    defaultRegistry.register(decomposeStrategy);
    defaultRegistry.register(escalateStrategy);
    const { assertDisjointReasonPatterns } = require('../factory/replan-recovery-bootstrap');
    expect(() => assertDisjointReasonPatterns()).not.toThrow();
  });
});
