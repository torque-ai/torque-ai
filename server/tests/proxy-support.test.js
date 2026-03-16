import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  detectProxyEnv,
  isProxyConfigured,
  installProxyAgent,
  createProxyAgent,
  shouldBypassProxy,
  redactProxyUrl,
} = require('../utils/proxy-agent');

describe('proxy-agent', () => {
  // Save and restore all proxy env vars between tests
  const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
  const savedEnv = {};

  beforeEach(() => {
    for (const key of PROXY_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PROXY_VARS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    vi.restoreAllMocks();
  });

  describe('detectProxyEnv', () => {
    it('returns nulls when no proxy env vars are set', () => {
      const result = detectProxyEnv();
      expect(result.httpsProxy).toBeNull();
      expect(result.httpProxy).toBeNull();
      expect(result.noProxy).toBeNull();
    });

    it('detects HTTPS_PROXY (uppercase)', () => {
      process.env.HTTPS_PROXY = 'http://proxy.corp:8080';
      const result = detectProxyEnv();
      expect(result.httpsProxy).toBe('http://proxy.corp:8080');
    });

    it('detects https_proxy (lowercase)', () => {
      process.env.https_proxy = 'http://proxy.corp:8080';
      const result = detectProxyEnv();
      expect(result.httpsProxy).toBe('http://proxy.corp:8080');
    });

    it('detects proxy from either case variant', () => {
      // On Windows, env vars are case-insensitive so both point to the same value.
      // On Unix, HTTPS_PROXY takes precedence via the || chain in detectProxyEnv.
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      const result = detectProxyEnv();
      expect(result.httpsProxy).toBe('http://proxy:8080');
    });

    it('detects HTTP_PROXY', () => {
      process.env.HTTP_PROXY = 'http://proxy.corp:3128';
      const result = detectProxyEnv();
      expect(result.httpProxy).toBe('http://proxy.corp:3128');
    });

    it('detects NO_PROXY', () => {
      process.env.NO_PROXY = 'localhost,127.0.0.1,.internal.corp';
      const result = detectProxyEnv();
      expect(result.noProxy).toBe('localhost,127.0.0.1,.internal.corp');
    });
  });

  describe('isProxyConfigured', () => {
    it('returns false when no proxy env vars are set', () => {
      expect(isProxyConfigured()).toBe(false);
    });

    it('returns true when HTTPS_PROXY is set', () => {
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      expect(isProxyConfigured()).toBe(true);
    });

    it('returns true when HTTP_PROXY is set', () => {
      process.env.HTTP_PROXY = 'http://proxy:8080';
      expect(isProxyConfigured()).toBe(true);
    });

    it('returns false when only NO_PROXY is set', () => {
      process.env.NO_PROXY = 'localhost';
      expect(isProxyConfigured()).toBe(false);
    });
  });

  describe('installProxyAgent', () => {
    it('returns installed:false when no proxy env vars are set', () => {
      const result = installProxyAgent();
      expect(result.installed).toBe(false);
      expect(result.httpsProxy).toBeNull();
      expect(result.httpProxy).toBeNull();
    });

    it('installs proxy agent when HTTPS_PROXY is set', () => {
      process.env.HTTPS_PROXY = 'http://proxy.corp:8080';
      const result = installProxyAgent();
      expect(result.installed).toBe(true);
      expect(result.httpsProxy).toBe('http://proxy.corp:8080');
    });

    it('installs proxy agent when HTTP_PROXY is set', () => {
      process.env.HTTP_PROXY = 'http://proxy.corp:3128';
      const result = installProxyAgent();
      expect(result.installed).toBe(true);
      expect(result.httpProxy).toBe('http://proxy.corp:3128');
    });

    it('includes NO_PROXY in the result when set', () => {
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      process.env.NO_PROXY = 'localhost,192.168.1.0/24';
      const result = installProxyAgent();
      expect(result.installed).toBe(true);
      expect(result.noProxy).toBe('localhost,192.168.1.0/24');
    });
  });

  describe('createProxyAgent', () => {
    it('returns null when proxyUrl is falsy', () => {
      expect(createProxyAgent(null)).toBeNull();
      expect(createProxyAgent('')).toBeNull();
      expect(createProxyAgent(undefined)).toBeNull();
    });

    it('creates a ProxyAgent when proxyUrl is provided', () => {
      const agent = createProxyAgent('http://proxy.corp:8080');
      expect(agent).not.toBeNull();
      expect(agent.constructor.name).toBe('ProxyAgent');
      agent.close();
    });
  });

  describe('shouldBypassProxy (NO_PROXY)', () => {
    it('returns false when NO_PROXY is empty', () => {
      expect(shouldBypassProxy('api.openai.com', '')).toBe(false);
    });

    it('returns false when hostname is empty', () => {
      expect(shouldBypassProxy('', 'localhost')).toBe(false);
    });

    it('matches exact hostname', () => {
      expect(shouldBypassProxy('localhost', 'localhost')).toBe(true);
      expect(shouldBypassProxy('127.0.0.1', '127.0.0.1')).toBe(true);
    });

    it('matches domain suffix with leading dot', () => {
      expect(shouldBypassProxy('api.internal.corp', '.internal.corp')).toBe(true);
      expect(shouldBypassProxy('deep.api.internal.corp', '.internal.corp')).toBe(true);
    });

    it('matches domain suffix without leading dot', () => {
      expect(shouldBypassProxy('api.internal.corp', 'internal.corp')).toBe(true);
    });

    it('does not match partial hostname', () => {
      expect(shouldBypassProxy('notlocalhost', 'localhost')).toBe(false);
    });

    it('handles wildcard (*) to bypass all', () => {
      expect(shouldBypassProxy('api.openai.com', '*')).toBe(true);
      expect(shouldBypassProxy('anything.anywhere.com', '*')).toBe(true);
    });

    it('handles comma-separated list', () => {
      const noProxy = 'localhost, 127.0.0.1, .internal.corp';
      expect(shouldBypassProxy('localhost', noProxy)).toBe(true);
      expect(shouldBypassProxy('127.0.0.1', noProxy)).toBe(true);
      expect(shouldBypassProxy('api.internal.corp', noProxy)).toBe(true);
      expect(shouldBypassProxy('api.openai.com', noProxy)).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(shouldBypassProxy('API.Internal.Corp', '.internal.corp')).toBe(true);
      expect(shouldBypassProxy('localhost', 'LOCALHOST')).toBe(true);
    });

    it('reads from NO_PROXY env var when noProxyValue is not provided', () => {
      process.env.NO_PROXY = 'localhost,127.0.0.1';
      expect(shouldBypassProxy('localhost')).toBe(true);
      expect(shouldBypassProxy('api.openai.com')).toBe(false);
    });

    it('reads from no_proxy (lowercase) env var', () => {
      process.env.no_proxy = 'localhost';
      expect(shouldBypassProxy('localhost')).toBe(true);
    });
  });

  describe('redactProxyUrl', () => {
    it('redacts username and password from proxy URL', () => {
      const redacted = redactProxyUrl('http://user:secret@proxy.corp:8080');
      expect(redacted).not.toContain('user');
      expect(redacted).not.toContain('secret');
      expect(redacted).toContain('proxy.corp');
      expect(redacted).toContain('8080');
    });

    it('returns URL unchanged when no credentials', () => {
      const url = 'http://proxy.corp:8080/';
      const redacted = redactProxyUrl(url);
      expect(redacted).toBe(url);
    });

    it('handles invalid URL gracefully', () => {
      expect(redactProxyUrl('not-a-url')).toBe('[invalid-url]');
    });
  });
});
