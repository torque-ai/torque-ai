'use strict';

const mockDb = {
  captureTestBaseline: vi.fn(),
  getConfig: vi.fn(),
  detectRegressions: vi.fn(),
  captureConfigBaselines: vi.fn(),
  detectConfigDrift: vi.fn(),
  getTask: vi.fn(),
  getTaskFileChanges: vi.fn(),
  estimateResourceUsage: vi.fn(),
  checkI18n: vi.fn(),
  checkAccessibility: vi.fn(),
  getSafeguardToolConfigs: vi.fn(),
  verifyTypeReferences: vi.fn(),
  getTypeVerificationResults: vi.fn(),
  analyzeBuildOutput: vi.fn(),
  getBuildErrorAnalysis: vi.fn(),
  calculateTaskComplexityScore: vi.fn(),
  getTaskComplexityScore: vi.fn(),
  performAutoRollback: vi.fn(),
  getAutoRollbackHistory: vi.fn(),
};

const mockConstants = {
  SOURCE_EXTENSIONS: new Set(['.js', '.ts', '.py']),
  UI_EXTENSIONS: new Set(['.html', '.tsx', '.vue']),
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

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/validation/safeguard')];
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../constants', mockConstants);
  return require('../handlers/validation/safeguard');
}

vi.mock('../database', () => mockDb);
vi.mock('../constants', () => mockConstants);

