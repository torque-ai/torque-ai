'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { discoverEmitSites } = require('../factory/scripts/audit-decision-actions');

function makeFixtureDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-decisions-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

describe('discoverEmitSites', () => {
  it('extracts literal action from single-arg logDecision({ ... })', () => {
    const dir = makeFixtureDir({
      'foo.js': `logDecision({ project_id: 1, stage: 'PLAN', action: 'generated_plan', outcome: {} });`,
    });
    const { literal_emissions, dynamic_action_sites } = discoverEmitSites(dir);
    expect([...literal_emissions.keys()]).toEqual(['generated_plan']);
    expect(dynamic_action_sites).toEqual([]);
  });

  it('extracts literal action from db-prefix logDecision(db, { ... })', () => {
    const dir = makeFixtureDir({
      'foo.js': `logDecision(db, { project_id, stage: 'verify', action: 'auto_recovery_classified', outcome: {} });`,
    });
    const { literal_emissions } = discoverEmitSites(dir);
    expect([...literal_emissions.keys()]).toEqual(['auto_recovery_classified']);
  });

  it('records dynamic-action sites where action is not a literal', () => {
    const dir = makeFixtureDir({
      'foo.js': `logDecision({ project_id: 1, action: \`prefix_\${stage}\`, outcome: {} });`,
    });
    const { literal_emissions, dynamic_action_sites } = discoverEmitSites(dir);
    expect([...literal_emissions.keys()]).toEqual([]);
    expect(dynamic_action_sites.length).toBe(1);
    expect(dynamic_action_sites[0].snippet).toContain('prefix_');
  });

  it('records the same action multiple times when emitted from multiple sites', () => {
    const dir = makeFixtureDir({
      'a.js': `logDecision({ action: 'verified_batch', outcome: {} });`,
      'b.js': `logDecision({ action: 'verified_batch', outcome: {} });`,
    });
    const { literal_emissions } = discoverEmitSites(dir);
    expect(literal_emissions.get('verified_batch').length).toBe(2);
  });
});
