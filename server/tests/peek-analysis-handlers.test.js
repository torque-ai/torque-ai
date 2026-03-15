'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { installMock } = require('./cjs-mock');
const realShared = require('../handlers/shared');

const { ErrorCodes } = realShared;
const ANALYSIS_MODULE_PATH = require.resolve('../handlers/peek/analysis');

var currentModules = {};

vi.mock('../database', () => currentModules.db);
vi.mock('../task-manager', () => currentModules.taskManager);
vi.mock('../handlers/peek/shared', () => currentModules.peekShared);
vi.mock('../handlers/peek/artifacts', () => currentModules.artifacts);
vi.mock('../contracts/peek', () => currentModules.contracts);
vi.mock('../handlers/peek/capture', () => currentModules.capture);
vi.mock('../logger', () => currentModules.logger);

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function expectError(result, errorCode, textFragment) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(errorCode);
  if (textFragment) {
    expect(getText(result)).toContain(textFragment);
  }
}

function sanitizeKey(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

function buildDiagnosePayload(args) {
  if (!args.process && !args.title) {
    throw new Error('peek_diagnose requires process or title');
  }

  const payload = {
    mode: args.process ? 'process' : 'title',
    name: args.process || args.title,
  };

  if (args.annotate) payload.annotate = true;
  if (args.elements) payload.elements = true;
  if (args.measurements) payload.measurements = true;
  if (args.text_content) payload.text_content = true;
  if (args.format) payload.format = args.format;
  if (args.quality != null) payload.quality = args.quality;
  if (args.max_width != null) payload.max_width = args.max_width;

  return payload;
}

function createModules(tempHomeDir) {
  const loggerInstance = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    db: {},
    taskManager: {},
    peekShared: {
      buildPeekPersistOutputDir: () => path.join(tempHomeDir, 'persisted-output'),
      peekHttpGetWithRetry: async () => ({ data: {} }),
      postCompareWithRetry: async () => ({ data: {} }),
      peekHttpPostWithRetry: async () => ({ data: {} }),
      resolvePeekHost: () => ({
        hostName: 'omen',
        hostUrl: 'http://omen:9876',
      }),
      resolvePeekTaskContext: () => ({
        task: null,
        taskId: null,
        workflowId: null,
        taskLabel: null,
      }),
      sanitizePeekTargetKey: sanitizeKey,
    },
    artifacts: {
      applyEvidenceStateToBundle: () => {},
      classifyEvidenceSufficiency: () => ({ sufficient: true }),
      ensurePeekBundlePersistence: () => {},
      persistPeekResultReferences: () => [],
    },
    contracts: {
      buildPeekBundleArtifactReferences: () => [],
      buildPeekDiagnosePayload: buildDiagnosePayload,
      formatPeekArtifactReferenceSection: (refs) => (
        refs && refs.length ? '### Artifacts\n- bundle.json' : ''
      ),
      getPeekBundleContractSummary: () => ({
        name: 'peek_investigation_bundle',
        version: 1,
        slice: 'ui',
        created_at: '2026-03-12T10:00:00.000Z',
        persisted: true,
        signed: false,
      }),
      validatePeekInvestigationBundleEnvelope: () => [],
    },
    capture: {
      getCompareImage: () => ({
        data: 'diff-image-b64',
        mimeType: 'image/png',
      }),
    },
    logger: {
      child: vi.fn(() => loggerInstance),
    },
    loggerInstance,
  };
}

function loadHandlers() {
  installMock('../database', currentModules.db);
  installMock('../task-manager', currentModules.taskManager);
  installMock('../handlers/peek/shared', currentModules.peekShared);
  installMock('../handlers/peek/artifacts', currentModules.artifacts);
  installMock('../contracts/peek', currentModules.contracts);
  installMock('../handlers/peek/capture', currentModules.capture);
  installMock('../handlers/shared', realShared);
  installMock('../logger', currentModules.logger);

  delete require.cache[ANALYSIS_MODULE_PATH];

  return require('../handlers/peek/analysis');
}

