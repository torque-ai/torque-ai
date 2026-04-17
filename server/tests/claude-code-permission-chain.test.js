'use strict';

const { evaluatePermission } = require('../providers/claude-code/permission-chain');

describe('evaluatePermission', () => {
  it('allowed_tools in settings -> allow', async () => {
    const result = await evaluatePermission({
      toolName: 'Read',
      args: { path: 'a.js' },
      settings: { allowed_tools: ['Read'], disallowed_tools: [] },
      mode: 'auto',
      hooks: [],
    });

    expect(result.decision).toBe('allow');
    expect(result.reason).toMatch(/settings\.allowed_tools/);
  });

  it('disallowed_tools in settings -> deny (even in bypassPermissions)', async () => {
    const result = await evaluatePermission({
      toolName: 'Bash',
      args: { cmd: 'rm -rf /' },
      settings: { allowed_tools: [], disallowed_tools: ['Bash'] },
      mode: 'bypassPermissions',
      hooks: [],
    });

    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/disallowed/);
  });

  it('hook returning deny short-circuits', async () => {
    const hook = vi.fn(async () => ({ decision: 'deny', reason: 'pii detected' }));
    const result = await evaluatePermission({
      toolName: 'Read',
      args: { path: 'a.js' },
      settings: { allowed_tools: ['Read'], disallowed_tools: [] },
      mode: 'auto',
      hooks: [hook],
    });

    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/pii/);
  });

  it('hook returning modify swaps args', async () => {
    const hook = vi.fn(async ({ args }) => ({ decision: 'modify', args: { path: `${args.path}.redacted` } }));
    const result = await evaluatePermission({
      toolName: 'Read',
      args: { path: 'a.js' },
      settings: { allowed_tools: ['Read'], disallowed_tools: [] },
      mode: 'auto',
      hooks: [hook],
    });

    expect(result.decision).toBe('allow');
    expect(result.modified_args).toEqual({ path: 'a.js.redacted' });
  });

  it('mode=plan -> deny writes, allow reads', async () => {
    const writeResult = await evaluatePermission({
      toolName: 'Edit',
      args: {},
      settings: {},
      mode: 'plan',
      hooks: [],
    });
    const readResult = await evaluatePermission({
      toolName: 'Read',
      args: {},
      settings: {},
      mode: 'plan',
      hooks: [],
    });

    expect(writeResult.decision).toBe('deny');
    expect(readResult.decision).toBe('allow');
  });

  it('mode=acceptEdits -> auto-allow Edit without prompt', async () => {
    const result = await evaluatePermission({
      toolName: 'Edit',
      args: {},
      settings: {},
      mode: 'acceptEdits',
      hooks: [],
    });

    expect(result.decision).toBe('allow');
    expect(result.reason).toMatch(/acceptEdits/);
  });

  it('fallback to runtime canUseTool callback when undecided', async () => {
    const canUseTool = vi.fn(async () => ({ decision: 'allow' }));
    const result = await evaluatePermission({
      toolName: 'Custom',
      args: {},
      settings: {},
      mode: 'auto',
      hooks: [],
      canUseTool,
    });

    expect(canUseTool).toHaveBeenCalled();
    expect(result.decision).toBe('allow');
  });

  it('no decision anywhere -> default deny', async () => {
    const result = await evaluatePermission({
      toolName: 'Bash',
      args: {},
      settings: {},
      mode: 'auto',
      hooks: [],
    });

    expect(result.decision).toBe('deny');
  });
});
