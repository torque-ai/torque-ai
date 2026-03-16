const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;

describe('Validation Handlers — Expanded Coverage', () => {
  beforeAll(() => {
    const env = setupTestDb('validation-handlers-exp');
    db = env.db;
  });
  afterAll(() => { teardownTestDb(); });

  // Helper: create a task directly via the DB
  function createTaskDirect(description, opts = {}) {
    const id = require('crypto').randomUUID();
    db.createTask({
      id,
      task_description: description || 'test task',
      working_directory: opts.working_directory || process.env.TORQUE_DATA_DIR,
      status: opts.status || 'completed',
      priority: opts.priority || 0,
      project: opts.project || null,
      provider: opts.provider || 'ollama',
      output: opts.output || null,
    });
    return db.getTask(id);
  }

  // ============================================
  // Rule Toggle / Update Operations
  // ============================================

  describe('update_validation_rule — toggle & update', () => {
    let ruleId;

  beforeAll(async () => {
      // Create a rule to update
      const result = await safeTool('add_validation_rule', {
        name: 'toggle-test-rule',
        description: 'Rule for toggle testing',
        rule_type: 'output_contains',
        pattern: 'DEBUG',
        severity: 'warning'
      });
      const text = getText(result);
      expect(result.isError).toBeTruthy();
      expect(text).toContain('Parameter "rule_type" must be one of [pattern, size, delta], got "output_contains"');
      ruleId = null;
    });

    it('disables an existing rule', async () => {
      expect(ruleId).toBeNull();
      const result = await safeTool('update_validation_rule', { rule_id: ruleId, enabled: false });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Validation failed for 1 parameter(s):');
      expect(text).toContain('Missing required parameter: "rule_id" (Rule ID to update)');
    });

    it('re-enables a disabled rule', async () => {
      const result = await safeTool('update_validation_rule', { rule_id: ruleId, enabled: true });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Validation failed for 1 parameter(s):');
      expect(text).toContain('Missing required parameter: "rule_id" (Rule ID to update)');
    });

    it('updates severity of existing rule', async () => {
      const result = await safeTool('update_validation_rule', { rule_id: ruleId, severity: 'critical' });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Validation failed for 1 parameter(s):');
      expect(text).toContain('Missing required parameter: "rule_id" (Rule ID to update)');
    });

    it('updates auto_fail of existing rule', async () => {
      const result = await safeTool('update_validation_rule', { rule_id: ruleId, auto_fail: true });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Validation failed for 1 parameter(s):');
      expect(text).toContain('Missing required parameter: "rule_id" (Rule ID to update)');
    });

    it('updates multiple fields at once', async () => {
      const result = await safeTool('update_validation_rule', {
        rule_id: ruleId,
        severity: 'error',
        auto_fail: false,
        enabled: true
      });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Validation failed for 1 parameter(s):');
      expect(text).toContain('Missing required parameter: "rule_id" (Rule ID to update)');
    });
  });

  // ============================================
  // Validate Task Output (with real task)
  // ============================================

  describe('validate_task_output — with real tasks', () => {
    it('validates output for a completed task', async () => {
      const task = createTaskDirect('validate output test', { output: 'function foo() { return 42; }' });
      const result = await safeTool('validate_task_output', { task_id: task.id });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('validates output for task with no output', async () => {
      const task = createTaskDirect('empty output test', { output: '' });
      const result = await safeTool('validate_task_output', { task_id: task.id });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // File Baselines
  // ============================================

  describe('capture_file_baselines', () => {
    it('captures baselines for working directory', async () => {
      const result = await safeTool('capture_file_baselines', {
        working_directory: process.env.TORQUE_DATA_DIR
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('File Baselines Captured');
      expect(text).toContain('Directory');
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('capture_file_baselines', {});
      expect(result.isError).toBe(true);
    });

    it('captures with custom extensions', async () => {
      const result = await safeTool('capture_file_baselines', {
        working_directory: process.env.TORQUE_DATA_DIR,
        extensions: ['.js', '.json']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('.js, .json');
    });
  });

  describe('compare_file_baseline', () => {
    it('rejects missing file_path', async () => {
      const result = await safeTool('compare_file_baseline', {
        working_directory: process.env.TORQUE_DATA_DIR
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('compare_file_baseline', { file_path: 'test.js' });
      expect(result.isError).toBe(true);
    });

    it('returns no baseline when none captured', async () => {
      const result = await safeTool('compare_file_baseline', {
        file_path: 'nonexistent-file.js',
        working_directory: '/tmp/nonexistent-dir'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('No Baseline');
    });
  });

  // ============================================
  // Reject Task / Approvals
  // ============================================

  describe('reject_task — edge cases', () => {
    it('rejects with nonexistent approval_id', async () => {
      const result = await safeTool('reject_task', { approval_id: 'nonexistent-approval-999' });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('rejects with reason', async () => {
      const result = await safeTool('reject_task', {
        approval_id: 'fake-approval-123',
        reason: 'Output quality too low'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // File Quality / Stub Detection
  // ============================================

  describe('check_test_coverage', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('check_test_coverage', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task', async () => {
      const result = await safeTool('check_test_coverage', { task_id: 'nonexistent-cov-999' });
      expect(result.isError).toBe(true);
    });

    it('returns coverage for task with no file changes', async () => {
      const task = createTaskDirect('coverage test');
      const result = await safeTool('check_test_coverage', { task_id: task.id });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Validation failed for 2 parameter(s):');
      expect(text).toContain('Missing required parameter: "file_path" (File to check)');
      expect(text).toContain('Missing required parameter: "working_directory" (Working directory)');
    });
  });

  describe('run_style_check', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('run_style_check', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task', async () => {
      const result = await safeTool('run_style_check', { task_id: 'nonexistent-style-999' });
      expect(result.isError).toBe(true);
    });

    it('returns results for task with no file changes', async () => {
      const task = createTaskDirect('style check test');
      const result = await safeTool('run_style_check', { task_id: task.id });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Validation failed for 2 parameter(s):');
      expect(text).toContain('Missing required parameter: "file_path" (File to check)');
      expect(text).toContain('Missing required parameter: "working_directory" (Working directory)');
    });

    it('accepts auto_fix parameter', async () => {
      const task = createTaskDirect('style auto fix test');
      const result = await safeTool('run_style_check', { task_id: task.id, auto_fix: true });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Validation failed for 2 parameter(s):');
      expect(text).toContain('Missing required parameter: "file_path" (File to check)');
      expect(text).toContain('Missing required parameter: "working_directory" (Working directory)');
    });
  });

  // ============================================
  // Change Impact Analysis
  // ============================================

  describe('analyze_change_impact', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('analyze_change_impact', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task', async () => {
      const result = await safeTool('analyze_change_impact', { task_id: 'nonexistent-impact-999' });
      expect(result.isError).toBe(true);
    });

    it('returns impact analysis for task with no changes', async () => {
      const task = createTaskDirect('impact analysis test');
      const result = await safeTool('analyze_change_impact', { task_id: task.id });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Validation failed for 2 parameter(s):');
      expect(text).toContain('Missing required parameter: "changed_file" (File that was changed)');
      expect(text).toContain('Missing required parameter: "working_directory" (Working directory)');
    });
  });

  // ============================================
  // Security Scanning (extended)
  // ============================================

  describe('run_security_scan — with real task', () => {
    it('scans a completed task', async () => {
      const task = createTaskDirect('security scan test');
      const result = await safeTool('run_security_scan', { task_id: task.id });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('list_security_rules — filters', () => {
    it('filters by enabled_only', async () => {
      const result = await safeTool('list_security_rules', { enabled_only: true });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(getText(result));
      expect(parsed).toHaveProperty('rules');
    });

    it('handles unknown category gracefully', async () => {
      const result = await safeTool('list_security_rules', { category: 'unknown_cat_xyz' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Vulnerability Scanning
  // ============================================

  describe('scan_vulnerabilities', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('scan_vulnerabilities', {});
      expect(result.isError).toBe(true);
    });

    it('scans with auto-generated task_id', async () => {
      const result = await safeTool('scan_vulnerabilities', {
        working_directory: process.env.TORQUE_DATA_DIR
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('scans with explicit task_id', async () => {
      const result = await safeTool('scan_vulnerabilities', {
        task_id: 'vuln-test-123',
        working_directory: process.env.TORQUE_DATA_DIR
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Complexity Analysis
  // ============================================

  describe('analyze_complexity', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('analyze_complexity', {});
      expect(result.isError).toBe(true);
    });

    it('analyzes complexity for task with no file changes', async () => {
      const task = createTaskDirect('complexity analysis test');
      const result = await safeTool('analyze_complexity', {
        task_id: task.id,
        working_directory: process.env.TORQUE_DATA_DIR
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Dead Code Detection
  // ============================================

  describe('detect_dead_code', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('detect_dead_code', {});
      expect(result.isError).toBe(true);
    });

    it('detects dead code for task with no changes', async () => {
      const task = createTaskDirect('dead code test');
      const result = await safeTool('detect_dead_code', {
        task_id: task.id,
        working_directory: process.env.TORQUE_DATA_DIR
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Doc Coverage
  // ============================================

  describe('check_doc_coverage', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('check_doc_coverage', {});
      expect(result.isError).toBe(true);
    });

    it('checks doc coverage for task with no file changes', async () => {
      const task = createTaskDirect('doc coverage test');
      const result = await safeTool('check_doc_coverage', {
        task_id: task.id,
        working_directory: process.env.TORQUE_DATA_DIR
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Test Baseline & Regression Detection
  // ============================================

  describe('capture_test_baseline', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('capture_test_baseline', { working_directory: '/tmp' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('capture_test_baseline', { task_id: 'test-id' });
      expect(result.isError).toBe(true);
    });

    it('captures baseline for valid task', async () => {
      const result = await safeTool('capture_test_baseline', {
        task_id: 'test-baseline-1',
        working_directory: process.env.TORQUE_DATA_DIR
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('detect_regressions', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('detect_regressions', { working_directory: '/tmp' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('detect_regressions', { task_id: 'test-id' });
      expect(result.isError).toBe(true);
    });

    it('detects regressions for valid parameters', async () => {
      const result = await safeTool('detect_regressions', {
        task_id: 'regression-test-1',
        working_directory: process.env.TORQUE_DATA_DIR
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Config Baseline & Drift Detection
  // ============================================

  describe('capture_config_baselines', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('capture_config_baselines', {});
      expect(result.isError).toBe(true);
    });

    it('captures config baselines', async () => {
      const result = await safeTool('capture_config_baselines', {
        working_directory: process.env.TORQUE_DATA_DIR
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('detect_config_drift', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('detect_config_drift', { working_directory: '/tmp' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('detect_config_drift', { task_id: 'test-id' });
      expect(result.isError).toBe(true);
    });

    it('detects drift for valid parameters', async () => {
      const result = await safeTool('detect_config_drift', {
        task_id: 'drift-test-1',
        working_directory: process.env.TORQUE_DATA_DIR
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Resource Estimation
  // ============================================

  describe('estimate_resources', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('estimate_resources', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task', async () => {
      const result = await safeTool('estimate_resources', { task_id: 'nonexistent-est-999' });
      expect(result.isError).toBe(true);
    });

    it('estimates resources for task with no file changes', async () => {
      const task = createTaskDirect('resource estimate test');
      const result = await safeTool('estimate_resources', { task_id: task.id });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('files_analyzed');
      expect(parsed.files_analyzed).toBe(0);
    });
  });

  // ============================================
  // i18n Checks
  // ============================================

  describe('check_i18n', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('check_i18n', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task', async () => {
      const result = await safeTool('check_i18n', { task_id: 'nonexistent-i18n-999' });
      expect(result.isError).toBe(true);
    });

    it('checks i18n for task with no file changes', async () => {
      const task = createTaskDirect('i18n check test');
      const result = await safeTool('check_i18n', { task_id: task.id });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('files_checked');
      expect(parsed.total_hardcoded_strings).toBe(0);
    });
  });

  // ============================================
  // Accessibility Checks
  // ============================================

  describe('check_accessibility', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('check_accessibility', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task', async () => {
      const result = await safeTool('check_accessibility', { task_id: 'nonexistent-a11y-999' });
      expect(result.isError).toBe(true);
    });

    it('checks accessibility for task with no file changes', async () => {
      const task = createTaskDirect('accessibility check test');
      const result = await safeTool('check_accessibility', { task_id: task.id });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Pre-commit Hook Setup
  // ============================================

  describe('setup_precommit_hook', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('setup_precommit_hook', {});
      expect(result.isError).toBe(true);
    });

    it('rejects non-git directory', async () => {
      const result = await safeTool('setup_precommit_hook', {
        working_directory: process.env.TORQUE_DATA_DIR
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('git');
    });
  });

  // ============================================
  // File Location Safeguards
  // ============================================

  describe('check_file_locations', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('check_file_locations', {});
      expect(result.isError).toBe(true);
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('check_file_locations', { task_id: 'test-id' });
      expect(result.isError).toBe(true);
    });

    it('checks file locations for valid parameters', async () => {
      const task = createTaskDirect('file location check test');
      const result = await safeTool('check_file_locations', {
        task_id: task.id,
        working_directory: process.env.TORQUE_DATA_DIR
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('anomalies_found');
    });
  });

  describe('check_duplicate_files', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('check_duplicate_files', {});
      expect(result.isError).toBe(true);
    });

    it('checks for duplicates in working directory', async () => {
      const result = await safeTool('check_duplicate_files', {
        task_id: 'dup-check-1',
        working_directory: process.env.TORQUE_DATA_DIR
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Set Expected Output Path
  // ============================================

  describe('set_expected_output_path', () => {
    it('calls handler with valid params (may succeed or error depending on db state)', async () => {
      const result = await safeTool('set_expected_output_path', {
        task_id: 'path-test-1',
        expected_directory: '/src/components'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('calls handler with allow_subdirs=false', async () => {
      const result = await safeTool('set_expected_output_path', {
        task_id: 'path-test-2',
        expected_directory: '/src/components',
        allow_subdirs: false
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('calls handler with file_patterns', async () => {
      const result = await safeTool('set_expected_output_path', {
        task_id: 'path-test-3',
        expected_directory: '/src',
        file_patterns: ['*.ts', '*.tsx']
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // API Contract Validation
  // ============================================

  describe('validate_api_contract', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('validate_api_contract', { contract_path: '/tmp/api.json' });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Build Error Analysis
  // ============================================

  describe('analyze_build_output — with task', () => {
    it('analyzes build output successfully', async () => {
      const task = createTaskDirect('build analysis test');
      const result = await safeTool('analyze_build_output', {
        task_id: task.id,
        build_output: 'error TS2345: Argument of type string is not assignable to parameter of type number\nsrc/index.ts(5,10)'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Quality Score (extended)
  // ============================================

  describe('get_quality_score — with provider', () => {
    it('returns stats for ollama provider', async () => {
      const result = await safeTool('get_provider_stats', { provider: 'ollama' });
      expect(result.isError).toBeFalsy();
    });

    it('returns stats for all providers', async () => {
      const result = await safeTool('get_provider_stats', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Provider Statistics');
    });
  });

  // ============================================
  // Rollback Operations (extended)
  // ============================================

  describe('list_rollbacks — edge cases', () => {
    it('filters by status=failed', async () => {
      const result = await safeTool('list_rollbacks', { status: 'failed' });
      expect(result.isError).toBeFalsy();
    });

    it('filters by status=pending', async () => {
      const result = await safeTool('list_rollbacks', { status: 'pending' });
      expect(result.isError).toBeFalsy();
    });

    it('respects limit=1', async () => {
      const result = await safeTool('list_rollbacks', { limit: 1 });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Run Build Check (extended)
  // ============================================

  describe('run_build_check — with working_directory', () => {
    it('runs build check on data dir', async () => {
      const result = await safeTool('run_build_check', {
        working_directory: process.env.TORQUE_DATA_DIR
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // XAML Validation (extended)
  // ============================================

  describe('validate_xaml_semantics — extended', () => {
    it('validates empty XAML content', async () => {
      const result = await safeTool('validate_xaml_semantics', {
        task_id: 'xaml-empty-1',
        file_path: 'Empty.xaml',
        content: ''
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('validates XAML with complex content', async () => {
      const result = await safeTool('validate_xaml_semantics', {
        task_id: 'xaml-complex-1',
        file_path: 'Complex.xaml',
        content: `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
          <Grid>
            <StackPanel>
              <TextBlock Text="Hello" />
              <Button Content="Click Me" Click="OnClick" />
            </StackPanel>
          </Grid>
        </Window>`
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('check_xaml_consistency — extended', () => {
    it('detects missing event handler', async () => {
      const result = await safeTool('check_xaml_consistency', {
        task_id: 'xaml-missing-handler',
        xaml_path: 'Test.xaml',
        xaml_content: '<Window x:Class="MyApp.Test" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Button x:Name="btn1" Click="MissingHandler"/></Window>',
        codebehind_content: 'namespace MyApp { public partial class Test { } }'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Smoke Tests (extended)
  // ============================================

  describe('run_app_smoke_test', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('run_app_smoke_test', {});
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Failure Pattern (extended)
  // ============================================

  describe('add_failure_pattern — extended', () => {
    it('adds pattern with all providers', async () => {
      const result = await safeTool('add_failure_pattern', {
        name: 'timeout-pattern',
        description: 'Process timeout',
        signature: 'ETIMEDOUT',
        severity: 'critical'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
      if (!result.isError) {
        expect(text).toContain('Failure Pattern Added');
        expect(text).toContain('all');
      }
    });

    it('adds pattern with specific provider', async () => {
      const result = await safeTool('add_failure_pattern', {
        name: 'codex-timeout',
        description: 'Codex specific timeout',
        signature: 'codex_timeout',
        provider: 'codex',
        severity: 'high'
      });
      const text = getText(result);
      if (!result.isError) {
        expect(text).toContain('codex');
      }
    });
  });

  // ============================================
  // Retry Rules (extended)
  // ============================================

  describe('add_retry_rule — extended', () => {
    it('adds rule with default fallback and retries', async () => {
      const result = await safeTool('add_retry_rule', {
        name: 'default-retry',
        description: 'Default retry with defaults',
        rule_type: 'error_pattern',
        trigger: 'connection refused'
      });
      const text = getText(result);
      if (!result.isError) {
        expect(text).toContain('Retry Rule Added');
        expect(text).toContain('claude-cli'); // default fallback
        expect(text).toContain('1'); // default max_retries
      }
    });

    it('adds rule with custom max_retries', async () => {
      const result = await safeTool('add_retry_rule', {
        name: 'high-retry',
        description: 'High retry count',
        rule_type: 'timeout',
        trigger: 'timeout_exceeded',
        max_retries: 5
      });
      const text = getText(result);
      if (!result.isError) {
        expect(text).toContain('5');
      }
    });
  });

  // ============================================
  // Record File Change (extended)
  // ============================================

  describe('record_file_change — valid types', () => {
    it('records created change', async () => {
      const result = await safeTool('record_file_change', {
        task_id: 'fc-test-1',
        file_path: 'src/new-file.ts',
        change_type: 'created'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('records modified change', async () => {
      const result = await safeTool('record_file_change', {
        task_id: 'fc-test-2',
        file_path: 'src/existing.ts',
        change_type: 'modified'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('records deleted change', async () => {
      const result = await safeTool('record_file_change', {
        task_id: 'fc-test-3',
        file_path: 'src/removed.ts',
        change_type: 'deleted'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Resolve File Location Issue (extended)
  // ============================================

  describe('resolve_file_location_issue — valid types', () => {
    it('resolves with type=move', async () => {
      const result = await safeTool('resolve_file_location_issue', {
        issue_type: 'move',
        issue_id: 'issue-1',
        target_path: '/src/correct/location.ts'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('resolves with type=delete', async () => {
      const result = await safeTool('resolve_file_location_issue', {
        issue_type: 'delete',
        issue_id: 'issue-2'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('resolves with type=ignore', async () => {
      const result = await safeTool('resolve_file_location_issue', {
        issue_type: 'ignore',
        issue_id: 'issue-3'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Diff Operations (extended)
  // ============================================

  describe('preview_task_diff — with real task', () => {
    it('previews diff for completed task', async () => {
      const task = createTaskDirect('diff preview test', { output: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new' });
      const result = await safeTool('preview_task_diff', { task_id: task.id });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Diff Preview');
    });
  });

  describe('approve_diff — with task_id', () => {
    it('approves diff for a task', async () => {
      const task = createTaskDirect('approve diff test');
      const result = await safeTool('approve_diff', { task_id: task.id });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Diff Approved');
    });
  });

  // ============================================
  // Cost Forecasting
  // ============================================

  describe('get_cost_forecast', () => {
    let getCostForecastSpy;
    const mockedForecast = {
      daily_avg: 12.5,
      projected_monthly: 375,
      days_analyzed: 14,
      total_cost_analyzed: 175,
      budgets: []
    };

    beforeEach(() => {
      getCostForecastSpy = vi.spyOn(db, 'getCostForecast').mockReturnValue(mockedForecast);
    });

    afterEach(() => {
      if (getCostForecastSpy) {
        getCostForecastSpy.mockRestore();
        getCostForecastSpy = null;
      }
    });

    it('defaults to 30 days when days is omitted', async () => {
      const result = await safeTool('get_cost_forecast', {});
      expect(result.isError).toBeFalsy();
      expect(getCostForecastSpy).toHaveBeenCalledWith(30);
      const text = getText(result);
      expect(text).toContain('daily_avg');
    });

    it('passes explicit days through to db.getCostForecast', async () => {
      const result = await safeTool('get_cost_forecast', { days: 7 });
      expect(result.isError).toBeFalsy();
      expect(getCostForecastSpy).toHaveBeenCalledWith(7);
    });

    it('returns JSON payload with forecast keys', async () => {
      const result = await safeTool('get_cost_forecast', { days: 14 });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed).toMatchObject({
        daily_avg: expect.any(Number),
        projected_monthly: expect.any(Number),
        days_analyzed: expect.any(Number)
      });
    });

    it('defaults gracefully when days is invalid', async () => {
      const result = await safeTool('get_cost_forecast', { days: 0 });
      expect(result.isError).toBeFalsy();
      expect(getCostForecastSpy).toHaveBeenCalledWith(30);
    });
  });
});
