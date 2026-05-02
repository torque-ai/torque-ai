'use strict';

const path = require('path');

// Pure-function unit tests for server/utils/proxy-agent.js. The module had
// no direct tests despite gating cloud-API egress for every provider that
// goes through Node's global fetch (deepinfra, hyperbolic, groq, cerebras,
// google-ai, openrouter, anthropic). Misclassifying a NO_PROXY rule or
// failing to redact credentials in a log line would both be production
// incidents — pin the contract.
//
// installProxyAgent and createProxyAgent are integration paths into undici;
// not exercised here to avoid mocking the dispatcher.

// installMock pattern: replace the logger require so we don't pull in the
// rest of the server.
function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => mockLogger };
installMock(path.join(__dirname, '..', 'logger.js'), mockLogger);

const {
  detectProxyEnv,
  isProxyConfigured,
  shouldBypassProxy,
  redactProxyUrl,
} = require('../utils/proxy-agent');

describe('detectProxyEnv', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
    delete process.env.HTTP_PROXY; delete process.env.http_proxy;
    delete process.env.NO_PROXY; delete process.env.no_proxy;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns nulls when no proxy env vars are set', () => {
    expect(detectProxyEnv()).toEqual({
      httpsProxy: null,
      httpProxy: null,
      noProxy: null,
    });
  });

  it('reads HTTPS_PROXY (uppercase)', () => {
    process.env.HTTPS_PROXY = 'http://host.example:8080';
    expect(detectProxyEnv().httpsProxy).toBe('http://host.example:8080');
  });

  it('reads https_proxy (lowercase) when HTTPS_PROXY is unset', () => {
    process.env.https_proxy = 'http://proxy.lower:8080';
    expect(detectProxyEnv().httpsProxy).toBe('http://proxy.lower:8080');
  });

  it('uppercase HTTPS_PROXY wins over lowercase https_proxy', () => {
    process.env.HTTPS_PROXY = 'http://proxy.upper:8080';
    process.env.https_proxy = 'http://proxy.lower:8080';
    expect(detectProxyEnv().httpsProxy).toBe('http://proxy.upper:8080');
  });

  it('reads HTTP_PROXY and NO_PROXY independently', () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    process.env.NO_PROXY = 'localhost,.internal';
    const result = detectProxyEnv();
    expect(result.httpProxy).toBe('http://proxy:8080');
    expect(result.noProxy).toBe('localhost,.internal');
  });
});

describe('isProxyConfigured', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
    delete process.env.HTTP_PROXY; delete process.env.http_proxy;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns false when no proxy is configured', () => {
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

  it('returns true when only NO_PROXY is set, no actual proxy → false', () => {
    process.env.NO_PROXY = 'localhost';
    // NO_PROXY alone doesn't constitute "configured" — there's no proxy
    // to bypass.
    expect(isProxyConfigured()).toBe(false);
  });
});

describe('shouldBypassProxy', () => {
  it('returns false when NO_PROXY is empty', () => {
    expect(shouldBypassProxy('api.example.com', '')).toBe(false);
    expect(shouldBypassProxy('api.example.com', null)).toBe(false);
  });

  it('returns false when hostname is empty', () => {
    expect(shouldBypassProxy('', 'localhost')).toBe(false);
    expect(shouldBypassProxy(null, 'localhost')).toBe(false);
  });

  it('matches exact hostname', () => {
    expect(shouldBypassProxy('localhost', 'localhost')).toBe(true);
    expect(shouldBypassProxy('127.0.0.1', '127.0.0.1')).toBe(true);
  });

  it('is case-insensitive on hostname', () => {
    expect(shouldBypassProxy('LOCALHOST', 'localhost')).toBe(true);
    expect(shouldBypassProxy('localhost', 'LOCALHOST')).toBe(true);
  });

  it('matches domain suffix with leading dot', () => {
    expect(shouldBypassProxy('sub.example.com', '.example.com')).toBe(true);
    expect(shouldBypassProxy('a.b.example.com', '.example.com')).toBe(true);
  });

  it('matches domain suffix without leading dot', () => {
    // The helper supports "example.com" matching "sub.example.com" via
    // the bare-suffix branch.
    expect(shouldBypassProxy('sub.example.com', 'example.com')).toBe(true);
    expect(shouldBypassProxy('example.com', 'example.com')).toBe(true);
  });

  it('does NOT match unrelated TLDs ("evil-example.com" vs "example.com")', () => {
    // Critical: prefix-matching would be a security bug. The helper
    // requires either exact match or a "." separator.
    expect(shouldBypassProxy('evil-example.com', 'example.com')).toBe(false);
    expect(shouldBypassProxy('notexample.com', 'example.com')).toBe(false);
  });

  it('wildcard "*" bypasses every hostname', () => {
    expect(shouldBypassProxy('any.host.tld', '*')).toBe(true);
    expect(shouldBypassProxy('localhost', '*')).toBe(true);
  });

  it('handles comma-separated lists with whitespace', () => {
    const noProxy = ' localhost , .internal ,  127.0.0.1 ';
    expect(shouldBypassProxy('localhost', noProxy)).toBe(true);
    expect(shouldBypassProxy('foo.internal', noProxy)).toBe(true);
    expect(shouldBypassProxy('127.0.0.1', noProxy)).toBe(true);
    expect(shouldBypassProxy('api.public.example', noProxy)).toBe(false);
  });

  it('returns false when no rule matches', () => {
    expect(shouldBypassProxy('api.public.com', 'localhost,.internal')).toBe(false);
  });

  it('falls back to NO_PROXY env var when no second arg is supplied', () => {
    const original = process.env.NO_PROXY;
    process.env.NO_PROXY = 'envhost.example';
    try {
      expect(shouldBypassProxy('envhost.example')).toBe(true);
      expect(shouldBypassProxy('not.example')).toBe(false);
    } finally {
      if (original === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = original;
    }
  });
});

describe('redactProxyUrl', () => {
  it('redacts username and password', () => {
    expect(redactProxyUrl('http://user:pass' + '@host.example:8080'))
      .toBe('http://***:***@host.example:8080/');
  });

  it('redacts username-only credentials', () => {
    const out = redactProxyUrl('http://user' + '@host.example:8080');
    expect(out).toContain('***');
    expect(out).not.toContain('user@');
  });

  it('returns the URL unchanged when no credentials present', () => {
    expect(redactProxyUrl('http://host.example:8080'))
      .toBe('http://host.example:8080/');
  });

  it('handles HTTPS proxy URLs', () => {
    expect(redactProxyUrl('https://user:pass' + '@secure.example:8443'))
      .toBe('https://***:***@secure.example:8443/');
  });

  it('returns "[invalid-url]" for malformed input', () => {
    expect(redactProxyUrl('not a url')).toBe('[invalid-url]');
    expect(redactProxyUrl('')).toBe('[invalid-url]');
  });

  it('preserves path and query parameters', () => {
    const out = redactProxyUrl('http://user:pass' + '@host.example:8080/path?q=1');
    expect(out).toContain('***:***@host.example:8080');
    expect(out).toContain('/path?q=1');
  });
});
