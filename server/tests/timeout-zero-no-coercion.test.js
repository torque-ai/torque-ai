'use strict';

// Regression guard for `timeout_minutes = 0` semantics.
//
// Prior code paths used `task.timeout_minutes || 30`, which coerces an
// explicit 0 to 30 (since 0 is falsy). Users who set 0 meaning "run until
// done" were silently capped at 30 minutes. The fix switches the persistence
// sites to `?? 30` (preserves 0, defaults only null/undefined) and gates the
// process-lifecycle setTimeout behind `rawTimeout > 0` so a 0 skips timeout
// enforcement entirely. cancel_task and stall detection still apply.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

describe('timeout_minutes=0 no-coercion guard (static source check)', () => {
  // These sites previously coerced 0 → 30/120/300/60. Guard against the
  // `|| <N>` pattern re-appearing on any of the known-load-bearing names.
  // The test is deliberately a source-level check (no DB spin-up) so it runs
  // in a millisecond and catches regressions from file-level refactors.
  const SITES = [
    { file: 'server/db/project-config-core.js', forbid: [
      /schedule\.timeout_minutes\s*\|\|\s*30/,
      /config\.default_timeout\s*\|\|\s*30/,
      /config\.build_timeout\s*\|\|\s*120/,
      /config\.test_timeout\s*\|\|\s*300/,
      /config\.style_check_timeout\s*\|\|\s*60/,
      /projConfig\?\.default_timeout\s*\|\|\s*parseInt/,
    ]},
    { file: 'server/db/scheduling-automation.js', forbid: [
      /template\.default_timeout\s*\|\|\s*30/,
    ]},
    { file: 'server/db/task-metadata.js', forbid: [
      /group\.default_timeout\s*\|\|\s*30/,
    ]},
    { file: 'server/db/pipeline-crud.js', forbid: [
      /step\.timeout_minutes\s*\|\|\s*30/,
    ]},
  ];

  for (const site of SITES) {
    it(`${site.file} does not coerce 0 to default via ||`, () => {
      const src = readSource(site.file);
      for (const pattern of site.forbid) {
        expect(src).not.toMatch(pattern);
      }
    });
  }
});

describe('process-lifecycle timeout_minutes=0 gating', () => {
  // process-lifecycle.js must skip `setTimeout` entirely when the user
  // explicitly passes 0 (opt-in no-timeout). Negative / NaN / null values
  // still fall back to the default-and-clamp path. The guard is `explicitZero`
  // so future refactors that drop it will leak a 30-minute default back onto
  // opt-out tasks.
  it('gates procRef.timeoutHandle setTimeout on explicitZero', () => {
    const src = readSource('server/execution/process-lifecycle.js');
    const idx = src.indexOf('procRef.timeoutHandle = setTimeout');
    expect(idx).toBeGreaterThan(0);
    const window = src.slice(Math.max(0, idx - 400), idx);
    expect(window).toMatch(/explicitZero/);
  });

  it('parses timeout_minutes via parseInt + Number.isFinite, not || 30', () => {
    const src = readSource('server/execution/process-lifecycle.js');
    // Old pattern: `parseInt(task.timeout_minutes, 10) || 30` — forbid it.
    expect(src).not.toMatch(/parseInt\(task\.timeout_minutes,\s*10\)\s*\|\|\s*30/);
    // New pattern must use Number.isFinite to distinguish 0 from NaN.
    expect(src).toMatch(/Number\.isFinite\(parsedTimeout\)/);
  });

  it('preserves the existing one-minute minimum for negative / undersized values', () => {
    // Negative timeouts are treated as "malformed" and fall back to the
    // default+clamp path, not the opt-in no-timeout path. The existing
    // process-lifecycle minimum-timeout test (`timeout_minutes: -5` should
    // cancel after 1 minute) must continue to pass.
    const src = readSource('server/execution/process-lifecycle.js');
    expect(src).toMatch(/MIN_TIMEOUT_MINUTES\s*=\s*1/);
    expect(src).toMatch(/Math\.max\(MIN_TIMEOUT_MINUTES/);
  });
});
