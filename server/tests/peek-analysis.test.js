'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const mockShared = {
  buildPeekPersistOutputDir: vi.fn(),
  peekHttpGetWithRetry: vi.fn(),
  postCompareWithRetry: vi.fn(),
  peekHttpPostWithRetry: vi.fn(),
  resolvePeekHost: vi.fn(),
  resolvePeekTaskContext: vi.fn(),
  sanitizePeekTargetKey: vi.fn(),
};

const mockArtifacts = {
  applyEvidenceStateToBundle: vi.fn(),
  classifyEvidenceSufficiency: vi.fn(),
  ensurePeekBundlePersistence: vi.fn(),
  persistPeekResultReferences: vi.fn(),
};

const mockContracts = {
  buildPeekBundleArtifactReferences: vi.fn(),
  buildPeekDiagnosePayload: vi.fn(),
  formatPeekArtifactReferenceSection: vi.fn(),
  getPeekBundleContractSummary: vi.fn(),
  validatePeekInvestigationBundleEnvelope: vi.fn(),
  // Constants required by peek-fixtures.js (loaded transitively via db/peek-fixture-catalog.js)
  PEEK_AUTHORITATIVE_PACKAGE_ROOT: 'tools/peek-server',
  PEEK_CAPABILITIES_ROUTES: Object.freeze({ health: '/health', investigation_bundle: '/diagnose' }),
  PEEK_FIRST_SLICE_NAME: 'first',
  PEEK_INVESTIGATION_BUNDLE_CONTRACT: Object.freeze({ name: 'peek_investigation_bundle', version: 1 }),
};

const mockCapture = {
  getCompareImage: vi.fn(),
};

const mockLogger = {
  child: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
};

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadAnalysis() {
  delete require.cache[require.resolve('../plugins/snapscope/handlers/analysis')];
  installCjsModuleMock('../plugins/snapscope/handlers/shared', mockShared);
  installCjsModuleMock('../plugins/snapscope/handlers/artifacts', mockArtifacts);
  installCjsModuleMock('../contracts/peek', mockContracts);
  installCjsModuleMock('../plugins/snapscope/handlers/capture', mockCapture);
  installCjsModuleMock('../logger', mockLogger);
  return require('../plugins/snapscope/handlers/analysis');
}

function loadAnalysisWithHelpers() {
  const resolvedPath = path.resolve(__dirname, '../plugins/snapscope/handlers/analysis.js');
  const source = fs.readFileSync(resolvedPath, 'utf8');
  const requireFromAnalysis = createRequire(resolvedPath);
  const exportedModule = { exports: {} };
  const wrappedSource = `${source}\n\nmodule.exports.__testHelpers = {\n  resolvePeekWindowTarget,\n  renderDiagnoseElementTree,\n  renderPeekElementsTree,\n};\n`;
  const compiled = new Function('require', 'module', 'exports', '__filename', '__dirname', wrappedSource);
  compiled(requireFromAnalysis, exportedModule, exportedModule.exports, resolvedPath, path.dirname(resolvedPath));
  return exportedModule.exports.__testHelpers;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadModuleFromSource(relativePath, injectedModules = {}, appendedSource = '') {
  const resolvedPath = path.resolve(__dirname, relativePath);
  const source = fs.readFileSync(resolvedPath, 'utf8');
  const requireFromModule = createRequire(resolvedPath);
  const exportedModule = { exports: {} };
  const compiled = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    `${source}\n${appendedSource}`,
  );
  const customRequire = (request) => {
    if (Object.prototype.hasOwnProperty.call(injectedModules, request)) {
      return injectedModules[request];
    }
    return requireFromModule(request);
  };
  compiled(customRequire, exportedModule, exportedModule.exports, resolvedPath, path.dirname(resolvedPath));
  return exportedModule.exports;
}

function createFsProxy() {
  return {
    existsSync: vi.fn((...args) => fs.existsSync(...args)),
    mkdirSync: vi.fn((...args) => fs.mkdirSync(...args)),
    readFileSync: vi.fn((...args) => fs.readFileSync(...args)),
    statSync: vi.fn((...args) => fs.statSync(...args)),
    writeFileSync: vi.fn((...args) => fs.writeFileSync(...args)),
  };
}

