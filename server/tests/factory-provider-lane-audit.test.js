'use strict';

const Database = require('better-sqlite3');
const { buildProviderLaneAudit } = require('../factory/provider-lane-audit');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT,
      project TEXT,
      provider TEXT,
      model TEXT,
      original_provider TEXT,
      tags TEXT,
      metadata TEXT,
      task_metadata TEXT,
      working_directory TEXT,
      created_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      files_modified TEXT,
      task_description TEXT,
      output TEXT,
      error_output TEXT
    )
  `);
  return db;
}

function insertTask(db, overrides) {
  const row = {
    id: overrides.id,
    status: overrides.status || 'completed',
    project: overrides.project || 'factory-plan',
    provider: overrides.provider || 'ollama-cloud',
    model: overrides.model || 'mistral-large-3:675b',
    original_provider: overrides.original_provider || null,
    tags: JSON.stringify(overrides.tags || ['factory:internal', 'factory:project_id=proj-1', 'factory:target_project=DLPhone']),
    metadata: JSON.stringify(overrides.metadata || { target_project: 'DLPhone', project_id: 'proj-1' }),
    task_metadata: JSON.stringify(overrides.task_metadata || {}),
    working_directory: overrides.working_directory || 'C:\\Projects\\DLPhone',
    created_at: overrides.created_at || '2026-04-25T17:00:00.000Z',
    started_at: overrides.started_at || null,
    completed_at: overrides.completed_at || null,
    files_modified: JSON.stringify(overrides.files_modified || []),
    task_description: overrides.task_description || 'Factory task',
    output: overrides.output || null,
    error_output: overrides.error_output || null,
  };
  db.prepare(`
    INSERT INTO tasks (
      id, status, project, provider, model, original_provider, tags, metadata, task_metadata,
      working_directory, created_at, started_at, completed_at, files_modified,
      task_description, output, error_output
    ) VALUES (
      @id, @status, @project, @provider, @model, @original_provider, @tags, @metadata, @task_metadata,
      @working_directory, @created_at, @started_at, @completed_at, @files_modified,
      @task_description, @output, @error_output
    )
  `).run(row);
}

describe('provider lane audit', () => {
  const project = {
    id: 'proj-1',
    name: 'DLPhone',
    path: 'C:\\Projects\\DLPhone',
    config_json: JSON.stringify({
      provider_lane_policy: {
        expected_provider: 'ollama-cloud',
        allowed_fallback_providers: [],
        require_classified_fallback: true,
      },
    }),
  };

  it('summarizes project provider usage and flags Codex drift from an Ollama Cloud lane', () => {
    const db = createDb();
    insertTask(db, {
      id: 'ollama-running',
      status: 'running',
      metadata: {
        target_project: 'DLPhone',
        project_id: 'proj-1',
        work_item_id: 885,
        _routing_template: 'preset-ollama-cloud-primary',
      },
      created_at: '2026-04-25T17:03:00.000Z',
    });
    insertTask(db, {
      id: 'codex-classified',
      provider: 'codex',
      model: null,
      original_provider: 'ollama-cloud',
      files_modified: ['src/Lan.cs'],
      metadata: {
        target_project: 'DLPhone',
        project_id: 'proj-1',
        work_item_id: 885,
        _routing_template: 'preset-ollama-cloud-primary',
        agentic_handoff: true,
        agentic_handoff_from: 'ollama-cloud',
        agentic_handoff_to: 'codex',
        agentic_handoff_reason: 'Agentic no-op from ollama-cloud',
      },
      created_at: '2026-04-25T17:02:00.000Z',
    });
    insertTask(db, {
      id: 'codex-unclassified',
      provider: 'codex',
      model: null,
      metadata: {
        target_project: 'DLPhone',
        project_id: 'proj-1',
        work_item_id: 884,
      },
      created_at: '2026-04-25T17:01:00.000Z',
    });
    insertTask(db, {
      id: 'unrelated',
      provider: 'codex',
      project: 'OtherProject',
      tags: ['factory:project_id=other'],
      metadata: { target_project: 'OtherProject', project_id: 'other' },
      working_directory: 'C:\\Other',
      created_at: '2026-04-25T17:04:00.000Z',
    });

    const audit = buildProviderLaneAudit({ db, project, limit: 10 });

    expect(audit.summary.total_tasks).toBe(3);
    expect(audit.summary.active_tasks).toBe(1);
    expect(audit.summary.file_change_tasks).toBe(1);
    expect(audit.summary.by_provider).toEqual([
      { key: 'codex', count: 2 },
      { key: 'ollama-cloud', count: 1 },
    ]);
    expect(audit.guard.status).toBe('fail');
    expect(audit.guard.violations).toEqual([
      expect.objectContaining({ task_id: 'codex-classified', type: 'provider_drift' }),
      expect.objectContaining({ task_id: 'codex-unclassified', type: 'provider_drift' }),
    ]);
  });

  it('allows classified fallback providers while still flagging unclassified fallback drift', () => {
    const db = createDb();
    insertTask(db, {
      id: 'codex-classified',
      provider: 'codex',
      original_provider: 'ollama-cloud',
      metadata: {
        target_project: 'DLPhone',
        project_id: 'proj-1',
        agentic_handoff: true,
        agentic_handoff_from: 'ollama-cloud',
        agentic_handoff_to: 'codex',
        fallback_reason: 'proposal apply skipped: no file_edits JSON found',
      },
      created_at: '2026-04-25T17:02:00.000Z',
    });
    insertTask(db, {
      id: 'codex-unclassified',
      provider: 'codex',
      metadata: { target_project: 'DLPhone', project_id: 'proj-1' },
      created_at: '2026-04-25T17:01:00.000Z',
    });

    const audit = buildProviderLaneAudit({
      db,
      project,
      expected_provider: 'ollama-cloud',
      allowed_fallback_providers: ['codex'],
      require_classified_fallback: true,
    });

    expect(audit.guard.status).toBe('fail');
    expect(audit.guard.warnings).toEqual([
      expect.objectContaining({ task_id: 'codex-classified', type: 'allowed_fallback_used' }),
    ]);
    expect(audit.guard.violations).toEqual([
      expect.objectContaining({ task_id: 'codex-unclassified', type: 'unclassified_allowed_fallback' }),
    ]);

    const permissive = buildProviderLaneAudit({
      db,
      project,
      expected_provider: 'ollama-cloud',
      allowed_fallback_providers: ['codex'],
      require_classified_fallback: false,
    });

    expect(permissive.guard.status).toBe('warn');
    expect(permissive.guard.violations_count).toBe(0);
    expect(permissive.guard.warnings_count).toBe(2);
  });

  it('limits the guard window to tasks after the policy effective timestamp', () => {
    const db = createDb();
    const configuredProject = {
      ...project,
      config_json: JSON.stringify({
        provider_lane_policy: {
          expected_provider: 'ollama-cloud',
          allowed_fallback_providers: [],
          effective_since: '2026-04-25T17:02:00.000Z',
        },
      }),
    };
    insertTask(db, {
      id: 'pre-policy-codex',
      provider: 'codex',
      metadata: { target_project: 'DLPhone', project_id: 'proj-1' },
      created_at: '2026-04-25T17:01:59.000Z',
    });
    insertTask(db, {
      id: 'post-policy-ollama',
      provider: 'ollama-cloud',
      metadata: { target_project: 'DLPhone', project_id: 'proj-1' },
      created_at: '2026-04-25T17:02:00.000Z',
    });

    const audit = buildProviderLaneAudit({ db, project: configuredProject });

    expect(audit.policy.effective_since).toBe('2026-04-25T17:02:00.000Z');
    expect(audit.window.effective_since).toBe('2026-04-25T17:02:00.000Z');
    expect(audit.summary.total_tasks).toBe(1);
    expect(audit.tasks.map((task) => task.id)).toEqual(['post-policy-ollama']);
    expect(audit.guard.status).toBe('pass');
  });

  it('does not let undefined handler options erase project provider-lane config', () => {
    const db = createDb();
    const configuredProject = {
      ...project,
      config_json: JSON.stringify({
        provider_lane_policy: {
          expected_provider: 'ollama-cloud',
          allowed_fallback_providers: ['codex'],
          require_classified_fallback: false,
        },
      }),
    };
    insertTask(db, {
      id: 'codex-fallback',
      provider: 'codex',
      metadata: { target_project: 'DLPhone', project_id: 'proj-1' },
    });

    const audit = buildProviderLaneAudit({
      db,
      project: configuredProject,
      allowed_fallback_providers: undefined,
      require_classified_fallback: undefined,
    });

    expect(audit.policy.allowed_fallback_providers).toEqual(['codex']);
    expect(audit.policy.require_classified_fallback).toBe(false);
    expect(audit.guard.status).toBe('warn');
    expect(audit.guard.violations_count).toBe(0);
  });
});
