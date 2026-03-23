'use strict';

const realShared = require('../handlers/shared');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const checkFileLocationAnomalies = vi.fn();
const getAllFileLocationIssues = vi.fn();
const resolveFileLocationIssue = vi.fn();
const resolveFileLocationAnomaly = vi.fn();
const getSimilarFileSearchResults = vi.fn();

const mockDb = {
  getTask: vi.fn(),
  setExpectedOutputPath: vi.fn(),
  checkFileLocations: checkFileLocationAnomalies,
  checkFileLocationAnomalies,
  checkDuplicateFiles: vi.fn(),
  getFileLocationIssues: getAllFileLocationIssues,
  getAllFileLocationIssues,
  recordFileChange: vi.fn(),
  resolveFileLocationIssue,
  resolveFileLocationAnomaly,
  resolveDuplicateFile: vi.fn(),
  searchSimilarFiles: vi.fn(),
  getSimilarFileResults: getSimilarFileSearchResults,
  getSimilarFileSearchResults,
};

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/validation/file')];
  installMock('../database', mockDb);
  installMock('../db/file-tracking', mockDb);
  installMock('../db/task-core', mockDb);
  installMock('../handlers/shared', realShared);
  return require('../handlers/validation/file');
}

function resetMockDefaults() {
  for (const fn of new Set(Object.values(mockDb))) {
    if (typeof fn?.mockReset === 'function') {
      fn.mockReset();
    }
  }

  mockDb.getTask.mockReturnValue({ id: 'task-default', working_directory: '/repo/default' });
  mockDb.setExpectedOutputPath.mockReturnValue({
    task_id: 'task-default',
    expected_directory: '/repo/default/out',
    allow_subdirs: true,
  });
  checkFileLocationAnomalies.mockReturnValue([]);
  mockDb.checkDuplicateFiles.mockReturnValue([]);
  getAllFileLocationIssues.mockReturnValue({
    total_issues: 0,
    anomalies: [],
    duplicates: [],
  });
  mockDb.recordFileChange.mockReturnValue({
    task_id: 'task-default',
    file_path: 'src/default.js',
    change_type: 'created',
    is_outside_workdir: false,
  });
  resolveFileLocationIssue.mockReturnValue({ resolved: 1 });
  resolveFileLocationAnomaly.mockReturnValue({ resolved: 1 });
  mockDb.resolveDuplicateFile.mockReturnValue({ resolved: 1 });
  mockDb.searchSimilarFiles.mockReturnValue({
    task_id: 'task-default',
    status: 'no_matches',
    matches_found: 0,
    matches: [],
    recommendation: null,
  });
  getSimilarFileSearchResults.mockReturnValue([]);
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function getJson(result) {
  return JSON.parse(getText(result));
}

describe('validation/file handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleSetExpectedOutputPath', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleSetExpectedOutputPath({ expected_directory: '/repo/out' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns MISSING_REQUIRED_PARAM when expected_directory is missing', () => {
      const result = handlers.handleSetExpectedOutputPath({ task_id: 'task-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('expected_directory is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleSetExpectedOutputPath({
        task_id: 'task-missing',
        expected_directory: '/repo/out',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getText(result)).toContain('Task not found: task-missing');
      expect(mockDb.setExpectedOutputPath).not.toHaveBeenCalled();
    });

    it('stores expected output rules and returns the persisted payload', () => {
      mockDb.setExpectedOutputPath.mockReturnValue({
        task_id: 'task-1',
        expected_directory: '/repo/project/dist',
        allow_subdirs: false,
        file_patterns: ['*.js', '*.ts'],
      });

      const payload = getJson(handlers.handleSetExpectedOutputPath({
        task_id: 'task-1',
        expected_directory: '/repo/project/dist',
        allow_subdirs: false,
        file_patterns: ['*.js', '*.ts'],
      }));

      expect(mockDb.setExpectedOutputPath).toHaveBeenCalledWith('task-1', '/repo/project/dist', {
        allowSubdirs: false,
        filePatterns: ['*.js', '*.ts'],
      });
      expect(payload).toEqual({
        message: 'Expected output path set',
        task_id: 'task-1',
        expected_directory: '/repo/project/dist',
        allow_subdirs: false,
        file_patterns: ['*.js', '*.ts'],
      });
    });
  });

  describe('handleCheckFileLocations', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleCheckFileLocations({ working_directory: '/repo/project' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns MISSING_REQUIRED_PARAM when working_directory is missing', () => {
      const result = handlers.handleCheckFileLocations({ task_id: 'task-2' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('working_directory is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleCheckFileLocations({
        task_id: 'task-missing',
        working_directory: '/repo/project',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(checkFileLocationAnomalies).not.toHaveBeenCalled();
    });

    it('returns anomaly results and issues_found status', () => {
      checkFileLocationAnomalies.mockReturnValue([
        { id: 11, anomaly_type: 'outside_workdir', file_path: '/tmp/rogue.js' },
      ]);

      const payload = getJson(handlers.handleCheckFileLocations({
        task_id: 'task-2',
        working_directory: '/repo/project',
      }));

      expect(checkFileLocationAnomalies).toHaveBeenCalledWith('task-2', '/repo/project');
      expect(payload).toEqual({
        task_id: 'task-2',
        working_directory: '/repo/project',
        anomalies_found: 1,
        anomalies: [
          { id: 11, anomaly_type: 'outside_workdir', file_path: '/tmp/rogue.js' },
        ],
        status: 'issues_found',
      });
    });
  });

  describe('handleCheckDuplicateFiles', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleCheckDuplicateFiles({ working_directory: '/repo/project' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns MISSING_REQUIRED_PARAM when working_directory is missing', () => {
      const result = handlers.handleCheckDuplicateFiles({ task_id: 'task-3' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('working_directory is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleCheckDuplicateFiles({
        task_id: 'task-missing',
        working_directory: '/repo/project',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(mockDb.checkDuplicateFiles).not.toHaveBeenCalled();
    });

    it('returns duplicate results and duplicates_found status', () => {
      mockDb.checkDuplicateFiles.mockReturnValue([
        {
          id: 41,
          file_name: 'Widget.ts',
          location_count: 2,
          locations: ['/repo/a/Widget.ts', '/repo/b/Widget.ts'],
        },
      ]);

      const payload = getJson(handlers.handleCheckDuplicateFiles({
        task_id: 'task-3',
        working_directory: '/repo/project',
        file_extensions: ['.ts'],
      }));

      expect(mockDb.checkDuplicateFiles).toHaveBeenCalledWith('task-3', '/repo/project', {
        fileExtensions: ['.ts'],
      });
      expect(payload).toEqual({
        task_id: 'task-3',
        working_directory: '/repo/project',
        duplicates_found: 1,
        duplicates: [
          {
            id: 41,
            file_name: 'Widget.ts',
            location_count: 2,
            locations: ['/repo/a/Widget.ts', '/repo/b/Widget.ts'],
          },
        ],
        status: 'duplicates_found',
      });
    });
  });

  describe('handleGetFileLocationIssues', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleGetFileLocationIssues({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleGetFileLocationIssues({ task_id: 'task-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getAllFileLocationIssues).not.toHaveBeenCalled();
    });

    it('returns aggregated file location issues', () => {
      getAllFileLocationIssues.mockReturnValue({
        total_issues: 2,
        anomalies: [{ id: 1, anomaly_type: 'outside_workdir' }],
        duplicates: [{ id: 2, file_name: 'Widget.ts' }],
      });

      const payload = getJson(handlers.handleGetFileLocationIssues({ task_id: 'task-4' }));

      expect(getAllFileLocationIssues).toHaveBeenCalledWith('task-4');
      expect(payload).toEqual({
        task_id: 'task-4',
        total_issues: 2,
        anomalies: [{ id: 1, anomaly_type: 'outside_workdir' }],
        duplicates: [{ id: 2, file_name: 'Widget.ts' }],
        status: 'issues_found',
      });
    });
  });

  describe('handleRecordFileChange', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleRecordFileChange({
        file_path: 'src/new.js',
        change_type: 'created',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns MISSING_REQUIRED_PARAM when file_path is missing', () => {
      const result = handlers.handleRecordFileChange({
        task_id: 'task-5',
        change_type: 'created',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('file_path is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns MISSING_REQUIRED_PARAM when change_type is missing', () => {
      const result = handlers.handleRecordFileChange({
        task_id: 'task-5',
        file_path: 'src/new.js',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('change_type is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns INVALID_PARAM for unsupported change types', () => {
      const result = handlers.handleRecordFileChange({
        task_id: 'task-5',
        file_path: 'src/new.js',
        change_type: 'renamed',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('change_type must be one of: created, modified, deleted');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleRecordFileChange({
        task_id: 'task-missing',
        file_path: 'src/new.js',
        change_type: 'created',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(mockDb.recordFileChange).not.toHaveBeenCalled();
    });

    it('records file changes and returns the stored payload', () => {
      mockDb.recordFileChange.mockReturnValue({
        task_id: 'task-5',
        file_path: 'src/new.js',
        change_type: 'modified',
        relative_path: 'src/new.js',
        is_outside_workdir: false,
      });

      const payload = getJson(handlers.handleRecordFileChange({
        task_id: 'task-5',
        file_path: 'src/new.js',
        change_type: 'modified',
        working_directory: '/repo/project',
      }));

      expect(mockDb.recordFileChange).toHaveBeenCalledWith('task-5', 'src/new.js', 'modified', {
        workingDirectory: '/repo/project',
      });
      expect(payload).toEqual({
        message: 'File change recorded',
        task_id: 'task-5',
        file_path: 'src/new.js',
        change_type: 'modified',
        relative_path: 'src/new.js',
        is_outside_workdir: false,
      });
    });
  });

  describe('handleResolveFileLocationIssue', () => {
    it('returns MISSING_REQUIRED_PARAM when issue_type is missing', () => {
      const result = handlers.handleResolveFileLocationIssue({ issue_id: 100 });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('issue_type is required');
    });

    it('returns MISSING_REQUIRED_PARAM when issue_id is missing', () => {
      const result = handlers.handleResolveFileLocationIssue({ issue_type: 'anomaly' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('issue_id is required');
    });

    it('returns INVALID_PARAM for unsupported issue types', () => {
      const result = handlers.handleResolveFileLocationIssue({
        issue_type: 'unknown',
        issue_id: 100,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('issue_type must be either "anomaly" or "duplicate"');
      expect(resolveFileLocationAnomaly).not.toHaveBeenCalled();
      expect(mockDb.resolveDuplicateFile).not.toHaveBeenCalled();
    });

    it('resolves anomaly issues', () => {
      resolveFileLocationAnomaly.mockReturnValue({ resolved: 1, issue_id: 101 });

      const payload = getJson(handlers.handleResolveFileLocationIssue({
        issue_type: 'anomaly',
        issue_id: 101,
      }));

      expect(resolveFileLocationAnomaly).toHaveBeenCalledWith(101);
      expect(payload).toEqual({
        message: 'Issue resolved',
        issue_type: 'anomaly',
        result: { resolved: 1, issue_id: 101 },
      });
    });

    it('resolves duplicate issues', () => {
      mockDb.resolveDuplicateFile.mockReturnValue({ resolved: 1, issue_id: 202 });

      const payload = getJson(handlers.handleResolveFileLocationIssue({
        issue_type: 'duplicate',
        issue_id: 202,
      }));

      expect(mockDb.resolveDuplicateFile).toHaveBeenCalledWith(202);
      expect(payload).toEqual({
        message: 'Issue resolved',
        issue_type: 'duplicate',
        result: { resolved: 1, issue_id: 202 },
      });
    });
  });

  describe('handleSearchSimilarFiles', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleSearchSimilarFiles({
        search_term: 'Widget',
        working_directory: '/repo/project',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns MISSING_REQUIRED_PARAM when search_term is missing', () => {
      const result = handlers.handleSearchSimilarFiles({
        task_id: 'task-6',
        working_directory: '/repo/project',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('search_term is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns MISSING_REQUIRED_PARAM when working_directory is missing', () => {
      const result = handlers.handleSearchSimilarFiles({
        task_id: 'task-6',
        search_term: 'Widget',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('working_directory is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleSearchSimilarFiles({
        task_id: 'task-missing',
        search_term: 'Widget',
        working_directory: '/repo/project',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(mockDb.searchSimilarFiles).not.toHaveBeenCalled();
    });

    it('searches similar files using the default filename strategy', () => {
      mockDb.searchSimilarFiles.mockReturnValue({
        task_id: 'task-6',
        status: 'similar_files_exist',
        matches_found: 2,
        matches: ['src/Widget.ts', 'src/WidgetService.ts'],
        recommendation: 'Consider reusing an existing similar file.',
      });

      const payload = getJson(handlers.handleSearchSimilarFiles({
        task_id: 'task-6',
        search_term: 'Widget',
        working_directory: '/repo/project',
      }));

      expect(mockDb.searchSimilarFiles).toHaveBeenCalledWith(
        'task-6',
        'Widget',
        '/repo/project',
        'filename'
      );
      expect(payload).toEqual({
        task_id: 'task-6',
        status: 'similar_files_exist',
        matches_found: 2,
        matches: ['src/Widget.ts', 'src/WidgetService.ts'],
        recommendation: 'Consider reusing an existing similar file.',
      });
    });
  });

  describe('handleGetSimilarFileResults', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleGetSimilarFileResults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleGetSimilarFileResults({ task_id: 'task-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getSimilarFileSearchResults).not.toHaveBeenCalled();
    });

    it('returns stored similar-file search results', () => {
      getSimilarFileSearchResults.mockReturnValue([
        { search_term: 'Widget', match_files: ['src/Widget.ts'] },
        { search_term: 'Gadget', match_files: [] },
      ]);

      const payload = getJson(handlers.handleGetSimilarFileResults({ task_id: 'task-7' }));

      expect(getSimilarFileSearchResults).toHaveBeenCalledWith('task-7');
      expect(payload).toEqual({
        task_id: 'task-7',
        search_count: 2,
        results: [
          { search_term: 'Widget', match_files: ['src/Widget.ts'] },
          { search_term: 'Gadget', match_files: [] },
        ],
      });
    });
  });
});
