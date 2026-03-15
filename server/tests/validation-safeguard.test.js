'use strict';

const realShared = require('../handlers/shared');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const mockDb = {
  captureTestBaseline: vi.fn(),
  detectRegressions: vi.fn(),
  captureConfigBaselines: vi.fn(),
  detectConfigDrift: vi.fn(),
  estimateResources: vi.fn(),
  estimateResourceUsage: vi.fn(),
  getTask: vi.fn(),
  getTaskFileChanges: vi.fn(),
  checkI18n: vi.fn(),
  checkAccessibility: vi.fn(),
  getConfigValue: vi.fn(),
  getConfig: vi.fn(),
  verifyTypeReferences: vi.fn(),
  getTypeVerificationResults: vi.fn(),
  analyzeBuildOutput: vi.fn(),
  getBuildErrorAnalysis: vi.fn(),
  calculateTaskComplexity: vi.fn(),
  calculateTaskComplexityScore: vi.fn(),
  getTaskComplexityScore: vi.fn(),
  performAutoRollback: vi.fn(),
  getAutoRollbackHistory: vi.fn(),
  getSafeguardToolConfigs: vi.fn(),
};

const mockConstants = {
  SOURCE_EXTENSIONS: new Set(['.js', '.ts']),
  UI_EXTENSIONS: new Set(['.jsx', '.tsx', '.vue']),
};

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/validation/safeguard')];
  installMock('../database', mockDb);
  installMock('../constants', mockConstants);
  installMock('../handlers/shared', realShared);
  return require('../handlers/validation/safeguard');
}

