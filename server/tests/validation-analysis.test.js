'use strict';

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const mockDb = {
  getTask: vi.fn(),
  getTaskFileChanges: vi.fn(),
  checkTestCoverage: vi.fn(),
  runStyleCheck: vi.fn(),
  analyzeChangeImpact: vi.fn(),
  getTimeoutAlerts: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  setOutputLimit: vi.fn(),
  getAuditTrail: vi.fn(),
  getAuditSummary: vi.fn(),
  runVulnerabilityScan: vi.fn(),
  getVulnerabilityResults: vi.fn(),
  getVulnerabilityScanResults: vi.fn(),
  analyzeCodeComplexity: vi.fn(),
  getComplexityMetrics: vi.fn(),
  detectDeadCode: vi.fn(),
  getDeadCodeResults: vi.fn(),
  validateApiContract: vi.fn(),
  checkDocCoverage: vi.fn(),
  getDocCoverageResults: vi.fn(),
};

const mockTaskManager = {
  startTask: vi.fn(),
  cancelTask: vi.fn(),
  processQueue: vi.fn(),
};

const mockLoggerChild = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockLogger = {
  child: vi.fn(() => mockLoggerChild),
};

const mockConstants = {
  CODE_EXTENSIONS: new Set(['.js', '.ts']),
  SOURCE_EXTENSIONS: new Set(['.js', '.ts']),
};

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/shared')];
  delete require.cache[require.resolve('../handlers/validation/analysis')];
  installMock('../database', mockDb);
  installMock('../task-manager', mockTaskManager);
  installMock('../logger', mockLogger);
  installMock('../constants', mockConstants);
  installMock('../handlers/shared', require('../handlers/shared'));
  return require('../handlers/validation/analysis');
}

