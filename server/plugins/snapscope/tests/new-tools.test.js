const { describe, it, expect, vi, beforeEach } = require('vitest');
const { createVerifyHandlers } = require('../handlers/verify');
const { createWatchHandlers } = require('../handlers/watch');
const newToolDefs = require('../new-tool-defs');
const { createSnapScopePlugin } = require('../index');

const NEW_TOOL_NAMES = [
  'peek_verify',
  'peek_verify_run',
  'peek_verify_specs',
  'peek_baselines',
  'peek_history',
  'peek_watch_add',
  'peek_watch_remove',
  'peek_watch_status',
  'peek_watch_control',
  'peek_recovery_execute',
  'peek_recovery_log',
];

describe('snapscope verify handlers', () => {
  let peekClient;

  beforeEach(() => {
    peekClient = {
      request: vi.fn().mockResolvedValue({ status: 200, data: { success: true } }),
    };
  });

  it.each([
    [
      'handlePeekVerify',
      { window: { title: 'Main' }, checks: ['pixels'], capture: false, name: 'smoke', branch: 'release' },
      '/verify',
      {
        window: { title: 'Main' },
        checks: ['pixels'],
        capture: false,
        name: 'smoke',
        branch: 'release',
      },
    ],
    [
      'handlePeekVerifyRun',
      { spec_name: 'dashboard', window: { process: 'app' }, branch: 'develop' },
      '/verify/run',
      {
        spec_name: 'dashboard',
        window: { process: 'app' },
        branch: 'develop',
      },
    ],
    [
      'handlePeekVerifySpecs',
      { action: 'list' },
      '/verify/specs',
      { action: 'list' },
    ],
    [
      'handlePeekBaselines',
      { action: 'list', branch: 'main' },
      '/baselines',
      { action: 'list', branch: 'main' },
    ],
    [
      'handlePeekHistory',
      { action: 'runs', spec_name: 'dashboard', limit: 5 },
      '/history',
      { action: 'runs', spec_name: 'dashboard', limit: 5 },
    ],
  ])('%s posts to %s', async (handlerName, args, expectedPath, expectedBody) => {
    const handlers = createVerifyHandlers(peekClient);

    const result = await handlers[handlerName](args);

    expect(peekClient.request).toHaveBeenCalledWith('POST', expectedPath, expectedBody);
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }],
    });
  });

  it('applies default verify payload values', async () => {
    const handlers = createVerifyHandlers(peekClient);

    await handlers.handlePeekVerify({ window: { title: 'Main' }, checks: ['pixels'] });

    expect(peekClient.request).toHaveBeenCalledWith('POST', '/verify', {
      window: { title: 'Main' },
      checks: ['pixels'],
      capture: true,
      name: '',
      branch: 'main',
    });
  });
});

describe('snapscope watch handlers', () => {
  let peekClient;

  beforeEach(() => {
    peekClient = {
      request: vi.fn().mockResolvedValue({ status: 200, data: { success: true } }),
    };
  });

  it.each([
    [
      'handlePeekWatchAdd',
      { name: 'nightly', app: { process: 'demo' }, specs: ['smoke'] },
      '/watch/add',
      { name: 'nightly', app: { process: 'demo' }, specs: ['smoke'] },
    ],
    [
      'handlePeekWatchRemove',
      { name: 'nightly' },
      '/watch/remove',
      { name: 'nightly' },
    ],
    [
      'handlePeekWatchStatus',
      undefined,
      '/watch/status',
      {},
    ],
    [
      'handlePeekWatchControl',
      { action: 'start' },
      '/watch/control',
      { action: 'start' },
    ],
    [
      'handlePeekRecoveryExecute',
      { action: 'restart_app', params: { delay: 1 }, simulate: true },
      '/recovery/execute',
      { action: 'restart_app', params: { delay: 1 }, simulate: true },
    ],
    [
      'handlePeekRecoveryLog',
      undefined,
      '/recovery/log',
      {},
    ],
  ])('%s posts to %s', async (handlerName, args, expectedPath, expectedBody) => {
    const handlers = createWatchHandlers(peekClient);

    const result = await handlers[handlerName](args);

    expect(peekClient.request).toHaveBeenCalledWith('POST', expectedPath, expectedBody);
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }],
    });
  });
});

describe('snapscope new tool definitions', () => {
  it('exports valid definitions for all M1-M6 tools', () => {
    expect(newToolDefs).toHaveLength(11);

    for (const def of newToolDefs) {
      expect(NEW_TOOL_NAMES).toContain(def.name);
      expect(typeof def.description).toBe('string');
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema).toMatchObject({ type: 'object' });
      expect(def.inputSchema.properties).toBeTypeOf('object');
    }
  });

  it('marks required fields on core tool inputs', () => {
    const defsByName = new Map(newToolDefs.map((def) => [def.name, def]));

    expect(defsByName.get('peek_verify').inputSchema.required).toEqual(['window', 'checks']);
    expect(defsByName.get('peek_verify_run').inputSchema.required).toEqual(['spec_name']);
    expect(defsByName.get('peek_watch_add').inputSchema.required).toEqual(['name', 'app', 'specs']);
    expect(defsByName.get('peek_watch_control').inputSchema.required).toEqual(['action']);
    expect(defsByName.get('peek_recovery_execute').inputSchema.required).toEqual(['action']);
  });
});

describe('snapscope plugin registration', () => {
  it('registers the new M1-M6 tools after install', () => {
    const plugin = createSnapScopePlugin();
    const container = {
      get(key) {
        if (key === 'db') return { getDbInstance: () => ({}) };
        if (key === 'serverConfig') return { get: () => '' };
        if (key === 'eventBus') return { on: () => {} };
        return null;
      },
    };

    plugin.install(container);
    const toolNames = new Set(plugin.mcpTools().map((tool) => tool.name));

    for (const toolName of NEW_TOOL_NAMES) {
      expect(toolNames.has(toolName)).toBe(true);
    }
  });
});