function resetMockDefaults() {
  for (const fn of Object.values(mockDb)) {
    fn.mockReset();
  }

  mockDb.captureTestBaseline.mockResolvedValue({ suites: 0, passed: 0, failed: 0 });
  mockDb.detectRegressions.mockResolvedValue({ regressions_found: 0, regressions: [] });
  mockDb.captureConfigBaselines.mockReturnValue({ baseline_count: 0, files: [] });
  mockDb.detectConfigDrift.mockReturnValue({ drift_detected: false, changed_files: [] });
  mockDb.estimateResources.mockReturnValue({ cpu_seconds: 0, memory_mb: 0, risk_factors: [] });
  mockDb.estimateResourceUsage.mockImplementation((taskId, filePath, newContent) => ({
    task_id: taskId,
    file_path: filePath,
    bytes: newContent.length,
    risk_factors: [],
  }));
  mockDb.getTask.mockReturnValue({ id: 'task-default', working_directory: '/repo' });
  mockDb.getTaskFileChanges.mockReturnValue([]);
  mockDb.checkI18n.mockImplementation((taskId, filePath) => ({
    task_id: taskId,
    file_path: filePath,
    hardcoded_strings_count: 0,
  }));
  mockDb.checkAccessibility.mockImplementation((taskId, filePath) => ({
    task_id: taskId,
    file_path: filePath,
    violations_count: 0,
  }));
  mockDb.getConfigValue.mockReturnValue(null);
  mockDb.getConfig.mockReturnValue(null);
  mockDb.verifyTypeReferences.mockReturnValue({
    task_id: 'task-default',
    verified: true,
    missing_types: [],
  });
  mockDb.getTypeVerificationResults.mockReturnValue([]);
  mockDb.analyzeBuildOutput.mockReturnValue({
    task_id: 'task-default',
    errors: [],
    summary: 'clean',
  });
  mockDb.getBuildErrorAnalysis.mockReturnValue([]);
  mockDb.calculateTaskComplexity.mockReturnValue({
    task_id: 'task-default',
    complexity_score: 0,
    category: 'low',
  });
  mockDb.calculateTaskComplexityScore.mockReturnValue({
    task_id: 'task-default',
    complexity_score: 0,
    category: 'low',
  });
  mockDb.getTaskComplexityScore.mockReturnValue(null);
  mockDb.performAutoRollback.mockReturnValue({
    task_id: 'task-default',
    rolled_back: true,
  });
  mockDb.getAutoRollbackHistory.mockReturnValue([]);
  mockDb.getSafeguardToolConfigs.mockReturnValue([]);
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function getJson(result) {
  return JSON.parse(getText(result));
}

describe('validation/safeguard handlers', () => {
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
        suites: 4,
        passed: 21,
        failed: 1,
      });

      const payload = getJson(await handlers.handleCaptureTestBaseline({
        task_id: 'task-1',
        working_directory: '/repo',
      }));

      expect(mockDb.captureTestBaseline).toHaveBeenCalledWith('task-1', '/repo');
      expect(payload).toEqual({
        task_id: 'task-1',
        baseline: {
          suites: 4,
          passed: 21,
          failed: 1,
        },
      });
    });
  });

  describe('handleDetectRegressions', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id or working_directory is missing', async () => {
      const result = await handlers.handleDetectRegressions({ working_directory: '/repo' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getConfig).not.toHaveBeenCalled();
    });

    it('returns regression results using a cached baseline when present', async () => {
      const baseline = { snapshot: 'cached' };
      mockDb.getConfig.mockReturnValue(JSON.stringify(baseline));
      mockDb.detectRegressions.mockResolvedValue({
        regressions_found: 1,
        regressions: [{ file_path: 'src/app.js', reason: 'snapshot changed' }],
      });

      const payload = getJson(await handlers.handleDetectRegressions({
        task_id: 'task-2',
        working_directory: '/repo',
      }));

      expect(mockDb.captureTestBaseline).not.toHaveBeenCalled();
      expect(mockDb.detectRegressions).toHaveBeenCalledWith('task-2', '/repo', baseline);
      expect(payload).toEqual({
        task_id: 'task-2',
        regressions_found: 1,
        regressions: [{ file_path: 'src/app.js', reason: 'snapshot changed' }],
      });
    });

    it('captures a fresh baseline when no cached baseline exists', async () => {
      mockDb.captureTestBaseline.mockResolvedValue({ snapshot: 'fresh' });

      await handlers.handleDetectRegressions({
        task_id: 'task-3',
        working_directory: '/repo',
      });

      expect(mockDb.captureTestBaseline).toHaveBeenCalledWith('task-3', '/repo');
      expect(mockDb.detectRegressions).toHaveBeenCalledWith('task-3', '/repo', { snapshot: 'fresh' });
    });
  });

  describe('config safeguard handlers', () => {
    it('requires working_directory when capturing config baselines', async () => {
      const result = await handlers.handleCaptureConfigBaselines({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('working_directory is required');
    });

    it('returns captured config baseline results', async () => {
      mockDb.captureConfigBaselines.mockReturnValue({
        baseline_count: 2,
        files: ['package.json', 'vitest.config.js'],
      });

      const payload = getJson(await handlers.handleCaptureConfigBaselines({
        working_directory: '/repo',
      }));

      expect(mockDb.captureConfigBaselines).toHaveBeenCalledWith('/repo');
      expect(payload).toEqual({
        working_directory: '/repo',
        baseline_count: 2,
        files: ['package.json', 'vitest.config.js'],
      });
    });

    it('requires task_id and working_directory when detecting config drift', async () => {
      const result = await handlers.handleDetectConfigDrift({ task_id: 'task-4' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id and working_directory are required');
    });

    it('returns detected config drift results', async () => {
      mockDb.detectConfigDrift.mockReturnValue({
        drift_detected: true,
        changed_files: ['package.json'],
      });

      const payload = getJson(await handlers.handleDetectConfigDrift({
        task_id: 'task-4',
        working_directory: '/repo',
      }));

      expect(mockDb.detectConfigDrift).toHaveBeenCalledWith('task-4', '/repo');
      expect(payload).toEqual({
        task_id: 'task-4',
        working_directory: '/repo',
        drift_detected: true,
        changed_files: ['package.json'],
      });
    });
  });

  describe('handleEstimateResources', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
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

    it('returns resource estimates for changed source files only', () => {
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/app.js', new_content: 'const app = true;' },
        { file_path: 'src/view.jsx', new_content: 'export default function View() {}' },
        { file_path: 'src/util.ts', new_content: 'export const util = 1;' },
        { file_path: 'README.md', new_content: '# docs' },
        { file_path: 'src/empty.ts', new_content: '' },
      ]);
      mockDb.estimateResourceUsage
        .mockReturnValueOnce({ file_path: 'src/app.js', risk_factors: [] })
        .mockReturnValueOnce({ file_path: 'src/util.ts', risk_factors: ['cpu_spike'] });

      const payload = getJson(handlers.handleEstimateResources({ task_id: 'task-5' }));

      expect(mockDb.estimateResourceUsage).toHaveBeenCalledTimes(2);
      expect(mockDb.estimateResourceUsage).toHaveBeenNthCalledWith(
        1,
        'task-5',
        'src/app.js',
        'const app = true;'
      );
      expect(mockDb.estimateResourceUsage).toHaveBeenNthCalledWith(
        2,
        'task-5',
        'src/util.ts',
        'export const util = 1;'
      );
      expect(payload).toEqual({
        task_id: 'task-5',
        files_analyzed: 2,
        has_risk_factors: true,
        results: [
          { file_path: 'src/app.js', risk_factors: [] },
          { file_path: 'src/util.ts', risk_factors: ['cpu_spike'] },
        ],
      });
    });
  });

  describe('content safeguard handlers', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing for i18n checks', () => {
      const result = handlers.handleCheckI18n({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns i18n check results and totals hardcoded strings', () => {
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/page.jsx', new_content: '<div>Hello</div>' },
        { file_path: 'src/service.ts', new_content: 'return "name";' },
        { file_path: 'src/component.vue', new_content: '<template>Hello</template>' },
        { file_path: 'src/empty.tsx', new_content: '' },
      ]);
      mockDb.checkI18n
        .mockReturnValueOnce({ file_path: 'src/page.jsx', hardcoded_strings_count: 2 })
        .mockReturnValueOnce({ file_path: 'src/service.ts', hardcoded_strings_count: 1 });

      const payload = getJson(handlers.handleCheckI18n({ task_id: 'task-6' }));

      expect(mockDb.checkI18n).toHaveBeenCalledTimes(2);
      expect(payload).toEqual({
        task_id: 'task-6',
        files_checked: 2,
        total_hardcoded_strings: 3,
        results: [
          { file_path: 'src/page.jsx', hardcoded_strings_count: 2 },
          { file_path: 'src/service.ts', hardcoded_strings_count: 1 },
        ],
      });
    });

    it('returns MISSING_REQUIRED_PARAM when task_id is missing for accessibility checks', () => {
      const result = handlers.handleCheckAccessibility({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns accessibility results for files matching UI_EXTENSIONS', () => {
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/page.jsx', new_content: '<button />' },
        { file_path: 'src/modal.tsx', new_content: '<img alt="" />' },
        { file_path: 'src/widget.vue', new_content: '<template />' },
        { file_path: 'src/logic.ts', new_content: 'const count = 1;' },
      ]);
      mockDb.checkAccessibility
        .mockReturnValueOnce({ file_path: 'src/page.jsx', violations_count: 1 })
        .mockReturnValueOnce({ file_path: 'src/modal.tsx', violations_count: 2 })
        .mockReturnValueOnce({ file_path: 'src/widget.vue', violations_count: 0 });

      const payload = getJson(handlers.handleCheckAccessibility({ task_id: 'task-7' }));

      expect(mockDb.checkAccessibility).toHaveBeenCalledTimes(3);
      expect(payload).toEqual({
        task_id: 'task-7',
        files_checked: 3,
        total_violations: 3,
        results: [
          { file_path: 'src/page.jsx', violations_count: 1 },
          { file_path: 'src/modal.tsx', violations_count: 2 },
          { file_path: 'src/widget.vue', violations_count: 0 },
        ],
      });
    });
  });

  describe('handleGetSafeguardTools', () => {
    it('returns available safeguard tools with a count', () => {
      mockDb.getSafeguardToolConfigs.mockReturnValue([
        { name: 'lint', enabled: true },
        { name: 'a11y', enabled: true },
      ]);

      const payload = getJson(handlers.handleGetSafeguardTools({}));

      expect(mockDb.getSafeguardToolConfigs).toHaveBeenCalledWith(undefined);
      expect(payload).toEqual({
        safeguard_type: 'all',
        tools: [
          { name: 'lint', enabled: true },
          { name: 'a11y', enabled: true },
        ],
        count: 2,
      });
    });
  });

  describe('type verification handlers', () => {
    it('returns MISSING_REQUIRED_PARAM for each required verifyTypeReferences arg', () => {
      const missingTaskId = handlers.handleVerifyTypeReferences({
        file_path: 'src/types.ts',
        content: 'type Foo = string;',
        working_directory: '/repo',
      });
      const missingFilePath = handlers.handleVerifyTypeReferences({
        task_id: 'task-8',
        content: 'type Foo = string;',
        working_directory: '/repo',
      });
      const missingContent = handlers.handleVerifyTypeReferences({
        task_id: 'task-8',
        file_path: 'src/types.ts',
        working_directory: '/repo',
      });
      const missingWorkingDirectory = handlers.handleVerifyTypeReferences({
        task_id: 'task-8',
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

    it('returns verifyTypeReferences results', () => {
      mockDb.verifyTypeReferences.mockReturnValue({
        task_id: 'task-8',
        verified: false,
        missing_types: ['MissingType'],
      });

      const payload = getJson(handlers.handleVerifyTypeReferences({
        task_id: 'task-8',
        file_path: 'src/types.ts',
        content: 'const value: MissingType = foo;',
        working_directory: '/repo',
      }));

      expect(mockDb.verifyTypeReferences).toHaveBeenCalledWith(
        'task-8',
        'src/types.ts',
        'const value: MissingType = foo;',
        '/repo'
      );
      expect(payload).toEqual({
        task_id: 'task-8',
        verified: false,
        missing_types: ['MissingType'],
      });
    });

    it('returns MISSING_REQUIRED_PARAM when task_id is missing for stored verification results', () => {
      const result = handlers.handleGetTypeVerificationResults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTypeVerificationResults).not.toHaveBeenCalled();
    });

    it('returns summarized type verification results', () => {
      mockDb.getTypeVerificationResults.mockReturnValue([
        { type_name: 'Foo', exists_in_codebase: true },
        { type_name: 'MissingType', exists_in_codebase: false },
      ]);

      const payload = getJson(handlers.handleGetTypeVerificationResults({ task_id: 'task-9' }));

      expect(mockDb.getTypeVerificationResults).toHaveBeenCalledWith('task-9');
      expect(payload).toEqual({
        task_id: 'task-9',
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

  describe('build analysis handlers', () => {
    it('returns MISSING_REQUIRED_PARAM when analyzeBuildOutput args are incomplete', () => {
      const missingTaskId = handlers.handleAnalyzeBuildOutput({ build_output: 'error TS2304' });
      const missingBuildOutput = handlers.handleAnalyzeBuildOutput({ task_id: 'task-10' });

      expect(missingTaskId.isError).toBe(true);
      expect(missingTaskId.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingTaskId)).toContain('task_id is required');
      expect(missingBuildOutput.isError).toBe(true);
      expect(missingBuildOutput.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingBuildOutput)).toContain('build_output is required');
      expect(mockDb.analyzeBuildOutput).not.toHaveBeenCalled();
    });

    it('returns analyzed build output', () => {
      mockDb.analyzeBuildOutput.mockReturnValue({
        task_id: 'task-10',
        errors: [{ error_type: 'missing_type' }],
        summary: '1 missing type',
      });

      const payload = getJson(handlers.handleAnalyzeBuildOutput({
        task_id: 'task-10',
        build_output: 'error TS2304: Cannot find name Foo',
      }));

      expect(mockDb.analyzeBuildOutput).toHaveBeenCalledWith(
        'task-10',
        'error TS2304: Cannot find name Foo'
      );
      expect(payload).toEqual({
        task_id: 'task-10',
        errors: [{ error_type: 'missing_type' }],
        summary: '1 missing type',
      });
    });

    it('returns MISSING_REQUIRED_PARAM when task_id is missing for build error analysis', () => {
      const result = handlers.handleGetBuildErrorAnalysis({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getBuildErrorAnalysis).not.toHaveBeenCalled();
    });

    it('returns aggregated build error analysis', () => {
      mockDb.getBuildErrorAnalysis.mockReturnValue([
        { error_type: 'namespace_conflict' },
        { error_type: 'missing_type' },
        { error_type: 'syntax_error' },
      ]);

      const payload = getJson(handlers.handleGetBuildErrorAnalysis({ task_id: 'task-11' }));

      expect(mockDb.getBuildErrorAnalysis).toHaveBeenCalledWith('task-11');
      expect(payload).toEqual({
        task_id: 'task-11',
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
  });

  describe('task complexity handlers', () => {
    it('returns MISSING_REQUIRED_PARAM when task complexity args are incomplete', () => {
      const missingTaskId = handlers.handleCalculateTaskComplexity({
        task_description: 'Refactor parser',
      });
      const missingTaskDescription = handlers.handleCalculateTaskComplexity({
        task_id: 'task-12',
      });

      expect(missingTaskId.isError).toBe(true);
      expect(missingTaskId.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingTaskId)).toContain('task_id is required');
      expect(missingTaskDescription.isError).toBe(true);
      expect(missingTaskDescription.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingTaskDescription)).toContain('task_description is required');
      expect(mockDb.calculateTaskComplexityScore).not.toHaveBeenCalled();
    });

    it('returns calculated task complexity results', () => {
      mockDb.calculateTaskComplexityScore.mockReturnValue({
        task_id: 'task-12',
        complexity_score: 78,
        category: 'high',
      });

      const payload = getJson(handlers.handleCalculateTaskComplexity({
        task_id: 'task-12',
        task_description: 'Refactor parser and add tests',
      }));

      expect(mockDb.calculateTaskComplexityScore).toHaveBeenCalledWith(
        'task-12',
        'Refactor parser and add tests'
      );
      expect(payload).toEqual({
        task_id: 'task-12',
        complexity_score: 78,
        category: 'high',
      });
    });

    it('returns MISSING_REQUIRED_PARAM when task_id is missing for stored scores', () => {
      const result = handlers.handleGetTaskComplexityScore({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTaskComplexityScore).not.toHaveBeenCalled();
    });

    it('returns stored task complexity scores', () => {
      mockDb.getTaskComplexityScore.mockReturnValue({
        task_id: 'task-13',
        complexity_score: 55,
        category: 'medium',
      });

      const payload = getJson(handlers.handleGetTaskComplexityScore({ task_id: 'task-13' }));

      expect(mockDb.getTaskComplexityScore).toHaveBeenCalledWith('task-13');
      expect(payload).toEqual({
        task_id: 'task-13',
        complexity_score: 55,
        category: 'medium',
      });
    });
  });

  describe('rollback handlers', () => {
    it('returns MISSING_REQUIRED_PARAM when auto rollback args are incomplete', () => {
      const missingTaskId = handlers.handlePerformAutoRollback({
        working_directory: '/repo',
        trigger_reason: 'build_failure',
      });
      const missingWorkingDirectory = handlers.handlePerformAutoRollback({
        task_id: 'task-14',
        trigger_reason: 'build_failure',
      });
      const missingTriggerReason = handlers.handlePerformAutoRollback({
        task_id: 'task-14',
        working_directory: '/repo',
      });

      expect(missingTaskId.isError).toBe(true);
      expect(getText(missingTaskId)).toContain('task_id is required');
      expect(missingWorkingDirectory.isError).toBe(true);
      expect(getText(missingWorkingDirectory)).toContain('working_directory is required');
      expect(missingTriggerReason.isError).toBe(true);
      expect(getText(missingTriggerReason)).toContain('trigger_reason is required');
      expect(mockDb.performAutoRollback).not.toHaveBeenCalled();
    });

    it('returns auto rollback results', () => {
      mockDb.performAutoRollback.mockReturnValue({
        task_id: 'task-14',
        rolled_back: true,
        restored_files: 3,
      });

      const payload = getJson(handlers.handlePerformAutoRollback({
        task_id: 'task-14',
        working_directory: '/repo',
        trigger_reason: 'build_failure',
      }));

      expect(mockDb.performAutoRollback).toHaveBeenCalledWith('task-14', '/repo', 'build_failure');
      expect(payload).toEqual({
        task_id: 'task-14',
        rolled_back: true,
        restored_files: 3,
      });
    });

    it('returns auto rollback history for a task and defaults to all when task_id is omitted', () => {
      mockDb.getAutoRollbackHistory
        .mockReturnValueOnce([{ task_id: 'task-15', trigger_reason: 'build_failure' }])
        .mockReturnValueOnce([
          { task_id: 'task-16', trigger_reason: 'timeout' },
          { task_id: 'task-17', trigger_reason: 'manual_override' },
        ]);

      const taskPayload = getJson(handlers.handleGetAutoRollbackHistory({ task_id: 'task-15' }));
      const allPayload = getJson(handlers.handleGetAutoRollbackHistory({}));

      expect(mockDb.getAutoRollbackHistory).toHaveBeenNthCalledWith(1, 'task-15');
      expect(mockDb.getAutoRollbackHistory).toHaveBeenNthCalledWith(2, undefined);
      expect(taskPayload).toEqual({
        task_id: 'task-15',
        rollback_count: 1,
        results: [{ task_id: 'task-15', trigger_reason: 'build_failure' }],
      });
      expect(allPayload).toEqual({
        task_id: 'all',
        rollback_count: 2,
        results: [
          { task_id: 'task-16', trigger_reason: 'timeout' },
          { task_id: 'task-17', trigger_reason: 'manual_override' },
        ],
      });
    });
  });
});
