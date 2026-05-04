// Targeted tests for the bitsy-work-item-471 retry hardening:
//   1. buildVerifyFixPrompt / VERIFY_FIX_PROMPT_TAIL_BUDGET — tail-clip width
//   2. isProjectStatusPaused — project-row pause gate for pause_project
//   3. countPriorVerifyRetryTasksForBatch — persisted retry counter

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('buildVerifyFixPrompt', () => {
  let loopController;

  beforeEach(() => {
    // eslint-disable-next-line torque/no-reset-modules-in-each -- requires loop-controller fresh each run
    vi.resetModules();
    loopController = require('../factory/loop-controller');
  });

  it('exports a 16000-char tail budget', () => {
    expect(loopController.VERIFY_FIX_PROMPT_TAIL_BUDGET).toBe(16000);
  });

  it('preserves the tail of long verify output so the root-cause error survives', () => {
    // Simulate a pip/pytest failure: a very long preamble that exceeds the
    // 16 KB budget, a Python traceback, and the actual error at the very end.
    // The old 4 KB budget dropped the middle of the traceback and sometimes
    // dropped the error itself. 16 KB keeps everything that matters for
    // Codex to diagnose while still clipping noisy preambles.
    const preambleLine = 'COLLECT_PREAMBLE_LINE_THAT_MUST_BE_DROPPED\n'; // 43 chars
    const preamble = preambleLine.repeat(500); // ~21 500 chars — exceeds 16 KB
    const traceback = 'File ".../pkg/foo.py", line 42, in <module>\n    raise ValueError("oops")\n'.repeat(10);
    const rootCause = 'error: invalid command \'bdist_wheel\'\nsubprocess.CalledProcessError: exit 1';
    const verifyOutput = preamble + traceback + rootCause;
    expect(verifyOutput.length).toBeGreaterThan(loopController.VERIFY_FIX_PROMPT_TAIL_BUDGET);

    const prompt = loopController.buildVerifyFixPrompt({
      planPath: '/plans/foo.md',
      planTitle: 'Harden packaging',
      branch: 'feat/harden',
      verifyCommand: 'python -m pytest tests/ -q',
      verifyOutput,
    });

    // Root cause survives at the tail; that's the critical guarantee.
    expect(prompt).toContain(rootCause);
    expect(prompt).toContain('bdist_wheel');
    // At least some preamble lines are correctly dropped — otherwise the
    // clip would be a head-clip, which is the bug this fix addresses.
    const preambleMatches = (prompt.match(/COLLECT_PREAMBLE_LINE_THAT_MUST_BE_DROPPED/g) || []).length;
    expect(preambleMatches).toBeLessThan(500);
    // And the tail-clip budget bounds the embedded section length.
    // Two fenced blocks now: [1] is the verify-command echo (small),
    // [3] is the verify-output tail. Find the tail block by header.
    const tailIdx = prompt.indexOf('Verify output (tail):');
    expect(tailIdx).toBeGreaterThan(-1);
    const afterTailHeader = prompt.slice(tailIdx);
    const codeFenceBody = afterTailHeader.split('```')[1] || '';
    expect(codeFenceBody.length).toBeLessThanOrEqual(loopController.VERIFY_FIX_PROMPT_TAIL_BUDGET + 2);
  });

  it('tail-clip handles short verify output without truncating it', () => {
    const short = 'AssertionError: expected 1, got 2';
    const prompt = loopController.buildVerifyFixPrompt({
      planPath: null,
      planTitle: 'Minor fix',
      branch: 'feat/short',
      verifyCommand: 'npx vitest run',
      verifyOutput: short,
    });
    expect(prompt).toContain(short);
  });

  it('strips ANSI escape sequences before measuring the tail', () => {
    const ansiNoise = '\u001b[31mRED\u001b[0m'.repeat(100);
    const realError = 'final assertion failure here';
    const prompt = loopController.buildVerifyFixPrompt({
      planPath: null,
      planTitle: 'Test',
      branch: 'feat/ansi',
      verifyCommand: 'npm test',
      verifyOutput: ansiNoise + realError,
    });
    expect(prompt).toContain(realError);
    expect(prompt).not.toContain('\u001b[');
  });

  it('wraps verifyCommand in a fenced diagnostic block so the heavy-validation guard ignores it', () => {
    // Regression for DLPhone WI #749 (2026-05-04): codex auto-verify-retry
    // tasks failed via [Governance] heavy local validation rule because
    // `Verify command: dotnet test ...` was emitted bare on a single line,
    // which the guard's regex caught. Wrapping in a fenced block under a
    // recognized diagnostic header (matched by DIAGNOSTIC_FENCE_HEADER_RE)
    // keeps the command informational without tripping the guard.
    const { findHeavyLocalValidationCommand } = require('../utils/heavy-validation-guard');
    const verifyCommand = 'dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter "Category!=RequiresAndroidBuild"';
    const prompt = loopController.buildVerifyFixPrompt({
      planPath: '/plans/foo.md',
      planTitle: 'WI 749',
      branch: 'feat/factory-749',
      verifyCommand,
      verifyOutput: 'AssertionError: expected 1, got 2',
    });

    // Without the fenced wrap, this returns a non-null detection and the
    // governance rule blocks the codex submission with a 0s failure.
    expect(findHeavyLocalValidationCommand(prompt, { ignoreDiagnosticFencedBlocks: true })).toBeNull();
    // The verify command must still appear in the prompt for the model
    // to know what runs after it edits.
    expect(prompt).toContain(verifyCommand);
  });
});

