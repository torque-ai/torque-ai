'use strict';

const { describe, it, expect, vi } = require('vitest');
const { createApprovalPolicy } = require('../evals/approval-policy');
const { runSample, runSamples } = require('../evals/run-sample');
const { createScorer } = require('../evals/scorer');
const { createSolver } = require('../evals/solver');
const { createTaskSpec } = require('../evals/task-spec');

describe('evals/run-sample', () => {
  it('routes solver tool calls through approval policy rewrites', async () => {
    const callTool = vi.fn(async (_tool, args) => ({ output: args.cmd }));
    const task = createTaskSpec({
      name: 'rewrite',
      dataset: [{ cmd: 'rm -rf /' }],
      solver: createSolver({
        name: 'tool-user',
        run: async (sample, ctx) => ctx.callTool('shell', { cmd: sample.cmd }),
      }),
      scorer: createScorer({ kind: 'match', target: () => 'echo -rf /' }),
      approvalPolicy: createApprovalPolicy({
        rules: [{
          match: { tool: 'shell', args_prefix: { cmd: 'rm ' } },
          action: 'modify',
          rewrite: ({ args }) => ({ ...args, cmd: args.cmd.replace(/^rm /, 'echo ') }),
        }],
      }),
    });

    const result = await runSample(task, task.dataset[0], { callTool });

    expect(callTool).toHaveBeenCalledWith('shell', { cmd: 'echo -rf /' });
    expect(result.status).toBe('completed');
    expect(result.score.value).toBe(1);
  });

  it('records rejected samples as blocked before the underlying tool is called', async () => {
    const callTool = vi.fn();
    const task = createTaskSpec({
      name: 'blocked',
      dataset: [{ cmd: 'cat /etc/passwd' }],
      solver: createSolver({
        name: 'tool-user',
        run: async (sample, ctx) => ctx.callTool('shell', { cmd: sample.cmd }),
      }),
      scorer: createScorer({ kind: 'match', target: () => 'never' }),
      approvalPolicy: createApprovalPolicy({
        rules: [{ match: { tool: 'shell' }, action: 'reject' }],
      }),
    });

    const result = await runSample(task, task.dataset[0], { callTool });

    expect(callTool).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked');
    expect(result.blocked).toBe(true);
    expect(result.score.value).toBe(0);
    expect(result.approval.action).toBe('reject');
  });

  it('pauses a batch when approval policy escalates a sample', async () => {
    const onEscalate = vi.fn(async () => ({ queued: true, task_id: 'review-1' }));
    const task = createTaskSpec({
      name: 'pause-on-escalate',
      dataset: [{ id: 1 }, { id: 2 }],
      solver: createSolver({
        name: 'tool-user',
        run: async (_sample, ctx) => ctx.callTool('deploy', { target: 'prod' }),
      }),
      scorer: createScorer({ kind: 'match', target: () => 'unused' }),
      approvalPolicy: createApprovalPolicy({
        rules: [{ match: { tool: 'deploy' }, action: 'escalate' }],
      }),
    });

    const result = await runSamples(task, {
      callTool: vi.fn(),
      onEscalate,
    });

    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].status).toBe('paused');
    expect(result.aggregate.paused_count).toBe(1);
    expect(result.aggregate.remaining).toBe(1);
  });
});
