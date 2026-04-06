'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockShared = {
  escapeXml: vi.fn(),
  formatBytes: vi.fn(),
  getPeekTargetKey: vi.fn(),
  peekHttpGetUrl: vi.fn(),
  peekHttpGetWithRetry: vi.fn(),
  peekHttpPostWithRetry: vi.fn(),
  postCompareWithRetry: vi.fn(),
  resolvePeekHost: vi.fn(),
};

const mockLoggerInstance = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockLogger = {
  child: vi.fn(() => mockLoggerInstance),
};

const mockChildProcess = {
  execFileSync: vi.fn(),
};

const mockTesseractWorker = {
  recognize: vi.fn(),
};

const mockTesseract = {
  createWorker: vi.fn(async () => mockTesseractWorker),
};

const sharpState = {
  metadata: { width: 640, height: 480 },
  outputBuffer: Buffer.from('annotated-image'),
};

const sharpCalls = [];
const mockSharp = vi.fn((input) => {
  const record = { input };
  const compositeResult = {
    toBuffer: vi.fn().mockResolvedValue(sharpState.outputBuffer),
  };
  const instance = {
    metadata: vi.fn().mockResolvedValue(sharpState.metadata),
    composite: vi.fn((layers) => {
      record.layers = layers;
      return compositeResult;
    }),
  };

  record.instance = instance;
  record.compositeResult = compositeResult;
  sharpCalls.push(record);
  return instance;
});

const sharedModule = require('../plugins/snapscope/handlers/shared');
const loggerModule = require('../logger');
const childProcessModule = require('child_process');
const tesseractModule = require('tesseract.js');
const sharpModulePath = require.resolve('sharp');

const originalShared = {
  escapeXml: sharedModule.escapeXml,
  formatBytes: sharedModule.formatBytes,
  getPeekTargetKey: sharedModule.getPeekTargetKey,
  peekHttpGetUrl: sharedModule.peekHttpGetUrl,
  peekHttpGetWithRetry: sharedModule.peekHttpGetWithRetry,
  peekHttpPostWithRetry: sharedModule.peekHttpPostWithRetry,
  postCompareWithRetry: sharedModule.postCompareWithRetry,
  resolvePeekHost: sharedModule.resolvePeekHost,
};
const originalLoggerChild = loggerModule.child;
const originalExecFileSync = childProcessModule.execFileSync;
const originalCreateWorker = tesseractModule.createWorker;
const originalSharpCacheEntry = require.cache[sharpModulePath];

let capture;
let tempHome;
let homedirSpy;
let tmpdirSpy;

function sanitizeTargetKey(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function loadCapture() {
  delete require.cache[require.resolve('../plugins/snapscope/handlers/capture')];
  return require('../plugins/snapscope/handlers/capture');
}

function createPeekCaptureData(overrides = {}) {
  return {
    image: Buffer.from('peek-image').toString('base64'),
    format: 'png',
    mime_type: 'image/png',
    mode: 'process',
    process: 'chrome.exe',
    title: 'Docs',
    width: 1280,
    height: 720,
    size_bytes: 9,
    ...overrides,
  };
}

function getTextBlocks(result) {
  return (result.content || [])
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text);
}

function getImages(result) {
  return (result.content || []).filter((entry) => entry.type === 'image');
}

