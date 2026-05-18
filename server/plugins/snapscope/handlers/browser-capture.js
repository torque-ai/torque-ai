'use strict';

const fs = require('fs');
const { PEEK_CAPTURE_PROVIDERS, PEEK_PLATFORM_SUPPORT_MATRIX } = require('../../../contracts/peek');
const { ErrorCodes, makeError } = require('../../../handlers/shared');
const logger = require('../../../logger').child({ component: 'peek-browser-capture' });

const BROWSER_CAPTURE_STATUS = 'implemented';
const DEFAULT_CDP_HOST = '127.0.0.1';
const DEFAULT_CDP_PORT = 9222;
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

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

function tryRequire(moduleName) {
  try {
    return require(moduleName);
  } catch {
    return null;
  }
}

function getPlaywright(options = {}) {
  if (options.playwright) {
    return options.playwright;
  }
  return tryRequire('playwright-core') || tryRequire('playwright');
}

/**
 * Check if browser capture is implemented in TORQUE.
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
      'Playwright or Playwright Core npm package installed for live CDP sessions',
      'Optional Playwright storage_state JSON file for authenticated sessions',
    ],
    actions: ['click', 'input', 'extract', 'scroll', 'switch_tab'],
    observation_policy: 'accessibility-tree-first; screenshot only when requested or when no useful AX elements are available',
  };
}

function buildCdpUrl(options = {}) {
  const normalizedOptions = normalizeOptions(options);
  if (typeof normalizedOptions.cdp_url === 'string' && normalizedOptions.cdp_url.trim()) {
    return normalizedOptions.cdp_url.trim();
  }
  const host = normalizeHost(normalizedOptions.host);
  const port = normalizePort(normalizedOptions.port);
  return `http://${host}:${port}`;
}

function buildUnavailableResponse(operation, options, details = {}) {
  const normalizedOptions = normalizeOptions(options);
  if (normalizedOptions.log_unavailable === true) {
    logger.debug('Browser capture unavailable', {
      operation,
      cdp_url: buildCdpUrl(normalizedOptions),
      reason: details.error || details.reason || null,
    });
  }

  return {
    success: false,
    status: 'unavailable',
    implementation_status: BROWSER_CAPTURE_STATUS,
    ...details,
  };
}

async function listPagesFromBrowser(browser) {
  if (!browser) {
    return [];
  }
  if (Array.isArray(browser.pages)) {
    return browser.pages;
  }
  if (typeof browser.pages === 'function') {
    return browser.pages();
  }
  if (typeof browser.contexts === 'function') {
    const contexts = await browser.contexts();
    const pages = [];
    for (const context of contexts || []) {
      if (typeof context.pages === 'function') {
        pages.push(...await context.pages());
      }
    }
    return pages;
  }
  return [];
}

async function connectBrowser(options) {
  if (options.page) {
    return { page: options.page, browser: options.browser || null, context: options.page.context?.() || null, close: async () => {} };
  }

  if (options.browser) {
    const pages = await listPagesFromBrowser(options.browser);
    const page = pages[Number(options.tab_index || options.page_index || 0)] || pages[0] || null;
    if (!page) {
      return { error: 'Connected browser has no pages' };
    }
    return { page, browser: options.browser, context: page.context?.() || null, close: async () => {} };
  }

  const playwright = getPlaywright(options);
  const chromium = playwright?.chromium;
  if (!chromium) {
    return {
      error: 'Playwright is not installed. Install playwright-core or pass an existing Playwright page.',
      missing_dependency: 'playwright-core',
    };
  }

  if (options.launch === true || options.url) {
    const browser = await chromium.launch({ headless: options.headless !== false });
    const contextOptions = {};
    if (options.storage_state_path && fs.existsSync(options.storage_state_path)) {
      contextOptions.storageState = options.storage_state_path;
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    if (options.url) {
      await page.goto(options.url, { waitUntil: options.wait_until || 'domcontentloaded' });
    }
    return { page, browser, context, close: async () => browser.close?.() };
  }

  const browser = await chromium.connectOverCDP(buildCdpUrl(options));
  const pages = await listPagesFromBrowser(browser);
  const page = pages[Number(options.tab_index || options.page_index || 0)] || pages[0] || null;
  if (!page) {
    return { error: 'CDP browser has no open pages', browser, close: async () => browser.close?.() };
  }
  return { page, browser, context: page.context?.() || null, close: async () => browser.close?.() };
}

function unwrapAxValue(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return value.value;
  }
  return value;
}

function getAxProperty(node, name) {
  const property = Array.isArray(node?.properties)
    ? node.properties.find((entry) => entry && entry.name === name)
    : null;
  return unwrapAxValue(property?.value);
}

function normalizeAxNode(node, index) {
  const role = String(unwrapAxValue(node?.role) || '').toLowerCase();
  const name = String(unwrapAxValue(node?.name) || '').trim();
  const value = unwrapAxValue(node?.value);
  const disabled = getAxProperty(node, 'disabled') === true;
  const ignored = node?.ignored === true;
  const editable = getAxProperty(node, 'editable') === 'plaintext' || getAxProperty(node, 'editable') === 'richtext';
  const focusable = getAxProperty(node, 'focusable') === true;
  const interactive = !ignored && !disabled && (INTERACTIVE_ROLES.has(role) || editable || focusable);

  return {
    index,
    role,
    name,
    value: value == null ? null : String(value),
    ax_node_id: node?.nodeId || null,
    backend_node_id: node?.backendDOMNodeId || null,
    disabled,
    focused: getAxProperty(node, 'focused') === true,
    selected: getAxProperty(node, 'selected') === true,
    checked: getAxProperty(node, 'checked') ?? null,
    expanded: getAxProperty(node, 'expanded') ?? null,
    ignored,
    interactive,
  };
}

function buildIndexedElements(nodes = []) {
  const elements = [];
  for (const node of nodes) {
    const candidate = normalizeAxNode(node, elements.length + 1);
    if (!candidate.interactive) {
      continue;
    }
    if (!candidate.name && !candidate.value && !candidate.role) {
      continue;
    }
    elements.push({ ...candidate, index: elements.length + 1 });
  }
  return elements;
}

async function getPageTitle(page) {
  try {
    return typeof page.title === 'function' ? await page.title() : '';
  } catch {
    return '';
  }
}

async function getPageUrl(page) {
  try {
    return typeof page.url === 'function' ? await page.url() : String(page.url || '');
  } catch {
    return '';
  }
}

async function getAccessibilityNodes(page) {
  const context = page.context?.();
  if (!context || typeof context.newCDPSession !== 'function') {
    if (typeof page.accessibility?.snapshot === 'function') {
      const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
      return flattenAccessibilitySnapshot(snapshot);
    }
    throw new Error('Page context does not expose CDP accessibility access');
  }

  const session = await context.newCDPSession(page);
  const response = await session.send('Accessibility.getFullAXTree');
  return Array.isArray(response?.nodes) ? response.nodes : [];
}

function flattenAccessibilitySnapshot(root) {
  const nodes = [];
  function visit(node) {
    if (!node) {
      return;
    }
    nodes.push({
      role: { value: node.role },
      name: { value: node.name },
      value: { value: node.value },
      properties: [
        { name: 'disabled', value: { value: node.disabled === true } },
        { name: 'focusable', value: { value: Boolean(node.focused || node.name) } },
        { name: 'focused', value: { value: node.focused === true } },
        { name: 'checked', value: { value: node.checked } },
        { name: 'selected', value: { value: node.selected } },
        { name: 'expanded', value: { value: node.expanded } },
      ],
    });
    for (const child of node.children || []) {
      visit(child);
    }
  }
  visit(root);
  return nodes;
}

async function maybeCaptureScreenshot(page, options, elements) {
  const requested = options.include_screenshot === true || options.screenshot === true;
  const fallback = options.vision_fallback === true && elements.length === 0;
  if (!requested && !fallback) {
    return null;
  }
  if (typeof page.screenshot !== 'function') {
    return null;
  }
  const buffer = await page.screenshot({ fullPage: options.full_page === true, type: options.screenshot_type || 'png' });
  return {
    data: Buffer.isBuffer(buffer) ? buffer.toString('base64') : Buffer.from(buffer).toString('base64'),
    mime_type: options.screenshot_type === 'jpeg' ? 'image/jpeg' : 'image/png',
    reason: requested ? 'requested' : 'vision_fallback_no_interactive_elements',
  };
}

async function maybeSaveStorageState(context, options) {
  if (!options.storage_state_path || !context || typeof context.storageState !== 'function') {
    return null;
  }
  await context.storageState({ path: options.storage_state_path });
  return options.storage_state_path;
}

async function captureBrowserPage(options = {}) {
  const normalizedOptions = normalizeOptions(options);
  let session = null;
  try {
    session = await connectBrowser(normalizedOptions);
    if (session.error) {
      return buildUnavailableResponse('captureBrowserPage', normalizedOptions, {
        error: session.error,
        missing_dependency: session.missing_dependency || null,
        capabilities: getBrowserCaptureCapabilities(),
      });
    }

    const page = session.page;
    const nodes = await getAccessibilityNodes(page);
    const elements = buildIndexedElements(nodes);
    const screenshot = await maybeCaptureScreenshot(page, normalizedOptions, elements);
    const storageStatePath = await maybeSaveStorageState(session.context, normalizedOptions);
    const state = {
      title: await getPageTitle(page),
      url: await getPageUrl(page),
      element_count: elements.length,
      elements,
      raw_node_count: nodes.length,
      screenshot,
      storage_state_path: storageStatePath,
      tabs: await listBrowserPageSummaries(session.browser || { pages: [page] }),
    };

    return {
      success: true,
      status: BROWSER_CAPTURE_STATUS,
      observation: 'accessibility_tree',
      vision_fallback_used: screenshot?.reason === 'vision_fallback_no_interactive_elements',
      state,
      elements,
      page: {
        title: state.title,
        url: state.url,
      },
      capabilities: getBrowserCaptureCapabilities(),
    };
  } catch (err) {
    return buildUnavailableResponse('captureBrowserPage', normalizedOptions, {
      error: err.message || String(err),
      capabilities: getBrowserCaptureCapabilities(),
    });
  } finally {
    if (session && normalizedOptions.keep_open !== true) {
      try { await session.close?.(); } catch { /* best effort */ }
    }
  }
}

