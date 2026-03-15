'use strict';

const { loadPeekContractFixture } = require('../contracts/peek');

const mockDb = {
  registerPeekHost: vi.fn(),
  unregisterPeekHost: vi.fn(),
  listPeekHosts: vi.fn(),
};

const mockPeekShared = {
  peekHttpGetUrl: vi.fn(),
};

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/peek/hosts')];
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../handlers/peek/shared', mockPeekShared);
  return require('../handlers/peek/hosts');
}

vi.mock('../database', () => mockDb);
vi.mock('../handlers/peek/shared', () => mockPeekShared);

function resetMockDefaults() {
  mockDb.registerPeekHost = vi.fn(() => undefined);
  mockDb.unregisterPeekHost = vi.fn(() => true);
  mockDb.listPeekHosts = vi.fn(() => []);
  mockPeekShared.peekHttpGetUrl = vi.fn().mockResolvedValue({
    status: 200,
    data: { status: 'ok' },
  });
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

let handlers;

beforeEach(() => {
  resetMockDefaults();
  handlers = loadHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('server/handlers/peek/hosts', () => {
  describe('handleRegisterPeekHost', () => {
    it('returns a missing-parameter error when name is omitted', async () => {
      const result = await handlers.handleRegisterPeekHost({ url: 'http://peek-a:9876' });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'MISSING_REQUIRED_PARAM',
      });
      expect(getText(result)).toContain('name is required');
      expect(mockDb.registerPeekHost).not.toHaveBeenCalled();
    });

    it('returns a missing-parameter error when name is not a string', async () => {
      const result = await handlers.handleRegisterPeekHost({
        name: 42,
        url: 'http://peek-a:9876',
      });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'MISSING_REQUIRED_PARAM',
      });
      expect(getText(result)).toContain('name is required');
      expect(mockDb.registerPeekHost).not.toHaveBeenCalled();
    });

    it('returns a missing-parameter error when url is omitted', async () => {
      const result = await handlers.handleRegisterPeekHost({ name: 'peek-a' });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'MISSING_REQUIRED_PARAM',
      });
      expect(getText(result)).toContain('url is required');
      expect(mockDb.registerPeekHost).not.toHaveBeenCalled();
    });

    it('returns a missing-parameter error when url is not a string', async () => {
      const result = await handlers.handleRegisterPeekHost({
        name: 'peek-a',
        url: 12345,
      });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'MISSING_REQUIRED_PARAM',
      });
      expect(getText(result)).toContain('url is required');
      expect(mockDb.registerPeekHost).not.toHaveBeenCalled();
    });

    it('rejects a non-string ssh value', async () => {
      const result = await handlers.handleRegisterPeekHost({
        name: 'peek-a',
        url: 'http://peek-a:9876',
        ssh: { user: 'admin' },
      });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INVALID_PARAM',
      });
      expect(getText(result)).toContain('ssh must be a string');
      expect(mockDb.registerPeekHost).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean default flag', async () => {
      const result = await handlers.handleRegisterPeekHost({
        name: 'peek-a',
        url: 'http://peek-a:9876',
        default: 'yes',
      });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INVALID_PARAM',
      });
      expect(getText(result)).toContain('default must be a boolean');
      expect(mockDb.registerPeekHost).not.toHaveBeenCalled();
    });

    it('rejects unsupported platforms', async () => {
      const result = await handlers.handleRegisterPeekHost({
        name: 'peek-a',
        url: 'http://peek-a:9876',
        platform: 'android',
      });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INVALID_PARAM',
      });
      expect(getText(result)).toContain('platform must be one of: windows, macos, linux');
      expect(mockDb.registerPeekHost).not.toHaveBeenCalled();
    });

    it('rejects non-absolute URLs', async () => {
      const result = await handlers.handleRegisterPeekHost({
        name: 'peek-a',
        url: '/relative/path',
      });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INVALID_PARAM',
      });
      expect(getText(result)).toContain('url must be a valid absolute URL');
      expect(mockDb.registerPeekHost).not.toHaveBeenCalled();
    });

    it('registers a host and renders placeholder values when optional fields are omitted', async () => {
      const result = await handlers.handleRegisterPeekHost({
        name: 'peek-a',
        url: 'http://peek-a:9876',
      });

      expect(mockDb.registerPeekHost).toHaveBeenCalledWith(
        'peek-a',
        'http://peek-a:9876',
        undefined,
        undefined,
        undefined,
      );
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBe([
        '## Peek Host Registered',
        '',
        '**Name:** peek-a',
        '**URL:** http://peek-a:9876',
        '**Default:** No',
        '**Platform:** -',
        '**SSH:** -',
      ].join('\n'));
    });

    it('registers a host and renders the provided fields', async () => {
      const result = await handlers.handleRegisterPeekHost({
        name: 'peek-mac',
        url: 'https://peek-mac.example.test:9443',
        ssh: 'engineer@peek-mac',
        default: true,
        platform: 'macos',
      });

      expect(mockDb.registerPeekHost).toHaveBeenCalledWith(
        'peek-mac',
        'https://peek-mac.example.test:9443',
        'engineer@peek-mac',
        true,
        'macos',
      );
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('## Peek Host Registered');
      expect(text).toContain('**Name:** peek-mac');
      expect(text).toContain('**URL:** https://peek-mac.example.test:9443');
      expect(text).toContain('**Default:** Yes');
      expect(text).toContain('**Platform:** macos');
      expect(text).toContain('**SSH:** engineer@peek-mac');
    });

    it('wraps registration failures from Error objects as internal errors', async () => {
      mockDb.registerPeekHost = vi.fn(() => {
        throw new Error('write failed');
      });

      const result = await handlers.handleRegisterPeekHost({
        name: 'peek-a',
        url: 'http://peek-a:9876',
      });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INTERNAL_ERROR',
      });
      expect(getText(result)).toContain('write failed');
    });

    it('wraps non-Error registration failures as internal errors', async () => {
      mockDb.registerPeekHost = vi.fn(() => {
        throw 'catastrophic failure';
      });

      const result = await handlers.handleRegisterPeekHost({
        name: 'peek-a',
        url: 'http://peek-a:9876',
      });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INTERNAL_ERROR',
      });
      expect(getText(result)).toContain('catastrophic failure');
    });
  });

  describe('handleUnregisterPeekHost', () => {
    it('returns a missing-parameter error when name is omitted', async () => {
      const result = await handlers.handleUnregisterPeekHost({});

      expect(result).toMatchObject({
        isError: true,
        error_code: 'MISSING_REQUIRED_PARAM',
      });
      expect(getText(result)).toContain('name is required');
      expect(mockDb.unregisterPeekHost).not.toHaveBeenCalled();
    });

    it('returns a missing-parameter error when name is not a string', async () => {
      const result = await handlers.handleUnregisterPeekHost({ name: false });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'MISSING_REQUIRED_PARAM',
      });
      expect(getText(result)).toContain('name is required');
      expect(mockDb.unregisterPeekHost).not.toHaveBeenCalled();
    });

    it('returns an invalid-parameter error when the host does not exist', async () => {
      mockDb.unregisterPeekHost = vi.fn(() => false);

      const result = await handlers.handleUnregisterPeekHost({ name: 'missing-peek' });

      expect(mockDb.unregisterPeekHost).toHaveBeenCalledWith('missing-peek');
      expect(result).toMatchObject({
        isError: true,
        error_code: 'INVALID_PARAM',
      });
      expect(getText(result)).toContain('Peek host not found: missing-peek');
    });

    it('removes a host and renders the removal summary', async () => {
      const result = await handlers.handleUnregisterPeekHost({ name: 'peek-a' });

      expect(mockDb.unregisterPeekHost).toHaveBeenCalledWith('peek-a');
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBe('## Peek Host Removed\n\n**Name:** peek-a');
    });

    it('wraps unregister failures as internal errors', async () => {
      mockDb.unregisterPeekHost = vi.fn(() => {
        throw 'delete failed';
      });

      const result = await handlers.handleUnregisterPeekHost({ name: 'peek-a' });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INTERNAL_ERROR',
      });
      expect(getText(result)).toContain('delete failed');
    });
  });

  describe('handleListPeekHosts', () => {
    it('returns an empty-state message when no hosts are registered', async () => {
      const result = await handlers.handleListPeekHosts({});

      expect(mockDb.listPeekHosts).toHaveBeenCalledOnce();
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBe('## Peek Hosts\n\n_No peek hosts registered._');
      expect(mockPeekShared.peekHttpGetUrl).not.toHaveBeenCalled();
    });

    it('lists hosts and defaults to healthy when the health payload omits status', async () => {
      mockDb.listPeekHosts = vi.fn(() => [
        { name: 'alpha', url: 'http://alpha:9876', is_default: 1, platform: 'windows' },
      ]);
      mockPeekShared.peekHttpGetUrl.mockReset().mockResolvedValue({
        status: 200,
        data: { version: '1.2.3' },
      });

      const result = await handlers.handleListPeekHosts({});

      expect(mockPeekShared.peekHttpGetUrl).toHaveBeenCalledWith('http://alpha:9876/health', 3000);
      expect(getText(result)).toContain('| alpha | http://alpha:9876 | Yes | windows | healthy |');
    });

    it('normalizes an ok health status to healthy', async () => {
      mockDb.listPeekHosts = vi.fn(() => [
        { name: 'alpha', url: 'http://alpha:9876', is_default: 1, platform: 'windows' },
      ]);
      mockPeekShared.peekHttpGetUrl.mockReset().mockResolvedValue({
        status: 200,
        data: { status: ' OK ' },
      });

      const result = await handlers.handleListPeekHosts({});

      expect(getText(result)).toContain('| alpha | http://alpha:9876 | Yes | windows | healthy |');
    });

    it('normalizes custom health states through the contract helper', async () => {
      mockDb.listPeekHosts = vi.fn(() => [
        { name: 'beta', url: 'http://beta:9876', is_default: 0, platform: 'linux' },
      ]);
      mockPeekShared.peekHttpGetUrl.mockReset().mockResolvedValue({
        status: 200,
        data: { status: ' DEGRADED ' },
      });

      const result = await handlers.handleListPeekHosts({});

      expect(getText(result)).toContain('| beta | http://beta:9876 | No | linux | degraded |');
    });

    it('renders HTTP failures and transport errors per host', async () => {
      mockDb.listPeekHosts = vi.fn(() => [
        { name: 'alpha', url: 'http://alpha:9876', is_default: 1, platform: 'windows' },
        { name: 'beta', url: 'http://beta:9876', is_default: 0, platform: null },
        { name: 'gamma', url: 'http://gamma:9876', is_default: 0, platform: 'linux' },
      ]);
      mockPeekShared.peekHttpGetUrl.mockReset()
        .mockResolvedValueOnce({ status: 200, data: { status: 'ok' } })
        .mockResolvedValueOnce({ status: 503, data: { status: 'down' } })
        .mockResolvedValueOnce({ error: 'connect ECONNREFUSED' });

      const result = await handlers.handleListPeekHosts({});

      expect(mockPeekShared.peekHttpGetUrl).toHaveBeenNthCalledWith(1, 'http://alpha:9876/health', 3000);
      expect(mockPeekShared.peekHttpGetUrl).toHaveBeenNthCalledWith(2, 'http://beta:9876/health', 3000);
      expect(mockPeekShared.peekHttpGetUrl).toHaveBeenNthCalledWith(3, 'http://gamma:9876/health', 3000);

      const text = getText(result);
      expect(text).toContain('| Name | URL | Default | Platform | Status |');
      expect(text).toContain('| alpha | http://alpha:9876 | Yes | windows | healthy |');
      expect(text).toContain('| beta | http://beta:9876 | No | - | HTTP 503 |');
      expect(text).toContain('| gamma | http://gamma:9876 | No | linux | connect ECONNREFUSED |');
    });

    it('accepts capability-rich health payloads without breaking status rendering', async () => {
      const capabilityFixture = loadPeekContractFixture('peek-capabilities-v1.json');
      mockDb.listPeekHosts = vi.fn(() => [
        { name: 'omen', url: 'http://omen:9876', is_default: 1, platform: 'windows' },
      ]);
      mockPeekShared.peekHttpGetUrl.mockReset().mockResolvedValue({
        status: 200,
        data: {
          status: 'ok',
          hostname: 'omen-host',
          platform: 'windows',
          version: capabilityFixture.versioning.runtime_version,
          contracts: {
            capabilities: capabilityFixture.contract,
            investigation_bundle: {
              name: 'peek_investigation_bundle',
              version: 1,
            },
          },
          capabilities: capabilityFixture,
        },
      });

      const result = await handlers.handleListPeekHosts({});

      expect(getText(result)).toContain('| omen | http://omen:9876 | Yes | windows | healthy |');
    });

    it('wraps listing failures as internal errors', async () => {
      mockDb.listPeekHosts = vi.fn(() => {
        throw new Error('peek list failed');
      });

      const result = await handlers.handleListPeekHosts({});

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INTERNAL_ERROR',
      });
      expect(getText(result)).toContain('peek list failed');
    });

    it('wraps rejected health probes as internal errors', async () => {
      mockDb.listPeekHosts = vi.fn(() => [
        { name: 'alpha', url: 'http://alpha:9876', is_default: 1, platform: 'windows' },
      ]);
      mockPeekShared.peekHttpGetUrl.mockReset().mockRejectedValue(new Error('health request exploded'));

      const result = await handlers.handleListPeekHosts({});

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INTERNAL_ERROR',
      });
      expect(getText(result)).toContain('health request exploded');
    });
  });

  describe('handlePeekHealthAll', () => {
    it('returns a plain message when no hosts are registered', async () => {
      const result = await handlers.handlePeekHealthAll({});

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBe('No peek hosts registered.');
      expect(mockPeekShared.peekHttpGetUrl).not.toHaveBeenCalled();
    });

    it('returns a plain message when the db module does not expose listPeekHosts', async () => {
      mockDb.listPeekHosts = undefined;

      const result = await handlers.handlePeekHealthAll({});

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBe('No peek hosts registered.');
      expect(mockPeekShared.peekHttpGetUrl).not.toHaveBeenCalled();
    });

    it('trims trailing slashes and reports healthy hosts with latency and version', async () => {
      mockDb.listPeekHosts = vi.fn(() => [
        { name: 'alpha', url: 'http://alpha:9876///', enabled: 1 },
      ]);
      mockPeekShared.peekHttpGetUrl.mockReset().mockResolvedValue({
        status: 200,
        data: { status: 'ok', version: '1.2.3', hostname: 'alpha-host' },
      });

      const result = await handlers.handlePeekHealthAll({});

      expect(mockPeekShared.peekHttpGetUrl).toHaveBeenCalledWith('http://alpha:9876/health', 5000);
      const text = getText(result);
      expect(text).toContain('## Peek Host Health');
      expect(text).toMatch(/\| alpha \| http:\/\/alpha:9876\/\/\/ \| ✅ Healthy \| \d+ms \| 1\.2\.3 \|/);
      expect(text).toContain('**1/1** enabled hosts reachable');
    });

    it('marks errored hosts as down with placeholder latency and version', async () => {
      mockDb.listPeekHosts = vi.fn(() => [
        { name: 'beta', url: 'http://beta:9876', enabled: 1 },
      ]);
      mockPeekShared.peekHttpGetUrl.mockReset().mockResolvedValue({
        error: 'connect ECONNREFUSED',
      });

      const result = await handlers.handlePeekHealthAll({});

      const text = getText(result);
      expect(text).toContain('| beta | http://beta:9876 | ❌ Down | - | - |');
      expect(text).toContain('**0/1** enabled hosts reachable');
    });

    it('marks disabled hosts as paused and excludes them from the enabled denominator', async () => {
      mockDb.listPeekHosts = vi.fn(() => [
        { name: 'alpha', url: 'http://alpha:9876', enabled: 1 },
        { name: 'gamma', url: 'http://gamma:9876', enabled: 0 },
      ]);
      mockPeekShared.peekHttpGetUrl.mockReset()
        .mockResolvedValueOnce({ status: 200, data: { version: '1.0.0' } })
        .mockResolvedValueOnce({ status: 200, data: { version: '0.9.0' } });

      const result = await handlers.handlePeekHealthAll({});

      const text = getText(result);
      expect(text).toMatch(/\| alpha \| http:\/\/alpha:9876 \| ✅ Healthy \| \d+ms \| 1\.0\.0 \|/);
      expect(text).toMatch(/\| gamma \| http:\/\/gamma:9876 \| ⏸ Disabled \| \d+ms \| 0\.9\.0 \|/);
      expect(text).toContain('**1/1** enabled hosts reachable');
    });

    it('reports zero enabled hosts reachable when every registered host is disabled', async () => {
      mockDb.listPeekHosts = vi.fn(() => [
        { name: 'gamma', url: 'http://gamma:9876', enabled: 0 },
      ]);
      mockPeekShared.peekHttpGetUrl.mockReset().mockResolvedValue({
        status: 200,
        data: { version: '0.9.0' },
      });

      const result = await handlers.handlePeekHealthAll({});

      const text = getText(result);
      expect(text).toMatch(/\| gamma \| http:\/\/gamma:9876 \| ⏸ Disabled \| \d+ms \| 0\.9\.0 \|/);
      expect(text).toContain('**0/0** enabled hosts reachable');
    });

    it('counts multiple enabled reachable hosts in the summary', async () => {
      mockDb.listPeekHosts = vi.fn(() => [
        { name: 'alpha', url: 'http://alpha:9876', enabled: 1 },
        { name: 'beta', url: 'http://beta:9876', enabled: 1 },
      ]);
      mockPeekShared.peekHttpGetUrl.mockReset()
        .mockResolvedValueOnce({ status: 200, data: { version: '1.0.0' } })
        .mockResolvedValueOnce({ status: 200, data: { version: '2.0.0' } });

      const result = await handlers.handlePeekHealthAll({});

      const text = getText(result);
      expect(text).toContain('**2/2** enabled hosts reachable');
      expect(text).toContain('| alpha | http://alpha:9876 |');
      expect(text).toContain('| beta | http://beta:9876 |');
    });

    it('wraps health collection failures as internal errors', async () => {
      mockDb.listPeekHosts = vi.fn(() => {
        throw new Error('health list failed');
      });

      const result = await handlers.handlePeekHealthAll({});

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INTERNAL_ERROR',
      });
      expect(getText(result)).toContain('health list failed');
    });

    it('wraps rejected health requests as internal errors', async () => {
      mockDb.listPeekHosts = vi.fn(() => [
        { name: 'alpha', url: 'http://alpha:9876', enabled: 1 },
      ]);
      mockPeekShared.peekHttpGetUrl.mockReset().mockRejectedValue(new Error('health matrix exploded'));

      const result = await handlers.handlePeekHealthAll({});

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INTERNAL_ERROR',
      });
      expect(getText(result)).toContain('health matrix exploded');
    });
  });
});
