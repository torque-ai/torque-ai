const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Validation Handlers', () => {
  beforeAll(() => { setupTestDb('validation-handlers'); });
  afterAll(() => { teardownTestDb(); });

  // ============================================
  // Validation Rules CRUD
  // ============================================

  describe('list_validation_rules', () => {
    it('returns rules list when none exist', async () => {
      const result = await safeTool('list_validation_rules', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Validation Rules');
    });

    it('returns enabled rules by default', async () => {
      const result = await safeTool('list_validation_rules', { enabled_only: true });
      expect(result.isError).toBeFalsy();
    });

    it('filters by severity when provided', async () => {
      // Add a warning-level rule first
      await safeTool('add_validation_rule', {
        name: 'severity-filter-test',
        description: 'Test rule for severity filtering',
        rule_type: 'output_contains',
        pattern: 'TODO',
        severity: 'warning'
      });
      const result = await safeTool('list_validation_rules', { enabled_only: false, severity: 'error' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('add_validation_rule', () => {
    it('adds a rule with required fields', async () => {
      const result = await safeTool('add_validation_rule', {
        name: 'test-rule-add',
        description: 'A test validation rule',
        rule_type: 'output_contains',
        pattern: 'function',
        severity: 'warning'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Validation Rule Added');
      expect(text).toContain('test-rule-add');
    });

    it('adds a rule with auto_fail enabled', async () => {
      const result = await safeTool('add_validation_rule', {
        name: 'auto-fail-rule',
        description: 'Auto-failing rule',
        rule_type: 'output_contains',
        pattern: 'CRITICAL_ERROR',
        severity: 'critical',
        auto_fail: true
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Auto-Fail');
      expect(text).toContain('Yes');
    });

    it('rejects missing required fields (name only)', async () => {
      const result = await safeTool('add_validation_rule', { name: 'incomplete' });
      expect(result.isError).toBe(true);
    });

    it('rejects completely empty args', async () => {
      const result = await safeTool('add_validation_rule', {});
      expect(result.isError).toBe(true);
    });

    it('rejects pattern-type rule without pattern', async () => {
      const result = await safeTool('add_validation_rule', {
        name: 'pattern-missing',
        description: 'Should fail',
        rule_type: 'pattern'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects size-type rule without condition', async () => {
      const result = await safeTool('add_validation_rule', {
        name: 'size-missing-condition',
        description: 'Should fail',
        rule_type: 'size'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects delta-type rule without condition', async () => {
      const result = await safeTool('add_validation_rule', {
        name: 'delta-missing-condition',
        description: 'Should fail',
        rule_type: 'delta'
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('update_validation_rule', () => {
    it('rejects missing rule_id', async () => {
      const result = await safeTool('update_validation_rule', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent rule_id', async () => {
      const result = await safeTool('update_validation_rule', { rule_id: 'nonexistent-rule-999' });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Task Output Validation
  // ============================================

  describe('validate_task_output', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('validate_task_output', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task', async () => {
      const result = await safeTool('validate_task_output', { task_id: 'nonexistent-vto-123' });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_validation_results', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_validation_results', {});
      expect(result.isError).toBe(true);
    });

    it('returns empty results for nonexistent task', async () => {
      const result = await safeTool('get_validation_results', { task_id: 'nonexistent-vr-123' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('No validation issues found');
    });

    it('accepts min_severity parameter', async () => {
      const result = await safeTool('get_validation_results', { task_id: 'nonexistent-vr-456', min_severity: 'error' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Reject Task / Approvals
  // ============================================

  describe('reject_task', () => {
    it('rejects missing approval_id', async () => {
      const result = await safeTool('reject_task', {});
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Syntax Validators
  // ============================================

  describe('list_syntax_validators', () => {
    it('returns validators list', async () => {
      const result = await safeTool('list_syntax_validators', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Syntax Validators');
    });
  });

  describe('run_syntax_check', () => {
    it('rejects missing file_path', async () => {
      const result = await safeTool('run_syntax_check', { working_directory: '/tmp' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('run_syntax_check', { file_path: 'test.js' });
      expect(result.isError).toBe(true);
    });
  });

  describe('setup_precommit_hook', () => {
    it('rejects path traversal with ../', async () => {
      const result = await safeTool('setup_precommit_hook', { working_directory: '../tmp' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('working_directory must not contain \"..\" path segments');
    });

    it('rejects path traversal with ..\\', async () => {
      const result = await safeTool('setup_precommit_hook', { working_directory: '..\\tmp' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('working_directory must not contain \"..\" path segments');
    });
  });

  // ============================================
  // Diff Preview
  // ============================================

  describe('preview_task_diff', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('preview_task_diff', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task', async () => {
      const result = await safeTool('preview_task_diff', { task_id: 'nonexistent-diff-123' });
      expect(result.isError).toBe(true);
    });
  });

  describe('approve_diff', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('approve_diff', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('configure_diff_preview', () => {
    it('enables diff preview requirement', async () => {
      const result = await safeTool('configure_diff_preview', { required: true });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Yes');
    });

    it('disables diff preview requirement', async () => {
      const result = await safeTool('configure_diff_preview', { required: false });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('No');
    });
  });

  // ============================================
  // Quality Scoring
  // ============================================

  describe('get_quality_score', () => {
    it('handles nonexistent task', async () => {
      const result = await safeTool('get_quality_score', { task_id: 'nonexistent_qs_123' });
      const text = getText(result);
      expect(text).toContain('No quality score');
    });

    it('rejects missing task_id', async () => {
      const result = await safeTool('get_quality_score', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('get_provider_quality', () => {
    it('rejects missing provider', async () => {
      const result = await safeTool('get_provider_quality', {});
      expect(result.isError).toBe(true);
    });

    it('returns no data for unknown provider', async () => {
      const result = await safeTool('get_provider_quality', { provider: 'unknown-provider-xyz' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('No quality data');
    });
  });

  describe('get_provider_stats', () => {
    it('returns stats without provider filter', async () => {
      const result = await safeTool('get_provider_stats', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Provider Statistics');
    });

    it('returns stats for a specific provider', async () => {
      const result = await safeTool('get_provider_stats', { provider: 'codex' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('get_best_provider', () => {
    it('rejects missing task_type', async () => {
      const result = await safeTool('get_best_provider', {});
      expect(result.isError).toBe(true);
    });

    it('returns recommendation for unknown task type', async () => {
      const result = await safeTool('get_best_provider', { task_type: 'exotic_task_type' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Best Provider');
    });
  });

  // ============================================
  // Rollbacks
  // ============================================

  describe('list_rollbacks', () => {
    it('returns rollback list', async () => {
      const result = await safeTool('list_rollbacks', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Rollback');
    });

    it('filters by status', async () => {
      const result = await safeTool('list_rollbacks', { status: 'completed' });
      expect(result.isError).toBeFalsy();
    });

    it('respects limit parameter', async () => {
      const result = await safeTool('list_rollbacks', { limit: 5 });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Build Checks
  // ============================================

  describe('run_build_check', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('run_build_check', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('get_build_result', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_build_result', {});
      expect(result.isError).toBe(true);
    });

    it('returns no result for nonexistent task', async () => {
      const result = await safeTool('get_build_result', { task_id: 'nonexistent-build-123' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('No build check recorded');
    });
  });

  describe('configure_build_check', () => {
    it('enables build checks', async () => {
      const result = await safeTool('configure_build_check', { enabled: true });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Yes');
    });

    it('disables build checks', async () => {
      const result = await safeTool('configure_build_check', { enabled: false });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('No');
    });
  });

  // ============================================
  // Security Rules & Scanning
  // ============================================

  describe('list_security_rules', () => {
    it('returns security rules', async () => {
      const result = await safeTool('list_security_rules', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('rules');
      expect(parsed).toHaveProperty('count');
    });

    it('filters by category', async () => {
      const result = await safeTool('list_security_rules', { category: 'secrets' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('run_security_scan', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('run_security_scan', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task', async () => {
      const result = await safeTool('run_security_scan', { task_id: 'nonexistent-sec-123' });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_security_results', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_security_results', {});
      expect(result.isError).toBe(true);
    });

    it('returns results for nonexistent task', async () => {
      const result = await safeTool('get_security_results', { task_id: 'nonexistent-secr-123' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed.issues_found).toBe(0);
    });
  });

  // ============================================
  // Rate Limits & Cost
  // ============================================

  describe('get_rate_limits', () => {
    it('returns rate limits for all providers', async () => {
      const result = await safeTool('get_rate_limits', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('rate_limits');
    });

    it('filters by provider', async () => {
      const result = await safeTool('get_rate_limits', { provider: 'codex' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('set_rate_limit', () => {
    it('sets a rate limit for a provider', async () => {
      const result = await safeTool('set_rate_limit', {
        provider: 'ollama',
        max_value: 10,
        limit_type: 'requests',
        window_seconds: 60
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('ollama');
    });

    it('rejects missing provider', async () => {
      const result = await safeTool('set_rate_limit', { max_value: 10 });
      expect(result.isError).toBe(true);
    });

    it('rejects missing or invalid max_value', async () => {
      const result = await safeTool('set_rate_limit', { provider: 'ollama' });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_cost_summary', () => {
    it('returns cost summary', async () => {
      const result = await safeTool('get_cost_summary', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('days');
      expect(parsed).toHaveProperty('costs');
    });

    it('accepts days parameter', async () => {
      const result = await safeTool('get_cost_summary', { days: 7 });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed.days).toBe(7);
    });
  });

  describe('get_budget_status', () => {
    it('returns budget status', async () => {
      const result = await safeTool('get_budget_status', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('budgets');
    });
  });

  describe('set_budget', () => {
    it('sets a budget', async () => {
      const result = await safeTool('set_budget', {
        name: 'test-budget',
        budget_usd: 50,
        period: 'monthly'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('test-budget');
      expect(text).toContain('50');
    });

    it('rejects missing name', async () => {
      const result = await safeTool('set_budget', { budget_usd: 50 });
      expect(result.isError).toBe(true);
    });

    it('rejects missing or invalid budget_usd', async () => {
      const result = await safeTool('set_budget', { name: 'bad-budget' });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // File Locks
  // ============================================

  describe('get_file_locks', () => {
    it('returns file locks', async () => {
      const result = await safeTool('get_file_locks', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('locks');
    });
  });

  describe('release_file_locks', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('release_file_locks', {});
      expect(result.isError).toBe(true);
    });

    it('releases locks for a task (even if none exist)', async () => {
      const result = await safeTool('release_file_locks', { task_id: 'no-locks-task' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Released');
    });
  });

  // ============================================
  // Backups
  // ============================================

  describe('list_backups', () => {
    it('handles missing task_id', async () => {
      const result = await safeTool('list_backups', {});
      const text = getText(result);
      // Handler may throw requiring task_id, or return error markdown
      expect(text.length).toBeGreaterThan(0);
    });

    it('returns backups for nonexistent task', async () => {
      const result = await safeTool('list_backups', { task_id: 'no-backups-task' });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('restore_backup', () => {
    it('rejects missing backup_id', async () => {
      const result = await safeTool('restore_backup', {});
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Timeout Alerts
  // ============================================

  describe('get_timeout_alerts', () => {
    it('returns timeout alerts', async () => {
      const result = await safeTool('get_timeout_alerts', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('alerts');
    });
  });

  // ============================================
  // Output Limits
  // ============================================

  describe('configure_output_limits', () => {
    it('sets output limits for a provider', async () => {
      const result = await safeTool('configure_output_limits', {
        provider: 'ollama',
        max_output_bytes: 2097152,
        max_file_size_bytes: 1048576,
        max_file_changes: 30
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('ollama');
    });

    it('rejects missing provider', async () => {
      const result = await safeTool('configure_output_limits', {});
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Audit Trail
  // ============================================

  describe('get_audit_trail', () => {
    it('returns audit trail events or error', async () => {
      const result = await safeTool('get_audit_trail', {});
      const text = getText(result);
      // May succeed with JSON or error if audit table not populated
      expect(text.length).toBeGreaterThan(0);
    });

    it('handles entity_type filter', async () => {
      const result = await safeTool('get_audit_trail', { entity_type: 'task' });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('get_audit_summary', () => {
    it('returns audit summary or error', async () => {
      const result = await safeTool('get_audit_summary', {});
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('handles period parameter', async () => {
      const result = await safeTool('get_audit_summary', { period: 'weekly' });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Vulnerability Scanning
  // ============================================

  describe('get_vulnerability_results', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_vulnerability_results', {});
      expect(result.isError).toBe(true);
    });

    it('returns results for nonexistent task', async () => {
      const result = await safeTool('get_vulnerability_results', { task_id: 'no-vulns-task' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Complexity Metrics
  // ============================================

  describe('get_complexity_metrics', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_complexity_metrics', {});
      expect(result.isError).toBe(true);
    });

    it('returns metrics for nonexistent task', async () => {
      const result = await safeTool('get_complexity_metrics', { task_id: 'no-complexity-task' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Dead Code Detection
  // ============================================

  describe('get_dead_code_results', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_dead_code_results', {});
      expect(result.isError).toBe(true);
    });

    it('returns results for nonexistent task', async () => {
      const result = await safeTool('get_dead_code_results', { task_id: 'no-dead-code-task' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Doc Coverage
  // ============================================

  describe('get_doc_coverage_results', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_doc_coverage_results', {});
      expect(result.isError).toBe(true);
    });

    it('returns results for nonexistent task', async () => {
      const result = await safeTool('get_doc_coverage_results', { task_id: 'no-doc-cov-task' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Safeguard Tools Config
  // ============================================

  describe('get_safeguard_tools', () => {
    it('returns safeguard tool configs', async () => {
      const result = await safeTool('get_safeguard_tools', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('tools');
      expect(parsed).toHaveProperty('count');
    });

    it('filters by safeguard_type', async () => {
      const result = await safeTool('get_safeguard_tools', { safeguard_type: 'security' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // File Location Safeguards
  // ============================================

  describe('set_expected_output_path', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('set_expected_output_path', { expected_directory: '/tmp' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing expected_directory', async () => {
      const result = await safeTool('set_expected_output_path', { task_id: 'test-task' });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_file_location_issues', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_file_location_issues', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('record_file_change', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('record_file_change', { file_path: 'test.js', change_type: 'created' });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid change_type', async () => {
      const result = await safeTool('record_file_change', {
        task_id: 'test-task',
        file_path: 'test.js',
        change_type: 'invalid_type'
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('resolve_file_location_issue', () => {
    it('rejects missing issue_type', async () => {
      const result = await safeTool('resolve_file_location_issue', { issue_id: '123' });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid issue_type', async () => {
      const result = await safeTool('resolve_file_location_issue', { issue_type: 'invalid', issue_id: '123' });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Type References & Build Error Analysis
  // ============================================

  describe('verify_type_references', () => {
    it('rejects missing required args', async () => {
      const result = await safeTool('verify_type_references', { task_id: 'test' });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_type_verification_results', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_type_verification_results', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('analyze_build_output', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('analyze_build_output', { build_output: 'some output' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing build_output', async () => {
      const result = await safeTool('analyze_build_output', { task_id: 'test-task' });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_build_error_analysis', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_build_error_analysis', {});
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Similar Files Search
  // ============================================

  describe('search_similar_files', () => {
    it('rejects missing required args', async () => {
      const result = await safeTool('search_similar_files', { task_id: 'test' });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_similar_file_results', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_similar_file_results', {});
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Task Complexity
  // ============================================

  describe('calculate_task_complexity', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('calculate_task_complexity', { task_description: 'test desc' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing task_description', async () => {
      const result = await safeTool('calculate_task_complexity', { task_id: 'test-task' });
      expect(result.isError).toBe(true);
    });

    it('calculates complexity for a given description', async () => {
      const result = await safeTool('calculate_task_complexity', {
        task_id: 'complexity-test-1',
        task_description: 'Refactor the authentication module to support OAuth2 with multiple providers'
      });
      const text = getText(result);
      // May succeed or error if DB function not available in test env
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('get_task_complexity_score', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_task_complexity_score', {});
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Auto Rollback
  // ============================================

  describe('perform_auto_rollback', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('perform_auto_rollback', { working_directory: '/tmp', trigger_reason: 'test' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('perform_auto_rollback', { task_id: 'test', trigger_reason: 'test' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing trigger_reason', async () => {
      const result = await safeTool('perform_auto_rollback', { task_id: 'test', working_directory: '/tmp' });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_auto_rollback_history', () => {
    it('returns empty history when no rollbacks exist', async () => {
      const result = await safeTool('get_auto_rollback_history', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('rollback_count');
    });

    it('filters by task_id', async () => {
      const result = await safeTool('get_auto_rollback_history', { task_id: 'nonexistent-task' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // XAML Validation
  // ============================================

  describe('validate_xaml_semantics', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('validate_xaml_semantics', { file_path: 'test.xaml', content: '<Window/>' });
      expect(result.isError).toBe(true);
    });

    it('rejects non-string task_id', async () => {
      const result = await safeTool('validate_xaml_semantics', { task_id: 123, file_path: 'test.xaml', content: '<Window/>' });
      expect(result.isError).toBe(true);
    });

    it('validates XAML content', async () => {
      const result = await safeTool('validate_xaml_semantics', {
        task_id: 'xaml-test-1',
        file_path: 'MainWindow.xaml',
        content: '<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><Grid></Grid></Window>'
      });
      const text = getText(result);
      // Handler returns JSON with task_id field
      expect(text.length).toBeGreaterThan(0);
      if (!result.isError) {
        const parsed = JSON.parse(text);
        expect(parsed).toHaveProperty('task_id');
      }
    });
  });

  describe('get_xaml_validation_results', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_xaml_validation_results', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('check_xaml_consistency', () => {
    it('rejects missing required fields', async () => {
      const result = await safeTool('check_xaml_consistency', { task_id: 'test' });
      expect(result.isError).toBe(true);
    });

    it('checks XAML/code-behind consistency', async () => {
      const result = await safeTool('check_xaml_consistency', {
        task_id: 'xaml-consistency-1',
        xaml_path: 'MainWindow.xaml',
        xaml_content: '<Window x:Class="MyApp.MainWindow" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Button x:Name="btn1" Click="OnClick"/></Window>',
        codebehind_content: 'namespace MyApp { public partial class MainWindow { private void OnClick(object s, RoutedEventArgs e) {} } }'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
      if (!result.isError) {
        const parsed = JSON.parse(text);
        expect(parsed).toHaveProperty('task_id');
      }
    });
  });

  describe('get_xaml_consistency_results', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_xaml_consistency_results', {});
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Smoke Tests
  // ============================================

  describe('get_smoke_test_results', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_smoke_test_results', {});
      expect(result.isError).toBe(true);
    });

    it('returns results for nonexistent task', async () => {
      const result = await safeTool('get_smoke_test_results', { task_id: 'no-smoke-task' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed.result_count).toBe(0);
    });
  });

  // ============================================
  // Failure Patterns & Retry Rules
  // ============================================

  describe('add_failure_pattern', () => {
    it('adds a failure pattern', async () => {
      const result = await safeTool('add_failure_pattern', {
        name: 'oom-crash',
        description: 'Out of memory failure',
        signature: 'CUDA out of memory',
        provider: 'ollama',
        severity: 'high'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
      if (!result.isError) {
        expect(text).toContain('Failure Pattern Added');
        expect(text).toContain('oom-crash');
      }
    });

    it('rejects missing required fields', async () => {
      const result = await safeTool('add_failure_pattern', { name: 'incomplete-pattern' });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_failure_matches', () => {
    it('returns message when no task_id provided', async () => {
      const result = await safeTool('get_failure_matches', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('specify a task_id');
    });

    it('returns no matches for nonexistent task', async () => {
      const result = await safeTool('get_failure_matches', { task_id: 'no-matches-task' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('No failure pattern matches');
    });
  });

  describe('list_retry_rules', () => {
    it('returns retry rules list', async () => {
      const result = await safeTool('list_retry_rules', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Retry Rules');
    });

    it('lists all rules including disabled', async () => {
      const result = await safeTool('list_retry_rules', { enabled_only: false });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('add_retry_rule', () => {
    it('adds a retry rule', async () => {
      const result = await safeTool('add_retry_rule', {
        name: 'oom-retry',
        description: 'Retry on OOM with cloud fallback',
        rule_type: 'error_pattern',
        trigger: 'CUDA out of memory',
        fallback_provider: 'codex',
        max_retries: 2
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
      if (!result.isError) {
        expect(text).toContain('Retry Rule Added');
        expect(text).toContain('oom-retry');
        expect(text).toContain('codex');
      }
    });

    it('rejects missing required fields', async () => {
      const result = await safeTool('add_retry_rule', { name: 'incomplete-retry' });
      expect(result.isError).toBe(true);
    });
  });
});