async function listBrowserPageSummaries(browser) {
  const pages = await listPagesFromBrowser(browser);
  const summaries = [];
  for (let i = 0; i < pages.length; i += 1) {
    summaries.push({
      index: i,
      title: await getPageTitle(pages[i]),
      url: await getPageUrl(pages[i]),
    });
  }
  return summaries;
}

async function listBrowserPages(options = {}) {
  const normalizedOptions = normalizeOptions(options);
  let session = null;
  try {
    session = await connectBrowser(normalizedOptions);
    if (session.error) {
      return buildUnavailableResponse('listBrowserPages', normalizedOptions, {
        error: session.error,
        pages: [],
        capabilities: getBrowserCaptureCapabilities(),
      });
    }
    return {
      success: true,
      status: BROWSER_CAPTURE_STATUS,
      pages: await listBrowserPageSummaries(session.browser || { pages: [session.page] }),
      capabilities: getBrowserCaptureCapabilities(),
    };
  } catch (err) {
    return buildUnavailableResponse('listBrowserPages', normalizedOptions, {
      error: err.message || String(err),
      pages: [],
      capabilities: getBrowserCaptureCapabilities(),
    });
  } finally {
    if (session && normalizedOptions.keep_open !== true) {
      try { await session.close?.(); } catch { /* best effort */ }
    }
  }
}

