'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
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
  performBrowserAction,
  buildCdpUrl,
} = require('../plugins/snapscope/handlers/browser-capture');

function axNode({ nodeId, role, name, value, disabled = false, focusable = true }) {
  return {
    nodeId,
    backendDOMNodeId: nodeId + 1000,
    role: { value: role },
    name: { value: name },
    value: value == null ? undefined : { value },
    properties: [
      { name: 'disabled', value: { value: disabled } },
      { name: 'focusable', value: { value: focusable } },
    ],
  };
}

function createFakePage(nodes, overrides = {}) {
  const locator = {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    textContent: vi.fn(async () => 'extracted text'),
  };
  const session = {
    send: vi.fn(async (command) => {
      expect(command).toBe('Accessibility.getFullAXTree');
      return { nodes };
    }),
  };
  const context = {
    newCDPSession: vi.fn(async () => session),
    storageState: vi.fn(async ({ path: statePath } = {}) => {
      if (statePath) fs.writeFileSync(statePath, '{"cookies":[]}');
      return { cookies: [] };
    }),
    pages: vi.fn(() => []),
  };
  const page = {
    title: vi.fn(async () => 'Example Page'),
    url: vi.fn(() => 'http://example.test/'),
    context: vi.fn(() => context),
    screenshot: vi.fn(async () => Buffer.from('fake-image')),
    getByRole: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    mouse: { wheel: vi.fn(async () => {}) },
    evaluate: vi.fn(async () => {}),
    bringToFront: vi.fn(async () => {}),
    ...overrides,
  };
  return { page, context, session, locator };
}