function inferArtifactMimeType(filePath) {
  switch (path.extname(filePath || '').toLowerCase()) {
    case '.json':
      return 'application/json';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

function createDiagnoseIntegrationHarness(tempRoot, overrides = {}) {
  const contracts = loadModuleFromSource('../contracts/peek.js');
  const fixtures = loadModuleFromSource('../contracts/peek-fixtures.js', {
    './peek': contracts,
  });
  const fsProxy = createFsProxy();
  const loggerInstance = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const loggerModule = {
    child: vi.fn(() => loggerInstance),
  };
  const persistOutputDir = overrides.persistOutputDir || path.join(tempRoot, 'integration-output');
  const taskContext = overrides.taskContext || {
    task: { metadata: { existing: true } },
    taskId: 'task-123',
    workflowId: 'wf-123',
    taskLabel: 'peek-diagnose',
  };
  const workflow = overrides.workflow || {
    context: { workflow: true },
  };
  const dbMock = {
    getWorkflow: vi.fn(() => workflow),
    storeArtifact: vi.fn((artifact) => ({
      ...artifact,
      created_at: '2026-03-11T12:00:00.000Z',
      expires_at: '2026-04-10T12:00:00.000Z',
    })),
    formatPolicyProof: vi.fn(),
    recordPolicyProofAudit: vi.fn(),
    updateTask: vi.fn(),
    updateWorkflow: vi.fn(),
  };
  const sharedModule = {
    buildPeekPersistOutputDir: vi.fn(() => persistOutputDir),
    getTorqueArtifactStorageRoot: vi.fn(() => path.join(tempRoot, 'artifact-root')),
    inferPeekArtifactMimeType: vi.fn((filePath) => inferArtifactMimeType(filePath)),
    peekHttpGetWithRetry: vi.fn(),
    peekHttpPostWithRetry: vi.fn(),
    postCompareWithRetry: vi.fn(),
    resolvePeekHost: vi.fn(() => ({
      hostName: 'omen',
      hostUrl: 'http://omen:9876',
    })),
    resolvePeekTaskContext: vi.fn(() => taskContext),
    sanitizePeekTargetKey: vi.fn((value, fallback) => {
      const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return normalized || fallback;
    }),
  };
  const artifacts = loadModuleFromSource('../plugins/snapscope/handlers/artifacts.js', {
    fs: fsProxy,
    '../../contracts/peek': contracts,
    '../../database': dbMock,
    '../../db/task-core': dbMock,
    '../../db/task-metadata': dbMock,
    '../../db/workflow-engine': dbMock,
    '../../db/peek-policy-audit': dbMock,
    '../../logger': loggerModule,
    './shared': sharedModule,
  });
  const analysis = loadModuleFromSource('../plugins/snapscope/handlers/analysis.js', {
    './artifacts': artifacts,
    './capture': mockCapture,
    './shared': sharedModule,
    '../../contracts/peek': contracts,
    '../../logger': loggerModule,
  });

  return {
    analysis,
    artifacts,
    contracts,
    dbMock,
    fixtures,
    fsProxy,
    loggerInstance,
    persistOutputDir,
    sharedModule,
    taskContext,
    workflow,
  };
}

vi.mock('../plugins/snapscope/handlers/shared', () => mockShared);
vi.mock('../plugins/snapscope/handlers/artifacts', () => mockArtifacts);
vi.mock('../contracts/peek', () => mockContracts);
vi.mock('../plugins/snapscope/handlers/capture', () => mockCapture);
vi.mock('../logger', () => mockLogger);

const { ErrorCodes } = require('../handlers/error-codes');

function resetMockDefaults(tempHomeDir) {
  mockShared.buildPeekPersistOutputDir.mockReset().mockReturnValue(path.join(tempHomeDir, 'persisted-output'));
  mockShared.peekHttpGetWithRetry.mockReset();
  mockShared.postCompareWithRetry.mockReset();
  mockShared.peekHttpPostWithRetry.mockReset();
  mockShared.resolvePeekHost.mockReset().mockReturnValue({
    hostName: 'omen',
    hostUrl: 'http://omen:9876',
  });
  mockShared.resolvePeekTaskContext.mockReset().mockReturnValue({
    task: null,
    taskId: null,
    workflowId: null,
    taskLabel: null,
  });
  mockShared.sanitizePeekTargetKey.mockReset().mockImplementation((value, fallback) => {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || fallback;
  });

  mockArtifacts.applyEvidenceStateToBundle.mockReset();
  mockArtifacts.classifyEvidenceSufficiency.mockReset().mockReturnValue({ sufficient: true });
  mockArtifacts.ensurePeekBundlePersistence.mockReset();
  mockArtifacts.persistPeekResultReferences.mockReset().mockReturnValue([]);

  mockContracts.buildPeekBundleArtifactReferences.mockReset().mockReturnValue([]);
  mockContracts.buildPeekDiagnosePayload.mockReset().mockImplementation((args) => {
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
  });
  mockContracts.formatPeekArtifactReferenceSection.mockReset().mockImplementation((refs) => {
    if (!refs || refs.length === 0) return '';
    return '### Artifacts\n- bundle.json';
  });
  mockContracts.getPeekBundleContractSummary.mockReset().mockReturnValue({
    name: 'peek_investigation_bundle',
    version: 1,
    slice: 'ui',
    created_at: '2026-03-11T12:00:00.000Z',
    persisted: true,
    signed: false,
  });
  mockContracts.validatePeekInvestigationBundleEnvelope.mockReset().mockReturnValue([]);

  mockCapture.getCompareImage.mockReset().mockReturnValue({
    data: 'diff-image-b64',
    mimeType: 'image/png',
  });
}

function getTextContent(result, index = 0) {
  return result.content[index]?.text || '';
}

function getCombinedText(result) {
  return (result.content || [])
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text)
    .join('\n\n');
}

function expectError(result, code, message) {
  expect(result).toMatchObject({
    isError: true,
    error_code: code,
  });
  expect(getCombinedText(result)).toContain(message);
}

describe('peek analysis handlers', () => {
  let analysis;
  let analysisHelpers;
  let tempHomeDir;

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-peek-analysis-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHomeDir);
    resetMockDefaults(tempHomeDir);
    analysis = loadAnalysis();
    analysisHelpers = loadAnalysisWithHelpers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
  });

  describe('handlePeekElements', () => {
    it('renders find-mode element details including state and path', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
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

      const result = await analysis.handlePeekElements({
        process: 'Taskmgr',
        find: 'Open',
        parent_name: 'Toolbar',
        region: { x: 1, y: 2, w: 3, h: 4 },
        index: 1,
        near: 'Close',
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://omen:9876/elements',
        {
          mode: 'process',
          name: 'Taskmgr',
          find: 'Open',
          parent_name: 'Toolbar',
          region: { x: 1, y: 2, w: 3, h: 4 },
          index: 1,
          near: 'Close',
        },
        15000,
      );
      expect(getTextContent(result)).toContain('## peek_elements: find "Open"');
      expect(getTextContent(result)).toContain('**Automation ID:** open-btn');
      expect(getTextContent(result)).toContain('**Path:** Window > Toolbar > Open');
      expect(getTextContent(result)).toContain('**State:** focused, hot');
      expect(getTextContent(result)).toContain('**Value:** Launch');
    });

    it('renders the tree view and focused element when browsing', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          window: { name: 'Task Manager' },
          count: 2,
          elements: [
            {
              name: 'Main Tabs',
              type: 'Tab',
              automation_id: 'tabs',
              value: 'Performance',
              enabled: false,
              bounds: { x: 1, y: 2, w: 300, h: 40 },
              toggle_state: 'on',
              is_selected: true,
              children: [
                {
                  name: 'CPU',
                  type: 'TabItem',
                  bounds: { x: 5, y: 8, w: 60, h: 20 },
                  enabled: true,
                  scroll_position: { vertical_percent: 75 },
                  range_value: { current: 25, maximum: 100 },
                  children: [],
                },
              ],
            },
          ],
          focused_element: {
            name: 'CPU',
            type: 'TabItem',
            bounds: { x: 5, y: 8, w: 60, h: 20 },
          },
        },
      });

      const result = await analysis.handlePeekElements({
        title: 'Task Manager',
        depth: 4,
        types: ['Tab', 'TabItem'],
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://omen:9876/elements',
        {
          mode: 'title',
          name: 'Task Manager',
          depth: 4,
          types: ['Tab', 'TabItem'],
        },
        15000,
      );
      expect(getTextContent(result)).toContain('**Window:** Task Manager');
      expect(getTextContent(result)).toContain('Main Tabs [Tab] id="tabs" value="Performance" [DISABLED] {on, selected} (1,2 300x40)');
      expect(getTextContent(result)).toContain('CPU [TabItem] {scroll:75%, range:25/100} (5,8 60x20)');
      expect(getTextContent(result)).toContain('Focused: CPU [TabItem] (5,8 60x20)');
    });

    it('returns a missing-param error when no process or title is provided', async () => {
      const result = await analysis.handlePeekElements({});

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'process or title is required');
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });
  });

  describe('handlePeekWait', () => {
    it('renders a successful wait result with matched conditions', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          success: true,
          elapsed_seconds: 2.25,
          polls: 4,
          conditions_met: [
            {
              met: true,
              detail: 'Button became enabled',
              condition: { type: 'state', name: 'Run', element_type: 'Button' },
            },
          ],
        },
      });

      const result = await analysis.handlePeekWait({
        process: 'Taskmgr',
        conditions: [{ type: 'state', name: 'Run', expected_state: 'enabled' }],
        wait_timeout: 12,
        poll_interval: 0.5,
        match_mode: 'all',
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://omen:9876/wait',
        {
          mode: 'process',
          name: 'Taskmgr',
          conditions: [{ type: 'state', name: 'Run', expected_state: 'enabled' }],
          timeout_seconds: 12,
          poll_interval_seconds: 0.5,
          match_mode: 'all',
        },
        30000,
      );
      expect(getTextContent(result)).toContain('**Success:** Yes');
      expect(getTextContent(result)).toContain('**Elapsed:** 2.25s');
      expect(getTextContent(result)).toContain('- ✓ **state** Run');
    });

    it('rejects missing conditions', async () => {
      const result = await analysis.handlePeekWait({ process: 'Taskmgr' });

      expectError(
        result,
        ErrorCodes.MISSING_REQUIRED_PARAM.code,
        'conditions is required and must be a non-empty array',
      );
    });
  });

  describe('handlePeekOcr', () => {
    it('renders OCR text, confidence, and line bounds', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
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

      const result = await analysis.handlePeekOcr({
        process: 'Taskmgr',
        region: { x: 12, y: 8, w: 64, h: 16 },
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://omen:9876/ocr',
        {
          mode: 'process',
          name: 'Taskmgr',
          region: { x: 12, y: 8, w: 64, h: 16 },
        },
        15000,
      );
      expect(getTextContent(result)).toContain('**Region:** x=12 y=8 w=64 h=16');
      expect(getTextContent(result)).toContain('**Confidence:** 97%');
      expect(getTextContent(result)).toContain('### Extracted Text');
      expect(getTextContent(result)).toContain('"CPU 24%" (confidence: 97, bounds: 12,8 64x16)');
    });

    it('returns an operation-failed error when OCR reports an error', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({ data: { error: 'OCR engine unavailable' } });

      const result = await analysis.handlePeekOcr({ process: 'Taskmgr' });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'OCR engine unavailable');
    });
  });

  describe('handlePeekAssert', () => {
    it('renders mixed assertion results and actual values for failures', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          passed: false,
          passed_count: 1,
          total: 2,
          results: [
            {
              passed: true,
              message: 'Element was found',
              assertion: { type: 'exists', name: 'Run', exact: true },
            },
            {
              passed: false,
              message: 'Unexpected state',
              actual: { enabled: false },
              assertion: {
                type: 'state',
                automation_id: 'run-btn',
                expected_state: 'enabled',
              },
            },
          ],
        },
      });

      const result = await analysis.handlePeekAssert({
        process: 'Taskmgr',
        assertions: [
          { type: 'exists', name: 'Run', exact: true },
          { type: 'state', automation_id: 'run-btn', expected_state: 'enabled' },
        ],
      });

      expect(getTextContent(result)).toContain('**Overall:** FAIL (1/2 passed)');
      expect(getTextContent(result)).toContain('✅ **exists name="Run" exact=true**');
      expect(getTextContent(result)).toContain('❌ **state id="run-btn" state=enabled**');
      expect(getTextContent(result)).toContain('Actual: {"enabled":false}');
    });

    it('rejects empty assertions', async () => {
      const result = await analysis.handlePeekAssert({
        process: 'Taskmgr',
        assertions: [],
      });

      expectError(
        result,
        ErrorCodes.MISSING_REQUIRED_PARAM.code,
        'assertions is required and must be a non-empty array',
      );
    });
  });

  describe('handlePeekHitTest', () => {
    it('renders the hit element metadata', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
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

      const result = await analysis.handlePeekHitTest({
        title: 'Task Manager',
        x: 50,
        y: 27,
      });

      expect(getTextContent(result)).toContain('**Coordinates:** (50, 27)');
      expect(getTextContent(result)).toContain('**Element:** Run (Button)');
      expect(getTextContent(result)).toContain('**Automation ID:** run-btn');
      expect(getTextContent(result)).toContain('**Path:** Window > Toolbar > Run');
      expect(getTextContent(result)).toContain('**Enabled:** false');
    });

    it('rejects missing hit-test coordinates', async () => {
      const result = await analysis.handlePeekHitTest({ process: 'Taskmgr', x: 50 });

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'x and y coordinates are required');
    });
  });

  describe('handlePeekColor', () => {
    it('renders color samples for named element positions', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          element_bounds: { x: 10, y: 12, w: 120, h: 50 },
          samples: {
            center: { x: 70, y: 37, hex: '#112233', r: 17, g: 34, b: 51 },
            top_left: { x: 10, y: 12, error: 'out of bounds' },
          },
        },
      });

      const result = await analysis.handlePeekColor({
        process: 'Taskmgr',
        element: { automation_id: 'summary-pane' },
      });

      expect(getTextContent(result)).toContain('**Element bounds:** x=10 y=12 w=120 h=50');
      expect(getTextContent(result)).toContain('- **center:** (70, 37) → #112233 (R=17 G=34 B=51)');
      expect(getTextContent(result)).toContain('- **top_left:** (10, 12) — out of bounds');
    });

    it('renders sampled colors for explicit points', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          count: 2,
          samples: [
            { x: 5, y: 7, hex: '#ffffff', r: 255, g: 255, b: 255 },
            { x: 8, y: 9, error: 'transparent pixel' },
          ],
        },
      });

      const result = await analysis.handlePeekColor({
        title: 'Task Manager',
        points: [{ x: 5, y: 7 }, { x: 8, y: 9 }],
      });

      expect(getTextContent(result)).toContain('**Points sampled:** 2');
      expect(getTextContent(result)).toContain('- (5, 7) → #ffffff (R=255 G=255 B=255)');
      expect(getTextContent(result)).toContain('- (8, 9) — transparent pixel');
    });

    it('rejects requests that omit both element and points', async () => {
      const result = await analysis.handlePeekColor({ process: 'Taskmgr' });

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'peek_color requires element or points');
    });
  });

  describe('handlePeekTable', () => {
    it('renders a markdown table and truncates after fifty rows', async () => {
      const rows = Array.from({ length: 52 }, (_value, index) => ({
        cells: [`Row ${index + 1}`, `Value ${index + 1}`],
      }));
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
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

      const result = await analysis.handlePeekTable({
        process: 'Taskmgr',
        table_name: 'Processes',
        depth: 2,
      });

      expect(getTextContent(result)).toContain('## Table: Processes');
      expect(getTextContent(result)).toContain('**Rows:** 52 | **Columns:** 2');
      expect(getTextContent(result)).toContain('**Headers:** Name | Value');
      expect(getTextContent(result)).toContain('**Selected rows:** 2, 5');
      expect(getTextContent(result)).toContain('| Name | Value |');
      expect(getTextContent(result)).toContain('| Row 50 | Value 50 |');
      expect(getTextContent(result)).toContain('... and 2 more rows');
    });

    it('returns an operation-failed error when table extraction fails', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({ error: 'connection reset' });

      const result = await analysis.handlePeekTable({ process: 'Taskmgr' });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'peek_table failed: connection reset');
    });
  });

  describe('handlePeekSummary', () => {
    it('renders a scene summary with lists, inputs, text, and prose summary', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
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

      const result = await analysis.handlePeekSummary({
        process: 'Taskmgr',
        depth: 2,
      });

      expect(getTextContent(result)).toContain('## Scene Summary');
      expect(getTextContent(result)).toContain('**Buttons:** Run new task, End task');
      expect(getTextContent(result)).toContain('  - Search: "CPU"');
      expect(getTextContent(result)).toContain('**Tabs:** Processes, Performance');
      expect(getTextContent(result)).toContain('  - Processes: 8 items');
      expect(getTextContent(result)).toContain('  - CPU');
      expect(getTextContent(result)).toContain('**Summary:** Task Manager is focused on performance metrics.');
    });
  });

  describe('handlePeekCdp', () => {
    it('renders CDP status including open tabs', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          cdp_available: true,
          port: 9333,
          targets: [
            { title: 'Docs', url: 'https://example.test/docs' },
            { title: 'Dashboard', url: 'https://example.test/dashboard' },
          ],
        },
      });

      const result = await analysis.handlePeekCdp({
        action: 'status',
        port: 9333,
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://omen:9876/cdp',
        {
          action: 'status',
          port: 9333,
          url: '',
          title: '',
          expression: '',
          timeout: 15,
          depth: 3,
        },
        15000,
      );
      expect(getTextContent(result)).toContain('## peek_cdp — status');
      expect(getTextContent(result)).toContain('**CDP Available:** Yes');
      expect(getTextContent(result)).toContain('**Open Tabs:** 2');
      expect(getTextContent(result)).toContain('- Docs — https://example.test/docs');
    });

    it('returns an operation-failed error when CDP responds with an error', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: { error: 'evaluation crashed' },
      });

      const result = await analysis.handlePeekCdp({
        action: 'evaluate',
        expression: 'document.title',
      });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'CDP error: evaluation crashed');
    });
  });

  describe('handlePeekRegression', () => {
    it('lists available snapshot directories and window counts', async () => {
      const regressionRoot = path.join(tempHomeDir, '.peek-ui', 'regression');
      const latestDir = path.join(regressionRoot, '2026-03-11T10-00-00');
      const olderDir = path.join(regressionRoot, '2026-03-10T10-00-00');
      fs.mkdirSync(latestDir, { recursive: true });
      fs.mkdirSync(olderDir, { recursive: true });
      fs.writeFileSync(path.join(latestDir, 'metadata.json'), JSON.stringify({ windows: [{}, {}, {}] }));
      fs.writeFileSync(path.join(olderDir, 'metadata.json'), JSON.stringify({ windows: [{}] }));

      const result = await analysis.handlePeekRegression({ action: 'list' });

      expect(getTextContent(result)).toContain('## peek_regression: snapshots');
      expect(getTextContent(result)).toContain('| 2026-03-11T10-00-00 | 3 |');
      expect(getTextContent(result)).toContain('| 2026-03-10T10-00-00 | 1 |');
      expect(mockShared.peekHttpGetWithRetry).not.toHaveBeenCalled();
    });

    it('creates a snapshot directory, metadata file, and window captures', async () => {
      const imageB64 = Buffer.from('png-image').toString('base64');
      mockShared.peekHttpGetWithRetry
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

      const result = await analysis.handlePeekRegression({ action: 'snapshot' });
      const regressionRoot = path.join(tempHomeDir, '.peek-ui', 'regression');
      const [snapshotId] = fs.readdirSync(regressionRoot);
      const snapshotDir = path.join(regressionRoot, snapshotId);
      const metadata = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'metadata.json'), 'utf8'));

      expect(metadata.host).toBe('omen');
      expect(metadata.windows).toEqual([
        expect.objectContaining({
          key: 'taskmgr-task-manager',
          process: 'Taskmgr',
          title: 'Task Manager',
          file: 'taskmgr-task-manager.png',
          width: 800,
          height: 600,
        }),
        expect.objectContaining({
          key: 'calc-calculator',
          process: 'Calc',
          title: 'Calculator',
          file: 'calc-calculator.png',
          width: 640,
          height: 480,
        }),
      ]);
      expect(fs.existsSync(path.join(snapshotDir, 'taskmgr-task-manager.png'))).toBe(true);
      expect(fs.existsSync(path.join(snapshotDir, 'calc-calculator.png'))).toBe(true);
      expect(getTextContent(result)).toContain('## peek_regression: snapshot');
      expect(getTextContent(result)).toContain('**Windows Captured:** 2/2');
    });

    it('compares a stored baseline and includes diff imagery for changed windows', async () => {
      const regressionRoot = path.join(tempHomeDir, '.peek-ui', 'regression');
      const snapshotId = '2026-03-11T11-00-00';
      const snapshotDir = path.join(regressionRoot, snapshotId);
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
      );
      fs.writeFileSync(path.join(snapshotDir, 'taskmgr-task-manager.png'), Buffer.from('baseline-image'));

      mockShared.peekHttpGetWithRetry
        .mockResolvedValueOnce({ data: { windows: [{ process: 'Taskmgr' }] } })
        .mockResolvedValueOnce({ data: { image: Buffer.from('current-image').toString('base64') } });
      mockShared.postCompareWithRetry.mockResolvedValue({
        data: {
          diff_percent: 0.05,
          changed_pixels: 512,
          has_differences: true,
        },
      });

      const result = await analysis.handlePeekRegression({
        action: 'compare',
        snapshot_id: snapshotId,
        diff_threshold: 0.05,
        ignore_regions: [{ x: 1, y: 2, w: 3, h: 4 }],
      });

      expect(mockShared.postCompareWithRetry).toHaveBeenCalledWith(
        'http://omen:9876',
        Buffer.from('baseline-image').toString('base64'),
        Buffer.from('current-image').toString('base64'),
        0.05,
        60000,
        2,
        [{ x: 1, y: 2, w: 3, h: 4 }],
      );
      expect(result.content).toEqual([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('## peek_regression: compare') }),
        expect.objectContaining({ type: 'text', text: '### Diff: Taskmgr — Task Manager' }),
        expect.objectContaining({ type: 'image', data: 'diff-image-b64', mimeType: 'image/png' }),
      ]);
      expect(getTextContent(result)).toContain('| Taskmgr — Task Manager | CHANGED | 5.00% | 512 |');
      expect(getTextContent(result)).toContain('**Summary:** 1 changed, 0 unchanged, 0 failed');
    });

    it('returns an invalid-param error when compare is requested without snapshots', async () => {
      mockShared.peekHttpGetWithRetry.mockResolvedValue({
        data: { windows: [{ process: 'Taskmgr' }] },
      });

      const result = await analysis.handlePeekRegression({ action: 'compare' });

      expectError(
        result,
        ErrorCodes.INVALID_PARAM.code,
        'No snapshots found. Run peek_regression with action "snapshot" first.',
      );
      expect(mockShared.postCompareWithRetry).not.toHaveBeenCalled();
    });
  });

  describe('handlePeekDiagnose', () => {
    it('renders bundle metadata, text sections, screenshots, and artifact references', async () => {
      const refs = [
        {
          kind: 'bundle_json',
          path: path.join(tempHomeDir, 'bundle.json'),
          artifact_id: 'artifact-1',
        },
      ];
      mockContracts.buildPeekBundleArtifactReferences.mockReturnValue(refs);
      mockArtifacts.persistPeekResultReferences.mockReturnValue(refs);
      mockShared.resolvePeekTaskContext.mockReturnValue({
        task: null,
        taskId: 'task-123',
        workflowId: 'wf-123',
        taskLabel: 'peek-diagnose',
      });
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          screenshot: 'raw-image-b64',
          annotated_screenshot: 'annotated-image-b64',
          format: 'png',
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
                expand_state: 'expanded',
                scroll_position: { vertical_percent: 40 },
                range_value: { current: 2, maximum: 8 },
                children: [],
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
            element_summary: [{ name: 'CPU', type: 'Text', bounds: { x: 12, y: 14, w: 50, h: 18 } }],
          },
          text_content: {
            summary: 'Performance overview',
            inputs: [{ name: 'Search', automation_id: 'search', value: 'cpu' }],
            labels_and_values: [{ label: 'CPU', value: '24%' }],
            by_type: {
              label: ['CPU', 'Memory'],
              input: [{ name: 'Search', value: 'cpu' }],
            },
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

      const result = await analysis.handlePeekDiagnose({
        process: 'Taskmgr',
        annotate: true,
        elements: true,
        measurements: true,
        text_content: true,
        format: 'png',
        quality: 80,
        max_width: 1280,
      });

      expect(mockContracts.buildPeekDiagnosePayload).toHaveBeenCalledWith({
        process: 'Taskmgr',
        annotate: true,
        elements: true,
        measurements: true,
        text_content: true,
        format: 'png',
        quality: 80,
        max_width: 1280,
      });
      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://omen:9876/diagnose',
        {
          mode: 'process',
          name: 'Taskmgr',
          annotate: true,
          elements: true,
          measurements: true,
          text_content: true,
          format: 'png',
          quality: 80,
          max_width: 1280,
          persist: true,
          output_dir: path.join(tempHomeDir, 'persisted-output'),
        },
        30000,
      );
      expect(mockArtifacts.applyEvidenceStateToBundle).toHaveBeenCalledWith({ id: 'bundle-1' }, { sufficient: true });
      expect(mockArtifacts.ensurePeekBundlePersistence).toHaveBeenCalledWith(
        { id: 'bundle-1' },
        path.join(tempHomeDir, 'persisted-output'),
        expect.objectContaining({ process: 'Taskmgr' }),
      );
      expect(result).toMatchObject({
        evidence_state: 'complete',
        evidence_sufficiency: { sufficient: true },
        missing_evidence_fields: [],
        peek_bundle_artifacts: refs,
      });
      expect(result.content).toEqual([
        expect.objectContaining({ type: 'image', data: 'raw-image-b64', mimeType: 'image/png' }),
        expect.objectContaining({ type: 'image', data: 'annotated-image-b64', mimeType: 'image/png' }),
        expect.objectContaining({ type: 'text', text: expect.any(String) }),
      ]);
      expect(getTextContent(result, 2)).toContain('**Evidence State:** complete');
      expect(getTextContent(result, 2)).toContain('**Bundle Contract:** peek_investigation_bundle v1');
      expect(getTextContent(result, 2)).toContain('- **Summary** `Pane` [summary-pane] (0,0 400x200) = "CPU" {disabled, on, selected, expanded, scroll:40%, range:2/8}');
      expect(getTextContent(result, 2)).toContain('### Focused Element');
      expect(getTextContent(result, 2)).toContain('- Search [search] = "cpu"');
      expect(getTextContent(result, 2)).toContain('- CPU "24%"');
      expect(getTextContent(result, 2)).toContain('- **label:** CPU, Memory');
      expect(getTextContent(result, 2)).toContain('- **input:** Search="cpu"');
      expect(getTextContent(result, 2)).toContain('- **CPU** ↔ **Memory**: gap_x=10px, gap_y=4px (horizontal)');
      expect(getTextContent(result, 2)).toContain('- **1** — CPU `Text` [cpu-value] (12,14 50x18)');
      expect(getTextContent(result, 2)).toContain('### Artifacts');
    });

    it('returns a missing-param error when the diagnose payload cannot be built', async () => {
      mockContracts.buildPeekDiagnosePayload.mockImplementation(() => {
        throw new Error('peek_diagnose requires process or title');
      });

      const result = await analysis.handlePeekDiagnose({ annotate: true });

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'peek_diagnose requires process or title');
      expect(mockShared.peekHttpPostWithRetry).not.toHaveBeenCalled();
    });

    it('returns an operation-failed error when the diagnose request fails', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({ error: 'peek service unavailable' });

      const result = await analysis.handlePeekDiagnose({ process: 'Taskmgr' });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'peek_diagnose failed: peek service unavailable');
    });

    it('runs the canonical diagnose-and-bundle flow through classification, persistence, and artifact references', async () => {
      const harness = createDiagnoseIntegrationHarness(tempHomeDir);
      const bundle = cloneValue(harness.fixtures.WPF_FIXTURE);
      const bundlePath = path.join(harness.persistOutputDir, 'bundle.json');
      const artifactReportPath = path.join(harness.persistOutputDir, 'artifact-report.json');

      fs.mkdirSync(harness.persistOutputDir, { recursive: true });
      fs.writeFileSync(artifactReportPath, JSON.stringify({ status: 'ok' }, null, 2), 'utf8');
      bundle.artifacts.artifact_report_path = artifactReportPath;

      expect(harness.artifacts.classifyEvidenceSufficiency(bundle)).toEqual({ sufficient: true });

      harness.sharedModule.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          screenshot: bundle.capture_data.image_base64,
          annotated_screenshot: bundle.evidence.annotated_screenshot.data,
          annotation_index: bundle.evidence.annotation_index,
          bundle,
          elements: bundle.evidence.elements,
          format: 'png',
          measurements: bundle.evidence.measurements,
          text_content: bundle.evidence.text_content,
        },
      });

      const result = await harness.analysis.handlePeekDiagnose({
        process: 'LedgerPro.Desktop.exe',
        annotate: true,
        elements: true,
        format: 'png',
        measurements: true,
        text_content: true,
      });

      expect(harness.sharedModule.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://omen:9876/diagnose',
        expect.objectContaining({
          annotate: true,
          elements: true,
          format: 'png',
          measurements: true,
          mode: 'process',
          name: 'LedgerPro.Desktop.exe',
          output_dir: harness.persistOutputDir,
          persist: true,
          text_content: true,
        }),
        30000,
      );
      expect(result.isError).toBeFalsy();
      expect(result.evidence_state).toBe('complete');
      expect(result.evidence_sufficiency).toEqual({ sufficient: true });
      expect(result.evidence_sufficiency).not.toHaveProperty('confidence');
      expect(result.missing_evidence_fields).toEqual([]);
      expect(result.peek_bundle_artifacts).toEqual([
        expect.objectContaining({
          artifact_id: expect.any(String),
          contract: expect.objectContaining({
            name: 'peek_investigation_bundle',
            persisted: true,
            version: 1,
          }),
          host: 'omen',
          kind: 'bundle_json',
          path: bundlePath,
          target: 'LedgerPro.Desktop.exe',
          task_id: 'task-123',
          workflow_id: 'wf-123',
        }),
        expect.objectContaining({
          artifact_id: expect.any(String),
          kind: 'artifact_report',
          path: artifactReportPath,
          task_id: 'task-123',
          workflow_id: 'wf-123',
        }),
      ]);

      const persistedBundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
      expect(harness.contracts.validatePeekInvestigationBundleEnvelope(persistedBundle)).toEqual([]);
      expect(persistedBundle.evidence_state).toBe('complete');
      expect(persistedBundle.evidence_sufficiency).toEqual({ sufficient: true });
      expect(persistedBundle.missing_evidence_fields).toEqual([]);
      expect(persistedBundle.artifacts).toEqual(expect.objectContaining({
        artifact_report_path: artifactReportPath,
        bundle_path: bundlePath,
        persisted: true,
      }));

      expect(harness.dbMock.storeArtifact).toHaveBeenCalledTimes(2);
      expect(harness.dbMock.storeArtifact.mock.calls[0][0]).toMatchObject({
        file_path: bundlePath,
        metadata: expect.objectContaining({
          evidence_state: 'complete',
          evidence_sufficiency: { sufficient: true },
          missing_evidence_fields: [],
          workflow_id: 'wf-123',
        }),
        mime_type: 'application/json',
        task_id: 'task-123',
      });
      expect(harness.dbMock.updateTask).toHaveBeenCalledWith('task-123', expect.objectContaining({
        metadata: expect.any(Object),
      }));
      expect(harness.dbMock.updateWorkflow).toHaveBeenCalledWith('wf-123', expect.objectContaining({
        context: expect.any(Object),
      }));
      expect(
        harness.contracts.getPeekArtifactReferences(harness.dbMock.updateTask.mock.calls[0][1].metadata),
      ).toEqual(result.peek_bundle_artifacts);
      expect(
        harness.contracts.getPeekArtifactReferences(harness.dbMock.updateWorkflow.mock.calls[0][1].context),
      ).toEqual(result.peek_bundle_artifacts);
      expect(getCombinedText(result)).toContain('**Evidence State:** complete');
      expect(getCombinedText(result)).toContain('### Bundle Artifacts');
      expect(getCombinedText(result)).toContain(bundlePath);
    });

    it('classifies partial evidence as low-confidence insufficient and persists missing fields', async () => {
      const harness = createDiagnoseIntegrationHarness(tempHomeDir);
      const bundle = cloneValue(harness.fixtures.WPF_FIXTURE);
      const bundlePath = path.join(harness.persistOutputDir, 'bundle.json');

      bundle.visual_tree = null;

      expect(harness.artifacts.classifyEvidenceSufficiency(bundle)).toEqual(expect.objectContaining({
        confidence: 'low',
        missing: expect.arrayContaining(['visual_tree']),
        sufficient: false,
      }));

      harness.sharedModule.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          screenshot: bundle.capture_data.image_base64,
          bundle,
          elements: bundle.evidence.elements,
          format: 'png',
          measurements: bundle.evidence.measurements,
          text_content: bundle.evidence.text_content,
        },
      });

      const result = await harness.analysis.handlePeekDiagnose({
        process: 'LedgerPro.Desktop.exe',
        annotate: false,
        elements: true,
        format: 'png',
        measurements: true,
        text_content: true,
      });

      expect(result.isError).toBeFalsy();
      expect(result.evidence_state).toBe('insufficient');
      expect(result.evidence_sufficiency).toEqual(expect.objectContaining({
        confidence: 'low',
        missing: expect.arrayContaining(['visual_tree']),
        sufficient: false,
      }));
      expect(result.missing_evidence_fields).toEqual(expect.arrayContaining(['visual_tree']));
      expect(result.peek_bundle_artifacts).toEqual([
        expect.objectContaining({
          kind: 'bundle_json',
          path: bundlePath,
        }),
      ]);

      const persistedBundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
      expect(persistedBundle.evidence_state).toBe('insufficient');
      expect(persistedBundle.evidence_sufficiency).toEqual(expect.objectContaining({
        confidence: 'low',
        missing: expect.arrayContaining(['visual_tree']),
        sufficient: false,
      }));
      expect(persistedBundle.missing_evidence_fields).toEqual(expect.arrayContaining(['visual_tree']));
      expect(harness.dbMock.storeArtifact).toHaveBeenCalledTimes(1);
      expect(getCombinedText(result)).toContain('**Evidence State:** insufficient');
      expect(getCombinedText(result)).toContain('**Missing Evidence:** visual_tree');
    });

    it('returns an operation-failed error for contract-invalid bundle responses', async () => {
      const harness = createDiagnoseIntegrationHarness(tempHomeDir);
      const bundle = cloneValue(harness.fixtures.WPF_FIXTURE);

      bundle.artifacts.signed = 'nope';
      harness.sharedModule.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          bundle,
          format: 'png',
        },
      });

      const result = await harness.analysis.handlePeekDiagnose({
        process: 'LedgerPro.Desktop.exe',
      });

      expectError(
        result,
        ErrorCodes.OPERATION_FAILED.code,
        'peek_diagnose returned malformed bundle: artifacts.signed must be a boolean',
      );
      expect(harness.fsProxy.writeFileSync).not.toHaveBeenCalled();
      expect(harness.dbMock.storeArtifact).not.toHaveBeenCalled();
    });

    it('returns an operation-failed error when the diagnose response omits bundle data', async () => {
      const harness = createDiagnoseIntegrationHarness(tempHomeDir);

      harness.sharedModule.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          format: 'png',
          screenshot: 'screenshot-b64',
        },
      });

      const result = await harness.analysis.handlePeekDiagnose({
        process: 'LedgerPro.Desktop.exe',
      });

      expectError(
        result,
        ErrorCodes.OPERATION_FAILED.code,
        'peek_diagnose returned malformed response: bundle is required',
      );
      expect(harness.fsProxy.writeFileSync).not.toHaveBeenCalled();
      expect(harness.dbMock.storeArtifact).not.toHaveBeenCalled();
    });

    it('returns an internal error when the diagnose request times out', async () => {
      const harness = createDiagnoseIntegrationHarness(tempHomeDir);

      harness.sharedModule.peekHttpPostWithRetry.mockRejectedValue(new Error('socket timeout'));

      const result = await harness.analysis.handlePeekDiagnose({
        process: 'LedgerPro.Desktop.exe',
      });

      expectError(result, ErrorCodes.INTERNAL_ERROR.code, 'socket timeout');
      expect(harness.dbMock.storeArtifact).not.toHaveBeenCalled();
    });
  });

  describe('handlePeekSemanticDiff', () => {
    it('renders semantic diff counts, changes, and an optional screenshot', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          screenshot: 'semantic-screenshot-b64',
          summary: '2 changes detected',
          matched_count: 8,
          unmatched_baseline: 1,
          unmatched_current: 1,
          changes: [
            {
              type: 'added',
              element: { name: 'GPU', type: 'Text' },
            },
            {
              type: 'moved',
              element: { automation_id: 'cpu-value', type: 'Text' },
              from: { x: 10, y: 20 },
              to: { x: 15, y: 30 },
              delta: { x: 5, y: 10 },
            },
            {
              type: 'text_changed',
              element: { name: 'CPU', type: 'Text' },
              from_value: '24%',
              to_value: '29%',
            },
          ],
        },
      });

      const result = await analysis.handlePeekSemanticDiff({
        process: 'Taskmgr',
        baseline_elements: [{ name: 'CPU', type: 'Text' }],
        match_strategy: 'automation_id',
        include_screenshot: true,
        format: 'png',
        quality: 90,
        max_width: 1200,
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://omen:9876/semantic-diff',
        {
          mode: 'process',
          name: 'Taskmgr',
          baseline_elements: [{ name: 'CPU', type: 'Text' }],
          match_strategy: 'automation_id',
          include_screenshot: true,
          format: 'png',
          quality: 90,
          max_width: 1200,
        },
        30000,
      );
      expect(result.content).toEqual([
        expect.objectContaining({ type: 'image', data: 'semantic-screenshot-b64', mimeType: 'image/png' }),
        expect.objectContaining({ type: 'text', text: expect.any(String) }),
      ]);
      expect(getTextContent(result, 1)).toContain('**Summary:** 2 changes detected');
      expect(getTextContent(result, 1)).toContain('- **+ ADDED** `GPU` (Text)');
      expect(getTextContent(result, 1)).toContain('- **↔ MOVED** `cpu-value` (Text) from (10,20) to (15,30) [Δ5,Δ10]');
      expect(getTextContent(result, 1)).toContain('- **✎ TEXT** `CPU` (Text): "24%" → "29%"');
    });

    it('rejects missing baseline elements', async () => {
      const result = await analysis.handlePeekSemanticDiff({
        process: 'Taskmgr',
      });

      expectError(
        result,
        ErrorCodes.MISSING_REQUIRED_PARAM.code,
        'baseline_elements is required and must be an array of element tree nodes',
      );
    });
  });

  describe('handlePeekActionSequence', () => {
    it('renders step results and emits capture images', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          success: true,
          steps_completed: 3,
          steps_total: 3,
          elapsed_seconds: 3.5,
          step_results: [
            {
              step: 1,
              action: 'capture',
              success: true,
              image: 'capture-b64',
              width: 1280,
              height: 720,
              format: 'png',
            },
            {
              step: 2,
              action: 'wait',
              success: true,
              elapsed: 1.25,
            },
            {
              step: 3,
              action: 'sleep',
              success: true,
              seconds: 2,
            },
          ],
        },
      });

      const result = await analysis.handlePeekActionSequence({
        process: 'Taskmgr',
        steps: [
          { action: 'capture' },
          { action: 'wait' },
          { action: 'sleep' },
        ],
      });

      expect(result.content).toEqual([
        expect.objectContaining({ type: 'image', data: 'capture-b64', mimeType: 'image/png' }),
        expect.objectContaining({ type: 'text', text: expect.any(String) }),
      ]);
      expect(getTextContent(result, 1)).toContain('**Success:** Yes');
      expect(getTextContent(result, 1)).toContain('**Steps:** 3/3');
      expect(getTextContent(result, 1)).toContain('- ✓ **Step 1** `capture` 1280x720 png');
      expect(getTextContent(result, 1)).toContain('- ✓ **Step 2** `wait` waited 1.25s');
      expect(getTextContent(result, 1)).toContain('- ✓ **Step 3** `sleep` 2s');
    });

    it('rejects empty step sequences', async () => {
      const result = await analysis.handlePeekActionSequence({
        process: 'Taskmgr',
        steps: [],
      });

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'steps is required and must be a non-empty array');
    });
  });

  describe('peek analysis helper coverage', () => {
    describe('resolvePeekWindowTarget', () => {
      it('prefers process over title when both are supplied', () => {
        const resolved = analysisHelpers.resolvePeekWindowTarget(
          { process: 'Taskmgr', title: 'Task Manager' },
          'peek_wait',
        );

        expect(resolved).toEqual({ mode: 'process', name: 'Taskmgr' });
      });

      it('uses title when process is not supplied', () => {
        const resolved = analysisHelpers.resolvePeekWindowTarget(
          { title: 'Task Manager' },
          'peek_wait',
        );

        expect(resolved).toEqual({ mode: 'title', name: 'Task Manager' });
      });

      it('throws when process and title are both missing', () => {
        expect(() => analysisHelpers.resolvePeekWindowTarget({}, 'peek_wait')).toThrow('peek_wait requires process or title');
      });
    });

    describe('renderDiagnoseElementTree', () => {
      it('handles an empty tree', () => {
        const lines = [];
        analysisHelpers.renderDiagnoseElementTree(lines, [], '');

        expect(lines).toEqual([]);
      });

      it('renders nested nodes and preserves special characters in text fields', () => {
        const lines = [];
        analysisHelpers.renderDiagnoseElementTree(lines, [
          {
            name: '<Window "Root">',
            type: 'Window',
            automation_id: 'root-id',
            bounds: { x: 10, y: 20, w: 300, h: 40 },
            value: 'Root "primary" value',
            state: ['focused', 'hot'],
            children: [
              {
                name: 'Child & Details',
                type: 'Button',
                automation_id: 'child-id',
                bounds: { x: 12, y: 22, w: 50, h: 18 },
                value: 'Open "Logs"',
                state: ['selected'],
              },
            ],
          },
        ], '');

        expect(lines).toEqual([
          '- **<Window "Root">** `Window` [root-id] (10,20 300x40) = "Root "primary" value" {focused, hot}',
          '  - **Child & Details** `Button` [child-id] (12,22 50x18) = "Open "Logs"" {selected}',
        ]);
      });

      it('renders implicit state flags when explicit state is not present', () => {
        const lines = [];
        analysisHelpers.renderDiagnoseElementTree(lines, [
          {
            name: 'Panel',
            type: 'Panel',
            automation_id: 'panel-id',
            bounds: { x: 0, y: 0, w: 100, h: 20 },
            enabled: false,
            toggle_state: 'on',
            is_selected: true,
            expand_state: 'expanded',
            scroll_position: { vertical_percent: 33 },
            range_value: { current: 3, maximum: 10 },
          },
        ], '');

        expect(lines[0]).toContain('- **Panel** `Panel` [panel-id] (0,0 100x20) {disabled, on, selected, expanded, scroll:33%, range:3/10}');
      });
    });

    describe('renderPeekElementsTree', () => {
      it('handles an empty tree', () => {
        const lines = [];
        analysisHelpers.renderPeekElementsTree(lines, [], '');

        expect(lines).toEqual([]);
      });

      it('renders disabled elements with combined state flags', () => {
        const lines = [];
        analysisHelpers.renderPeekElementsTree(lines, [
          {
            name: 'Control',
            type: 'CheckBox',
            automation_id: 'chk-control',
            bounds: { x: 4, y: 6, w: 12, h: 8 },
            value: 'Auto-refresh',
            enabled: false,
            toggle_state: 'on',
            is_selected: true,
            expand_state: 'expanded',
            scroll_position: { vertical_percent: 12 },
            range_value: { current: 1, maximum: 2 },
          },
        ], '');

        expect(lines[0]).toContain('Control');
        expect(lines[0]).toContain('[DISABLED]');
        expect(lines[0]).toContain('{on, selected, expanded, scroll:12%, range:1/2}');
      });

      it('renders nested nodes and supports empty-string values', () => {
        const lines = [];
        analysisHelpers.renderPeekElementsTree(lines, [
          {
            name: 'Parent',
            type: 'Group',
            automation_id: 'group-1',
            bounds: { x: 1, y: 2, w: 30, h: 10 },
            value: 'group',
            children: [
              {
                name: 'Child',
                type: 'Text',
                bounds: { x: 5, y: 6, w: 10, h: 4 },
                value: '',
              },
            ],
          },
        ], '');

        expect(lines).toEqual([
          'Parent [Group] id="group-1" value="group" [DISABLED] (1,2 30x10)',
          '  Child [Text] value="" [DISABLED] (5,6 10x4)',
        ]);
      });
    });
  });

  describe('additional handler edge cases and error paths', () => {
    it('resolves title-mode targets for peek elements browse mode', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          window: { name: 'Task Manager' },
          count: 0,
          elements: [],
        },
      });

      const result = await analysis.handlePeekElements({ title: 'Task Manager' });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://omen:9876/elements',
        { mode: 'title', name: 'Task Manager', depth: 3 },
        15000,
      );
      expect(getTextContent(result)).toContain('**Window:** Task Manager');
      expect(getTextContent(result)).toContain('**Total Elements:** 0');
    });

    it('returns internal error for peek_elements HTTP failures', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({ error: 'endpoint unavailable' });

      const result = await analysis.handlePeekElements({ process: 'Taskmgr' });

      expectError(result, ErrorCodes.INTERNAL_ERROR.code, 'Element inspection failed: endpoint unavailable');
    });

    it('handles missing peek_elements response payloads as empty trees', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({});

      const result = await analysis.handlePeekElements({ process: 'Taskmgr' });

      expectError(result, ErrorCodes.INTERNAL_ERROR.code, "Cannot read properties of undefined (reading 'window')");
    });

    it('resolves title targets for wait and returns conditions with match mode', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          success: true,
          elapsed_seconds: 1.25,
          polls: 3,
          conditions_met: [{ met: true, detail: 'Matched', condition: { type: 'state', name: 'Focused' } }],
        },
      });

      const result = await analysis.handlePeekWait({
        title: 'Task Manager',
        conditions: [{ type: 'state', name: 'Focused' }],
        wait_timeout: 9,
        match_mode: 'all',
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://omen:9876/wait',
        {
          mode: 'title',
          name: 'Task Manager',
          conditions: [{ type: 'state', name: 'Focused' }],
          timeout_seconds: 9,
          match_mode: 'all',
        },
        30000,
      );
      expect(getTextContent(result)).toContain('**Target:** Task Manager');
      expect(getTextContent(result)).toContain('### Conditions');
    });

    it('returns missing-param for peek_wait when target is omitted', async () => {
      const result = await analysis.handlePeekWait({ conditions: [{ type: 'state', name: 'Focused' }] });

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'peek_wait requires process or title');
    });

    it('returns operation-failed for peek_wait HTTP request errors', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({ error: 'timeout contacting host' });

      const result = await analysis.handlePeekWait({
        process: 'Taskmgr',
        conditions: [{ type: 'state', name: 'Focused' }],
      });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'peek_wait failed: timeout contacting host');
    });

    it('returns internal error for peek_ocr request timeouts', async () => {
      mockShared.peekHttpPostWithRetry.mockRejectedValue(new Error('socket timeout'));

      const result = await analysis.handlePeekOcr({
        process: 'Taskmgr',
      });

      expectError(result, ErrorCodes.INTERNAL_ERROR.code, 'socket timeout');
    });

    it('returns default OCR output for malformed response payloads', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({});

      const result = await analysis.handlePeekOcr({
        process: 'Taskmgr',
      });

      expect(getTextContent(result)).toContain('**Confidence:** 0%');
      expect(getTextContent(result)).not.toContain('### Extracted Text');
      expect(getTextContent(result)).not.toContain('### Lines');
    });

    it('returns missing-param for peek_ocr when no target is provided', async () => {
      const result = await analysis.handlePeekOcr({ region: { x: 1, y: 2, w: 3, h: 4 } });

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'peek_ocr requires process or title');
    });

    it('returns operation-failed for peek_assert request failures', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({ error: 'assert service down' });

      const result = await analysis.handlePeekAssert({
        process: 'Taskmgr',
        assertions: [{ type: 'exists', name: 'Run' }],
      });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'peek_assert failed: assert service down');
    });

    it('returns operation-failed for peek_hit_test request failures', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({ error: 'hit-test failed' });

      const result = await analysis.handlePeekHitTest({
        process: 'Taskmgr',
        x: 12,
        y: 34,
      });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'peek_hit_test failed: hit-test failed');
    });

    it('uses sample array length when color point count is omitted', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          samples: [
            { x: 1, y: 2, hex: '#111111', r: 1, g: 1, b: 1 },
            { x: 3, y: 4, error: 'transparent pixel' },
          ],
        },
      });

      const result = await analysis.handlePeekColor({
        process: 'Taskmgr',
        points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
      });

      expect(getTextContent(result)).toContain('**Points sampled:** 2');
      expect(getTextContent(result)).toContain('(1, 2) → #111111');
      expect(getTextContent(result)).toContain('(3, 4) — transparent pixel');
    });

    it('returns operation-failed for peek_color request failures', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({ error: 'peek /color failed' });

      const result = await analysis.handlePeekColor({
        process: 'Taskmgr',
        element: { automation_id: 'btn-save' },
      });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'peek_color failed: peek /color failed');
    });

    it('handles empty table rows without rendering row lines', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          name: 'Empty',
          type: 'DataGrid',
          row_count: 0,
          column_count: 0,
          rows: [],
          columns: [],
        },
      });

      const result = await analysis.handlePeekTable({ process: 'Taskmgr' });

      expect(getTextContent(result)).toContain('**Rows:** 0 | **Columns:** 0');
      expect(getTextContent(result)).not.toContain('Row 1');
    });

    it('returns missing-param for peek_table when no target is supplied', async () => {
      const result = await analysis.handlePeekTable({ columns: ['Name', 'Type'] });

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'peek_table requires process or title');
    });

    it('returns operation-failed for peek_summary request failures', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({ error: 'summary service down' });

      const result = await analysis.handlePeekSummary({ process: 'Taskmgr' });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'peek_summary failed: summary service down');
    });

    it('returns missing-param for peek_summary when no target is provided', async () => {
      const result = await analysis.handlePeekSummary({});

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'peek_summary requires process or title');
    });

    it('renders evaluate mode output for peek_cdp', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          cdp_available: true,
          port: 9222,
          targets: [{ title: 'Dashboard', url: 'https://example.test/dashboard' }],
        },
      });

      const result = await analysis.handlePeekCdp({
        action: 'evaluate',
        expression: 'document.title',
      });

      expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
        'http://omen:9876/cdp',
        {
          action: 'evaluate',
          port: 9222,
          expression: 'document.title',
          url: '',
          title: '',
          timeout: 15,
          depth: 3,
        },
        15000,
      );
      expect(getTextContent(result)).toContain('## peek_cdp — evaluate');
    });

    it('returns operation-failed for peek_cdp if evaluation errors', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: { error: 'cdp handshake failed' },
      });

      const result = await analysis.handlePeekCdp({ action: 'status' });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'CDP error: cdp handshake failed');
    });

    it('handles malformed snapshot metadata JSON while listing regression snapshots', async () => {
      const regressionRoot = path.join(tempHomeDir, '.peek-ui', 'regression');
      const badSnapshot = path.join(regressionRoot, '2026-03-11T10-00-00');
      fs.mkdirSync(badSnapshot, { recursive: true });
      fs.writeFileSync(path.join(badSnapshot, 'metadata.json'), '{invalid-json}');

      const result = await analysis.handlePeekRegression({ action: 'list' });

      expect(getTextContent(result)).toContain('| 2026-03-11T10-00-00 | ? |');
      expect(mockShared.peekHttpGetWithRetry).not.toHaveBeenCalled();
    });

    it('returns operation-failed when diagnose artifact data omits the bundle envelope', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          text_content: {
            summary: 'diagnostic-only summary',
          },
        },
      });

      const result = await analysis.handlePeekDiagnose({
        process: 'Taskmgr',
      });

      expectError(
        result,
        ErrorCodes.OPERATION_FAILED.code,
        'peek_diagnose returned malformed response: bundle is required',
      );
    });

    it('renders no-changes output for semantic diff with empty change list', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({
        data: {
          matched_count: 2,
          unmatched_baseline: 0,
          unmatched_current: 0,
          changes: [],
        },
      });

      const result = await analysis.handlePeekSemanticDiff({
        process: 'Taskmgr',
        baseline_elements: [{ name: 'Window', type: 'Window' }],
      });

      expect(getTextContent(result)).toContain('**Matched:** 2 elements');
      expect(getTextContent(result)).toContain('No structural changes detected.');
    });

    it('returns internal error when semantic-diff payload is invalid JSON', async () => {
      mockShared.peekHttpPostWithRetry.mockRejectedValue(new Error('Unexpected token o in JSON at position 1'));

      const result = await analysis.handlePeekSemanticDiff({
        process: 'Taskmgr',
        baseline_elements: [{ name: 'Window', type: 'Window' }],
      });

      expectError(
        result,
        ErrorCodes.INTERNAL_ERROR.code,
        'Unexpected token o in JSON at position 1',
      );
    });

    it('returns operation-failed for action-sequence HTTP failures', async () => {
      mockShared.peekHttpPostWithRetry.mockResolvedValue({ error: 'sequence service down' });

      const result = await analysis.handlePeekActionSequence({
        process: 'Taskmgr',
        steps: [{ action: 'capture' }],
      });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'peek_action_sequence failed: sequence service down');
    });
  });
});