async function getBrowserElements(options = {}) {
  const result = await captureBrowserPage({ ...normalizeOptions(options), include_screenshot: false, vision_fallback: false });
  if (!result.success) {
    return {
      ...result,
      elements: [],
    };
  }
  return {
    success: true,
    status: BROWSER_CAPTURE_STATUS,
    elements: result.elements,
    page: result.page,
    capabilities: getBrowserCaptureCapabilities(),
  };
}

async function resolveElementForAction(page, options, state) {
  if (options.element_index != null || options.index != null) {
    const index = Number(options.element_index ?? options.index);
    if (!Number.isInteger(index) || index < 1) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, 'element_index must be a positive integer') };
    }
    const element = (state?.elements || []).find((entry) => entry.index === index);
    if (!element) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `No current browser element with index ${index}`) };
    }
    return { element, locator: buildLocator(page, element) };
  }

  const role = typeof options.role === 'string' ? options.role.trim() : '';
  const name = typeof options.name === 'string' ? options.name.trim() : '';
  if (role && typeof page.getByRole === 'function') {
    return { element: { role, name, index: null }, locator: page.getByRole(role, name ? { name } : undefined) };
  }
  if (name && typeof page.getByText === 'function') {
    return { element: { role: null, name, index: null }, locator: page.getByText(name) };
  }
  return { error: makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'element_index, or role/name target, is required') };
}

