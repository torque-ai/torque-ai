'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

/**
 * Database Migration System for TORQUE
 *
 * Manages schema changes via numbered migration entries.
 * Tracks applied migrations in a `schema_migrations` table.
 *
 * Usage:
 *   const { runMigrations } = require('./db/migrations');
 *   runMigrations(db);  // db = better-sqlite3 instance
 */

// Task lifecycle note:
// `tasks.status` is defined as an unconstrained TEXT column in schema-tables.js.
// Adding logical statuses such as `pending_approval` does not require a schema
// migration unless a future CHECK/enum constraint is introduced.
function readSqlMigration(fileName) {
  return fs.readFileSync(path.join(__dirname, '..', 'migrations', fileName), 'utf8');
}

const MIGRATIONS = [
  {
    version: 1,
    name: 'remove_unused_notification_templates',
    up: 'DROP TABLE IF EXISTS notification_templates;',
    down: [
      'CREATE TABLE IF NOT EXISTS notification_templates (',
      '  id TEXT PRIMARY KEY,',
      '  integration_type TEXT NOT NULL,',
      '  event_type TEXT NOT NULL,',
      '  template TEXT NOT NULL,',
      '  enabled INTEGER DEFAULT 1,',
      '  created_at TEXT NOT NULL',
      ')',
    ].join('\n'),
  },
  {
    version: 2,
    name: 'add_provider_composite_index',
    up: 'CREATE INDEX IF NOT EXISTS idx_provider_stats_composite ON provider_task_stats(provider, task_type, total_tasks);',
    down: 'DROP INDEX IF EXISTS idx_provider_stats_composite;',
  },
  {
    version: 3,
    name: 'add_model_affinity_columns',
    up: [
      'ALTER TABLE ollama_hosts ADD COLUMN last_model_used TEXT',
      'ALTER TABLE ollama_hosts ADD COLUMN model_loaded_at TEXT',
    ].join('; '),
    down: [
      // SQLite doesn't support DROP COLUMN easily, but these columns are nullable so just ignore
    ].join('; '),
  },
  {
    version: 4,
    name: 'add_lock_heartbeat_column',
    up: 'ALTER TABLE distributed_locks ADD COLUMN last_heartbeat TEXT',
    down: '',
  },
  {
    version: 5,
    name: 'add_project_tuning_table',
    up: [
      'CREATE TABLE IF NOT EXISTS project_tuning (',
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
      '  project_path TEXT NOT NULL UNIQUE,',
      '  settings_json TEXT NOT NULL,',
      '  description TEXT,',
      '  created_at TEXT NOT NULL,',
      '  updated_at TEXT NOT NULL',
      ')',
    ].join('\n'),
    down: 'DROP TABLE IF EXISTS project_tuning',
  },
  {
    version: 6,
    name: 'add_benchmark_results_table',
    up: [
      'CREATE TABLE IF NOT EXISTS benchmark_results (',
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
      '  host_id TEXT NOT NULL,',
      '  model TEXT NOT NULL,',
      '  test_type TEXT NOT NULL,',
      '  prompt_type TEXT,',
      '  tokens_per_second REAL,',
      '  prompt_tokens INTEGER,',
      '  output_tokens INTEGER,',
      '  eval_duration_seconds REAL,',
      '  num_gpu INTEGER,',
      '  num_ctx INTEGER,',
      '  temperature REAL,',
      '  success INTEGER DEFAULT 1,',
      '  error_message TEXT,',
      '  raw_result TEXT,',
      '  benchmarked_at TEXT NOT NULL',
      ')',
    ].join('\n'),
    down: 'DROP TABLE IF EXISTS benchmark_results',
  },
  {
    version: 7,
    name: 'add_api_keys_table_and_server_secret',
    up: [
      [
        'CREATE TABLE IF NOT EXISTS api_keys (',
        '  id TEXT PRIMARY KEY,',
        '  key_hash TEXT NOT NULL,',
        '  name TEXT NOT NULL,',
        "  role TEXT NOT NULL DEFAULT 'admin',",
        "  created_at TEXT NOT NULL DEFAULT (datetime('now')),",
        '  last_used_at TEXT,',
        '  revoked_at TEXT',
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)',
    ].join('; '),
    down: 'DROP TABLE IF EXISTS api_keys',
  },
  {
    version: 8,
    name: 'remove_aider_provider_config',
    up: [
      // Delete aider-specific config keys
      "DELETE FROM config WHERE key IN ('aider_auto_commits', 'aider_auto_switch_format', 'aider_edit_format', 'aider_map_tokens', 'aider_model_edit_formats', 'aider_subtree_only')",
      // Rename stall_threshold_aider → stall_threshold_ollama
      "UPDATE config SET key = 'stall_threshold_ollama' WHERE key = 'stall_threshold_aider'",
    ].join('; '),
    down: '',
  },
  {
    version: 9,
    name: 'add_host_default_model',
    up: 'ALTER TABLE ollama_hosts ADD COLUMN default_model TEXT',
    down: '',
  },
  {
    // Vendor-aligned tuning: disable repeat_penalty (1.0) globally, set per-family
    // values per vendor recommendations (Qwen: temp 0.7/top_k 20/rp 1.05,
    // Llama: top_k 10, DeepSeek: temp 0.6). Research (ACL 2025) shows repeat_penalty
    // >=1.1 degrades code generation correctness.
    version: 10,
    name: 'vendor_aligned_tuning',
    up: [
      // qwen3: temp 0.7, top_k 20, repeat_penalty 1.05 (vendor-recommended)
      "UPDATE model_family_templates SET tuning_json = json_set(tuning_json, '$.temperature', 0.7, '$.top_k', 20, '$.repeat_penalty', 1.05) WHERE family = 'qwen3'",
      // qwen2.5: temp 0.7, repeat_penalty 1.0
      "UPDATE model_family_templates SET tuning_json = json_set(tuning_json, '$.temperature', 0.7, '$.repeat_penalty', 1.0) WHERE family = 'qwen2.5'",
      // llama: top_k 10, repeat_penalty 1.0
      "UPDATE model_family_templates SET tuning_json = json_set(tuning_json, '$.top_k', 10, '$.repeat_penalty', 1.0) WHERE family = 'llama'",
      // deepseek: temp 0.6, repeat_penalty 1.0
      "UPDATE model_family_templates SET tuning_json = json_set(tuning_json, '$.temperature', 0.6, '$.repeat_penalty', 1.0) WHERE family = 'deepseek'",
      // All others: repeat_penalty 1.0
      "UPDATE model_family_templates SET tuning_json = json_set(tuning_json, '$.repeat_penalty', 1.0) WHERE family NOT IN ('qwen3', 'qwen2.5', 'llama', 'deepseek')",
      // Global config: repeat_penalty 1.1 -> 1.0
      "UPDATE config SET value = '1.0' WHERE key = 'ollama_repeat_penalty' AND value = '1.1'",
      // Note: deprecated model cleanup moved to migration 11
    ].join(';\n'),
    down: '',
  },
  {
    version: 11,
    name: 'remove_deprecated_models',
    up: "UPDATE model_registry SET status = 'removed' WHERE model_name IN ('qwen2.5-coder:32b', 'codestral:22b') AND status = 'approved'",
    down: '',
  },
  {
    version: 12,
    name: 'remove-hashline-aider-providers',
    description: 'Remove deprecated local providers and hashline config keys',
    up: (db) => {
      const removedProviders = ['hashline-ollama', 'hashline-openai', 'aider-ollama'];

      db.prepare("DELETE FROM provider_config WHERE provider IN ('hashline-ollama', 'hashline-openai', 'aider-ollama')").run();

      const hashlineKeys = [
        'hashline_capable_models',
        'hashline_format_auto_select',
        'hashline_model_formats',
        'hashline_lite_min_samples',
        'hashline_lite_threshold',
        'max_hashline_local_retries',
      ];
      const deleteConfig = db.prepare('DELETE FROM config WHERE key = ?');
      for (const key of hashlineKeys) {
        deleteConfig.run(key);
      }

      const defaultProvider = db.prepare("SELECT value FROM config WHERE key = 'smart_routing_default_provider'").get();
      if (defaultProvider && removedProviders.includes(defaultProvider.value)) {
        db.prepare("UPDATE config SET value = 'ollama' WHERE key = 'smart_routing_default_provider'").run();
      }

      try {
        db.prepare("DELETE FROM provider_task_stats WHERE provider IN ('hashline-ollama', 'hashline-openai', 'aider-ollama')").run();
      } catch {
        // Table may not exist in older databases.
      }

      try {
        const templates = db.prepare('SELECT id, rules FROM routing_templates').all();
        const updateTemplate = db.prepare('UPDATE routing_templates SET rules = ? WHERE id = ?');
        for (const template of templates) {
          try {
            const rules = JSON.parse(template.rules);
            let changed = false;
            for (const [category, chain] of Object.entries(rules)) {
              if (Array.isArray(chain)) {
                const filtered = chain.filter(provider => !removedProviders.includes(provider));
                if (filtered.length !== chain.length) {
                  rules[category] = filtered;
                  changed = true;
                }
              }
            }
            if (changed) {
              updateTemplate.run(JSON.stringify(rules), template.id);
            }
          } catch {
            // Skip malformed template rules.
          }
        }
      } catch {
        // Table may not exist in older databases.
      }
    },
    down: '',
  },
  {
    version: 13,
    name: 'add_factory_tables',
    up: [
      [
        'CREATE TABLE IF NOT EXISTS factory_projects (',
        '  id TEXT PRIMARY KEY,',
        '  name TEXT NOT NULL,',
        '  path TEXT NOT NULL UNIQUE,',
        '  brief TEXT,',
        "  trust_level TEXT NOT NULL DEFAULT 'supervised',",
        "  status TEXT NOT NULL DEFAULT 'paused',",
        '  config_json TEXT,',
        "  created_at TEXT NOT NULL DEFAULT (datetime('now')),",
        "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
        ')',
      ].join('\n'),
      [
        'CREATE TABLE IF NOT EXISTS factory_health_snapshots (',
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        '  project_id TEXT NOT NULL REFERENCES factory_projects(id),',
        '  dimension TEXT NOT NULL,',
        '  score REAL NOT NULL,',
        '  details_json TEXT,',
        "  scan_type TEXT NOT NULL DEFAULT 'incremental',",
        '  batch_id TEXT,',
        "  scanned_at TEXT NOT NULL DEFAULT (datetime('now'))",
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_fhs_project_dim ON factory_health_snapshots(project_id, dimension, scanned_at)',
      'CREATE INDEX IF NOT EXISTS idx_fhs_project_time ON factory_health_snapshots(project_id, scanned_at)',
      [
        'CREATE TABLE IF NOT EXISTS factory_health_findings (',
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        '  snapshot_id INTEGER NOT NULL REFERENCES factory_health_snapshots(id),',
        '  severity TEXT NOT NULL,',
        '  message TEXT NOT NULL,',
        '  file_path TEXT,',
        '  details_json TEXT',
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_fhf_snapshot ON factory_health_findings(snapshot_id)',
    ].join('; '),
    down: [
      'DROP TABLE IF EXISTS factory_health_findings',
      'DROP TABLE IF EXISTS factory_health_snapshots',
      'DROP TABLE IF EXISTS factory_projects',
    ].join('; '),
  },
  {
    version: 14,
    name: 'add_factory_work_items',
    up: [
      [
        'CREATE TABLE IF NOT EXISTS factory_work_items (',
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        '  project_id TEXT NOT NULL REFERENCES factory_projects(id),',
        '  source TEXT NOT NULL,',
        '  origin_json TEXT,',
        '  title TEXT NOT NULL,',
        '  description TEXT,',
        '  priority INTEGER NOT NULL DEFAULT 50,',
        '  requestor TEXT,',
        '  constraints_json TEXT,',
        "  status TEXT NOT NULL DEFAULT 'pending',",
        '  reject_reason TEXT,',
        '  linked_item_id INTEGER,',
        '  batch_id TEXT,',
        "  created_at TEXT NOT NULL DEFAULT (datetime('now')),",
        "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_fwi_project_status ON factory_work_items(project_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_fwi_status_priority ON factory_work_items(status, priority DESC)',
      'CREATE INDEX IF NOT EXISTS idx_fwi_source ON factory_work_items(source)',
      'CREATE INDEX IF NOT EXISTS idx_fwi_linked ON factory_work_items(linked_item_id)',
    ].join('; '),
    down: 'DROP TABLE IF EXISTS factory_work_items',
  },
  {
    version: 15,
    name: 'add_factory_architect_cycles',
    up: [
      [
        'CREATE TABLE IF NOT EXISTS factory_architect_cycles (',
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        '  project_id TEXT NOT NULL REFERENCES factory_projects(id),',
        '  input_snapshot_json TEXT NOT NULL,',
        '  reasoning TEXT NOT NULL,',
        '  backlog_json TEXT NOT NULL,',
        '  flags_json TEXT,',
        "  status TEXT NOT NULL DEFAULT 'completed',",
        "  trigger TEXT NOT NULL DEFAULT 'manual',",
        "  created_at TEXT NOT NULL DEFAULT (datetime('now'))",
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_fac_project_time ON factory_architect_cycles(project_id, created_at)',
    ].join('; '),
    down: 'DROP TABLE IF EXISTS factory_architect_cycles',
  },
  {
    version: 16,
    name: 'add_factory_guardrail_events',
    up: [
      [
        'CREATE TABLE IF NOT EXISTS factory_guardrail_events (',
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        '  project_id TEXT NOT NULL REFERENCES factory_projects(id),',
        '  category TEXT NOT NULL,',
        '  check_name TEXT NOT NULL,',
        '  status TEXT NOT NULL,',
        '  details_json TEXT,',
        '  batch_id TEXT,',
        "  created_at TEXT NOT NULL DEFAULT (datetime('now'))",
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_fge_project_time ON factory_guardrail_events(project_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_fge_category ON factory_guardrail_events(project_id, category)',
    ].join('; '),
    down: 'DROP TABLE IF EXISTS factory_guardrail_events',
  },
  {
    version: 17,
    name: 'add_factory_loop_state',
    up: [
      "ALTER TABLE factory_projects ADD COLUMN loop_state TEXT DEFAULT 'idle'",
      'ALTER TABLE factory_projects ADD COLUMN loop_batch_id TEXT',
      'ALTER TABLE factory_projects ADD COLUMN loop_last_action_at TEXT',
      'ALTER TABLE factory_projects ADD COLUMN loop_paused_at_stage TEXT',
    ].join('; '),
    down: 'SELECT 1',
  },
  {
    version: 18,
    name: 'add_factory_feedback_table',
    up: [
      [
        'CREATE TABLE IF NOT EXISTS factory_feedback (',
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        '  project_id TEXT NOT NULL REFERENCES factory_projects(id),',
        '  batch_id TEXT,',
        '  health_delta_json TEXT,',
        '  execution_metrics_json TEXT,',
        '  guardrail_activity_json TEXT,',
        '  human_corrections_json TEXT,',
        "  created_at TEXT NOT NULL DEFAULT (datetime('now'))",
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_ff_project_time ON factory_feedback(project_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_ff_batch ON factory_feedback(batch_id)',
    ].join('; '),
    down: 'DROP TABLE IF EXISTS factory_feedback',
  },
  {
    version: 19,
    name: 'add_factory_decisions',
    up: [
      [
        'CREATE TABLE IF NOT EXISTS factory_decisions (',
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        '  project_id TEXT NOT NULL REFERENCES factory_projects(id),',
        '  stage TEXT NOT NULL,',
        '  actor TEXT NOT NULL,',
        '  action TEXT NOT NULL,',
        '  reasoning TEXT,',
        '  inputs_json TEXT,',
        '  outcome_json TEXT,',
        '  confidence REAL,',
        '  batch_id TEXT,',
        "  created_at TEXT NOT NULL DEFAULT (datetime('now'))",
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_fd_project_time ON factory_decisions(project_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_fd_stage ON factory_decisions(project_id, stage)',
    ].join('; '),
    down: 'DROP TABLE IF EXISTS factory_decisions',
  },
  {
    version: 20,
    name: 'add_factory_audit_events',
    up: [
      [
        'CREATE TABLE IF NOT EXISTS factory_audit_events (',
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        '  project_id TEXT NOT NULL REFERENCES factory_projects(id),',
        '  event_type TEXT NOT NULL,',
        '  previous_status TEXT,',
        '  reason TEXT,',
        '  actor TEXT,',
        '  source TEXT,',
        "  created_at TEXT NOT NULL DEFAULT (datetime('now'))",
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_fae_project_time ON factory_audit_events(project_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_fae_event_type ON factory_audit_events(project_id, event_type)',
    ].join('; '),
    down: 'DROP TABLE IF EXISTS factory_audit_events',
  },
  {
    version: 21,
    name: 'add_factory_plan_file_intake',
    up: [
      'CREATE TABLE IF NOT EXISTS factory_plan_file_intake (',
      '  plan_path TEXT NOT NULL,',
      '  content_hash TEXT NOT NULL,',
      '  work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id) ON DELETE CASCADE,',
      '  project_id TEXT NOT NULL,',
      '  created_at TEXT NOT NULL,',
      '  PRIMARY KEY (project_id, plan_path, content_hash)',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_factory_plan_file_project ON factory_plan_file_intake(project_id);',
    ].join('\n'),
    down: [
      'DROP INDEX IF EXISTS idx_factory_plan_file_project;',
      'DROP TABLE IF EXISTS factory_plan_file_intake;',
    ].join('\n'),
  },
  {
    // Keep vc_worktree_id as a tracked identifier instead of an enforced FK:
    // merge cleanup deletes rows from vc_worktrees after shipping.
    version: 22,
    name: 'add_factory_worktrees',
    up: [
      [
        'CREATE TABLE IF NOT EXISTS factory_worktrees (',
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        '  project_id TEXT NOT NULL REFERENCES factory_projects(id),',
        '  work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id),',
        '  batch_id TEXT NOT NULL,',
        '  vc_worktree_id TEXT NOT NULL,',
        '  branch TEXT NOT NULL,',
        '  worktree_path TEXT NOT NULL,',
        "  status TEXT NOT NULL DEFAULT 'active',",
        "  created_at TEXT NOT NULL DEFAULT (datetime('now')),",
        '  merged_at TEXT,',
        '  abandoned_at TEXT',
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_factory_worktrees_project_active ON factory_worktrees(project_id, status)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_worktrees_branch ON factory_worktrees(branch)',
    ].join('; '),
    down: [
      'DROP INDEX IF EXISTS idx_factory_worktrees_project_active',
      'DROP INDEX IF EXISTS idx_factory_worktrees_branch',
      'DROP TABLE IF EXISTS factory_worktrees',
    ].join('; '),
  },
  {
    version: 23,
    name: 'add_run_artifacts',
    up: [
      [
        'CREATE TABLE IF NOT EXISTS run_artifacts (',
        '  artifact_id TEXT PRIMARY KEY,',
        '  task_id TEXT NOT NULL,',
        '  workflow_id TEXT,',
        '  relative_path TEXT NOT NULL,',
        '  absolute_path TEXT NOT NULL,',
        '  size_bytes INTEGER,',
        '  mime_type TEXT,',
        '  promoted INTEGER NOT NULL DEFAULT 0,',
        "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_run_artifacts_task ON run_artifacts(task_id)',
    ].join('; '),
    down: [
      'DROP INDEX IF EXISTS idx_run_artifacts_task',
      'DROP TABLE IF EXISTS run_artifacts',
    ].join('; '),
  },
  {
    version: 24,
    name: 'add_managed_oauth_tables',
    up: [
      [
        'CREATE TABLE IF NOT EXISTS auth_configs (',
        '  id TEXT PRIMARY KEY,',
        '  toolkit TEXT NOT NULL,',
        "  auth_type TEXT NOT NULL CHECK (auth_type IN ('oauth2', 'api_key', 'basic', 'bearer')),",
        '  client_id TEXT,',
        '  client_secret_enc TEXT,',
        '  authorize_url TEXT,',
        '  token_url TEXT,',
        '  scopes TEXT,',
        '  redirect_uri TEXT,',
        '  created_at INTEGER NOT NULL,',
        '  UNIQUE (toolkit)',
        ')',
      ].join('\n'),
      [
        'CREATE TABLE IF NOT EXISTS connected_accounts (',
        '  id TEXT PRIMARY KEY,',
        '  user_id TEXT NOT NULL,',
        '  toolkit TEXT NOT NULL,',
        '  auth_config_id TEXT NOT NULL REFERENCES auth_configs(id),',
        '  access_token_enc TEXT,',
        '  refresh_token_enc TEXT,',
        '  expires_at INTEGER,',
        "  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked', 'expired')),",
        '  metadata_json TEXT,',
        '  created_at INTEGER NOT NULL,',
        '  updated_at INTEGER NOT NULL',
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_conn_accounts_user_toolkit ON connected_accounts(user_id, toolkit)',
      'CREATE INDEX IF NOT EXISTS idx_conn_accounts_status ON connected_accounts(status)',
    ].join('; '),
    down: [
      'DROP INDEX IF EXISTS idx_conn_accounts_status',
      'DROP INDEX IF EXISTS idx_conn_accounts_user_toolkit',
      'DROP TABLE IF EXISTS connected_accounts',
      'DROP TABLE IF EXISTS auth_configs',
    ].join('; '),
  },
  {
    version: 25,
    name: 'add_factory_loop_instances',
    up: (db) => {
      try {
        db.prepare('ALTER TABLE factory_work_items ADD COLUMN claimed_by_instance_id TEXT').run();
      } catch (_e) {
        void _e;
      }

      db.exec([
        'CREATE TABLE IF NOT EXISTS factory_loop_instances (',
        '  id TEXT PRIMARY KEY,',
        '  project_id TEXT NOT NULL REFERENCES factory_projects(id),',
        '  work_item_id INTEGER REFERENCES factory_work_items(id),',
        '  batch_id TEXT,',
        "  loop_state TEXT NOT NULL DEFAULT 'IDLE',",
        '  paused_at_stage TEXT,',
        '  last_action_at TEXT,',
        "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),",
        '  terminated_at TEXT',
        ')',
      ].join('\n'));
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

        const pausedStage = String(project.loop_paused_at_stage || '').toUpperCase();
        let instanceState = String(project.loop_state || 'IDLE').toUpperCase();
        if (instanceState === 'PAUSED') {
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
          project.loop_last_action_at || new Date().toISOString(),
        );
      }
    },
    down: [
      'DROP INDEX IF EXISTS idx_factory_loop_instances_project_active',
      'DROP INDEX IF EXISTS idx_factory_loop_instances_stage_occupancy',
      'DROP TABLE IF EXISTS factory_loop_instances',
    ].join('; '),
  },
  {
    // factory_worktrees.branch was UNIQUE across all rows, so a merged row
    // with the same branch name blocked any future worktree creation for
    // that item — which (pre-fail-loud-guard) triggered the silent
    // fallback-to-main-worktree bug. Convert to a partial unique index
    // that only enforces uniqueness on active rows; merged/abandoned rows
    // are historical and shouldn't constrain new work.
    version: 26,
    name: 'factory_worktrees_branch_unique_active_only',
    up: [
      'DROP INDEX IF EXISTS idx_factory_worktrees_branch',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_worktrees_branch_active
         ON factory_worktrees(branch)
         WHERE status = 'active'`,
    ].join('; '),
    down: [
      'DROP INDEX IF EXISTS idx_factory_worktrees_branch_active',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_worktrees_branch ON factory_worktrees(branch)',
    ].join('; '),
  },
  {
    version: 27,
    name: 'add_repo_graph_registry',
    up: readSqlMigration('027-repo-graph.sql'),
    down: [
      'DROP INDEX IF EXISTS idx_repo_symbols_qualified',
      'DROP INDEX IF EXISTS idx_repo_symbols_name',
      'DROP TABLE IF EXISTS repo_symbols',
      'DROP TABLE IF EXISTS registered_repos',
    ].join('; '),
  },
  {
    version: 28,
    name: 'add_factory_scout_findings_intake',
    up: [
      'CREATE TABLE IF NOT EXISTS factory_scout_findings_intake (',
      '  project_id TEXT NOT NULL,',
      '  scan_path TEXT NOT NULL,',
      '  finding_hash TEXT NOT NULL,',
      '  work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id) ON DELETE CASCADE,',
      '  created_at TEXT NOT NULL,',
      '  PRIMARY KEY (project_id, scan_path, finding_hash)',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_factory_scout_findings_project ON factory_scout_findings_intake(project_id);',
    ].join('\n'),
    down: [
      'DROP INDEX IF EXISTS idx_factory_scout_findings_project;',
      'DROP TABLE IF EXISTS factory_scout_findings_intake;',
    ].join('\n'),
  },
  {
    version: 29,
    name: 'add_factory_worktrees_owning_task_id',
    up: [
      // Track the in-flight task that currently holds this worktree as its
      // cwd. Used by the pre-reclaim flow: before abandoning a worktree we
      // cancel any active owning task so its process releases file locks
      // (otherwise Windows blocks rm/git worktree remove and the reclaim
      // produces phantom state).
      'ALTER TABLE factory_worktrees ADD COLUMN owning_task_id TEXT',
      'CREATE INDEX IF NOT EXISTS idx_factory_worktrees_owning_task ON factory_worktrees(owning_task_id) WHERE owning_task_id IS NOT NULL',
    ].join('; '),
    down: [
      'DROP INDEX IF EXISTS idx_factory_worktrees_owning_task',
      // SQLite lacks DROP COLUMN on older versions; leave the column on
      // downgrade since it's nullable and unused by earlier code paths.
    ].join('; '),
  },
  {
    version: 30,
    name: 'add_factory_attempt_history_and_silent_rerun_counter',
    up: [
      'CREATE TABLE IF NOT EXISTS factory_attempt_history (',
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
      '  batch_id TEXT NOT NULL,',
      '  work_item_id TEXT NOT NULL,',
      '  attempt INTEGER NOT NULL,',
      '  kind TEXT NOT NULL CHECK (kind IN (\'execute\', \'verify_retry\')),',
      '  task_id TEXT NOT NULL,',
      '  files_touched TEXT,',
      '  file_count INTEGER NOT NULL DEFAULT 0,',
      '  stdout_tail TEXT,',
      '  zero_diff_reason TEXT,',
      '  classifier_source TEXT NOT NULL DEFAULT \'none\' CHECK (classifier_source IN (\'heuristic\', \'llm\', \'none\')),',
      '  classifier_conf REAL,',
      '  verify_output_tail TEXT,',
      '  created_at TEXT NOT NULL',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_factory_attempt_history_batch ON factory_attempt_history(batch_id, attempt);',
      'CREATE INDEX IF NOT EXISTS idx_factory_attempt_history_work_item ON factory_attempt_history(work_item_id, created_at DESC);',
      'ALTER TABLE factory_loop_instances ADD COLUMN verify_silent_reruns INTEGER NOT NULL DEFAULT 0;',
    ].join('\n'),
    down: [
      'DROP INDEX IF EXISTS idx_factory_attempt_history_work_item;',
      'DROP INDEX IF EXISTS idx_factory_attempt_history_batch;',
      'DROP TABLE IF EXISTS factory_attempt_history;',
    ].join('\n'),
  },
  {
    version: 31,
    name: 'add_factory_worktrees_base_branch',
    up: [
      'ALTER TABLE factory_worktrees ADD COLUMN base_branch TEXT',
    ].join('; '),
    // SQLite lacks DROP COLUMN on older versions; leave the nullable column
    // in place on downgrade.
    down: 'SELECT 1',
  },
  {
    version: 32,
    name: 'add_action_state_snapshots',
    up: readSqlMigration('032-action-state-snapshots.sql'),
    down: [
      'DROP INDEX IF EXISTS idx_action_snapshots_app',
      'DROP TABLE IF EXISTS action_state_snapshots',
    ].join('; '),
  },
  {
    version: 33,
    name: 'add_memory_kind_namespace',
    up: readSqlMigration('033-memory-kind-namespace.sql'),
    down: 'DROP INDEX IF EXISTS idx_memories_kind_namespace',
  },
  {
    version: 34,
    name: 'add_specialist_chat_history',
    up: readSqlMigration('034-specialist-chat-history.sql'),
    down: [
      'DROP INDEX IF EXISTS idx_spec_history_agent',
      'DROP INDEX IF EXISTS idx_spec_history_session',
      'DROP TABLE IF EXISTS specialist_chat_history',
    ].join('; '),
  },
  {
    version: 35,
    name: 'add_workflow_checkpoints',
    up: readSqlMigration('035-workflow-checkpoints.sql'),
    down: [
      'DROP INDEX IF EXISTS idx_workflow_checkpoints_step',
      'DROP INDEX IF EXISTS idx_workflow_checkpoints_wf_time',
      'DROP TABLE IF EXISTS workflow_checkpoints',
    ].join('; '),
  },
  {
    version: 36,
    name: 'add_workflow_state_and_fork_columns',
    up: readSqlMigration('036-workflow-state-and-fork-columns.sql'),
    down: [
      'DROP INDEX IF EXISTS idx_workflow_state_updated',
      'DROP TABLE IF EXISTS workflow_state',
    ].join('; '),
  },
  {
    version: 37,
    name: 'idx_fge_batch',
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures that don't include the
      // factory_guardrail_events table. CREATE INDEX IF NOT EXISTS still
      // throws "no such table" when the underlying table is absent —
      // skip the index in that case rather than aborting the migration.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_guardrail_events'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_fge_batch ON factory_guardrail_events (project_id, batch_id, created_at)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_fge_batch',
  },
  {
    version: 38,
    name: 'drop_abandoned_codegraph_tables',
    // Codegraph used to write to tasks.db; commit 66aa6f3e moved it to its own
    // <DATA_DIR>/codegraph.db. Older deployments still carry the now-orphan
    // cg_* tables in tasks.db — they're never read but consume disk and clutter
    // schema dumps. Drop them. cg_class_edges was added AFTER isolation so it
    // never lived in tasks.db; included in IF EXISTS list for completeness.
    up: [
      'DROP INDEX IF EXISTS idx_cg_symbols_name',
      'DROP INDEX IF EXISTS idx_cg_symbols_file',
      'DROP INDEX IF EXISTS idx_cg_refs_target',
      'DROP INDEX IF EXISTS idx_cg_refs_caller',
      'DROP INDEX IF EXISTS idx_cg_dispatch_case',
      'DROP INDEX IF EXISTS idx_cg_dispatch_handler',
      'DROP INDEX IF EXISTS idx_cg_class_sub',
      'DROP INDEX IF EXISTS idx_cg_class_super',
      'DROP TABLE IF EXISTS cg_dispatch_edges',
      'DROP TABLE IF EXISTS cg_class_edges',
      'DROP TABLE IF EXISTS cg_references',
      'DROP TABLE IF EXISTS cg_symbols',
      'DROP TABLE IF EXISTS cg_files',
      'DROP TABLE IF EXISTS cg_index_state',
    ].join('; '),
    // No down — restoring orphaned tables would just recreate them empty.
    // Use `cg_reindex` against the dedicated codegraph.db to repopulate the
    // graph in its proper home if a rollback is ever required.
  },
];

function ensureMigrationTable(sqliteDb) {
  sqliteDb.prepare([
    'CREATE TABLE IF NOT EXISTS schema_migrations (',
    '  version INTEGER PRIMARY KEY,',
    '  name TEXT NOT NULL,',
    '  applied_at TEXT NOT NULL',
    ')',
  ].join('\n')).run();
}

function getAppliedVersions(sqliteDb) {
  const rows = sqliteDb.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  return new Set(rows.map(r => r.version));
}

function runMigrations(sqliteDb) {
  ensureMigrationTable(sqliteDb);
  const applied = getAppliedVersions(sqliteDb);
  let count = 0;

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    // Wrap each migration in a transaction for atomicity
    const runOne = sqliteDb.transaction(() => {
      if (typeof migration.up === 'function') {
        migration.up(sqliteDb);
      } else {
        const stmts = migration.up.split(';').filter(s => s.trim());
        for (const stmt of stmts) {
          try {
            // eslint-disable-next-line torque/no-prepare-in-loop -- migration DDL split into statements; each is unique SQL run exactly once when the migration applies
            sqliteDb.prepare(stmt).run();
          } catch (err) {
            // Tolerate "duplicate column" errors — the column may already exist in the base schema
            if (err.message && err.message.includes('duplicate column')) {
              // Column already exists, migration is effectively a no-op for this statement
            } else {
              throw err;
            }
          }
        }
      }

      // eslint-disable-next-line torque/no-prepare-in-loop -- inside the per-migration runOne transaction; each migration applies exactly once at startup, no cache benefit across the runner's lifetime
      sqliteDb.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(migration.version, migration.name, new Date().toISOString());
    });

    try {
      runOne();
      count++;
    } catch (err) {
      console.error('Migration ' + migration.version + ' (' + migration.name + ') failed:', err.message);
      throw err;
    }
  }

  return count;
}

function rollbackMigration(sqliteDb, version) {
  const migration = MIGRATIONS.find(function(m) { return m.version === version; });
  if (!migration) throw new Error('Migration ' + version + ' not found');
  if (!migration.down) throw new Error('Migration ' + version + ' has no rollback');

  try {
    sqliteDb.prepare(migration.down).run();
  } catch (_err) {
    void _err;
    const stmts = migration.down.split(';').filter(function(s) { return s.trim(); });
    for (const stmt of stmts) {
      // eslint-disable-next-line torque/no-prepare-in-loop -- rollback DDL split into statements; each is unique SQL run exactly once during rollback
      sqliteDb.prepare(stmt).run();
    }
  }
  sqliteDb.prepare('DELETE FROM schema_migrations WHERE version = ?').run(version);
}

module.exports = { runMigrations, rollbackMigration, MIGRATIONS };