describe('peek capture handlers', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    sharpCalls.length = 0;
    sharpState.metadata = { width: 640, height: 480 };
    sharpState.outputBuffer = Buffer.from('annotated-image');

    tempHome = fs.mkdtempSync(path.join(process.cwd(), 'tmp-peek-capture-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(tempHome);

    mockShared.escapeXml.mockImplementation((value) => String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'));
    mockShared.formatBytes.mockImplementation((bytes) => `${bytes} bytes`);
    mockShared.getPeekTargetKey.mockImplementation((args, peekData = {}) => {
      if (args.process) {
        return sanitizeTargetKey(`process-${peekData.process || args.process}`, 'process');
      }
      if (args.title) {
        return sanitizeTargetKey(`title-${peekData.title || args.title}`, 'title');
      }
      return 'screen';
    });
    mockShared.peekHttpGetUrl.mockImplementation(async (url) => {
      if (String(url).endsWith('/health')) {
        return { data: { ok: true } };
      }
      if (String(url).endsWith('/list')) {
        return { data: { windows: [] } };
      }
      return { data: {} };
    });
    mockShared.peekHttpGetWithRetry.mockResolvedValue({ data: {} });
    mockShared.peekHttpPostWithRetry.mockResolvedValue({ data: { success: true } });
    mockShared.postCompareWithRetry.mockResolvedValue({ data: {} });
    mockShared.resolvePeekHost.mockReturnValue({
      hostName: 'peek-host',
      hostUrl: 'http://peek-host:9876',
      ssh: null,
      platform: 'linux',
    });

    mockChildProcess.execFileSync.mockReturnValue('ok');
    mockTesseract.createWorker.mockResolvedValue(mockTesseractWorker);
    mockTesseractWorker.recognize.mockResolvedValue({
      data: { text: 'Detected text' },
    });

    sharedModule.escapeXml = mockShared.escapeXml;
    sharedModule.formatBytes = mockShared.formatBytes;
    sharedModule.getPeekTargetKey = mockShared.getPeekTargetKey;
    sharedModule.peekHttpGetUrl = mockShared.peekHttpGetUrl;
    sharedModule.peekHttpGetWithRetry = mockShared.peekHttpGetWithRetry;
    sharedModule.peekHttpPostWithRetry = mockShared.peekHttpPostWithRetry;
    sharedModule.postCompareWithRetry = mockShared.postCompareWithRetry;
    sharedModule.resolvePeekHost = mockShared.resolvePeekHost;
    loggerModule.child = mockLogger.child;
    childProcessModule.execFileSync = mockChildProcess.execFileSync;
    tesseractModule.createWorker = mockTesseract.createWorker;
    require.cache[sharpModulePath] = {
      id: sharpModulePath,
      filename: sharpModulePath,
      loaded: true,
      exports: mockSharp,
    };

    capture = loadCapture();
  });

  afterEach(() => {
    vi.useRealTimers();
    homedirSpy.mockRestore();
    tmpdirSpy.mockRestore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  afterAll(() => {
    sharedModule.escapeXml = originalShared.escapeXml;
    sharedModule.formatBytes = originalShared.formatBytes;
    sharedModule.getPeekTargetKey = originalShared.getPeekTargetKey;
    sharedModule.peekHttpGetUrl = originalShared.peekHttpGetUrl;
    sharedModule.peekHttpGetWithRetry = originalShared.peekHttpGetWithRetry;
    sharedModule.peekHttpPostWithRetry = originalShared.peekHttpPostWithRetry;
    sharedModule.postCompareWithRetry = originalShared.postCompareWithRetry;
    sharedModule.resolvePeekHost = originalShared.resolvePeekHost;
    loggerModule.child = originalLoggerChild;
    childProcessModule.execFileSync = originalExecFileSync;
    tesseractModule.createWorker = originalCreateWorker;
    if (originalSharpCacheEntry) {
      require.cache[sharpModulePath] = originalSharpCacheEntry;
    } else {
      delete require.cache[sharpModulePath];
    }
  });

  describe('helpers', () => {
    it('loadRegions returns an empty object for missing or invalid files', () => {
      expect(capture.loadRegions('screen')).toEqual({});

      const regionsPath = capture.getRegionsPath('screen');
      fs.mkdirSync(path.dirname(regionsPath), { recursive: true });
      fs.writeFileSync(regionsPath, '{bad json');

      expect(capture.loadRegions('screen')).toEqual({});
    });

    it('saveRegion writes normalized coordinates and resolveRegion reads them back', () => {
      capture.saveRegion('process-chrome-exe', 'toolbar', {
        name: 'toolbar',
        x: 10,
        y: 20,
        w: 300,
        h: 40,
        ignored: true,
      });

      const regionsPath = capture.getRegionsPath('process-chrome-exe');
      expect(JSON.parse(fs.readFileSync(regionsPath, 'utf8'))).toEqual({
        toolbar: { x: 10, y: 20, w: 300, h: 40 },
      });
      expect(capture.resolveRegion('process-chrome-exe', 'toolbar')).toEqual({
        x: 10,
        y: 20,
        w: 300,
        h: 40,
      });
    });

    it('buildCompareSummary formats compare metadata into markdown lines', () => {
      expect(capture.buildCompareSummary({
        summary: '  layout changed  ',
        changed_pixels: 42,
        diff_percent: 0.125,
        threshold: 0.1,
        passed: false,
      }, 'baseline:docs')).toEqual([
        '**Diff Source:** baseline:docs',
        '**Diff Summary:** layout changed',
        '**Changed Pixels:** 42',
        '**Diff Percent:** 12.50%',
        '**Threshold:** 10.00%',
        '**Within Threshold:** No',
      ]);
    });

    it('getCompareImage selects a compare image when present and returns null otherwise', () => {
      expect(capture.getCompareImage({
        diff_image: 'diff-b64',
        diff_mime_type: 'image/webp',
      })).toEqual({
        data: 'diff-b64',
        mimeType: 'image/webp',
      });
      expect(capture.getCompareImage({ summary: 'no image' })).toBeNull();
    });
  });

  describe('handlePeekUi', () => {
    it('lists remote desktop windows', async () => {
      mockShared.peekHttpGetUrl
        .mockResolvedValueOnce({ data: { ok: true } })
        .mockResolvedValueOnce({
          data: {
            windows: [
              { process: 'chrome.exe', title: 'Docs' },
              { process: 'code.exe', title: 'Torque' },
            ],
          },
        });

      const result = await capture.handlePeekUi({ list_windows: true });
      const text = getTextBlocks(result).join('\n');

      expect(text).toContain('| chrome.exe | Docs |');
      expect(text).toContain('| code.exe | Torque |');
      expect(text).toContain('**Host:** peek-host');
      expect(mockShared.peekHttpGetUrl).toHaveBeenNthCalledWith(2, 'http://peek-host:9876/list', 30000);
    });

    it('tries to auto-start the peek server over SSH before returning a host-down error', async () => {
      vi.useFakeTimers();
      mockShared.resolvePeekHost.mockReturnValue({
        hostName: 'ssh-host',
        hostUrl: 'http://ssh-host:9876',
        ssh: 'dev@ssh-host',
        platform: 'linux',
      });
      mockShared.peekHttpGetUrl
        .mockResolvedValueOnce({ error: 'ECONNREFUSED' })
        .mockResolvedValueOnce({ error: 'ECONNREFUSED' });

      const promise = capture.handlePeekUi({});
      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(mockChildProcess.execFileSync).toHaveBeenCalledWith(
        'ssh',
        ['dev@ssh-host', 'nohup peek-server --port 9876 > /dev/null 2>&1 &'],
        expect.objectContaining({ timeout: 10000, stdio: 'ignore' }),
      );
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getTextBlocks(result).join('\n')).toContain('Cannot reach peek_server on ssh-host');
    });

    it('captures an image, compares against a baseline, and records OCR and region output', async () => {
      const baselineRoot = path.join(tempHome, '.peek-ui', 'baselines', 'default');
      const baselineBytes = Buffer.from('baseline-image');
      const currentBytes = Buffer.from('fresh-image');
      const diffBytes = Buffer.from('diff-image');
      const savePath = path.join(tempHome, 'captures', 'capture.png');

      fs.mkdirSync(baselineRoot, { recursive: true });
      fs.writeFileSync(path.join(baselineRoot, 'golden.png'), baselineBytes);

      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData({
          image: currentBytes.toString('base64'),
          annotated_image: Buffer.from('server-annotated').toString('base64'),
          annotated_mime_type: 'image/png',
        }),
      });
      mockShared.postCompareWithRetry.mockResolvedValueOnce({
        data: {
          summary: 'Significant change',
          changed_pixels: 25,
          diff_percent: 0.04,
          threshold: 0.05,
          passed: true,
          diff_image: diffBytes.toString('base64'),
          diff_mime_type: 'image/png',
        },
      });
      mockTesseractWorker.recognize.mockResolvedValueOnce({
        data: { text: 'Docs loaded successfully' },
      });

      const result = await capture.handlePeekUi({
        process: 'chrome.exe',
        save_path: savePath,
        diff_baseline: 'golden',
        save_baseline: 'golden-new',
        save_region: { name: 'toolbar', x: 1, y: 2, w: 3, h: 4 },
        ocr: true,
        ocr_assert: 'loaded',
      });

      const text = getTextBlocks(result).join('\n');
      expect(getImages(result)).toHaveLength(3);
      expect(text).toContain('**Baseline Saved:** golden-new');
      expect(text).toContain('**Region Saved:** toolbar (1,2,3,4)');
      expect(text).toContain('**Diff Source:** baseline:golden');
      expect(text).toContain('**OCR Assert:** "loaded" → PASS');
      expect(mockShared.postCompareWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876',
        baselineBytes.toString('base64'),
        currentBytes.toString('base64'),
        0.01,
        30000,
      );
      expect(fs.existsSync(savePath)).toBe(true);
      expect(fs.existsSync(path.join(baselineRoot, 'golden-new.png'))).toBe(true);
      expect(fs.existsSync(path.join(tempHome, '.peek-ui', 'last', 'default', 'process-chrome-exe.png'))).toBe(true);
      expect(capture.resolveRegion('process-chrome-exe', 'toolbar')).toEqual({
        x: 1,
        y: 2,
        w: 3,
        h: 4,
      });
    });

    it('rejects a named region that has not been saved', async () => {
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });

      const result = await capture.handlePeekUi({
        process: 'chrome.exe',
        region: 'toolbar',
      });

      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('Named region not found: "toolbar"');
      expect(mockShared.peekHttpGetWithRetry).not.toHaveBeenCalled();
    });
  });

  describe('handlePeekInteract', () => {
    it('clicks an element and optionally captures the result', async () => {
      mockShared.peekHttpPostWithRetry
        .mockResolvedValueOnce({
          data: {
            center: { x: 12, y: 34 },
            name: 'Save',
            type: 'button',
          },
        })
        .mockResolvedValueOnce({ data: { success: true } });
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData(),
      });

      const result = await capture.handlePeekInteract({
        action: 'click',
        process: 'chrome.exe',
        element: 'Save',
        wait_after: 0,
        capture_after: true,
      });

      const text = getTextBlocks(result).join('\n');
      expect(text).toContain('## peek_interact: click');
      expect(text).toContain('**Coords:** (12, 34)');
      expect(mockShared.peekHttpPostWithRetry).toHaveBeenNthCalledWith(
        1,
        'http://peek-host:9876/elements',
        { mode: 'process', name: 'chrome.exe', find: 'Save' },
        15000,
      );
      expect(mockShared.peekHttpPostWithRetry).toHaveBeenNthCalledWith(
        2,
        'http://peek-host:9876/click',
        {
          mode: 'process',
          name: 'chrome.exe',
          x: 12,
          y: 34,
          button: 'left',
          double: false,
        },
        15000,
      );
      expect(getImages(result)).toHaveLength(1);
    });

    it('requires an action name', async () => {
      const result = await capture.handlePeekInteract({});

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('action is required');
    });

    it('times out while waiting for an element that never appears', async () => {
      vi.useFakeTimers();
      mockShared.peekHttpPostWithRetry.mockResolvedValue({ data: {} });

      const promise = capture.handlePeekInteract({
        action: 'wait_for_element',
        element: 'Missing Button',
        wait_timeout: 1000,
        poll_interval: 250,
      });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(getTextBlocks(result).join('\n')).toContain('Timed out waiting for element: Missing Button (1000ms)');
    });
  });

  describe('handlePeekLaunch', () => {
    it('launches a remote process and reports process details', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          success: true,
          pid: 321,
          hwnd: 456,
          title: 'Torque UI',
        },
      });

      const result = await capture.handlePeekLaunch({
        path: 'C:\\Apps\\Torque.exe',
        args: ['--dev'],
        build: true,
        timeout: 20,
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/process',
        {
          action: 'build_and_launch',
          path: 'C:\\Apps\\Torque.exe',
          args: ['--dev'],
          wait_for_window: true,
          timeout: 20,
        },
        30000,
      );
      expect(getTextBlocks(result).join('\n')).toContain('**PID:** 321');
      expect(getTextBlocks(result).join('\n')).toContain('**Status:** OK');
    });

    it('requires an executable path', async () => {
      const result = await capture.handlePeekLaunch({});

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('path is required');
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });
  });

  describe('handlePeekDiscover', () => {
    it('lists discovered projects and launchable paths', async () => {
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: {
          projects: [
            { name: 'DeskApp', type: 'electron', executable: '/home/<user>/DeskApp/dist/DeskApp.exe' },
            { name: 'WebApp', type: 'vite', path: '/home/<user>/WebApp' },
          ],
        },
      });

      const result = await capture.handlePeekDiscover({});
      const text = getTextBlocks(result).join('\n');

      expect(text).toContain('| DeskApp | electron | DeskApp.exe |');
      expect(text).toContain('- **DeskApp:** `/home/<user>/DeskApp/dist/DeskApp.exe`');
      expect(text).toContain('- **WebApp:** `/home/<user>/WebApp` _(use build: true)_');
    });

    it('returns an internal error when discovery fails', async () => {
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({ error: 'service unavailable' });

      const result = await capture.handlePeekDiscover({});

      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(getTextBlocks(result).join('\n')).toContain('Discovery failed: service unavailable');
    });
  });

  describe('handlePeekOpenUrl', () => {
    it('opens a URL on the remote host', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });

      const result = await capture.handlePeekOpenUrl({
        url: 'https://example.com/docs',
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/open-url',
        { url: 'https://example.com/docs' },
        10000,
      );
      expect(getTextBlocks(result).join('\n')).toContain('Opened **https://example.com/docs** in default browser on **peek-host**');
    });

    it('rejects URLs that do not use http or https', async () => {
      const result = await capture.handlePeekOpenUrl({
        url: 'file:///tmp/index.html',
      });

      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('url must start with http:// or https://');
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });
  });

  describe('handlePeekSnapshot', () => {
    it('lists snapshots on the remote host', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          count: 2,
          snapshots: [
            { label: 'baseline', element_count: 12, age_seconds: 8 },
            { label: 'after-login', element_count: 15, age_seconds: 3 },
          ],
        },
      });

      const result = await capture.handlePeekSnapshot({ action: 'list' });
      const text = getTextBlocks(result).join('\n');

      expect(text).toContain('## Snapshots on peek-host');
      expect(text).toContain('- **baseline**: 12 elements, 8s ago');
      expect(text).toContain('- **after-login**: 15 elements, 3s ago');
    });

    it('saves a snapshot for the target window', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          element_count: 18,
          snapshot_count: 4,
        },
      });

      const result = await capture.handlePeekSnapshot({
        label: 'baseline',
        process: 'chrome.exe',
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/snapshot',
        {
          action: 'save',
          label: 'baseline',
          mode: 'process',
          name: 'chrome.exe',
        },
        15000,
      );
      expect(getTextBlocks(result).join('\n')).toContain('Snapshot **"baseline"** saved on peek-host (18 elements, 4 total snapshots).');
    });

    it('renders a diff summary for a saved snapshot', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          baseline_count: 10,
          current_count: 12,
          has_changes: true,
          added: [{ name: 'Save' }],
          removed: [{ type: 'button' }],
          moved: [{ name: 'Panel' }],
          resized: [{ name: 'Editor' }],
          text_changed: [{ name: 'Title' }],
        },
      });

      const result = await capture.handlePeekSnapshot({
        action: 'diff',
        label: 'baseline',
        process: 'chrome.exe',
        depth: 2,
      });

      const text = getTextBlocks(result).join('\n');
      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/snapshot',
        {
          action: 'diff',
          label: 'baseline',
          mode: 'process',
          name: 'chrome.exe',
          depth: 2,
        },
        15000,
      );
      expect(text).toContain('**Added (1):** Save');
      expect(text).toContain('**Removed (1):** button');
      expect(text).toContain('**Moved (1):** Panel');
      expect(text).toContain('**Resized (1):** Editor');
      expect(text).toContain('**Text Changed (1):** Title');
    });

    it('requires a label for save and diff actions', async () => {
      const result = await capture.handlePeekSnapshot({
        action: 'diff',
        process: 'chrome.exe',
      });

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('label is required for save/diff');
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });
  });

  describe('handlePeekRefresh', () => {
    it('detects a browser window and sends a hard refresh hotkey', async () => {
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({
        data: {
          windows: [
            { process: 'notes.exe', title: 'Scratch' },
            { process: 'chrome.exe', title: 'Docs' },
          ],
        },
      });
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });

      const result = await capture.handlePeekRefresh({ hard: true });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/hotkey',
        {
          keys: 'Ctrl+Shift+R',
          mode: 'process',
          name: 'chrome.exe',
        },
        10000,
      );
      expect(getTextBlocks(result).join('\n')).toContain('Sent Ctrl+Shift+R to chrome.exe on **peek-host**');
    });

    it('returns an operation error when refresh fails', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ error: 'permission denied' });

      const result = await capture.handlePeekRefresh({
        process: 'chrome.exe',
      });

      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getTextBlocks(result).join('\n')).toContain('Refresh failed: permission denied');
    });
  });

  describe('handlePeekBuildAndOpen', () => {
    it('builds locally, opens the URL remotely, and captures the browser window', async () => {
      mockChildProcess.execFileSync.mockReturnValueOnce('build complete');
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData(),
      });

      const result = await capture.handlePeekBuildAndOpen({
        url: 'https://example.com/app',
        build_command: 'npm run build',
        working_directory: 'C:\\repo\\app',
        wait_seconds: 0,
        capture_process: 'chrome.exe',
      });

      const text = getTextBlocks(result).join('\n');
      expect(mockChildProcess.execFileSync).toHaveBeenCalledWith(
        'npm',
        ['run', 'build'],
        expect.objectContaining({
          cwd: 'C:\\repo\\app',
          timeout: 60000,
          encoding: 'utf8',
          shell: true,
        }),
      );
      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/open-url',
        { url: 'https://example.com/app' },
        10000,
      );
      expect(mockShared.peekHttpGetWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/peek?mode=process&name=chrome.exe&format=jpeg&quality=80&max_width=1920',
        30000,
      );
      expect(getImages(result)).toHaveLength(1);
      expect(text).toContain('**Build Status:** OK');
      expect(text).toContain('**Opened:** https://example.com/app on peek-host');
      expect(text).toContain('**Captured:** 1280x720 (Docs)');
    });

    it('validates the URL before attempting to build or open it', async () => {
      const result = await capture.handlePeekBuildAndOpen({
        url: 'ftp://example.com/app',
      });

      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('url must start with http:// or https://');
      expect(mockChildProcess.execFileSync).not.toHaveBeenCalled();
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });

    it('returns build stderr when the local build step fails', async () => {
      const buildError = new Error('build exploded');
      buildError.stderr = 'build failed badly';
      mockChildProcess.execFileSync.mockImplementationOnce(() => {
        throw buildError;
      });

      const result = await capture.handlePeekBuildAndOpen({
        url: 'https://example.com/app',
        build_command: 'npm run build',
      });

      expect(getTextBlocks(result).join('\n')).toContain('**Build Status:** FAILED');
      expect(getTextBlocks(result).join('\n')).toContain('build failed badly');
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });

    it('reports host-resolution errors before attempting to open a URL', async () => {
      const hostError = { error_code: 'OPERATION_FAILED', text: 'peek host not configured' };
      mockShared.resolvePeekHost.mockReturnValue({ error: hostError });

      const result = await capture.handlePeekBuildAndOpen({
        url: 'https://example.com/app',
        build_command: 'npm run build',
      });

      expect(result).toEqual(hostError);
      // Build runs before host resolution, so execFileSync IS called
      expect(mockChildProcess.execFileSync).toHaveBeenCalledTimes(1);
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });

    it('opens successfully without a local build step', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });

      const result = await capture.handlePeekBuildAndOpen({
        url: 'https://example.com/app',
        capture: false,
      });

      const text = getTextBlocks(result).join('\n');
      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/open-url',
        { url: 'https://example.com/app' },
        10000,
      );
      expect(text).toContain('**Opened:** https://example.com/app on peek-host');
      expect(text).toContain('**Waited:** 3s for page load');
      expect(text).not.toContain('**Captured:**');
      expect(result.content.some((item) => item.type === 'image')).toBe(false);
    });
  });

  describe('handlePeekUi - edge cases', () => {
    it('defaults to full-screen capture when no target params are provided', async () => {
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData({ mode: 'screen', process: null }),
      });

      const result = await capture.handlePeekUi({});
      const text = getTextBlocks(result).join('\n');

      expect(mockShared.peekHttpGetWithRetry).toHaveBeenCalledWith(
        expect.stringContaining('/peek?mode=screen'),
        30000,
      );
      expect(text).toContain('## peek_ui capture');
      expect(text).toContain('**Target:** Full screen');
    });

    it('returns host-resolution errors without attempting capture', async () => {
      const hostError = { error_code: 'OPERATION_FAILED', text: 'cannot resolve host' };
      mockShared.resolvePeekHost.mockReturnValue({ error: hostError });

      const result = await capture.handlePeekUi({ process: 'chrome.exe' });

      expect(result).toEqual(hostError);
      expect(mockShared.peekHttpGetUrl).not.toHaveBeenCalled();
      expect(mockShared.peekHttpGetWithRetry).not.toHaveBeenCalled();
    });

    it('returns a timeout error when capture request times out', async () => {
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({ error: 'ETIMEDOUT' });

      const result = await capture.handlePeekUi({ process: 'chrome.exe' });

      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getTextBlocks(result).join('\n')).toContain('peek_ui capture failed: ETIMEDOUT');
    });

    it('supports diff against a named baseline using compare mode', async () => {
      const baselineRoot = path.join(tempHome, '.peek-ui', 'baselines', 'default');
      const baselineBytes = Buffer.from('baseline');
      const currentBytes = Buffer.from('current');

      fs.mkdirSync(baselineRoot, { recursive: true });
      fs.writeFileSync(path.join(baselineRoot, 'golden.png'), baselineBytes);
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData({
          process: 'chrome.exe',
          image: currentBytes.toString('base64'),
        }),
      });
      mockShared.postCompareWithRetry.mockResolvedValueOnce({
        data: {
          summary: 'Layout drift',
          changed_pixels: 12,
          diff_percent: 0.15,
          threshold: 0.05,
          passed: false,
          diff_image: Buffer.from('diff').toString('base64'),
          diff_mime_type: 'image/png',
        },
      });

      const result = await capture.handlePeekUi({
        process: 'chrome.exe',
        diff_baseline: 'golden',
      });

      const text = getTextBlocks(result).join('\n');
      expect(mockShared.postCompareWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876',
        baselineBytes.toString('base64'),
        currentBytes.toString('base64'),
        0.01,
        30000,
      );
      expect(text).toContain('**Diff Source:** baseline:golden');
      expect(text).toContain('**Diff Percent:** 15.00%');
      expect(text).toContain('**Within Threshold:** No');
    });

    it('performs OCR and OCR assertion during capture', async () => {
      mockTesseractWorker.recognize.mockResolvedValueOnce({
        data: { text: '  dashboard loaded  ' },
      });
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData({
          process: 'chrome.exe',
          image: Buffer.from('peek-image').toString('base64'),
        }),
      });

      const result = await capture.handlePeekUi({
        process: 'chrome.exe',
        ocr: true,
        ocr_assert: 'loaded',
      });

      const text = getTextBlocks(result).join('\n');
      expect(text).toContain('**OCR Text:** dashboard loaded');
      expect(text).toContain('**OCR Assert:** "loaded"');
      expect(text).toContain('PASS');
      expect(mockTesseractWorker.recognize).toHaveBeenCalledTimes(1);
    });
  });

  describe('handlePeekInteract', () => {
    it('clicks at explicit coordinates when provided', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });

      const result = await capture.handlePeekInteract({
        action: 'click',
        process: 'chrome.exe',
        x: 14,
        y: 27,
        button: 'right',
        double: true,
        wait_after: 0,
      });

      const text = getTextBlocks(result).join('\n');
      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/click',
        {
          mode: 'process',
          name: 'chrome.exe',
          x: 14,
          y: 27,
          button: 'right',
          double: true,
        },
        15000,
      );
      expect(text).toContain('**Coords:** (14, 27)');
      expect(text).toContain('**Button:** right (double)');
      expect(text).toContain('**Status:** OK');
    });

    it('validates click coordinates when they are missing', async () => {
      const result = await capture.handlePeekInteract({
        action: 'click',
        process: 'chrome.exe',
      });

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('click requires x,y coordinates or element name');
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });

    it('types text and reports it in output', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });

      const result = await capture.handlePeekInteract({
        action: 'type',
        process: 'chrome.exe',
        text: 'hello',
        wait_after: 0,
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/type',
        {
          mode: 'process',
          name: 'chrome.exe',
          text: 'hello',
        },
        15000,
      );
      const text = getTextBlocks(result).join('\n');
      expect(text).toContain('## peek_interact: type');
      expect(text).toContain('**Text:** hello');
    });

    it('validates type action text requirement', async () => {
      const result = await capture.handlePeekInteract({
        action: 'type',
        process: 'chrome.exe',
      });

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('type requires text');
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });

    it('scrolls at the provided coordinates and delta', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });

      const result = await capture.handlePeekInteract({
        action: 'scroll',
        process: 'chrome.exe',
        x: 9,
        y: 10,
        delta: -120,
        wait_after: 0,
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/scroll',
        {
          mode: 'process',
          name: 'chrome.exe',
          x: 9,
          y: 10,
          delta: -120,
        },
        15000,
      );
      const text = getTextBlocks(result).join('\n');
      expect(text).toContain('**Coords:** (9, 10)');
      expect(text).toContain('**Delta:** -120');
    });

    it('sends hotkey events', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });

      const result = await capture.handlePeekInteract({
        action: 'hotkey',
        process: 'chrome.exe',
        keys: 'Ctrl+S',
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/hotkey',
        {
          mode: 'process',
          name: 'chrome.exe',
          keys: 'Ctrl+S',
        },
        15000,
      );
      expect(getTextBlocks(result).join('\n')).toContain('**Keys:** Ctrl+S');
    });

    it('drags between two points with a duration', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });

      const result = await capture.handlePeekInteract({
        action: 'drag',
        process: 'chrome.exe',
        x: 1,
        y: 2,
        to_x: 20,
        to_y: 30,
        duration: 250,
        wait_after: 0,
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/drag',
        {
          mode: 'process',
          name: 'chrome.exe',
          from_x: 1,
          from_y: 2,
          to_x: 20,
          to_y: 30,
          button: 'left',
          duration: 250,
        },
        15000,
      );
      expect(getTextBlocks(result).join('\n')).toContain('## peek_interact: drag');
      expect(getTextBlocks(result).join('\n')).toContain('**Status:** OK');
    });

    it('validates drag coordinates', async () => {
      const result = await capture.handlePeekInteract({
        action: 'drag',
        process: 'chrome.exe',
        from_x: 1,
        from_y: 2,
      });

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('drag requires from_x, from_y, to_x, to_y');
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });

    it('requires an action value', async () => {
      const result = await capture.handlePeekInteract({});

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('action is required');
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });
  });

  describe('handlePeekLaunch', () => {
    it('requires a string path value', async () => {
      const result = await capture.handlePeekLaunch({
        path: 42,
      });

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('path is required');
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });

    it('returns an internal error when the launch request fails', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ error: 'service unavailable' });

      const result = await capture.handlePeekLaunch({
        path: 'C:\\Apps\\Torque.exe',
      });

      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(getTextBlocks(result).join('\n')).toContain('Launch failed: service unavailable');
    });
  });

  describe('handlePeekSnapshot', () => {
    it('saves snapshots by window title', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          element_count: 6,
          snapshot_count: 2,
        },
      });

      const result = await capture.handlePeekSnapshot({
        action: 'save',
        label: 'before-save',
        title: 'Torque',
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/snapshot',
        {
          action: 'save',
          label: 'before-save',
          mode: 'title',
          name: 'Torque',
        },
        15000,
      );
      expect(getTextBlocks(result).join('\n')).toContain('Snapshot **"before-save"** saved on peek-host (6 elements, 2 total snapshots).');
    });

    it('returns a snapshot diff report for diff action', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          baseline_count: 5,
          current_count: 4,
          has_changes: true,
          added: [{ name: 'Search' }],
          removed: [{ type: 'checkbox' }],
          moved: [],
          resized: [{ name: 'Panel' }],
          text_changed: [],
        },
      });

      const result = await capture.handlePeekSnapshot({
        action: 'diff',
        label: 'after-login',
        title: 'Torque',
      });

      const text = getTextBlocks(result).join('\n');
      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/snapshot',
        {
          action: 'diff',
          label: 'after-login',
          mode: 'title',
          name: 'Torque',
        },
        15000,
      );
      expect(text).toContain('## Snapshot Diff: "after-login"');
      expect(text).toContain('**Added (1):** Search');
      expect(text).toContain('**Removed (1):** checkbox');
      expect(text).toContain('**Resized (1):** Panel');
    });

    it('requires a process or title for save/diff actions', async () => {
      const result = await capture.handlePeekSnapshot({
        action: 'save',
        label: 'missing-target',
      });

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('peek_snapshot requires process or title for save/diff');
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });

    it('clears all snapshots', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          cleared: 3,
        },
      });

      const result = await capture.handlePeekSnapshot({
        action: 'clear',
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/snapshot',
        {
          action: 'clear',
        },
        15000,
      );
      expect(getTextBlocks(result).join('\n')).toContain('Cleared 3 snapshot(s) on peek-host.');
    });
  });

  describe('handlePeekRefresh', () => {
    it('auto-detects browser window and refreshes it', async () => {
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({
        data: {
          windows: [
            { process: 'Code.exe', title: 'Editor' },
            { process: 'chrome.exe', title: 'Docs' },
          ],
        },
      });
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });

      const result = await capture.handlePeekRefresh({});

      expect(mockShared.peekHttpGetUrl).toHaveBeenCalledWith('http://peek-host:9876/list', 5000);
      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/hotkey',
        {
          keys: 'F5',
          mode: 'process',
          name: 'chrome.exe',
        },
        10000,
      );
      expect(getTextBlocks(result).join('\n')).toContain('Sent F5 to chrome.exe on **peek-host**');
    });

    it('returns an operation error when hotkey fails', async () => {
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({
        data: {
          windows: [],
        },
      });
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ error: 'keyboard blocked' });

      const result = await capture.handlePeekRefresh({});

      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getTextBlocks(result).join('\n')).toContain('Refresh failed: keyboard blocked');
    });
  });

  describe('region file helpers', () => {
    it('treats missing region files as empty', async () => {
      const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('should not be read');
      });

      try {
        expect(capture.loadRegions('screen')).toEqual({});
        expect(readSpy).not.toHaveBeenCalled();
      } finally {
        existsSpy.mockRestore();
        readSpy.mockRestore();
      }
    });

    it('writes normalized regions and can serialize merges', async () => {
      const regionsPath = capture.getRegionsPath('process-chrome-exe');
      const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({ toolbar: { x: 1, y: 1, w: 20, h: 30 } })
      );
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      try {
        capture.saveRegion('process-chrome-exe', 'menu', {
          name: 'menu',
          x: 10,
          y: 20,
          w: 30,
          h: 40,
          extra: 'ignored',
        });

        expect(writeSpy).toHaveBeenCalledWith(
          regionsPath,
          JSON.stringify({
            toolbar: { x: 1, y: 1, w: 20, h: 30 },
            menu: { x: 10, y: 20, w: 30, h: 40 },
          }, null, 2),
        );
        expect(existsSpy).toHaveBeenCalledWith(regionsPath);
      } finally {
        existsSpy.mockRestore();
        readSpy.mockRestore();
        mkdirSpy.mockRestore();
        writeSpy.mockRestore();
      }
    });
  });

  describe('handlePeekUi - additional branches', () => {
    it('recovers from an initial health check failure by auto-starting the Windows peek server over SSH', async () => {
      vi.useFakeTimers();
      mockShared.resolvePeekHost.mockReturnValue({
        hostName: 'win-host',
        hostUrl: 'http://win-host:9988',
        ssh: 'builder@win-host',
        platform: 'windows',
      });
      mockShared.peekHttpGetUrl
        .mockResolvedValueOnce({ error: 'ECONNREFUSED' })
        .mockResolvedValueOnce({ data: { ok: true } })
        .mockResolvedValueOnce({
          data: {
            windows: [
              { process: 'chrome.exe', title: 'Recovered Browser' },
            ],
          },
        });

      const promise = capture.handlePeekUi({ list_windows: true });
      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;
      const text = getTextBlocks(result).join('\n');

      expect(mockChildProcess.execFileSync).toHaveBeenCalledWith(
        'ssh',
        [
          'builder@win-host',
          'schtasks /create /tn PeekAutoStart /tr "peek-server --port 9988" /sc once /st 00:00 /ru builder /f && schtasks /run /tn PeekAutoStart',
        ],
        expect.objectContaining({ timeout: 10000, stdio: 'ignore' }),
      );
      expect(text).toContain('| chrome.exe | Recovered Browser |');
      expect(text).toContain('**Host:** win-host');
    });

    it('resolves saved regions and includes crop, scale, and annotate query params', async () => {
      capture.saveRegion('title-docs', 'toolbar', {
        name: 'toolbar',
        x: 11,
        y: 22,
        w: 33,
        h: 44,
      });
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData({
          mode: 'title',
          title: 'Docs',
          process: null,
          format: 'png',
        }),
      });

      const result = await capture.handlePeekUi({
        title: 'Docs',
        region: 'toolbar',
        scale: 0.5,
        annotate: 'elements',
        format: 'png',
        quality: 90,
      });
      const requestUrl = new URL(mockShared.peekHttpGetWithRetry.mock.calls[0][0]);
      const text = getTextBlocks(result).join('\n');

      expect(requestUrl.searchParams.get('mode')).toBe('title');
      expect(requestUrl.searchParams.get('name')).toBe('Docs');
      expect(requestUrl.searchParams.get('format')).toBe('png');
      expect(requestUrl.searchParams.get('quality')).toBe('90');
      expect(requestUrl.searchParams.get('max_width')).toBe('960');
      expect(requestUrl.searchParams.get('crop')).toBe('11,22,33,44');
      expect(requestUrl.searchParams.get('annotate')).toBe('elements');
      expect(text).toContain('**Region:** toolbar');
    });

    it('applies client-side annotations before saving the local image', async () => {
      const savePath = path.join(tempHome, 'captures', 'annotated.png');
      sharpState.outputBuffer = Buffer.from('client-annotated-image');
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData({
          image: Buffer.from('server-image').toString('base64'),
          format: 'png',
          mime_type: 'image/png',
          size_bytes: 12,
        }),
      });

      const result = await capture.handlePeekUi({
        process: 'chrome.exe',
        save_path: savePath,
        annotations: [{ type: 'circle', x: 15, y: 20, r: 5, label: 'CTA' }],
      });
      const text = getTextBlocks(result).join('\n');
      const image = getImages(result)[0];

      expect(image.data).toBe(sharpState.outputBuffer.toString('base64'));
      expect(fs.readFileSync(savePath)).toEqual(sharpState.outputBuffer);
      expect(text).toContain(`**Size:** ${sharpState.outputBuffer.length} bytes`);
    });

    it('rejects missing diff baselines before compare requests run', async () => {
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData(),
      });

      const result = await capture.handlePeekUi({
        process: 'chrome.exe',
        diff_baseline: 'missing-baseline',
      });

      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('Baseline not found: missing-baseline');
      expect(mockShared.postCompareWithRetry).not.toHaveBeenCalled();
    });

    it('auto-diffs against the last capture and forwards the configured threshold', async () => {
      const lastRoot = path.join(tempHome, '.peek-ui', 'last', 'default');
      const previousBytes = Buffer.from('previous-capture');
      const currentBytes = Buffer.from('current-capture');
      fs.mkdirSync(lastRoot, { recursive: true });
      fs.writeFileSync(path.join(lastRoot, 'process-chrome-exe.png'), previousBytes);
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData({
          image: currentBytes.toString('base64'),
        }),
      });
      mockShared.postCompareWithRetry.mockResolvedValueOnce({
        data: {
          summary: 'Drift from previous capture',
          changed_pixels: 3,
          diff_percent: 0.2,
          threshold: 0.25,
          match: false,
        },
      });

      const result = await capture.handlePeekUi({
        process: 'chrome.exe',
        auto_diff: true,
        diff_threshold: 0.25,
      });
      const text = getTextBlocks(result).join('\n');

      expect(mockShared.postCompareWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876',
        previousBytes.toString('base64'),
        currentBytes.toString('base64'),
        0.25,
        30000,
      );
      expect(text).toContain('**Diff Source:** last:process-chrome-exe');
      expect(text).toContain('**Threshold:** 25.00%');
      expect(text).toContain('**Match:** No');
    });

    it('returns compare transport errors when the diff request fails', async () => {
      const baselineRoot = path.join(tempHome, '.peek-ui', 'baselines', 'default');
      fs.mkdirSync(baselineRoot, { recursive: true });
      fs.writeFileSync(path.join(baselineRoot, 'golden.png'), Buffer.from('baseline-image'));
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData(),
      });
      mockShared.postCompareWithRetry.mockResolvedValueOnce({ error: 'compare unavailable' });

      const result = await capture.handlePeekUi({
        process: 'chrome.exe',
        diff_baseline: 'golden',
      });

      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getTextBlocks(result).join('\n')).toContain('peek_ui compare failed: compare unavailable');
    });

    it('returns compare HTTP status failures when the diff endpoint rejects the request', async () => {
      const baselineRoot = path.join(tempHome, '.peek-ui', 'baselines', 'default');
      fs.mkdirSync(baselineRoot, { recursive: true });
      fs.writeFileSync(path.join(baselineRoot, 'golden.png'), Buffer.from('baseline-image'));
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData(),
      });
      mockShared.postCompareWithRetry.mockResolvedValueOnce({
        status: 503,
        data: {},
      });

      const result = await capture.handlePeekUi({
        process: 'chrome.exe',
        diff_baseline: 'golden',
      });

      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getTextBlocks(result).join('\n')).toContain('peek_ui compare failed: HTTP 503');
    });

    it('returns compare payload errors reported by the diff endpoint', async () => {
      const baselineRoot = path.join(tempHome, '.peek-ui', 'baselines', 'default');
      fs.mkdirSync(baselineRoot, { recursive: true });
      fs.writeFileSync(path.join(baselineRoot, 'golden.png'), Buffer.from('baseline-image'));
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData(),
      });
      mockShared.postCompareWithRetry.mockResolvedValueOnce({
        status: 200,
        data: { error: 'threshold rejected' },
      });

      const result = await capture.handlePeekUi({
        process: 'chrome.exe',
        diff_baseline: 'golden',
      });

      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getTextBlocks(result).join('\n')).toContain('peek_ui compare failed: threshold rejected');
    });

    it('reports OCR worker failures in the capture summary', async () => {
      mockTesseractWorker.recognize.mockRejectedValueOnce(new Error('OCR offline'));
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData({
          image: Buffer.from('peek-image').toString('base64'),
        }),
      });

      const result = await capture.handlePeekUi({
        process: 'chrome.exe',
        ocr: true,
        ocr_assert: 'loaded',
      });
      const text = getTextBlocks(result).join('\n');

      expect(text).toContain('**OCR Text:** [OCR failed: OCR offline]');
      expect(text).toContain('**OCR Assert:** "loaded" → FAIL');
    });

    it('renders a no-text OCR summary when the worker returns only whitespace', async () => {
      mockTesseractWorker.recognize.mockResolvedValueOnce({
        data: { text: '   \n' },
      });
      mockShared.peekHttpGetUrl.mockResolvedValueOnce({ data: { ok: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData(),
      });

      const result = await capture.handlePeekUi({
        process: 'chrome.exe',
        ocr: true,
      });

      expect(getTextBlocks(result).join('\n')).toContain('**OCR Text:** (no text detected)');
    });
  });

  describe('handlePeekInteract - additional branches', () => {
    it('waits for a matching window to appear', async () => {
      vi.useFakeTimers();
      mockShared.peekHttpGetWithRetry
        .mockResolvedValueOnce({ data: { windows: [] } })
        .mockResolvedValueOnce({
          data: {
            windows: [
              { process: 'chrome.exe', title: 'Docs', hwnd: 77 },
            ],
          },
        });

      const promise = capture.handlePeekInteract({
        action: 'wait_for_window',
        wait_target: 'chrome',
        wait_timeout: 1000,
        poll_interval: 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;
      const text = getTextBlocks(result).join('\n');

      expect(text).toContain('## peek_interact: wait_for_window');
      expect(text).toContain('**Found:** chrome.exe — Docs (hwnd: 77)');
      expect(text).toContain('**Status:** OK');
    });

    it('requires a target value for wait_for_window', async () => {
      const result = await capture.handlePeekInteract({
        action: 'wait_for_window',
      });

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('wait_for_window requires wait_target, process, or title');
    });

    it('surfaces transport errors while resolving interactive elements', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ error: 'element service offline' });

      const result = await capture.handlePeekInteract({
        action: 'click',
        process: 'chrome.exe',
        element: 'Save',
      });

      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(getTextBlocks(result).join('\n')).toContain('Element lookup failed: element service offline');
    });

    it('surfaces payload errors while resolving interactive elements', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: { error: 'Element not found' },
      });

      const result = await capture.handlePeekInteract({
        action: 'click',
        process: 'chrome.exe',
        element: 'Save',
      });

      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('Element not found');
    });

    it('returns clipboard text for clipboard_get', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          text: 'copied value',
          length: 12,
        },
      });

      const result = await capture.handlePeekInteract({
        action: 'clipboard_get',
        wait_after: 0,
      });
      const text = getTextBlocks(result).join('\n');

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/clipboard',
        { action: 'get' },
        15000,
      );
      expect(text).toContain('**Clipboard Text:** copied value');
      expect(text).toContain('**Length:** 12');
    });

    it('writes clipboard text for clipboard_set', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          length: 5,
        },
      });

      const result = await capture.handlePeekInteract({
        action: 'clipboard_set',
        text: 'hello',
        wait_after: 0,
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/clipboard',
        {
          action: 'set',
          text: 'hello',
        },
        15000,
      );
      expect(getTextBlocks(result).join('\n')).toContain('**Chars Written:** 5');
    });

    it('requires text for clipboard_set', async () => {
      const result = await capture.handlePeekInteract({
        action: 'clipboard_set',
      });

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('clipboard_set requires text');
    });

    it('returns window rect details for resize', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          success: true,
          rect: { x: 10, y: 15, w: 800, h: 600 },
        },
      });

      const result = await capture.handlePeekInteract({
        action: 'resize',
        process: 'chrome.exe',
        width: 800,
        height: 600,
        wait_after: 0,
      });
      const text = getTextBlocks(result).join('\n');

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/resize',
        {
          mode: 'process',
          name: 'chrome.exe',
          width: 800,
          height: 600,
        },
        15000,
      );
      expect(text).toContain('**Window Rect:** (10, 15, 800x600)');
    });

    it('requires coordinates for move actions', async () => {
      const result = await capture.handlePeekInteract({
        action: 'move',
        process: 'chrome.exe',
        x: 50,
      });

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('move requires x and y');
    });

    it('returns endpoint payload errors after an interaction request', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: { error: 'input blocked' },
      });

      const result = await capture.handlePeekInteract({
        action: 'click',
        process: 'chrome.exe',
        x: 10,
        y: 20,
        wait_after: 0,
      });

      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(getTextBlocks(result).join('\n')).toContain('click failed: input blocked');
    });
  });

  describe('peek URL and snapshot helpers - additional branches', () => {
    it('requires a url for handlePeekOpenUrl', async () => {
      const result = await capture.handlePeekOpenUrl({});

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('url is required');
    });

    it('surfaces remote open-url payload errors', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: { error: 'browser policy blocked' },
      });

      const result = await capture.handlePeekOpenUrl({
        url: 'https://example.com/docs',
      });

      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(getTextBlocks(result).join('\n')).toContain('Failed to open URL: browser policy blocked');
    });

    it('requires a label for snapshot diff actions', async () => {
      const result = await capture.handlePeekSnapshot({
        action: 'diff',
        process: 'chrome.exe',
      });

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('label is required for save/diff');
    });

    it('surfaces snapshot payload errors from the remote host', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: { error: 'snapshot missing' },
      });

      const result = await capture.handlePeekSnapshot({
        action: 'diff',
        label: 'after-login',
        process: 'chrome.exe',
      });

      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getTextBlocks(result).join('\n')).toContain('snapshot missing');
    });

    it('includes depth when saving snapshots', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          element_count: 4,
          snapshot_count: 1,
        },
      });

      await capture.handlePeekSnapshot({
        action: 'save',
        label: 'deep-save',
        process: 'chrome.exe',
        depth: 3,
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/snapshot',
        {
          action: 'save',
          label: 'deep-save',
          mode: 'process',
          name: 'chrome.exe',
          depth: 3,
        },
        15000,
      );
    });
  });

  describe('refresh and build/open - additional branches', () => {
    it('sends a hard refresh to an explicitly targeted window', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });

      const result = await capture.handlePeekRefresh({
        title: 'Docs',
        hard: true,
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/hotkey',
        {
          keys: 'Ctrl+Shift+R',
          mode: 'title',
          name: 'Docs',
        },
        10000,
      );
      expect(getTextBlocks(result).join('\n')).toContain('Sent Ctrl+Shift+R to Docs on **peek-host**');
    });

    it('requires a url for handlePeekBuildAndOpen', async () => {
      const result = await capture.handlePeekBuildAndOpen({});

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getTextBlocks(result).join('\n')).toContain('url is required');
    });

    it('returns an operation error when opening the url fails remotely', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ error: 'remote browser unavailable' });

      const result = await capture.handlePeekBuildAndOpen({
        url: 'https://example.com/app',
        capture: false,
      });

      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getTextBlocks(result).join('\n')).toContain('Failed to open URL: remote browser unavailable');
    });

    it('reports capture failures after opening the page', async () => {
      vi.useFakeTimers();
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({ data: {} });

      const promise = capture.handlePeekBuildAndOpen({
        url: 'https://example.com/app',
        capture_process: 'chrome.exe',
        wait_seconds: 1,
      });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      const text = getTextBlocks(result).join('\n');

      expect(text).toContain('**Opened:** https://example.com/app on peek-host');
      expect(text).toContain('**Capture:** Failed — no image data');
    });

    it('captures using an explicit capture title without listing windows', async () => {
      vi.useFakeTimers();
      mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({ data: { success: true } });
      mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData({
          mode: 'title',
          title: 'Docs',
          process: null,
          format: 'png',
        }),
      });

      const promise = capture.handlePeekBuildAndOpen({
        url: 'https://example.com/app',
        capture_title: 'Docs',
        wait_seconds: 1,
      });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      const requestUrl = new URL(mockShared.peekHttpGetWithRetry.mock.calls[0][0]);

      expect(requestUrl.searchParams.get('mode')).toBe('title');
      expect(requestUrl.searchParams.get('name')).toBe('Docs');
      expect(mockShared.peekHttpGetUrl).not.toHaveBeenCalledWith('http://peek-host:9876/list', 5000);
      expect(getImages(result)).toHaveLength(1);
      expect(getTextBlocks(result).join('\n')).toContain('**Captured:** 1280x720 (Docs)');
    });
  });
});