function resetMockDefaults() {
  for (const fn of Object.values(mockDb)) {
    fn.mockReset();
  }
  for (const fn of Object.values(mockTaskManager)) {
    fn.mockReset();
  }
  mockLogger.child.mockReset();
  mockLogger.child.mockImplementation(() => mockLoggerChild);
  for (const fn of Object.values(mockLoggerChild)) {
    fn.mockReset();
  }

  mockDb.getTask.mockReturnValue({ id: 'task-default', working_directory: '/repo' });
  mockDb.getTaskFileChanges.mockReturnValue([]);
  mockDb.checkTestCoverage.mockReturnValue({ file_path: 'src/default.js', has_test: false });
  mockDb.runStyleCheck.mockReturnValue({ file_path: 'src/default.js', issue_count: 0, issues: [] });
  mockDb.analyzeChangeImpact.mockReturnValue({ file_path: 'src/default.js', impacted_files: [] });
  mockDb.getTimeoutAlerts.mockReturnValue([]);
  mockDb.getConfigValue.mockReturnValue(null);
  mockDb.setConfigValue.mockReturnValue(undefined);
  mockDb.setOutputLimit.mockReturnValue(undefined);
  mockDb.getAuditTrail.mockReturnValue([]);
  mockDb.getAuditSummary.mockReturnValue({});
  mockDb.runVulnerabilityScan.mockResolvedValue([]);
  mockDb.getVulnerabilityResults.mockReturnValue([]);
  mockDb.getVulnerabilityScanResults.mockReturnValue([]);
  mockDb.analyzeCodeComplexity.mockReturnValue({ file_path: 'src/default.js', cyclomatic: 1 });
  mockDb.getComplexityMetrics.mockReturnValue([]);
  mockDb.detectDeadCode.mockReturnValue([]);
  mockDb.getDeadCodeResults.mockReturnValue([]);
  mockDb.validateApiContract.mockResolvedValue({ valid: true, breaking_changes: 0, warnings: [] });
  mockDb.checkDocCoverage.mockReturnValue({ file_path: 'src/default.js', coverage_percent: 0 });
  mockDb.getDocCoverageResults.mockReturnValue([]);
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function getJson(result) {
  return JSON.parse(getText(result));
}

describe('validation/analysis handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads shared helpers through the mocked logger module', () => {
    expect(mockLogger.child).toHaveBeenCalledWith({ component: 'shared-handlers' });
  });

  describe('handleCheckTestCoverage', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleCheckTestCoverage({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleCheckTestCoverage({ task_id: 'task-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getText(result)).toContain('Task not found: task-missing');
      expect(mockDb.getTaskFileChanges).not.toHaveBeenCalled();
    });

    it('checks changed files and reports aggregate coverage results', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-1', working_directory: '/repo/project' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/a.js' },
        { file_path: 'src/b.ts' },
        { file_path: null },
      ]);
      mockDb.checkTestCoverage
        .mockReturnValueOnce({ file_path: 'src/a.js', has_test: true, test_file: 'src/a.test.js' })
        .mockReturnValueOnce({ file_path: 'src/b.ts', has_test: false, reason: 'missing test file' });

      const payload = getJson(handlers.handleCheckTestCoverage({ task_id: 'task-1' }));

      expect(mockDb.checkTestCoverage).toHaveBeenCalledTimes(2);
      expect(mockDb.checkTestCoverage).toHaveBeenNthCalledWith(1, 'task-1', 'src/a.js', '/repo/project');
      expect(mockDb.checkTestCoverage).toHaveBeenNthCalledWith(2, 'task-1', 'src/b.ts', '/repo/project');
      expect(payload).toEqual({
        task_id: 'task-1',
        files_checked: 2,
        files_with_tests: 1,
        coverage_percentage: 50,
        results: [
          { file_path: 'src/a.js', has_test: true, test_file: 'src/a.test.js' },
          { file_path: 'src/b.ts', has_test: false, reason: 'missing test file' },
        ],
      });
    });

    it('returns zero coverage when no changed files have a file path', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-empty', working_directory: '/repo/project' });
      mockDb.getTaskFileChanges.mockReturnValue([{ file_path: '' }, {}, { file_path: null }]);

      const payload = getJson(handlers.handleCheckTestCoverage({ task_id: 'task-empty' }));

      expect(mockDb.checkTestCoverage).not.toHaveBeenCalled();
      expect(payload).toEqual({
        task_id: 'task-empty',
        files_checked: 0,
        files_with_tests: 0,
        coverage_percentage: 0,
        results: [],
      });
    });
  });

  describe('handleRunStyleCheck', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleRunStyleCheck({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleRunStyleCheck({ task_id: 'style-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(mockDb.runStyleCheck).not.toHaveBeenCalled();
    });

    it('runs style checks and returns aggregated issue counts', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-2', working_directory: '/repo/style' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/app.js' },
        { file_path: 'src/util.ts' },
        {},
      ]);
      mockDb.runStyleCheck
        .mockReturnValueOnce({ file_path: 'src/app.js', issue_count: 2, issues: ['semi', 'quotes'] })
        .mockReturnValueOnce({ file_path: 'src/util.ts', issue_count: 1, issues: ['indent'] });

      const payload = getJson(handlers.handleRunStyleCheck({ task_id: 'task-2', auto_fix: true }));

      expect(mockDb.runStyleCheck).toHaveBeenCalledTimes(2);
      expect(mockDb.runStyleCheck).toHaveBeenNthCalledWith(1, 'task-2', 'src/app.js', '/repo/style', true);
      expect(mockDb.runStyleCheck).toHaveBeenNthCalledWith(2, 'task-2', 'src/util.ts', '/repo/style', true);
      expect(payload).toEqual({
        task_id: 'task-2',
        files_checked: 2,
        total_issues: 3,
        auto_fix: true,
        results: [
          { file_path: 'src/app.js', issue_count: 2, issues: ['semi', 'quotes'] },
          { file_path: 'src/util.ts', issue_count: 1, issues: ['indent'] },
        ],
      });
    });

    it('defaults auto_fix to false and treats missing issue counts as zero', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-style-defaults', working_directory: '/repo/style' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/app.js' },
        { file_path: 'src/util.ts' },
      ]);
      mockDb.runStyleCheck
        .mockReturnValueOnce({ file_path: 'src/app.js', issues: ['semi'] })
        .mockReturnValueOnce({ file_path: 'src/util.ts', issue_count: 4, issues: ['indent'] });

      const payload = getJson(handlers.handleRunStyleCheck({ task_id: 'task-style-defaults' }));

      expect(mockDb.runStyleCheck).toHaveBeenNthCalledWith(1, 'task-style-defaults', 'src/app.js', '/repo/style', false);
      expect(mockDb.runStyleCheck).toHaveBeenNthCalledWith(2, 'task-style-defaults', 'src/util.ts', '/repo/style', false);
      expect(payload).toEqual({
        task_id: 'task-style-defaults',
        files_checked: 2,
        total_issues: 4,
        auto_fix: false,
        results: [
          { file_path: 'src/app.js', issues: ['semi'] },
          { file_path: 'src/util.ts', issue_count: 4, issues: ['indent'] },
        ],
      });
    });
  });

  describe('handleAnalyzeChangeImpact', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleAnalyzeChangeImpact({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns impact analysis across changed files', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-3', working_directory: '/repo/impact' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/api.js' },
        { file_path: 'src/service.ts' },
      ]);
      mockDb.analyzeChangeImpact
        .mockReturnValueOnce({ file_path: 'src/api.js', impacted_files: ['src/routes.js', 'src/schema.js'] })
        .mockReturnValueOnce({ file_path: 'src/service.ts', impacted_files: ['src/controller.ts'] });

      const payload = getJson(handlers.handleAnalyzeChangeImpact({ task_id: 'task-3' }));

      expect(mockDb.analyzeChangeImpact).toHaveBeenCalledTimes(2);
      expect(payload).toEqual({
        task_id: 'task-3',
        files_analyzed: 2,
        total_impacted_files: 3,
        impacts: [
          { file_path: 'src/api.js', impacted_files: ['src/routes.js', 'src/schema.js'] },
          { file_path: 'src/service.ts', impacted_files: ['src/controller.ts'] },
        ],
      });
    });

    it('ignores missing file paths and missing impacted file lists', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-impact-mixed', working_directory: '/repo/impact' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/api.js' },
        { file_path: '' },
        {},
      ]);
      mockDb.analyzeChangeImpact.mockReturnValueOnce({ file_path: 'src/api.js', summary: 'low' });

      const payload = getJson(handlers.handleAnalyzeChangeImpact({ task_id: 'task-impact-mixed' }));

      expect(mockDb.analyzeChangeImpact).toHaveBeenCalledTimes(1);
      expect(payload).toEqual({
        task_id: 'task-impact-mixed',
        files_analyzed: 1,
        total_impacted_files: 0,
        impacts: [
          { file_path: 'src/api.js', summary: 'low' },
        ],
      });
    });
  });

  describe('alerts and audit handlers', () => {
    it('returns timeout alerts with a count', () => {
      mockDb.getTimeoutAlerts.mockReturnValue([
        { id: 'timeout-1', task_id: 'task-4', status: 'open' },
        { id: 'timeout-2', task_id: 'task-4', status: 'acknowledged' },
      ]);

      const payload = getJson(handlers.handleGetTimeoutAlerts({ task_id: 'task-4', status: 'open' }));

      expect(mockDb.getTimeoutAlerts).toHaveBeenCalledWith('task-4', 'open');
      expect(payload).toEqual({
        alerts: [
          { id: 'timeout-1', task_id: 'task-4', status: 'open' },
          { id: 'timeout-2', task_id: 'task-4', status: 'acknowledged' },
        ],
        count: 2,
      });
    });

    it('requires provider when configuring output limits', () => {
      const result = handlers.handleConfigureOutputLimits({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.setOutputLimit).not.toHaveBeenCalled();
    });

    it('persists output-limit configuration and returns a confirmation message', () => {
      const result = handlers.handleConfigureOutputLimits({
        provider: 'codex',
        max_output_bytes: 4096,
        max_file_size_bytes: 1024,
        max_file_changes: 8,
        enabled: false,
      });

      expect(mockDb.setOutputLimit).toHaveBeenCalledWith('codex', 4096, 1024, 8, false);
      expect(getText(result)).toContain('Output limits configured for codex');
      expect(getText(result)).toContain('max 4096 bytes output');
      expect(getText(result)).toContain('1024 bytes/file');
    });

    it('applies default output-limit values when optional args are omitted', () => {
      const result = handlers.handleConfigureOutputLimits({ provider: 'ollama' });

      expect(mockDb.setOutputLimit).toHaveBeenCalledWith('ollama', 1048576, 524288, 20, true);
      expect(getText(result)).toContain('Output limits configured for ollama');
      expect(getText(result)).toContain('max 1048576 bytes output');
      expect(getText(result)).toContain('524288 bytes/file');
    });

    it('returns audit trail entries using the provided filters and pagination', () => {
      mockDb.getAuditTrail.mockReturnValue([
        { id: 'audit-1', entity_type: 'task', entity_id: 'task-5', action: 'update' },
      ]);

      const payload = getJson(handlers.handleGetAuditTrail({
        entity_type: 'task',
        entity_id: 'task-5',
        event_type: 'status_change',
        action: 'update',
        limit: 25,
        offset: 50,
      }));

      expect(mockDb.getAuditTrail).toHaveBeenCalledWith({
        entity_type: 'task',
        entity_id: 'task-5',
        event_type: 'status_change',
        action: 'update',
        limit: 25,
        offset: 50,
      });
      expect(payload).toEqual({
        events: [
          { id: 'audit-1', entity_type: 'task', entity_id: 'task-5', action: 'update' },
        ],
        count: 1,
        limit: 25,
        offset: 50,
      });
    });

    it('uses default audit trail pagination when limit and offset are omitted', () => {
      const payload = getJson(handlers.handleGetAuditTrail({ entity_type: 'task' }));

      expect(mockDb.getAuditTrail).toHaveBeenCalledWith({
        entity_type: 'task',
        entity_id: undefined,
        event_type: undefined,
        action: undefined,
        limit: 100,
        offset: 0,
      });
      expect(payload).toEqual({
        events: [],
        count: 0,
        limit: 100,
        offset: 0,
      });
    });

    it('returns audit summary statistics for the requested period', () => {
      mockDb.getAuditSummary.mockReturnValue({
        total_events: 12,
        by_action: { create: 2, update: 10 },
      });

      const payload = getJson(handlers.handleGetAuditSummary({ period: 'weekly' }));

      expect(mockDb.getAuditSummary).toHaveBeenCalledWith('weekly');
      expect(payload).toEqual({
        period: 'weekly',
        summary: {
          total_events: 12,
          by_action: { create: 2, update: 10 },
        },
      });
    });

    it('defaults audit summary period to daily', () => {
      mockDb.getAuditSummary.mockReturnValue({ total_events: 0 });

      const payload = getJson(handlers.handleGetAuditSummary({}));

      expect(mockDb.getAuditSummary).toHaveBeenCalledWith('daily');
      expect(payload).toEqual({
        period: 'daily',
        summary: { total_events: 0 },
      });
    });
  });

  describe('vulnerability handlers', () => {
    it('returns MISSING_REQUIRED_PARAM when working_directory is missing', async () => {
      const result = await handlers.handleScanVulnerabilities({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('working_directory is required');
      expect(mockDb.runVulnerabilityScan).not.toHaveBeenCalled();
    });

    it('runs vulnerability scans when task_id is omitted and returns aggregated results', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
      mockDb.runVulnerabilityScan.mockResolvedValue([
        { ecosystem: 'npm', vulnerabilities: { total: 3 } },
        { ecosystem: 'nuget', vulnerabilities: { total: 1 } },
      ]);

      const payload = getJson(await handlers.handleScanVulnerabilities({
        working_directory: '/repo/vulns',
      }));

      expect(mockDb.runVulnerabilityScan).toHaveBeenCalledWith('scan-1700000000000', '/repo/vulns');
      expect(payload).toEqual({
        task_id: 'scan-1700000000000',
        working_directory: '/repo/vulns',
        scans_run: 2,
        total_vulnerabilities: 4,
        results: [
          { ecosystem: 'npm', vulnerabilities: { total: 3 } },
          { ecosystem: 'nuget', vulnerabilities: { total: 1 } },
        ],
      });
    });

    it('uses the provided task_id and tolerates scan results without vulnerability totals', async () => {
      mockDb.runVulnerabilityScan.mockResolvedValue([
        { ecosystem: 'npm', vulnerabilities: { total: 2 } },
        { ecosystem: 'pip' },
      ]);

      const payload = getJson(await handlers.handleScanVulnerabilities({
        task_id: 'scan-fixed',
        working_directory: '/repo/vulns',
      }));

      expect(mockDb.runVulnerabilityScan).toHaveBeenCalledWith('scan-fixed', '/repo/vulns');
      expect(payload).toEqual({
        task_id: 'scan-fixed',
        working_directory: '/repo/vulns',
        scans_run: 2,
        total_vulnerabilities: 2,
        results: [
          { ecosystem: 'npm', vulnerabilities: { total: 2 } },
          { ecosystem: 'pip' },
        ],
      });
    });

    it('returns INTERNAL_ERROR when the vulnerability scan throws', async () => {
      mockDb.runVulnerabilityScan.mockRejectedValue(new Error('scanner exploded'));

      const result = await handlers.handleScanVulnerabilities({
        task_id: 'scan-error',
        working_directory: '/repo/vulns',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(getText(result)).toContain('scanner exploded');
    });

    it('requires task_id when fetching stored vulnerability results', () => {
      const result = handlers.handleGetVulnerabilityResults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getVulnerabilityScanResults).not.toHaveBeenCalled();
    });

    it('returns stored vulnerability scan results', () => {
      mockDb.getVulnerabilityScanResults.mockReturnValue([
        { ecosystem: 'npm', vulnerabilities: { total: 2 } },
      ]);

      const payload = getJson(handlers.handleGetVulnerabilityResults({ task_id: 'task-6' }));

      expect(mockDb.getVulnerabilityScanResults).toHaveBeenCalledWith('task-6');
      expect(payload).toEqual({
        task_id: 'task-6',
        results: [
          { ecosystem: 'npm', vulnerabilities: { total: 2 } },
        ],
      });
    });
  });

  describe('complexity handlers', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleAnalyzeComplexity({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when complexity analysis targets a missing task', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleAnalyzeComplexity({ task_id: 'complexity-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(mockDb.analyzeCodeComplexity).not.toHaveBeenCalled();
    });

    it('analyzes only code files and returns stored complexity scores', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-7', working_directory: '/repo/complexity' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/a.js', new_content: 'function a() { return 1; }' },
        { file_path: 'docs/readme.md', new_content: '# docs' },
        { file_path: 'src/b.ts', new_content: 'export function b() { return 2; }' },
        { file_path: 'src/c.js' },
      ]);
      mockDb.analyzeCodeComplexity
        .mockReturnValueOnce({ file_path: 'src/a.js', cyclomatic: 3, maintainability: 82 })
        .mockReturnValueOnce({ file_path: 'src/b.ts', cyclomatic: 5, maintainability: 74 });

      const payload = getJson(handlers.handleAnalyzeComplexity({ task_id: 'task-7' }));

      expect(mockDb.analyzeCodeComplexity).toHaveBeenCalledTimes(2);
      expect(mockDb.analyzeCodeComplexity).toHaveBeenNthCalledWith(
        1,
        'task-7',
        'src/a.js',
        'function a() { return 1; }'
      );
      expect(mockDb.analyzeCodeComplexity).toHaveBeenNthCalledWith(
        2,
        'task-7',
        'src/b.ts',
        'export function b() { return 2; }'
      );
      expect(payload).toEqual({
        task_id: 'task-7',
        files_analyzed: 2,
        results: [
          { file_path: 'src/a.js', cyclomatic: 3, maintainability: 82 },
          { file_path: 'src/b.ts', cyclomatic: 5, maintainability: 74 },
        ],
      });
    });

    it('normalizes uppercase file extensions when selecting complexity targets', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-7-upper', working_directory: '/repo/complexity' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/a.JS', new_content: 'function a() { return 1; }' },
        { file_path: 'src/b.TS', new_content: 'export const b = 2;' },
        { file_path: 'docs/readme.MD', new_content: '# docs' },
      ]);
      mockDb.analyzeCodeComplexity
        .mockReturnValueOnce({ file_path: 'src/a.JS', cyclomatic: 3 })
        .mockReturnValueOnce({ file_path: 'src/b.TS', cyclomatic: 1 });

      const payload = getJson(handlers.handleAnalyzeComplexity({ task_id: 'task-7-upper' }));

      expect(mockDb.analyzeCodeComplexity).toHaveBeenCalledTimes(2);
      expect(payload).toEqual({
        task_id: 'task-7-upper',
        files_analyzed: 2,
        results: [
          { file_path: 'src/a.JS', cyclomatic: 3 },
          { file_path: 'src/b.TS', cyclomatic: 1 },
        ],
      });
    });

    it('requires task_id when fetching complexity metrics', () => {
      const result = handlers.handleGetComplexityMetrics({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getComplexityMetrics).not.toHaveBeenCalled();
    });

    it('returns stored complexity metrics', () => {
      mockDb.getComplexityMetrics.mockReturnValue([
        { file_path: 'src/a.js', cyclomatic: 3, maintainability: 82 },
      ]);

      const payload = getJson(handlers.handleGetComplexityMetrics({ task_id: 'task-7' }));

      expect(mockDb.getComplexityMetrics).toHaveBeenCalledWith('task-7');
      expect(payload).toEqual({
        task_id: 'task-7',
        metrics: [
          { file_path: 'src/a.js', cyclomatic: 3, maintainability: 82 },
        ],
      });
    });
  });

  describe('dead code handlers', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleDetectDeadCode({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when dead code detection targets a missing task', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleDetectDeadCode({ task_id: 'dead-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(mockDb.detectDeadCode).not.toHaveBeenCalled();
    });

    it('detects dead code for supported source files and annotates each finding with the file path', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-8', working_directory: '/repo/deadcode' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/a.js', new_content: 'const unusedA = 1;' },
        { file_path: 'docs/readme.md', new_content: '# docs' },
        { file_path: 'src/b.ts', new_content: 'const unusedB = 2;' },
      ]);
      mockDb.detectDeadCode
        .mockReturnValueOnce([{ symbol: 'unusedA', line: 1 }])
        .mockReturnValueOnce([{ symbol: 'unusedB', line: 1 }]);

      const payload = getJson(handlers.handleDetectDeadCode({ task_id: 'task-8' }));

      expect(mockDb.detectDeadCode).toHaveBeenCalledTimes(2);
      expect(payload).toEqual({
        task_id: 'task-8',
        dead_code_count: 2,
        results: [
          { symbol: 'unusedA', line: 1, file_path: 'src/a.js' },
          { symbol: 'unusedB', line: 1, file_path: 'src/b.ts' },
        ],
      });
    });

    it('requires task_id when fetching stored dead code results', () => {
      const result = handlers.handleGetDeadCodeResults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getDeadCodeResults).not.toHaveBeenCalled();
    });

    it('returns stored dead code results', () => {
      mockDb.getDeadCodeResults.mockReturnValue([
        { file_path: 'src/a.js', symbol: 'unusedA', line: 1 },
      ]);

      const payload = getJson(handlers.handleGetDeadCodeResults({ task_id: 'task-8' }));

      expect(mockDb.getDeadCodeResults).toHaveBeenCalledWith('task-8');
      expect(payload).toEqual({
        task_id: 'task-8',
        results: [
          { file_path: 'src/a.js', symbol: 'unusedA', line: 1 },
        ],
      });
    });

    it('handles uppercase source extensions and empty dead-code matches', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-8-upper', working_directory: '/repo/deadcode' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/a.JS', new_content: 'const a = 1;' },
        { file_path: 'src/b.TS', new_content: 'const unusedB = 2;' },
        { file_path: 'notes.txt', new_content: 'ignore me' },
      ]);
      mockDb.detectDeadCode
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ symbol: 'unusedB', line: 1 }]);

      const payload = getJson(handlers.handleDetectDeadCode({ task_id: 'task-8-upper' }));

      expect(mockDb.detectDeadCode).toHaveBeenCalledTimes(2);
      expect(payload).toEqual({
        task_id: 'task-8-upper',
        dead_code_count: 1,
        results: [
          { symbol: 'unusedB', line: 1, file_path: 'src/b.TS' },
        ],
      });
    });
  });

  describe('API contract and documentation handlers', () => {
    it('returns MISSING_REQUIRED_PARAM when API contract args are incomplete', async () => {
      const result = await handlers.handleValidateApiContract({
        task_id: 'task-9',
        contract_file: 'openapi.yaml',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id, contract_file, and working_directory are required');
      expect(mockDb.validateApiContract).not.toHaveBeenCalled();
    });

    it('returns API contract validation results', async () => {
      mockDb.validateApiContract.mockResolvedValue({
        valid: false,
        breaking_changes: 2,
        warnings: ['response schema mismatch'],
      });

      const payload = getJson(await handlers.handleValidateApiContract({
        task_id: 'task-9',
        contract_file: 'openapi.yaml',
        working_directory: '/repo/contracts',
      }));

      expect(mockDb.validateApiContract).toHaveBeenCalledWith(
        'task-9',
        'openapi.yaml',
        '/repo/contracts'
      );
      expect(payload).toEqual({
        task_id: 'task-9',
        valid: false,
        breaking_changes: 2,
        warnings: ['response schema mismatch'],
      });
    });

    it('returns INTERNAL_ERROR when API contract validation throws', async () => {
      mockDb.validateApiContract.mockRejectedValue(new Error('contract parse failed'));

      const result = await handlers.handleValidateApiContract({
        task_id: 'task-9',
        contract_file: 'openapi.yaml',
        working_directory: '/repo/contracts',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(getText(result)).toContain('contract parse failed');
    });

    it('returns MISSING_REQUIRED_PARAM when task_id is missing for doc coverage', () => {
      const result = handlers.handleCheckDocCoverage({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when doc coverage targets a missing task', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleCheckDocCoverage({ task_id: 'doc-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(mockDb.checkDocCoverage).not.toHaveBeenCalled();
    });

    it('checks documentation coverage for code files and returns a rounded average', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-10', working_directory: '/repo/docs' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'src/a.js', new_content: 'function a() {}' },
        { file_path: 'src/b.ts', new_content: 'export function b() {}' },
        { file_path: 'README.md', new_content: '# docs' },
        { file_path: 'src/skip.js' },
      ]);
      mockDb.checkDocCoverage
        .mockReturnValueOnce({ file_path: 'src/a.js', coverage_percent: 87.44 })
        .mockReturnValueOnce({ file_path: 'src/b.ts', coverage_percent: 92.09 });

      const payload = getJson(handlers.handleCheckDocCoverage({ task_id: 'task-10' }));

      expect(mockDb.checkDocCoverage).toHaveBeenCalledTimes(2);
      expect(mockDb.checkDocCoverage).toHaveBeenNthCalledWith(
        1,
        'task-10',
        'src/a.js',
        'function a() {}'
      );
      expect(mockDb.checkDocCoverage).toHaveBeenNthCalledWith(
        2,
        'task-10',
        'src/b.ts',
        'export function b() {}'
      );
      expect(payload).toEqual({
        task_id: 'task-10',
        files_checked: 2,
        average_coverage: 89.8,
        results: [
          { file_path: 'src/a.js', coverage_percent: 87.44 },
          { file_path: 'src/b.ts', coverage_percent: 92.09 },
        ],
      });
    });

    it('requires task_id when fetching stored doc coverage results', () => {
      const result = handlers.handleGetDocCoverageResults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getDocCoverageResults).not.toHaveBeenCalled();
    });

    it('returns stored documentation coverage results', () => {
      mockDb.getDocCoverageResults.mockReturnValue([
        { file_path: 'src/a.js', coverage_percent: 87.44 },
      ]);

      const payload = getJson(handlers.handleGetDocCoverageResults({ task_id: 'task-10' }));

      expect(mockDb.getDocCoverageResults).toHaveBeenCalledWith('task-10');
      expect(payload).toEqual({
        task_id: 'task-10',
        results: [
          { file_path: 'src/a.js', coverage_percent: 87.44 },
        ],
      });
    });

    it('returns zero documentation coverage when no changed files are analyzable', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-10-empty', working_directory: '/repo/docs' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'README.md', new_content: '# docs' },
        { file_path: 'src/no-content.js' },
      ]);

      const payload = getJson(handlers.handleCheckDocCoverage({ task_id: 'task-10-empty' }));

      expect(mockDb.checkDocCoverage).not.toHaveBeenCalled();
      expect(payload).toEqual({
        task_id: 'task-10-empty',
        files_checked: 0,
        average_coverage: 0,
        results: [],
      });
    });
  });
});
