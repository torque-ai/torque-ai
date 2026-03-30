'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mockChildProcess = require('child_process');

const { installMock } = require('./cjs-mock');
const realShared = require('../handlers/shared');

const { ErrorCodes, makeError } = realShared;
const CAPTURE_MODULE_PATH = require.resolve('../plugins/snapscope/handlers/capture');

let currentModules = {};

vi.mock('../database', () => currentModules.db);
vi.mock('../db/peek-policy-audit', () => currentModules.db);
vi.mock('../task-manager', () => currentModules.taskManager);
vi.mock('../plugins/snapscope/handlers/shared', () => currentModules.peekShared);
vi.mock('../logger', () => currentModules.logger);

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
  const record = { input, layers: [] };
  sharpCalls.push(record);

  return {
    metadata: vi.fn().mockResolvedValue(sharpState.metadata),
    composite: vi.fn((layers) => {
      record.layers = layers;
      return {
        toBuffer: vi.fn().mockResolvedValue(sharpState.outputBuffer),
      };
    }),
  };
});

function sanitizeTargetKey(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
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
  return (result?.content || [])
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text);
}

function getText(result) {
  return getTextBlocks(result).join('\n');
}

function getImages(result) {
  return (result?.content || []).filter((entry) => entry.type === 'image');
}

function expectError(result, errorCode, textFragment) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(errorCode);
  if (textFragment) {
    expect(getText(result)).toContain(textFragment);
  }
}

function createModules() {
  const loggerInstance = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    db: {
      formatPolicyProof: vi.fn(),
      recordPolicyProofAudit: vi.fn(),
    },
    taskManager: {},
    peekShared: {
      escapeXml: vi.fn((value) => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')),
      formatBytes: vi.fn((bytes) => `${bytes} bytes`),
      getPeekTargetKey: vi.fn((args, peekData = {}) => {
        if (args.process) {
          return sanitizeTargetKey(`process-${peekData.process || args.process}`, 'process');
        }
        if (args.title) {
          return sanitizeTargetKey(`title-${peekData.title || args.title}`, 'title');
        }
        return 'screen';
      }),
      peekHttpGetUrl: vi.fn(async (url) => {
        if (String(url).endsWith('/health')) {
          return { data: { ok: true } };
        }
        if (String(url).endsWith('/list')) {
          return { data: { windows: [] } };
        }
        return { data: {} };
      }),
      peekHttpGetWithRetry: vi.fn(async () => ({ data: {} })),
      peekHttpPostWithRetry: vi.fn(async () => ({ data: { success: true } })),
      postCompareWithRetry: vi.fn(async () => ({ data: {} })),
      resolvePeekHost: vi.fn(() => ({
        hostName: 'peek-host',
        hostUrl: 'http://peek-host:9876',
        ssh: null,
        platform: 'linux',
      })),
    },
    logger: {
      child: vi.fn(() => loggerInstance),
    },
    loggerInstance,
  };
}

function loadHandlers() {
  installMock('../database', currentModules.db);
  installMock('../db/peek-policy-audit', currentModules.db);
  installMock('../task-manager', currentModules.taskManager);
  installMock('../plugins/snapscope/handlers/shared', currentModules.peekShared);
  installMock('../handlers/shared', realShared);
  installMock('../logger', currentModules.logger);
  installMock('sharp', mockSharp);
  installMock('tesseract.js', mockTesseract);

  delete require.cache[CAPTURE_MODULE_PATH];

  return require('../plugins/snapscope/handlers/capture');
}