describe('isProjectStatusPaused', () => {
  let loopController;
  let factoryHealth;

  beforeEach(() => {
    // eslint-disable-next-line torque/no-reset-modules-in-each -- requires factory-health and loop-controller fresh each run
    vi.resetModules();
    factoryHealth = require('../db/factory-health');
    loopController = require('../factory/loop-controller');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when project_id is missing', () => {
    expect(loopController.isProjectStatusPaused(null)).toBe(false);
    expect(loopController.isProjectStatusPaused(undefined)).toBe(false);
    expect(loopController.isProjectStatusPaused('')).toBe(false);
  });

  it('returns true when factory_projects.status is "paused"', () => {
    vi.spyOn(factoryHealth, 'getProject').mockReturnValue({ id: 'p1', status: 'paused' });
    expect(loopController.isProjectStatusPaused('p1')).toBe(true);
  });

  it('returns false when status is running/idle/missing', () => {
    vi.spyOn(factoryHealth, 'getProject').mockReturnValue({ id: 'p1', status: 'running' });
    expect(loopController.isProjectStatusPaused('p1')).toBe(false);
  });

  it('returns false when getProject returns null (unknown project)', () => {
    vi.spyOn(factoryHealth, 'getProject').mockReturnValue(null);
    expect(loopController.isProjectStatusPaused('p1')).toBe(false);
  });

  it('fails closed (returns false) if factoryHealth.getProject throws', () => {
    vi.spyOn(factoryHealth, 'getProject').mockImplementation(() => {
      throw new Error('db locked');
    });
    // Failing closed means the loop can still advance on transient DB errors;
    // the alternative (failing open = treating it as paused) would freeze
    // the factory on any DB hiccup, which is worse.
    expect(loopController.isProjectStatusPaused('p1')).toBe(false);
  });
});

describe('countPriorVerifyRetryTasksForBatch', () => {
  let loopController;
  let taskCore;

  beforeEach(() => {
    // eslint-disable-next-line torque/no-reset-modules-in-each -- requires task-core and loop-controller fresh each run
    vi.resetModules();
    taskCore = require('../db/task-core');
    loopController = require('../factory/loop-controller');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 when batch_id is missing', () => {
    expect(loopController.countPriorVerifyRetryTasksForBatch(null)).toBe(0);
    expect(loopController.countPriorVerifyRetryTasksForBatch('')).toBe(0);
  });

  it('counts only tasks with a factory:verify_retry=* tag', () => {
    vi.spyOn(taskCore, 'listTasks').mockReturnValue([
      { id: 't1', tags: ['factory:batch_id=B1', 'factory:plan_task_number=1'] }, // not a retry
      { id: 't2', tags: ['factory:batch_id=B1', 'factory:verify_retry=1'] },
      { id: 't3', tags: ['factory:batch_id=B1', 'factory:verify_retry=2'] },
      { id: 't4', tags: ['factory:batch_id=B1', 'factory:verify_retry=3'] },
    ]);
    expect(loopController.countPriorVerifyRetryTasksForBatch('B1')).toBe(3);
  });

  it('returns 0 when no retries have been submitted yet for this batch', () => {
    vi.spyOn(taskCore, 'listTasks').mockReturnValue([
      { id: 't1', tags: ['factory:batch_id=B1', 'factory:plan_task_number=1'] },
      { id: 't2', tags: ['factory:batch_id=B1', 'factory:plan_task_number=2'] },
    ]);
    expect(loopController.countPriorVerifyRetryTasksForBatch('B1')).toBe(0);
  });

  it('ignores tasks with malformed or missing tag arrays', () => {
    vi.spyOn(taskCore, 'listTasks').mockReturnValue([
      { id: 't1', tags: null },
      { id: 't2' }, // no tags key at all
      { id: 't3', tags: 'string-not-array' },
      { id: 't4', tags: ['factory:batch_id=B1', 'factory:verify_retry=1'] },
    ]);
    expect(loopController.countPriorVerifyRetryTasksForBatch('B1')).toBe(1);
  });

  it('fails closed (returns 0) if listTasks throws', () => {
    vi.spyOn(taskCore, 'listTasks').mockImplementation(() => {
      throw new Error('db unavailable');
    });
    expect(loopController.countPriorVerifyRetryTasksForBatch('B1')).toBe(0);
  });

  it('querying with the batch tag includes only tasks from this batch', () => {
    const listSpy = vi.spyOn(taskCore, 'listTasks').mockReturnValue([]);
    loopController.countPriorVerifyRetryTasksForBatch('factory-XYZ-471');
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({
      tags: ['factory:batch_id=factory-XYZ-471'],
    }));
  });
});
