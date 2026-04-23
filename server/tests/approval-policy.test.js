'use strict';

const { createApprovalPolicy } = require('../evals/approval-policy');

describe('ApprovalPolicy', () => {
  it('approves a tool that matches an allow rule', async () => {
    const policy = createApprovalPolicy({
      rules: [{ match: { tool: 'read_file' }, action: 'approve' }],
    });

    expect((await policy.evaluate({ tool: 'read_file', args: {} })).action).toBe('approve');
  });

  it('rejects a tool that matches a reject rule', async () => {
    const policy = createApprovalPolicy({
      rules: [{ match: { tool: 'rm_rf' }, action: 'reject' }],
    });

    expect((await policy.evaluate({ tool: 'rm_rf', args: {} })).action).toBe('reject');
  });

  it('modify rewrites args via rewriter fn', async () => {
    const policy = createApprovalPolicy({
      rules: [{
        match: { tool: 'shell', args_prefix: { cmd: 'rm ' } },
        action: 'modify',
        rewrite: (ctx) => ({ ...ctx.args, cmd: ctx.args.cmd.replace(/^rm /, 'echo ') }),
      }],
    });

    const result = await policy.evaluate({ tool: 'shell', args: { cmd: 'rm -rf /' } });

    expect(result.action).toBe('modify');
    expect(result.args.cmd).toBe('echo -rf /');
  });

  it('escalate returns pending status for human review', async () => {
    const policy = createApprovalPolicy({
      rules: [{ match: { tool: 'deploy' }, action: 'escalate' }],
    });

    expect((await policy.evaluate({ tool: 'deploy', args: {} })).action).toBe('escalate');
  });

  it('terminate halts the sample', async () => {
    const policy = createApprovalPolicy({
      rules: [{ match: { tool: 'exfil' }, action: 'terminate' }],
    });

    expect((await policy.evaluate({ tool: 'exfil', args: {} })).action).toBe('terminate');
  });

  it('first matching rule wins; default=approve', async () => {
    const policy = createApprovalPolicy({
      rules: [
        { match: { tool: 'shell', args_prefix: { cmd: 'ls' } }, action: 'approve' },
        { match: { tool: 'shell' }, action: 'escalate' },
      ],
    });

    expect((await policy.evaluate({ tool: 'shell', args: { cmd: 'ls -la' } })).action).toBe('approve');
    expect((await policy.evaluate({ tool: 'shell', args: { cmd: 'cat /etc/passwd' } })).action).toBe('escalate');
    expect((await policy.evaluate({ tool: 'other', args: {} })).action).toBe('approve');
  });
});
