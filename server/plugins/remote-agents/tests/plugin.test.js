'use strict';

const { validatePlugin } = require('../../plugin-contract');

vi.mock('../../../logger', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockDb() {
  return {
    prepare: vi.fn(() => ({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(() => []),
    })),
    exec: vi.fn(),
  };
}

function createMockContainer({
  db = createMockDb(),
  register = vi.fn(),
  unregister = vi.fn(),
} = {}) {
  return {
    db,
    register,
    unregister,
    container: {
      get: vi.fn((name) => {
        if (name === 'db') {
          return {
            getDbInstance: () => db,
            getProjectFromPath: vi.fn(() => null),
            getProjectConfig: vi.fn(() => null),
          };
        }
        if (name === 'testRunnerRegistry') {
          return {
            register,
            unregister,
            runVerifyCommand: vi.fn(),
            runRemoteOrLocal: vi.fn(),
          };
        }
        return null;
      }),
    },
  };
}

describe('remote-agents plugin', () => {
  let plugin;

  beforeEach(() => {
    vi.resetModules();
    const { createPlugin } = require('../index');
    plugin = createPlugin();
  });

  afterEach(() => {
    if (plugin) {
      plugin.uninstall();
    }
    vi.restoreAllMocks();
  });

  it('should satisfy the plugin contract', () => {
    const result = validatePlugin(plugin);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('remote-agents');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('should return empty mcpTools before install', () => {
    expect(plugin.mcpTools()).toEqual([]);
  });

  it('should return tools after install with mock container', () => {
    const { container } = createMockContainer();

    plugin.install(container);
    const tools = plugin.mcpTools();
    expect(tools.length).toBeGreaterThan(0);

    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('register_remote_agent');
    expect(toolNames).toContain('list_remote_agents');
    expect(toolNames).toContain('remove_remote_agent');
    expect(toolNames).toContain('check_remote_agent_health');
    expect(toolNames).toContain('get_remote_agent');
    expect(toolNames).toContain('run_remote_command');
  });

  it('should register test runner override on install', () => {
    const registerFn = vi.fn();
    const { container } = createMockContainer({ register: registerFn });

    plugin.install(container);
    expect(registerFn).toHaveBeenCalledTimes(1);
  });

  it('should unregister test runner on uninstall', () => {
    const unregisterFn = vi.fn();
    const { container } = createMockContainer({ unregister: unregisterFn });

    plugin.install(container);
    plugin.uninstall();
    expect(unregisterFn).toHaveBeenCalledTimes(1);
  });
});
