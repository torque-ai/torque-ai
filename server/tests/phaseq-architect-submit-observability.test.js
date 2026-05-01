/**
 * Phase Q (2026-04-30): submitArchitectJsonPrompt's 5 null-return paths
 * each emit a structured warn with `[architect-submit] <mode>` so we can
 * distinguish them in logs.
 *
 * Pre-Phase-Q, all 5 returned `null` silently (except submit_failed which
 * logged a generic warn). Downstream parseStrictJson then threw "provider
 * response was not a string" — masking which upstream condition actually
 * triggered the null. Live evidence: DLPhone work item replan at
 * 03:29:15 UTC failed with `replan_recovery_strategy_failed: Strategy
 * "rewrite-description" threw or timed out: rewriteWorkItem: provider
 * response was not a string`.
 *
 * Test approach: read architect-runner.js source and assert each of the
 * 5 failure-mode log messages is present with the expected `[architect-
 * submit] <mode>` prefix and `kind=` + `project_id=` tags. This avoids
 * the vitest-doMock-vs-lazy-require mismatch that blocked dynamic
 * mocking of the internal-task-submit path. The source-grep approach is
 * brittle to refactors but reliable for verifying observability strings
 * are wired correctly.
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('Phase Q: submitArchitectJsonPrompt failure-mode logging strings', () => {
  let source;

  beforeAll(() => {
    source = fs.readFileSync(
      path.resolve(__dirname, '../factory/architect-runner.js'),
      'utf8',
    );
  });

  it('logs submit_failed with kind + project_id when submit throws', () => {
    expect(source).toMatch(/\[architect-submit\] submit_failed/);
    // The submit_failed log lives in the catch block right after submitFactoryInternalTask.
    expect(source).toMatch(/submit_failed kind=\$\{kind\} project_id=\$\{project_id\}/);
  });

  it('logs no_task_id when submit returns falsy task_id', () => {
    expect(source).toMatch(/\[architect-submit\] no_task_id/);
    expect(source).toMatch(/no_task_id kind=\$\{kind\} project_id=\$\{project_id\}/);
  });

  it('logs task_failed / task_cancelled with provider, task_id, and error_tail', () => {
    expect(source).toMatch(/\[architect-submit\] task_\$\{task\.status\}/);
    // The status interpolation produces "task_failed" or "task_cancelled" at runtime.
    expect(source).toMatch(/error_tail=\$\{JSON\.stringify\(errSnippet\)\}/);
    expect(source).toMatch(/provider=\$\{task\.provider \|\| '\?'\}/);
    expect(source).toMatch(/task_id=\$\{taskId\}/);
  });

  it('logs task_vanished when getTask returns null mid-poll', () => {
    expect(source).toMatch(/\[architect-submit\] task_vanished/);
    expect(source).toMatch(/task row not found mid-poll/);
  });

  it('logs deadline_exceeded when 5-min poll loop times out', () => {
    expect(source).toMatch(/\[architect-submit\] deadline_exceeded/);
    expect(source).toMatch(/no terminal status within \$\{deadlineMs\}ms/);
  });

  it('exports submitArchitectJsonPrompt for direct integration testing', () => {
    const ar = require('../factory/architect-runner');
    expect(ar._internalForTests).toBeDefined();
    expect(typeof ar._internalForTests.submitArchitectJsonPrompt).toBe('function');
  });

  it('all 5 failure modes are distinguishable by their unique tag', () => {
    // Each failure mode's tag is unique enough to grep in production logs.
    const tags = [
      'submit_failed',
      'no_task_id',
      'task_${task.status}', // covers task_failed AND task_cancelled
      'task_vanished',
      'deadline_exceeded',
    ];
    for (const tag of tags) {
      expect(source).toContain(`[architect-submit] ${tag}`);
    }
  });
});
