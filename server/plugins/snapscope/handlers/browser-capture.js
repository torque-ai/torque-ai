'use strict';

const { PEEK_CAPTURE_PROVIDERS, PEEK_PLATFORM_SUPPORT_MATRIX } = require('../../../contracts/peek');
const logger = require('../../../logger').child({ component: 'peek-browser-capture' });

const BROWSER_CAPTURE_STATUS = 'planned'; // Will change to 'available' when provider ships
const DEFAULT_CDP_HOST = '127.0.0.1';
const DEFAULT_CDP_PORT = 9222;

function normalizeOptions(options) {
  return options && typeof options === 'object' && !Array.isArray(options) ? options : {};
}

function normalizeHost(host) {
  if (typeof host !== 'string') {
    return DEFAULT_CDP_HOST;
  }

  const normalizedHost = host.trim();
  return normalizedHost || DEFAULT_CDP_HOST;
}

function normalizePort(port) {
  if (port === undefined || port === null || port === '') {
    return DEFAULT_CDP_PORT;
  }

  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    return DEFAULT_CDP_PORT;
  }

  return normalizedPort;
}

function getBrowserProvider() {
  return PEEK_CAPTURE_PROVIDERS.browser || null;
}

function getBrowserPlatformSupport() {
  const provider = getBrowserProvider();
  if (!provider) {
    return {};
  }

  return provider.platforms.reduce((support, platform) => {
    const platformEntry = PEEK_PLATFORM_SUPPORT_MATRIX[platform] || null;
    support[platform] = {
      supported: platformEntry?.supported === true,
      prerequisite: platformEntry?.prerequisite || null,
    };
    return support;
  }, {});
}

/**
 * Check if browser capture is available.
 */
function isBrowserCaptureAvailable() {
  const provider = getBrowserProvider();
  return Boolean(provider && provider.status === 'implemented');
}

/**
 * Get browser capture capabilities.
 */
function getBrowserCaptureCapabilities() {
  const provider = getBrowserProvider();
  return {
    available: isBrowserCaptureAvailable(),
    status: BROWSER_CAPTURE_STATUS,
    provider: provider || null,
    supported_platforms: provider ? [...provider.platforms] : [],
    capabilities: provider ? [...provider.capabilities] : [],
    platform_support: getBrowserPlatformSupport(),
    requirements: [
      'Chrome/Chromium or Edge browser with remote debugging enabled',
      'CDP (Chrome DevTools Protocol) accessible on a debug port',
      'Playwright or Puppeteer npm package installed',
    ],
  };
}

function maybeLogUnavailable(operation, options) {
  if (options.log_unavailable !== true) {
    return;
  }

  logger.debug('Browser capture requested before provider implementation', {
    operation,
    status: BROWSER_CAPTURE_STATUS,
    cdp_url: buildCdpUrl(options),
  });
}

function buildUnavailableResponse(operation, options, details = {}) {
  maybeLogUnavailable(operation, options);
  return {
    success: false,
    status: BROWSER_CAPTURE_STATUS,
    ...details,
  };
}

/**
 * Capture a browser tab/page. Returns structured error until provider is implemented.
 */
function captureBrowserPage(options = {}) {
  const normalizedOptions = normalizeOptions(options);
  if (!isBrowserCaptureAvailable()) {
    return buildUnavailableResponse('captureBrowserPage', normalizedOptions, {
      error: `Browser capture provider is not yet implemented (status: ${BROWSER_CAPTURE_STATUS})`,
      help: 'Browser capture requires a CDP-compatible browser with remote debugging. See DS-07 in the deferred scope register.',
      capabilities: getBrowserCaptureCapabilities(),
    });
  }

  return buildUnavailableResponse('captureBrowserPage', normalizedOptions, {
    error: 'Browser capture implementation pending',
    capabilities: getBrowserCaptureCapabilities(),
  });
}

/**
 * List browser tabs/pages. Returns structured error until provider is implemented.
 */
function listBrowserPages(options = {}) {
  const normalizedOptions = normalizeOptions(options);
  if (!isBrowserCaptureAvailable()) {
    return buildUnavailableResponse('listBrowserPages', normalizedOptions, {
      error: 'Browser capture provider is not yet implemented',
      pages: [],
      capabilities: getBrowserCaptureCapabilities(),
    });
  }

  return buildUnavailableResponse('listBrowserPages', normalizedOptions, {
    error: 'Implementation pending',
    pages: [],
    capabilities: getBrowserCaptureCapabilities(),
  });
}

/**
 * Get DOM elements from a browser page. Returns structured error until provider is implemented.
 */
function getBrowserElements(options = {}) {
  const normalizedOptions = normalizeOptions(options);
  if (!isBrowserCaptureAvailable()) {
    return buildUnavailableResponse('getBrowserElements', normalizedOptions, {
      error: 'Browser capture provider is not yet implemented',
      elements: [],
      capabilities: getBrowserCaptureCapabilities(),
    });
  }

  return buildUnavailableResponse('getBrowserElements', normalizedOptions, {
    error: 'Implementation pending',
    elements: [],
    capabilities: getBrowserCaptureCapabilities(),
  });
}

/**
 * Build a CDP connection URL from options.
 */
function buildCdpUrl(options = {}) {
  const normalizedOptions = normalizeOptions(options);
  const host = normalizeHost(normalizedOptions.host);
  const port = normalizePort(normalizedOptions.port);
  return `http://${host}:${port}/json`;
}

module.exports = {
  BROWSER_CAPTURE_STATUS,
  isBrowserCaptureAvailable,
  getBrowserCaptureCapabilities,
  captureBrowserPage,
  listBrowserPages,
  getBrowserElements,
  buildCdpUrl,
};
