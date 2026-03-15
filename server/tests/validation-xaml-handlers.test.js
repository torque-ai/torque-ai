const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const validationXamlHandlers = require('../handlers/validation/xaml');

let db, handleToolCall;

beforeAll(() => { ({ db, handleToolCall } = setupTestDb('val-xaml')); });
afterAll(() => { teardownTestDb(); });

describe('validation-xaml handlers', () => {
  function parseJson(result) {
    const text = getText(result);
    expect(typeof text).toBe('string');
    return JSON.parse(text);
  }

  function ensureTask(taskId) {
    try {
      db.createTask({
        id: taskId,
        task_description: `Test task for ${taskId}`,
        working_directory: process.env.TORQUE_DATA_DIR
      });
    } catch {
      // Task may already exist in long-running suites; ignore duplicate inserts.
    }
  }

  it('exports all XAML handler functions', () => {
    expect(typeof validationXamlHandlers.handleValidateXamlSemantics).toBe('function');
    expect(typeof validationXamlHandlers.handleGetXamlValidationResults).toBe('function');
    expect(typeof validationXamlHandlers.handleCheckXamlConsistency).toBe('function');
    expect(typeof validationXamlHandlers.handleGetXamlConsistencyResults).toBe('function');
    expect(typeof validationXamlHandlers.handleRunAppSmokeTest).toBe('function');
    expect(typeof validationXamlHandlers.handleGetSmokeTestResults).toBe('function');
    expect(typeof handleToolCall).toBe('function');
    expect(db).toBeDefined();
  });

  describe('validate_xaml_semantics', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('validate_xaml_semantics', {
        file_path: 'MainWindow.xaml',
        content: '<Window/>'
      });
      expect(result.isError).toBe(true);
    });

    it('accepts valid XAML and reports no issues', async () => {
      const result = await safeTool('validate_xaml_semantics', {
        task_id: 'xaml-valid-1',
        file_path: 'MainWindow.xaml',
        content: '<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Grid><TextBlock Text="Hello" /></Grid></Window>'
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseJson(result);
      expect(parsed.task_id).toBe('xaml-valid-1');
      expect(parsed.issue_count).toBe(0);
      expect(parsed.issues).toHaveLength(0);
    });

    it('flags broken binding expressions outside ControlTemplate', async () => {
      ensureTask('xaml-invalid-binding-1');

      const result = await safeTool('validate_xaml_semantics', {
        task_id: 'xaml-invalid-binding-1',
        file_path: 'BrokenBinding.xaml',
        content: '<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><Grid><TextBlock Text="{TemplateBinding Foreground}" /></Grid></Window>'
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseJson(result);
      expect(parsed.issue_count).toBeGreaterThan(0);
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'invalid_templatebinding', severity: 'error' }),
        ])
      );
    });

    it('flags potentially missing resource dictionary keys', async () => {
      ensureTask('xaml-missing-resource-1');

      const result = await safeTool('validate_xaml_semantics', {
        task_id: 'xaml-missing-resource-1',
        file_path: 'Resources.xaml',
        content: `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
                    <Grid>
                      <Grid.Resources>
                        <SolidColorBrush x:Key="PrimaryBrush">#FF00AA00</SolidColorBrush>
                      </Grid.Resources>
                      <Border Background="{StaticResource MissingBrush}"/>
                    </Grid>
                  </Window>`
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseJson(result);
      expect(parsed.issue_count).toBeGreaterThan(0);
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'potentially_missing_resource', severity: 'warning' }),
        ])
      );
    });

    it('handles missing namespace declarations as an edge case without crashing', async () => {
      const result = await safeTool('validate_xaml_semantics', {
        task_id: 'xaml-missing-namespace-1',
        file_path: 'MissingNamespace.xaml',
        content: '<Window x:Class="MyApp.MissingNs"><TextBlock x:Name="titleText" Text="Hello" /></Window>'
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseJson(result);
      expect(parsed.task_id).toBe('xaml-missing-namespace-1');
      expect(Array.isArray(parsed.issues)).toBe(true);
    });

    it('persists and returns validation results for a task', async () => {
      const taskId = 'xaml-results-lookup-1';
      ensureTask(taskId);

      const validation = await safeTool('validate_xaml_semantics', {
        task_id: taskId,
        file_path: 'Lookup.xaml',
        content: '<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><TextBlock Text="{TemplateBinding ShouldNotBeHere}" /></Window>'
      });
      expect(validation.isError).toBeFalsy();

      const results = await safeTool('get_xaml_validation_results', { task_id: taskId });
      expect(results.isError).toBeFalsy();

      const parsedResults = parseJson(results);
      expect(parsedResults.task_id).toBe(taskId);
      expect(parsedResults.result_count).toBeGreaterThanOrEqual(1);
      expect(parsedResults.results.some(r => r.task_id === taskId)).toBe(true);
      expect(db.getXamlValidationResults(taskId).length).toBe(parsedResults.result_count);
    });
  });

  describe('check_xaml_consistency', () => {
    it('rejects missing xaml_path', async () => {
      const result = await safeTool('check_xaml_consistency', {
        task_id: 'xaml-consistency-missing',
        xaml_content: '<Window><Button x:Name="save"/></Window>',
        codebehind_content: 'namespace App { public partial class Window {} }'
      });
      expect(result.isError).toBe(true);
    });

    it('returns clean consistency for matching named elements', async () => {
      ensureTask('xaml-consistency-match-1');

      const result = await safeTool('check_xaml_consistency', {
        task_id: 'xaml-consistency-match-1',
        xaml_path: 'MainWindow.xaml',
        xaml_content: '<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><TextBox x:Name="emailBox" /><Button x:Name="submitBtn" /></Window>',
        codebehind_content: 'namespace MyApp { public partial class MainWindow { void Update() { this.emailBox.Content = null; this.submitBtn.Visibility = 1; } } }'
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseJson(result);
      expect(parsed.consistency_passed).toBeUndefined();
      expect(parsed.issue_count).toBe(0);
      expect(parsed.issues).toHaveLength(0);
    });

    it('reports missing XAML element for code-behind references', async () => {
      ensureTask('xaml-consistency-mismatch-1');

      const result = await safeTool('check_xaml_consistency', {
        task_id: 'xaml-consistency-mismatch-1',
        xaml_path: 'Mismatch.xaml',
        xaml_content: '<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><TextBox x:Name="existingField" /></Window>',
        codebehind_content: 'namespace MyApp { public partial class Mismatch { void Update() { this.missingField.Content = "x"; } } }'
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseJson(result);
      expect(parsed.issue_count).toBeGreaterThan(0);
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'missing_xaml_element', severity: 'error' })
        ])
      );
    });

    it('returns stored consistency results by task', async () => {
      const taskId = 'xaml-consistency-results-1';
      ensureTask(taskId);

      const check = await safeTool('check_xaml_consistency', {
        task_id: taskId,
        xaml_path: 'CheckResults.xaml',
        xaml_content: '<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><TextBox x:Name="statusField" /></Window>',
        codebehind_content: 'namespace MyApp { public partial class CheckResults { } }'
      });
      expect(check.isError).toBeFalsy();

      const results = await safeTool('get_xaml_consistency_results', { task_id: taskId });
      expect(results.isError).toBeFalsy();

      const parsedResults = parseJson(results);
      expect(parsedResults.task_id).toBe(taskId);
      expect(parsedResults.result_count).toBeGreaterThanOrEqual(1);
      expect(parsedResults.results[0].task_id).toBe(taskId);
      expect(db.getXamlConsistencyResults(taskId).length).toBe(parsedResults.result_count);
    });
  });

  describe('run_app_smoke_test', () => {
    it('requires task_id', async () => {
      const result = await safeTool('run_app_smoke_test', {
        working_directory: process.env.TORQUE_DATA_DIR
      });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid project file extension without spawning dotnet', async () => {
      const result = await safeTool('run_app_smoke_test', {
        task_id: 'xaml-smoke-invalid-ext-1',
        working_directory: process.env.TORQUE_DATA_DIR,
        project_file: 'not-a-project.txt'
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseJson(result);
      expect(parsed.task_id).toBe('xaml-smoke-invalid-ext-1');
      expect(parsed.smoke_test_passed).toBe(false);
      expect(parsed.exit_code).toBe(-1);
      expect(parsed.error_output).toBe('Invalid project file extension');
    });

    it('rejects path traversal project file input', async () => {
      const result = await safeTool('run_app_smoke_test', {
        task_id: 'xaml-smoke-invalid-path-1',
        working_directory: process.env.TORQUE_DATA_DIR,
        project_file: '..\\projects\\bad.csproj'
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseJson(result);
      expect(parsed.error_output).toBe('Invalid project file path');
      expect(parsed.smoke_test_passed).toBe(false);
    });

    it('records smoke test results and returns them by task', async () => {
      const taskId = 'xaml-smoke-results-1';
      ensureTask(taskId);

      const runResult = await safeTool('run_app_smoke_test', {
        task_id: taskId,
        working_directory: process.env.TORQUE_DATA_DIR,
        project_file: 'bad.csproj'
      });
      expect(runResult.isError).toBeFalsy();

      const lookup = await safeTool('get_smoke_test_results', { task_id: taskId });
      expect(lookup.isError).toBeFalsy();

      const parsed = parseJson(lookup);
      expect(parsed.task_id).toBe(taskId);
      expect(parsed.result_count).toBeGreaterThanOrEqual(1);
      expect(parsed.results[0].task_id).toBe(taskId);
      expect(db.getSmokeTestResults(taskId).length).toBe(parsed.result_count);
    });
  });

  describe('get_smoke_test_results', () => {
    it('requires task_id', async () => {
      const result = await safeTool('get_smoke_test_results', {});
      expect(result.isError).toBe(true);
    });
  });
});
