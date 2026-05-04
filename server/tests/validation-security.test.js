'use strict';

const realShared = require('../handlers/shared');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

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

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/validation/security')];
  installMock('../database', mockDb);
  installMock('../db/file/tracking', mockDb);
  installMock('../db/task-core', mockDb);
  installMock('../handlers/shared', realShared);
  return require('../handlers/validation/security');
}

function resetMockDefaults() {
  for (const fn of Object.values(mockDb)) {
    fn.mockReset();
  }

  mockDb.getRateLimits.mockReturnValue([]);
  mockDb.setRateLimit.mockReturnValue(undefined);
  mockDb.getTask.mockReturnValue({ id: 'task-default' });
  mockDb.getTaskFileChanges.mockReturnValue([]);
  mockDb.runSecurityScan.mockReturnValue([]);
  mockDb.getSecurityScanResults.mockReturnValue([]);
  mockDb.getSecurityRules.mockReturnValue([]);
  mockDb.getActiveFileLocks.mockReturnValue([]);
  mockDb.releaseAllFileLocks.mockReturnValue(0);
  mockDb.getTaskBackups.mockReturnValue([]);
  mockDb.restoreFileBackup.mockReturnValue({
    success: false,
    error: 'Failed to restore backup',
  });
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function getJson(result) {
  return JSON.parse(getText(result));
}

describe('validation/security handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleGetRateLimits', () => {
    it('returns rate limits for the requested provider', () => {
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

    it('returns an empty rate-limit inventory when nothing is configured', () => {
      const payload = getJson(handlers.handleGetRateLimits({}));

      expect(mockDb.getRateLimits).toHaveBeenCalledWith(undefined);
      expect(payload).toEqual({
        rate_limits: [],
        count: 0,
      });
    });
  });

  describe('handleSetRateLimit', () => {
    it('returns MISSING_REQUIRED_PARAM when provider is missing', () => {
      const result = handlers.handleSetRateLimit({ max_value: 10 });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('provider is required');
      expect(mockDb.setRateLimit).not.toHaveBeenCalled();
    });

    it('returns INVALID_PARAM when max_value is not a positive number', () => {
      const result = handlers.handleSetRateLimit({ provider: 'openai', max_value: 0 });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('max_value must be a positive number');
      expect(mockDb.setRateLimit).not.toHaveBeenCalled();
    });

    it('applies default values when optional arguments are omitted', () => {
      const result = handlers.handleSetRateLimit({
        provider: 'openai',
        max_value: 60,
      });

      expect(mockDb.setRateLimit).toHaveBeenCalledWith('openai', 'requests', 60, 60, true);
      expect(getText(result)).toContain('Rate limit set for openai: 60 requests per 60 seconds');
    });

    it('passes custom rate-limit settings through to the database layer', () => {
      const result = handlers.handleSetRateLimit({
        provider: 'anthropic',
        limit_type: 'tokens',
        max_value: 5000,
        window_seconds: 120,
        enabled: false,
      });

      expect(mockDb.setRateLimit).toHaveBeenCalledWith('anthropic', 'tokens', 5000, 120, false);
      expect(getText(result)).toContain('Rate limit set for anthropic: 5000 tokens per 120 seconds');
    });
  });

  describe('handleRunSecurityScan', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleRunSecurityScan({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleRunSecurityScan({ task_id: 'missing-task' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getText(result)).toContain('Task not found: missing-task');
      expect(mockDb.getTaskFileChanges).not.toHaveBeenCalled();
    });

    it('scans changed files with new content and aggregates all findings', () => {
      mockDb.getTask.mockReturnValue({ id: 'task-1' });
      mockDb.getTaskFileChanges.mockReturnValue([
        { file_path: 'package-lock.json', new_content: '{"deps":1}' },
        { file_path: '.env', new_content: 'API_KEY=secret' },
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
      expect(mockDb.runSecurityScan).toHaveBeenNthCalledWith(
        2,
        'task-1',
        '.env',
        'API_KEY=secret'
      );
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
  });

  describe('handleGetSecurityResults', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleGetSecurityResults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getSecurityScanResults).not.toHaveBeenCalled();
    });

    it('returns stored security results for a task', () => {
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
  });

  describe('handleListSecurityRules', () => {
    it('passes category and enabled filters through to the database', () => {
      mockDb.getSecurityRules.mockReturnValue([{ id: 'rule-1', category: 'secrets', enabled: true }]);

      const payload = getJson(
        handlers.handleListSecurityRules({ category: 'secrets', enabled: true })
      );

      expect(mockDb.getSecurityRules).toHaveBeenCalledWith('secrets', true);
      expect(payload).toEqual({
        rules: [{ id: 'rule-1', category: 'secrets', enabled: true }],
        count: 1,
      });
    });

    it('lists all rules when filters are omitted', () => {
      const payload = getJson(handlers.handleListSecurityRules({}));

      expect(mockDb.getSecurityRules).toHaveBeenCalledWith(undefined, undefined);
      expect(payload).toEqual({
        rules: [],
        count: 0,
      });
    });
  });

  describe('handleGetFileLocks', () => {
    it('returns active file locks for a working directory', () => {
      mockDb.getActiveFileLocks.mockReturnValue([
        { file_path: 'src/a.js', task_id: 'task-1' },
        { file_path: 'src/b.js', task_id: 'task-2' },
      ]);

      const payload = getJson(handlers.handleGetFileLocks({ working_directory: '/repo' }));

      expect(mockDb.getActiveFileLocks).toHaveBeenCalledWith('/repo');
      expect(payload).toEqual({
        locks: [
          { file_path: 'src/a.js', task_id: 'task-1' },
          { file_path: 'src/b.js', task_id: 'task-2' },
        ],
        count: 2,
      });
    });
  });

  describe('handleReleaseFileLocks', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleReleaseFileLocks({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.releaseAllFileLocks).not.toHaveBeenCalled();
    });

    it('releases all file locks for a task', () => {
      mockDb.releaseAllFileLocks.mockReturnValue(3);

      const result = handlers.handleReleaseFileLocks({ task_id: 'task-3' });

      expect(mockDb.releaseAllFileLocks).toHaveBeenCalledWith('task-3');
      expect(getText(result)).toContain('Released 3 file lock(s) for task task-3');
    });
  });

  describe('handleListBackups', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleListBackups({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getTaskBackups).not.toHaveBeenCalled();
    });

    it('returns backups for a task', () => {
      mockDb.getTaskBackups.mockReturnValue([
        { id: 'bk-1', file_path: 'src/app.js' },
        { id: 'bk-2', file_path: 'src/worker.js' },
      ]);

      const payload = getJson(handlers.handleListBackups({ task_id: 'task-4' }));

      expect(mockDb.getTaskBackups).toHaveBeenCalledWith('task-4');
      expect(payload).toEqual({
        task_id: 'task-4',
        backups: [
          { id: 'bk-1', file_path: 'src/app.js' },
          { id: 'bk-2', file_path: 'src/worker.js' },
        ],
        count: 2,
      });
    });
  });

  describe('handleRestoreBackup', () => {
    it('returns MISSING_REQUIRED_PARAM when backup_id is missing', () => {
      const result = handlers.handleRestoreBackup({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('backup_id is required');
      expect(mockDb.restoreFileBackup).not.toHaveBeenCalled();
    });

    it('returns OPERATION_FAILED when the backup resource is not found', () => {
      mockDb.restoreFileBackup.mockReturnValue({
        success: false,
        error: 'Backup not found: bk-missing',
      });

      const result = handlers.handleRestoreBackup({ backup_id: 'bk-missing' });

      expect(mockDb.restoreFileBackup).toHaveBeenCalledWith('bk-missing');
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getText(result)).toContain('Backup not found: bk-missing');
    });

    it('falls back to the default restore error when no explicit error is returned', () => {
      mockDb.restoreFileBackup.mockReturnValue({ success: false });

      const result = handlers.handleRestoreBackup({ backup_id: 'bk-2' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getText(result)).toContain('Failed to restore backup');
    });

    it('returns a success message when the backup is restored', () => {
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
