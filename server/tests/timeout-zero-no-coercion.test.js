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

describe('secondary execution-path timeout gating', () => {
  // The main setTimeout sits in process-lifecycle.js; these secondary abort
  // timers run inside each provider's execute function and would kick in at
  // 30 minutes even when the task opted out of the primary timeout. Gate
  // each on `timeoutMinutes === 0` so an explicit 0 gets the unbounded
  // behaviour end-to-end, not just at the primary level.
  const SECONDARY_SITES = [
    'server/providers/execute-ollama.js',
    'server/providers/execution.js',
  ];
  for (const rel of SECONDARY_SITES) {
    it(`${rel} gates its abort setTimeout on timeoutMinutes === 0`, () => {
      const src = readSource(rel);
      // Old pattern must be gone from every site.
      expect(src).not.toMatch(/\(task\.timeout_minutes\s*\|\|\s*30\)\s*\*\s*60\s*\*\s*1000/);
      // New pattern: ternary or conditional that skips setTimeout when 0.
      expect(src).toMatch(/timeoutMinutes\s*===\s*0/);
    });
  }

  it('server/index.js orphan-reconciler preserves timeout_minutes=0 via ??', () => {
    // index.js has a background orphan-requeue loop that uses timeout_minutes
    // to decide whether to reap stuck tasks. The `|| 30` variant would kick
    // in at 30 min for unbounded tasks; `??` lets 0 propagate into the
    // Math.max(GRACE_PERIOD_MS, 0) fallback.
    const src = readSource('server/index.js');
    expect(src).toMatch(/task\.timeout_minutes\s*\?\?\s*30/);
  });
});

describe('cloud-adapter HTTP abort-timer gating', () => {
  // Each cloud adapter had its own `(options.timeout || N) * 60 * 1000` +
  // unconditional `setTimeout(() => controller.abort(), timeout)`. execute-api
  // passes `timeout: task.timeout_minutes` straight through, so opt-in zero
  // landed here as the default N instead. Guard that none of them re-grow
  // the pattern.
  const ADAPTER_SITES = [
    'server/providers/anthropic.js',
    'server/providers/cerebras.js',
    'server/providers/deepinfra.js',
    'server/providers/google-ai.js',
    'server/providers/groq.js',
    'server/providers/hyperbolic.js',
    'server/providers/ollama-cloud.js',
    'server/providers/openrouter.js',
    'server/providers/ollama-strategic.js',
  ];
  for (const rel of ADAPTER_SITES) {
    it(`${rel} does not coerce 0 to default via (options.timeout || N)`, () => {
      const src = readSource(rel);
      expect(src).not.toMatch(/options\.timeout\s*\|\|\s*\d+/);
      expect(src).toMatch(/options\.timeout\s*\?\?\s*\d+/);
      expect(src).toMatch(/timeoutMinutes\s*>\s*0/);
    });
  }

  it('claude-code-sdk resolveTimeoutMs returns 0 on explicit 0 input', () => {
    const src = readSource('server/providers/claude-code-sdk.js');
    // Old shape: `Number(options.timeout || 0)` + `if (... > 0)` → fell through
    // to DEFAULT_TIMEOUT_MS on explicit 0. New shape must short-circuit to 0.
    expect(src).toMatch(/if\s*\(timeoutMs\s*===\s*0\)\s*return\s*0/);
    expect(src).toMatch(/if\s*\(timeoutMinutes\s*===\s*0\)\s*return\s*0/);
    // The one caller of timeoutMs must gate its setTimeout on >0.
    expect(src).toMatch(/if\s*\(timeoutMs\s*>\s*0\)\s*\{[\s\S]*?timeoutHandle\s*=\s*setTimeout/);
  });
});

describe('container.js initModules dead-code removal', () => {
  // `initModules` was defined in container.js but never called from anywhere.
  // Registering new services inside it was a silent trap — they never reached
  // the container. Keep the dead function out of the module exports so nobody
  // accidentally relies on it.
  it('does not export an initModules function', () => {
    const src = readSource('server/container.js');
    // Export block shouldn't list initModules as a key.
    expect(src).not.toMatch(/^\s*initModules,\s*$/m);
  });

  it('does not define a top-level initModules function', () => {
    const src = readSource('server/container.js');
    expect(src).not.toMatch(/^function\s+initModules\s*\(/m);
  });
});
