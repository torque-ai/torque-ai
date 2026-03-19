'use strict';

const { init, handleRequest, SERVER_INFO } = require('../mcp-protocol');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOL_A = { name: 'tool_a', description: 'Tool A' };
const TOOL_B = { name: 'tool_b', description: 'Tool B' };
const TOOL_C = { name: 'tool_c', description: 'Tool C' };

const ALL_TOOLS = [TOOL_A, TOOL_B, TOOL_C];
const CORE_NAMES = ['tool_a'];
const EXTENDED_NAMES = ['tool_a', 'tool_b'];

function makeSession(toolMode = 'full') {
  return { toolMode };
}

function makeHandlerReturning(result) {
  return async (_name, _args, _session) => result;
}

function reinit(overrides = {}) {
  init({
    tools: ALL_TOOLS,
    coreToolNames: CORE_NAMES,
    extendedToolNames: EXTENDED_NAMES,
    handleToolCall: makeHandlerReturning({ content: [{ type: 'text', text: 'ok' }] }),
    onInitialize: null,
    ...overrides,
  });
}

// Reset to a clean state before every test so module-level state doesn't bleed
beforeEach(() => {
  reinit();
});

// ---------------------------------------------------------------------------
// 1. initialize
// ---------------------------------------------------------------------------

describe('initialize', () => {
  it('returns correct protocol version, capabilities, and server info', async () => {
    const session = makeSession();
    const result = await handleRequest({ method: 'initialize', params: {} }, session);

    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo).toEqual(SERVER_INFO);
    expect(result.serverInfo.name).toBe('torque');
  });

  it('calls onInitialize callback with the session', async () => {
    const session = makeSession();
    const onInitialize = vi.fn();
    reinit({ onInitialize });

    await handleRequest({ method: 'initialize', params: {} }, session);

    expect(onInitialize).toHaveBeenCalledOnce();
    expect(onInitialize).toHaveBeenCalledWith(session);
  });

  it('does not throw when no onInitialize is provided', async () => {
    reinit({ onInitialize: null });
    const session = makeSession();
    await expect(handleRequest({ method: 'initialize', params: {} }, session)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. tools/list — full mode
// ---------------------------------------------------------------------------

describe('tools/list full mode', () => {
  it('returns all tools when toolMode is full', async () => {
    const session = makeSession('full');
    const result = await handleRequest({ method: 'tools/list' }, session);

    expect(result.tools).toHaveLength(ALL_TOOLS.length);
    expect(result.tools).toEqual(expect.arrayContaining(ALL_TOOLS));
  });

  it('returns a copy, not the original array reference', async () => {
    const session = makeSession('full');
    const result = await handleRequest({ method: 'tools/list' }, session);

    expect(result.tools).not.toBe(ALL_TOOLS);
  });
});

// ---------------------------------------------------------------------------
// 3. tools/list — core mode
// ---------------------------------------------------------------------------

describe('tools/list core mode', () => {
  it('returns only core tools when toolMode is core', async () => {
    const session = makeSession('core');
    const result = await handleRequest({ method: 'tools/list' }, session);

    expect(result.tools).toHaveLength(CORE_NAMES.length);
    expect(result.tools.map(t => t.name)).toEqual(CORE_NAMES);
  });

  it('does not include non-core tools', async () => {
    const session = makeSession('core');
    const result = await handleRequest({ method: 'tools/list' }, session);
    const names = result.tools.map(t => t.name);

    expect(names).not.toContain('tool_b');
    expect(names).not.toContain('tool_c');
  });
});

// ---------------------------------------------------------------------------
// 4. tools/list — extended mode
// ---------------------------------------------------------------------------

describe('tools/list extended mode', () => {
  it('returns only extended tools when toolMode is extended', async () => {
    const session = makeSession('extended');
    const result = await handleRequest({ method: 'tools/list' }, session);

    expect(result.tools).toHaveLength(EXTENDED_NAMES.length);
    expect(result.tools.map(t => t.name)).toEqual(expect.arrayContaining(EXTENDED_NAMES));
  });

  it('does not include tools outside the extended set', async () => {
    const session = makeSession('extended');
    const result = await handleRequest({ method: 'tools/list' }, session);
    const names = result.tools.map(t => t.name);

    expect(names).not.toContain('tool_c');
  });
});

// ---------------------------------------------------------------------------
// 5. unknown method
// ---------------------------------------------------------------------------

describe('unknown method', () => {
  it('throws -32601 for an unrecognised method', async () => {
    const session = makeSession();
    await expect(
      handleRequest({ method: 'no_such_method' }, session)
    ).rejects.toMatchObject({ code: -32601 });
  });

  it('includes the method name in the error message', async () => {
    const session = makeSession();
    await expect(
      handleRequest({ method: 'totally_unknown' }, session)
    ).rejects.toMatchObject({ message: expect.stringContaining('totally_unknown') });
  });
});

// ---------------------------------------------------------------------------
// 6. tools/call — success
// ---------------------------------------------------------------------------

describe('tools/call success', () => {
  it('dispatches to handleToolCall with the correct name and args', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'result' }] }));
    reinit({ handleToolCall: handler });

    const session = makeSession('full');
    await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a', arguments: { x: 1 } } },
      session
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith('tool_a', { x: 1 }, session);
  });

  it('returns the handler result unchanged', async () => {
    const content = [{ type: 'text', text: 'hello' }];
    reinit({ handleToolCall: async () => ({ content }) });

    const session = makeSession('full');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(result).toEqual({ content });
  });

  it('passes empty object for missing arguments', async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    reinit({ handleToolCall: handler });

    const session = makeSession('full');
    await handleRequest({ method: 'tools/call', params: { name: 'tool_a' } }, session);

    expect(handler).toHaveBeenCalledWith('tool_a', {}, session);
  });
});

