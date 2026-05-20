/**
 * Tests for the 2026-05-04 ollama no-op defense hardening in
 * server/providers/execution.js.
 *
 * Covers:
 *  - shouldEscalateNoOpAgenticResult uses isFactoryExecutionTask as the
 *    authoritative signal for factory batch tasks (regardless of regex
 *    match on task_description).
 *  - HARD_FAIL_AGENTIC_STOP_REASONS includes 'no_edits_after_nudge'.
 *  - inspectHardFailAgenticStopReason returns a sensible message for
 *    'no_edits_after_nudge'.
 */
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const execution = require('../providers/execution');

function withTempProject(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-agentic-prompt-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('shouldEscalateNoOpAgenticResult — factory-batch structural check', () => {
  // The "Capture observable failure reasons" task description is the
  // exact shape that broke the original regex check: it has no verb
  // matching \b(create|add|write|implement|...)\b. Without the factory-
  // tag override, taskLikelyRequiresFileChanges returned false and the
  // no-op check skipped these tasks entirely.
  const factoryBatchTask = {
    id: 'wi-749-task-1',
    task_description: 'Capture observable LanStartupCoordinator failure reasons.',
    tags: JSON.stringify([
      'factory:project=example-project',
      'factory:batch_id=factory-b9261762-7be5-4fc9-9794-f18c3e404fcb-749',
      'factory:plan_task_number=1',
    ]),
    metadata: JSON.stringify({}),
  };

  const noOpResult = {
    toolLog: [{ name: 'read_file' }, { name: 'read_file' }],
    changedFiles: [],
  };

  const writeResult = {
    toolLog: [{ name: 'read_file' }, { name: 'edit_file' }],
    changedFiles: ['simtests/Foo.cs'],
  };

  it('escalates a factory batch task that produced 0 changes (regex would have missed)', () => {
    expect(execution.shouldEscalateNoOpAgenticResult(factoryBatchTask, noOpResult)).toBe(true);
  });

  it('does not escalate when the task did write files', () => {
    expect(execution.shouldEscalateNoOpAgenticResult(factoryBatchTask, writeResult)).toBe(false);
  });

  it('respects explicit read_only metadata even on factory batch tasks', () => {
    const readOnlyTask = {
      ...factoryBatchTask,
      metadata: JSON.stringify({ read_only: true }),
    };
    expect(execution.shouldEscalateNoOpAgenticResult(readOnlyTask, noOpResult)).toBe(false);
  });

  it('still escalates non-factory tasks with modification verbs in description', () => {
    const looseTask = {
      id: 'standalone-1',
      task_description: 'Add a new helper to foo.js',
      tags: JSON.stringify([]),
      metadata: JSON.stringify({}),
    };
    expect(execution.shouldEscalateNoOpAgenticResult(looseTask, noOpResult)).toBe(true);
  });

  it('does not escalate non-factory inspection tasks (preserves backwards-compat)', () => {
    const inspectionTask = {
      id: 'standalone-2',
      task_description: 'Capture observable failure reasons.',
      tags: JSON.stringify([]),
      metadata: JSON.stringify({}),
    };
    // No factory tag, no modification verb → falls back to the regex gate.
    // The regex doesn't match "capture", so the task is treated as inspection
    // and not escalated — same as before the hardening.
    expect(execution.shouldEscalateNoOpAgenticResult(inspectionTask, noOpResult)).toBe(false);
  });
});

describe('HARD_FAIL_AGENTIC_STOP_REASONS contains no_edits_after_nudge', () => {
  it('treats no_edits_after_nudge as a hard-fail reason', () => {
    expect(execution.HARD_FAIL_AGENTIC_STOP_REASONS.has('no_edits_after_nudge')).toBe(true);
  });
});

describe('inspectHardFailAgenticStopReason — no_edits_after_nudge wording', () => {
  it('returns a structured failure with the new stopReason', () => {
    const task = {
      id: 't1',
      task_description: 'Add a new test',
      tags: JSON.stringify([]),
      metadata: JSON.stringify({}),
    };
    const result = {
      stopReason: 'no_edits_after_nudge',
      output: 'Task stopped: model expected to modify files but produced 2 read-only tool call(s) and 0 writes after 2 corrective nudges.',
      toolLog: [{ name: 'read_file' }, { name: 'read_file' }],
    };
    const failure = execution.inspectHardFailAgenticStopReason(task, '/tmp', {}, result);
    expect(failure).toBeTruthy();
    expect(failure.stopReason).toBe('no_edits_after_nudge');
    expect(failure.message).toContain('no_edits_after_nudge');
    expect(failure.message).toContain('read-only');
  });
});

describe('buildAgenticTaskPrompt — factory plan generation context', () => {
  it('does not pre-stuff referenced file contents for factory plan-generation tasks', () => withTempProject((dir) => {
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'docs', 'old-plan.md'),
      'Historical guidance: dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release\n',
      'utf8',
    );

    const prompt = execution.buildAgenticTaskPrompt({
      id: 'plan-gen-1',
      task_description: 'Generate a plan using `docs/old-plan.md` as scope.',
      metadata: JSON.stringify({ factory_internal: true, kind: 'plan_generation' }),
      tags: JSON.stringify(['factory:internal', 'factory:plan_generation']),
    }, dir, 200000);

    expect(prompt).toContain('Generate a plan using `docs/old-plan.md` as scope.');
    expect(prompt).not.toContain('[PRE-LOADED FILES');
    expect(prompt).not.toContain('dotnet test simtests/SimCore.DotNet.Tests.csproj');
  }));

  it('still pre-stuffs referenced file contents for ordinary agentic tasks', () => withTempProject((dir) => {
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'note.md'), 'Visible note content\n', 'utf8');

    const prompt = execution.buildAgenticTaskPrompt({
      id: 'task-1',
      task_description: 'Update `docs/note.md`.',
      metadata: JSON.stringify({}),
      tags: JSON.stringify([]),
    }, dir, 200000);

    expect(prompt).toContain('[PRE-LOADED FILES');
    expect(prompt).toContain('--- FILE: docs/note.md ---');
    expect(prompt).toContain('Visible note content');
  }));
});
