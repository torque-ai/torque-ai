'use strict';

function runMigrations(db, logger, safeAddColumn, extras = {}) {
  const { getConfig, setConfig } = extras;
  safeAddColumn('tasks', 'git_before_sha TEXT');
  safeAddColumn('tasks', 'git_after_sha TEXT');
  safeAddColumn('tasks', 'git_stash_ref TEXT');
  safeAddColumn('tasks', 'tags TEXT');
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks(tags)`);
  } catch (e) {
    logger.debug(`Schema migration (tags index): ${e.message}`);
  }
  safeAddColumn('pipeline_steps', 'parallel_group TEXT');
  safeAddColumn('tasks', 'project TEXT');
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project)`);
  } catch (e) {
    logger.debug(`Schema migration (tasks project index): ${e.message}`);
  }
  safeAddColumn('scheduled_tasks', 'project TEXT');
  safeAddColumn('scheduled_tasks', 'task_config TEXT');
  safeAddColumn('scheduled_tasks', 'updated_at TEXT');
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_project ON scheduled_tasks(project)`);
  } catch (e) {
    logger.debug(`Schema migration (scheduled tasks project index): ${e.message}`);
  }
  safeAddColumn('tasks', 'mcp_instance_id TEXT');
  safeAddColumn('pipelines', 'project TEXT');
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pipelines_project ON pipelines(project)`);
  } catch (e) {
    logger.debug(`Schema migration (pipelines project index): ${e.message}`);
  }
  safeAddColumn('token_usage', 'project TEXT');
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_token_project ON token_usage(project)`);
  } catch (e) {
    logger.debug(`Schema migration (token usage project index): ${e.message}`);
  }
  safeAddColumn('tasks', "retry_strategy TEXT DEFAULT 'exponential'");
  safeAddColumn('tasks', 'retry_delay_seconds INTEGER DEFAULT 30');
  safeAddColumn('tasks', 'last_retry_at TEXT');
  safeAddColumn('tasks', 'group_id TEXT');
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id)`);
  } catch (e) {
    logger.debug(`Schema migration (tasks group index): ${e.message}`);
  }
  safeAddColumn('templates', 'variables TEXT');
  safeAddColumn('templates', 'variable_defaults TEXT');
  safeAddColumn('tasks', 'paused_at TEXT');
  safeAddColumn('tasks', 'pause_reason TEXT');
  safeAddColumn('tasks', 'ollama_host_id TEXT');
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_ollama_host_id ON tasks(ollama_host_id)`);
  } catch (e) {
    logger.debug(`Schema migration (tasks ollama_host_id index): ${e.message}`);
  }
  safeAddColumn('tasks', "approval_status TEXT DEFAULT 'not_required'");
  try {
      db.exec(`ALTER TABLE tasks ADD COLUMN workflow_id TEXT`);
    } catch (_e) {
      void _e;
      // Column already exists
    }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id)`);
  } catch (e) {
    logger.debug(`Schema migration (tasks workflow index): ${e.message}`);
  }
  try {
      db.exec(`ALTER TABLE tasks ADD COLUMN stall_timeout_seconds INTEGER`);
    } catch (_e) {
      void _e;
      // Column already exists
    }
  try {
      db.exec(`ALTER TABLE tasks ADD COLUMN workflow_node_id TEXT`);
    } catch (_e) {
      void _e;
      // Column already exists
    }
  try {
      db.exec(`ALTER TABLE workflows ADD COLUMN working_directory TEXT`);
    } catch (_e) {
      void _e;
      // Column already exists
    }
  safeAddColumn('workflows', 'priority INTEGER DEFAULT 0');
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_priority ON workflows(priority)`);
  } catch (e) {
    logger.debug(`Schema migration (workflows priority index): ${e.message}`);
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_status_priority ON workflows(status, priority DESC)`);
  } catch (e) {
    logger.debug(`Schema migration (workflows status+priority index): ${e.message}`);
  }
  try {
      db.exec(`ALTER TABLE retry_history ADD COLUMN strategy_used TEXT`);
    } catch (_e) {
      void _e;
      // Column already exists
    }
  try {
      db.exec(`ALTER TABLE retry_history ADD COLUMN adaptation_applied TEXT`);
    } catch (_e) {
      void _e;
      // Column already exists
    }
  try {
      db.exec(`ALTER TABLE tasks ADD COLUMN claimed_by_agent TEXT`);
    } catch (_e) {
      void _e;
      // Column already exists
    }
  try {
      db.exec(`ALTER TABLE tasks ADD COLUMN required_capabilities TEXT`);
    } catch (_e) {
      void _e;
      // Column already exists
    }
  safeAddColumn('failure_patterns', 'name TEXT');
  safeAddColumn('failure_patterns', 'description TEXT');
  safeAddColumn('failure_patterns', 'signature TEXT');
  safeAddColumn('failure_patterns', 'task_types TEXT');
  safeAddColumn('failure_patterns', 'provider TEXT');
  safeAddColumn('failure_patterns', 'occurrence_count INTEGER DEFAULT 1');
  safeAddColumn('failure_patterns', 'last_seen_at TEXT');
  safeAddColumn('failure_patterns', 'recommended_action TEXT');
  safeAddColumn('failure_patterns', 'auto_learned INTEGER DEFAULT 0');
  safeAddColumn('failure_patterns', 'enabled INTEGER DEFAULT 1');
  safeAddColumn('failure_patterns', 'updated_at TEXT');
  safeAddColumn('rate_limits', 'provider TEXT');
  safeAddColumn('rate_limits', 'enabled INTEGER DEFAULT 1');
  safeAddColumn('quality_scores', 'provider TEXT');
  safeAddColumn('provider_task_stats', 'provider TEXT');
  safeAddColumn('approval_rules', 'description TEXT');
  safeAddColumn('approval_rules', 'auto_reject INTEGER DEFAULT 0');
  safeAddColumn('project_config', 'build_verification_enabled INTEGER DEFAULT 0');
  safeAddColumn('project_config', 'build_command TEXT');
  safeAddColumn('project_config', 'build_timeout INTEGER DEFAULT 120');
  safeAddColumn('project_config', 'rollback_on_build_failure INTEGER DEFAULT 1');
  safeAddColumn('project_config', 'llm_safeguards_enabled INTEGER DEFAULT 1');
  safeAddColumn('project_config', 'test_verification_enabled INTEGER DEFAULT 0');
  safeAddColumn('project_config', 'test_command TEXT');
  safeAddColumn('project_config', 'test_timeout INTEGER DEFAULT 300');
  safeAddColumn('project_config', 'rollback_on_test_failure INTEGER DEFAULT 0');
  safeAddColumn('project_config', 'style_check_enabled INTEGER DEFAULT 0');
  safeAddColumn('project_config', 'style_check_command TEXT');
  safeAddColumn('project_config', 'style_check_timeout INTEGER DEFAULT 60');
  safeAddColumn('project_config', 'auto_pr_enabled INTEGER DEFAULT 0');
  safeAddColumn('project_config', 'auto_pr_base_branch TEXT DEFAULT "main"');
  safeAddColumn('project_config', 'default_provider TEXT');
  safeAddColumn('project_config', 'default_model TEXT');
  safeAddColumn('project_config', 'verify_command TEXT');
  safeAddColumn('project_config', 'auto_fix_enabled INTEGER DEFAULT 0');
  safeAddColumn('project_config', 'test_pattern TEXT');
  safeAddColumn('project_config', 'auto_verify_on_completion INTEGER');
  safeAddColumn('project_config', 'remote_agent_id TEXT');
  safeAddColumn('project_config', 'remote_project_path TEXT');
  safeAddColumn('project_config', 'prefer_remote_tests INTEGER DEFAULT 0');
  safeAddColumn('provider_config', "transport TEXT DEFAULT 'api'");
  safeAddColumn('provider_usage', 'elapsed_ms INTEGER');
  safeAddColumn('provider_usage', 'retry_count INTEGER');
  safeAddColumn('provider_usage', 'transport TEXT');
  safeAddColumn('provider_usage', 'failure_reason TEXT');
  db.exec(`
      UPDATE provider_config
      SET transport = 'api'
      WHERE transport IS NULL
        OR TRIM(transport) = ''
        OR transport NOT IN ('api', 'cli', 'hybrid')
    `);
  const updateQuotaPatterns = db.prepare(`
      UPDATE provider_config SET quota_error_patterns = ?
      WHERE provider = 'claude-cli' AND (quota_error_patterns IS NULL OR quota_error_patterns = '[]')
    `);
  updateQuotaPatterns.run(JSON.stringify([
      'hit your limit', 'rate limit', 'resets', '429', 'quota exceeded', 'too many requests'
    ]));
  if (getConfig('ollama_fallback_provider') === 'claude-cli') {
      setConfig('ollama_fallback_provider', 'codex');
    }
  try {
      const formatsCfg = getConfig('aider_model_edit_formats');
      if (formatsCfg) {
        const formats = JSON.parse(formatsCfg);
        if (formats['deepseek-coder-v2:16b'] !== 'whole') {
          formats['deepseek-coder-v2:16b'] = 'whole';
          setConfig('aider_model_edit_formats', JSON.stringify(formats));
        }
      }
    } catch (e) { logger.debug(`Schema migration (deepseek-coder-v2 edit format): ${e.message}`); }
  try {
      const formatsCfg = getConfig('aider_model_edit_formats');
      if (formatsCfg) {
        const formats = JSON.parse(formatsCfg);
        let changed = false;
        if (formats['llama3:latest'] !== 'whole') { formats['llama3:latest'] = 'whole'; changed = true; }
        if (!formats['llama3:8b']) { formats['llama3:8b'] = 'whole'; changed = true; }
        if (changed) setConfig('aider_model_edit_formats', JSON.stringify(formats));
      }
    } catch (e) { logger.debug(`Schema migration (llama3 edit format): ${e.message}`); }
  try {
      db.prepare(`
        UPDATE validation_rules SET pattern = '// implementation|// TODO|// FIXME|# TODO|# implementation|implementation goes here|throw new NotImplementedException|raise NotImplementedError|\\.{3}\\s*(rest of|remaining|same as|unchanged|code remains)'
        WHERE id = 'val-stub-impl'
      `).run();
    } catch (e) { logger.debug(`Schema migration (val-stub-impl): ${e.message}`); }
  try {
      db.prepare(`
        UPDATE validation_rules SET pattern = '(?<![:=,])\\s*\\{\\s*\\}'
        WHERE id = 'val-empty-body'
      `).run();
    } catch (e) { logger.debug(`Schema migration (val-empty-body): ${e.message}`); }
  safeAddColumn('rate_limits', 'provider TEXT');
  safeAddColumn('rate_limits', 'enabled INTEGER DEFAULT 1');
  safeAddColumn('tasks', 'provider TEXT DEFAULT \'codex\'');
  safeAddColumn('tasks', 'original_provider TEXT');
  safeAddColumn('tasks', 'provider_switched_at TEXT');
  safeAddColumn('tasks', 'model TEXT');
  safeAddColumn('ollama_hosts', 'memory_limit_mb INTEGER');
  safeAddColumn('ollama_hosts', 'priority INTEGER DEFAULT 10');
  safeAddColumn('ollama_hosts', 'max_concurrent INTEGER DEFAULT 1');
  safeAddColumn('ollama_hosts', 'settings TEXT');
  safeAddColumn('ollama_hosts', 'gpu_metrics_port INTEGER');
  try {
      const hasHolderId = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('distributed_locks') WHERE name='holder_id'").get();
      if (hasHolderId.cnt === 0) {
        db.exec('DROP TABLE IF EXISTS distributed_locks');
        db.exec(`
          CREATE TABLE distributed_locks (
            lock_name TEXT PRIMARY KEY,
            holder_id TEXT NOT NULL,
            acquired_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            holder_info TEXT,
            last_heartbeat TEXT
          )
        `);
      }
    } catch (e) {
      logger.debug(`Schema migration (distributed_locks): ${e.message}`);
    }
  safeAddColumn('distributed_locks', 'last_heartbeat TEXT');
  safeAddColumn('tasks', 'complexity TEXT DEFAULT "normal"');
  safeAddColumn('tasks', 'review_status TEXT');
  safeAddColumn('tasks', 'review_notes TEXT');
  safeAddColumn('tasks', 'reviewed_at TEXT');
  safeAddColumn('tasks', 'metadata TEXT');
  try {
      db.exec(`
        UPDATE complexity_routing SET model = NULL, target_host = NULL
          WHERE complexity IN ('simple', 'normal');
        UPDATE complexity_routing SET target_provider = 'aider-ollama', model = NULL, target_host = NULL
          WHERE complexity = 'complex';
      `);
    } catch (e) {
      logger.debug(`Schema migration (complexity routing): ${e.message}`);
    }
  try {
      if (!getConfig('ollama_fast_model_fallback')) setConfig('ollama_fast_model_fallback', 'codestral:22b');
      if (!getConfig('ollama_balanced_model_fallback')) setConfig('ollama_balanced_model_fallback', 'codestral:22b');
    } catch (e) { logger.debug(`Schema migration (fallback models): ${e.message}`); }
  try {
      const currentFast = getConfig('ollama_fast_model');
      if (!currentFast || currentFast === 'qwen2.5-coder:7b' || currentFast === 'gemma3:4b') {
        setConfig('ollama_fast_model', 'codestral:22b');
      }
    } catch (e) { logger.debug(`Schema migration (fast tier): ${e.message}`); }
  try {
      if (getConfig('ollama_balanced_model') === 'deepseek-r1:14b') {
        setConfig('ollama_balanced_model', 'codestral:22b');
      }
    } catch (e) { logger.debug(`Schema migration (balanced tier P75): ${e.message}`); }
  try {
      if (getConfig('ollama_balanced_model') === 'deepseek-coder-v2:16b') {
        setConfig('ollama_balanced_model', 'codestral:22b');
      }
    } catch (e) { logger.debug(`Schema migration (balanced tier R97): ${e.message}`); }
  try {
      if (getConfig('ollama_balanced_model') === 'codestral:22b') {
        setConfig('ollama_balanced_model', 'qwen3:8b');
      }
    } catch (e) { logger.debug(`Schema migration (balanced tier R113): ${e.message}`); }
  try {
      const existingSettings = JSON.parse(getConfig('ollama_model_settings') || '{}');
      let updated = false;
    
      // Only update if qwen2.5-coder:32b doesn't have 16K context yet
      if (!existingSettings['qwen2.5-coder:32b'] || existingSettings['qwen2.5-coder:32b'].num_ctx !== 16384) {
        existingSettings['qwen2.5-coder:32b'] = {
          temperature: 0.2, top_k: 30, num_ctx: 16384, repeat_penalty: 1.15,
          description: 'Quality tier — complex tasks, multi-requirement code gen'
        };
        updated = true;
      }
      if (!existingSettings['codestral:22b'] || existingSettings['codestral:22b'].temperature !== 0.2) {
        existingSettings['codestral:22b'] = {
          temperature: 0.2, top_k: 30, num_ctx: 8192, repeat_penalty: 1.1,
          description: 'Fast tier — simple/medium tasks, speed over completeness'
        };
        updated = true;
      }
      if (!existingSettings['gemma3:4b']) {
        existingSettings['gemma3:4b'] = {
          temperature: 0.3, top_k: 40, num_ctx: 4096, repeat_penalty: 1.1,
          description: 'Lightweight — simple utilities, fast generation'
        };
        updated = true;
      }
    
      if (updated) {
        setConfig('ollama_model_settings', JSON.stringify(existingSettings));
      }
    } catch (e) { logger.debug(`Schema migration (model settings R115): ${e.message}`); }
  safeAddColumn('remote_agents', 'tls INTEGER DEFAULT 0');
  safeAddColumn('remote_agents', 'rejectUnauthorized INTEGER DEFAULT 1');

  // peek_hosts table for multi-host peek_ui registry
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS peek_hosts (
        name TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        ssh TEXT,
        is_default INTEGER DEFAULT 0,
        platform TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    logger.debug(`Schema migration (peek_hosts): ${e.message}`);
  }

  safeAddColumn('peek_hosts', 'enabled INTEGER DEFAULT 1');
  safeAddColumn('tasks', 'archived INTEGER DEFAULT 0');

  // host_credentials table for encrypted credential storage
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS host_credentials (
        id TEXT PRIMARY KEY,
        host_name TEXT NOT NULL,
        host_type TEXT NOT NULL CHECK(host_type IN ('ollama', 'peek')),
        credential_type TEXT NOT NULL CHECK(credential_type IN ('ssh', 'http_auth', 'windows')),
        label TEXT,
        encrypted_value TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_host_credentials_unique
      ON host_credentials (host_name, host_type, credential_type)
    `);
  } catch (e) {
    logger.debug(`Schema migration (host_credentials): ${e.message}`);
  }

  // R-hashline: Consolidate to best models only, route simple/normal to hashline-ollama
  try {
    try {
      db.prepare('ALTER TABLE model_task_outcomes ADD COLUMN failure_category TEXT').run();
    } catch (_e) {
      void _e;
      // Column already exists
    }
    // Update complexity routing to use hashline-ollama with best model
    const updateRouting = db.prepare(`
      UPDATE complexity_routing
      SET target_provider = ?, model = ?, target_host = NULL, name = ?
      WHERE complexity = ?
    `);
    updateRouting.run('hashline-ollama', 'qwen2.5-coder:32b', 'Normal tasks to hashline', 'normal');
    updateRouting.run('hashline-ollama', 'qwen2.5-coder:32b', 'Simple tasks to hashline', 'simple');
    // Set model tiers to best models
    setConfig('ollama_fast_model', 'qwen2.5-coder:32b');
    setConfig('ollama_balanced_model', 'qwen2.5-coder:32b');
    setConfig('ollama_quality_model', 'qwen2.5-coder:32b');
    setConfig('ollama_fast_model_fallback', 'codestral:22b');
    setConfig('ollama_balanced_model_fallback', 'codestral:22b');
    // Fix VRAM limit for 24GB GPU hosts (was incorrectly set to 8GB in earlier versions)
    // This migration is a no-op for new installs; retained for existing DBs that had the wrong value.
    db.prepare(`
      UPDATE ollama_hosts SET memory_limit_mb = 24576
      WHERE memory_limit_mb = 8192 AND memory_limit_mb < 24576
    `).run();
    // Restrict hashline to only the best models
    setConfig('hashline_capable_models', 'qwen2.5-coder:32b,codestral:22b');
    // Enable hashline format auto-selection based on success rates
    setConfig('hashline_format_auto_select', '1');
    // Force standard hashline for qwen2.5-coder (abbreviates SEARCH content in hashline-lite)
    setConfig('hashline_model_formats', JSON.stringify({ 'qwen2.5-coder:32b': 'hashline', 'qwen2.5-coder': 'hashline' }));
    // Enable error feedback for self-correcting edits
    setConfig('error_feedback_enabled', '1');
    setConfig('verify_max_fix_attempts', '2');
    // Lower temperature for qwen2.5-coder:32b — reduces hash hallucination
    setConfig('ollama_model_settings', JSON.stringify({
      'qwen2.5-coder:32b': { temperature: 0.1 },
      'codestral:22b': { temperature: 0.15 }
    }));
    // Increase keep_alive to reduce cold-start latency between tasks
    setConfig('ollama_keep_alive', '30m');
    // Enable hashline-ollama provider (was disabled)
    db.prepare(`UPDATE provider_config SET enabled = 1 WHERE provider = 'hashline-ollama'`).run();
    logger.debug('Schema migration (R-hashline): consolidated to best models, hashline-ollama routing');
  } catch (e) {
    logger.debug(`Schema migration (R-hashline): ${e.message}`);
  }

  // provider_health_history table for persistent provider health tracking
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_health_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT,
        total_checks INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        failure_rate REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider, window_start)
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_provider_health_history_provider_window
      ON provider_health_history(provider, window_start)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_provider_health_history_window_start
      ON provider_health_history(window_start)
    `);
  } catch (e) {
    logger.debug(`Schema migration (provider_health_history): ${e.message}`);
  }

  // Unified workstations table — replaces peek_hosts, remote_agents, ollama_hosts
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workstations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        host TEXT NOT NULL,
        agent_port INTEGER DEFAULT 3460,
        platform TEXT,
        arch TEXT,
        tls_cert TEXT,
        tls_fingerprint TEXT,
        secret TEXT,
        capabilities TEXT,
        ollama_port INTEGER DEFAULT 11434,
        models_cache TEXT,
        memory_limit_mb INTEGER,
        settings TEXT,
        last_model_used TEXT,
        model_loaded_at TEXT,
        gpu_metrics_port INTEGER,
        models_updated_at TEXT,
        gpu_name TEXT,
        gpu_vram_mb INTEGER,
        status TEXT DEFAULT 'unknown',
        consecutive_failures INTEGER DEFAULT 0,
        last_health_check TEXT,
        last_healthy TEXT,
        max_concurrent INTEGER DEFAULT 3,
        running_tasks INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 10,
        enabled INTEGER DEFAULT 1,
        is_default INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    logger.debug(`Schema migration (workstations): ${e.message}`);
  }

  // Phase 2: Migrate existing host data to workstations
  try {
    const { migrateExistingHostsToWorkstations } = require('../workstation/migration');
    migrateExistingHostsToWorkstations(db);
  } catch (e) {
    logger.debug(`Schema migration (workstation data migration): ${e.message}`);
  }
}

module.exports = { runMigrations };
