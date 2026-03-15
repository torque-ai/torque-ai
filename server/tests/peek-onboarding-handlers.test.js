'use strict';

const MODULE_PATH = require.resolve('../handlers/peek/onboarding');

const realShared = require('../handlers/shared');
const realContracts = require('../contracts/peek');

const { ErrorCodes, makeError } = realShared;
const {
  PEEK_FIRST_SLICE_APP_TYPES,
  PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME,
  PEEK_FIRST_SLICE_HOST_PLATFORMS,
} = realContracts;

let currentModules = {};

vi.mock('../handlers/peek/shared', () => currentModules.peekShared);
vi.mock('../logger', () => currentModules.loggerModule);

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function createLoggerMock() {
  const instance = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    instance,
    module: {
      child: vi.fn(() => instance),
    },
  };
}

function createPeekSharedMock(overrides = {}) {
  return {
    resolvePeekHost: vi.fn(() => ({
      hostName: 'peek-host',
      hostUrl: 'http://peek-host:9876',
      ssh: 'tester@peek-host',
      platform: 'windows',
    })),
    peekHttpGetWithRetry: vi.fn().mockResolvedValue({
      data: {
        windows: [],
      },
    }),
    ...overrides,
  };
}

function createModules(overrides = {}) {
  const logger = createLoggerMock();

  return {
    peekShared: createPeekSharedMock(overrides.peekShared),
    loggerModule: overrides.loggerModule || logger.module,
    loggerInstance: overrides.loggerInstance || logger.instance,
  };
}

