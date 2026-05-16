'use strict';

const baselineAutoFix = require('../factory/baseline-auto-fix');

const {
  BASELINE_FIX_ATTEMPT_CAP,
  BASELINE_FIX_PRIORITY,
  parseFailingTestsFromProbeOutput,
  getBaselineFixAttempts,
  buildBaselineFixWorkItemFields,
  runBaselineAutoFix,
  repauseIfBaselineFixTerminal,
} = baselineAutoFix;

// ── Test doubles ─────────────────────────────────────────────────────────────

function makeDeps(overrides = {}) {
  const calls = {
    updateProject: [],
    createWorkItem: [],
    recordDecision: [],
    getWorkItem: [],
  };
  const deps = {
    db: {},
    logger: { info() {}, warn() {}, debug() {} },
    factoryHealth: {
      updateProject(id, fields) {
        calls.updateProject.push({ id, fields });
        return { id, ...fields };
      },
    },
    factoryIntake: {
      setDb() {},
      createWorkItem(fields) {
        calls.createWorkItem.push(fields);
        return { id: 7777, ...fields };
      },
      getWorkItem(id) {
        calls.getWorkItem.push(id);
        return overrides.workItem === undefined ? { id, status: 'executing' } : overrides.workItem;
      },
      isClosedWorkItem(item) {
        return new Set([
          'completed', 'rejected', 'shipped', 'shipped_stale',
          'unactionable', 'needs_review', 'superseded', 'escalation_exhausted',
        ]).has(item && item.status);
      },
    },
    factoryDecisions: {
      setDb() {},
      recordDecision(d) {
        calls.recordDecision.push(d);
      },
    },
  };
  if (overrides.createWorkItem) deps.factoryIntake.createWorkItem = overrides.createWorkItem;
  return { deps, calls };
}

// ── parseFailingTestsFromProbeOutput ─────────────────────────────────────────

describe('parseFailingTestsFromProbeOutput', () => {
  it('extracts xUnit FQN test names before [FAIL]', () => {
    const output = [
      '[xUnit.net 00:01:29.59]     SpudgetBooks.Infrastructure.UnitTests.Accounting.IntercompanyLoanServiceTests.When_CreateLoanAsyncCalledWithInvalidPrincipalAmount_Then_ThrowsAndDoesNotPersist [FAIL]',
      '[xUnit.net 00:01:31.23]     SpudgetBooks.Infrastructure.UnitTests.InvoiceServiceTests.ReapplyPaymentAsync_MovesPaymentToTargetInvoice [FAIL]',
    ].join('\n');
    const r = parseFailingTestsFromProbeOutput(output);
    expect(r).toContain('SpudgetBooks.Infrastructure.UnitTests.Accounting.IntercompanyLoanServiceTests.When_CreateLoanAsyncCalledWithInvalidPrincipalAmount_Then_ThrowsAndDoesNotPersist');
    expect(r).toContain('SpudgetBooks.Infrastructure.UnitTests.InvoiceServiceTests.ReapplyPaymentAsync_MovesPaymentToTargetInvoice');
    expect(r).toHaveLength(2);
  });

  it('extracts pytest FAILED lines', () => {
    const output = 'FAILED tests/test_ledger.py::test_balances\nFAILED tests/test_audit.py::test_chain';
    const r = parseFailingTestsFromProbeOutput(output);
    expect(r).toContain('tests/test_ledger.py::test_balances');
    expect(r).toContain('tests/test_audit.py::test_chain');
  });

  it('de-duplicates repeated failing tests', () => {
    const output = 'Foo.Bar.BazTests.Qux [FAIL]\nFoo.Bar.BazTests.Qux [FAIL]';
    expect(parseFailingTestsFromProbeOutput(output)).toEqual(['Foo.Bar.BazTests.Qux']);
  });

  it('returns [] for empty / null / non-string input', () => {
    expect(parseFailingTestsFromProbeOutput('')).toEqual([]);
    expect(parseFailingTestsFromProbeOutput(null)).toEqual([]);
    expect(parseFailingTestsFromProbeOutput(undefined)).toEqual([]);
    expect(parseFailingTestsFromProbeOutput(42)).toEqual([]);
  });

  it('does not false-match a bare word before [FAIL]', () => {
    // single token (no dots) must not be captured as an xUnit FQN
    expect(parseFailingTestsFromProbeOutput('something [FAIL]')).toEqual([]);
  });
});