function buildLocator(page, element) {
  if (element.role && element.name && typeof page.getByRole === 'function') {
    return page.getByRole(element.role, { name: element.name });
  }
  if (element.name && typeof page.getByText === 'function') {
    return page.getByText(element.name);
  }
  if (element.backend_node_id && typeof page.locator === 'function') {
    return page.locator(`[data-backend-node-id="${element.backend_node_id}"]`);
  }
  return null;
}

async function runLocatorAction(locator, action, options, element) {
  if (action === 'click') {
    if (!locator || typeof locator.click !== 'function') {
      return makeError(ErrorCodes.OPERATION_FAILED, `Element ${element.index || element.name || ''} cannot be clicked by the current browser adapter`);
    }
    await locator.click();
    return { success: true, action, element };
  }

  if (action === 'input') {
    if (typeof options.text !== 'string') {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'input action requires text');
    }
    if (locator && typeof locator.fill === 'function') {
      await locator.fill(options.text);
    } else if (locator && typeof locator.type === 'function') {
      await locator.type(options.text);
    } else {
      return makeError(ErrorCodes.OPERATION_FAILED, `Element ${element.index || element.name || ''} cannot receive input by the current browser adapter`);
    }
    return { success: true, action, element, text_length: options.text.length };
  }

  if (action === 'extract') {
    let text = element.value || element.name || '';
    if (locator && typeof locator.textContent === 'function') {
      text = await locator.textContent();
    }
    return { success: true, action, element, text: text || '' };
  }

  return makeError(ErrorCodes.INVALID_PARAM, `Unsupported element action: ${action}`);
}