// ---------------------------------------------------------------------------
// 7. tools/call — mode enforcement
// ---------------------------------------------------------------------------

describe('tools/call mode enforcement', () => {
  it('blocks a tool not in core mode', async () => {
    const session = makeSession('core');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_b' } },
      session
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tool_b');
    expect(result.content[0].text).toContain('core');
  });

  it('blocks a tool not in extended mode', async () => {
    const session = makeSession('extended');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_c' } },
      session
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tool_c');
    expect(result.content[0].text).toContain('extended');
  });

  it('allows a tool present in core mode', async () => {
    const session = makeSession('core');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(result.isError).toBeFalsy();
  });

  it('allows any tool in full mode', async () => {
    const session = makeSession('full');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_c' } },
      session
    );

    expect(result.isError).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 8. tools/call — unlock (__unlock_all_tools)
// ---------------------------------------------------------------------------

describe('tools/call unlock all tools', () => {
  it('updates session.toolMode to full and sets _toolsChanged', async () => {
    const unlockResult = {
      __unlock_all_tools: true,
      content: [{ type: 'text', text: 'unlocked' }],
    };
    reinit({ handleToolCall: async () => unlockResult });

    const session = makeSession('core');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(session.toolMode).toBe('full');
    expect(session._toolsChanged).toBe(true);
    expect(result).toEqual({ content: unlockResult.content });
  });

  it('does not set _toolsChanged if mode is already full', async () => {
    const unlockResult = {
      __unlock_all_tools: true,
      content: [{ type: 'text', text: 'already full' }],
    };
    reinit({ handleToolCall: async () => unlockResult });

    const session = makeSession('full');
    await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(session._toolsChanged).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. tools/call — unlock_tier
// ---------------------------------------------------------------------------

describe('tools/call unlock_tier', () => {
  async function callWithTier(tier, startMode = 'core') {
    reinit({
      handleToolCall: async () => ({
        __unlock_tier: tier,
        content: [{ type: 'text', text: `tier ${tier}` }],
      }),
    });
    const session = makeSession(startMode);
    await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );
    return session;
  }

  it('tier 1 → core mode', async () => {
    const session = await callWithTier(1, 'extended');
    expect(session.toolMode).toBe('core');
    expect(session._toolsChanged).toBe(true);
  });

  it('tier 2 → extended mode', async () => {
    const session = await callWithTier(2, 'core');
    expect(session.toolMode).toBe('extended');
    expect(session._toolsChanged).toBe(true);
  });

  it('tier 3 → full mode', async () => {
    const session = await callWithTier(3, 'core');
    expect(session.toolMode).toBe('full');
    expect(session._toolsChanged).toBe(true);
  });

  it('high tier (e.g. 99) → full mode', async () => {
    const session = await callWithTier(99, 'core');
    expect(session.toolMode).toBe('full');
  });

  it('returns only the content portion', async () => {
    const content = [{ type: 'text', text: 'tier unlock' }];
    reinit({
      handleToolCall: async () => ({ __unlock_tier: 2, content }),
    });
    const session = makeSession('core');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );
    expect(result).toEqual({ content });
  });
});

// ---------------------------------------------------------------------------
// 10. tools/call — error handling
// ---------------------------------------------------------------------------

describe('tools/call error handling', () => {
  it('catches a thrown Error and returns isError content', async () => {
    reinit({
      handleToolCall: async () => { throw new Error('boom'); },
    });

    const session = makeSession('full');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom');
  });

  it('catches a thrown string and returns isError content', async () => {
    reinit({
      handleToolCall: async () => { throw 'string error'; },
    });

    const session = makeSession('full');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error:');
  });
});

// ---------------------------------------------------------------------------
// 11. tools/call — missing name
// ---------------------------------------------------------------------------

describe('tools/call missing name', () => {
  it('throws -32602 when params is null', async () => {
    const session = makeSession('full');
    await expect(
      handleRequest({ method: 'tools/call', params: null }, session)
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('throws -32602 when name is missing', async () => {
    const session = makeSession('full');
    await expect(
      handleRequest({ method: 'tools/call', params: { arguments: {} } }, session)
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('throws -32602 when name is not a string', async () => {
    const session = makeSession('full');
    await expect(
      handleRequest({ method: 'tools/call', params: { name: 42 } }, session)
    ).rejects.toMatchObject({ code: -32602 });
  });
});

// ---------------------------------------------------------------------------
// 12. notifications
// ---------------------------------------------------------------------------

describe('notifications', () => {
  it('returns null for notifications/initialized', async () => {
    const session = makeSession();
    const result = await handleRequest({ method: 'notifications/initialized' }, session);
    expect(result).toBeNull();
  });

  it('returns null for notifications/cancelled', async () => {
    const session = makeSession();
    const result = await handleRequest({ method: 'notifications/cancelled' }, session);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 13. uninitialized — _handleToolCall is null
// ---------------------------------------------------------------------------

describe('uninitialized handler', () => {
  it('throws -32603 when handleToolCall has not been set', async () => {
    init({
      tools: ALL_TOOLS,
      coreToolNames: CORE_NAMES,
      extendedToolNames: EXTENDED_NAMES,
      handleToolCall: null,
    });

    const session = makeSession('full');
    await expect(
      handleRequest({ method: 'tools/call', params: { name: 'tool_a' } }, session)
    ).rejects.toMatchObject({ code: -32603 });
  });
});

// ---------------------------------------------------------------------------
// 14. invalid request object
// ---------------------------------------------------------------------------

describe('invalid request', () => {
  it('throws -32600 for a non-object request', async () => {
    const session = makeSession();
    await expect(handleRequest(null, session)).rejects.toMatchObject({ code: -32600 });
    await expect(handleRequest('string', session)).rejects.toMatchObject({ code: -32600 });
    await expect(handleRequest(42, session)).rejects.toMatchObject({ code: -32600 });
  });
});