// ── getBaselineFixAttempts ───────────────────────────────────────────────────

describe('getBaselineFixAttempts', () => {
  it('returns 0 for missing / zero / invalid counters', () => {
    expect(getBaselineFixAttempts({})).toBe(0);
    expect(getBaselineFixAttempts({ baseline_fix_attempts: 0 })).toBe(0);
    expect(getBaselineFixAttempts({ baseline_fix_attempts: 'nope' })).toBe(0);
    expect(getBaselineFixAttempts(null)).toBe(0);
  });

  it('returns the floored counter when valid', () => {
    expect(getBaselineFixAttempts({ baseline_fix_attempts: 2 })).toBe(2);
    expect(getBaselineFixAttempts({ baseline_fix_attempts: 3 })).toBe(3);
  });
});

// ── buildBaselineFixWorkItemFields ───────────────────────────────────────────

describe('buildBaselineFixWorkItemFields', () => {
  it('builds a high-priority self_generated work item naming the failing tests', () => {
    const f = buildBaselineFixWorkItemFields({
      projectId: 'proj-1',
      failingTests: ['A.B.CTests.One', 'A.B.CTests.Two'],
      attemptNumber: 1,
    });
    expect(f.project_id).toBe('proj-1');
    expect(f.source).toBe('self_generated');
    expect(f.priority).toBe(BASELINE_FIX_PRIORITY);
    expect(f.priority).toBeGreaterThan(90); // outranks 'high'
    expect(f.title).toContain('2 failing baseline tests');
    expect(f.description).toContain('A.B.CTests.One');
    expect(f.description).toContain('A.B.CTests.Two');
  });

  it('embeds the anti-test-gaming + red-zone-invariant instructions verbatim', () => {
    const f = buildBaselineFixWorkItemFields({ projectId: 'p', failingTests: ['X.Y.Z'], attemptNumber: 1 });
    expect(f.description).toMatch(/do NOT modify, weaken, skip, or delete/i);
    expect(f.description).toMatch(/red-zone invariants/i);
    expect(f.description).toMatch(/audit hash chain/i);
    expect(f.description).toMatch(/never relax the test/i);
  });

  it('caps the listed tests and notes the overflow', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Ns.Cls.Test${i}`);
    const f = buildBaselineFixWorkItemFields({ projectId: 'p', failingTests: many, attemptNumber: 2 });
    expect(f.description).toMatch(/\.\.\.and 15 more/);
    expect(f.title).toContain('40 failing baseline tests');
  });

  it('records traceable origin metadata', () => {
    const f = buildBaselineFixWorkItemFields({ projectId: 'p', failingTests: ['X.Y.Z'], attemptNumber: 3 });
    const origin = JSON.parse(f.origin_json);
    expect(origin.kind).toBe('baseline_auto_fix');
    expect(origin.attempt).toBe(3);
    expect(origin.failing_tests).toEqual(['X.Y.Z']);
  });
});

// ── runBaselineAutoFix ───────────────────────────────────────────────────────

describe('runBaselineAutoFix', () => {
  it('creates a fix work item, resumes the project, and increments the counter (under cap)', () => {
    const { deps, calls } = makeDeps();
    const cfg = { baseline_broken_since: '2026-05-09T00:00:00Z' };
    const result = runBaselineAutoFix({
      project: { id: 'proj-1' },
      cfg,
      probe: { output: 'Ns.Cls.FailingTest [FAIL]' },
      deps,
    });
    expect(result.action).toBe('created');
    expect(result.work_item_id).toBe(7777);
    expect(calls.createWorkItem).toHaveLength(1);
    expect(cfg.baseline_fix_attempts).toBe(1);
    expect(cfg.baseline_fix_work_item_id).toBe(7777);
    // project resumed to running
    const update = calls.updateProject.find((u) => u.fields.status === 'running');
    expect(update).toBeTruthy();
    // a creation decision was recorded
    expect(calls.recordDecision.some((d) => d.action === 'baseline_auto_fix_work_item_created')).toBe(true);
  });

  it('escalates without creating a work item once the attempt cap is reached', () => {
    const { deps, calls } = makeDeps();
    const cfg = { baseline_fix_attempts: BASELINE_FIX_ATTEMPT_CAP };
    const result = runBaselineAutoFix({ project: { id: 'p' }, cfg, probe: { output: 'X.Y.Z [FAIL]' }, deps });
    expect(result.action).toBe('exhausted');
    expect(calls.createWorkItem).toHaveLength(0);
    expect(calls.recordDecision.some((d) => d.action === 'baseline_auto_fix_exhausted')).toBe(true);
    expect(cfg.baseline_fix_exhausted_at).toBeTruthy();
    // project must NOT be resumed on exhaustion
    expect(calls.updateProject.every((u) => u.fields.status !== 'running')).toBe(true);
  });

  it('escalates only once — subsequent exhausted calls are silent', () => {
    const { deps, calls } = makeDeps();
    const cfg = { baseline_fix_attempts: BASELINE_FIX_ATTEMPT_CAP, baseline_fix_exhausted_at: '2026-05-15T00:00:00Z' };
    const result = runBaselineAutoFix({ project: { id: 'p' }, cfg, probe: { output: '' }, deps });
    expect(result.action).toBe('exhausted');
    expect(result.already_escalated).toBe(true);
    expect(calls.recordDecision).toHaveLength(0);
  });

  it('reports create_failed without resuming the project when createWorkItem throws', () => {
    const { deps, calls } = makeDeps({
      createWorkItem() { throw new Error('intake rejected'); },
    });
    const cfg = {};
    const result = runBaselineAutoFix({ project: { id: 'p' }, cfg, probe: { output: 'X.Y.Z [FAIL]' }, deps });
    expect(result.action).toBe('create_failed');
    expect(cfg.baseline_fix_attempts).toBeUndefined();
    expect(calls.updateProject).toHaveLength(0);
  });
});

// ── repauseIfBaselineFixTerminal ─────────────────────────────────────────────

describe('repauseIfBaselineFixTerminal', () => {
  it('no-ops when there is no tracked fix work item', () => {
    const { deps, calls } = makeDeps();
    const result = repauseIfBaselineFixTerminal({ project: { id: 'p' }, cfg: {}, deps });
    expect(result.action).toBe('no_fix_item');
    expect(calls.updateProject).toHaveLength(0);
  });

  it('leaves the project running while the fix work item is still in progress', () => {
    const { deps, calls } = makeDeps({ workItem: { id: 7777, status: 'executing' } });
    const result = repauseIfBaselineFixTerminal({
      project: { id: 'p' },
      cfg: { baseline_fix_work_item_id: 7777 },
      deps,
    });
    expect(result.action).toBe('fix_in_progress');
    expect(calls.updateProject).toHaveLength(0);
  });

  it('re-pauses the project once the fix work item reaches a terminal status', () => {
    const { deps, calls } = makeDeps({ workItem: { id: 7777, status: 'rejected' } });
    const cfg = { baseline_broken_since: '2026-05-09T00:00:00Z', baseline_fix_work_item_id: 7777 };
    const result = repauseIfBaselineFixTerminal({ project: { id: 'p' }, cfg, deps });
    expect(result.action).toBe('repaused');
    const update = calls.updateProject.find((u) => u.fields.status === 'paused');
    expect(update).toBeTruthy();
    // the tracked work item id is cleared from the persisted config
    expect(JSON.parse(update.fields.config_json).baseline_fix_work_item_id).toBeUndefined();
    expect(calls.recordDecision.some((d) => d.action === 'baseline_auto_fix_repaused_for_reprobe')).toBe(true);
  });

  it('treats a missing fix work item as terminal and re-pauses', () => {
    const { deps, calls } = makeDeps({ workItem: null });
    const result = repauseIfBaselineFixTerminal({
      project: { id: 'p' },
      cfg: { baseline_fix_work_item_id: 9999 },
      deps,
    });
    expect(result.action).toBe('repaused');
    expect(calls.updateProject.some((u) => u.fields.status === 'paused')).toBe(true);
  });
});
