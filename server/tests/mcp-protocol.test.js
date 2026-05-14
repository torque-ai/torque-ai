'use strict';

const { init, handleRequest, SERVER_INFO, parseStreamingArtifacts, journalArtifactActions } = require('../mcp/protocol');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOL_A = { name: 'tool_a', description: 'Tool A' };
const TOOL_B = { name: 'tool_b', description: 'Tool B' };
const TOOL_C = { name: 'tool_c', description: 'Tool C' };
const PLUGIN_TOOL = { name: 'plugin_tool', description: 'Plugin tool' };

const ALL_TOOLS = [TOOL_A, TOOL_B, TOOL_C, PLUGIN_TOOL];
const CORE_NAMES = ['tool_a'];
const EXTENDED_NAMES = ['tool_a', 'tool_b'];

function makeSession(toolMode = 'full', authenticated = true) {
  return { toolMode, authenticated };
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
    expect(onInitialize).toHaveBeenCalledWith(session, expect.anything());
  });

  it('does not throw when no onInitialize is provided', async () => {
    reinit({ onInitialize: null });
    const session = makeSession();
    await expect(handleRequest({ method: 'initialize', params: {} }, session)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. authentication
// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('rejects unauthenticated sessions', async () => {
    const session = { toolMode: 'core', authenticated: false };
    await expect(handleRequest({ method: 'tools/list' }, session))
      .rejects.toMatchObject({ code: -32600 });
  });

  it('allows authenticated sessions', async () => {
    const session = { toolMode: 'core', authenticated: true };
    const result = await handleRequest({ method: 'tools/list' }, session);
    expect(result.tools).toBeDefined();
  });

  it('allows initialize without auth (needed to establish connection)', async () => {
    const session = { toolMode: 'core', authenticated: false };
    const result = await handleRequest({ method: 'initialize' }, session);
    expect(result.protocolVersion).toBe('2024-11-05');
  });
});

// ---------------------------------------------------------------------------
// 3. tools/list — full mode
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
// 4. tools/list — core mode
// ---------------------------------------------------------------------------

describe('tools/list core mode', () => {
  it('returns only core tools when toolMode is core', async () => {
    const session = makeSession('core');
    const result = await handleRequest({ method: 'tools/list' }, session);

    expect(result.tools).toHaveLength(CORE_NAMES.length);
    expect(result.tools.map((t) => t.name)).toEqual(CORE_NAMES);
  });

  it('does not include extended-only or untiered tools', async () => {
    const session = makeSession('core');
    const result = await handleRequest({ method: 'tools/list' }, session);
    const names = result.tools.map((t) => t.name);

    expect(names).not.toContain('tool_b');
    expect(names).not.toContain('tool_c');
    expect(names).not.toContain(PLUGIN_TOOL.name);
  });
});

// ---------------------------------------------------------------------------
// 5. tools/list — extended mode
// ---------------------------------------------------------------------------

describe('tools/list extended mode', () => {
  it('returns only extended tools when toolMode is extended', async () => {
    const session = makeSession('extended');
    const result = await handleRequest({ method: 'tools/list' }, session);

    expect(result.tools).toHaveLength(EXTENDED_NAMES.length);
    expect(result.tools.map((t) => t.name)).toEqual(EXTENDED_NAMES);
  });

  it('does not include untiered tools in extended mode', async () => {
    const session = makeSession('extended');
    const result = await handleRequest({ method: 'tools/list' }, session);
    const names = result.tools.map((t) => t.name);

    expect(names).not.toContain('tool_c');
    expect(names).not.toContain(PLUGIN_TOOL.name);
  });
});

