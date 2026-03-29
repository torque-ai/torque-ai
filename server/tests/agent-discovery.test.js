'use strict';

const childProcess = require('child_process');

function installMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

const MODULE_PATH = require.resolve('../utils/agent-discovery');
const PROVIDER_ROUTING_CORE_MODULE_PATH = require.resolve('../db/provider-routing-core');
const originalProviderRoutingCoreCache = require.cache[PROVIDER_ROUTING_CORE_MODULE_PATH];
const mockProviderRoutingCore = {
  getProvider: vi.fn(),
};

function restoreProviderRoutingCoreModule() {
  if (originalProviderRoutingCoreCache) {
    require.cache[PROVIDER_ROUTING_CORE_MODULE_PATH] = originalProviderRoutingCoreCache;
  } else {
    delete require.cache[PROVIDER_ROUTING_CORE_MODULE_PATH];
  }
}

function unloadAgentDiscovery() {
  delete require.cache[MODULE_PATH];
}

function loadAgentDiscovery() {
  unloadAgentDiscovery();
  installMock('../db/provider-routing-core', mockProviderRoutingCore);
  return require('../utils/agent-discovery');
}

describe('utils/agent-discovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockProviderRoutingCore.getProvider.mockReset();
    mockProviderRoutingCore.getProvider.mockImplementation((provider) => ({
      provider,
      enabled: provider !== 'codex',
    }));
    restoreProviderRoutingCoreModule();
    unloadAgentDiscovery();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreProviderRoutingCoreModule();
    unloadAgentDiscovery();
  });

  it('returns installed, missing, and suggestions structure', () => {
    const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((command, args) => {
      if ((command === 'which' || command === 'where') && args[0] === 'codex') {
        return '/usr/local/bin/codex\n';
      }
      if (command === 'codex' && args[0] === '--version') {
        return 'codex 1.2.3';
      }
      if ((command === 'which' || command === 'where') && args[0] === 'ollama') {
        return '/usr/local/bin/ollama\n';
      }
      if (command === 'ollama' && args[0] === '--version') {
        return 'ollama version 0.5.1';
      }
      if (command === process.execPath && args[0] === '-e') {
        return JSON.stringify({ running: true, models: 3 });
      }
      throw new Error('not found');
    });

    const { discoverAgents } = loadAgentDiscovery();
    const result = discoverAgents();

    expect(result).toEqual(expect.objectContaining({
      installed: expect.any(Array),
      missing: expect.any(Array),
      suggestions: expect.any(Array),
    }));
    expect(result.installed).toEqual(expect.arrayContaining([
      {
        name: 'codex',
        version: '1.2.3',
        path: '/usr/local/bin/codex',
        status: 'ready',
      },
      {
        name: 'ollama',
        version: '0.5.1',
        path: '/usr/local/bin/ollama',
        status: 'running',
        models: 3,
      },
    ]));
    expect(result.missing).toEqual(expect.arrayContaining([
      'claude',
      'gemini',
      'aider',
    ]));
    expect(result.suggestions).toContain(
      'codex is installed — enable with: configure_provider({ provider: "codex", enabled: true })'
    );
    expect(execFileSyncSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^(which|where)$/),
      ['codex'],
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
  });

  it('handles missing commands gracefully', () => {
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('missing');
    });

    const { discoverAgents } = loadAgentDiscovery();
    let result;

    expect(() => {
      result = discoverAgents();
    }).not.toThrow();
    expect(result.installed).toEqual([]);
    expect(result.missing).toEqual(['claude', 'codex', 'gemini', 'ollama', 'aider']);
    expect(result.suggestions).toEqual([]);
  });

  it('selects which vs where based on platform', () => {
    const { getLookupCommand } = loadAgentDiscovery();

    expect(getLookupCommand('linux')).toBe('which');
    expect(getLookupCommand('darwin')).toBe('which');
    expect(getLookupCommand('win32')).toBe('where');
  });
});
