'use strict';

const mockDb = {
  getRateLimits: vi.fn(),
  setRateLimit: vi.fn(),
  getTask: vi.fn(),
  getTaskFileChanges: vi.fn(),
  runSecurityScan: vi.fn(),
  getSecurityScanResults: vi.fn(),
  getSecurityRules: vi.fn(),
  getActiveFileLocks: vi.fn(),
  releaseAllFileLocks: vi.fn(),
  getTaskBackups: vi.fn(),
  restoreFileBackup: vi.fn(),
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
  delete require.cache[require.resolve('../handlers/validation/security')];
  installCjsModuleMock('../database', mockDb);
  return require('../handlers/validation/security');
}

vi.mock('../database', () => mockDb);

function resetMockDefaults() {
  mockDb.getRateLimits.mockReset();
  mockDb.getRateLimits.mockReturnValue([]);

  mockDb.setRateLimit.mockReset();
  mockDb.setRateLimit.mockReturnValue(undefined);

  mockDb.getTask.mockReset();
  mockDb.getTask.mockReturnValue({ id: 'task-default' });

  mockDb.getTaskFileChanges.mockReset();
  mockDb.getTaskFileChanges.mockReturnValue([]);

  mockDb.runSecurityScan.mockReset();
  mockDb.runSecurityScan.mockReturnValue([]);

  mockDb.getSecurityScanResults.mockReset();
  mockDb.getSecurityScanResults.mockReturnValue([]);

  mockDb.getSecurityRules.mockReset();
  mockDb.getSecurityRules.mockReturnValue([]);

  mockDb.getActiveFileLocks.mockReset();
  mockDb.getActiveFileLocks.mockReturnValue([]);

  mockDb.releaseAllFileLocks.mockReset();
  mockDb.releaseAllFileLocks.mockReturnValue(0);

  mockDb.getTaskBackups.mockReset();
  mockDb.getTaskBackups.mockReturnValue([]);

  mockDb.restoreFileBackup.mockReset();
  mockDb.restoreFileBackup.mockReturnValue({ success: false, error: 'Failed to restore backup' });
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function getJson(result) {
  return JSON.parse(getText(result));
}

describe('handler:validation-security-handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rate limit handlers', () => {
    it('returns rate limits for a provider filter', () => {
      mockDb.getRateLimits.mockReturnValue([
        { provider: 'openai', limit_type: 'requests', max_value: 100 },
      ]);

      const payload = getJson(handlers.handleGetRateLimits({ provider: 'openai' }));

      expect(mockDb.getRateLimits).toHaveBeenCalledWith('openai');
      expect(payload).toEqual({
        rate_limits: [{ provider: 'openai', limit_type: 'requests', max_value: 100 }],
        count: 1,
      });
    });

    it('returns empty rate limit inventory when no limits exist', () => {
      const payload = getJson(handlers.handleGetRateLimits({}));

      expect(mockDb.getRateLimits).toHaveBeenCalledWith(undefined);
      expect(payload).toEqual({
        rate_limits: [],
        count: 0,
      });
    });

    it('requires provider for handleSetRateLimit', () => {
      const result = handlers.handleSetRateLimit({ max_value: 5 });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('provider is required');
      expect(mockDb.setRateLimit).not.toHaveBeenCalled();
    });

    it('requires positive max_value for handleSetRateLimit', () => {
      const result = handlers.handleSetRateLimit({ provider: 'openai', max_value: 0 });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('max_value must be a positive number');
      expect(mockDb.setRateLimit).not.toHaveBeenCalled();
    });

    it('applies default rate-limit fields when optional args are omitted', () => {
      const result = handlers.handleSetRateLimit({
        provider: 'openai',
        max_value: 60,
      });

      expect(mockDb.setRateLimit).toHaveBeenCalledWith('openai', 'requests', 60, 60, true);
      expect(getText(result)).toContain('Rate limit set for openai: 60 requests per 60 seconds');
    });

    it('passes custom rate-limit options through to persistence layer', () => {
      handlers.handleSetRateLimit({
        provider: 'claude',
        limit_type: 'tokens',
        max_value: 5000,
        window_seconds: 120,
        enabled: false,
      });

      expect(mockDb.setRateLimit).toHaveBeenCalledWith('claude', 'tokens', 5000, 120, false);
    });
  });

  describe('security scan handlers', () => {
    it('requires task_id for handleRunSecurityScan', () => {
      const result = handlers.handleRunSecurityScan({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when scanning an unknown task', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleRunSecurityScan({ task_id: 'missing-task' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getText(result)).toContain('Task not found: missing-task');
      expect(mockDb.getTaskFileChanges).not.toHaveBeenCalled();
    });

    it('runs scans only for changed files with truthy new content and aggregates findings', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-1' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'package-lock.json', new_content: '{"deps":1}' },
        { file_path: '.env', new_content: 'API_KEY=abc' },
        { file_path: 'README.md', new_content: '' },
        { file_path: 'notes.txt' },
        { file_path: 'config.yml', new_content: null },
      ]);
      mockDb.runSecurityScan
        .mockReturnValueOnce([{ type: 'dependency', severity: 'high' }])
        .mockReturnValueOnce([
          { type: 'secret', severity: 'critical' },
          { type: 'secret', severity: 'medium' },
        ]);

      const payload = getJson(handlers.handleRunSecurityScan({ task_id: 'task-1' }));

      expect(mockDb.getTask).toHaveBeenCalledWith('task-1');
      expect(mockDb.getTaskFileChanges).toHaveBeenCalledWith('task-1');
      expect(mockDb.runSecurityScan).toHaveBeenCalledTimes(2);
      expect(mockDb.runSecurityScan).toHaveBeenNthCalledWith(
        1,
        'task-1',
        'package-lock.json',
        '{"deps":1}'
      );
      expect(mockDb.runSecurityScan).toHaveBeenNthCalledWith(2, 'task-1', '.env', 'API_KEY=abc');
      expect(payload).toEqual({
        task_id: 'task-1',
        issues_found: 3,
        results: [
          { type: 'dependency', severity: 'high' },
          { type: 'secret', severity: 'critical' },
          { type: 'secret', severity: 'medium' },
        ],
      });
    });

    it('returns zero findings when no changed files include new content', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-empty' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'README.md', new_content: '' },
        { file_path: 'notes.txt' },
        { file_path: 'config.yml', new_content: null },
      ]);

      const payload = getJson(handlers.handleRunSecurityScan({ task_id: 'task-empty' }));

      expect(mockDb.runSecurityScan).not.toHaveBeenCalled();
      expect(payload).toEqual({
        task_id: 'task-empty',
        issues_found: 0,
        results: [],
      });
    });

    it('requires task_id for handleGetSecurityResults', () => {
      const result = handlers.handleGetSecurityResults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getSecurityScanResults).not.toHaveBeenCalled();
    });

    it('returns stored security results with an issue count', () => {
      mockDb.getSecurityScanResults.mockReturnValue([
        { type: 'secret', severity: 'critical' },
        { type: 'permission', severity: 'high' },
      ]);

      const payload = getJson(handlers.handleGetSecurityResults({ task_id: 'task-2' }));

      expect(mockDb.getSecurityScanResults).toHaveBeenCalledWith('task-2');
      expect(payload).toEqual({
        task_id: 'task-2',
        issues_found: 2,
        results: [
          { type: 'secret', severity: 'critical' },
          { type: 'permission', severity: 'high' },
        ],
      });
    });

    it('passes category and enabled filters to handleListSecurityRules', () => {
      mockDb.getSecurityRules.mockReturnValue([{ id: 'r1', category: 'secrets' }]);

      const payload = getJson(
        handlers.handleListSecurityRules({ category: 'secrets', enabled: true })
      );

      expect(mockDb.getSecurityRules).toHaveBeenCalledWith('secrets', true);
      expect(payload).toEqual({
        rules: [{ id: 'r1', category: 'secrets' }],
        count: 1,
      });
    });

    it('lists all security rules when filters are omitted', () => {
      const payload = getJson(handlers.handleListSecurityRules({}));

      expect(mockDb.getSecurityRules).toHaveBeenCalledWith(undefined, undefined);
      expect(payload).toEqual({
        rules: [],
        count: 0,
      });
    });
  });

  describe('file lock and backup handlers', () => {
    it('returns file lock inventory for a working directory', () => {
      mockDb.getActiveFileLocks.mockReturnValue([
        { file: 'a.js', task_id: 'task-1' },
        { file: 'b.js', task_id: 'task-2' },
      ]);

      const payload = getJson(handlers.handleGetFileLocks({ working_directory: '/repo' }));

      expect(mockDb.getActiveFileLocks).toHaveBeenCalledWith('/repo');
      expect(payload).toEqual({
        locks: [
          { file: 'a.js', task_id: 'task-1' },
          { file: 'b.js', task_id: 'task-2' },
        ],
        count: 2,
      });
    });

    it('requires task_id when releasing file locks', () => {
      const result = handlers.handleReleaseFileLocks({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.releaseAllFileLocks).not.toHaveBeenCalled();
    });

    it('returns the released lock count for a task', () => {
      mockDb.releaseAllFileLocks.mockReturnValue(3);

      const result = handlers.handleReleaseFileLocks({ task_id: 'task-3' });

      expect(mockDb.releaseAllFileLocks).toHaveBeenCalledWith('task-3');
      expect(getText(result)).toContain('Released 3 file lock(s) for task task-3');
    });

    it('requires task_id for backup listing', () => {
      const result = handlers.handleListBackups({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.getTaskBackups).not.toHaveBeenCalled();
    });

    it('returns task backups with a count', () => {
      mockDb.getTaskBackups.mockReturnValue([
        { id: 'b1', file_path: 'src/app.js' },
        { id: 'b2', file_path: 'src/worker.js' },
      ]);

      const payload = getJson(handlers.handleListBackups({ task_id: 'task-4' }));

      expect(mockDb.getTaskBackups).toHaveBeenCalledWith('task-4');
      expect(payload).toEqual({
        task_id: 'task-4',
        backups: [
          { id: 'b1', file_path: 'src/app.js' },
          { id: 'b2', file_path: 'src/worker.js' },
        ],
        count: 2,
      });
    });

    it('requires backup_id when restoring backups', () => {
      const result = handlers.handleRestoreBackup({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(mockDb.restoreFileBackup).not.toHaveBeenCalled();
    });

    it('returns OPERATION_FAILED when backup restore fails with an explicit error', () => {
      mockDb.restoreFileBackup.mockReturnValue({
        success: false,
        error: 'permission denied',
      });

      const result = handlers.handleRestoreBackup({ backup_id: 'bk-1' });

      expect(mockDb.restoreFileBackup).toHaveBeenCalledWith('bk-1');
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getText(result)).toContain('permission denied');
    });

    it('falls back to a default restore error message when the database omits one', () => {
      mockDb.restoreFileBackup.mockReturnValue({ success: false });

      const result = handlers.handleRestoreBackup({ backup_id: 'bk-2' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getText(result)).toContain('Failed to restore backup');
    });

    it('returns a success message when backup restore succeeds', () => {
      mockDb.restoreFileBackup.mockReturnValue({
        success: true,
        file_path: 'src/app.js',
      });

      const result = handlers.handleRestoreBackup({ backup_id: 'bk-3' });

      expect(mockDb.restoreFileBackup).toHaveBeenCalledWith('bk-3');
      expect(getText(result)).toContain('Restored src/app.js from backup');
    });
  });
});
