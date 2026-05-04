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
  {
    version: 39,
    name: 'add_benchmark_results_host_id_index',
    // server/db/host-benchmarking.js runs five host-scoped queries against
    // benchmark_results, each filtering on `WHERE host_id = ?` (with
    // additional predicates on model/success/tokens_per_second). The
    // table only had `id INTEGER PRIMARY KEY`, so every host-stats lookup
    // was a full scan. This grows linearly with benchmark history,
    // multiplied by host count — the static DB-query audit (62 warnings
    // before this) flagged all five lines.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures that don't include the
      // benchmark_results table. CREATE INDEX IF NOT EXISTS throws
      // "no such table" when the underlying table is absent — skip the
      // index in that case rather than aborting the migration. Same
      // pattern as migration 37 for factory_guardrail_events.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='benchmark_results'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_benchmark_results_host ON benchmark_results(host_id, success)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_benchmark_results_host',
  },
  {
    version: 40,
    name: 'add_quality_scores_scored_at_index',
    // server/db/file-quality.js runs two stats queries against
    // quality_scores filtering on `WHERE scored_at >= ?` (overall stats
    // and per-provider stats since timestamp). The table only carried
    // task_id and provider indexes — every stats roll-up was a full
    // scan that grows linearly with task history. Adding an index on
    // scored_at gives the dashboard's quality-stats panel a real seek.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures that don't include the
      // quality_scores table. Same pattern as v37 / v39.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='quality_scores'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_quality_scores_scored_at ON quality_scores(scored_at)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_quality_scores_scored_at',
  },
  {
    version: 41,
    name: 'add_validation_results_validated_at_severity_index',
    // server/db/file-quality.js#getValidationFailureRate runs two
    // queries on validation_results filtering on `WHERE validated_at >= ?`
    // (and one with an additional `severity IN ('error', 'critical')`).
    // The table only had task_id and status indexes — every dashboard
    // refresh of the validation-failure-rate widget was a full scan that
    // grows linearly with task history. Composite (validated_at, severity)
    // covers both queries: time-range seek on the leading column, then
    // the in-list filter is pushed into the index walk for the second.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures. Same pattern as v37 / v39 / v40.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='validation_results'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_validation_results_validated_at ON validation_results(validated_at, severity)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_validation_results_validated_at',
  },
  {
    version: 42,
    name: 'add_task_streams_created_at_index',
    // server/db/webhooks-streaming.js runs two cleanup queries against
    // task_streams filtering on `WHERE created_at < ?` to expire old
    // streams (one for purging chunks tied to expired streams, one for
    // deleting the streams themselves). The table only carried a
    // task_id index, so each cleanup tick was a full scan growing with
    // total stream history. An index on created_at lets the cleanup
    // sweep seek directly to expired rows.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures. Same pattern as v37 / v39 / v40 / v41.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_streams'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_task_streams_created_at ON task_streams(created_at)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_task_streams_created_at',
  },
  {
    version: 43,
    name: 'add_factory_worktrees_batch_id_index',
    // server/db/factory/worktrees.js#getActiveWorktreeByBatch is on the
    // factory-tick hot path — when a stage reuses a worktree for the
    // same batch it queries `WHERE batch_id = ? AND status = 'active'`.
    // The table already had an index on (project_id, status) but
    // nothing leading on batch_id, so each tick walked the table.
    // Composite (batch_id, status) seeks directly to the matching rows
    // and lines up with the existing project_id+status pattern.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures. Same pattern as v37 / v39 / v40 / v41 / v42.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_worktrees'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_factory_worktrees_batch ON factory_worktrees(batch_id, status)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_factory_worktrees_batch',
  },
  {
    version: 44,
    name: 'add_distributed_locks_expires_at_index',
    // server/db/coordination.js#cleanupExpiredLocks runs
    // `DELETE FROM distributed_locks WHERE expires_at < ?` on every
    // maintenance tick. The table only had `lock_name PRIMARY KEY`,
    // so the cleanup walked every row to find expired ones. An index
    // on expires_at lets the sweep seek straight to the dead-rows
    // range, especially valuable when many transient locks accumulate
    // between sweeps.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures. Same pattern as v37 / v39+.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='distributed_locks'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_distributed_locks_expires_at ON distributed_locks(expires_at)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_distributed_locks_expires_at',
  },
  {
    version: 45,
    name: 'add_adversarial_reviews_review_task_id_index',
    // server/db/adversarial-reviews.js#getReviewByReviewTaskId runs
    // `SELECT * FROM adversarial_reviews WHERE review_task_id = ?`
    // — a single-row foreign-key lookup invoked from the close-handler
    // pipeline whenever a review task completes. The table already had
    // task_id and verdict indexes but nothing on review_task_id, so
    // each lookup walked the whole adversarial-reviews history.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures. Same pattern as v37 / v39+.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='adversarial_reviews'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_adversarial_reviews_review_task ON adversarial_reviews(review_task_id)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_adversarial_reviews_review_task',
  },
  {
    version: 46,
    name: 'add_ci_run_cache_created_at_index',
    // server/db/ci-cache.js#pruneCiRunCache runs
    // `DELETE FROM ci_run_cache WHERE created_at < datetime('now', ?)`
    // periodically to age out stale CI cache entries (default 7 days).
    // The table had repo+branch and commit_sha indexes but nothing on
    // created_at, so each prune walked every cached row. An index on
    // created_at lets the cleanup seek straight to expired rows.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures. Same pattern as v37 / v39+.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ci_run_cache'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_ci_run_cache_created_at ON ci_run_cache(created_at)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_ci_run_cache_created_at',
  },
  {
    version: 47,
    name: 'add_file_locks_released_at_index',
    // server/db/file-baselines.js#getActiveFileLocks (no-task-id case)
    // and #releaseExpiredFileLocks both filter on
    // `WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`
    // — the active-lock sweep used by every file-baseline open. The
    // table had file_path+working_directory and task_id indexes, but
    // nothing led on released_at, so each sweep walked every row of
    // lock history (released or not). A composite (released_at,
    // expires_at) index lets SQLite's index-on-NULL machinery seek
    // straight to the unreleased rows and range-filter expires_at.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures. Same pattern as v37 / v39+.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_locks'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_file_locks_active ON file_locks(released_at, expires_at)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_file_locks_active',
  },
  {
    version: 48,
    name: 'add_tasks_review_status_index',
    // server/db/host-management.js#getTasksNeedingCorrection runs
    // `SELECT * FROM tasks WHERE review_status = 'needs_correction'`
    // for the dashboard's correction-queue widget. The tasks table
    // is the largest in the deployment (one row per submitted task),
    // and review_status was un-indexed, so each dashboard refresh
    // walked every historical task row. Since needs_correction is a
    // small subset of all rows, an index on review_status is highly
    // selective and cheap to maintain.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures. Same pattern as v37 / v39+.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_tasks_review_status ON tasks(review_status)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_tasks_review_status',
  },
  {
    version: 49,
    name: 'add_pipeline_steps_status_index',
    // server/db/pipeline-crud.js scans pipeline_steps for stuck steps:
    // `WHERE ps.status = 'running' AND t.status IN (...)` joined with
    // tasks. The table only had (pipeline_id, step_order); the
    // status-leading filter walked every step row before joining.
    // Since 'running' is a small subset of completed/failed history,
    // an index on status is highly selective.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures. Same pattern as v37 / v39+.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pipeline_steps'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_pipeline_steps_status ON pipeline_steps(status)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_pipeline_steps_status',
  },
  {
    version: 50,
    name: 'add_verification_checks_workflow_and_created_at_indexes',
    // server/db/verification-ledger.js runs two queries on
    // verification_checks that lacked covering indexes:
    //   - getCheckSummary(workflowId): WHERE workflow_id = ? GROUP BY ...
    //   - pruneOldChecks: DELETE WHERE created_at < ?
    // The table had task_id and phase indexes but nothing on
    // workflow_id or created_at, so both the ledger summary and the
    // 90-day retention prune walked every check row. Adding both
    // indexes lets each query seek directly.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures. Same pattern as v37 / v39+.
      const tableExists = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='verification_checks'"
      ).get();
      if (!tableExists) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_verification_checks_workflow ON verification_checks(workflow_id)'
      ).run();
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_verification_checks_created_at ON verification_checks(created_at)'
      ).run();
    },
    down: [
      'DROP INDEX IF EXISTS idx_verification_checks_workflow',
      'DROP INDEX IF EXISTS idx_verification_checks_created_at',
    ].join('; '),
  },
  {
    version: 51,
    name: 'add_replan_recovery_columns',
    up: (db) => {
      const tryAlter = (sql) => {
        try { db.prepare(sql).run(); } catch (_e) { void _e; }
      };
      tryAlter('ALTER TABLE factory_work_items ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0');
      tryAlter('ALTER TABLE factory_work_items ADD COLUMN last_recovery_at TEXT');
      tryAlter('ALTER TABLE factory_work_items ADD COLUMN recovery_history_json TEXT');
      tryAlter('ALTER TABLE factory_work_items ADD COLUMN depth INTEGER NOT NULL DEFAULT 0');
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_factory_work_items_replan_eligibility
        ON factory_work_items(status, recovery_attempts, last_recovery_at)
        WHERE status IN ('rejected', 'unactionable')
      `).run();
    },
    // No down — column drops on SQLite require table rebuild; not worth it for an additive migration.
  },
  {
    version: 52,
    name: 'add_misc_cleanup_prune_indexes',
    // Two small cleanup-query indexes on growing tables. Both
    // periodically prune by timestamp; without an index, each prune
    // walks the full retention window of rows.
    //   - task_cache.created_at: project-cache.js#purgeOlderThan
    //   - task_file_writes.written_at: resource-health.js prune sweep
    //
    // The audit also flags token_usage with `WHERE provider IS NOT NULL`,
    // but that's a dead branch — token_usage has no `provider` column;
    // the query in provider-routing-core.js is wrapped in try/catch
    // with a "may not have provider column" comment, so the SELECT
    // always throws and falls through. No index needed; the audit
    // false-positive there reflects a schema/code mismatch worth
    // cleaning up separately.
    up: function(sqliteDb) {
      // Tolerate minimal-schema test fixtures. Same pattern as v37 / v39+.
      const hasTable = (name) => sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
      ).get(name);
      if (hasTable('task_cache')) {
        sqliteDb.prepare(
          'CREATE INDEX IF NOT EXISTS idx_task_cache_created_at ON task_cache(created_at)'
        ).run();
      }
      if (hasTable('task_file_writes')) {
        sqliteDb.prepare(
          'CREATE INDEX IF NOT EXISTS idx_task_file_writes_written_at ON task_file_writes(written_at)'
        ).run();
      }
    },
    down: [
      'DROP INDEX IF EXISTS idx_task_cache_created_at',
      'DROP INDEX IF EXISTS idx_task_file_writes_written_at',
    ].join('; '),
  },
  {
    version: 53,
    name: 'add_factory_decisions_batch_id_index',
    // factory_decisions is the event-sourcing log for the factory loop;
    // grows by ~10 rows per work item. Two hot lookups full-scan it
    // today:
    //   - recovery-inbox-handlers.js#decisionsForItem: WHERE batch_id = ?
    //   - rejected-recovery.js#countPriorReopens: WHERE action = ? AND batch_id = ?
    // A single batch_id index covers both — `action` is filtered post-seek
    // on the small per-batch result set.
    up: function(sqliteDb) {
      const hasTable = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_decisions'"
      ).get();
      if (!hasTable) return;
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_factory_decisions_batch_id ON factory_decisions(batch_id)'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_factory_decisions_batch_id',
  },
  {
    version: 54,
    name: 'add_remaining_query_indexes',
    // Round-3 perf indexes for queries flagged by audit-db-queries:
    //   - adversarial_reviews(created_at): getReviewStats's
    //     `WHERE created_at >= ?` time-windowed aggregate.
    //   - vc_worktrees(repo_path): worktree-reconcile equality lookup;
    //     repo_path is the natural lookup key but had no index.
    //   - tasks(git_after_sha) PARTIAL: getTasksWithCommits filters
    //     `WHERE git_after_sha IS NOT NULL` — most tasks never produce
    //     a commit so the partial index stays tiny while covering the
    //     hot rollback-candidate query.
    //   - maintenance_schedule(next_run_at) PARTIAL on enabled=1: the
    //     scheduler tick reads `WHERE enabled = 1 AND next_run_at IS NOT
    //     NULL AND next_run_at <= ?` on every cycle.
    // v37+ table-existence guard preserved for minimal-schema test fixtures.
    up: function(sqliteDb) {
      const hasTable = (name) => sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
      ).get(name);
      if (hasTable('adversarial_reviews')) {
        sqliteDb.prepare(
          'CREATE INDEX IF NOT EXISTS idx_adversarial_reviews_created_at ON adversarial_reviews(created_at)'
        ).run();
      }
      if (hasTable('vc_worktrees')) {
        sqliteDb.prepare(
          'CREATE INDEX IF NOT EXISTS idx_vc_worktrees_repo_path ON vc_worktrees(repo_path)'
        ).run();
      }
      if (hasTable('tasks')) {
        sqliteDb.prepare(
          'CREATE INDEX IF NOT EXISTS idx_tasks_git_after_sha ON tasks(git_after_sha) WHERE git_after_sha IS NOT NULL'
        ).run();
      }
      if (hasTable('maintenance_schedule')) {
        sqliteDb.prepare(
          'CREATE INDEX IF NOT EXISTS idx_maintenance_schedule_next_run_at ON maintenance_schedule(next_run_at) WHERE enabled = 1 AND next_run_at IS NOT NULL'
        ).run();
      }
    },
    down: [
      'DROP INDEX IF EXISTS idx_adversarial_reviews_created_at',
      'DROP INDEX IF EXISTS idx_vc_worktrees_repo_path',
      'DROP INDEX IF EXISTS idx_tasks_git_after_sha',
      'DROP INDEX IF EXISTS idx_maintenance_schedule_next_run_at',
    ].join('; '),
  },
  {
    version: 55,
    name: 'add_routing_templates_capability_constraints',
    // Phase B of the routing-templates fold-in arc: templates can now
    // declare capability constraints (max_files per provider,
    // greenfield_provider, modification_oversize_provider) so
    // hardcoded routing logic in db/smart-routing.js
    // matchProviderByPattern and handlers/integration/routing.js
    // resolveModificationRouting can be replaced with data-driven
    // template lookups. Stored as a JSON blob alongside rules_json.
    up: function(sqliteDb) {
      const hasTable = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='routing_templates'"
      ).get();
      if (!hasTable) return;
      const cols = sqliteDb.prepare("PRAGMA table_info(routing_templates)").all();
      const hasColumn = cols.some((c) => c.name === 'capability_constraints_json');
      if (!hasColumn) {
        sqliteDb.prepare(
          'ALTER TABLE routing_templates ADD COLUMN capability_constraints_json TEXT'
        ).run();
      }
    },
    // No down — column drops on SQLite require table rebuild; not worth it for an additive migration.
  },
  {
    version: 56,
    name: 'add_task_subprocess_recovery_columns',
    // Phase A of the subprocess-detachment arc (see
    // docs/design/2026-05-03-subprocess-detachment-codex-spike.md).
    // These columns are the persistent anchors that let a fresh TORQUE
    // instance re-adopt a running subprocess after a restart instead
    // of marking it cancelled via the startup-task-reconciler:
    //
    //   subprocess_pid       — OS PID of the spawned CLI (codex, etc.)
    //   output_log_path      — absolute path to the on-disk stdout log
    //   error_log_path       — absolute path to the on-disk stderr log
    //   output_log_offset    — bytes of stdout already consumed by the
    //                          output handler; the tailer resumes from
    //                          this byte after re-adoption
    //   error_log_offset     — same, for stderr
    //   last_activity_at     — wall-clock timestamp of the most recent
    //                          chunk-or-write the runner saw, persisted
    //                          at a throttled cadence so stall
    //                          detection has a recent floor after a
    //                          restart
    //
    // Phase A only adds the schema; no caller writes to these columns
    // yet. The detached spawn path that populates them ships in Phase
    // B behind a feature flag (TORQUE_DETACHED_SUBPROCESSES).
    up: function(sqliteDb) {
      const hasTable = sqliteDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'"
      ).get();
      if (!hasTable) return;
      const cols = sqliteDb.prepare("PRAGMA table_info(tasks)").all();
      const has = (name) => cols.some((c) => c.name === name);
      const adds = [
        ['subprocess_pid', 'INTEGER'],
        ['output_log_path', 'TEXT'],
        ['error_log_path', 'TEXT'],
        ['output_log_offset', 'INTEGER DEFAULT 0'],
        ['error_log_offset', 'INTEGER DEFAULT 0'],
        ['last_activity_at', 'TEXT'],
      ];
      for (const [name, type] of adds) {
        if (!has(name)) {
          // eslint-disable-next-line torque/no-prepare-in-loop -- one-shot DDL; each ALTER TABLE is unique SQL run exactly once when this migration applies, so PreparedStatement caching has no benefit
          sqliteDb.prepare(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`).run();
        }
      }
      // Partial index — most tasks never have a subprocess_pid (queued,
      // already finalized, or non-CLI providers), so a partial index
      // keeps the on-disk size minimal while still covering the
      // re-adoption hot path: SELECT WHERE status IN ('running','claimed')
      //                        AND subprocess_pid IS NOT NULL.
      sqliteDb.prepare(
        'CREATE INDEX IF NOT EXISTS idx_tasks_subprocess_pid ON tasks(subprocess_pid) WHERE subprocess_pid IS NOT NULL'
      ).run();
    },
    down: 'DROP INDEX IF EXISTS idx_tasks_subprocess_pid',
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