function loadHandlers() {
  vi.resetModules();
  vi.doMock('../handlers/peek/shared', () => currentModules.peekShared);
  vi.doMock('../logger', () => currentModules.loggerModule);

  installCjsModuleMock('../handlers/peek/shared', currentModules.peekShared);
  installCjsModuleMock('../logger', currentModules.loggerModule);

  delete require.cache[MODULE_PATH];
  return require('../handlers/peek/onboarding');
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function expectError(result, code, fragment) {
  expect(result).toMatchObject({
    isError: true,
    error_code: code,
  });
  if (fragment) {
    expect(getText(result)).toContain(fragment);
  }
}

describe('server/handlers/peek/onboarding', () => {
  let handlers;
  let mocks;

  beforeEach(() => {
    vi.clearAllMocks();
    currentModules = createModules();
    mocks = currentModules;
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    currentModules = {};
    delete require.cache[MODULE_PATH];
  });

  describe('handlePeekOnboard', () => {
    it('returns the full guided setup catalog for the first slice', () => {
      const result = handlers.handlePeekOnboard();

      expect(result).toMatchObject({
        success: true,
        slice: 'first',
        supported_platforms: [...PEEK_FIRST_SLICE_HOST_PLATFORMS],
        canonical_tool: PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME,
      });
      expect(result.app_types.map((entry) => entry.app_type).sort()).toEqual([...PEEK_FIRST_SLICE_APP_TYPES].sort());
    });

    it('surfaces capability assessment details for each supported app type', () => {
      const result = handlers.handlePeekOnboard();
      const wpf = result.app_types.find((entry) => entry.app_type === 'wpf');
      const win32 = result.app_types.find((entry) => entry.app_type === 'win32');
      const electron = result.app_types.find((entry) => entry.app_type === 'electron_webview');

      expect(wpf).toMatchObject({
        framework: 'WPF / .NET',
        capabilities: {
          screenshot: true,
          automation_id: true,
          devtools_protocol: false,
        },
        recommended_options: {
          element_depth: 5,
        },
      });
      expect(win32).toMatchObject({
        framework: 'Win32 / MFC / ATL',
        capabilities: {
          automation_id: false,
          measurements: true,
        },
        recommended_options: {
          element_depth: 4,
        },
      });
      expect(electron).toMatchObject({
        framework: 'Chromium-based (Electron, WebView2, CEF)',
        capabilities: {
          devtools_protocol: true,
          dom_snapshot: true,
        },
        recommended_options: {
          element_depth: 6,
        },
      });
    });

    it('filters to a normalized app type selection', () => {
      const result = handlers.handlePeekOnboard({ app_type: '  WPF  ' });

      expect(result.success).toBe(true);
      expect(result.app_types).toHaveLength(1);
      expect(result.app_types[0]).toMatchObject({
        app_type: 'wpf',
        label: 'WPF (Windows Presentation Foundation)',
      });
    });

    it('rejects unsupported app types with the supported list in the error text', () => {
      const result = handlers.handlePeekOnboard({ app_type: 'qt' });

      expectError(result, ErrorCodes.INVALID_PARAM.code, "Unknown app type 'qt'");
      expect(getText(result)).toContain(PEEK_FIRST_SLICE_APP_TYPES.join(', '));
    });

    it('returns cloned capability and recommended option objects on each call', () => {
      const first = handlers.handlePeekOnboard({ app_type: 'wpf' });
      first.app_types[0].capabilities.automation_id = false;
      first.app_types[0].recommended_options.element_depth = 99;

      const second = handlers.handlePeekOnboard({ app_type: 'wpf' });

      expect(second.app_types[0].capabilities.automation_id).toBe(true);
      expect(second.app_types[0].recommended_options.element_depth).toBe(5);
    });

    it('returns the guided onboarding steps in order', () => {
      const result = handlers.handlePeekOnboard();

      expect(result.onboarding_steps).toHaveLength(6);
      expect(result.onboarding_steps[0]).toContain('registered and healthy');
      expect(result.onboarding_steps[0]).toContain('list_peek_hosts');
      expect(result.onboarding_steps[2]).toContain(PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME);
      expect(result.onboarding_steps[3]).toContain("bundle's app_type");
      expect(result.onboarding_steps[4]).toContain('evidence_sufficiency');
      expect(result.onboarding_steps[5]).toContain('peek_semantic_diff');
    });
  });

  describe('detectAppTypeFromClassName', () => {
    it('detects WPF windows from HwndWrapper class names', () => {
      expect(handlers.detectAppTypeFromClassName('HwndWrapper[Ops.Desktop;;shell]')).toBe('wpf');
    });

    it('detects Electron and WebView shells from Chrome widget classes', () => {
      expect(handlers.detectAppTypeFromClassName('Chrome_WidgetWin_1')).toBe('electron_webview');
    });

    it('detects Electron and Chromium hosts from alternate browser class names', () => {
      expect(handlers.detectAppTypeFromClassName('cefBrowserWindow')).toBe('electron_webview');
      expect(handlers.detectAppTypeFromClassName('ElectronBrowserHost')).toBe('electron_webview');
    });

    it('detects Win32 desktop classes across the standard built-in controls', () => {
      for (const className of ['#32770', 'Button', 'Edit', 'ListBox', 'ComboBox', 'Static', 'SysListView32', 'SysTreeView32']) {
        expect(handlers.detectAppTypeFromClassName(className)).toBe('win32');
      }
    });

    it('does not misclassify WinForms shell class names as a first-slice app type', () => {
      expect(handlers.detectAppTypeFromClassName('WindowsForms10.Window.8.app.0.2bf8098_r9_ad1')).toBeNull();
    });

    it('does not misclassify Qt shell class names as a first-slice app type', () => {
      expect(handlers.detectAppTypeFromClassName('Qt5152QWindowIcon')).toBeNull();
      expect(handlers.detectAppTypeFromClassName('QWidget')).toBeNull();
    });

    it('returns null for missing or unknown class names', () => {
      expect(handlers.detectAppTypeFromClassName('CustomWidgetHost')).toBeNull();
      expect(handlers.detectAppTypeFromClassName('')).toBeNull();
      expect(handlers.detectAppTypeFromClassName(null)).toBeNull();
      expect(handlers.detectAppTypeFromClassName(undefined)).toBeNull();
    });
  });

  describe('handlePeekOnboardDetect', () => {
    it('returns host resolution errors directly', async () => {
      const hostError = makeError(ErrorCodes.INVALID_PARAM, 'Peek host not found: omen');
      mocks.peekShared.resolvePeekHost.mockReturnValue({ error: hostError });
      handlers = loadHandlers();

      const result = await handlers.handlePeekOnboardDetect({ host: 'omen' });

      expect(result).toBe(hostError);
      expect(mocks.peekShared.peekHttpGetWithRetry).not.toHaveBeenCalled();
    });

    it('requires either process or title after trimming whitespace', async () => {
      const result = await handlers.handlePeekOnboardDetect({
        process: '   ',
        title: '\n\t',
      });

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'Either process or title is required');
      expect(mocks.peekShared.peekHttpGetWithRetry).not.toHaveBeenCalled();
    });

    it('queries the host by process name with an encoded process selector and custom timeout', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        data: {
          windows: [],
        },
      });

      await handlers.handlePeekOnboardDetect({
        process: '  Ledger Pro.exe  ',
        timeout_seconds: '7',
      });

      expect(mocks.peekShared.peekHttpGetWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/windows?process=Ledger%20Pro.exe',
        7000,
      );
    });

    it('queries the host by title with the default timeout when no positive timeout is supplied', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        data: [],
      });

      await handlers.handlePeekOnboardDetect({
        title: 'Main / Window',
        timeout_seconds: 0,
      });

      expect(mocks.peekShared.peekHttpGetWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/windows?title=Main%20%2F%20Window',
        15000,
      );
    });

    it('prefers the process selector when both process and title are provided', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        data: {
          windows: [],
        },
      });

      await handlers.handlePeekOnboardDetect({
        process: 'desk.exe',
        title: 'Desk App',
      });

      expect(mocks.peekShared.peekHttpGetWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/windows?process=desk.exe',
        15000,
      );
    });

    it('wraps transport rejections from the peek host query', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockRejectedValue(new Error('socket closed'));

      const result = await handlers.handlePeekOnboardDetect({ process: 'desk.exe' });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'Failed to query peek host: socket closed');
    });

    it('wraps explicit host error payloads from the peek host query', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        error: 'backend unavailable',
      });

      const result = await handlers.handlePeekOnboardDetect({ title: 'Desk App' });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'Peek host error: backend unavailable');
    });

    it('returns an actionable not-found response when no process windows match', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        data: {
          windows: [],
        },
      });

      const result = await handlers.handlePeekOnboardDetect({ process: 'missing.exe' });

      expect(result).toEqual({
        success: false,
        detected: false,
        message: "No windows found matching process 'missing.exe'.",
        suggestion: 'Ensure the application is running on the peek host, then retry.',
      });
    });

    it('returns an actionable not-found response for title-only queries and direct array payloads', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        data: [],
      });

      const result = await handlers.handlePeekOnboardDetect({ title: 'Missing Window' });

      expect(result).toEqual({
        success: false,
        detected: false,
        message: "No windows found matching title 'Missing Window'.",
        suggestion: 'Ensure the application is running on the peek host, then retry.',
      });
    });

    it('detects WPF windows and returns the WPF capability catalog', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        data: {
          windows: [{
            title: 'LedgerPro - Quarter Close',
            process_name: 'LedgerPro.Desktop.exe',
            class_name: 'HwndWrapper[LedgerPro.Desktop;;shell]',
            hwnd: 1056820,
          }],
        },
      });

      const result = await handlers.handlePeekOnboardDetect({ process: 'LedgerPro.Desktop' });

      expect(result).toMatchObject({
        success: true,
        detected: true,
        app_type: 'wpf',
        window: {
          title: 'LedgerPro - Quarter Close',
          process: 'LedgerPro.Desktop.exe',
          class_name: 'HwndWrapper[LedgerPro.Desktop;;shell]',
          hwnd: 1056820,
        },
        catalog: {
          label: 'WPF (Windows Presentation Foundation)',
          framework: 'WPF / .NET',
          capabilities: {
            automation_id: true,
            devtools_protocol: false,
          },
          recommended_options: {
            element_depth: 5,
          },
        },
      });
      expect(result.next_step).toContain(`${PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME} with process 'LedgerPro.Desktop.exe'`);
      expect(result.catalog.capabilities).not.toBe(handlers.APP_TYPE_CATALOG.wpf.capabilities);
      expect(result.catalog.recommended_options).not.toBe(handlers.APP_TYPE_CATALOG.wpf.recommended_options);
    });

    it('detects Win32 windows from a top-level array payload and uses fallbacks for title and process', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        data: [{
          window_title: 'Native Preferences',
          class_name: '#32770',
          hwnd: 42,
        }],
      });

      const result = await handlers.handlePeekOnboardDetect({ process: 'native-app.exe' });

      expect(result).toMatchObject({
        success: true,
        detected: true,
        app_type: 'win32',
        window: {
          title: 'Native Preferences',
          process: 'native-app.exe',
          class_name: '#32770',
          hwnd: 42,
        },
        catalog: {
          framework: 'Win32 / MFC / ATL',
          capabilities: {
            automation_id: false,
            measurements: true,
          },
          recommended_options: {
            element_depth: 4,
          },
        },
      });
      expect(result.next_step).toContain(`${PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME} with process 'native-app.exe'`);
    });

    it('detects Electron and Chromium windows and reports browser-specific capabilities', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        data: {
          windows: [{
            title: 'Contoso Ops',
            process_name: 'contoso-shell.exe',
            class_name: 'CefBrowserWindow',
            hwnd: 2048,
          }],
        },
      });

      const result = await handlers.handlePeekOnboardDetect({ title: 'Contoso Ops' });

      expect(result).toMatchObject({
        success: true,
        detected: true,
        app_type: 'electron_webview',
        catalog: {
          framework: 'Chromium-based (Electron, WebView2, CEF)',
          capabilities: {
            devtools_protocol: true,
            dom_snapshot: true,
          },
          recommended_options: {
            element_depth: 6,
          },
        },
      });
      expect(result.next_step).toContain(`${PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME} with process 'contoso-shell.exe'`);
    });

    it('returns unknown for unsupported WinForms windows while still echoing the matched window metadata', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        data: {
          windows: [{
            title: 'Legacy Admin',
            process_name: 'legacy-admin.exe',
            class_name: 'WindowsForms10.Window.8.app.0.2bf8098_r9_ad1',
            hwnd: 77,
          }],
        },
      });

      const result = await handlers.handlePeekOnboardDetect({ process: 'legacy-admin.exe' });

      expect(result).toEqual({
        success: true,
        detected: false,
        window: {
          title: 'Legacy Admin',
          process: 'legacy-admin.exe',
          class_name: 'WindowsForms10.Window.8.app.0.2bf8098_r9_ad1',
          hwnd: 77,
        },
        app_type: 'unknown',
        catalog: null,
        next_step: 'App type could not be auto-detected. Run peek_diagnose anyway — the peek server will classify the app type from the capture.',
      });
    });

    it('returns unknown for unsupported Qt windows', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        data: {
          windows: [{
            title: 'Qt Control Center',
            process_name: 'qt-center.exe',
            class_name: 'Qt5152QWindowIcon',
            hwnd: 88,
          }],
        },
      });

      const result = await handlers.handlePeekOnboardDetect({ title: 'Qt Control Center' });

      expect(result.detected).toBe(false);
      expect(result.app_type).toBe('unknown');
      expect(result.catalog).toBeNull();
      expect(result.window.class_name).toBe('Qt5152QWindowIcon');
    });

    it('normalizes missing class names and hwnd values when detection is not possible', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        data: {
          windows: [{
            window_title: 'Custom Shell',
            process_name: 'custom-shell.exe',
            class_name: 1234,
          }],
        },
      });

      const result = await handlers.handlePeekOnboardDetect({ process: 'custom-shell.exe' });

      expect(result).toEqual({
        success: true,
        detected: false,
        window: {
          title: 'Custom Shell',
          process: 'custom-shell.exe',
          class_name: '',
          hwnd: null,
        },
        app_type: 'unknown',
        catalog: null,
        next_step: 'App type could not be auto-detected. Run peek_diagnose anyway — the peek server will classify the app type from the capture.',
      });
    });

    it('uses the first matching window when the host returns multiple candidates', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValue({
        data: {
          windows: [
            {
              title: 'First Window',
              process_name: 'first.exe',
              class_name: '#32770',
              hwnd: 1,
            },
            {
              title: 'Second Window',
              process_name: 'second.exe',
              class_name: 'Chrome_WidgetWin_1',
              hwnd: 2,
            },
          ],
        },
      });

      const result = await handlers.handlePeekOnboardDetect({ process: 'ignored.exe' });

      expect(result.window).toEqual({
        title: 'First Window',
        process: 'first.exe',
        class_name: '#32770',
        hwnd: 1,
      });
      expect(result.app_type).toBe('win32');
    });

    it('logs and returns an internal error when host resolution throws unexpectedly', async () => {
      mocks.peekShared.resolvePeekHost.mockImplementation(() => {
        throw new Error('resolution exploded');
      });
      handlers = loadHandlers();

      const result = await handlers.handlePeekOnboardDetect({ process: 'desk.exe' });

      expectError(result, ErrorCodes.INTERNAL_ERROR.code, 'resolution exploded');
      expect(mocks.loggerInstance.warn).toHaveBeenCalledWith('Onboard detect failed: resolution exploded');
    });
  });
});
