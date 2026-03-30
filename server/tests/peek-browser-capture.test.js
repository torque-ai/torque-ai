'use strict';

const {
  PEEK_CAPTURE_PROVIDERS,
  PEEK_PLATFORM_SUPPORT_MATRIX,
} = require('../contracts/peek');
const {
  BROWSER_CAPTURE_STATUS,
  isBrowserCaptureAvailable,
  getBrowserCaptureCapabilities,
  captureBrowserPage,
  listBrowserPages,
  getBrowserElements,
  buildCdpUrl,
} = require('../plugins/snapscope/handlers/browser-capture');

describe('peek/browser-capture scaffold', () => {
  it('exposes planned browser capture status and reports the provider as unavailable', () => {
    expect(BROWSER_CAPTURE_STATUS).toBe('planned');
    expect(PEEK_CAPTURE_PROVIDERS.browser.status).toBe('planned');
    expect(isBrowserCaptureAvailable()).toBe(false);
  });

  it('returns structured capabilities from the browser capture contract', () => {
    const capabilities = getBrowserCaptureCapabilities();

    expect(capabilities).toMatchObject({
      available: false,
      status: 'planned',
      provider: PEEK_CAPTURE_PROVIDERS.browser,
      supported_platforms: [...PEEK_CAPTURE_PROVIDERS.browser.platforms],
      capabilities: [...PEEK_CAPTURE_PROVIDERS.browser.capabilities],
      platform_support: {
        windows: {
          supported: PEEK_PLATFORM_SUPPORT_MATRIX.windows.supported,
          prerequisite: PEEK_PLATFORM_SUPPORT_MATRIX.windows.prerequisite || null,
        },
        linux: {
          supported: PEEK_PLATFORM_SUPPORT_MATRIX.linux.supported,
          prerequisite: PEEK_PLATFORM_SUPPORT_MATRIX.linux.prerequisite || null,
        },
        darwin: {
          supported: PEEK_PLATFORM_SUPPORT_MATRIX.darwin.supported,
          prerequisite: PEEK_PLATFORM_SUPPORT_MATRIX.darwin.prerequisite || null,
        },
      },
    });
    expect(capabilities.requirements).toEqual(expect.arrayContaining([
      expect.stringContaining('remote debugging enabled'),
      expect.stringContaining('CDP'),
      expect.stringContaining('Playwright'),
    ]));
    expect(capabilities.requirements.length).toBeGreaterThan(0);
  });

  it('returns a structured unavailable response when capture is requested', () => {
    const result = captureBrowserPage();

    expect(result).toMatchObject({
      success: false,
      status: 'planned',
      error: 'Browser capture provider is not yet implemented (status: planned)',
      help: expect.stringContaining('CDP-compatible browser'),
      capabilities: getBrowserCaptureCapabilities(),
    });
  });

  it('returns empty browser page results while the provider is unavailable', () => {
    const result = listBrowserPages();

    expect(result).toMatchObject({
      success: false,
      status: 'planned',
      error: 'Browser capture provider is not yet implemented',
      pages: [],
      capabilities: getBrowserCaptureCapabilities(),
    });
  });

  it('returns empty browser element results while the provider is unavailable', () => {
    const result = getBrowserElements();

    expect(result).toMatchObject({
      success: false,
      status: 'planned',
      error: 'Browser capture provider is not yet implemented',
      elements: [],
      capabilities: getBrowserCaptureCapabilities(),
    });
  });

  it('keeps all provider-backed operations in a structured failure state until implementation exists', () => {
    const results = [
      captureBrowserPage({}),
      listBrowserPages({}),
      getBrowserElements({}),
    ];

    expect(results.every((result) => result.success === false)).toBe(true);
    expect(results.every((result) => result.status === 'planned')).toBe(true);
  });

  it('builds the default CDP endpoint URL', () => {
    expect(buildCdpUrl()).toBe('http://127.0.0.1:9222/json');
    expect(buildCdpUrl(null)).toBe('http://127.0.0.1:9222/json');
  });

  it('uses custom CDP host and port values when provided', () => {
    expect(buildCdpUrl({ host: 'localhost', port: 9333 })).toBe('http://localhost:9333/json');
    expect(buildCdpUrl({ host: ' 192.0.2.10 ', port: '9229' })).toBe('http://192.0.2.10:9229/json');
  });
});
