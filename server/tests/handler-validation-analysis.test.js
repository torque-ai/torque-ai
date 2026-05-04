const taskCore = require('../db/task-core');
const fileTracking = require('../db/file/tracking');
const handlers = require('../handlers/validation/analysis');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function getJson(result) {
  return JSON.parse(getText(result));
}

describe('handler:validation-analysis-handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('coverage, style, and impact analysis', () => {
    it('returns error when test coverage is requested without task_id', () => {
      const result = handlers.handleCheckTestCoverage({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns TASK_NOT_FOUND when coverage task does not exist', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
      const result = handlers.handleCheckTestCoverage({ task_id: 'missing' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('computes test coverage percentage across changed files', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1', working_directory: '/repo' });
      vi.spyOn(fileTracking,'getTaskFileChanges').mockReturnValue([
        { file_path: 'src/a.js' },
        { file_path: 'src/b.js' },
        { file_path: 'src/c.js' }
      ]);
      const coverageSpy = vi.spyOn(fileTracking,'checkTestCoverage');
      coverageSpy
        .mockReturnValueOnce({ file_path: 'src/a.js', has_test: true })
        .mockReturnValueOnce({ file_path: 'src/b.js', has_test: false })
        .mockReturnValueOnce({ file_path: 'src/c.js', has_test: true });

      const payload = getJson(handlers.handleCheckTestCoverage({ task_id: 'task-1' }));
      expect(payload.files_checked).toBe(3);
      expect(payload.files_with_tests).toBe(2);
      expect(payload.coverage_percentage).toBe(67);
      expect(coverageSpy).toHaveBeenCalledTimes(3);
    });

    it('runs style checks and aggregates issue counts', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-2', working_directory: '/repo' });
      vi.spyOn(fileTracking,'getTaskFileChanges').mockReturnValue([
        { file_path: 'src/x.js' },
        { file_path: 'src/y.ts' }
      ]);
      const styleSpy = vi.spyOn(fileTracking,'runStyleCheck');
      styleSpy
        .mockReturnValueOnce({ file_path: 'src/x.js', issue_count: 3 })
        .mockReturnValueOnce({ file_path: 'src/y.ts', issue_count: 1 });

      const payload = getJson(handlers.handleRunStyleCheck({ task_id: 'task-2', auto_fix: true }));
      expect(payload.total_issues).toBe(4);
      expect(payload.auto_fix).toBe(true);
      expect(styleSpy).toHaveBeenNthCalledWith(1, 'task-2', 'src/x.js', '/repo', true);
      expect(styleSpy).toHaveBeenNthCalledWith(2, 'task-2', 'src/y.ts', '/repo', true);
    });

    it('returns error when style check is requested without task_id', () => {
      const result = handlers.handleRunStyleCheck({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns TASK_NOT_FOUND when style check task does not exist', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
      const result = handlers.handleRunStyleCheck({ task_id: 'missing-style-task' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('skips style checks for changes without file paths and defaults auto_fix to false', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-2b', working_directory: '/repo' });
      vi.spyOn(fileTracking,'getTaskFileChanges').mockReturnValue([
        { file_path: 'src/only.js' },
        { file_path: '' },
        {}
      ]);
      const styleSpy = vi.spyOn(fileTracking,'runStyleCheck').mockReturnValue({
        file_path: 'src/only.js'
      });

      const payload = getJson(handlers.handleRunStyleCheck({ task_id: 'task-2b' }));
      expect(styleSpy).toHaveBeenCalledTimes(1);
      expect(styleSpy).toHaveBeenCalledWith('task-2b', 'src/only.js', '/repo', false);
      expect(payload.files_checked).toBe(1);
      expect(payload.total_issues).toBe(0);
      expect(payload.auto_fix).toBe(false);
    });

    it('analyzes change impact and totals impacted dependencies', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-3', working_directory: '/repo' });
      vi.spyOn(fileTracking,'getTaskFileChanges').mockReturnValue([
        { file_path: 'src/api.js' },
        { file_path: 'src/controller.js' }
      ]);
      const impactSpy = vi.spyOn(fileTracking,'analyzeChangeImpact');
      impactSpy
        .mockReturnValueOnce({ file_path: 'src/api.js', impacted_files: ['a', 'b'] })
        .mockReturnValueOnce({ file_path: 'src/controller.js', impacted_files: ['c'] });

      const payload = getJson(handlers.handleAnalyzeChangeImpact({ task_id: 'task-3' }));
      expect(payload.files_analyzed).toBe(2);
      expect(payload.total_impacted_files).toBe(3);
      expect(impactSpy).toHaveBeenCalledTimes(2);
    });

    it('returns error when change impact analysis is requested without task_id', () => {
      const result = handlers.handleAnalyzeChangeImpact({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns TASK_NOT_FOUND when change impact task does not exist', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
      const result = handlers.handleAnalyzeChangeImpact({ task_id: 'missing-impact-task' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('ignores impact entries without file paths and missing impacted file lists', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-3b', working_directory: '/repo' });
      vi.spyOn(fileTracking,'getTaskFileChanges').mockReturnValue([
        { file_path: 'src/service.js' },
        { file_path: null },
        {}
      ]);
      const impactSpy = vi.spyOn(fileTracking,'analyzeChangeImpact').mockReturnValue({
        file_path: 'src/service.js'
      });

      const payload = getJson(handlers.handleAnalyzeChangeImpact({ task_id: 'task-3b' }));
      expect(impactSpy).toHaveBeenCalledTimes(1);
      expect(impactSpy).toHaveBeenCalledWith('task-3b', 'src/service.js', '/repo');
      expect(payload.files_analyzed).toBe(1);
      expect(payload.total_impacted_files).toBe(0);
    });
  });

  describe('alerts and audit controls', () => {
    it('returns timeout alerts with count', () => {
      const alerts = [{ id: 1 }, { id: 2 }];
      const spy = vi.spyOn(fileTracking,'getTimeoutAlerts').mockReturnValue(alerts);

      const payload = getJson(handlers.handleGetTimeoutAlerts({ task_id: 'task-4', status: 'open' }));
      expect(spy).toHaveBeenCalledWith('task-4', 'open');
      expect(payload.count).toBe(2);
      expect(payload.alerts).toEqual(alerts);
    });

    it('returns empty timeout alerts when no filters are provided', () => {
      const spy = vi.spyOn(fileTracking,'getTimeoutAlerts').mockReturnValue([]);

      const payload = getJson(handlers.handleGetTimeoutAlerts({}));
      expect(spy).toHaveBeenCalledWith(undefined, undefined);
      expect(payload.count).toBe(0);
      expect(payload.alerts).toEqual([]);
    });

    it('requires provider when configuring output limits', () => {
      const result = handlers.handleConfigureOutputLimits({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('uses default output limits when optional values are omitted', () => {
      const spy = vi.spyOn(fileTracking,'setOutputLimit').mockReturnValue(undefined);

      const result = handlers.handleConfigureOutputLimits({ provider: 'codex' });
      expect(spy).toHaveBeenCalledWith('codex', 1048576, 524288, 20, true);
      expect(getText(result)).toContain('Output limits configured for codex');
      expect(getText(result)).toContain('max 1048576 bytes output');
    });

    it('persists explicit output limits and disabled flag', () => {
      const spy = vi.spyOn(fileTracking,'setOutputLimit').mockReturnValue(undefined);

      handlers.handleConfigureOutputLimits({
        provider: 'ollama',
        max_output_bytes: 2048,
        max_file_size_bytes: 1024,
        max_file_changes: 7,
        enabled: false
      });

      expect(spy).toHaveBeenCalledWith('ollama', 2048, 1024, 7, false);
    });

    it('applies default pagination when audit trail args are omitted', () => {
      const trail = [{ id: 1 }];
      const spy = vi.spyOn(fileTracking,'getAuditTrail').mockReturnValue(trail);

      const payload = getJson(handlers.handleGetAuditTrail({}));
      expect(spy).toHaveBeenCalledWith({
        entity_type: undefined,
        entity_id: undefined,
        event_type: undefined,
        action: undefined,
        limit: 100,
        offset: 0
      });
      expect(payload.count).toBe(1);
      expect(payload.limit).toBe(100);
      expect(payload.offset).toBe(0);
    });

    it('passes explicit filters and pagination to audit trail lookup', () => {
      const trail = [{ id: 5 }];
      const spy = vi.spyOn(fileTracking,'getAuditTrail').mockReturnValue(trail);

      const payload = getJson(handlers.handleGetAuditTrail({
        entity_type: 'task',
        entity_id: 'task-5',
        event_type: 'state_change',
        action: 'update',
        limit: 25,
        offset: 50
      }));

      expect(spy).toHaveBeenCalledWith({
        entity_type: 'task',
        entity_id: 'task-5',
        event_type: 'state_change',
        action: 'update',
        limit: 25,
        offset: 50
      });
      expect(payload.count).toBe(1);
    });

    it('uses the default audit summary period when period is omitted', () => {
      const summary = { total_events: 12 };
      const spy = vi.spyOn(fileTracking,'getAuditSummary').mockReturnValue(summary);

      const payload = getJson(handlers.handleGetAuditSummary({}));
      expect(spy).toHaveBeenCalledWith(7);
      expect(payload).toEqual({
        days: 7,
        summary
      });
    });

    it('passes through an explicit audit summary period', () => {
      const summary = { total_events: 4 };
      const spy = vi.spyOn(fileTracking,'getAuditSummary').mockReturnValue(summary);

      const payload = getJson(handlers.handleGetAuditSummary({ days: 30 }));
      expect(spy).toHaveBeenCalledWith(30);
      expect(payload).toEqual({
        days: 30,
        summary
      });
    });
  });

  describe('vulnerability and complexity analysis', () => {
    it('requires working_directory for vulnerability scans', async () => {
      const result = await handlers.handleScanVulnerabilities({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('runs vulnerability scan with provided task_id and aggregates totals', async () => {
      vi.spyOn(fileTracking,'runVulnerabilityScan').mockResolvedValue([
        { ecosystem: 'npm', vulnerabilities: { total: 3 } },
        { ecosystem: 'nuget', vulnerabilities: { total: 2 } }
      ]);

      const payload = getJson(await handlers.handleScanVulnerabilities({
        task_id: 'task-6',
        working_directory: '/repo'
      }));

      expect(payload.task_id).toBe('task-6');
      expect(payload.scans_run).toBe(2);
      expect(payload.total_vulnerabilities).toBe(5);
    });

    it('generates fallback scan task id when task_id is omitted', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(123456789);
      vi.spyOn(fileTracking,'runVulnerabilityScan').mockResolvedValue([]);

      const payload = getJson(await handlers.handleScanVulnerabilities({
        working_directory: '/repo'
      }));

      expect(payload.task_id).toBe('scan-123456789');
      expect(payload.scans_run).toBe(0);
    });

    it('returns INTERNAL_ERROR when vulnerability scan throws', async () => {
      vi.spyOn(fileTracking,'runVulnerabilityScan').mockRejectedValue(new Error('scanner failed'));

      const result = await handlers.handleScanVulnerabilities({
        task_id: 'task-7',
        working_directory: '/repo'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(getText(result)).toContain('scanner failed');
    });

    it('requires task_id when fetching vulnerability scan results', () => {
      const result = handlers.handleGetVulnerabilityResults({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns vulnerability scan results for a task', () => {
      const results = [{ ecosystem: 'npm', vulnerabilities: { total: 1 } }];
      const spy = vi.spyOn(fileTracking,'getVulnerabilityScanResults').mockReturnValue(results);

      const payload = getJson(handlers.handleGetVulnerabilityResults({ task_id: 'task-7b' }));
      expect(spy).toHaveBeenCalledWith('task-7b');
      expect(payload).toEqual({
        task_id: 'task-7b',
        results
      });
    });

    it('analyzes complexity only for code extensions', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-8' });
      vi.spyOn(fileTracking,'getTaskFileChanges').mockReturnValue([
        { file_path: 'src/app.js', new_content: 'function a() {}' },
        { file_path: 'docs/README.md', new_content: '# docs' },
        { file_path: 'src/worker.py', new_content: 'def run(): pass' }
      ]);
      const complexitySpy = vi.spyOn(fileTracking,'analyzeCodeComplexity');
      complexitySpy
        .mockReturnValueOnce({ file_path: 'src/app.js', cyclomatic: 3 })
        .mockReturnValueOnce({ file_path: 'src/worker.py', cyclomatic: 5 });

      const payload = getJson(handlers.handleAnalyzeComplexity({ task_id: 'task-8' }));
      expect(payload.files_analyzed).toBe(2);
      expect(complexitySpy).toHaveBeenCalledTimes(2);
    });

    it('returns error when complexity analysis is requested without task_id', () => {
      const result = handlers.handleAnalyzeComplexity({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns TASK_NOT_FOUND when complexity task does not exist', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
      const result = handlers.handleAnalyzeComplexity({ task_id: 'missing-complexity-task' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('skips complexity analysis for files without code content', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-8b' });
      vi.spyOn(fileTracking,'getTaskFileChanges').mockReturnValue([
        { file_path: 'src/empty.js' },
        { new_content: 'function orphan() {}' },
        { file_path: 'docs/notes.md', new_content: '# docs' }
      ]);
      const complexitySpy = vi.spyOn(fileTracking,'analyzeCodeComplexity');

      const payload = getJson(handlers.handleAnalyzeComplexity({ task_id: 'task-8b' }));
      expect(complexitySpy).not.toHaveBeenCalled();
      expect(payload.files_analyzed).toBe(0);
      expect(payload.results).toEqual([]);
    });

    it('requires task_id when fetching complexity metrics', () => {
      const result = handlers.handleGetComplexityMetrics({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns stored complexity metrics for a task', () => {
      const metrics = [{ file_path: 'src/app.js', cyclomatic: 3 }];
      const spy = vi.spyOn(fileTracking,'getComplexityMetrics').mockReturnValue(metrics);

      const payload = getJson(handlers.handleGetComplexityMetrics({ task_id: 'task-8c' }));
      expect(spy).toHaveBeenCalledWith('task-8c');
      expect(payload).toEqual({
        task_id: 'task-8c',
        metrics
      });
    });

    it('detects dead code and annotates results with source file path', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-9' });
      vi.spyOn(fileTracking,'getTaskFileChanges').mockReturnValue([
        { file_path: 'src/a.js', new_content: 'const a = 1;' },
        { file_path: 'notes.md', new_content: 'skip' }
      ]);
      vi.spyOn(fileTracking,'detectDeadCode').mockReturnValue([
        { symbol: 'unusedVar', line: 4 }
      ]);

      const payload = getJson(handlers.handleDetectDeadCode({ task_id: 'task-9' }));
      expect(payload.dead_code_count).toBe(1);
      expect(payload.results[0].file_path).toBe('src/a.js');
      expect(payload.results[0].symbol).toBe('unusedVar');
    });

    it('returns error when dead code detection is requested without task_id', () => {
      const result = handlers.handleDetectDeadCode({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns TASK_NOT_FOUND when dead code task does not exist', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
      const result = handlers.handleDetectDeadCode({ task_id: 'missing-dead-code-task' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('ignores dead code checks for unsupported source extensions or missing content', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-9b' });
      vi.spyOn(fileTracking,'getTaskFileChanges').mockReturnValue([
        { file_path: 'src/service.java', new_content: 'class Service {}' },
        { file_path: 'src/app.ts' },
        { new_content: 'const missingPath = true;' }
      ]);
      const deadCodeSpy = vi.spyOn(fileTracking,'detectDeadCode');

      const payload = getJson(handlers.handleDetectDeadCode({ task_id: 'task-9b' }));
      expect(deadCodeSpy).not.toHaveBeenCalled();
      expect(payload.dead_code_count).toBe(0);
      expect(payload.results).toEqual([]);
    });

    it('requires task_id when fetching dead code results', () => {
      const result = handlers.handleGetDeadCodeResults({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns stored dead code results for a task', () => {
      const results = [{ file_path: 'src/a.js', symbol: 'unusedVar' }];
      const spy = vi.spyOn(fileTracking,'getDeadCodeResults').mockReturnValue(results);

      const payload = getJson(handlers.handleGetDeadCodeResults({ task_id: 'task-9c' }));
      expect(spy).toHaveBeenCalledWith('task-9c');
      expect(payload).toEqual({
        task_id: 'task-9c',
        results
      });
    });
  });

  describe('API contract and documentation quality', () => {
    it('requires task_id, contract_file, and working_directory for API contract validation', async () => {
      const result = await handlers.handleValidateApiContract({
        task_id: 'task-10',
        contract_file: 'openapi.yaml'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('merges API contract validation result with task_id', async () => {
      vi.spyOn(fileTracking,'validateApiContract').mockResolvedValue({
        valid: false,
        breaking_changes: 2
      });

      const payload = getJson(await handlers.handleValidateApiContract({
        task_id: 'task-11',
        contract_file: 'openapi.yaml',
        working_directory: '/repo'
      }));

      expect(payload).toEqual({
        task_id: 'task-11',
        valid: false,
        breaking_changes: 2
      });
    });

    it('returns INTERNAL_ERROR when API contract validation throws', async () => {
      vi.spyOn(fileTracking,'validateApiContract').mockRejectedValue(new Error('contract parse failed'));

      const result = await handlers.handleValidateApiContract({
        task_id: 'task-11b',
        contract_file: 'openapi.yaml',
        working_directory: '/repo'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(getText(result)).toContain('contract parse failed');
    });

    it('calculates rounded average documentation coverage for code files', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-12' });
      vi.spyOn(fileTracking,'getTaskFileChanges').mockReturnValue([
        { file_path: 'src/a.js', new_content: 'function a() {}' },
        { file_path: 'src/b.ts', new_content: 'function b() {}' },
        { file_path: 'README.md', new_content: '# docs' }
      ]);
      const coverageSpy = vi.spyOn(fileTracking,'checkDocCoverage');
      coverageSpy
        .mockReturnValueOnce({ file_path: 'src/a.js', coverage_percent: 87.44 })
        .mockReturnValueOnce({ file_path: 'src/b.ts', coverage_percent: 92.09 });

      const payload = getJson(handlers.handleCheckDocCoverage({ task_id: 'task-12' }));
      expect(coverageSpy).toHaveBeenCalledTimes(2);
      expect(payload.files_checked).toBe(2);
      expect(payload.average_coverage).toBe(89.8);
    });

    it('returns error when documentation coverage is requested without task_id', () => {
      const result = handlers.handleCheckDocCoverage({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns TASK_NOT_FOUND when documentation coverage task does not exist', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
      const result = handlers.handleCheckDocCoverage({ task_id: 'missing-doc-task' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('returns zero documentation coverage when no changed files qualify', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-12b' });
      vi.spyOn(fileTracking,'getTaskFileChanges').mockReturnValue([
        { file_path: 'README.md', new_content: '# docs' },
        { file_path: 'src/no-content.js' },
        { new_content: 'function noPath() {}' }
      ]);
      const coverageSpy = vi.spyOn(fileTracking,'checkDocCoverage');

      const payload = getJson(handlers.handleCheckDocCoverage({ task_id: 'task-12b' }));
      expect(coverageSpy).not.toHaveBeenCalled();
      expect(payload.files_checked).toBe(0);
      expect(payload.average_coverage).toBe(0);
      expect(payload.results).toEqual([]);
    });

    it('requires task_id when fetching documentation coverage results', () => {
      const result = handlers.handleGetDocCoverageResults({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns stored documentation coverage results for a task', () => {
      const results = [{ file_path: 'src/a.js', coverage_percent: 87.4 }];
      const spy = vi.spyOn(fileTracking,'getDocCoverageResults').mockReturnValue(results);

      const payload = getJson(handlers.handleGetDocCoverageResults({ task_id: 'task-12c' }));
      expect(spy).toHaveBeenCalledWith('task-12c');
      expect(payload).toEqual({
        task_id: 'task-12c',
        results
      });
    });
  });
});