// ---------------------------------------------------------------------------
// 6. unknown method
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
// 7. tools/call — success
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
// 8. tools/call — mode enforcement
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

  it('blocks untiered tools in extended mode', async () => {
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

  it('allows a tool present in extended mode', async () => {
    const session = makeSession('extended');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_b' } },
      session
    );

    expect(result.isError).toBeFalsy();
  });

  it('blocks untiered plugin tools in restricted modes', async () => {
    const coreSession = makeSession('core');
    const extendedSession = makeSession('extended');

    const coreResult = await handleRequest(
      { method: 'tools/call', params: { name: PLUGIN_TOOL.name } },
      coreSession
    );
    const extendedResult = await handleRequest(
      { method: 'tools/call', params: { name: PLUGIN_TOOL.name } },
      extendedSession
    );

    expect(coreResult.isError).toBe(true);
    expect(coreResult.content[0].text).toContain(PLUGIN_TOOL.name);
    expect(coreResult.content[0].text).toContain('core');
    expect(extendedResult.isError).toBe(true);
    expect(extendedResult.content[0].text).toContain(PLUGIN_TOOL.name);
    expect(extendedResult.content[0].text).toContain('extended');
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
// 9. tools/call — unlock (__unlock_all_tools)
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
// 10. tools/call — unlock_tier
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
// 11. tools/call — error handling
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
// 12. tools/call — missing name
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
// 13. notifications
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
// 14. uninitialized — _handleToolCall is null
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
// 15. invalid request object
// ---------------------------------------------------------------------------

describe('invalid request', () => {
  it('throws -32600 for a non-object request', async () => {
    const session = makeSession();
    await expect(handleRequest(null, session)).rejects.toMatchObject({ code: -32600 });
    await expect(handleRequest('string', session)).rejects.toMatchObject({ code: -32600 });
    await expect(handleRequest(42, session)).rejects.toMatchObject({ code: -32600 });
  });
});

// ---------------------------------------------------------------------------
// 16. parseStreamingArtifacts
// ---------------------------------------------------------------------------

describe('parseStreamingArtifacts', () => {
  it('returns empty array for null/undefined/non-string input', () => {
    expect(parseStreamingArtifacts(null)).toEqual([]);
    expect(parseStreamingArtifacts(undefined)).toEqual([]);
    expect(parseStreamingArtifacts(42)).toEqual([]);
  });

  it('returns empty array when no action tags present', () => {
    expect(parseStreamingArtifacts('plain text with no tags')).toEqual([]);
  });

  it('parses a single file action', () => {
    const text = '<action type="file" path="src/index.js">console.log("hi");</action>';
    const result = parseStreamingArtifacts(text);
    expect(result).toEqual([
      { type: 'file', path: 'src/index.js', content: 'console.log("hi");' },
    ]);
  });

  it('parses a single shell action', () => {
    const text = '<action type="shell" cmd="npm install">installing deps</action>';
    const result = parseStreamingArtifacts(text);
    expect(result).toEqual([
      { type: 'shell', cmd: 'npm install', content: 'installing deps' },
    ]);
  });

  it('parses multiple mixed actions from one string', () => {
    const text = [
      'Some preamble text.',
      '<action type="file" path="a.txt">file content A</action>',
      'middle text',
      '<action type="shell" cmd="echo hello">hello output</action>',
      '<action type="file" path="b.js">const b = 1;</action>',
    ].join('\n');
    const result = parseStreamingArtifacts(text);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'file', path: 'a.txt', content: 'file content A' });
    expect(result[1]).toEqual({ type: 'shell', cmd: 'echo hello', content: 'hello output' });
    expect(result[2]).toEqual({ type: 'file', path: 'b.js', content: 'const b = 1;' });
  });

  it('handles multiline content inside action tags', () => {
    const text = '<action type="file" path="multi.js">line1\nline2\nline3</action>';
    const result = parseStreamingArtifacts(text);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('line1\nline2\nline3');
  });

  it('handles empty content inside action tags', () => {
    const text = '<action type="file" path="empty.txt"></action>';
    const result = parseStreamingArtifacts(text);
    expect(result).toEqual([{ type: 'file', path: 'empty.txt', content: '' }]);
  });

  it('does not set path for shell actions or cmd for file actions', () => {
    const fileText = '<action type="file" path="f.txt">data</action>';
    const shellText = '<action type="shell" cmd="ls">output</action>';
    const fileResult = parseStreamingArtifacts(fileText);
    const shellResult = parseStreamingArtifacts(shellText);
    expect(fileResult[0]).not.toHaveProperty('cmd');
    expect(shellResult[0]).not.toHaveProperty('path');
  });

  it('resets global regex state between consecutive calls', () => {
    const text = '<action type="file" path="a.js">a</action>';
    const first = parseStreamingArtifacts(text);
    const second = parseStreamingArtifacts(text);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });

  it('omits path when file action has no path attribute', () => {
    // Regex makes path optional — a file action without path= should still parse
    const text = '<action type="file">bare content</action>';
    const result = parseStreamingArtifacts(text);
    expect(result).toEqual([{ type: 'file', content: 'bare content' }]);
    expect(result[0]).not.toHaveProperty('path');
  });

  it('omits cmd when shell action has no cmd attribute', () => {
    const text = '<action type="shell">bare shell</action>';
    const result = parseStreamingArtifacts(text);
    expect(result).toEqual([{ type: 'shell', content: 'bare shell' }]);
    expect(result[0]).not.toHaveProperty('cmd');
  });
});

// ---------------------------------------------------------------------------
// 17. journalArtifactActions
// ---------------------------------------------------------------------------

describe('journalArtifactActions', () => {
  it('returns the same actions array (pass-through)', () => {
    const actions = [{ type: 'file', path: 'a.txt', content: 'x' }];
    const session = makeSession();
    const result = journalArtifactActions(actions, session, 'tool_a');
    expect(result).toBe(actions);
  });

  it('creates _artifactJournal on session if absent', () => {
    const session = makeSession();
    expect(session._artifactJournal).toBeUndefined();
    journalArtifactActions([{ type: 'file', path: 'a.txt', content: 'x' }], session, 'tool_a');
    expect(Array.isArray(session._artifactJournal)).toBe(true);
    expect(session._artifactJournal).toHaveLength(1);
  });

  it('appends to existing _artifactJournal', () => {
    const session = makeSession();
    session._artifactJournal = [{ toolName: 'prev', timestamp: 1, type: 'shell', cmd: 'echo', content: '' }];
    journalArtifactActions([{ type: 'file', path: 'b.txt', content: 'y' }], session, 'tool_b');
    expect(session._artifactJournal).toHaveLength(2);
    expect(session._artifactJournal[1].toolName).toBe('tool_b');
    expect(session._artifactJournal[1].path).toBe('b.txt');
  });

  it('records toolName and timestamp on each entry', () => {
    const session = makeSession();
    const before = Date.now();
    journalArtifactActions([{ type: 'shell', cmd: 'npm test', content: 'ok' }], session, 'my_tool');
    const after = Date.now();
    const entry = session._artifactJournal[0];
    expect(entry.toolName).toBe('my_tool');
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry.timestamp).toBeLessThanOrEqual(after);
    expect(entry.type).toBe('shell');
    expect(entry.cmd).toBe('npm test');
  });

  it('returns the actions array unchanged for empty input', () => {
    const session = makeSession();
    expect(journalArtifactActions([], session, 'tool_a')).toEqual([]);
    expect(journalArtifactActions(null, session, 'tool_a')).toBeNull();
    expect(session._artifactJournal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 18. tools/call — streaming artifact extraction integration
// ---------------------------------------------------------------------------

describe('tools/call streaming artifact extraction', () => {
  it('extracts file artifacts from tool result text and attaches _streamingArtifacts', async () => {
    const textWithAction = 'Result: <action type="file" path="out.js">module.exports = {};</action> done.';
    reinit({
      handleToolCall: async () => ({
        content: [{ type: 'text', text: textWithAction }],
      }),
    });

    const session = makeSession('full');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(result._streamingArtifacts).toEqual([
      { type: 'file', path: 'out.js', content: 'module.exports = {};' },
    ]);
  });

  it('journals extracted artifacts into session._artifactJournal', async () => {
    const textWithAction = '<action type="shell" cmd="npm test">all passed</action>';
    reinit({
      handleToolCall: async () => ({
        content: [{ type: 'text', text: textWithAction }],
      }),
    });

    const session = makeSession('full');
    await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(session._artifactJournal).toHaveLength(1);
    expect(session._artifactJournal[0].toolName).toBe('tool_a');
    expect(session._artifactJournal[0].type).toBe('shell');
    expect(session._artifactJournal[0].cmd).toBe('npm test');
  });

  it('does not attach _streamingArtifacts when no action tags present', async () => {
    reinit({
      handleToolCall: async () => ({
        content: [{ type: 'text', text: 'plain result' }],
      }),
    });

    const session = makeSession('full');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(result._streamingArtifacts).toBeUndefined();
    expect(session._artifactJournal).toBeUndefined();
  });

  it('does not extract artifacts from error results', async () => {
    reinit({
      handleToolCall: async () => ({
        content: [{ type: 'text', text: '<action type="file" path="x.js">code</action>' }],
        isError: true,
      }),
    });

    const session = makeSession('full');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(result._streamingArtifacts).toBeUndefined();
    expect(session._artifactJournal).toBeUndefined();
  });

  it('extracts artifacts from multiple text blocks in one result', async () => {
    reinit({
      handleToolCall: async () => ({
        content: [
          { type: 'text', text: '<action type="file" path="a.js">const a = 1;</action>' },
          { type: 'text', text: '<action type="shell" cmd="node a.js">1</action>' },
        ],
      }),
    });

    const session = makeSession('full');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(result._streamingArtifacts).toHaveLength(2);
    expect(result._streamingArtifacts[0].type).toBe('file');
    expect(result._streamingArtifacts[1].type).toBe('shell');
    expect(session._artifactJournal).toHaveLength(2);
  });

  it('accumulates journal entries across multiple tool calls', async () => {
    reinit({
      handleToolCall: async () => ({
        content: [{ type: 'text', text: '<action type="file" path="f.txt">data</action>' }],
      }),
    });

    const session = makeSession('full');
    await handleRequest({ method: 'tools/call', params: { name: 'tool_a' } }, session);
    await handleRequest({ method: 'tools/call', params: { name: 'tool_a' } }, session);

    expect(session._artifactJournal).toHaveLength(2);
  });

  it('skips non-text content blocks during artifact extraction', async () => {
    reinit({
      handleToolCall: async () => ({
        content: [
          { type: 'image', data: 'base64...' },
          { type: 'text', text: '<action type="file" path="x.txt">content</action>' },
        ],
      }),
    });

    const session = makeSession('full');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(result._streamingArtifacts).toHaveLength(1);
    expect(result._streamingArtifacts[0].path).toBe('x.txt');
  });

  it('does not attach _streamingArtifacts when result has no content array', async () => {
    reinit({
      handleToolCall: async () => ({ someOtherField: true }),
    });

    const session = makeSession('full');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(result._streamingArtifacts).toBeUndefined();
    expect(session._artifactJournal).toBeUndefined();
  });

  it('skips text blocks with empty string during artifact extraction', async () => {
    reinit({
      handleToolCall: async () => ({
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: '<action type="file" path="real.js">code</action>' },
        ],
      }),
    });

    const session = makeSession('full');
    const result = await handleRequest(
      { method: 'tools/call', params: { name: 'tool_a' } },
      session
    );

    expect(result._streamingArtifacts).toHaveLength(1);
    expect(result._streamingArtifacts[0].path).toBe('real.js');
  });
});
