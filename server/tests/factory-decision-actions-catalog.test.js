'use strict';

const path = require('node:path');
const { runDecisionActionsAudit } = require('../factory/scripts/audit-decision-actions');
const { DECISION_ACTIONS } = require('../factory/decision-actions');

describe('factory decision-actions catalog', () => {
  let report;

  beforeAll(() => {
    const rootDir = path.resolve(__dirname, '../../');
    report = runDecisionActionsAudit({ rootDir, catalog: DECISION_ACTIONS });
  });

  it('every emitted action is in the catalog', () => {
    expect(report.emitted_not_in_catalog).toEqual([]);
  });

  it('every emitted action has a classifier (rule, benign-skip, terminal, or engine)', () => {
    expect(report.emitted_no_classifier).toEqual([]);
  });

  it('every catalog rule_id reference matches a real rule in rules.js', () => {
    expect(report.rule_id_mismatch).toEqual([]);
  });

  it('catalog has no orphan entries (dead documentation)', () => {
    expect(report.catalog_not_emitted).toEqual([]);
  });

  it('reports dynamic-action sites for manual review (non-fatal)', () => {
    if (report.dynamic_action_sites.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`Dynamic action sites (manual review): ${report.dynamic_action_sites.length}`);
    }
    expect(Array.isArray(report.dynamic_action_sites)).toBe(true);
  });
});