function resetMockDefaults() {
  mockDb.captureTestBaseline.mockReset();
  mockDb.captureTestBaseline.mockResolvedValue({ suites: 0, passed: 0, failed: 0 });

  mockDb.getConfig.mockReset();
  mockDb.getConfig.mockReturnValue(null);

  mockDb.detectRegressions.mockReset();
  mockDb.detectRegressions.mockResolvedValue({
    regressions_found: 0,
    regressions: [],
  });

  mockDb.captureConfigBaselines.mockReset();
  mockDb.captureConfigBaselines.mockReturnValue({
    baseline_count: 0,
    files: [],
  });

  mockDb.detectConfigDrift.mockReset();
  mockDb.detectConfigDrift.mockReturnValue({
    drift_detected: false,
    changed_files: [],
  });

  mockDb.getTask.mockReset();
  mockDb.getTask.mockReturnValue({ id: 'task-default' });

  mockDb.getTaskFileChanges.mockReset();
  mockDb.getTaskFileChanges.mockReturnValue([]);

  mockDb.estimateResourceUsage.mockReset();
  mockDb.estimateResourceUsage.mockImplementation((taskId, filePath, newContent) => ({
    task_id: taskId,
    file_path: filePath,
    bytes: newContent.length,
    risk_factors: [],
  }));

  mockDb.checkI18n.mockReset();
  mockDb.checkI18n.mockImplementation((taskId, filePath) => ({
    task_id: taskId,
    file_path: filePath,
    hardcoded_strings_count: 0,
  }));

  mockDb.checkAccessibility.mockReset();
  mockDb.checkAccessibility.mockImplementation((taskId, filePath) => ({
    task_id: taskId,
    file_path: filePath,
    violations_count: 0,
  }));

  mockDb.getSafeguardToolConfigs.mockReset();
  mockDb.getSafeguardToolConfigs.mockReturnValue([]);

  mockDb.verifyTypeReferences.mockReset();
  mockDb.verifyTypeReferences.mockReturnValue({
    task_id: 'task-default',
    verified: true,
    missing_types: [],
  });

  mockDb.getTypeVerificationResults.mockReset();
  mockDb.getTypeVerificationResults.mockReturnValue([]);

  mockDb.analyzeBuildOutput.mockReset();
  mockDb.analyzeBuildOutput.mockReturnValue({
    task_id: 'task-default',
    errors: [],
    summary: 'clean',
  });

  mockDb.getBuildErrorAnalysis.mockReset();
  mockDb.getBuildErrorAnalysis.mockReturnValue([]);

  mockDb.calculateTaskComplexityScore.mockReset();
  mockDb.calculateTaskComplexityScore.mockReturnValue({
    task_id: 'task-default',
    complexity_score: 0,
    category: 'low',
  });

  mockDb.getTaskComplexityScore.mockReset();
  mockDb.getTaskComplexityScore.mockReturnValue(null);

  mockDb.performAutoRollback.mockReset();
  mockDb.performAutoRollback.mockReturnValue({
    task_id: 'task-default',
    rolled_back: true,
  });

  mockDb.getAutoRollbackHistory.mockReset();
  mockDb.getAutoRollbackHistory.mockReturnValue([]);
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function getJson(result) {
  return JSON.parse(getText(result));
}

describe('handler:validation-safeguard-handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleCaptureTestBaseline', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id or working_directory is missing', async () => {
      const result = await handlers.handleCaptureTestBaseline({ task_id: 'task-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id and working_directory are required');
      expect(mockDb.captureTestBaseline).not.toHaveBeenCalled();
    });

    it('captures and returns a baseline payload', async () => {
      mockDb.captureTestBaseline.mockResolvedValue({
        suites: 5,
        passed: 42,
        failed: 1,
      });

      const result = await handlers.handleCaptureTestBaseline({
        task_id: 'task-1',
        working_directory: '/repo',
      });

      expect(mockDb.captureTestBaseline).toHaveBeenCalledWith('task-1', '/repo');
      expect(getJson(result)).toEqual({
        task_id: 'task-1',
        baseline: {
          suites: 5,
          passed: 42,
          failed: 1,
        },
      });
    });

    it('returns INTERNAL_ERROR when baseline capture throws', async () => {
      mockDb.captureTestBaseline.mockRejectedValue(new Error('baseline failed'));

      const result = await handlers.handleCaptureTestBaseline({
        task_id: 'task-1',
        working_directory: '/repo',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(getText(result)).toContain('baseline failed');
    });
  });

  describe('handleDetectRegressions', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id or working_directory is missing', async () => {
      const result = await handlers.handleDetectRegressions({ working_directory: '/repo' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getConfig).not.toHaveBeenCalled();
    });

    it('uses a cached baseline when config data exists', async () => {
      const baseline = { files: ['src/app.js'] };
      mockDb.getConfig.mockReturnValue(JSON.stringify(baseline));
      mockDb.detectRegressions.mockResolvedValue({
        regressions_found: 1,
        regressions: [{ file_path: 'src/app.js', reason: 'snapshot changed' }],
      });

      const result = await handlers.handleDetectRegressions({
        task_id: 'task-2',
        working_directory: '/repo',
      });

      expect(mockDb.captureTestBaseline).not.toHaveBeenCalled();
      expect(mockDb.detectRegressions).toHaveBeenCalledWith('task-2', '/repo', baseline);
      expect(getJson(result)).toMatchObject({
        task_id: 'task-2',
        regressions_found: 1,
      });
    });

    it('captures a baseline when no cached baseline exists', async () => {
      mockDb.getConfig.mockReturnValue(null);
      mockDb.captureTestBaseline.mockResolvedValue({ snapshot: 'fresh' });

      const result = await handlers.handleDetectRegressions({
        task_id: 'task-3',
        working_directory: '/repo',
      });

      expect(mockDb.captureTestBaseline).toHaveBeenCalledWith('task-3', '/repo');
      expect(mockDb.detectRegressions).toHaveBeenCalledWith('task-3', '/repo', { snapshot: 'fresh' });
      expect(getJson(result).regressions_found).toBe(0);
    });

    it('returns INTERNAL_ERROR when cached baseline JSON is invalid', async () => {
      mockDb.getConfig.mockReturnValue('{not-valid-json');

      const result = await handlers.handleDetectRegressions({
        task_id: 'task-4',
        working_directory: '/repo',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(getText(result)).toMatch(/JSON|property name|Unexpected token/i);
    });
  });

  describe('configuration safeguard handlers', () => {
    it('requires working_directory when capturing config baselines', () => {
      const result = handlers.handleCaptureConfigBaselines({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('working_directory is required');
    });

    it('captures configuration baselines and returns the db payload', () => {
      mockDb.captureConfigBaselines.mockReturnValue({
        baseline_count: 2,
        files: ['package.json', 'vitest.config.js'],
      });

      const result = handlers.handleCaptureConfigBaselines({ working_directory: '/repo' });

      expect(mockDb.captureConfigBaselines).toHaveBeenCalledWith('/repo');
      expect(getJson(result)).toEqual({
        working_directory: '/repo',
        baseline_count: 2,
        files: ['package.json', 'vitest.config.js'],
      });
    });

    it('requires task_id and working_directory when detecting config drift', () => {
      const result = handlers.handleDetectConfigDrift({ task_id: 'task-5' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id and working_directory are required');
    });

    it('detects config drift for a task', () => {
      mockDb.detectConfigDrift.mockReturnValue({
        drift_detected: true,
        changed_files: ['package.json'],
      });

      const result = handlers.handleDetectConfigDrift({
        task_id: 'task-5',
        working_directory: '/repo',
      });

      expect(mockDb.detectConfigDrift).toHaveBeenCalledWith('task-5', '/repo');
      expect(getJson(result)).toEqual({
        task_id: 'task-5',
        working_directory: '/repo',
        drift_detected: true,
        changed_files: ['package.json'],
      });
    });
  });

  describe('handleEstimateResources', () => {
    it('requires task_id', () => {
      const result = handlers.handleEstimateResources({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleEstimateResources({ task_id: 'missing-task' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getText(result)).toContain('Task not found: missing-task');
    });

    it('only analyzes source files with non-empty content and reports risk factors', () => {
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/app.JS', new_content: 'const app = true;' },
        { file_path: 'README.md', new_content: '# docs' },
        { file_path: 'src/worker.ts', new_content: '' },
        { file_path: 'scripts/build.py', new_content: 'print("ok")' },
        { file_path: null, new_content: 'missing path' },
        { file_path: 'notes', new_content: 'missing extension' },
      ]);
      mockDb.estimateResourceUsage
        .mockReturnValueOnce({ file_path: 'src/app.JS', risk_factors: [] })
        .mockReturnValueOnce({ file_path: 'scripts/build.py', risk_factors: ['cpu_spike'] });

      const result = handlers.handleEstimateResources({ task_id: 'task-6' });
      const payload = getJson(result);

      expect(mockDb.estimateResourceUsage).toHaveBeenCalledTimes(2);
      expect(mockDb.estimateResourceUsage).toHaveBeenNthCalledWith(1, 'task-6', 'src/app.JS', 'const app = true;');
      expect(mockDb.estimateResourceUsage).toHaveBeenNthCalledWith(2, 'task-6', 'scripts/build.py', 'print("ok")');
      expect(payload.files_analyzed).toBe(2);
      expect(payload.has_risk_factors).toBe(true);
      expect(payload.results[1].risk_factors).toEqual(['cpu_spike']);
    });

    it('returns zero analyzed files when no file changes qualify', () => {
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'README.md', new_content: '# docs' },
        { file_path: 'src/empty.js', new_content: '' },
        { file_path: null, new_content: 'const nope = true;' },
      ]);

      const result = handlers.handleEstimateResources({ task_id: 'task-7' });

      expect(mockDb.estimateResourceUsage).not.toHaveBeenCalled();
      expect(getJson(result)).toEqual({
        task_id: 'task-7',
        files_analyzed: 0,
        has_risk_factors: false,
        results: [],
      });
    });
  });

  describe('handleCheckI18n', () => {
    it('requires task_id', () => {
      const result = handlers.handleCheckI18n({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleCheckI18n({ task_id: 'missing-task' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('checks only JS and TS family files with content and totals hardcoded strings', () => {
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/page.tsx', new_content: '<div>Hello</div>' },
        { file_path: 'src/service.TS', new_content: 'return "name";' },
        { file_path: 'src/template.html', new_content: '<p>ignore</p>' },
        { file_path: 'src/empty.jsx', new_content: '' },
      ]);
      mockDb.checkI18n
        .mockReturnValueOnce({ file_path: 'src/page.tsx', hardcoded_strings_count: 2 })
        .mockReturnValueOnce({ file_path: 'src/service.TS', hardcoded_strings_count: 1 });

      const result = handlers.handleCheckI18n({ task_id: 'task-8' });
      const payload = getJson(result);

      expect(mockDb.checkI18n).toHaveBeenCalledTimes(2);
      expect(payload.files_checked).toBe(2);
      expect(payload.total_hardcoded_strings).toBe(3);
    });

    it('returns zero totals when no files are eligible for i18n checks', () => {
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'public/index.html', new_content: '<html />' },
        { file_path: 'src/empty.ts', new_content: '' },
      ]);

      const result = handlers.handleCheckI18n({ task_id: 'task-9' });

      expect(mockDb.checkI18n).not.toHaveBeenCalled();
      expect(getJson(result)).toEqual({
        task_id: 'task-9',
        files_checked: 0,
        total_hardcoded_strings: 0,
        results: [],
      });
    });
  });

  describe('handleCheckAccessibility', () => {
    it('requires task_id', () => {
      const result = handlers.handleCheckAccessibility({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleCheckAccessibility({ task_id: 'missing-task' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('checks only configured UI extensions with content and totals violations', () => {
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/page.HTML', new_content: '<img src="x" />' },
        { file_path: 'src/widget.tsx', new_content: '<button />' },
        { file_path: 'src/logic.ts', new_content: 'const x = 1;' },
        { file_path: 'src/empty.vue', new_content: '' },
      ]);
      mockDb.checkAccessibility
        .mockReturnValueOnce({ file_path: 'src/page.HTML', violations_count: 2 })
        .mockReturnValueOnce({ file_path: 'src/widget.tsx', violations_count: 1 });

      const result = handlers.handleCheckAccessibility({ task_id: 'task-10' });
      const payload = getJson(result);

      expect(mockDb.checkAccessibility).toHaveBeenCalledTimes(2);
      expect(payload.files_checked).toBe(2);
      expect(payload.total_violations).toBe(3);
    });

    it('returns zero totals when no files are eligible for accessibility checks', () => {
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/logic.ts', new_content: 'const count = 1;' },
        { file_path: 'src/empty.vue', new_content: '' },
        { file_path: null, new_content: '<button />' },
      ]);

      const result = handlers.handleCheckAccessibility({ task_id: 'task-10b' });

      expect(mockDb.checkAccessibility).not.toHaveBeenCalled();
      expect(getJson(result)).toEqual({
        task_id: 'task-10b',
        files_checked: 0,
        total_violations: 0,
        results: [],
      });
    });
  });

  describe('lookup and reporting handlers', () => {
    it('returns safeguard tool configs with a default safeguard_type of all', () => {
      mockDb.getSafeguardToolConfigs.mockReturnValue([
        { name: 'lint', enabled: true },
        { name: 'a11y', enabled: true },
      ]);

      const result = handlers.handleGetSafeguardTools({});

      expect(mockDb.getSafeguardToolConfigs).toHaveBeenCalledWith(undefined);
      expect(getJson(result)).toEqual({
        safeguard_type: 'all',
        tools: [
          { name: 'lint', enabled: true },
          { name: 'a11y', enabled: true },
        ],
        count: 2,
      });
    });

    it('passes through safeguard_type filters when requesting tool configs', () => {
      mockDb.getSafeguardToolConfigs.mockReturnValue([
        { name: 'tsc', enabled: true, safeguard_type: 'types' },
      ]);

      const result = handlers.handleGetSafeguardTools({ safeguard_type: 'types' });

      expect(mockDb.getSafeguardToolConfigs).toHaveBeenCalledWith('types');
      expect(getJson(result)).toEqual({
        safeguard_type: 'types',
        tools: [{ name: 'tsc', enabled: true, safeguard_type: 'types' }],
        count: 1,
      });
    });

    it('requires all verifyTypeReferences params', () => {
      const missingTaskId = handlers.handleVerifyTypeReferences({
        file_path: 'src/types.ts',
        content: 'type Foo = string;',
        working_directory: '/repo',
      });
      const missingFilePath = handlers.handleVerifyTypeReferences({
        task_id: 'task-11',
        content: 'type Foo = string;',
        working_directory: '/repo',
      });
      const missingContent = handlers.handleVerifyTypeReferences({
        task_id: 'task-11',
        file_path: 'src/types.ts',
        working_directory: '/repo',
      });
      const missingWorkingDirectory = handlers.handleVerifyTypeReferences({
        task_id: 'task-11',
        file_path: 'src/types.ts',
        content: 'type Foo = string;',
      });

      expect(missingTaskId.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingTaskId)).toContain('task_id is required');
      expect(missingFilePath.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingFilePath)).toContain('file_path is required');
      expect(missingContent.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingContent)).toContain('content is required');
      expect(missingWorkingDirectory.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingWorkingDirectory)).toContain('working_directory is required');
      expect(mockDb.verifyTypeReferences).not.toHaveBeenCalled();
    });

    it('passes verifyTypeReferences args through to the database', () => {
      mockDb.verifyTypeReferences.mockReturnValue({
        task_id: 'task-12',
        verified: false,
        missing_types: ['MissingType'],
      });

      const result = handlers.handleVerifyTypeReferences({
        task_id: 'task-12',
        file_path: 'src/types.ts',
        content: 'const value: MissingType = foo;',
        working_directory: '/repo',
      });

      expect(mockDb.verifyTypeReferences).toHaveBeenCalledWith(
        'task-12',
        'src/types.ts',
        'const value: MissingType = foo;',
        '/repo'
      );
      expect(getJson(result)).toEqual({
        task_id: 'task-12',
        verified: false,
        missing_types: ['MissingType'],
      });
    });

    it('requires task_id for getTypeVerificationResults', () => {
      const result = handlers.handleGetTypeVerificationResults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('summarizes type verification results and reports verified status when nothing is missing', () => {
      mockDb.getTypeVerificationResults.mockReturnValue([
        { type_name: 'Foo', exists_in_codebase: true },
        { type_name: 'Bar', exists_in_codebase: true },
      ]);

      const result = handlers.handleGetTypeVerificationResults({ task_id: 'task-13' });

      expect(mockDb.getTypeVerificationResults).toHaveBeenCalledWith('task-13');
      expect(getJson(result)).toEqual({
        task_id: 'task-13',
        total_types: 2,
        missing_types: 0,
        results: [
          { type_name: 'Foo', exists_in_codebase: true },
          { type_name: 'Bar', exists_in_codebase: true },
        ],
        status: 'verified',
      });
    });

    it('reports types_missing status when any type lookup fails', () => {
      mockDb.getTypeVerificationResults.mockReturnValue([
        { type_name: 'Foo', exists_in_codebase: true },
        { type_name: 'MissingType', exists_in_codebase: false },
      ]);

      const result = handlers.handleGetTypeVerificationResults({ task_id: 'task-13b' });

      expect(getJson(result)).toEqual({
        task_id: 'task-13b',
        total_types: 2,
        missing_types: 1,
        results: [
          { type_name: 'Foo', exists_in_codebase: true },
          { type_name: 'MissingType', exists_in_codebase: false },
        ],
        status: 'types_missing',
      });
    });
  });

  describe('build, complexity, and rollback handlers', () => {
    it('requires task_id and build_output for build analysis', () => {
      const missingTaskId = handlers.handleAnalyzeBuildOutput({ build_output: 'error TS2304' });
      const missingBuildOutput = handlers.handleAnalyzeBuildOutput({ task_id: 'task-14' });

      expect(missingTaskId.isError).toBe(true);
      expect(missingTaskId.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingTaskId)).toContain('task_id is required');
      expect(missingBuildOutput.isError).toBe(true);
      expect(missingBuildOutput.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingBuildOutput)).toContain('build_output is required');
      expect(mockDb.analyzeBuildOutput).not.toHaveBeenCalled();
    });

    it('returns analyzed build output from the database', () => {
      mockDb.analyzeBuildOutput.mockReturnValue({
        task_id: 'task-14',
        errors: [{ error_type: 'missing_type' }],
        summary: '1 missing type',
      });

      const result = handlers.handleAnalyzeBuildOutput({
        task_id: 'task-14',
        build_output: 'error TS2304: Cannot find name Foo',
      });

      expect(mockDb.analyzeBuildOutput).toHaveBeenCalledWith(
        'task-14',
        'error TS2304: Cannot find name Foo'
      );
      expect(getJson(result)).toEqual({
        task_id: 'task-14',
        errors: [{ error_type: 'missing_type' }],
        summary: '1 missing type',
      });
    });

    it('requires task_id for getBuildErrorAnalysis', () => {
      const result = handlers.handleGetBuildErrorAnalysis({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('summarizes build error analysis booleans from returned errors', () => {
      mockDb.getBuildErrorAnalysis.mockReturnValue([
        { error_type: 'namespace_conflict' },
        { error_type: 'missing_type' },
        { error_type: 'syntax_error' },
      ]);

      const result = handlers.handleGetBuildErrorAnalysis({ task_id: 'task-15' });

      expect(mockDb.getBuildErrorAnalysis).toHaveBeenCalledWith('task-15');
      expect(getJson(result)).toEqual({
        task_id: 'task-15',
        error_count: 3,
        results: [
          { error_type: 'namespace_conflict' },
          { error_type: 'missing_type' },
          { error_type: 'syntax_error' },
        ],
        has_namespace_conflicts: true,
        has_missing_types: true,
      });
    });

    it('reports false build error summary flags when special error types are absent', () => {
      mockDb.getBuildErrorAnalysis.mockReturnValue([
        { error_type: 'syntax_error' },
      ]);

      const result = handlers.handleGetBuildErrorAnalysis({ task_id: 'task-15b' });

      expect(getJson(result)).toEqual({
        task_id: 'task-15b',
        error_count: 1,
        results: [{ error_type: 'syntax_error' }],
        has_namespace_conflicts: false,
        has_missing_types: false,
      });
    });

    it('requires task_id and task_description for complexity calculation', () => {
      const missingTaskId = handlers.handleCalculateTaskComplexity({
        task_description: 'Refactor parser',
      });
      const missingTaskDescription = handlers.handleCalculateTaskComplexity({
        task_id: 'task-16',
      });

      expect(missingTaskId.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingTaskId)).toContain('task_id is required');
      expect(missingTaskDescription.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingTaskDescription)).toContain('task_description is required');
      expect(mockDb.calculateTaskComplexityScore).not.toHaveBeenCalled();
    });

    it('returns calculated task complexity results', () => {
      mockDb.calculateTaskComplexityScore.mockReturnValue({
        task_id: 'task-16',
        complexity_score: 78,
        category: 'high',
      });

      const result = handlers.handleCalculateTaskComplexity({
        task_id: 'task-16',
        task_description: 'Refactor parser and add tests',
      });

      expect(mockDb.calculateTaskComplexityScore).toHaveBeenCalledWith(
        'task-16',
        'Refactor parser and add tests'
      );
      expect(getJson(result)).toEqual({
        task_id: 'task-16',
        complexity_score: 78,
        category: 'high',
      });
    });

    it('requires task_id for getTaskComplexityScore and returns stored scores when present', () => {
      const missingTaskId = handlers.handleGetTaskComplexityScore({});
      mockDb.getTaskComplexityScore.mockReturnValue({
        task_id: 'task-17',
        complexity_score: 55,
        category: 'medium',
      });

      const success = handlers.handleGetTaskComplexityScore({ task_id: 'task-17' });

      expect(missingTaskId.isError).toBe(true);
      expect(missingTaskId.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTaskComplexityScore).toHaveBeenCalledWith('task-17');
      expect(getJson(success)).toEqual({
        task_id: 'task-17',
        complexity_score: 55,
        category: 'medium',
      });
    });

    it('returns a fallback message when no stored complexity score exists', () => {
      mockDb.getTaskComplexityScore.mockReturnValue(null);

      const result = handlers.handleGetTaskComplexityScore({ task_id: 'task-18' });

      expect(getJson(result)).toEqual({
        message: 'No complexity score found for task',
      });
    });

    it('requires task_id, working_directory, and trigger_reason for auto rollback', () => {
      const missingTaskId = handlers.handlePerformAutoRollback({
        working_directory: '/repo',
        trigger_reason: 'build_failure',
      });
      const missingWorkingDirectory = handlers.handlePerformAutoRollback({
        task_id: 'task-19',
        trigger_reason: 'build_failure',
      });
      const missingTriggerReason = handlers.handlePerformAutoRollback({
        task_id: 'task-19',
        working_directory: '/repo',
      });

      expect(getText(missingTaskId)).toContain('task_id is required');
      expect(getText(missingWorkingDirectory)).toContain('working_directory is required');
      expect(getText(missingTriggerReason)).toContain('trigger_reason is required');
      expect(mockDb.performAutoRollback).not.toHaveBeenCalled();
    });

    it('passes auto rollback args through to the database', () => {
      mockDb.performAutoRollback.mockReturnValue({
        task_id: 'task-19',
        rolled_back: true,
        restored_files: 3,
      });

      const result = handlers.handlePerformAutoRollback({
        task_id: 'task-19',
        working_directory: '/repo',
        trigger_reason: 'build_failure',
      });

      expect(mockDb.performAutoRollback).toHaveBeenCalledWith('task-19', '/repo', 'build_failure');
      expect(getJson(result)).toEqual({
        task_id: 'task-19',
        rolled_back: true,
        restored_files: 3,
      });
    });

    it('returns rollback history with the provided task id or a default all label', () => {
      mockDb.getAutoRollbackHistory
        .mockReturnValueOnce([
          { task_id: 'task-20', trigger_reason: 'build_failure' },
        ])
        .mockReturnValueOnce([
          { task_id: 'task-21', trigger_reason: 'manual_override' },
          { task_id: 'task-22', trigger_reason: 'timeout' },
        ]);

      const taskSpecific = handlers.handleGetAutoRollbackHistory({ task_id: 'task-20' });
      const allTasks = handlers.handleGetAutoRollbackHistory({});

      expect(mockDb.getAutoRollbackHistory).toHaveBeenNthCalledWith(1, 'task-20');
      expect(mockDb.getAutoRollbackHistory).toHaveBeenNthCalledWith(2, undefined);
      expect(getJson(taskSpecific)).toEqual({
        task_id: 'task-20',
        rollback_count: 1,
        results: [{ task_id: 'task-20', trigger_reason: 'build_failure' }],
      });
      expect(getJson(allTasks)).toEqual({
        task_id: 'all',
        rollback_count: 2,
        results: [
          { task_id: 'task-21', trigger_reason: 'manual_override' },
          { task_id: 'task-22', trigger_reason: 'timeout' },
        ],
      });
    });
  });
});