describe('peek/browser-capture', () => {
  it('exposes implemented browser capture status', () => {
    expect(BROWSER_CAPTURE_STATUS).toBe('implemented');
    expect(PEEK_CAPTURE_PROVIDERS.browser.status).toBe('implemented');
    expect(isBrowserCaptureAvailable()).toBe(true);
  });

  it('returns structured capabilities from the browser capture contract', () => {
    const capabilities = getBrowserCaptureCapabilities();

    expect(capabilities).toMatchObject({
      available: true,
      status: 'implemented',
      provider: PEEK_CAPTURE_PROVIDERS.browser,
      supported_platforms: [...PEEK_CAPTURE_PROVIDERS.browser.platforms],
      capabilities: [...PEEK_CAPTURE_PROVIDERS.browser.capabilities],
      platform_support: {
        windows: {
          supported: PEEK_PLATFORM_SUPPORT_MATRIX.windows.supported,
          prerequisite: PEEK_PLATFORM_SUPPORT_MATRIX.windows.prerequisite || null,
        },
      },
    });
    expect(capabilities.actions).toEqual(['click', 'input', 'extract', 'scroll', 'switch_tab']);
    expect(capabilities.observation_policy).toContain('accessibility-tree-first');
  });

  it('captures accessibility-tree-first browser state from an injected Playwright page', async () => {
    const { page } = createFakePage([
      axNode({ nodeId: 1, role: 'button', name: 'Save' }),
      axNode({ nodeId: 2, role: 'textbox', name: 'Search', value: 'abc' }),
      axNode({ nodeId: 3, role: 'text', name: 'Static copy', focusable: false }),
    ]);

    const result = await captureBrowserPage({ page });

    expect(result).toMatchObject({
      success: true,
      status: 'implemented',
      observation: 'accessibility_tree',
      page: { title: 'Example Page', url: 'http://example.test/' },
    });
    expect(result.elements).toHaveLength(2);
    expect(result.elements[0]).toMatchObject({ index: 1, role: 'button', name: 'Save' });
    expect(result.elements[1]).toMatchObject({ index: 2, role: 'textbox', name: 'Search', value: 'abc' });
    expect(result.state.screenshot).toBeNull();
  });

  it('uses vision fallback only when requested and no interactive AX elements exist', async () => {
    const { page } = createFakePage([
      axNode({ nodeId: 1, role: 'text', name: 'Static copy', focusable: false }),
    ]);

    const result = await captureBrowserPage({ page, vision_fallback: true });

    expect(result.success).toBe(true);
    expect(result.vision_fallback_used).toBe(true);
    expect(result.state.screenshot).toMatchObject({
      data: Buffer.from('fake-image').toString('base64'),
      mime_type: 'image/png',
      reason: 'vision_fallback_no_interactive_elements',
    });
  });

  it('saves Playwright storage state when a path is supplied', async () => {
    const { page } = createFakePage([
      axNode({ nodeId: 1, role: 'button', name: 'Save' }),
    ]);
    const statePath = path.join(os.tmpdir(), `torque-storage-state-${Date.now()}.json`);

    const result = await captureBrowserPage({ page, storage_state_path: statePath });

    expect(result.success).toBe(true);
    expect(result.state.storage_state_path).toBe(statePath);
    expect(fs.existsSync(statePath)).toBe(true);
    fs.rmSync(statePath, { force: true });
  });

  it('lists browser pages from an injected browser', async () => {
    const first = createFakePage([]).page;
    const second = createFakePage([], {
      title: vi.fn(async () => 'Second'),
      url: vi.fn(() => 'http://example.test/second'),
    }).page;
    const browser = { pages: [first, second] };

    const result = await listBrowserPages({ browser });

    expect(result.success).toBe(true);
    expect(result.pages).toEqual([
      { index: 0, title: 'Example Page', url: 'http://example.test/' },
      { index: 1, title: 'Second', url: 'http://example.test/second' },
    ]);
  });

  it('returns elements without screenshots for getBrowserElements', async () => {
    const { page } = createFakePage([
      axNode({ nodeId: 1, role: 'link', name: 'Docs' }),
    ]);

    const result = await getBrowserElements({ page });

    expect(result).toMatchObject({
      success: true,
      status: 'implemented',
      elements: [{ index: 1, role: 'link', name: 'Docs' }],
    });
  });

  it('performs high-level click and input actions by current element index', async () => {
    const { page, locator } = createFakePage([
      axNode({ nodeId: 1, role: 'button', name: 'Save' }),
      axNode({ nodeId: 2, role: 'textbox', name: 'Search' }),
    ]);

    const clickResult = await performBrowserAction({ page, action: 'click', element_index: 1 });
    const inputResult = await performBrowserAction({ page, action: 'input', element_index: 2, text: 'hello' });

    expect(clickResult).toMatchObject({ success: true, action: 'click' });
    expect(inputResult).toMatchObject({ success: true, action: 'input', text_length: 5 });
    expect(locator.click).toHaveBeenCalledTimes(1);
    expect(locator.fill).toHaveBeenCalledWith('hello');
  });

  it('rejects stale or missing element indexes before taking action', async () => {
    const { page, locator } = createFakePage([
      axNode({ nodeId: 1, role: 'button', name: 'Save' }),
    ]);

    const result = await performBrowserAction({ page, action: 'click', element_index: 99 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No current browser element with index 99');
    expect(locator.click).not.toHaveBeenCalled();
  });

  it('switches tabs without exposing arbitrary scripting', async () => {
    const first = createFakePage([]).page;
    const second = createFakePage([], {
      title: vi.fn(async () => 'Second'),
      url: vi.fn(() => 'http://example.test/second'),
    }).page;
    const browser = { pages: [first, second] };

    const result = await performBrowserAction({ browser, action: 'switch_tab', tab_index: 1 });

    expect(result).toMatchObject({
      success: true,
      action: 'switch_tab',
      tab: { index: 1, title: 'Second', url: 'http://example.test/second' },
    });
    expect(second.bringToFront).toHaveBeenCalledTimes(1);
  });

  it('returns a structured unavailable response when Playwright/CDP is missing', async () => {
    const result = await captureBrowserPage({ playwright: {}, cdp_url: 'http://127.0.0.1:1' });

    expect(result).toMatchObject({
      success: false,
      status: 'unavailable',
      implementation_status: 'implemented',
      missing_dependency: 'playwright-core',
    });
  });

  it('builds the default CDP endpoint URL', () => {
    expect(buildCdpUrl()).toBe('http://127.0.0.1:9222');
    expect(buildCdpUrl(null)).toBe('http://127.0.0.1:9222');
  });

  it('uses custom CDP host, port, and URL values when provided', () => {
    expect(buildCdpUrl({ host: 'localhost', port: 9333 })).toBe('http://localhost:9333');
    expect(buildCdpUrl({ host: ' 192.0.2.10 ', port: '9229' })).toBe('http://192.0.2.10:9229');
    expect(buildCdpUrl({ cdp_url: ' http://browser.test:9222 ' })).toBe('http://browser.test:9222');
  });
});
