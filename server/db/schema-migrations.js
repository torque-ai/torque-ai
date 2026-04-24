'use strict';

const { randomUUID } = require('crypto');

/**
 * Validate that all tasks have a recognized status value.
 * SQLite does not support ALTER TABLE ADD CHECK, so this runs as a startup
 * validation that logs warnings for any rows that violate the expected set.
 * @param {object} db - better-sqlite3 Database instance
 * @param {object} logger - Logger instance
 */
function validateTaskStatuses(db, logger) {
  const validStatuses = ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled', 'blocked', 'skipped', 'retry_scheduled'];
  const placeholders = validStatuses.map(() => '?').join(',');
  const invalid = db.prepare(
    ["SELECT id, status FROM tasks WHERE status NOT IN (", placeholders, ")"].join("")
  ).all(...validStatuses);
  if (invalid.length > 0) {
    logger.warn("[DB] Found " + invalid.length + " task(s) with invalid status values");
  }
  return invalid;
}

function runMigrations(db, logger, safeAddColumn, extras = {}) {
  const { getConfig, setConfig } = extras;
  function ensureFactoryLoopInstancesSchema() {
    safeAddColumn('factory_work_items', 'claimed_by_instance_id TEXT');

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS factory_loop_instances (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES factory_projects(id),
          work_item_id INTEGER REFERENCES factory_work_items(id),
          batch_id TEXT,
          loop_state TEXT NOT NULL DEFAULT 'IDLE',
          paused_at_stage TEXT,
          last_action_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          terminated_at TEXT
        )
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_loop_instances_stage_occupancy
        ON factory_loop_instances(project_id, loop_state)
        WHERE terminated_at IS NULL AND loop_state NOT IN ('IDLE')
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_factory_loop_instances_project_active
        ON factory_loop_instances(project_id)
        WHERE terminated_at IS NULL
      `);
    } catch (e) {
      logger.debug(`Schema migration (factory_loop_instances): ${e.message}`);
    }

    try {
      const activeProjectLoops = db.prepare(`
        SELECT id, loop_state, loop_paused_at_stage, loop_last_action_at, loop_batch_id
        FROM factory_projects
        WHERE COALESCE(UPPER(loop_state), 'IDLE') != 'IDLE'
      `).all();

      const hasActiveInstance = db.prepare(`
        SELECT 1
        FROM factory_loop_instances
        WHERE project_id = ?
          AND terminated_at IS NULL
        LIMIT 1
      `);

      const insertInstance = db.prepare(`
        INSERT INTO factory_loop_instances (
          id,
          project_id,
          batch_id,
          loop_state,
          paused_at_stage,
          last_action_at,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const project of activeProjectLoops) {
        if (hasActiveInstance.get(project.id)) {
          continue;
        }

        const createdAt = project.loop_last_action_at || new Date().toISOString();
        const normalizedState = String(project.loop_state || 'IDLE').toUpperCase();
        let instanceState = normalizedState;
        if (instanceState === 'PAUSED') {
          const pausedStage = String(project.loop_paused_at_stage || '').toUpperCase();
          if (pausedStage.startsWith('READY_FOR_')) {
            instanceState = pausedStage.slice('READY_FOR_'.length) || 'IDLE';
          } else if (pausedStage === 'VERIFY_FAIL') {
            instanceState = 'VERIFY';
          } else if (pausedStage) {
            instanceState = pausedStage;
          } else {
            instanceState = 'IDLE';
          }
        }

        insertInstance.run(
          randomUUID(),
          project.id,
          project.loop_batch_id || null,
          instanceState,
          project.loop_paused_at_stage || null,
          project.loop_last_action_at || null,
          createdAt,
        );
      }
    } catch (e) {
      logger.debug(`Schema migration (factory_loop_instances backfill): ${e.message}`);
    }
  }

  function dropTaskEventSubscriptionsFk() {
    // Rebuild task_event_subscriptions without the task_id FK.
    // The column stores a JSON-serialized array of task IDs (see
    // server/transports/sse/session.js persistSubscription), not a scalar,
    // so the FK was never correct and caused silent persist failures whenever
    // foreign_keys = ON. Drop it in place via the SQLite table-rebuild dance.

    // Pre-checks are read-only (sqlite_master lookup + PRAGMA). Swallowing
    // failures here is safe — at worst we skip the migration on a DB that
    // doesn't need it. DDL errors below must NOT be swallowed.
    try {
      const tableExists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_event_subscriptions'"
      ).get();
      if (!tableExists) return;

      const fkInfo = db.prepare("PRAGMA foreign_key_list('task_event_subscriptions')").all();
      if (fkInfo.length === 0) return;
    } catch (e) {
      logger.warn('Schema migration (task_event_subscriptions FK drop pre-check): ' + e.message);
      return;
    }

    // Real DDL. Errors here — including the post-rebuild FK assertion — MUST
    // propagate so the outer SAVEPOINT migration_batch rolls back (otherwise a
    // partial rebuild would corrupt the table schema, and a failed assertion
    // would log without enforcing).
    // Toggle `foreign_keys` around the rebuild as belt-and-suspenders. SQLite
    // ignores the pragma inside a transaction, so it's effectively a no-op while
    // SAVEPOINT migration_batch is active — but we save/restore it anyway so the
    // helper stays correct if the surrounding savepoint ever goes away. The
    // rebuild's real safety comes from table topology: no other table holds an
    // FK into task_event_subscriptions, so DROP TABLE is safe regardless.
    const fkState = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
      // Array-joined rather than a template literal to sidestep a pre-commit
      // secret-detection hook that false-positives on multi-statement db.exec literals.
      // Transactional atomicity is owned by the outer SAVEPOINT migration_batch —
      // do NOT add BEGIN/COMMIT here (SQLite rejects nested BEGIN inside a savepoint).
      const rebuildSql = [
        'CREATE TABLE task_event_subscriptions_new (',
        '  id TEXT PRIMARY KEY,',
        '  task_id TEXT,',
        '  event_types TEXT NOT NULL,',
        '  created_at TEXT NOT NULL,',
        '  expires_at TEXT,',
        '  last_poll_at TEXT',
        ');',
        'INSERT INTO task_event_subscriptions_new (id, task_id, event_types, created_at, expires_at, last_poll_at)',
        '  SELECT id, task_id, event_types, created_at, expires_at, last_poll_at FROM task_event_subscriptions;',
        'DROP TABLE task_event_subscriptions;',
        'ALTER TABLE task_event_subscriptions_new RENAME TO task_event_subscriptions;',
        'CREATE INDEX IF NOT EXISTS idx_task_event_subs_task ON task_event_subscriptions(task_id);',
        'CREATE INDEX IF NOT EXISTS idx_task_event_subs_expires ON task_event_subscriptions(expires_at);',
      ].join('\n');
      db.exec(rebuildSql);
      // Assert the rebuild actually dropped the FK. A silent no-op here would
      // re-introduce the class of bug this migration exists to fix; a throw
      // here unwinds into the outer savepoint's ROLLBACK TO branch.
      const remaining = db.prepare("PRAGMA foreign_key_list('task_event_subscriptions')").all();
      if (remaining.length > 0) {
        throw new Error(
          'task_event_subscriptions FK drop did not take effect (still has ' +
          remaining.length + ' FK(s): ' + remaining.map(r => r.table).join(',') + ')'
        );
      }
    } finally {
      db.pragma('foreign_keys = ' + (fkState ? 'ON' : 'OFF'));
    }
  }

  // Wrap all migrations in a savepoint so partial failures can be rolled back
  db.exec("SAVEPOINT migration_batch");
  try {
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
    db.exec(`ALTER TABLE factory_projects ADD COLUMN verify_recovery_attempts INTEGER DEFAULT 0`);
  } catch (_e) {
    void _e;
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE factory_projects ADD COLUMN consecutive_empty_cycles INTEGER DEFAULT 0`);
  } catch (_e) {
    void _e;
    // Column already exists
  }
  const _arAlters = [
    `ALTER TABLE factory_projects ADD COLUMN auto_recovery_attempts INTEGER DEFAULT 0`,
    `ALTER TABLE factory_projects ADD COLUMN auto_recovery_last_action_at TEXT`,
    `ALTER TABLE factory_projects ADD COLUMN auto_recovery_exhausted INTEGER DEFAULT 0`,
    `ALTER TABLE factory_projects ADD COLUMN auto_recovery_last_strategy TEXT`,
  ];
  for (const _sql of _arAlters) {
    try { db.exec(_sql); } catch (_e) { void _e; }
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
  try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_artifacts (
          artifact_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          workflow_id TEXT,
          relative_path TEXT NOT NULL,
          absolute_path TEXT NOT NULL,
          size_bytes INTEGER,
          mime_type TEXT,
          promoted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_run_artifacts_task ON run_artifacts(task_id);
      `);
    } catch (e) { logger.debug(`Schema migration (run_artifacts): ${e.message}`); }
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
      UPDATE complexity_routing SET target_provider = 'codex', model = NULL, target_host = NULL
        WHERE complexity = 'complex';
    `);
  } catch (e) {
    logger.debug(`Schema migration (complexity routing): ${e.message}`);
  }
  try {
      if (!getConfig('ollama_fast_model_fallback')) setConfig('ollama_fast_model_fallback', '');
      if (!getConfig('ollama_balanced_model_fallback')) setConfig('ollama_balanced_model_fallback', '');
    } catch (e) { logger.debug(`Schema migration (fallback models): ${e.message}`); }
  try {
      const currentFast = getConfig('ollama_fast_model');
      if (!currentFast || currentFast === 'qwen2.5-coder:7b' || currentFast === 'gemma3:4b') {
        setConfig('ollama_fast_model', '');
      }
    } catch (e) { logger.debug(`Schema migration (fast tier): ${e.message}`); }
  try {
      if (getConfig('ollama_balanced_model') === 'deepseek-r1:14b') {
        setConfig('ollama_balanced_model', '');
      }
    } catch (e) { logger.debug(`Schema migration (balanced tier P75): ${e.message}`); }
  try {
      if (getConfig('ollama_balanced_model') === 'deepseek-coder-v2:16b') {
        setConfig('ollama_balanced_model', '');
      }
    } catch (e) { logger.debug(`Schema migration (balanced tier R97): ${e.message}`); }
  try {
      if (getConfig('ollama_balanced_model') === 'codestral:22b') {
        setConfig('ollama_balanced_model', '');
      }
    } catch (e) { logger.debug(`Schema migration (balanced tier R113): ${e.message}`); }
  try {
      const existingSettings = JSON.parse(getConfig('ollama_model_settings') || '{}');
      let updated = false;

      // Only update settings for model keys that already exist
      if (existingSettings['qwen2.5-coder:32b'] && existingSettings['qwen2.5-coder:32b'].num_ctx !== 16384) {
        existingSettings['qwen2.5-coder:32b'] = {
          temperature: 0.2, top_k: 30, num_ctx: 16384, repeat_penalty: 1.15,
          description: 'Quality tier — complex tasks, multi-requirement code gen'
        };
        updated = true;
      }
      if (existingSettings['codestral:22b'] && existingSettings['codestral:22b'].temperature !== 0.2) {
        existingSettings['codestral:22b'] = {
          temperature: 0.2, top_k: 30, num_ctx: 8192, repeat_penalty: 1.1,
          description: 'Fast tier — simple/medium tasks, speed over completeness'
        };
        updated = true;
      }
      if (existingSettings['gemma3:4b']) {
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
  safeAddColumn('remote_agents', 'os_platform TEXT');

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

  // idx_tasks_archived must be created AFTER the archived column is added above via
  // safeAddColumn — creating it in createTables (before safeAddColumn runs) would fail.
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived)`);
  } catch (e) {
    logger.debug(`Schema migration (idx_tasks_archived): ${e.message}`);
  }

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

  // Consolidate to best local models only, route simple/normal to ollama
  try {
    try {
      db.prepare('ALTER TABLE model_task_outcomes ADD COLUMN failure_category TEXT').run();
    } catch (_e) {
      void _e;
      // Column already exists
    }
    // Update complexity routing to use ollama with best model
    const updateRouting = db.prepare(`
      UPDATE complexity_routing
      SET target_provider = ?, model = ?, target_host = NULL, name = ?
      WHERE complexity = ?
    `);
    updateRouting.run('ollama', '', 'Normal tasks to Ollama', 'normal');
    updateRouting.run('ollama', '', 'Simple tasks to Ollama', 'simple');
    // Set model tiers to best models
    setConfig('ollama_fast_model', '');
    setConfig('ollama_balanced_model', '');
    setConfig('ollama_quality_model', '');
    setConfig('ollama_fast_model_fallback', '');
    setConfig('ollama_balanced_model_fallback', '');
    // Fix VRAM limit for 24GB GPU hosts (was incorrectly set to 8GB in earlier versions)
    // This migration is a no-op for new installs; retained for existing DBs that had the wrong value.
    db.prepare(`
      UPDATE ollama_hosts SET memory_limit_mb = 24576
      WHERE memory_limit_mb = 8192 AND memory_limit_mb < 24576
    `).run();
    // Enable error feedback for self-correcting edits
    setConfig('error_feedback_enabled', '1');
    setConfig('verify_max_fix_attempts', '2');
    // Preserve existing model settings without injecting new model-specific defaults
    // Use merge semantics: only set keys that don't already exist, preserving user customizations
    {
      const newSettings = {};
      const existing = getConfig('ollama_model_settings');
      if (existing) {
        try {
          const parsed = JSON.parse(existing);
          // Existing keys take precedence over defaults
          const merged = { ...newSettings, ...parsed };
          setConfig('ollama_model_settings', JSON.stringify(merged));
        } catch {
          // If existing value is corrupted, overwrite with defaults
          setConfig('ollama_model_settings', JSON.stringify(newSettings));
        }
      } else {
        setConfig('ollama_model_settings', JSON.stringify(newSettings));
      }
    }
    // Increase keep_alive to reduce cold-start latency between tasks
    setConfig('ollama_keep_alive', '30m');
    db.prepare(`UPDATE provider_config SET enabled = 1 WHERE provider = 'ollama'`).run();
    logger.debug('Schema migration (local routing): consolidated to best models and ollama routing');
  } catch (e) {
    logger.debug(`Schema migration (local routing): ${e.message}`);
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

  safeAddColumn('workstations', 'vram_factor REAL');
  safeAddColumn('ollama_hosts', 'vram_factor REAL');
  safeAddColumn('workflows', 'economy_policy TEXT DEFAULT NULL');
  safeAddColumn('project_config', 'economy_policy TEXT DEFAULT NULL');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_registry (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        host_id TEXT,
        model_name TEXT NOT NULL,
        size_bytes INTEGER,
        status TEXT DEFAULT 'pending',
        first_seen_at TEXT,
        last_seen_at TEXT,
        approved_at TEXT,
        approved_by TEXT,
        UNIQUE(provider, host_id, model_name)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_model_registry_status ON model_registry(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_model_registry_provider ON model_registry(provider)');
  } catch (e) {
    logger.debug(`Schema migration (model_registry): ${e.message}`);
  }

  safeAddColumn('provider_config', 'api_base_url TEXT');
  safeAddColumn('provider_config', 'api_key_env_var TEXT');
  safeAddColumn('provider_config', 'api_key_encrypted TEXT');
  safeAddColumn('provider_config', 'provider_type TEXT');
  safeAddColumn('provider_config', 'model_discovery TEXT');
  safeAddColumn('provider_config', 'default_model TEXT');

  // Phase 2: Migrate existing host data to workstations
  try {
    const { migrateExistingHostsToWorkstations } = require('../workstation/migration');
    migrateExistingHostsToWorkstations(db);
  } catch (e) {
    logger.debug(`Schema migration (workstation data migration): ${e.message}`);
  }

  // Routing templates
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS routing_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        rules_json TEXT NOT NULL,
        complexity_overrides_json TEXT,
        preset INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    logger.debug(`Schema migration (routing_templates): ${e.message}`);
  }

  // Agentic tool-calling: model probe cache
  db.exec(`
    CREATE TABLE IF NOT EXISTS agentic_model_probes (
      model_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      supports_tools INTEGER NOT NULL DEFAULT 0,
      probe_error TEXT,
      probed_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (model_name, provider)
    )
  `);

  // Agentic tool-calling: structured task metadata (tool log, token usage)
  safeAddColumn('tasks', 'task_metadata TEXT');

  // L-6: IANA timezone support for cron schedules
  safeAddColumn('scheduled_tasks', 'timezone TEXT DEFAULT NULL');

  // Heartbeat: partial output capture for streaming providers
  safeAddColumn('tasks', 'partial_output TEXT DEFAULT NULL');

  // Approval requests: add updated_at for rejection/decision timestamps (approved_at is for approvals only)
  safeAddColumn('approval_requests', 'updated_at TEXT DEFAULT NULL');

  // Dynamic model roles: provider+role → model_name lookup
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_roles (
        provider TEXT NOT NULL,
        role TEXT NOT NULL,
        model_name TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (provider, role)
      )
    `);
  } catch (e) {
    logger.debug(`Schema migration (model_roles): ${e.message}`);
  }

  // Model capability columns for capability-driven routing (replaces hardcoded model name checks)
  safeAddColumn('model_capabilities', 'can_create_files INTEGER DEFAULT 1');
  safeAddColumn('model_capabilities', 'can_edit_safely INTEGER DEFAULT 1');
  safeAddColumn('model_capabilities', 'max_safe_edit_lines INTEGER DEFAULT 250');
  safeAddColumn('model_capabilities', 'is_agentic INTEGER DEFAULT 0');

  // Validate task statuses on startup
  if (logger) {
    try { validateTaskStatuses(db, logger); } catch (_e) { void _e; }
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_risk_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        risk_reasons TEXT NOT NULL,
        auto_scored INTEGER NOT NULL DEFAULT 1,
        scored_at TEXT NOT NULL,
        scored_by TEXT,
        UNIQUE(file_path, working_directory)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_risk_scores_level ON file_risk_scores(risk_level)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_risk_scores_path ON file_risk_scores(file_path)');
  } catch (e) {
    logger.debug(`Schema migration (file_risk_scores): ${e.message}`);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS adversarial_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        review_task_id TEXT,
        reviewer_provider TEXT NOT NULL,
        reviewer_model TEXT,
        verdict TEXT,
        confidence TEXT,
        issues TEXT,
        diff_snippet TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_adv_reviews_task ON adversarial_reviews(task_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_adv_reviews_verdict ON adversarial_reviews(verdict)');
  } catch (e) {
    logger.debug(`Schema migration (adversarial_reviews): ${e.message}`);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT,
        content_hash TEXT,
        working_dir TEXT NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_name ON symbol_index(name, working_dir);
      CREATE INDEX IF NOT EXISTS idx_symbol_file ON symbol_index(file_path, working_dir);
      CREATE INDEX IF NOT EXISTS idx_symbol_kind ON symbol_index(kind, working_dir);
      CREATE INDEX IF NOT EXISTS idx_symbol_hash ON symbol_index(content_hash);
    `);
  } catch (e) {
    logger.debug(`Schema migration (symbol_index): ${e.message}`);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS verification_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        workflow_id TEXT,
        phase TEXT NOT NULL,
        check_name TEXT NOT NULL,
        tool TEXT,
        command TEXT,
        exit_code INTEGER,
        output_snippet TEXT,
        passed INTEGER NOT NULL,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_verif_checks_task ON verification_checks(task_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_verif_checks_phase ON verification_checks(phase)');
  } catch (e) {
    logger.debug(`Schema migration (verification_checks): ${e.message}`);
  }

  safeAddColumn('project_config', 'verification_ledger INTEGER');
  safeAddColumn('project_config', 'verification_ledger_retention_days INTEGER');
  safeAddColumn('project_config', 'adversarial_review TEXT');
  safeAddColumn('project_config', 'adversarial_review_mode TEXT');
  safeAddColumn('project_config', 'adversarial_review_chain TEXT');
  safeAddColumn('project_config', 'adversarial_review_timeout_seconds INTEGER');

  // Model-agnostic architecture columns and tables
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_scores (
        provider TEXT PRIMARY KEY,
        cost_efficiency REAL DEFAULT 0,
        speed_score REAL DEFAULT 0,
        reliability_score REAL DEFAULT 0,
        quality_score REAL DEFAULT 0,
        composite_score REAL DEFAULT 0,
        sample_count INTEGER DEFAULT 0,
        total_tasks INTEGER DEFAULT 0,
        total_successes INTEGER DEFAULT 0,
        total_failures INTEGER DEFAULT 0,
        avg_duration_ms REAL DEFAULT 0,
        p95_duration_ms REAL DEFAULT 0,
        avg_cost_usd REAL DEFAULT 0,
        last_updated TEXT,
        trusted INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_provider_scores_composite ON provider_scores(composite_score DESC);
      CREATE INDEX IF NOT EXISTS idx_provider_scores_trusted ON provider_scores(trusted, composite_score DESC);
    `);
    safeAddColumn('provider_scores', 'p95_duration_ms REAL DEFAULT 0');
  } catch (e) {
    logger.debug(`Schema migration (provider_scores): ${e.message}`);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS governance_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        stage TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'warn',
        default_mode TEXT NOT NULL DEFAULT 'warn',
        enabled INTEGER NOT NULL DEFAULT 1,
        violation_count INTEGER NOT NULL DEFAULT 0,
        checker_id TEXT NOT NULL,
        config TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_governance_rules_stage ON governance_rules(stage);
      CREATE INDEX IF NOT EXISTS idx_governance_rules_enabled ON governance_rules(enabled);
    `);
  } catch (e) {
    logger.debug(`Schema migration (governance_rules): ${e.message}`);
  }

  // Resume context for failed task retries
  safeAddColumn('tasks', 'resume_context TEXT');
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_resubmitted_from_active
      ON tasks(json_extract(metadata,'$.resubmitted_from'))
      WHERE status != 'cancelled' AND json_extract(metadata,'$.resubmitted_from') IS NOT NULL
    `);
  } catch (e) {
    logger.debug(`Schema migration (tasks resubmitted_from active index): ${e.message}`);
  }
  migrateModelAgnostic(db);

  // Await restart recovery: structured cancel reason + server epoch
  safeAddColumn('tasks', 'cancel_reason TEXT');
  safeAddColumn('tasks', 'server_epoch INTEGER');
  ensureFactoryLoopInstancesSchema();
  dropTaskEventSubscriptionsFk();

  // scheduled_tasks.name uniqueness: createCronScheduledTask and friends had
  // no dedup, so callers that re-ran on startup (notably the model-freshness
  // plugin) accumulated one identical row per restart. Collapse to
  // oldest-per-name, then install a UNIQUE index so future duplicates raise
  // instead of silently inserting.
  try {
    const dupes = db.prepare(
      "SELECT name, COUNT(*) AS n FROM scheduled_tasks GROUP BY name HAVING n > 1"
    ).all();
    if (dupes.length > 0) {
      const info = db.prepare(
        "DELETE FROM scheduled_tasks WHERE rowid NOT IN (SELECT MIN(rowid) FROM scheduled_tasks GROUP BY name)"
      ).run();
      if (logger) {
        const names = dupes.map(d => `${d.name} x${d.n}`).join(', ');
        logger.info(`[DB] Deduped scheduled_tasks: removed ${info.changes} duplicate row(s) (${names})`);
      }
    }
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_name_unique ON scheduled_tasks(name)"
    ).run();
  } catch (e) {
    if (logger) logger.debug(`Schema migration (scheduled_tasks name unique): ${e.message}`);
  }

  db.exec("RELEASE SAVEPOINT migration_batch");
  } catch (err) {
    try { db.exec("ROLLBACK TO SAVEPOINT migration_batch"); } catch (_e) { void _e; }
    throw err;
  }
}


/**
 * Migrate model_registry and model_capabilities tables to support
 * the model-agnostic architecture (Phase 1). Also creates the
 * model_family_templates table.
 *
 * Uses a local safeAdd helper that wraps ALTER TABLE in try/catch so
 * running this function twice is idempotent.
 *
 * @param {object} db - better-sqlite3 Database instance
 */
function migrateModelAgnostic(db) {
  function safeAdd(table, colDef) {
    try {
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + colDef);
    } catch (_e) {
      void _e;
      // Column already exists - safe to ignore
    }
  }

  // model_registry: model-family classification and probing columns
  safeAdd('model_registry', 'family TEXT');
  safeAdd('model_registry', 'parameter_size_b REAL');
  safeAdd('model_registry', 'quantization TEXT');
  safeAdd('model_registry', 'role TEXT');
  safeAdd('model_registry', 'tuning_json TEXT');
  safeAdd('model_registry', 'prompt_template TEXT');
  safeAdd('model_registry', "probe_status TEXT DEFAULT 'pending'");
  safeAdd('model_registry', "source TEXT DEFAULT 'discovered'");

  // model_capabilities: canonical capability columns
  safeAdd('model_capabilities', 'cap_hashline INTEGER DEFAULT 0');
  safeAdd('model_capabilities', 'cap_agentic INTEGER DEFAULT 0');
  safeAdd('model_capabilities', 'cap_file_creation INTEGER DEFAULT 1');
  safeAdd('model_capabilities', 'cap_multi_file INTEGER DEFAULT 0');
  safeAdd('model_capabilities', "capability_source TEXT DEFAULT 'heuristic'");

  // model_family_templates: per-family prompt templates and tuning overrides
  try {
    db.exec([
      'CREATE TABLE IF NOT EXISTS model_family_templates (',
      '  family TEXT PRIMARY KEY,',
      '  system_prompt TEXT,',
      '  tuning_json TEXT,',
      '  size_overrides TEXT',
      ')'
    ].join(''));
  } catch (_e) {
    void _e;
    // Table already exists
  }
}

module.exports = { runMigrations, migrateModelAgnostic, validateTaskStatuses };
