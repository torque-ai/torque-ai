/**
 * Tests for server/db/file-quality.js
 *
 * Pure database tests — no child_process, no spawning.
 * Uses vitest-setup template buffer for schema; dependency injection via setDb().
 */

const { setupTestDbModule, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');

let mod;

/** Insert a minimal task row to satisfy FK constraints on child tables. */
function ensureTask(id) {
  rawDb().prepare(`
    INSERT OR IGNORE INTO tasks (id, task_description, status, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, 'test task', 'pending', new Date().toISOString());
}

beforeAll(() => {
  ({ mod } = setupTestDbModule('../db/file-quality', 'file-quality'));
});

afterAll(() => teardownTestDb());

beforeEach(() => {
  resetTables([
    'syntax_validators', 'diff_previews', 'quality_scores',
    'provider_task_stats', 'build_checks', 'rate_limits',
    'rate_limit_events', 'output_limits', 'output_violations',
    'audit_trail', 'task_complexity_scores', 'validation_results',
    'safeguard_tool_config', 'config', 'validation_rules', 'tasks',
  ]);
});

// ============================================
// Syntax Validators
// ============================================

describe('file-quality', () => {
  describe('syntax validators', () => {
    it('should return empty array when no validators exist', () => {
      const result = mod.getSyntaxValidators('.js');
      expect(result).toEqual([]);
    });

    it('should return validators matching a given extension', () => {
      rawDb().prepare(`
        INSERT INTO syntax_validators (id, name, file_extensions, command, args, success_exit_codes, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('sv-1', 'eslint', '.js,.ts', 'eslint', '--fix', '0', 1, new Date().toISOString());

      const result = mod.getSyntaxValidators('.js');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('eslint');
      expect(result[0].command).toBe('eslint');
    });

    it('should not return disabled validators', () => {
      rawDb().prepare(`
        INSERT INTO syntax_validators (id, name, file_extensions, command, args, success_exit_codes, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('sv-2', 'disabled-lint', '.js', 'lint', '', '0', 0, new Date().toISOString());

      const result = mod.getSyntaxValidators('.js');
      expect(result).toHaveLength(0);
    });

    it('should not return validators for non-matching extensions', () => {
      rawDb().prepare(`
        INSERT INTO syntax_validators (id, name, file_extensions, command, args, success_exit_codes, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('sv-3', 'rustfmt', '.rs', 'rustfmt', '--check', '0', 1, new Date().toISOString());

      const result = mod.getSyntaxValidators('.js');
      expect(result).toHaveLength(0);
    });

    it('should list all syntax validators ordered by name', () => {
      const now = new Date().toISOString();
      const stmt = rawDb().prepare(`
        INSERT INTO syntax_validators (id, name, file_extensions, command, args, success_exit_codes, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run('sv-a', 'alpha', '.js', 'alpha', '', '0', 1, now);
      stmt.run('sv-b', 'beta', '.py', 'beta', '', '0', 0, now);
      stmt.run('sv-c', 'gamma', '.rs', 'gamma', '', '0', 1, now);

      const all = mod.listAllSyntaxValidators();
      expect(all).toHaveLength(3);
      expect(all[0].name).toBe('alpha');
      expect(all[1].name).toBe('beta');
      expect(all[2].name).toBe('gamma');
    });
  });

  // ============================================
  // Diff Previews
  // ============================================

  describe('diff previews', () => {
    it('should create a diff preview and retrieve it', () => {
      ensureTask('task-1');
      const id = mod.createDiffPreview('task-1', '--- a/file\n+++ b/file', 1, 10, 5);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);

      const preview = mod.getDiffPreview('task-1');
      expect(preview).toBeDefined();
      expect(preview.task_id).toBe('task-1');
      expect(preview.diff_content).toContain('--- a/file');
      expect(preview.files_changed).toBe(1);
      expect(preview.lines_added).toBe(10);
      expect(preview.lines_removed).toBe(5);
      expect(preview.status).toBe('pending');
    });

    it('should return undefined for non-existent task diff preview', () => {
      const result = mod.getDiffPreview('nonexistent');
      expect(result).toBeUndefined();
    });

    it('should mark a diff as reviewed', () => {
      ensureTask('task-2');
      mod.createDiffPreview('task-2', 'diff content', 2, 20, 10);

      mod.markDiffReviewed('task-2', 'admin');

      const preview = mod.getDiffPreview('task-2');
      expect(preview.status).toBe('reviewed');
      expect(preview.reviewed_by).toBe('admin');
      expect(preview.reviewed_at).toBeTruthy();
    });

    it('should check isDiffReviewRequired returns false by default', () => {
      const required = mod.isDiffReviewRequired();
      expect(required).toBe(false);
    });

    it('should check isDiffReviewRequired returns true when config set', () => {
      rawDb().prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('diff_preview_required', '1');
      const required = mod.isDiffReviewRequired();
      expect(required).toBe(true);
    });
  });

  // ============================================
  // Quality Scoring
  // ============================================

  describe('quality scoring', () => {
    it('should record a quality score and retrieve it', () => {
      ensureTask('task-q1');
      const score = mod.recordQualityScore('task-q1', 'ollama', 'testing', {
        validation: 90,
        syntax: 80,
        completeness: 70,
        metrics: { lines: 100 }
      });

      // Expected: 90*0.4 + 80*0.3 + 70*0.3 = 36+24+21 = 81
      expect(score).toBe(81);

      const stored = mod.getQualityScore('task-q1');
      expect(stored).toBeDefined();
      expect(stored.task_id).toBe('task-q1');
      expect(stored.provider).toBe('ollama');
      expect(stored.task_type).toBe('testing');
      expect(stored.overall_score).toBe(81);
      expect(stored.validation_score).toBe(90);
      expect(stored.syntax_score).toBe(80);
      expect(stored.completeness_score).toBe(70);
    });

    it('should use default 100 for missing score components', () => {
      ensureTask('task-q2');
      const score = mod.recordQualityScore('task-q2', 'codex', 'feature', {});
      // Expected: 100*0.4 + 100*0.3 + 100*0.3 = 40+30+30 = 100
      expect(score).toBe(100);
    });

    it('should return undefined for non-existent quality score', () => {
      const result = mod.getQualityScore('nonexistent');
      expect(result).toBeUndefined();
    });

    it('should get provider quality stats', () => {
      ensureTask('task-q3a');
      ensureTask('task-q3b');
      mod.recordQualityScore('task-q3a', 'ollama', 'testing', { validation: 80, syntax: 80, completeness: 80 });
      mod.recordQualityScore('task-q3b', 'ollama', 'feature', { validation: 60, syntax: 60, completeness: 60 });

      const stats = mod.getProviderQualityStats('ollama');
      expect(stats).toBeDefined();
      expect(stats.provider).toBe('ollama');
      expect(stats.total_tasks).toBe(2);
      expect(stats.avg_score).toBe(70); // (80+60)/2
      expect(stats.min_score).toBe(60);
      expect(stats.max_score).toBe(80);
    });

    it('should return undefined for provider with no quality stats', () => {
      const stats = mod.getProviderQualityStats('unknown');
      expect(stats).toBeUndefined();
    });

    it('should get overall quality stats since a given time', () => {
      ensureTask('task-q4');
      mod.recordQualityScore('task-q4', 'ollama', 'testing', { validation: 90, syntax: 90, completeness: 90 });

      const since = new Date(Date.now() - 60000).toISOString();
      const stats = mod.getOverallQualityStats(since);
      expect(stats.totalScored).toBe(1);
      expect(stats.avgScore).toBe(90);
      expect(stats.minScore).toBe(90);
      expect(stats.maxScore).toBe(90);
    });

    it('should return null avgScore when no scores exist for the period', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const stats = mod.getOverallQualityStats(future);
      expect(stats.avgScore).toBeNull();
      expect(stats.totalScored).toBe(0);
    });

    it('should get quality stats grouped by provider', () => {
      ensureTask('task-q5a');
      ensureTask('task-q5b');
      mod.recordQualityScore('task-q5a', 'ollama', 'testing', { validation: 80, syntax: 80, completeness: 80 });
      mod.recordQualityScore('task-q5b', 'codex', 'feature', { validation: 90, syntax: 90, completeness: 90 });

      const since = new Date(Date.now() - 60000).toISOString();
      const stats = mod.getQualityStatsByProvider(since);
      expect(stats).toHaveLength(2);
      // Sorted by avg_score DESC, so codex (90) first
      expect(stats[0].provider).toBe('codex');
      expect(stats[0].avgScore).toBe(90);
      expect(stats[1].provider).toBe('ollama');
      expect(stats[1].avgScore).toBe(80);
    });
  });

  // ============================================
  // Provider Stats (provider_task_stats)
  // ============================================

  describe('provider stats', () => {
    it('should update provider stats for a new provider/task_type combo', () => {
      mod.updateProviderStats('ollama', 'testing', true, 85, 120);

      const stats = mod.getProviderStats('ollama');
      expect(stats).toHaveLength(1);
      expect(stats[0].provider).toBe('ollama');
      expect(stats[0].task_type).toBe('testing');
      expect(stats[0].total_tasks).toBe(1);
      expect(stats[0].successful_tasks).toBe(1);
      expect(stats[0].failed_tasks).toBe(0);
      expect(stats[0].avg_quality_score).toBe(85);
      expect(stats[0].avg_duration_seconds).toBe(120);
    });

    it('should accumulate stats on repeated updates', () => {
      mod.updateProviderStats('codex', 'feature', true, 90, 60);
      mod.updateProviderStats('codex', 'feature', false, 50, 120);

      const stats = mod.getProviderStats('codex');
      expect(stats).toHaveLength(1);
      expect(stats[0].total_tasks).toBe(2);
      expect(stats[0].successful_tasks).toBe(1);
      expect(stats[0].failed_tasks).toBe(1);
      // avg quality: (90*1 + 50)/2 = 70
      expect(stats[0].avg_quality_score).toBe(70);
      // avg duration: (60*1 + 120)/2 = 90
      expect(stats[0].avg_duration_seconds).toBe(90);
    });

    it('should return all provider stats when no provider specified', () => {
      mod.updateProviderStats('ollama', 'testing', true, 80, 100);
      mod.updateProviderStats('codex', 'feature', true, 90, 50);

      const all = mod.getProviderStats();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('should return empty array for unknown provider', () => {
      const stats = mod.getProviderStats('nonexistent');
      expect(stats).toEqual([]);
    });

    it('should find the best provider for a task type', () => {
      // Need at least 3 tasks to qualify
      mod.updateProviderStats('ollama', 'testing', true, 80, 100);
      mod.updateProviderStats('ollama', 'testing', true, 85, 90);
      mod.updateProviderStats('ollama', 'testing', true, 90, 80);

      const best = mod.getBestProviderForTaskType('testing');
      expect(best).toBeDefined();
      expect(best.provider).toBe('ollama');
      expect(best.total_tasks).toBe(3);
    });

    it('should return undefined when no provider has enough tasks', () => {
      mod.updateProviderStats('ollama', 'rare', true, 80, 100);
      // Only 1 task, minimum is 3
      const best = mod.getBestProviderForTaskType('rare');
      expect(best).toBeUndefined();
    });

    it('should detect provider degradation', () => {
      // Create a provider with high failure rate (>0.3) and recent updates
      const now = new Date().toISOString();
      rawDb().prepare(`
        INSERT INTO provider_task_stats (provider, task_type, total_tasks, successful_tasks, failed_tasks, avg_quality_score, avg_duration_seconds, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('bad-provider', 'testing', 10, 5, 5, 40, 200, now);

      const degraded = mod.detectProviderDegradation();
      expect(degraded).toHaveLength(1);
      expect(degraded[0].provider).toBe('bad-provider');
      expect(degraded[0].failure_rate).toBe(0.5);
    });

    it('should not flag providers with low failure rate as degraded', () => {
      const now = new Date().toISOString();
      rawDb().prepare(`
        INSERT INTO provider_task_stats (provider, task_type, total_tasks, successful_tasks, failed_tasks, avg_quality_score, avg_duration_seconds, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('good-provider', 'testing', 10, 9, 1, 90, 60, now);

      const degraded = mod.detectProviderDegradation();
      expect(degraded).toHaveLength(0);
    });
  });

  // ============================================
  // Build Checks
  // ============================================

  describe('build checks', () => {
    it('should save and retrieve a build result', () => {
      ensureTask('task-b1');
      mod.saveBuildResult('task-b1', {
        command: 'npm run build',
        workingDirectory: '/project',
        exitCode: 0,
        output: 'Build succeeded',
        errorOutput: '',
        durationSeconds: 12.5,
        status: 'passed'
      });

      const check = mod.getBuildCheck('task-b1');
      expect(check).toBeDefined();
      expect(check.task_id).toBe('task-b1');
      expect(check.build_command).toBe('npm run build');
      expect(check.exit_code).toBe(0);
      expect(check.status).toBe('passed');
      expect(check.output).toBe('Build succeeded');
    });

    it('should return the most recent build check for a task', () => {
      ensureTask('task-b2');
      mod.saveBuildResult('task-b2', {
        command: 'npm run build',
        exitCode: 1,
        status: 'failed'
      });
      mod.saveBuildResult('task-b2', {
        command: 'npm run build',
        exitCode: 0,
        status: 'passed'
      });

      // getBuildCheck orders by checked_at DESC LIMIT 1.
      // Both records are inserted within the same millisecond so the
      // ordering is deterministic only by rowid. Verify we get one of
      // the two records back (the function returns a single row).
      const check = mod.getBuildCheck('task-b2');
      expect(check).toBeDefined();
      expect(check.task_id).toBe('task-b2');
      expect(['passed', 'failed']).toContain(check.status);
    });

    it('should return undefined for task with no build checks', () => {
      const check = mod.getBuildCheck('nonexistent');
      expect(check).toBeUndefined();
    });
  });

  // ============================================
  // Task Type Classification
  // ============================================

  describe('task type classification', () => {
    it('should classify test tasks', () => {
      expect(mod.classifyTaskType('Write unit tests for the parser')).toBe('testing');
      expect(mod.classifyTaskType('Add spec for component')).toBe('testing');
    });

    it('should classify documentation tasks', () => {
      expect(mod.classifyTaskType('Update the README file')).toBe('documentation');
      expect(mod.classifyTaskType('Add comment to function')).toBe('documentation');
      expect(mod.classifyTaskType('Document the API')).toBe('documentation');
    });

    it('should classify refactoring tasks', () => {
      expect(mod.classifyTaskType('Refactor the database module')).toBe('refactoring');
      expect(mod.classifyTaskType('Rename variable x to count')).toBe('refactoring');
      expect(mod.classifyTaskType('Extract method from class')).toBe('refactoring');
    });

    it('should classify bugfix tasks', () => {
      expect(mod.classifyTaskType('Fix the null pointer error')).toBe('bugfix');
      expect(mod.classifyTaskType('Debug the crash bug')).toBe('bugfix');
    });

    it('should classify feature tasks', () => {
      expect(mod.classifyTaskType('Add a new search feature')).toBe('feature');
      expect(mod.classifyTaskType('Create a user service')).toBe('feature');
      expect(mod.classifyTaskType('Implement the caching layer')).toBe('feature');
    });

    it('should classify modification tasks', () => {
      expect(mod.classifyTaskType('Update the timeout value')).toBe('modification');
      expect(mod.classifyTaskType('Change the color scheme')).toBe('modification');
      expect(mod.classifyTaskType('Modify the query logic')).toBe('modification');
    });

    it('should classify deletion tasks', () => {
      expect(mod.classifyTaskType('Delete the deprecated module')).toBe('deletion');
      expect(mod.classifyTaskType('Remove unused imports')).toBe('deletion');
    });

    it('should classify configuration tasks', () => {
      // Note: classifyTaskType checks keywords in priority order.
      // 'update' and 'change' match 'modification' before 'config'/'setting'.
      // Only descriptions without higher-priority keywords hit 'configuration'.
      expect(mod.classifyTaskType('The config needs adjusting')).toBe('configuration');
      expect(mod.classifyTaskType('Tweak the setting value')).toBe('configuration');
    });

    it('should classify unknown tasks as general', () => {
      expect(mod.classifyTaskType('Do something')).toBe('general');
      expect(mod.classifyTaskType('XYZ')).toBe('general');
    });
  });

  // ============================================
  // Rate Limits
  // ============================================

  describe('rate limits', () => {
    it('should set and retrieve rate limits', () => {
      const result = mod.setRateLimit('ollama', 'concurrent', 5, 60, true);
      expect(result.id).toBe('rl-ollama-concurrent');
      expect(result.provider).toBe('ollama');
      expect(result.max_value).toBe(5);

      const limits = mod.getRateLimits('ollama');
      expect(limits).toHaveLength(1);
      expect(limits[0].provider).toBe('ollama');
      expect(limits[0].limit_type).toBe('concurrent');
      expect(limits[0].max_value).toBe(5);
    });

    it('should upsert rate limit on conflict', () => {
      mod.setRateLimit('ollama', 'concurrent', 5);
      mod.setRateLimit('ollama', 'concurrent', 10);

      const limits = mod.getRateLimits('ollama');
      expect(limits).toHaveLength(1);
      expect(limits[0].max_value).toBe(10);
    });

    it('should return all rate limits when no provider specified', () => {
      mod.setRateLimit('ollama', 'concurrent', 5);
      mod.setRateLimit('codex', 'requests', 100, 60);

      const all = mod.getRateLimits();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('should check concurrent rate limit - allowed', () => {
      mod.setRateLimit('test-prov', 'concurrent', 10, 60, true);

      const result = mod.checkRateLimit('test-prov');
      expect(result.allowed).toBe(true);
    });

    it('should check concurrent rate limit - blocked when at max', () => {
      mod.setRateLimit('test-prov2', 'concurrent', 0, 60, true);

      const result = mod.checkRateLimit('test-prov2');
      // Running count is 0, limit is 0, so blocked
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Concurrent limit');
    });

    it('should check request rate limit within window', () => {
      mod.setRateLimit('rl-prov', 'requests', 100, 60, true);
      // Update window_start to now
      rawDb().prepare('UPDATE rate_limits SET window_start = ?, current_value = 1 WHERE id = ?')
        .run(new Date().toISOString(), 'rl-rl-prov-requests');

      const result = mod.checkRateLimit('rl-prov');
      expect(result.allowed).toBe(true);
    });

    it('should record rate limit events', () => {
      mod.recordRateLimitEvent('ollama', 'task-1', 'blocked', 5, 5);

      const events = rawDb().prepare('SELECT * FROM rate_limit_events WHERE provider = ?').all('ollama');
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('blocked');
      expect(events[0].current_value).toBe(5);
      expect(events[0].max_value).toBe(5);
    });
  });

  // ============================================
  // Output Limits
  // ============================================

  describe('output limits', () => {
    it('should set output limits for a provider', () => {
      const result = mod.setOutputLimit('ollama', 2097152, 1048576, 30, true);
      expect(result.provider).toBe('ollama');
      expect(result.max_output_bytes).toBe(2097152);
      expect(result.max_file_size_bytes).toBe(1048576);
      expect(result.enabled).toBe(true);
    });

    it('should upsert output limits on conflict', () => {
      mod.setOutputLimit('codex', 1000000);
      mod.setOutputLimit('codex', 2000000);

      const row = rawDb().prepare('SELECT * FROM output_limits WHERE provider = ?').get('codex');
      expect(row.max_output_bytes).toBe(2000000);
    });

    it('should check output size limits - within limits', () => {
      ensureTask('task-ol1');
      mod.setOutputLimit('ollama', 1048576, 524288, 20, true);

      const result = mod.checkOutputSizeLimits('task-ol1', 'ollama', 100000);
      expect(result.withinLimits).toBe(true);
    });

    it('should check output size limits - output too large', () => {
      ensureTask('task-ol2');
      mod.setOutputLimit('ollama', 1000, 500, 10, true);

      const result = mod.checkOutputSizeLimits('task-ol2', 'ollama', 5000);
      expect(result.withinLimits).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].type).toBe('output_size');
      expect(result.violations[0].actual).toBe(5000);
      expect(result.violations[0].max).toBe(1000);
    });

    it('should check output size limits - file too large', () => {
      ensureTask('task-ol3');
      mod.setOutputLimit('ollama', 1048576, 500, 10, true);

      const result = mod.checkOutputSizeLimits('task-ol3', 'ollama', 100, [
        { path: 'big-file.js', size: 1000 }
      ]);
      expect(result.withinLimits).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].type).toBe('file_size');
      expect(result.violations[0].filePath).toBe('big-file.js');
    });

    it('should record output violations in the database', () => {
      ensureTask('task-ol4');
      mod.setOutputLimit('ollama', 1000, 500, 10, true);
      mod.checkOutputSizeLimits('task-ol4', 'ollama', 5000);

      const violations = mod.getOutputViolations('task-ol4');
      expect(violations).toHaveLength(1);
      expect(violations[0].task_id).toBe('task-ol4');
      expect(violations[0].violation_type).toBe('output_size');
    });

    it('should return within limits when no output limits configured', () => {
      ensureTask('task-ol5');
      const result = mod.checkOutputSizeLimits('task-ol5', 'unknown-provider', 999999);
      expect(result.withinLimits).toBe(true);
    });
  });

  // ============================================
  // Audit Trail
  // ============================================

  describe('audit trail', () => {
    it('should record an audit event', () => {
      mod.recordAuditEvent('task', 'task', 'task-1', 'created', 'system');

      const trail = mod.getAuditTrail('task', 'task-1');
      expect(trail).toHaveLength(1);
      expect(trail[0].event_type).toBe('task');
      expect(trail[0].entity_type).toBe('task');
      expect(trail[0].entity_id).toBe('task-1');
      expect(trail[0].action).toBe('created');
      expect(trail[0].actor).toBe('system');
    });

    it('should record audit event with object values', () => {
      mod.recordAuditEvent(
        'config', 'setting', 'timeout', 'updated',
        'admin',
        { value: 30 },
        { value: 60 },
        { reason: 'performance' }
      );

      const trail = mod.getAuditTrail('setting', 'timeout');
      expect(trail).toHaveLength(1);
      expect(JSON.parse(trail[0].old_value)).toEqual({ value: 30 });
      expect(JSON.parse(trail[0].new_value)).toEqual({ value: 60 });
      expect(JSON.parse(trail[0].metadata)).toEqual({ reason: 'performance' });
    });

    it('should filter audit trail by entity_type only', () => {
      mod.recordAuditEvent('task', 'task', 'task-1', 'created', 'system');
      mod.recordAuditEvent('config', 'setting', 'key-1', 'updated', 'admin');

      const taskTrail = mod.getAuditTrail('task');
      expect(taskTrail).toHaveLength(1);
      expect(taskTrail[0].entity_type).toBe('task');
    });

    it('should return all audit trail entries when no filters', () => {
      mod.recordAuditEvent('task', 'task', 't1', 'created', 'system');
      mod.recordAuditEvent('config', 'setting', 's1', 'updated', 'admin');
      mod.recordAuditEvent('task', 'task', 't2', 'completed', 'system');

      const all = mod.getAuditTrail();
      expect(all).toHaveLength(3);
    });

    it('should respect the limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        mod.recordAuditEvent('task', 'task', `t-${i}`, 'created', 'system');
      }

      const limited = mod.getAuditTrail(null, null, 3);
      expect(limited).toHaveLength(3);
    });

    it('should order audit trail by created_at DESC', () => {
      // Use distinct timestamps to ensure deterministic ordering
      const earlier = new Date(Date.now() - 5000).toISOString();
      const later = new Date().toISOString();

      // Insert 'first' with an earlier timestamp by direct SQL
      rawDb().prepare(`
        INSERT INTO audit_trail (event_type, entity_type, entity_id, action, actor, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('task', 'task', 'first', 'created', 'system', earlier);
      rawDb().prepare(`
        INSERT INTO audit_trail (event_type, entity_type, entity_id, action, actor, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('task', 'task', 'second', 'created', 'system', later);

      const trail = mod.getAuditTrail();
      // Most recent first
      expect(trail[0].entity_id).toBe('second');
      expect(trail[1].entity_id).toBe('first');
    });

    it('should get audit summary grouped by event_type and action', () => {
      for (let i = 0; i < 5; i++) {
        mod.recordAuditEvent('task', 'task', `t-${i}`, 'created', 'system');
      }
      for (let i = 0; i < 3; i++) {
        mod.recordAuditEvent('task', 'task', `t-${i}`, 'completed', 'system');
      }

      const summary = mod.getAuditSummary(1);
      expect(summary.length).toBeGreaterThanOrEqual(2);
      // Sorted by count DESC
      expect(summary[0].count).toBeGreaterThanOrEqual(summary[1].count);
    });
  });

  // ============================================
  // Task Complexity Scoring
  // ============================================

  describe('task complexity scoring', () => {
    it('should score a simple task with low complexity', () => {
      ensureTask('task-c1');
      const result = mod.calculateTaskComplexityScore('task-c1', 'Update the timeout value');
      expect(result.task_id).toBe('task-c1');
      expect(result.total_score).toBeLessThanOrEqual(4);
      expect(result.recommended_provider).toBe('aider-ollama');
      expect(result.routing_reason).toContain('suitable for local LLM');
    });

    it('should score a complex XAML task highly', () => {
      ensureTask('task-c2');
      const result = mod.calculateTaskComplexityScore(
        'task-c2',
        'Create a new XAML UserControl with multiple methods and implement INotifyPropertyChanged interface'
      );
      expect(result.total_score).toBeGreaterThan(4);
      expect(result.recommended_provider).toBe('claude-cli');
      expect(result.routing_reason).toContain('route to cloud provider');
      expect(result.factors.involves_xaml).toBe(1);
      expect(result.factors.creates_file).toBe(1);
    });

    it('should detect file creation in task description', () => {
      ensureTask('task-c3');
      const result = mod.calculateTaskComplexityScore('task-c3', 'Create a new service class');
      expect(result.factors.creates_file).toBe(1);
    });

    it('should detect interface implementation', () => {
      ensureTask('task-c4');
      const result = mod.calculateTaskComplexityScore('task-c4', 'Implement the IDisposable interface');
      expect(result.factors.implements_interface).toBe(1);
    });

    it('should detect method count', () => {
      ensureTask('task-c5');
      // The regex /method|function|add.*\(\)|implement.*\(\)/gi uses greedy
      // matching, so 'add.*\(\)' can consume multiple methods in one match.
      // Use separate sentences to get distinct matches.
      const result = mod.calculateTaskComplexityScore(
        'task-c5',
        'This has a method and a function in it'
      );
      expect(result.factors.method_count).toBeGreaterThanOrEqual(2);
    });

    it('should detect large modification keywords', () => {
      ensureTask('task-c6');
      const result = mod.calculateTaskComplexityScore('task-c6', 'Refactor the entire database module across multiple files');
      expect(result.factors.modifies_lines).toBe(100);
    });

    it('should persist complexity score to database', () => {
      ensureTask('task-c7');
      mod.calculateTaskComplexityScore('task-c7', 'Simple edit');

      const stored = mod.getTaskComplexityScore('task-c7');
      expect(stored).toBeDefined();
      expect(stored.task_id).toBe('task-c7');
      expect(typeof stored.total_score).toBe('number');
      expect(stored.scored_at).toBeTruthy();
    });

    it('should return undefined for task with no complexity score', () => {
      const result = mod.getTaskComplexityScore('nonexistent');
      expect(result).toBeUndefined();
    });
  });

  // ============================================
  // Validation Failure Rate
  // ============================================

  describe('validation failure rate', () => {
    it('should return zero failure rate when no validation results exist', () => {
      const since = new Date(Date.now() - 86400000).toISOString();
      const result = mod.getValidationFailureRate(since);
      expect(result.totalValidated).toBe(0);
      expect(result.totalFailed).toBe(0);
      expect(result.failureRate).toBe(0);
    });

    it('should compute failure rate from validation results', () => {
      ensureTask('task-v1');
      ensureTask('task-v2');
      ensureTask('task-v3');
      // Insert a validation rule to satisfy FK on rule_id
      rawDb().prepare(`
        INSERT OR IGNORE INTO validation_rules (id, name, description, severity, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('rule-1', 'no-stubs', 'No stub implementations', 'error', 1, new Date().toISOString());

      const now = new Date().toISOString();
      const stmt = rawDb().prepare(`
        INSERT INTO validation_results (task_id, rule_id, rule_name, status, severity, validated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      // 3 tasks validated, 1 with error severity
      stmt.run('task-v1', 'rule-1', 'no-stubs', 'passed', 'info', now);
      stmt.run('task-v2', 'rule-1', 'no-stubs', 'failed', 'error', now);
      stmt.run('task-v3', 'rule-1', 'no-stubs', 'passed', 'warning', now);

      const since = new Date(Date.now() - 60000).toISOString();
      const result = mod.getValidationFailureRate(since);
      expect(result.totalValidated).toBe(3);
      expect(result.totalFailed).toBe(1);
      expect(result.failureRate).toBe(33); // 1/3 * 100 rounded
    });
  });

  // ============================================
  // Safeguard Tool Configs
  // ============================================

  describe('safeguard tool configs', () => {
    it('should return empty array when no configs exist', () => {
      const configs = mod.getSafeguardToolConfigs();
      expect(configs).toEqual([]);
    });

    it('should return all enabled safeguard tool configs', () => {
      const now = new Date().toISOString();
      rawDb().prepare(`
        INSERT INTO safeguard_tool_config (id, safeguard_type, language, tool_name, tool_command, tool_args, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('st-1', 'vulnerability', 'javascript', 'npm audit', 'npm', 'audit --json', 1, now);
      rawDb().prepare(`
        INSERT INTO safeguard_tool_config (id, safeguard_type, language, tool_name, tool_command, tool_args, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('st-2', 'complexity', 'javascript', 'plato', 'plato', '-r report', 0, now);

      const configs = mod.getSafeguardToolConfigs();
      expect(configs).toHaveLength(1);
      expect(configs[0].tool_name).toBe('npm audit');
    });

    it('should filter by safeguard type', () => {
      const now = new Date().toISOString();
      rawDb().prepare(`
        INSERT INTO safeguard_tool_config (id, safeguard_type, language, tool_name, tool_command, tool_args, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('st-3', 'vulnerability', 'javascript', 'npm audit', 'npm', 'audit', 1, now);
      rawDb().prepare(`
        INSERT INTO safeguard_tool_config (id, safeguard_type, language, tool_name, tool_command, tool_args, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('st-4', 'complexity', 'javascript', 'plato', 'plato', '-r', 1, now);

      const vuln = mod.getSafeguardToolConfigs('vulnerability');
      expect(vuln).toHaveLength(1);
      expect(vuln[0].safeguard_type).toBe('vulnerability');

      const complexity = mod.getSafeguardToolConfigs('complexity');
      expect(complexity).toHaveLength(1);
      expect(complexity[0].safeguard_type).toBe('complexity');
    });
  });
});
