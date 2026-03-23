'use strict';

const realShared = require('../handlers/shared');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const mockDb = {
  validateXamlSemantics: vi.fn(),
  getXamlValidationResults: vi.fn(),
  checkXamlCodeBehindConsistency: vi.fn(),
  getXamlConsistencyResults: vi.fn(),
  runAppSmokeTestSync: vi.fn(),
  getSmokeTestResults: vi.fn(),
};

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/validation/xaml')];
  installMock('../database', mockDb);
  installMock('../db/file-tracking', mockDb);
  installMock('../handlers/shared', realShared);
  return require('../handlers/validation/xaml');
}

function resetMockDefaults() {
  for (const fn of Object.values(mockDb)) {
    fn.mockReset();
  }

  mockDb.validateXamlSemantics.mockReturnValue({ passed: true, issues: [] });
  mockDb.getXamlValidationResults.mockReturnValue([]);
  mockDb.checkXamlCodeBehindConsistency.mockReturnValue({ passed: true, issues: [] });
  mockDb.getXamlConsistencyResults.mockReturnValue([]);
  mockDb.runAppSmokeTestSync.mockReturnValue({
    passed: true,
    exit_code: 0,
    startup_time_ms: 250,
  });
  mockDb.getSmokeTestResults.mockReturnValue([]);
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function getJson(result) {
  return JSON.parse(getText(result));
}

describe('validation/xaml handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleValidateXamlSemantics', () => {
    it('returns MISSING_REQUIRED_PARAM for each required argument', () => {
      const missingTaskId = handlers.handleValidateXamlSemantics({
        file_path: 'Views/MainWindow.xaml',
        content: '<Window />',
      });
      const missingFilePath = handlers.handleValidateXamlSemantics({
        task_id: 'task-1',
        content: '<Window />',
      });
      const missingContent = handlers.handleValidateXamlSemantics({
        task_id: 'task-1',
        file_path: 'Views/MainWindow.xaml',
      });

      expect(missingTaskId.isError).toBe(true);
      expect(missingTaskId.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingTaskId)).toContain('task_id is required');
      expect(missingFilePath.isError).toBe(true);
      expect(missingFilePath.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingFilePath)).toContain('file_path is required');
      expect(missingContent.isError).toBe(true);
      expect(missingContent.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingContent)).toContain('content is required');
      expect(mockDb.validateXamlSemantics).not.toHaveBeenCalled();
    });

    it('returns serialized validation results', () => {
      mockDb.validateXamlSemantics.mockReturnValue({
        passed: false,
        issues: [
          { type: 'invalid_binding', severity: 'error', line: 8 },
          { type: 'missing_resource', severity: 'warning', line: 11 },
        ],
      });

      const payload = getJson(handlers.handleValidateXamlSemantics({
        task_id: 'task-1',
        file_path: 'Views/MainWindow.xaml',
        content: '<Window><Grid /></Window>',
      }));

      expect(mockDb.validateXamlSemantics).toHaveBeenCalledWith(
        'task-1',
        'Views/MainWindow.xaml',
        '<Window><Grid /></Window>'
      );
      expect(payload).toEqual({
        task_id: 'task-1',
        file_path: 'Views/MainWindow.xaml',
        validation_passed: false,
        issue_count: 2,
        issues: [
          { type: 'invalid_binding', severity: 'error', line: 8 },
          { type: 'missing_resource', severity: 'warning', line: 11 },
        ],
      });
    });
  });

  describe('handleGetXamlValidationResults', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleGetXamlValidationResults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getXamlValidationResults).not.toHaveBeenCalled();
    });

    it('returns stored validation results', () => {
      mockDb.getXamlValidationResults.mockReturnValue([
        { file_path: 'Views/MainWindow.xaml', passed: true, issues: [] },
        { file_path: 'Views/Dialog.xaml', passed: false, issues: [{ type: 'warning' }] },
      ]);

      const payload = getJson(handlers.handleGetXamlValidationResults({ task_id: 'task-2' }));

      expect(mockDb.getXamlValidationResults).toHaveBeenCalledWith('task-2');
      expect(payload).toEqual({
        task_id: 'task-2',
        result_count: 2,
        results: [
          { file_path: 'Views/MainWindow.xaml', passed: true, issues: [] },
          { file_path: 'Views/Dialog.xaml', passed: false, issues: [{ type: 'warning' }] },
        ],
      });
    });
  });

  describe('handleCheckXamlConsistency', () => {
    it('returns MISSING_REQUIRED_PARAM for each required argument', () => {
      const missingTaskId = handlers.handleCheckXamlConsistency({
        xaml_path: 'Views/MainWindow.xaml',
        xaml_content: '<Window />',
        codebehind_content: 'partial class MainWindow {}',
      });
      const missingXamlPath = handlers.handleCheckXamlConsistency({
        task_id: 'task-3',
        xaml_content: '<Window />',
        codebehind_content: 'partial class MainWindow {}',
      });
      const missingXamlContent = handlers.handleCheckXamlConsistency({
        task_id: 'task-3',
        xaml_path: 'Views/MainWindow.xaml',
        codebehind_content: 'partial class MainWindow {}',
      });
      const missingCodeBehind = handlers.handleCheckXamlConsistency({
        task_id: 'task-3',
        xaml_path: 'Views/MainWindow.xaml',
        xaml_content: '<Window />',
      });

      expect(missingTaskId.isError).toBe(true);
      expect(missingTaskId.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingTaskId)).toContain('task_id is required');
      expect(missingXamlPath.isError).toBe(true);
      expect(missingXamlPath.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingXamlPath)).toContain('xaml_path is required');
      expect(missingXamlContent.isError).toBe(true);
      expect(missingXamlContent.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingXamlContent)).toContain('xaml_content is required');
      expect(missingCodeBehind.isError).toBe(true);
      expect(missingCodeBehind.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingCodeBehind)).toContain('codebehind_content is required');
      expect(mockDb.checkXamlCodeBehindConsistency).not.toHaveBeenCalled();
    });

    it('returns serialized consistency results', () => {
      mockDb.checkXamlCodeBehindConsistency.mockReturnValue({
        passed: false,
        issues: [
          { type: 'missing_xaml_element', severity: 'error', member: 'saveButton' },
        ],
      });

      const payload = getJson(handlers.handleCheckXamlConsistency({
        task_id: 'task-3',
        xaml_path: 'Views/MainWindow.xaml',
        xaml_content: '<Button x:Name="openButton" />',
        codebehind_content: 'partial class MainWindow { void Save() { saveButton.Content = "ok"; } }',
      }));

      expect(mockDb.checkXamlCodeBehindConsistency).toHaveBeenCalledWith(
        'task-3',
        'Views/MainWindow.xaml',
        '<Button x:Name="openButton" />',
        'partial class MainWindow { void Save() { saveButton.Content = "ok"; } }'
      );
      expect(payload).toEqual({
        task_id: 'task-3',
        xaml_path: 'Views/MainWindow.xaml',
        consistency_passed: false,
        issue_count: 1,
        issues: [
          { type: 'missing_xaml_element', severity: 'error', member: 'saveButton' },
        ],
      });
    });
  });

  describe('handleGetXamlConsistencyResults', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleGetXamlConsistencyResults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getXamlConsistencyResults).not.toHaveBeenCalled();
    });

    it('returns stored consistency results', () => {
      mockDb.getXamlConsistencyResults.mockReturnValue([
        { xaml_path: 'Views/MainWindow.xaml', passed: true, issues: [] },
      ]);

      const payload = getJson(handlers.handleGetXamlConsistencyResults({ task_id: 'task-4' }));

      expect(mockDb.getXamlConsistencyResults).toHaveBeenCalledWith('task-4');
      expect(payload).toEqual({
        task_id: 'task-4',
        result_count: 1,
        results: [
          { xaml_path: 'Views/MainWindow.xaml', passed: true, issues: [] },
        ],
      });
    });
  });

  describe('handleRunAppSmokeTest', () => {
    it('returns MISSING_REQUIRED_PARAM for each required argument', () => {
      const missingTaskId = handlers.handleRunAppSmokeTest({
        working_directory: 'C:/repo/app',
      });
      const missingWorkingDirectory = handlers.handleRunAppSmokeTest({
        task_id: 'task-5',
      });

      expect(missingTaskId.isError).toBe(true);
      expect(missingTaskId.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingTaskId)).toContain('task_id is required');
      expect(missingWorkingDirectory.isError).toBe(true);
      expect(missingWorkingDirectory.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(missingWorkingDirectory)).toContain('working_directory is required');
      expect(mockDb.runAppSmokeTestSync).not.toHaveBeenCalled();
    });

    it('runs the smoke test with default options and returns the summary', () => {
      mockDb.runAppSmokeTestSync.mockReturnValue({
        passed: true,
        exit_code: 0,
        startup_time_ms: 912,
      });

      const payload = getJson(handlers.handleRunAppSmokeTest({
        task_id: 'task-5',
        working_directory: 'C:/repo/app',
      }));

      expect(mockDb.runAppSmokeTestSync).toHaveBeenCalledWith(
        'task-5',
        'C:/repo/app',
        {
          timeoutSeconds: 10,
          projectFile: null,
        }
      );
      expect(payload).toEqual({
        task_id: 'task-5',
        smoke_test_passed: true,
        exit_code: 0,
        startup_time_ms: 912,
        error_output: null,
      });
    });
  });

  describe('handleGetSmokeTestResults', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleGetSmokeTestResults({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getSmokeTestResults).not.toHaveBeenCalled();
    });

    it('returns stored smoke test results', () => {
      mockDb.getSmokeTestResults.mockReturnValue([
        { exit_code: 0, passed: true, startup_time_ms: 450 },
        { exit_code: -1, passed: false, startup_time_ms: 10 },
      ]);

      const payload = getJson(handlers.handleGetSmokeTestResults({ task_id: 'task-6' }));

      expect(mockDb.getSmokeTestResults).toHaveBeenCalledWith('task-6');
      expect(payload).toEqual({
        task_id: 'task-6',
        result_count: 2,
        results: [
          { exit_code: 0, passed: true, startup_time_ms: 450 },
          { exit_code: -1, passed: false, startup_time_ms: 10 },
        ],
      });
    });
  });
});
