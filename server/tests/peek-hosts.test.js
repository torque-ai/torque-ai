'use strict';

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
  mockDb.registerPeekHost.mockReset().mockImplementation(() => undefined);
  mockDb.unregisterPeekHost.mockReset().mockReturnValue(true);
  mockDb.listPeekHosts.mockReset().mockReturnValue([]);
  mockPeekShared.peekHttpGetUrl.mockReset().mockResolvedValue({
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

    it('returns a missing-parameter error when url is omitted', async () => {
      const result = await handlers.handleRegisterPeekHost({ name: 'peek-a' });

      expect(result).toMatchObject({
        isError: true,
        error_code: 'MISSING_REQUIRED_PARAM',
      });
      expect(getText(result)).toContain('url is required');
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

    it('registers a host and renders the summary table fields', async () => {
      const result = await handlers.handleRegisterPeekHost({
        name: 'peek-a',
        url: 'http://peek-a:9876',
        ssh: 'admin@peek-a',
        default: true,
        platform: 'linux',
      });

      expect(mockDb.registerPeekHost).toHaveBeenCalledWith(
        'peek-a',
        'http://peek-a:9876',
        'admin@peek-a',
        true,
        'linux',
      );
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('## Peek Host Registered');
      expect(text).toContain('**Name:** peek-a');
      expect(text).toContain('**URL:** http://peek-a:9876');
      expect(text).toContain('**Default:** Yes');
      expect(text).toContain('**Platform:** linux');
      expect(text).toContain('**SSH:** admin@peek-a');
    });

    it('wraps registration failures as internal errors', async () => {
      mockDb.registerPeekHost.mockImplementation(() => {
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

    it('returns an invalid-parameter error when the host does not exist', async () => {
      mockDb.unregisterPeekHost.mockReturnValue(false);

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
  });

  describe('handleListPeekHosts', () => {
    it('returns an empty-state message when no hosts are registered', async () => {
      const result = await handlers.handleListPeekHosts({});

      expect(mockDb.listPeekHosts).toHaveBeenCalledOnce();
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBe('## Peek Hosts\n\n_No peek hosts registered._');
      expect(mockPeekShared.peekHttpGetUrl).not.toHaveBeenCalled();
    });

    it('lists hosts with normalized health, HTTP failures, and transport errors', async () => {
      mockDb.listPeekHosts.mockReturnValue([
        { name: 'alpha', url: 'http://alpha:9876', is_default: 1, platform: 'windows' },
        { name: 'beta', url: 'http://beta:9876', is_default: 0, platform: null },
        { name: 'gamma', url: 'http://gamma:9876', is_default: 0, platform: 'linux' },
      ]);
      mockPeekShared.peekHttpGetUrl
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

    it('wraps listing failures as internal errors', async () => {
      mockDb.listPeekHosts.mockImplementation(() => {
        throw new Error('peek list failed');
      });

      const result = await handlers.handleListPeekHosts({});

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INTERNAL_ERROR',
      });
      expect(getText(result)).toContain('peek list failed');
    });
  });

  describe('handlePeekHealthAll', () => {
    it('returns a plain message when no hosts are registered', async () => {
      const result = await handlers.handlePeekHealthAll({});

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBe('No peek hosts registered.');
      expect(mockPeekShared.peekHttpGetUrl).not.toHaveBeenCalled();
    });

    it('reports healthy, down, and disabled hosts in the health matrix', async () => {
      mockDb.listPeekHosts.mockReturnValue([
        { name: 'alpha', url: 'http://alpha:9876/', enabled: 1 },
        { name: 'beta', url: 'http://beta:9876', enabled: 1 },
        { name: 'gamma', url: 'http://gamma:9876', enabled: 0 },
      ]);
      mockPeekShared.peekHttpGetUrl
        .mockResolvedValueOnce({ status: 200, data: { status: 'ok', version: '1.2.3', hostname: 'alpha' } })
        .mockResolvedValueOnce({ error: 'connect ECONNREFUSED' })
        .mockResolvedValueOnce({ status: 200, data: { status: 'ok', version: '0.9.0', hostname: 'gamma' } });

      const result = await handlers.handlePeekHealthAll({});

      expect(mockPeekShared.peekHttpGetUrl).toHaveBeenNthCalledWith(1, 'http://alpha:9876/health', 5000);
      expect(mockPeekShared.peekHttpGetUrl).toHaveBeenNthCalledWith(2, 'http://beta:9876/health', 5000);
      expect(mockPeekShared.peekHttpGetUrl).toHaveBeenNthCalledWith(3, 'http://gamma:9876/health', 5000);

      const text = getText(result);
      expect(text).toContain('## Peek Host Health');
      expect(text).toMatch(/\| alpha \| http:\/\/alpha:9876\/ \| \u2705 Healthy \| \d+ms \| 1\.2\.3 \|/);
      expect(text).toContain('| beta | http://beta:9876 | \u274c Down | - | - |');
      expect(text).toMatch(/\| gamma \| http:\/\/gamma:9876 \| \u23f8 Disabled \| \d+ms \| 0\.9\.0 \|/);
      expect(text).toContain('**1/2** enabled hosts reachable');
    });

    it('wraps health collection failures as internal errors', async () => {
      mockDb.listPeekHosts.mockImplementation(() => {
        throw new Error('health list failed');
      });

      const result = await handlers.handlePeekHealthAll({});

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INTERNAL_ERROR',
      });
      expect(getText(result)).toContain('health list failed');
    });
  });
});
