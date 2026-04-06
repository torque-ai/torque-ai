'use strict';

const path = require('path');
const { FILE_SIZE_TRUNCATION_THRESHOLD } = require('../constants');

function seedDefaults(db, logger, safeAddColumn, extras = {}) {
  const { DATA_DIR, truncationThreshold, setConfigDefault } = extras;
  const safeTruncationThreshold = Number.isFinite(truncationThreshold)
    ? Math.abs(truncationThreshold)
    : Math.abs(FILE_SIZE_TRUNCATION_THRESHOLD);
  const insertArtifactConfig = db.prepare(`
      INSERT OR IGNORE INTO artifact_config (key, value) VALUES (?, ?)
    `);
  insertArtifactConfig.run('storage_path', path.join(DATA_DIR, 'artifacts'));
  insertArtifactConfig.run('max_size_mb', '50');
  insertArtifactConfig.run('retention_days', '30');
  insertArtifactConfig.run('max_per_task', '20');
  const insertCacheConfig = db.prepare(`
      INSERT OR IGNORE INTO cache_config (key, value) VALUES (?, ?)
    `);
  insertCacheConfig.run('ttl_hours', '24');
  insertCacheConfig.run('max_size_mb', '100');
  insertCacheConfig.run('similarity_threshold', '0.85');
  insertCacheConfig.run('auto_cache', 'true');
  const insertPriorityConfig = db.prepare(`
      INSERT OR IGNORE INTO priority_config (key, value) VALUES (?, ?)
    `);
  insertPriorityConfig.run('resource_weight', '0.3');
  insertPriorityConfig.run('success_weight', '0.3');
  insertPriorityConfig.run('dependency_weight', '0.4');
  const insertSafeguardTool = db.prepare(`
      INSERT OR IGNORE INTO safeguard_tool_config (id, safeguard_type, language, tool_name, tool_command, tool_args, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  const toolNow = new Date().toISOString();
  insertSafeguardTool.run('vuln-npm', 'vulnerability', 'javascript', 'npm audit', 'npm', 'audit --json', 1, toolNow);
  insertSafeguardTool.run('vuln-dotnet', 'vulnerability', 'csharp', 'dotnet vulnerable', 'dotnet', 'list package --vulnerable --format json', 1, toolNow);
  insertSafeguardTool.run('vuln-pip', 'vulnerability', 'python', 'pip-audit', 'pip-audit', '--format json', 1, toolNow);
  insertSafeguardTool.run('complex-eslint', 'complexity', 'javascript', 'ESLint Complexity', 'npx', 'eslint --rule "complexity: [error, 10]" --format json', 1, toolNow);
  insertSafeguardTool.run('complex-radon', 'complexity', 'python', 'Radon', 'radon', 'cc -j', 1, toolNow);
  insertSafeguardTool.run('dead-ts-prune', 'deadcode', 'typescript', 'ts-prune', 'npx', 'ts-prune', 1, toolNow);
  insertSafeguardTool.run('dead-vulture', 'deadcode', 'python', 'Vulture', 'vulture', '', 1, toolNow);
  insertSafeguardTool.run('api-swagger', 'api_contract', null, 'Swagger CLI', 'npx', 'swagger-cli validate', 1, toolNow);
  insertSafeguardTool.run('api-spectral', 'api_contract', null, 'Spectral', 'npx', 'spectral lint', 1, toolNow);
  insertSafeguardTool.run('a11y-axe', 'accessibility', 'javascript', 'axe-core', 'npx', 'axe', 1, toolNow);
  insertSafeguardTool.run('a11y-eslint', 'accessibility', 'javascript', 'eslint-plugin-jsx-a11y', 'npx', 'eslint --plugin jsx-a11y --format json', 1, toolNow);
  const insertFailoverConfig = db.prepare(`
      INSERT OR IGNORE INTO failover_config (key, value) VALUES (?, ?)
    `);
  insertFailoverConfig.run('heartbeat_interval_seconds', '30');
  insertFailoverConfig.run('offline_threshold_missed', '3');
  insertFailoverConfig.run('default_lease_seconds', '300');
  insertFailoverConfig.run('auto_failover_enabled', '1');
  insertFailoverConfig.run('auto_rebalance_enabled', '0');
  insertFailoverConfig.run('rebalance_threshold_percent', '30');
  const insertConfig = db.prepare(`
      INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)
    `);
  insertConfig.run('max_concurrent', '20');
  insertConfig.run('auto_compute_max_concurrent', '1');
  insertConfig.run('default_project_max_concurrent', '3');
  insertConfig.run('default_timeout', '30');
  insertConfig.run('stale_running_minutes', '60');
  insertConfig.run('stale_queued_minutes', '1440');
  insertConfig.run('api_rate_limit', '200');
  insertConfig.run('task_retention_count', '5000');
  insertConfig.run('default_provider', 'ollama');
  insertConfig.run('strategic_auto_diagnose', '0');
  insertConfig.run('strategic_auto_review', '0');
  insertConfig.run('strategic_provider', 'ollama');
  // Legacy: populated dynamically by discovery engine
  insertConfig.run('strategic_model', '');
  insertConfig.run('codex_overflow_to_local', '0');
  insertConfig.run('codex_probe_interval_minutes', '15');
  insertConfig.run('overflow_max_complexity', 'normal');
  insertConfig.run('quota_auto_scale_enabled', 'false');
  insertConfig.run('quota_queue_depth_threshold', '3');
  insertConfig.run('quota_cooldown_seconds', '60');
  insertConfig.run('resource_gating_enabled', '1');
  insertConfig.run('scheduling_mode', 'legacy');
  insertConfig.run('policy_engine_enabled', '0');
  insertConfig.run('policy_engine_shadow_only', '1');
  insertConfig.run('policy_rest_enabled', '0');
  insertConfig.run('policy_mcp_enabled', '0');
  insertConfig.run('policy_block_mode_enabled', '0');
  insertConfig.run('policy_profile_torque_default_enabled', '0');
  const pruneScheduleNow = new Date().toISOString();
  const pruneNextRun = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const insertMaintenanceSchedule = db.prepare(`
      INSERT OR IGNORE INTO maintenance_schedule (id, task_type, schedule_type, interval_minutes, cron_expression, next_run_at, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  insertMaintenanceSchedule.run(
      'prune_old_tasks',
      'prune_old_tasks',
      'interval',
      1440,
      null,
      pruneNextRun,
      1,
      pruneScheduleNow
    );
  insertMaintenanceSchedule.run(
      'purge_task_output',
      'purge_task_output',
      'interval',
      1440,
      null,
      pruneNextRun,
      1,
      pruneScheduleNow
    );
  const hasLegacyMaintenanceTasks = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_tasks'
    `).get();
  if (hasLegacyMaintenanceTasks) {
      db.prepare(`
        INSERT OR IGNORE INTO maintenance_tasks (name, interval_seconds, enabled)
        VALUES (?, ?, ?)
      `).run('prune_old_tasks', 86400, 1);
    }
  const insertProvider = db.prepare(`
      INSERT OR IGNORE INTO provider_config (provider, enabled, priority, cli_path, transport, cli_args, quota_error_patterns, max_concurrent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  const now = new Date().toISOString();
  insertProvider.run('codex', 1, 1, 'codex', 'hybrid', null, JSON.stringify([
      'quota exceeded', 'rate limit', 'weekly limit', 'usage limit', 'too many requests', '429'
    ]), 10, now);
  insertProvider.run('claude-cli', 1, 2, 'claude', 'cli', null, JSON.stringify([
      'hit your limit', 'rate limit', 'resets', '429', 'quota exceeded', 'too many requests'
    ]), 10, now);
  insertProvider.run('ollama', 1, 3, 'api', 'api', null, JSON.stringify([
      'connection refused', 'timeout', 'ECONNREFUSED', 'model not found'
    ]), 2, now);
  // anthropic provider not seeded by default — add via provider CRUD if you have an API key
  // insertProvider.run('anthropic', 0, 6, 'api', 'api', null, JSON.stringify([
  //     'rate_limit_error', 'overloaded_error', '429', '529'
  //   ]), 5, now);
  insertProvider.run('groq', 0, 7, 'api', 'api', null, JSON.stringify([
      'rate_limit', '429', 'model_not_available'
    ]), 10, now);
  insertProvider.run('ollama-cloud', 0, 6, 'api', 'api', null, JSON.stringify([
      'rate_limit', '429', 'model_not_available'
    ]), 2, now);
  insertProvider.run('cerebras', 0, 7, 'api', 'api', null, JSON.stringify([
      'rate_limit', '429', 'model_not_available'
    ]), 3, now);
  insertProvider.run('google-ai', 0, 7, 'api', 'api', null, JSON.stringify([
      'rate_limit', '429', 'RESOURCE_EXHAUSTED', 'quota'
    ]), 2, now);
  insertProvider.run('openrouter', 0, 7, 'api', 'api', null, JSON.stringify([
      'rate_limit', '429', 'model_not_available', 'credits'
    ]), 3, now);
  insertProvider.run('hyperbolic', 0, 8, 'api', 'api', null, JSON.stringify([
      'rate_limit', '429', 'model_not_available', 'server_error'
    ]), 20, now);
  insertProvider.run('deepinfra', 0, 9, 'api', 'api', null, JSON.stringify([
      'rate_limit', '429', 'model_not_available', 'server_error'
    ]), 50, now);
  const providerTypes = {
    codex: 'cloud-cli', 'claude-cli': 'cloud-cli',
    ollama: 'ollama',
    anthropic: 'cloud-api', deepinfra: 'cloud-api', groq: 'cloud-api',
    hyperbolic: 'cloud-api', cerebras: 'cloud-api', 'google-ai': 'cloud-api',
    openrouter: 'cloud-api', 'ollama-cloud': 'cloud-api',
  };
  for (const [provider, type] of Object.entries(providerTypes)) {
    try {
      db.prepare('UPDATE provider_config SET provider_type = ? WHERE provider = ? AND provider_type IS NULL')
        .run(type, provider);
    } catch { /* ignore */ }
  }
  const PROVIDER_CAPABILITIES = {
    codex: { capabilities: ['file_creation', 'file_edit', 'multi_file', 'reasoning'], band: 'A' },
    'claude-cli': { capabilities: ['file_creation', 'file_edit', 'multi_file', 'reasoning'], band: 'A' },
    deepinfra: { capabilities: ['reasoning', 'large_context', 'code_review'], band: 'B' },
    'ollama-cloud': { capabilities: ['reasoning', 'large_context', 'code_review'], band: 'B' },
    hyperbolic: { capabilities: ['reasoning', 'large_context'], band: 'B' },
    anthropic: { capabilities: ['reasoning', 'code_review'], band: 'B' },
    ollama: { capabilities: ['file_edit', 'reasoning', 'code_review'], band: 'C' },
    openrouter: { capabilities: ['reasoning', 'code_review'], band: 'C' },
    groq: { capabilities: [], band: 'D' },
    cerebras: { capabilities: [], band: 'D' },
    'google-ai': { capabilities: [], band: 'D' },
  };

  for (const [provider, config] of Object.entries(PROVIDER_CAPABILITIES)) {
    try {
      db.prepare('UPDATE provider_config SET capability_tags = ?, quality_band = ? WHERE provider = ?')
        .run(JSON.stringify(config.capabilities), config.band, provider);
    } catch { /* provider may not exist yet */ }
  }
  const insertRateLimit = db.prepare('INSERT OR IGNORE INTO provider_rate_limits (provider, is_free_tier, rpm_limit, rpd_limit, tpm_limit, tpd_limit, daily_reset_hour, daily_reset_tz, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertRateLimit.run('groq', 1, 30, 14400, 6000, 500000, 0, 'UTC', now);
  insertRateLimit.run('cerebras', 1, 30, 14400, 64000, 1000000, 0, 'UTC', now);
  insertRateLimit.run('google-ai', 1, 10, 250, 250000, null, 0, 'America/Los_Angeles', now);
  insertRateLimit.run('openrouter', 1, 20, 50, null, null, 0, 'UTC', now);
  insertRateLimit.run('ollama-cloud', 1, 10, 500, 100000, null, 0, 'UTC', now);
  insertConfig.run('ollama_host', 'http://localhost:11434');
  // Legacy: populated dynamically by discovery engine
  insertConfig.run('ollama_model', '');
  insertConfig.run('smart_routing_enabled', '1');
  insertConfig.run('smart_routing_default_provider', 'ollama');
  insertConfig.run('ollama_fallback_provider', 'codex');
  insertConfig.run('ollama_health_check_enabled', '1');
  insertConfig.run('ollama_temperature', '0.3');
  insertConfig.run('ollama_num_ctx', '8192');
  insertConfig.run('ollama_top_p', '0.9');
  insertConfig.run('ollama_top_k', '40');
  insertConfig.run('ollama_repeat_penalty', '1.0');
  insertConfig.run('ollama_num_predict', '-1');
  insertConfig.run('ollama_mirostat', '0');
  insertConfig.run('ollama_mirostat_tau', '5.0');
  insertConfig.run('ollama_mirostat_eta', '0.1');
  insertConfig.run('ollama_preset', 'code');
  insertConfig.run('ollama_presets', JSON.stringify({
      code: { temperature: 0.3, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, num_ctx: 8192, mirostat: 0 },
      precise: { temperature: 0.1, top_p: 0.8, top_k: 20, repeat_penalty: 1.2, num_ctx: 8192, mirostat: 0 },
      creative: { temperature: 0.8, top_p: 0.95, top_k: 60, repeat_penalty: 1.05, num_ctx: 4096, mirostat: 0 },
      balanced: { temperature: 0.5, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, num_ctx: 8192, mirostat: 2 },
      fast: { temperature: 0.3, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, num_ctx: 4096, mirostat: 0 }
    }));
  // Legacy fallback — superseded by model_family_templates
  insertConfig.run('ollama_model_settings', JSON.stringify({}));
  // Legacy fallback — superseded by model_family_templates
  insertConfig.run('ollama_model_prompts', JSON.stringify({}));
  insertConfig.run('ollama_num_gpu', '-1');
  insertConfig.run('ollama_num_thread', '0');
  insertConfig.run('ollama_keep_alive', '5m');
  insertConfig.run('ollama_auto_tuning_enabled', '1');
  insertConfig.run('ollama_auto_tuning_rules', JSON.stringify({
      code_generation: {
        patterns: [
          'write code', 'implement', 'create function', 'add method', 'generate',
          'add test', 'write test', 'unit test', 'create class', 'create file',
          'new file', 'add feature', 'build', 'scaffold', 'boilerplate',
          'add endpoint', 'create component', 'add handler', 'write function'
        ],
        tuning: { temperature: 0.2, top_k: 30, mirostat: 0 }
      },
      code_review: {
        patterns: [
          'review', 'check code', 'find bugs', 'analyze code', 'improve',
          'audit', 'inspect', 'evaluate', 'assess', 'quality check',
          'code smell', 'best practice', 'optimize'
        ],
        tuning: { temperature: 0.3, top_k: 40, mirostat: 0 }
      },
      refactoring: {
        patterns: [
          'refactor', 'rename', 'extract', 'consolidate', 'simplify',
          'clean up', 'reorganize', 'move', 'split', 'merge',
          'deduplicate', 'inline', 'encapsulate'
        ],
        tuning: { temperature: 0.2, top_k: 30, mirostat: 0 }
      },
      documentation: {
        patterns: [
          'document', 'readme', 'explain', 'describe', 'comment',
          'jsdoc', 'docstring', 'changelog', 'guide', 'tutorial',
          'summarize', 'annotate', 'type annotations'
        ],
        tuning: { temperature: 0.5, top_k: 50, mirostat: 0 }
      },
      creative: {
        patterns: [
          'creative', 'brainstorm', 'ideas', 'suggest', 'alternative',
          'design', 'propose', 'architect', 'prototype', 'explore options'
        ],
        tuning: { temperature: 0.7, top_k: 60, mirostat: 0 }
      },
      precise: {
        patterns: [
          'exact', 'specific', 'precise', 'deterministic', 'consistent',
          'format', 'lint', 'style', 'whitespace', 'indent',
          'config', 'json', 'yaml', 'env'
        ],
        tuning: { temperature: 0.1, top_k: 20, mirostat: 0 }
      },
      debugging: {
        patterns: [
          'debug', 'fix bug', 'error', 'issue', 'problem', 'not working',
          'broken', 'crash', 'exception', 'fail', 'undefined', 'null',
          'stack trace', 'regression', 'investigate', 'diagnose',
          'troubleshoot', 'why does', 'root cause'
        ],
        tuning: { temperature: 0.3, top_k: 40, mirostat: 2 }
      }
    }));
  insertConfig.run('stall_recovery_enabled', '1');
  insertConfig.run('stall_recovery_max_attempts', '3');
  insertConfig.run('max_local_retries', '3');
  const insertRule = db.prepare(`
      INSERT OR IGNORE INTO routing_rules (name, description, rule_type, pattern, target_provider, priority, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  insertRule.run('docs-readme', 'README and documentation files', 'keyword', 'readme|documentation|docs|changelog', 'ollama', 10, 1, now);
  insertRule.run('docs-comments', 'Code comments and docstrings', 'keyword', 'comment|docstring|jsdoc|tsdoc', 'ollama', 10, 1, now);
  insertRule.run('simple-test', 'Test writing (legacy — see integration-handlers test guard)', 'keyword', 'write test|add test|unit test|test case|test file|tests for|comprehensive test|test suite|spec file|write spec|add spec', 'codex', 15, 0, now);
  insertRule.run('commit-msg', 'Commit message generation', 'keyword', 'commit message|git commit', 'ollama', 10, 1, now);
  insertRule.run('explain-code', 'Code explanation tasks', 'keyword', 'explain|what does|how does|describe', 'ollama', 10, 1, now);
  insertRule.run('simple-refactor', 'Simple refactoring', 'keyword', 'rename|move|extract|inline', 'ollama', 20, 1, now);
  insertRule.run('config-edit', 'Config file edits', 'extension', '.json|.yaml|.yml|.toml|.ini|.env', 'ollama', 15, 1, now);
  insertRule.run('boilerplate', 'Boilerplate generation', 'keyword', 'boilerplate|scaffold|template|skeleton', 'codex', 20, 1, now);
  insertRule.run('multi-file', 'Multi-file refactoring', 'keyword', 'refactor multiple|across files|all files|entire codebase', 'claude-cli', 80, 1, now);
  insertRule.run('architecture', 'Architectural decisions', 'keyword', 'architecture|design pattern|restructure|redesign', 'claude-cli', 85, 1, now);
  insertRule.run('security', 'Security-sensitive code', 'keyword', 'security|auth|password|encrypt|credential|vulnerability|xss|injection', 'claude-cli', 90, 1, now);
  insertRule.run('complex-debug', 'Complex debugging', 'keyword', 'debug complex|investigate|root cause|deep dive', 'codex', 85, 1, now);
  insertRule.run('api-integration', 'API integrations', 'keyword', 'integrate api|api integration|external api|third-party', 'claude-cli', 75, 1, now);
  insertRule.run('production', 'Production deployments', 'keyword', 'production|deploy|release|publish', 'claude-cli', 90, 1, now);
  insertRule.run('lang-python', 'Python files (local-friendly)', 'extension', '.py', 'ollama', 30, 1, now);
  insertRule.run('lang-javascript', 'JavaScript/TypeScript files', 'extension', '.js|.ts|.jsx|.tsx', 'ollama', 30, 1, now);
  insertRule.run('lang-csharp', 'C# files (prefer cloud)', 'extension', '.cs', 'claude-cli', 50, 1, now);
  insertRule.run('lang-powershell', 'PowerShell files', 'extension', '.ps1|.psm1', 'ollama', 35, 1, now);
  insertRule.run('lang-gdscript', 'GDScript files', 'extension', '.gd', 'ollama', 40, 1, now);
  insertRule.run('xaml-generation', 'XAML file generation (complex markup)', 'extension', '.xaml|.axaml', 'claude-cli', 70, 1, now);
  insertRule.run('implement-service', 'Service/interface implementation', 'keyword', 'implement.*service|implement.*interface|create.*service', 'claude-cli', 75, 1, now);
  insertRule.run('create-view', 'View/component creation', 'keyword', 'create.*view|create.*component|build.*view|build.*component', 'claude-cli', 75, 1, now);
  insertRule.run('multi-method', 'Multi-method class generation', 'keyword', 'add.*methods|implement.*methods|create.*class.*with', 'claude-cli', 70, 1, now);
  insertRule.run('full-implementation', 'Full implementation requests', 'keyword', 'full implementation|complete implementation|implement all', 'claude-cli', 80, 1, now);
  const insertValidation = db.prepare(`
      INSERT OR IGNORE INTO validation_rules (id, name, description, rule_type, pattern, condition, severity, enabled, auto_fail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  insertValidation.run('val-stub-impl', 'stub-implementation', 'Detects stub implementations with TODO comments', 'pattern', '// implementation|// TODO|// FIXME|# TODO|# implementation|implementation goes here|throw new NotImplementedException|raise NotImplementedError|\\.{3}\\s*(rest of|remaining|same as|unchanged|code remains)', null, 'error', 1, 0, now);
  insertValidation.run('val-empty-body', 'empty-method-body', 'Detects methods with empty bodies', 'pattern', '(?<![:=,])\\s*\\{\\s*\\}', null, 'warning', 1, 0, now);
  insertValidation.run('val-filepath-content', 'filepath-as-content', 'Detects files containing only a file path', 'pattern', '^[a-zA-Z/\\\\:._-]+\\.(cs|xaml|ts|js|py)$', null, 'error', 1, 1, now);
  insertValidation.run('val-tiny-cs', 'tiny-csharp-file', 'C# files under 100 bytes are suspicious', 'size', null, 'extension:.cs AND size:<100', 'error', 1, 0, now);
  insertValidation.run('val-tiny-xaml', 'tiny-xaml-file', 'XAML files under 200 bytes are suspicious', 'size', null, 'extension:.xaml AND size:<200', 'error', 1, 0, now);
  insertValidation.run('val-empty-file', 'empty-file', 'Empty files (0 bytes)', 'size', null, 'size:0', 'error', 1, 1, now);
  insertValidation.run('val-truncation', 'file-truncation', 'File size decreased by more than 50%', 'delta', null, `size_decrease_percent:>${safeTruncationThreshold}`, 'error', 1, 0, now);
  safeAddColumn('approval_rules', 'description TEXT');
  safeAddColumn('approval_rules', 'auto_reject INTEGER DEFAULT 0');
  const insertApproval = db.prepare(`
      INSERT OR IGNORE INTO approval_rules (id, name, description, rule_type, condition, required_approvers, auto_reject, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  insertApproval.run('apr-large-shrink', 'large-file-shrink', 'File size decreased by more than 50%', 'condition', `size_decrease_percent > ${safeTruncationThreshold}`, 1, 0, 1, now);
  insertApproval.run('apr-tiny-new', 'tiny-new-file', 'New file is suspiciously small (<50 bytes)', 'condition', 'is_new AND size < 50', 1, 0, 1, now);
  insertApproval.run('apr-mass-delete', 'mass-line-deletion', 'More than 100 lines deleted', 'condition', 'lines_deleted > 100', 1, 0, 1, now);
  insertApproval.run('apr-validation-fail', 'validation-failure', 'Task failed output validation', 'condition', 'validation_failed', 1, 0, 1, now);
  safeAddColumn('failure_patterns', 'name TEXT');
  safeAddColumn('failure_patterns', 'description TEXT');
  safeAddColumn('failure_patterns', 'signature TEXT');
  safeAddColumn('failure_patterns', 'task_types TEXT');
  safeAddColumn('failure_patterns', 'provider TEXT');
  safeAddColumn('failure_patterns', 'occurrence_count INTEGER DEFAULT 1');
  safeAddColumn('failure_patterns', 'recommended_action TEXT');
  safeAddColumn('failure_patterns', 'auto_learned INTEGER DEFAULT 0');
  safeAddColumn('failure_patterns', 'enabled INTEGER DEFAULT 1');
  safeAddColumn('failure_patterns', 'updated_at TEXT');
  const insertFailurePattern = db.prepare(`
      INSERT OR IGNORE INTO failure_patterns (id, name, description, pattern_type, pattern_definition, signature, task_types, provider, occurrence_count, recommended_action, auto_learned, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  insertFailurePattern.run('fp-stub-methods', 'Stub Methods', 'Methods with // implementation goes here', 'output', '// implementation|implementation goes here', '// implementation|implementation goes here', 'code_generation', 'ollama', 5, 'retry_with_cloud', 0, 1, now);
  insertFailurePattern.run('fp-filepath-content', 'File Path as Content', 'File contains only its own path', 'output', '^[a-zA-Z/\\\\:._-]+\\.(cs|xaml|ts|js)$', '^[a-zA-Z/\\\\:._-]+\\.(cs|xaml|ts|js)$', 'code_generation', 'ollama', 3, 'retry_with_cloud', 0, 1, now);
  insertFailurePattern.run('fp-empty-output', 'Empty Output', 'Task completed but file is empty', 'output', '^$', '^$', 'code_generation', 'ollama', 2, 'retry_with_cloud', 0, 1, now);
  insertFailurePattern.run('fp-duplicate-class', 'Duplicate Class Definition', 'Same class defined multiple times', 'output', 'class\\s+(\\w+).*class\\s+\\1', 'class\\s+(\\w+).*class\\s+\\1', 'code_generation', 'ollama', 1, 'retry_with_cloud', 0, 1, now);
  insertFailurePattern.run('fp-truncated', 'Truncated Output', 'Output truncated mid-sentence or mid-code', 'output', '[^.;\\}\\)]\\s*$', '[^.;\\}\\)]\\s*$', 'code_generation', 'ollama', 2, 'retry_with_cloud', 0, 1, now);
  const insertRetryRule = db.prepare(`
      INSERT OR IGNORE INTO retry_rules (id, name, description, trigger_type, trigger_condition, action, fallback_provider, max_retries, retry_delay_seconds, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  insertRetryRule.run('retry-stub', 'Retry on Stub Detection', 'Retry with cloud when stub implementation detected', 'pattern', '// implementation|// TODO.*implement|implementation goes here', 'retry_with_cloud', 'claude-cli', 1, 0, 1, now);
  insertRetryRule.run('retry-empty', 'Retry on Empty Output', 'Retry with cloud when output is empty', 'condition', 'output_empty OR file_size < 10', 'retry_with_cloud', 'claude-cli', 1, 0, 1, now);
  insertRetryRule.run('retry-truncation', 'Retry on Truncation', 'Retry with cloud when file was truncated', 'condition', `size_decrease_percent > ${safeTruncationThreshold}`, 'retry_with_cloud', 'claude-cli', 1, 0, 1, now);
  insertRetryRule.run('retry-validation-fail', 'Retry on Validation Failure', 'Retry with cloud when validation fails with severity=error', 'condition', 'validation_failed AND validation_severity = error', 'retry_with_cloud', 'claude-cli', 1, 0, 1, now);
  const insertSyntaxValidator = db.prepare(`
      INSERT OR IGNORE INTO syntax_validators (id, name, file_extensions, command, args, success_exit_codes, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  insertSyntaxValidator.run('syntax-csharp', 'C# Syntax Check', '.cs', 'dotnet', 'build --no-restore --verbosity quiet', '0', 1, now);
  insertSyntaxValidator.run('syntax-typescript', 'TypeScript Syntax Check', '.ts,.tsx', 'npx', 'tsc --noEmit', '0', 1, now);
  insertSyntaxValidator.run('syntax-javascript', 'JavaScript Syntax Check', '.js,.jsx', 'node', '--check', '0', 1, now);
  insertSyntaxValidator.run('syntax-python', 'Python Syntax Check', '.py', 'python', '-m py_compile', '0', 1, now);
  insertSyntaxValidator.run('syntax-json', 'JSON Syntax Check', '.json', 'node', '-e "JSON.parse(require(\'fs\').readFileSync(process.argv[1]))"', '0', 1, now);
  insertSyntaxValidator.run('syntax-xaml', 'XAML/XML Syntax Check', '.xaml,.xml,.axaml', 'xmllint', '--noout', '0', 1, now);
  setConfigDefault('build_command_dotnet', 'dotnet build --no-restore');
  setConfigDefault('build_command_npm', 'npm run build');
  setConfigDefault('build_command_yarn', 'yarn build');
  setConfigDefault('build_command_cargo', 'cargo build');
  setConfigDefault('build_command_go', 'go build ./...');
  setConfigDefault('build_command_maven', 'mvn compile -q');
  setConfigDefault('build_command_gradle', 'gradle build -q');
  setConfigDefault('codex_enabled', '1');
  setConfigDefault('codex_spark_enabled', '1');
  setConfigDefault('continuous_batch_enabled', '0');
  setConfigDefault('auto_compute_max_concurrent', '1');
  setConfigDefault('max_per_host', '4');
  // Migration: upgrade existing installations from the old default of 1.
  // The original seed was '1' which capped all hosts to 1 concurrent task
  // regardless of their individual max_concurrent setting. This runs during
  // init() before the config cache is populated, so direct UPDATE is safe.
  try {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get('max_per_host');
    if (row && row.value === '1') {
      db.prepare('UPDATE config SET value = ? WHERE key = ?').run('4', 'max_per_host');
      if (logger) logger.info('[Schema Seeds] Migrated max_per_host from 1 to 4');
    }
  } catch { /* ignore — config table might not exist yet on fresh install */ }
  setConfigDefault('max_codex_concurrent', '6');
  setConfigDefault('max_concurrent_workflows', '10');
  setConfigDefault('workflow_retention_days', '30');
  setConfigDefault('auto_archive_days', '30');
  setConfigDefault('auto_archive_status', 'completed,failed,cancelled');
  setConfigDefault('cleanup_log_days', '30');
  setConfigDefault('cleanup_stream_days', '7');
  setConfigDefault('file_baseline_enabled', '1');
  setConfigDefault('syntax_validation_enabled', '1');
  setConfigDefault('diff_preview_required', '0');
  setConfigDefault('quality_scoring_enabled', '1');
  setConfigDefault('provider_stats_enabled', '1');
  setConfigDefault('build_check_enabled', '0');
  setConfigDefault('rate_limiting_enabled', '1');
  setConfigDefault('v2_auth_mode', 'permissive');
  setConfigDefault('v2_rate_policy', 'enforced');
  setConfigDefault('v2_rate_limit', '120');
  setConfigDefault('cost_tracking_enabled', '1');
  setConfigDefault('duplicate_detection_enabled', '1');
  setConfigDefault('file_locking_enabled', '1');
  setConfigDefault('backup_before_modify_enabled', '0');
  setConfigDefault('security_scanning_enabled', '1');
  setConfigDefault('test_coverage_check_enabled', '0');
  setConfigDefault('style_enforcement_enabled', '0');
  setConfigDefault('impact_analysis_enabled', '0');
  setConfigDefault('timeout_alerts_enabled', '1');
  setConfigDefault('output_limits_enabled', '1');
  setConfigDefault('audit_trail_enabled', '1');
  setConfigDefault('task_output_retention_days', '30');
  safeAddColumn('rate_limits', 'provider TEXT');
  safeAddColumn('rate_limits', 'enabled INTEGER DEFAULT 1');
  const insertWindowRateLimit = db.prepare(`
      INSERT OR IGNORE INTO rate_limits (id, provider, limit_type, max_value, window_seconds, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  insertWindowRateLimit.run('rl-ollama-rpm', 'ollama', 'requests', 10, 60, 1, now);
  insertWindowRateLimit.run('rl-ollama-concurrent', 'ollama', 'concurrent', 4, 0, 1, now);
  insertWindowRateLimit.run('rl-claude-rpm', 'claude-cli', 'requests', 50, 60, 1, now);
  insertWindowRateLimit.run('rl-claude-concurrent', 'claude-cli', 'concurrent', 5, 0, 1, now);
  const insertBudget = db.prepare(`
      INSERT OR IGNORE INTO cost_budgets (id, name, provider, budget_usd, period, alert_threshold_percent, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  insertBudget.run('budget-claude-monthly', 'Claude Monthly Budget', 'claude-cli', 200.0, 'monthly', 80, 1, now);
  insertBudget.run('budget-total-monthly', 'Total Monthly Budget', null, 400.0, 'monthly', 80, 1, now);
  const insertSecurityRule = db.prepare(`
      INSERT OR IGNORE INTO security_rules (id, name, description, pattern, file_extensions, severity, category, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  insertSecurityRule.run('sec-sql-concat', 'SQL String Concatenation', 'Direct SQL string building', 'SELECT.*\\+.*\\"|UPDATE.*\\+.*\\"|DELETE.*\\+.*\\"', '.cs,.java,.py,.js,.ts', 'critical', 'injection', 1, now);
  insertSecurityRule.run('sec-sql-format', 'SQL String Format', 'SQL with string formatting', 'String\\.Format\\(.*SELECT|f".*SELECT|f\'.*SELECT', '.cs,.py', 'critical', 'injection', 1, now);
  insertSecurityRule.run('sec-innerhtml', 'innerHTML Assignment', 'Direct innerHTML assignment', 'innerHTML\\s*=', '.js,.ts,.jsx,.tsx', 'warning', 'xss', 1, now);
  insertSecurityRule.run('sec-react-dangerous', 'React Dangerous HTML', 'React dangerous HTML pattern', 'dangerously.*HTML', '.jsx,.tsx', 'warning', 'xss', 1, now);
  insertSecurityRule.run('sec-hardcoded-password', 'Hardcoded Password', 'Password in code', 'password\\s*=\\s*["\'][^"\']+["\']', '.cs,.java,.py,.js,.ts', 'critical', 'secrets', 1, now);
  insertSecurityRule.run('sec-hardcoded-apikey', 'Hardcoded API Key', 'API key in code', 'api[_-]?key\\s*=\\s*["\'][^"\']+["\']', '.cs,.java,.py,.js,.ts', 'critical', 'secrets', 1, now);
  insertSecurityRule.run('sec-hardcoded-secret', 'Hardcoded Secret', 'Secret in code', 'secret\\s*=\\s*["\'][^"\']+["\']', '.cs,.java,.py,.js,.ts', 'critical', 'secrets', 1, now);
  insertSecurityRule.run('sec-cmd-injection', 'Command Injection Risk', 'Shell command with variables', 'exec\\(|system\\(|shell_exec\\(|Process\\.Start\\(', '.cs,.java,.py,.php', 'warning', 'injection', 1, now);
  insertSecurityRule.run('sec-path-traversal', 'Path Traversal', 'Unsanitized path input', '\\.\\./|\\.\\.\\\\', '.cs,.java,.py,.js,.ts', 'warning', 'path', 1, now);
  const insertLinter = db.prepare(`
      INSERT OR IGNORE INTO linter_configs (id, name, file_extensions, command, args, fix_args, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  insertLinter.run('lint-eslint', 'ESLint', '.js,.jsx,.ts,.tsx', 'npx', 'eslint', 'eslint --fix', 1, now);
  insertLinter.run('lint-prettier', 'Prettier', '.js,.jsx,.ts,.tsx,.json,.css,.md', 'npx', 'prettier --check', 'prettier --write', 1, now);
  insertLinter.run('lint-dotnet', '.NET Format', '.cs', 'dotnet', 'format --verify-no-changes', 'format', 1, now);
  insertLinter.run('lint-pylint', 'Pylint', '.py', 'pylint', '', null, 1, now);
  insertLinter.run('lint-black', 'Black', '.py', 'black', '--check', '', 1, now);
  const insertOutputLimit = db.prepare(`
      INSERT OR IGNORE INTO output_limits (id, provider, task_type, max_output_bytes, max_file_size_bytes, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  insertOutputLimit.run('limit-default', null, null, 1048576, 524288, 1, now);
  insertOutputLimit.run('limit-ollama', 'ollama', null, 524288, 262144, 1, now);
  const existingComplexityRules = db.prepare('SELECT COUNT(*) as count FROM complexity_routing').get();
  if (existingComplexityRules.count === 0) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO complexity_routing (name, complexity, target_provider, target_host, model, priority, enabled, created_at) VALUES
        ('Complex tasks to Codex', 'complex', 'codex', NULL, NULL, 1, 1, ?),
        ('Normal tasks to Ollama', 'normal', 'ollama', NULL, NULL, 2, 1, ?),
        ('Simple tasks to Ollama', 'simple', 'ollama', NULL, NULL, 3, 1, ?)
      `).run(now, now, now);
    }
  try {
      const seedStmt = db.prepare(`INSERT OR IGNORE INTO model_capabilities
        (model_name, score_code_gen, score_refactoring, score_testing, score_reasoning, score_docs,
         lang_typescript, lang_javascript, lang_python, lang_csharp, lang_go, lang_rust, lang_general,
         context_window, param_size_b, is_thinking_model, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'benchmark')`);
  
      const seeds = [];
  
      for (const row of seeds) {
        seedStmt.run(...row);
      }
    } catch (e) { logger.debug(`Schema migration (model capabilities seed): ${e.message}`); }

  // Agentic tool-calling pipeline defaults
  setConfigDefault('agentic_enabled', '1');
  setConfigDefault('agentic_max_iterations', '15');
  setConfigDefault('agentic_command_mode', 'unrestricted');
  setConfigDefault('agentic_git_safety', 'on');

  // Workstation defaults
  setConfigDefault('workstation_health_check_interval_seconds', '30');
  setConfigDefault('workstation_agent_port', '3460');
  setConfigDefault('workstation_cert_warning_days', '30');
  setConfigDefault('vram_overhead_factor', '0.95');

  // Seed routing template presets
  try {
    const templateStore = require('../routing/template-store');
    templateStore.setDb(db);
    templateStore.ensureTable();
    templateStore.seedPresets();
  } catch (e) {
    logger.debug(`Schema seed (routing templates): ${e.message}`);
  }

  // Seed default model roles if none exist for ollama
  try {
    const modelRoles = require('./model-roles');
    modelRoles.setDb(db);
    const existingRoles = modelRoles.listModelRoles('ollama');
    if (existingRoles.length === 0) {
      const defaultModel = (extras.getConfig && extras.getConfig('ollama_model')) || '';
      modelRoles.setModelRole('ollama', 'default', defaultModel);
      modelRoles.setModelRole('ollama', 'fallback', defaultModel);
    }
  } catch (e) {
    logger.debug(`Schema seed (model roles): ${e.message}`);
  }

  // Seed model family templates (system prompts + tuning per model family)
  try {
    seedFamilyTemplates(db);
  } catch (e) { logger.debug('family templates seed: ' + e.message); }
}

/**
 * Seed default prompt templates and tuning overrides for known model families.
 * Uses INSERT OR IGNORE so existing customisations are preserved.
 *
 * @param {import('better-sqlite3').Database} db
 */
function seedFamilyTemplates(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO model_family_templates
      (family, system_prompt, tuning_json, size_overrides)
    VALUES (?, ?, ?, ?)
  `);

  const families = [
    {
      // Qwen3-Coder: vendor-recommended temp 0.7, top_k 20, repeat_penalty 1.05
      // Source: HuggingFace Qwen/Qwen3-Coder-30B-A3B-Instruct generation_config
      family: 'qwen3',
      systemPrompt: 'You are Qwen3, a highly capable code generation model. Write clean, idiomatic code. Make only the changes requested. Preserve existing style and conventions.',
      tuning: { temperature: 0.7, num_ctx: 8192, top_k: 20, repeat_penalty: 1.05 },
      sizeOverrides: { small: { num_ctx: 4096, top_k: 20 }, large: { num_ctx: 16384, top_k: 20 } },
    },
    {
      // Qwen2.5-Coder: vendor default temp 0.7, top_p 0.9
      family: 'qwen2.5',
      systemPrompt: 'You are Qwen2.5 Coder, an expert code generation model. Write idiomatic, language-specific code. Follow established project conventions exactly. Minimal changes — only modify what is requested.',
      tuning: { temperature: 0.7, num_ctx: 8192, top_k: 30, repeat_penalty: 1.0 },
      sizeOverrides: { small: { num_ctx: 4096 }, large: { num_ctx: 16384, top_k: 25 } },
    },
    {
      // Llama 3.1: vendor-recommended temp 0.2-0.3, top_k 10 for code
      // Source: llama.com/docs/how-to-guides/prompting
      family: 'llama',
      systemPrompt: 'You are Llama, a versatile code assistant. Write clean, efficient code. Follow project conventions and existing patterns. Keep implementations direct and minimal.',
      tuning: { temperature: 0.3, num_ctx: 8192, top_k: 10, repeat_penalty: 1.0 },
      sizeOverrides: { small: { num_ctx: 4096 }, large: { num_ctx: 16384 } },
    },
    {
      family: 'gemma',
      systemPrompt: 'You are Gemma, a fast and efficient code assistant. Make only the specific changes requested. Keep edits small and targeted. Follow existing code patterns and style exactly.',
      tuning: { temperature: 0.3, num_ctx: 4096, top_k: 40, repeat_penalty: 1.0 },
      sizeOverrides: { large: { num_ctx: 8192 } },
    },
    {
      // DeepSeek-R1: vendor-recommended temp 0.6, top_p 0.95
      // Source: api-docs.deepseek.com/guides/reasoning_model
      family: 'deepseek',
      systemPrompt: 'You are DeepSeek Coder, specialized in code generation. Write production-quality code. Follow established patterns and conventions. Handle edge cases appropriately.',
      tuning: { temperature: 0.6, num_ctx: 8192, top_k: 30, repeat_penalty: 1.0 },
      sizeOverrides: { small: { num_ctx: 4096 }, large: { num_ctx: 16384 } },
    },
    {
      family: 'codestral',
      systemPrompt: 'You are Codestral, a specialized code generation model. Write clean, efficient implementations. Follow project conventions and existing patterns. Minimal changes — only modify what is requested.',
      tuning: { temperature: 0.2, num_ctx: 8192, top_k: 30, repeat_penalty: 1.0 },
      sizeOverrides: { large: { num_ctx: 16384 } },
    },
    {
      family: 'mistral',
      systemPrompt: 'You are Mistral, a capable code assistant. Write clear, well-structured code. Follow project conventions. Provide complete, working implementations.',
      tuning: { temperature: 0.3, num_ctx: 8192, top_k: 40, repeat_penalty: 1.0 },
      sizeOverrides: { small: { num_ctx: 4096 } },
    },
    {
      family: 'phi',
      systemPrompt: 'You are Phi, a compact and efficient code model. Write focused, minimal code. Make only the requested changes. Prefer simple, direct implementations.',
      tuning: { temperature: 0.3, num_ctx: 4096, top_k: 40, repeat_penalty: 1.0 },
      sizeOverrides: null,
    },
    {
      family: 'unknown',
      systemPrompt: 'You are a highly capable, code-focused AI assistant. Write clean, correct, idiomatic code. Make only the changes requested. Follow the existing code conventions, style, and architecture. Keep implementations minimal and direct.',
      tuning: { temperature: 0.2, num_ctx: 8192, top_k: 30, repeat_penalty: 1.0 },
      sizeOverrides: null,
    },
  ];

  for (const { family, systemPrompt, tuning, sizeOverrides } of families) {
    insert.run(
      family,
      systemPrompt,
      JSON.stringify(tuning),
      sizeOverrides != null ? JSON.stringify(sizeOverrides) : null
    );
  }
}

module.exports = { seedDefaults, seedFamilyTemplates };