describe('peek/capture exported handlers', () => {
  let handlers;
  let mocks;
  let tempHomeDir;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    sharpCalls.length = 0;
    sharpState.metadata = { width: 640, height: 480 };
    sharpState.outputBuffer = Buffer.from('annotated-image');
    vi.spyOn(mockChildProcess, 'execFileSync').mockReturnValue('build ok');
    mockTesseract.createWorker.mockResolvedValue(mockTesseractWorker);
    mockTesseractWorker.recognize.mockResolvedValue({
      data: { text: 'Detected text' },
    });

    tempHomeDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-peek-capture-handlers-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHomeDir);
    vi.spyOn(os, 'tmpdir').mockReturnValue(tempHomeDir);

    currentModules = createModules();
    mocks = currentModules;
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    currentModules = {};
    delete require.cache[CAPTURE_MODULE_PATH];
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
  });

  describe('helpers', () => {
    it('returns the original image when annotations are empty', async () => {
      const imageBuffer = Buffer.from('raw-image');

      const result = await handlers.applyAnnotations(imageBuffer, []);

      expect(result).toBe(imageBuffer);
      expect(mockSharp).not.toHaveBeenCalled();
    });

    it('renders SVG overlays for rect, circle, and arrow annotations', async () => {
      sharpState.outputBuffer = Buffer.from('annotated-output');

      const result = await handlers.applyAnnotations(Buffer.from('raw-image'), [
        { type: 'rect', x: 5, y: 10, w: 15, h: 20, color: 'blue', label: '<bad & "quote">' },
        { type: 'circle', x: 40, y: 50, r: 8, color: 'green', label: 'Dot' },
        { type: 'arrow', from: [1, 2], to: [30, 40], label: 'Go' },
      ]);

      expect(result).toEqual(Buffer.from('annotated-output'));
      expect(mockSharp).toHaveBeenCalledTimes(2);
      const svg = sharpCalls[1].layers[0].input.toString('utf8');
      expect(svg).toContain('<rect');
      expect(svg).toContain('<circle');
      expect(svg).toContain('<line');
      expect(svg).toContain('&lt;bad &amp; &quot;quote&quot;&gt;');
    });

    it('caches the OCR worker across calls', async () => {
      const firstWorker = await handlers.getOcrWorker();
      const secondWorker = await handlers.getOcrWorker();

      expect(firstWorker).toBe(mockTesseractWorker);
      expect(secondWorker).toBe(firstWorker);
      expect(mockTesseract.createWorker).toHaveBeenCalledTimes(1);
      expect(mockTesseract.createWorker).toHaveBeenCalledWith('eng');
    });

    it('extracts and trims OCR text', async () => {
      mockTesseractWorker.recognize.mockResolvedValueOnce({
        data: { text: '  Hello world  \n' },
      });

      const result = await handlers.extractText(Buffer.from('image-bytes'));

      expect(result).toBe('Hello world');
      expect(mockTesseractWorker.recognize).toHaveBeenCalledWith(Buffer.from('image-bytes'));
    });

    it('builds region file paths under the mocked home directory', () => {
      expect(handlers.getRegionsPath('screen')).toBe(
        path.join(tempHomeDir, '.peek-ui', 'regions', 'default', 'screen.json')
      );
    });

    it('returns an empty object when region files are missing or invalid', () => {
      expect(handlers.loadRegions('screen')).toEqual({});

      const regionsPath = handlers.getRegionsPath('screen');
      fs.mkdirSync(path.dirname(regionsPath), { recursive: true });
      fs.writeFileSync(regionsPath, '{bad json');

      expect(handlers.loadRegions('screen')).toEqual({});
    });

    it('saves named regions and resolves them by name', () => {
      handlers.saveRegion('process-chrome', 'toolbar', {
        name: 'toolbar',
        x: 10,
        y: 20,
        w: 300,
        h: 40,
        ignored: true,
      });

      const regionsPath = handlers.getRegionsPath('process-chrome');
      expect(JSON.parse(fs.readFileSync(regionsPath, 'utf8'))).toEqual({
        toolbar: { x: 10, y: 20, w: 300, h: 40 },
      });
      expect(handlers.resolveRegion('process-chrome', 'toolbar')).toEqual({
        x: 10,
        y: 20,
        w: 300,
        h: 40,
      });
    });

    it('formats compare summaries with the match fallback when passed is absent', () => {
      expect(handlers.buildCompareSummary({
        summary: '  layout drift  ',
        diff_percent: 0.125,
        threshold: 0.05,
        match: true,
      })).toEqual([
        '**Diff Summary:** layout drift',
        '**Diff Percent:** 12.50%',
        '**Threshold:** 5.00%',
        '**Match:** Yes',
      ]);
    });

    it('selects compare images from fallback fields and defaults mime type', () => {
      expect(handlers.getCompareImage({ image: 'diff-b64' })).toEqual({
        data: 'diff-b64',
        mimeType: 'image/png',
      });
      expect(handlers.getCompareImage({ summary: 'no image' })).toBeNull();
    });
  });

  describe('handlePeekUi', () => {
    it('lists remote desktop windows', async () => {
      mocks.peekShared.peekHttpGetUrl
        .mockResolvedValueOnce({ data: { ok: true } })
        .mockResolvedValueOnce({
          data: {
            windows: [
              { process: 'chrome.exe', title: 'Docs' },
              { process: 'code.exe', title: 'Torque' },
            ],
          },
        });

      const result = await handlers.handlePeekUi({ list_windows: true });

      expect(getText(result)).toContain('| chrome.exe | Docs |');
      expect(getText(result)).toContain('| code.exe | Torque |');
      expect(getText(result)).toContain('**Host:** peek-host');
      expect(mocks.peekShared.peekHttpGetUrl).toHaveBeenNthCalledWith(
        2,
        'http://peek-host:9876/list',
        30000
      );
    });

    it('returns host-resolution errors without attempting capture', async () => {
      const hostError = makeError(ErrorCodes.OPERATION_FAILED, 'cannot resolve host');
      mocks.peekShared.resolvePeekHost.mockReturnValueOnce({ error: hostError });

      const result = await handlers.handlePeekUi({ process: 'chrome.exe' });

      expect(result).toEqual(hostError);
      expect(mocks.peekShared.peekHttpGetUrl).not.toHaveBeenCalled();
      expect(mocks.peekShared.peekHttpGetWithRetry).not.toHaveBeenCalled();
    });

    it('rejects missing named regions before capture', async () => {
      const result = await handlers.handlePeekUi({
        process: 'chrome.exe',
        region: 'toolbar',
      });

      expectError(
        result,
        ErrorCodes.INVALID_PARAM.code,
        'Named region not found: "toolbar"'
      );
      expect(mocks.peekShared.peekHttpGetWithRetry).not.toHaveBeenCalled();
    });

    it('captures, compares, records OCR output, saves regions, and audits policy proof', async () => {
      const baselineRoot = path.join(tempHomeDir, '.peek-ui', 'baselines', 'default');
      const baselineBytes = Buffer.from('baseline-image');
      const currentBytes = Buffer.from('fresh-image');
      const diffBytes = Buffer.from('diff-image');
      const savePath = path.join(tempHomeDir, 'captures', 'capture.png');

      fs.mkdirSync(baselineRoot, { recursive: true });
      fs.writeFileSync(path.join(baselineRoot, 'golden.png'), baselineBytes);

      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData({
          image: currentBytes.toString('base64'),
          annotated_image: Buffer.from('server-annotated').toString('base64'),
          annotated_mime_type: 'image/png',
        }),
      });
      mocks.peekShared.postCompareWithRetry.mockResolvedValueOnce({
        data: {
          summary: 'Layout changed',
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

      const result = await handlers.handlePeekUi({
        process: 'chrome.exe',
        save_path: savePath,
        diff_baseline: 'golden',
        save_baseline: 'golden-new',
        save_region: { name: 'toolbar', x: 1, y: 2, w: 3, h: 4 },
        ocr: true,
        ocr_assert: 'loaded',
        policyProof: { rule: 'allow' },
        task_id: 'task-7',
        workflow_id: 'wf-2',
      });

      expect(getImages(result)).toHaveLength(3);
      expect(getText(result)).toContain('**Baseline Saved:** golden-new');
      expect(getText(result)).toContain('**Region Saved:** toolbar (1,2,3,4)');
      expect(getText(result)).toContain('**Diff Source:** baseline:golden');
      expect(getText(result)).toContain('**OCR Assert:** "loaded" → PASS');
      expect(mocks.peekShared.postCompareWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876',
        baselineBytes.toString('base64'),
        currentBytes.toString('base64'),
        0.01,
        30000
      );
      expect(mocks.db.formatPolicyProof).toHaveBeenCalledWith(expect.objectContaining({
        surface: 'capture_analysis',
        policy_family: 'peek',
        proof: { rule: 'allow' },
        context: expect.objectContaining({
          task_id: 'task-7',
          workflow_id: 'wf-2',
          action: 'capture_complete',
          host: 'peek-host',
          target: 'Docs',
        }),
      }));
      expect(fs.existsSync(savePath)).toBe(true);
      expect(fs.existsSync(path.join(baselineRoot, 'golden-new.png'))).toBe(true);
      expect(handlers.resolveRegion('process-chrome', 'toolbar')).toEqual({
        x: 1,
        y: 2,
        w: 3,
        h: 4,
      });
    });

    it('auto-diffs against the last capture when requested', async () => {
      const lastRoot = path.join(tempHomeDir, '.peek-ui', 'last', 'default');
      const previousBytes = Buffer.from('previous-image');
      const currentBytes = Buffer.from('current-image');

      fs.mkdirSync(lastRoot, { recursive: true });
      fs.writeFileSync(path.join(lastRoot, 'process-chrome.png'), previousBytes);

      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData({
          process: 'chrome.exe',
          image: currentBytes.toString('base64'),
        }),
      });
      mocks.peekShared.postCompareWithRetry.mockResolvedValueOnce({
        data: {
          summary: 'Minor drift',
          match: true,
        },
      });

      const result = await handlers.handlePeekUi({
        process: 'chrome.exe',
        auto_diff: true,
      });

      expect(mocks.peekShared.postCompareWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876',
        previousBytes.toString('base64'),
        currentBytes.toString('base64'),
        0.01,
        30000
      );
      expect(getText(result)).toContain('**Diff Source:** last:process-chrome');
      expect(getText(result)).toContain('**Match:** Yes');
    });

    it('returns compare failures for non-success HTTP statuses', async () => {
      const baselineRoot = path.join(tempHomeDir, '.peek-ui', 'baselines', 'default');

      fs.mkdirSync(baselineRoot, { recursive: true });
      fs.writeFileSync(path.join(baselineRoot, 'golden.png'), Buffer.from('baseline-image'));

      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData(),
      });
      mocks.peekShared.postCompareWithRetry.mockResolvedValueOnce({
        status: 503,
        data: {},
      });

      const result = await handlers.handlePeekUi({
        process: 'chrome.exe',
        diff_baseline: 'golden',
      });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'peek_ui compare failed: HTTP 503');
    });

    it('warns when policy proof auditing throws but still returns capture content', async () => {
      mocks.db.formatPolicyProof = undefined;
      mocks.db.recordPolicyProofAudit.mockImplementationOnce(() => {
        throw new Error('audit unavailable');
      });
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData(),
      });

      const result = await handlers.handlePeekUi({
        process: 'chrome.exe',
        policyProof: { rule: 'allow' },
      });

      expect(result.isError).not.toBe(true);
      expect(getText(result)).toContain('## peek_ui capture');
      expect(mocks.loggerInstance.warn).toHaveBeenCalledWith(
        'Policy proof audit recording failed: audit unavailable'
      );
    });

    it('attempts SSH auto-start before continuing when the host is initially down', async () => {
      vi.useFakeTimers();
      mocks.peekShared.resolvePeekHost.mockReturnValueOnce({
        hostName: 'ssh-host',
        hostUrl: 'http://ssh-host:9876',
        ssh: 'dev@ssh-host',
        platform: 'linux',
      });
      mocks.peekShared.peekHttpGetUrl
        .mockResolvedValueOnce({ error: 'ECONNREFUSED' })
        .mockResolvedValueOnce({ data: { ok: true } })
        .mockResolvedValueOnce({ data: { windows: [] } });

      const promise = handlers.handlePeekUi({ list_windows: true });
      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(mockChildProcess.execFileSync).toHaveBeenCalledWith(
        'ssh',
        ['dev@ssh-host', 'nohup peek-server --port 9876 > /dev/null 2>&1 &'],
        expect.objectContaining({ timeout: 10000, stdio: 'ignore' })
      );
      expect(getText(result)).toContain('_No visible windows found._');
    });
  });

  describe('handlePeekInteract', () => {
    it('clicks a discovered element and captures the result when requested', async () => {
      mocks.peekShared.peekHttpPostWithRetry
        .mockResolvedValueOnce({
          data: {
            center: { x: 12, y: 34 },
            name: 'Save',
            type: 'button',
          },
        })
        .mockResolvedValueOnce({ data: { success: true } });
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData(),
      });

      const result = await handlers.handlePeekInteract({
        action: 'click',
        process: 'chrome.exe',
        element: 'Save',
        wait_after: 0,
        capture_after: true,
      });

      expect(getText(result)).toContain('## peek_interact: click');
      expect(getText(result)).toContain('**Coords:** (12, 34)');
      expect(mocks.peekShared.peekHttpPostWithRetry).toHaveBeenNthCalledWith(
        1,
        'http://peek-host:9876/elements',
        { mode: 'process', name: 'chrome.exe', find: 'Save' },
        15000
      );
      expect(mocks.peekShared.peekHttpPostWithRetry).toHaveBeenNthCalledWith(
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
        15000
      );
      expect(getImages(result)).toHaveLength(1);
    });

    it('requires an action', async () => {
      const result = await handlers.handlePeekInteract({});

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'action is required');
    });

    it('requires click coordinates when no element is supplied', async () => {
      const result = await handlers.handlePeekInteract({
        action: 'click',
        wait_after: 0,
      });

      expectError(
        result,
        ErrorCodes.MISSING_REQUIRED_PARAM.code,
        'click requires x,y coordinates or element name'
      );
    });

    it('returns lookup failures when element discovery fails', async () => {
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        error: 'socket closed',
      });

      const result = await handlers.handlePeekInteract({
        action: 'click',
        process: 'chrome.exe',
        element: 'Save',
      });

      expectError(result, ErrorCodes.INTERNAL_ERROR.code, 'Element lookup failed: socket closed');
    });

    it('times out while waiting for an element that never appears', async () => {
      vi.useFakeTimers();
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValue({ data: {} });

      const promise = handlers.handlePeekInteract({
        action: 'wait_for_element',
        element: 'Missing Button',
        wait_timeout: 1000,
        poll_interval: 250,
      });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expectError(
        result,
        ErrorCodes.INTERNAL_ERROR.code,
        'Timed out waiting for element: Missing Button (1000ms)'
      );
    });

    it('waits until a window appears', async () => {
      vi.useFakeTimers();
      mocks.peekShared.peekHttpGetWithRetry
        .mockResolvedValueOnce({
          data: {
            windows: [{ process: 'notes.exe', title: 'Scratch', hwnd: 4 }],
          },
        })
        .mockResolvedValueOnce({
          data: {
            windows: [{ process: 'chrome.exe', title: 'Docs', hwnd: 9 }],
          },
        });

      const promise = handlers.handlePeekInteract({
        action: 'wait_for_window',
        wait_target: 'docs',
        wait_timeout: 1000,
        poll_interval: 250,
      });
      await vi.advanceTimersByTimeAsync(250);
      const result = await promise;

      expect(result.isError).not.toBe(true);
      expect(getText(result)).toContain('## peek_interact: wait_for_window');
      expect(getText(result)).toContain('**Found:** chrome.exe');
    });

    it('renders clipboard_get responses', async () => {
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          text: 'copied text',
          length: 11,
        },
      });

      const result = await handlers.handlePeekInteract({
        action: 'clipboard_get',
        wait_after: 0,
      });

      expect(mocks.peekShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/clipboard',
        { action: 'get' },
        15000
      );
      expect(getText(result)).toContain('**Clipboard Text:** copied text');
      expect(getText(result)).toContain('**Length:** 11');
    });

    it('rejects unknown actions', async () => {
      const result = await handlers.handlePeekInteract({
        action: 'dance',
      });

      expectError(result, ErrorCodes.INVALID_PARAM.code, 'Unknown action: dance');
    });
  });

  describe('handlePeekLaunch', () => {
    it('launches a remote process and clamps launch timeout to 30 seconds', async () => {
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          success: true,
          pid: 321,
          hwnd: 456,
          title: 'Torque UI',
        },
      });

      const result = await handlers.handlePeekLaunch({
        path: 'C:\\Apps\\Torque.exe',
        args: ['--dev'],
        timeout: 60,
        wait_for_window: false,
      });

      expect(mocks.peekShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/process',
        {
          action: 'launch',
          path: 'C:\\Apps\\Torque.exe',
          args: ['--dev'],
          wait_for_window: false,
          timeout: 30,
        },
        30000
      );
      expect(getText(result)).toContain('**PID:** 321');
      expect(getText(result)).toContain('**Status:** OK');
    });

    it('requires an executable path', async () => {
      const result = await handlers.handlePeekLaunch({});

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'path is required');
      expect(mocks.peekShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });
  });

  describe('handlePeekDiscover', () => {
    it('lists discovered projects and launchable paths', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: {
          projects: [
            { name: 'DeskApp', type: 'electron', executable: '/home/dev/DeskApp/dist/DeskApp.exe' },
            { name: 'WebApp', type: 'vite', path: '/home/dev/WebApp' },
          ],
        },
      });

      const result = await handlers.handlePeekDiscover({});

      expect(getText(result)).toContain('| DeskApp | electron | DeskApp.exe |');
      expect(getText(result)).toContain('- **DeskApp:** `/home/dev/DeskApp/dist/DeskApp.exe`');
      expect(getText(result)).toContain('- **WebApp:** `/home/dev/WebApp` _(use build: true)_');
    });

    it('returns a friendly empty state when no projects are discovered', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: { projects: [] },
      });

      const result = await handlers.handlePeekDiscover({});

      expect(getText(result)).toContain('_No projects found in ~/Projects._');
    });

    it('returns an internal error when discovery fails', async () => {
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        error: 'service unavailable',
      });

      const result = await handlers.handlePeekDiscover({});

      expectError(result, ErrorCodes.INTERNAL_ERROR.code, 'Discovery failed: service unavailable');
    });
  });

  describe('handlePeekOpenUrl', () => {
    it('opens a URL on the remote host', async () => {
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: { success: true },
      });

      const result = await handlers.handlePeekOpenUrl({
        url: 'https://example.com/docs',
      });

      expect(mocks.peekShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/open-url',
        { url: 'https://example.com/docs' },
        10000
      );
      expect(getText(result)).toContain('Opened **https://example.com/docs** in default browser on **peek-host**');
    });

    it('rejects URLs without an http or https scheme', async () => {
      const result = await handlers.handlePeekOpenUrl({
        url: 'file:///tmp/index.html',
      });

      expectError(result, ErrorCodes.INVALID_PARAM.code, 'url must start with http:// or https://');
      expect(mocks.peekShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });

    it('returns backend open-url failures', async () => {
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: { error: 'browser unavailable' },
      });

      const result = await handlers.handlePeekOpenUrl({
        url: 'https://example.com/docs',
      });

      expectError(result, ErrorCodes.INTERNAL_ERROR.code, 'Failed to open URL: browser unavailable');
    });
  });

  describe('handlePeekSnapshot', () => {
    it('lists snapshots on the remote host', async () => {
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: {
          count: 2,
          snapshots: [
            { label: 'baseline', element_count: 12, age_seconds: 8 },
            { label: 'after-login', element_count: 15, age_seconds: 3 },
          ],
        },
      });

      const result = await handlers.handlePeekSnapshot({ action: 'list' });

      expect(getText(result)).toContain('## Snapshots on peek-host');
      expect(getText(result)).toContain('- **baseline**: 12 elements, 8s ago');
      expect(getText(result)).toContain('- **after-login**: 15 elements, 3s ago');
    });

    it('clears snapshots on the remote host', async () => {
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: { cleared: 4 },
      });

      const result = await handlers.handlePeekSnapshot({ action: 'clear' });

      expect(getText(result)).toContain('Cleared 4 snapshot(s) on peek-host.');
    });

    it('renders diff output for a saved snapshot', async () => {
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValueOnce({
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

      const result = await handlers.handlePeekSnapshot({
        action: 'diff',
        label: 'baseline',
        process: 'chrome.exe',
        depth: 2,
      });

      expect(mocks.peekShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/snapshot',
        {
          action: 'diff',
          label: 'baseline',
          mode: 'process',
          name: 'chrome.exe',
          depth: 2,
        },
        15000
      );
      expect(getText(result)).toContain('**Added (1):** Save');
      expect(getText(result)).toContain('**Removed (1):** button');
      expect(getText(result)).toContain('**Moved (1):** Panel');
      expect(getText(result)).toContain('**Resized (1):** Editor');
      expect(getText(result)).toContain('**Text Changed (1):** Title');
    });

    it('requires a label and target for save and diff actions', async () => {
      const missingLabel = await handlers.handlePeekSnapshot({
        action: 'diff',
        process: 'chrome.exe',
      });
      const missingTarget = await handlers.handlePeekSnapshot({
        action: 'save',
        label: 'baseline',
      });

      expectError(missingLabel, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'label is required for save/diff');
      expectError(
        missingTarget,
        ErrorCodes.MISSING_REQUIRED_PARAM.code,
        'peek_snapshot requires process or title for save/diff'
      );
    });
  });

  describe('handlePeekRefresh', () => {
    it('detects a browser window and sends a hard refresh hotkey', async () => {
      mocks.peekShared.peekHttpGetUrl.mockResolvedValueOnce({
        data: {
          windows: [
            { process: 'notes.exe', title: 'Scratch' },
            { process: 'chrome.exe', title: 'Docs' },
          ],
        },
      });
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: { success: true },
      });

      const result = await handlers.handlePeekRefresh({ hard: true });

      expect(mocks.peekShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/hotkey',
        {
          keys: 'Ctrl+Shift+R',
          mode: 'process',
          name: 'chrome.exe',
        },
        10000
      );
      expect(getText(result)).toContain('Sent Ctrl+Shift+R to chrome.exe on **peek-host**');
    });

    it('returns an operation error when refresh fails', async () => {
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        error: 'permission denied',
      });

      const result = await handlers.handlePeekRefresh({
        process: 'chrome.exe',
      });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'Refresh failed: permission denied');
    });
  });

  describe('handlePeekBuildAndOpen', () => {
    it('builds locally, opens the URL remotely, and captures the browser window', async () => {
      vi.useFakeTimers();
      mockChildProcess.execFileSync.mockReturnValueOnce('build complete');
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: { success: true },
      });
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        data: createPeekCaptureData(),
      });

      const promise = handlers.handlePeekBuildAndOpen({
        url: 'https://example.com/app',
        build_command: 'npm run build',
        working_directory: 'C:\\repo\\app',
        wait_seconds: 1,
        capture_process: 'chrome.exe',
      });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(mockChildProcess.execFileSync).toHaveBeenCalledWith(
        'npm',
        ['run', 'build'],
        expect.objectContaining({
          cwd: 'C:\\repo\\app',
          timeout: 60000,
          encoding: 'utf8',
          shell: true,
        })
      );
      expect(mocks.peekShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/open-url',
        { url: 'https://example.com/app' },
        10000
      );
      expect(mocks.peekShared.peekHttpGetWithRetry).toHaveBeenCalledWith(
        'http://peek-host:9876/peek?mode=process&name=chrome.exe&format=jpeg&quality=80&max_width=1920',
        30000
      );
      expect(getImages(result)).toHaveLength(1);
      expect(getText(result)).toContain('**Build Status:** OK');
      expect(getText(result)).toContain('**Opened:** https://example.com/app on peek-host');
      expect(getText(result)).toContain('**Captured:** 1280x720 (Docs)');
    });

    it('returns build stderr when the local build step fails', async () => {
      const buildError = new Error('build exploded');
      buildError.stderr = 'build failed badly';
      mockChildProcess.execFileSync.mockImplementationOnce(() => {
        throw buildError;
      });

      const result = await handlers.handlePeekBuildAndOpen({
        url: 'https://example.com/app',
        build_command: 'npm run build',
      });

      expect(getText(result)).toContain('**Build Status:** FAILED');
      expect(getText(result)).toContain('build failed badly');
      expect(mocks.peekShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });

    it('reports capture failures without failing the open-url operation', async () => {
      vi.useFakeTimers();
      mocks.peekShared.peekHttpPostWithRetry.mockResolvedValueOnce({
        data: { success: true },
      });
      mocks.peekShared.peekHttpGetWithRetry.mockResolvedValueOnce({
        error: 'ETIMEDOUT',
      });

      const promise = handlers.handlePeekBuildAndOpen({
        url: 'https://example.com/app',
        wait_seconds: 1,
      });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(result.isError).not.toBe(true);
      expect(getText(result)).toContain('**Capture:** Failed');
      expect(getText(result)).toContain('ETIMEDOUT');
      expect(getImages(result)).toHaveLength(0);
    });
  });
});