async function performBrowserAction(options = {}) {
  const normalizedOptions = normalizeOptions(options);
  const action = typeof normalizedOptions.action === 'string' ? normalizedOptions.action.trim() : '';
  if (!action) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'action is required');
  }
  if (!['click', 'input', 'extract', 'scroll', 'switch_tab'].includes(action)) {
    return makeError(ErrorCodes.INVALID_PARAM, `Unsupported browser action: ${action}`);
  }

  let session = null;
  try {
    session = await connectBrowser({ ...normalizedOptions, keep_open: true });
    if (session.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, session.error);
    }

    if (action === 'switch_tab') {
      const pages = await listPagesFromBrowser(session.browser || { pages: [session.page] });
      const targetIndex = Number(normalizedOptions.tab_index ?? normalizedOptions.page_index ?? 0);
      if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= pages.length) {
        return makeError(ErrorCodes.INVALID_PARAM, `No browser tab at index ${targetIndex}`);
      }
      await pages[targetIndex].bringToFront?.();
      return {
        success: true,
        status: BROWSER_CAPTURE_STATUS,
        action,
        tab: {
          index: targetIndex,
          title: await getPageTitle(pages[targetIndex]),
          url: await getPageUrl(pages[targetIndex]),
        },
      };
    }

    if (action === 'scroll') {
      const delta = Number(normalizedOptions.delta ?? normalizedOptions.scroll_delta ?? 600);
      if (session.page.mouse && typeof session.page.mouse.wheel === 'function') {
        await session.page.mouse.wheel(0, delta);
      } else if (typeof session.page.evaluate === 'function') {
        await session.page.evaluate((amount) => globalThis.scrollBy(0, amount), delta);
      } else {
        return makeError(ErrorCodes.OPERATION_FAILED, 'Current browser adapter cannot scroll');
      }
      return { success: true, status: BROWSER_CAPTURE_STATUS, action, delta };
    }

    const state = normalizedOptions.state || (await captureBrowserPage({ ...normalizedOptions, page: session.page, keep_open: true })).state;
    const resolved = await resolveElementForAction(session.page, normalizedOptions, state);
    if (resolved.error) {
      return resolved.error;
    }
    const result = await runLocatorAction(resolved.locator, action, normalizedOptions, resolved.element);
    if (result?.isError) {
      return result;
    }
    return {
      status: BROWSER_CAPTURE_STATUS,
      ...result,
    };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, err.message || String(err));
  } finally {
    if (session && normalizedOptions.keep_open !== true && !normalizedOptions.page && !normalizedOptions.browser) {
      try { await session.close?.(); } catch { /* best effort */ }
    }
  }
}

function formatStateText(result) {
  if (!result.success) {
    return `Browser state unavailable: ${result.error || 'unknown error'}`;
  }
  const lines = [
    '## Browser State',
    `**URL:** ${result.page.url || '(unknown)'}`,
    `**Title:** ${result.page.title || '(untitled)'}`,
    `**Interactive Elements:** ${result.elements.length}`,
    '',
  ];
  for (const element of result.elements.slice(0, 80)) {
    const label = element.name || element.value || '(unnamed)';
    lines.push(`${element.index}. ${element.role || 'element'} — ${label}`);
  }
  if (result.elements.length > 80) {
    lines.push(`... ${result.elements.length - 80} more`);
  }
  return lines.join('\n');
}

async function handlePeekBrowserState(args = {}) {
  const result = await captureBrowserPage(args);
  const content = [];
  const screenshot = result.state?.screenshot || null;
  if (screenshot?.data) {
    content.push({
      type: 'image',
      data: screenshot.data,
      mimeType: screenshot.mime_type || 'image/png',
    });
  }
  content.push({ type: 'text', text: formatStateText(result) });
  return {
    content,
    structuredData: result,
    isError: result.success !== true,
  };
}

async function handlePeekBrowserAction(args = {}) {
  const result = await performBrowserAction(args);
  if (result?.isError) {
    return result;
  }
  return {
    content: [{
      type: 'text',
      text: `Browser action ${result.action} completed${result.element?.index ? ` on element ${result.element.index}` : ''}.`,
    }],
    structuredData: result,
  };
}

module.exports = {
  BROWSER_CAPTURE_STATUS,
  isBrowserCaptureAvailable,
  getBrowserCaptureCapabilities,
  captureBrowserPage,
  listBrowserPages,
  getBrowserElements,
  performBrowserAction,
  handlePeekBrowserState,
  handlePeekBrowserAction,
  buildCdpUrl,
  _testing: {
    buildIndexedElements,
    normalizeAxNode,
    flattenAccessibilitySnapshot,
  },
};