describe('peek/analysis exported handlers', () => {
  let handlers;
  let mocks;
  let tempHomeDir;

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-peek-analysis-handlers-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHomeDir);
    currentModules = createModules(tempHomeDir);
    mocks = currentModules;
    handlers = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    currentModules = {};
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
  });

  it('renders find-mode element details for handlePeekElements', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        name: 'Open',
        type: 'Button',
        automation_id: 'open-btn',
        bounds: { x: 10, y: 20, w: 100, h: 30 },
        center: { x: 60, y: 35 },
        enabled: true,
        state: ['focused', 'hot'],
        path: ['Window', 'Toolbar', 'Open'],
        value: 'Launch',
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekElements({
      process: 'Taskmgr',
      find: 'Open',
      parent_name: 'Toolbar',
      region: { x: 1, y: 2, w: 3, h: 4 },
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## peek_elements: find "Open"');
    expect(getText(result)).toContain('**Automation ID:** open-btn');
    expect(getText(result)).toContain('**Path:** Window > Toolbar > Open');
    expect(getText(result)).toContain('**Value:** Launch');
  });

  it('returns an internal error when handlePeekElements backend calls fail', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      error: 'socket closed',
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekElements({
      title: 'Task Manager',
      depth: 2,
    });

    expectError(result, ErrorCodes.INTERNAL_ERROR.code, 'Element inspection failed: socket closed');
  });

  it('renders timeout output without error for handlePeekWait', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        success: false,
        error: 'timeout',
        elapsed_seconds: 3.5,
        polls: 7,
        conditions_met: [
          {
            met: false,
            detail: 'Still waiting for enabled state',
            condition: { type: 'state', name: 'Run' },
          },
        ],
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekWait({
      process: 'Taskmgr',
      conditions: [{ type: 'state', name: 'Run', expected_state: 'enabled' }],
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## Wait Result');
    expect(getText(result)).toContain('**Success:** No (timeout)');
    expect(getText(result)).toContain('**Polls:** 7');
    expect(getText(result)).toContain('- ✗ **state** Run');
  });

  it('rejects missing targets for handlePeekWait', async () => {
    handlers = loadHandlers();
    const result = await handlers.handlePeekWait({
      conditions: [{ type: 'exists', name: 'Run' }],
    });

    expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'peek_wait requires process or title');
  });

  it('renders OCR text and line bounds for handlePeekOcr', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        confidence: 97,
        text: 'CPU 24%',
        lines: [
          {
            text: 'CPU 24%',
            confidence: 97,
            bounds: { x: 12, y: 8, w: 64, h: 16 },
          },
        ],
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekOcr({
      process: 'Taskmgr',
      region: { x: 12, y: 8, w: 64, h: 16 },
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## OCR Results');
    expect(getText(result)).toContain('**Region:** x=12 y=8 w=64 h=16');
    expect(getText(result)).toContain('**Confidence:** 97%');
    expect(getText(result)).toContain('"CPU 24%" (confidence: 97, bounds: 12,8 64x16)');
  });

  it('returns an operation-failed error for handlePeekOcr backend errors', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: { error: 'OCR engine unavailable' },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekOcr({ process: 'Taskmgr' });

    expectError(result, ErrorCodes.OPERATION_FAILED.code, 'OCR engine unavailable');
  });

  it('renders mixed assertion results for handlePeekAssert', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        passed: false,
        passed_count: 1,
        total: 2,
        results: [
          {
            passed: true,
            message: 'Element exists',
            assertion: { type: 'exists', name: 'Run', exact: true },
          },
          {
            passed: false,
            message: 'Unexpected state',
            actual: { enabled: false },
            assertion: { type: 'state', automation_id: 'run-btn', expected_state: 'enabled' },
          },
        ],
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekAssert({
      process: 'Taskmgr',
      assertions: [
        { type: 'exists', name: 'Run', exact: true },
        { type: 'state', automation_id: 'run-btn', expected_state: 'enabled' },
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## Assertion Results');
    expect(getText(result)).toContain('**Overall:** FAIL (1/2 passed)');
    expect(getText(result)).toContain('✅ **exists name="Run" exact=true**');
    expect(getText(result)).toContain('Actual: {"enabled":false}');
  });

  it('rejects empty assertions for handlePeekAssert', async () => {
    handlers = loadHandlers();
    const result = await handlers.handlePeekAssert({
      process: 'Taskmgr',
      assertions: [],
    });

    expectError(
      result,
      ErrorCodes.MISSING_REQUIRED_PARAM.code,
      'assertions is required and must be a non-empty array',
    );
  });

  it('renders the hit-test element metadata for handlePeekHitTest', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        name: 'Run',
        type: 'Button',
        automation_id: 'run-btn',
        bounds: { x: 10, y: 15, w: 80, h: 25 },
        center: { x: 50, y: 27 },
        path: ['Window', 'Toolbar', 'Run'],
        value: 'Execute',
        state: ['focused'],
        enabled: false,
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekHitTest({
      title: 'Task Manager',
      x: 50,
      y: 27,
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## Hit-Test Result');
    expect(getText(result)).toContain('**Coordinates:** (50, 27)');
    expect(getText(result)).toContain('**Path:** Window > Toolbar > Run');
    expect(getText(result)).toContain('**Enabled:** false');
  });

  it('requires both coordinates for handlePeekHitTest', async () => {
    handlers = loadHandlers();
    const result = await handlers.handlePeekHitTest({ process: 'Taskmgr', x: 10 });

    expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'x and y coordinates are required');
  });

  it('renders element color samples for handlePeekColor', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        element_bounds: { x: 10, y: 12, w: 120, h: 50 },
        samples: {
          center: { x: 70, y: 37, hex: '#112233', r: 17, g: 34, b: 51 },
          top_left: { x: 10, y: 12, error: 'out of bounds' },
        },
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekColor({
      process: 'Taskmgr',
      element: { automation_id: 'summary-pane' },
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## Color Samples');
    expect(getText(result)).toContain('**Element bounds:** x=10 y=12 w=120 h=50');
    expect(getText(result)).toContain('- **center:** (70, 37) → #112233 (R=17 G=34 B=51)');
    expect(getText(result)).toContain('- **top_left:** (10, 12) — out of bounds');
  });

  it('requires element or points for handlePeekColor', async () => {
    handlers = loadHandlers();
    const result = await handlers.handlePeekColor({ process: 'Taskmgr' });

    expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'peek_color requires element or points');
  });

  it('renders markdown table rows and truncation for handlePeekTable', async () => {
    const rows = Array.from({ length: 52 }, (_value, index) => ({
      cells: [`Row ${index + 1}`, `Value ${index + 1}`],
    }));

    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        name: 'Processes',
        type: 'DataGrid',
        row_count: 52,
        column_count: 2,
        columns: ['Name', 'Value'],
        selected_rows: [2, 5],
        rows,
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekTable({
      process: 'Taskmgr',
      table_name: 'Processes',
      depth: 2,
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## Table: Processes');
    expect(getText(result)).toContain('**Selected rows:** 2, 5');
    expect(getText(result)).toContain('| Name | Value |');
    expect(getText(result)).toContain('| Row 50 | Value 50 |');
    expect(getText(result)).toContain('... and 2 more rows');
  });

  it('returns an operation-failed error for handlePeekTable request failures', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      error: 'connection reset',
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekTable({ process: 'Taskmgr' });

    expectError(result, ErrorCodes.OPERATION_FAILED.code, 'peek_table failed: connection reset');
  });

  it('renders lists, visible text, and summary prose for handlePeekSummary', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        window: 'Task Manager',
        size: '1280x720',
        element_count: 12,
        buttons: ['Run new task', 'End task'],
        input_fields: [{ label: 'Search', value: 'CPU' }],
        tabs: ['Processes', 'Performance'],
        lists: [{ name: 'Processes', item_count: 8 }],
        visible_text: ['CPU', 'Memory'],
        summary: 'Task Manager is focused on performance metrics.',
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekSummary({
      process: 'Taskmgr',
      depth: 2,
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## Scene Summary');
    expect(getText(result)).toContain('**Buttons:** Run new task, End task');
    expect(getText(result)).toContain('  - Search: "CPU"');
    expect(getText(result)).toContain('  - CPU');
    expect(getText(result)).toContain('**Summary:** Task Manager is focused on performance metrics.');
  });

  it('returns missing-param when handlePeekSummary lacks a target', async () => {
    handlers = loadHandlers();
    const result = await handlers.handlePeekSummary({});

    expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'peek_summary requires process or title');
  });

  it('renders evaluate output for handlePeekCdp', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        type: 'string',
        value: 'Task Manager',
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekCdp({
      action: 'evaluate',
      expression: 'document.title',
      timeout_seconds: 8,
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## peek_cdp — evaluate');
    expect(getText(result)).toContain('**Expression:** `document.title`');
    expect(getText(result)).toContain('**Type:** string');
    expect(getText(result)).toContain('**Value:** "Task Manager"');
  });

  it('returns operation-failed when handlePeekCdp returns a service error', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: { error: 'evaluation crashed' },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekCdp({
      action: 'evaluate',
      expression: 'document.title',
    });

    expectError(result, ErrorCodes.OPERATION_FAILED.code, 'CDP error: evaluation crashed');
  });

  it('creates regression snapshots with captured window files', async () => {
    const imageB64 = Buffer.from('png-image').toString('base64');

    vi.spyOn(mocks.peekShared, 'peekHttpGetWithRetry')
      .mockResolvedValueOnce({
        data: {
          windows: [
            { process: 'Taskmgr.exe', title: 'Task Manager', hwnd: '1001' },
            { process: 'Calc.exe', title: 'Calculator', hwnd: '1002' },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { image: imageB64, width: 800, height: 600 },
      })
      .mockResolvedValueOnce({
        data: { image: imageB64, width: 640, height: 480 },
      });

    handlers = loadHandlers();
    const result = await handlers.handlePeekRegression({ action: 'snapshot' });
    const regressionRoot = path.join(tempHomeDir, '.peek-ui', 'regression');
    const [snapshotId] = fs.readdirSync(regressionRoot);
    const snapshotDir = path.join(regressionRoot, snapshotId);
    const metadata = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'metadata.json'), 'utf8'));

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## peek_regression: snapshot');
    expect(getText(result)).toContain('**Windows Captured:** 2/2');
    expect(metadata.host).toBe('omen');
    expect(metadata.windows).toEqual([
      expect.objectContaining({
        process: 'Taskmgr',
        title: 'Task Manager',
        file: 'taskmgr-task-manager.png',
      }),
      expect.objectContaining({
        process: 'Calc',
        title: 'Calculator',
        file: 'calc-calculator.png',
      }),
    ]);
    expect(fs.existsSync(path.join(snapshotDir, 'taskmgr-task-manager.png'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'calc-calculator.png'))).toBe(true);
  });

  it('compares regression baselines and includes diff content', async () => {
    const snapshotId = '2026-03-11T11-00-00';
    const snapshotDir = path.join(tempHomeDir, '.peek-ui', 'regression', snapshotId);

    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(
      path.join(snapshotDir, 'metadata.json'),
      JSON.stringify({
        timestamp: snapshotId,
        windows: [
          {
            process: 'Taskmgr',
            title: 'Task Manager',
            file: 'taskmgr-task-manager.png',
          },
        ],
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(snapshotDir, 'taskmgr-task-manager.png'), Buffer.from('baseline-image'));

    vi.spyOn(mocks.peekShared, 'peekHttpGetWithRetry')
      .mockResolvedValueOnce({
        data: {
          windows: [{ process: 'Taskmgr', title: 'Task Manager' }],
        },
      })
      .mockResolvedValueOnce({
        data: { image: Buffer.from('current-image').toString('base64') },
      });
    vi.spyOn(mocks.peekShared, 'postCompareWithRetry').mockResolvedValueOnce({
      data: {
        diff_percent: 0.05,
        changed_pixels: 512,
        has_differences: true,
      },
    });
    vi.spyOn(mocks.capture, 'getCompareImage').mockReturnValueOnce({
      data: 'diff-image-b64',
      mimeType: 'image/png',
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekRegression({
      action: 'compare',
      snapshot_id: snapshotId,
      diff_threshold: 0.05,
      ignore_regions: [{ x: 1, y: 2, w: 3, h: 4 }],
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## peek_regression: compare');
    expect(getText(result)).toContain('| Taskmgr — Task Manager | CHANGED | 5.00% | 512 |');
    expect(result.content[1]).toEqual({
      type: 'text',
      text: '### Diff: Taskmgr — Task Manager',
    });
    expect(result.content[2]).toEqual({
      type: 'image',
      data: 'diff-image-b64',
      mimeType: 'image/png',
    });
  });

  it('renders a diagnostic bundle summary for handlePeekDiagnose', async () => {
    const refs = [
      {
        kind: 'bundle_json',
        path: path.join(tempHomeDir, 'bundle.json'),
        artifact_id: 'artifact-1',
      },
    ];

    vi.spyOn(mocks.contracts, 'buildPeekBundleArtifactReferences').mockReturnValueOnce(refs);
    vi.spyOn(mocks.artifacts, 'persistPeekResultReferences').mockReturnValueOnce(refs);
    vi.spyOn(mocks.peekShared, 'resolvePeekTaskContext').mockReturnValueOnce({
      task: null,
      taskId: 'task-123',
      workflowId: 'wf-123',
      taskLabel: 'peek-diagnose',
    });
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        bundle: { id: 'bundle-1' },
        elements: {
          tree: [
            {
              name: 'Summary',
              type: 'Pane',
              automation_id: 'summary-pane',
              bounds: { x: 0, y: 0, w: 400, h: 200 },
              value: 'CPU',
              enabled: false,
              toggle_state: 'on',
              is_selected: true,
            },
          ],
          count: 1,
          focused_element: {
            name: 'CPU',
            type: 'Text',
            bounds: { x: 12, y: 14, w: 50, h: 18 },
          },
        },
        measurements: {
          window_size: { w: 1280, h: 720 },
          spacing: [{ a: 'CPU', b: 'Memory', gap_x: 10, gap_y: 4, alignment: 'horizontal' }],
        },
        text_content: {
          summary: 'Performance overview',
          inputs: [{ name: 'Search', automation_id: 'search', value: 'cpu' }],
          labels_and_values: [{ label: 'CPU', value: '24%' }],
          by_type: { label: ['CPU', 'Memory'] },
        },
        annotation_index: [
          {
            number: 1,
            name: 'CPU',
            type: 'Text',
            automation_id: 'cpu-value',
            bounds: { x: 12, y: 14, w: 50, h: 18 },
          },
        ],
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekDiagnose({
      process: 'Taskmgr',
      elements: true,
      measurements: true,
      text_content: true,
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## Diagnostic Bundle');
    expect(getText(result)).toContain('**Evidence State:** complete');
    expect(getText(result)).toContain('**Bundle Contract:** peek_investigation_bundle v1');
    expect(getText(result)).toContain('- **Summary** `Pane` [summary-pane] (0,0 400x200) = "CPU" {disabled, on, selected}');
    expect(getText(result)).toContain('- Search [search] = "cpu"');
    expect(getText(result)).toContain('### Artifacts');
    expect(result.peek_bundle_artifacts).toEqual(refs);
  });

  it('returns an operation-failed error when handlePeekDiagnose omits bundle data', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        elements: [],
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekDiagnose({ process: 'Taskmgr' });

    expectError(
      result,
      ErrorCodes.OPERATION_FAILED.code,
      'peek_diagnose returned malformed response: bundle is required',
    );
  });

  it('renders semantic diff changes for handlePeekSemanticDiff', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        summary: '1 moved, 1 text updated',
        matched_count: 10,
        unmatched_baseline: 1,
        unmatched_current: 2,
        changes: [
          {
            type: 'moved',
            element: { name: 'Search', type: 'Edit' },
            from: { x: 10, y: 20 },
            to: { x: 30, y: 40 },
            delta: { x: 20, y: 20 },
          },
          {
            type: 'text_changed',
            element: { automation_id: 'cpu-value', type: 'Text' },
            from_value: '20%',
            to_value: '24%',
          },
        ],
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekSemanticDiff({
      process: 'Taskmgr',
      baseline_elements: [{ name: 'Search', type: 'Edit' }],
      match_strategy: 'automation_id',
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## Semantic Diff');
    expect(getText(result)).toContain('**Match Strategy:** automation_id');
    expect(getText(result)).toContain('**Summary:** 1 moved, 1 text updated');
    expect(getText(result)).toContain('- **↔ MOVED** `Search` (Edit) from (10,20) to (30,40) [Δ20,Δ20]');
    expect(getText(result)).toContain('- **✎ TEXT** `cpu-value` (Text): "20%" → "24%"');
  });

  it('requires baseline elements for handlePeekSemanticDiff', async () => {
    handlers = loadHandlers();
    const result = await handlers.handlePeekSemanticDiff({
      process: 'Taskmgr',
    });

    expectError(
      result,
      ErrorCodes.MISSING_REQUIRED_PARAM.code,
      'baseline_elements is required and must be an array of element tree nodes',
    );
  });

  it('renders step results for handlePeekActionSequence', async () => {
    vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValueOnce({
      data: {
        success: true,
        steps_completed: 2,
        steps_total: 2,
        elapsed_seconds: 1.75,
        step_results: [
          { step: 1, action: 'wait', success: true, elapsed: 1.2 },
          { step: 2, action: 'sleep', success: true, seconds: 0.5 },
        ],
      },
    });

    handlers = loadHandlers();
    const result = await handlers.handlePeekActionSequence({
      process: 'Taskmgr',
      steps: [
        { action: 'wait', conditions: [{ type: 'exists', name: 'Run' }] },
        { action: 'sleep', seconds: 0.5 },
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('## Action Sequence');
    expect(getText(result)).toContain('**Success:** Yes');
    expect(getText(result)).toContain('**Steps:** 2/2');
    expect(getText(result)).toContain('- ✓ **Step 1** `wait` waited 1.20s');
    expect(getText(result)).toContain('- ✓ **Step 2** `sleep` 0.5s');
  });

  it('rejects empty steps for handlePeekActionSequence', async () => {
    handlers = loadHandlers();
    const result = await handlers.handlePeekActionSequence({
      process: 'Taskmgr',
      steps: [],
    });

    expectError(
      result,
      ErrorCodes.MISSING_REQUIRED_PARAM.code,
      'steps is required and must be a non-empty array',
    );
  });
});
