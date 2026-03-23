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

function getLookupCommand() {
  return process.platform === 'win32' ? 'where' : 'which';
}

describe('utils/agent-discovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockProviderRoutingCore.getProvider.mockReset();
    mockProviderRoutingCore.getProvider.mockImplementation((provider) => ({ provider, enabled: true }));
    restoreProviderRoutingCoreModule();
    unloadAgentDiscovery();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreProviderRoutingCoreModule();
    unloadAgentDiscovery();
  });

  it('discovers agents that exist on PATH', () => {
    const lookupCommand = getLookupCommand();
    const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((command, args) => {
      if (command === lookupCommand && args[0] === 'claude') {
        return 'C:\\Tools\\claude.cmd\n';
      }
      if (command === 'claude' && args[0] === '--version') {
        return 'claude 1.9.0';
      }
      throw new Error('not found');
    });

    const { discoverAgents } = loadAgentDiscovery();
    const result = discoverAgents();

    expect(result.installed).toContainEqual({
      name: 'Claude Code',
      binary: 'claude',
      version: '1.9.0',
      path: 'C:\\Tools\\claude.cmd',
      provider: 'claude-cli',
    });
    expect(result.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ binary: 'codex' }),
    ]));
    expect(execFileSyncSpy).toHaveBeenCalledWith(lookupCommand, ['claude'], expect.objectContaining({
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  });

  it('reports missing agents', () => {
    const lookupCommand = getLookupCommand();
    vi.spyOn(childProcess, 'execFileSync').mockImplementation((command, args) => {
      if (command === lookupCommand && args[0] === 'codex') {
        throw new Error('missing');
      }
      throw new Error('not found');
    });

    const { discoverAgents } = loadAgentDiscovery();
    const result = discoverAgents();

    expect(result.installed).toEqual([]);
    expect(result.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Codex CLI',
        binary: 'codex',
        provider: 'codex',
        installHint: 'npm install -g @openai/codex',
      }),
    ]));
  });

  it('extracts version from --version output', () => {
    const lookupCommand = getLookupCommand();
    vi.spyOn(childProcess, 'execFileSync').mockImplementation((command, args) => {
      if (command === lookupCommand && args[0] === 'codex') {
        return '/usr/local/bin/codex\n';
      }
      if (command === 'codex' && args[0] === '--version') {
        return '1.2.3';
      }
      throw new Error('not found');
    });

    const { discoverAgents } = loadAgentDiscovery();
    const result = discoverAgents();
    const codex = result.installed.find((agent) => agent.binary === 'codex');

    expect(codex).toMatchObject({
      binary: 'codex',
      version: '1.2.3',
      path: '/usr/local/bin/codex',
    });
  });

  it('handles --version failure gracefully', () => {
    const lookupCommand = getLookupCommand();
    vi.spyOn(childProcess, 'execFileSync').mockImplementation((command, args) => {
      if (command === lookupCommand && args[0] === 'codex') {
        return '/usr/local/bin/codex\n';
      }
      if (command === 'codex' && args[0] === '--version') {
        throw new Error('version failed');
      }
      throw new Error('not found');
    });

    const { discoverAgents } = loadAgentDiscovery();
    const result = discoverAgents();
    const codex = result.installed.find((agent) => agent.binary === 'codex');

    expect(codex).toMatchObject({
      binary: 'codex',
      version: null,
      path: '/usr/local/bin/codex',
    });
  });

  it('generates suggestions for installed but unconfigured providers', () => {
    const lookupCommand = getLookupCommand();
    mockProviderRoutingCore.getProvider.mockImplementation((provider) => (
      provider === 'codex' ? { provider, enabled: false } : { provider, enabled: true }
    ));
    vi.spyOn(childProcess, 'execFileSync').mockImplementation((command, args) => {
      if (command === lookupCommand && args[0] === 'codex') {
        return '/usr/local/bin/codex\n';
      }
      if (command === 'codex' && args[0] === '--version') {
        return 'codex 1.2.3';
      }
      throw new Error('not found');
    });

    const { discoverAgents } = loadAgentDiscovery();
    const result = discoverAgents();

    expect(result.suggestions).toContain(
      'codex is installed (v1.2.3) but not configured — run configure_provider({ provider: "codex", enabled: true })'
    );
  });

  it('formatDiscoveryReport produces valid markdown', () => {
    const { formatDiscoveryReport } = loadAgentDiscovery();
    const report = formatDiscoveryReport({
      installed: [
        {
          name: 'Codex CLI',
          binary: 'codex',
          version: '1.2.3',
          path: '/usr/local/bin/codex',
          provider: 'codex',
        },
      ],
      missing: [
        {
          name: 'Claude Code',
          binary: 'claude',
          installHint: 'npm install -g @anthropic-ai/claude-code',
          provider: 'claude-cli',
        },
      ],
      suggestions: [
        'codex is installed (v1.2.3) but not configured — run configure_provider({ provider: "codex", enabled: true })',
      ],
    });

    expect(report).toContain('## Agent Discovery Report');
    expect(report).toContain('### Installed');
    expect(report).toContain('| Agent | Version | Path | Provider | Status |');
    expect(report).toContain('| Codex CLI | 1.2.3 | /usr/local/bin/codex | codex | Not configured |');
    expect(report).toContain('### Not Installed');
    expect(report).toContain('| Claude Code | npm install -g @anthropic-ai/claude-code |');
    expect(report).toContain('### Suggestions');
    expect(report).toContain('- codex is installed (v1.2.3) but not configured — run configure_provider({ provider: "codex", enabled: true })');
  });
});
