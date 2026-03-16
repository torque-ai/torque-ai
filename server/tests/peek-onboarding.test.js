'use strict';

const http = require('http');
const { EventEmitter } = require('events');

const {
  APP_TYPE_CATALOG,
  detectAppTypeFromClassName,
  handlePeekOnboard,
  handlePeekOnboardDetect,
} = require('../handlers/peek/onboarding');
const database = require('../database');

function createHttpGetMock(queue) {
  return (_url, _options, cb) => {
    // http.get can be called as (url, cb) or (url, options, cb)
    if (typeof _options === 'function') {
      cb = _options;
    }
    const next = queue.shift() || {};
    const req = new EventEmitter();
    req.destroy = vi.fn();
    process.nextTick(() => {
      if (next.error) {
        req.emit('error', new Error(next.error));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = next.statusCode ?? 200;
      cb(res);
      if (next.body !== undefined) {
        const payload = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
        res.emit('data', Buffer.from(payload));
      }
      res.emit('end');
    });
    return req;
  };
}

describe('peek onboarding', () => {
  let requestQueue;

  beforeEach(() => {
    requestQueue = [];
    vi.spyOn(database, 'getDefaultPeekHost').mockReturnValue({
      name: 'omen',
      url: 'http://omen:9876',
    });
    vi.spyOn(http, 'get').mockImplementation(createHttpGetMock(requestQueue));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('APP_TYPE_CATALOG', () => {
    it('covers all three first-slice app types', () => {
      expect(Object.keys(APP_TYPE_CATALOG).sort()).toEqual(['electron_webview', 'win32', 'wpf']);
    });

    it('each type has required fields', () => {
      for (const [_key, spec] of Object.entries(APP_TYPE_CATALOG)) {
        expect(spec.label).toBeTruthy();
        expect(spec.framework).toBeTruthy();
        expect(spec.detection_hint).toBeTruthy();
        expect(spec.capabilities).toBeDefined();
        expect(spec.capabilities.screenshot).toBe(true);
        expect(spec.recommended_options).toBeDefined();
        expect(spec.notes).toBeTruthy();
      }
    });

    it('wpf has automation_id but no devtools', () => {
      expect(APP_TYPE_CATALOG.wpf.capabilities.automation_id).toBe(true);
      expect(APP_TYPE_CATALOG.wpf.capabilities.devtools_protocol).toBe(false);
    });

    it('electron has devtools and dom_snapshot', () => {
      expect(APP_TYPE_CATALOG.electron_webview.capabilities.devtools_protocol).toBe(true);
      expect(APP_TYPE_CATALOG.electron_webview.capabilities.dom_snapshot).toBe(true);
    });
  });

  describe('detectAppTypeFromClassName', () => {
    it('detects WPF from HwndWrapper class name', () => {
      expect(detectAppTypeFromClassName('HwndWrapper[App.Desktop;;app-shell]')).toBe('wpf');
    });

    it('detects Electron from Chrome_WidgetWin_1', () => {
      expect(detectAppTypeFromClassName('Chrome_WidgetWin_1')).toBe('electron_webview');
    });

    it('detects Win32 from standard class names', () => {
      expect(detectAppTypeFromClassName('#32770')).toBe('win32');
      expect(detectAppTypeFromClassName('Button')).toBe('win32');
      expect(detectAppTypeFromClassName('Edit')).toBe('win32');
      expect(detectAppTypeFromClassName('SysListView32')).toBe('win32');
    });

    it('returns null for unknown class names', () => {
      expect(detectAppTypeFromClassName('CustomWidget')).toBeNull();
      expect(detectAppTypeFromClassName('')).toBeNull();
      expect(detectAppTypeFromClassName(null)).toBeNull();
    });
  });

  describe('handlePeekOnboard', () => {
    it('returns all app types when no filter', () => {
      const result = handlePeekOnboard();
      expect(result.success).toBe(true);
      expect(result.app_types.length).toBe(3);
      expect(result.canonical_tool).toBe('peek_diagnose');
      expect(result.onboarding_steps.length).toBeGreaterThanOrEqual(4);
    });

    it('filters to a specific app type', () => {
      const result = handlePeekOnboard({ app_type: 'wpf' });
      expect(result.success).toBe(true);
      expect(result.app_types.length).toBe(1);
      expect(result.app_types[0].app_type).toBe('wpf');
      expect(result.app_types[0].capabilities.automation_id).toBe(true);
    });

    it('rejects unknown app type', () => {
      const result = handlePeekOnboard({ app_type: 'flutter' });
      expect(result.isError).toBe(true);
    });

    it('includes supported platforms', () => {
      const result = handlePeekOnboard();
      expect(result.supported_platforms).toContain('windows');
    });
  });

  describe('handlePeekOnboardDetect', () => {
    it('detects WPF app type from window class name', async () => {
      requestQueue.push({
        body: {
          windows: [{
            title: 'LedgerPro - Quarter Close',
            process_name: 'LedgerPro.Desktop.exe',
            class_name: 'HwndWrapper[LedgerPro.Desktop;;ledgerpro-shell]',
            hwnd: 1056820,
          }],
        },
      });

      const result = await handlePeekOnboardDetect({ process: 'LedgerPro.Desktop' });
      expect(result.success).toBe(true);
      expect(result.detected).toBe(true);
      expect(result.app_type).toBe('wpf');
      expect(result.catalog).toBeTruthy();
      expect(result.catalog.label).toContain('WPF');
      expect(result.next_step).toContain('peek_diagnose');
    });

    it('detects Electron app type', async () => {
      requestQueue.push({
        body: {
          windows: [{
            title: 'Contoso Ops',
            process_name: 'contoso-ops.exe',
            class_name: 'Chrome_WidgetWin_1',
            hwnd: 2048,
          }],
        },
      });

      const result = await handlePeekOnboardDetect({ process: 'contoso-ops' });
      expect(result.success).toBe(true);
      expect(result.detected).toBe(true);
      expect(result.app_type).toBe('electron_webview');
    });

    it('returns unknown for unrecognized class names', async () => {
      requestQueue.push({
        body: {
          windows: [{
            title: 'Custom App',
            process_name: 'custom.exe',
            class_name: 'MyCustomWindow',
            hwnd: 3072,
          }],
        },
      });

      const result = await handlePeekOnboardDetect({ process: 'custom' });
      expect(result.success).toBe(true);
      expect(result.detected).toBe(false);
      expect(result.app_type).toBe('unknown');
      expect(result.catalog).toBeNull();
      expect(result.next_step).toContain('peek_diagnose');
    });

    it('returns not found when no windows match', async () => {
      requestQueue.push({
        body: { windows: [] },
      });

      const result = await handlePeekOnboardDetect({ process: 'nonexistent' });
      expect(result.success).toBe(false);
      expect(result.detected).toBe(false);
    });

    it('requires process or title', async () => {
      const result = await handlePeekOnboardDetect({});
      expect(result.isError).toBe(true);
    });

    it('handles peek host errors gracefully', async () => {
      requestQueue.push({ error: 'Connection refused' });

      const result = await handlePeekOnboardDetect({ process: 'test' });
      expect(result.isError).toBe(true);
    });
  });
});
