'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { setupTestDb, teardownTestDb } = require('./vitest-setup');

const factoryArchitect = require('../db/factory-architect');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const factoryWorktrees = require('../db/factory-worktrees');

function ensureFactoryTables(dbHandle) {
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      loop_state TEXT DEFAULT 'IDLE',
      loop_batch_id TEXT,
      loop_last_action_at TEXT,
      loop_paused_at_stage TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      dimension TEXT NOT NULL,
      score REAL NOT NULL,
      details_json TEXT,
      scan_type TEXT NOT NULL DEFAULT 'incremental',
      batch_id TEXT,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      source TEXT NOT NULL,
      origin_json TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      requestor TEXT,
      constraints_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      linked_item_id INTEGER,
      batch_id TEXT,
      claimed_by_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_loop_instances (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      work_item_id INTEGER REFERENCES factory_work_items(id),
      batch_id TEXT,
      loop_state TEXT NOT NULL DEFAULT 'IDLE',
      paused_at_stage TEXT,
      last_action_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      terminated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS factory_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      stage TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      reasoning TEXT,
      inputs_json TEXT,
      outcome_json TEXT,
      confidence REAL,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_architect_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      input_snapshot_json TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      backlog_json TEXT NOT NULL,
      flags_json TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      trigger TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id),
      batch_id TEXT NOT NULL,
      vc_worktree_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT,
      worktree_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      merged_at TEXT,
      abandoned_at TEXT
    );
  `);

  try { dbHandle.exec('ALTER TABLE factory_worktrees ADD COLUMN base_branch TEXT'); } catch { /* exists */ }
  try { dbHandle.exec('ALTER TABLE factory_worktrees ADD COLUMN updated_at TEXT'); } catch { /* exists */ }
}

function wireFactoryDbModules(dbHandle) {
  factoryArchitect.setDb(dbHandle);
  factoryDecisions.setDb(dbHandle);
  factoryHealth.setDb(dbHandle);
  factoryIntake.setDb(dbHandle);
  factoryLoopInstances.setDb(dbHandle);
  factoryWorktrees.setDb(dbHandle);
}

function seedProjectItemAndWorktree(dbHandle, { trust = 'autonomous', originOverrides = {} } = {}) {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-e2e-'));
  const worktreeAbsPath = path.join(tempPath, '.worktrees', 'feat-test');
  // Retry-fix path short-circuits with 'cwd_missing' if the worktree dir
  // doesn't exist; create it so retry can proceed.
  fs.mkdirSync(worktreeAbsPath, { recursive: true });

  const projectId = `proj-vr-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  dbHandle.prepare(`
    INSERT INTO factory_projects (id, name, path, trust_level, status, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'running', '{}', datetime('now'), datetime('now'))
  `).run(projectId, 'Test', tempPath, trust);

  const { lastInsertRowid: workItemId } = dbHandle.prepare(`
    INSERT INTO factory_work_items (project_id, source, title, description, priority, status, origin_json, created_at, updated_at)
    VALUES (?, 'architect', 'test item', 'desc', 50, 'executing', ?, datetime('now'), datetime('now'))
  `).run(projectId, JSON.stringify({ plan_path: path.join(tempPath, 'plan.md'), ...originOverrides }));

  const batchId = `factory-${projectId}-${workItemId}`;
  dbHandle.prepare(`
    INSERT INTO factory_worktrees (project_id, work_item_id, batch_id, branch, base_branch, worktree_path, vc_worktree_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'main', ?, 'vcid1', 'active', datetime('now'), datetime('now'))
  `).run(projectId, workItemId, batchId, `feat/factory-${workItemId}-test`, worktreeAbsPath);

  return { projectId, workItemId, batchId, tempPath, worktreeAbsPath };
}

describe('executeVerifyStage + verify-review integration', () => {
  let dbModule;
  let dbHandle;

  beforeEach(() => {
    ({ db: dbModule } = setupTestDb('verify-review-e2e'));
    dbHandle = dbModule.getDbInstance();
    ensureFactoryTables(dbHandle);
    wireFactoryDbModules(dbHandle);
  });

  afterEach(() => {
    try {
      const loopController = require('../factory/loop-controller');
      loopController.setWorktreeRunnerForTests(null);
    } catch { /* ok */ }
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('Scenario 1 (task_caused): retry fires, existing flow unchanged', async () => {
    const loopController = require('../factory/loop-controller');
    const verifyReview = require('../factory/verify-review');
    const routingModule = require('../handlers/integration/routing');
    const awaitModule = require('../handlers/workflow/await');
    const taskCore = require('../db/task-core');
    const guardrailRunner = require('../factory/guardrail-runner');
    const branchFreshness = require('../factory/branch-freshness');

    const { projectId, workItemId, batchId, worktreeAbsPath } = seedProjectItemAndWorktree(dbHandle);

    const verify = vi.fn()
      .mockResolvedValueOnce({ passed: false, exitCode: 1, stdout: 'FAIL  tests/foo.test.ts', stderr: '', output: 'FAIL  tests/foo.test.ts', durationMs: 100, timedOut: false })
      .mockResolvedValueOnce({ passed: true, exitCode: 0, stdout: 'PASS', stderr: '', output: 'PASS', durationMs: 50, timedOut: false });
    loopController.setWorktreeRunnerForTests({ verify });

    const freshnessSpy = vi.spyOn(branchFreshness, 'checkBranchFreshness').mockResolvedValue({
      stale: false,
      reason: null,
      commitsBehind: 0,
      staleFiles: [],
    });
    const reviewSpy = vi.spyOn(verifyReview, 'reviewVerifyFailure').mockResolvedValue({
      classification: 'task_caused',
      confidence: 'high',
      modifiedFiles: ['tests/foo.test.ts'],
      failingTests: ['tests/foo.test.ts'],
      intersection: ['tests/foo.test.ts'],
      environmentSignals: [],
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: null,
    });

    vi.spyOn(routingModule, 'handleSmartSubmitTask').mockResolvedValue({ task_id: 't-retry' });
    vi.spyOn(awaitModule, 'handleAwaitTask').mockResolvedValue({ status: 'completed' });
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
      id: 't-retry',
      status: 'completed',
      output: '',
      error_output: null,
    });

    // After verify passes, the function falls through to guardrail checks.
    // Stub them to a clean passed result so we can assert on the canonical
    // verify-passed path without noise from the guardrail engine.
    vi.spyOn(guardrailRunner, 'runPostBatchChecks').mockReturnValue({
      status: 'passed',
      passed: true,
      results: [],
      batch_id: batchId,
    });

    const instance = { id: 'inst-1', project_id: projectId, batch_id: batchId, work_item_id: workItemId };
    const r = await loopController.executeVerifyStage(projectId, batchId, instance);

    expect(r.status).toBe('passed');
    expect(verify).toHaveBeenCalledTimes(2);
    expect(freshnessSpy).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: worktreeAbsPath,
      branch: `feat/factory-${workItemId}-test`,
      baseRef: 'main',
      threshold: 0,
    }));
    expect(verify).toHaveBeenNthCalledWith(1, expect.objectContaining({
      worktreePath: worktreeAbsPath,
      branch: `feat/factory-${workItemId}-test`,
      baseBranch: 'main',
    }));
    expect(reviewSpy).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: worktreeAbsPath,
      worktreeBranch: `feat/factory-${workItemId}-test`,
      mergeBase: 'main',
    }));

    const item = dbHandle.prepare('SELECT status FROM factory_work_items WHERE id = ?').get(workItemId);
    expect(item.status).not.toBe('rejected');

    const project = dbHandle.prepare('SELECT status FROM factory_projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('running');
  });

  it('rechecks branch freshness after a failed verify and rebases before classifier triage', async () => {
    const loopController = require('../factory/loop-controller');
    const verifyReview = require('../factory/verify-review');
    const guardrailRunner = require('../factory/guardrail-runner');
    const branchFreshness = require('../factory/branch-freshness');

    const { projectId, workItemId, batchId, worktreeAbsPath } = seedProjectItemAndWorktree(dbHandle);

    const verify = vi.fn()
      .mockResolvedValueOnce({
        passed: false,
        exitCode: 1,
        stdout: 'FAIL stale baseline',
        stderr: '',
        output: 'FAIL stale baseline',
        durationMs: 100,
        timedOut: false,
      })
      .mockResolvedValueOnce({
        passed: true,
        exitCode: 0,
        stdout: 'PASS',
        stderr: '',
        output: 'PASS',
        durationMs: 50,
        timedOut: false,
      });
    loopController.setWorktreeRunnerForTests({ verify });

    const freshnessSpy = vi.spyOn(branchFreshness, 'checkBranchFreshness')
      .mockResolvedValueOnce({
        stale: false,
        reason: null,
        commitsBehind: 0,
        staleFiles: [],
      })
      .mockResolvedValueOnce({
        stale: true,
        reason: 'behind_threshold',
        commitsBehind: 8,
        staleFiles: [],
      });
    const rebaseSpy = vi.spyOn(branchFreshness, 'attemptRebase').mockResolvedValue({ ok: true });
    const reviewSpy = vi.spyOn(verifyReview, 'reviewVerifyFailure');
    vi.spyOn(guardrailRunner, 'runPostBatchChecks').mockReturnValue({
      status: 'passed',
      passed: true,
      results: [],
      batch_id: batchId,
    });

    const instance = { id: 'inst-stale', project_id: projectId, batch_id: batchId, work_item_id: workItemId };
    const result = await loopController.executeVerifyStage(projectId, batchId, instance);

    expect(result.status).toBe('passed');
    expect(verify).toHaveBeenCalledTimes(2);
    expect(freshnessSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      worktreePath: worktreeAbsPath,
      branch: `feat/factory-${workItemId}-test`,
      baseRef: 'main',
      threshold: 0,
    }));
    expect(freshnessSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      worktreePath: worktreeAbsPath,
      branch: `feat/factory-${workItemId}-test`,
      baseRef: 'main',
      threshold: 0,
    }));
    expect(rebaseSpy).toHaveBeenCalledWith(
      worktreeAbsPath,
      `feat/factory-${workItemId}-test`,
      'main',
    );
    expect(reviewSpy).not.toHaveBeenCalled();
  });

  it('Scenario 2 (baseline_broken): rejects item, pauses project, emits event', async () => {
    const loopController = require('../factory/loop-controller');
    const verifyReview = require('../factory/verify-review');
    const eventBus = require('../event-bus');

    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(dbHandle);

    const verify = vi.fn().mockResolvedValue({
      passed: false,
      exitCode: 1,
      stdout: 'FAILED tests/legacy_reconciler_test.py::test_old_thing',
      stderr: '',
      output: 'FAILED tests/legacy_reconciler_test.py::test_old_thing',
      durationMs: 100,
      timedOut: false,
    });
    loopController.setWorktreeRunnerForTests({ verify });

    vi.spyOn(verifyReview, 'reviewVerifyFailure').mockResolvedValue({
      classification: 'baseline_broken',
      confidence: 'high',
      modifiedFiles: ['src/feature_x.py'],
      failingTests: ['tests/legacy_reconciler_test.py'],
      intersection: [],
      environmentSignals: [],
      llmVerdict: 'no-go',
      llmCritique: 'Failures in legacy reconciler, untouched by diff.',
      suggestedRejectReason: 'verify_failed_baseline_unrelated',
    });

    const eventSpy = vi.fn();
    eventBus.onFactoryProjectBaselineBroken(eventSpy);

    const instance = { id: 'inst-2', project_id: projectId, batch_id: batchId, work_item_id: workItemId };
    const r = await loopController.executeVerifyStage(projectId, batchId, instance);

    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('baseline_broken');

    const item = dbHandle.prepare('SELECT status, reject_reason FROM factory_work_items WHERE id = ?').get(workItemId);
    expect(item.status).toBe('rejected');
    expect(item.reject_reason).toBe('verify_failed_baseline_unrelated');

    const project = dbHandle.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('paused');
    const cfg = JSON.parse(project.config_json);
    expect(cfg.baseline_broken_since).toBeTruthy();
    expect(cfg.baseline_broken_reason).toBe('verify_failed_baseline_unrelated');

    expect(eventSpy).toHaveBeenCalledTimes(1);
    expect(eventSpy.mock.calls[0][0].project_id).toBe(projectId);

    eventBus.removeListener('factory:project_baseline_broken', eventSpy);
  });

  it('Scenario 3 (environment_failure): rejects item, pauses project, emits env-failure event', async () => {
    const loopController = require('../factory/loop-controller');
    const verifyReview = require('../factory/verify-review');
    const eventBus = require('../event-bus');

    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(dbHandle);

    const verify = vi.fn().mockResolvedValue({
      passed: false,
      exitCode: 127,
      stdout: '',
      stderr: 'pytest: command not found',
      output: 'pytest: command not found',
      durationMs: 100,
      timedOut: false,
    });
    loopController.setWorktreeRunnerForTests({ verify });

    vi.spyOn(verifyReview, 'reviewVerifyFailure').mockResolvedValue({
      classification: 'environment_failure',
      confidence: 'high',
      modifiedFiles: [],
      failingTests: [],
      intersection: [],
      environmentSignals: ['exit_127', 'stderr_ENOENT'],
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: 'verify_failed_environment',
    });

    const eventSpy = vi.fn();
    eventBus.onFactoryProjectEnvironmentFailure(eventSpy);

    const instance = { id: 'inst-3', project_id: projectId, batch_id: batchId, work_item_id: workItemId };
    const r = await loopController.executeVerifyStage(projectId, batchId, instance);

    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('environment_failure');

    const item = dbHandle.prepare('SELECT status, reject_reason FROM factory_work_items WHERE id = ?').get(workItemId);
    expect(item.status).toBe('rejected');
    expect(item.reject_reason).toBe('verify_failed_environment');

    const project = dbHandle.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('paused');
    const cfg = JSON.parse(project.config_json);
    expect(cfg.baseline_broken_since).toBeTruthy();
    expect(cfg.baseline_broken_reason).toBe('verify_failed_environment');

    expect(eventSpy).toHaveBeenCalledTimes(1);
    expect(eventSpy.mock.calls[0][0].project_id).toBe(projectId);

    eventBus.removeListener('factory:project_environment_failure', eventSpy);
  });

  it('Scenario 6 (classifier throws): fail-open, retry path fires', async () => {
    const loopController = require('../factory/loop-controller');
    const verifyReview = require('../factory/verify-review');
    const routingModule = require('../handlers/integration/routing');
    const awaitModule = require('../handlers/workflow/await');
    const taskCore = require('../db/task-core');
    const guardrailRunner = require('../factory/guardrail-runner');

    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(dbHandle);

    const verify = vi.fn()
      .mockResolvedValueOnce({ passed: false, exitCode: 1, stdout: 'FAIL', stderr: '', output: 'FAIL', durationMs: 100, timedOut: false })
      .mockResolvedValueOnce({ passed: true, exitCode: 0, stdout: 'PASS', stderr: '', output: 'PASS', durationMs: 50, timedOut: false });
    loopController.setWorktreeRunnerForTests({ verify });

    vi.spyOn(verifyReview, 'reviewVerifyFailure').mockRejectedValue(new Error('classifier exploded'));
    vi.spyOn(routingModule, 'handleSmartSubmitTask').mockResolvedValue({ task_id: 't-retry' });
    vi.spyOn(awaitModule, 'handleAwaitTask').mockResolvedValue({ status: 'completed' });
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
      id: 't-retry',
      status: 'completed',
      output: '',
      error_output: null,
    });
    vi.spyOn(guardrailRunner, 'runPostBatchChecks').mockReturnValue({
      status: 'passed',
      passed: true,
      results: [],
      batch_id: batchId,
    });

    const instance = { id: 'inst-6', project_id: projectId, batch_id: batchId, work_item_id: workItemId };
    const r = await loopController.executeVerifyStage(projectId, batchId, instance);

    expect(r.status).toBe('passed');

    const item = dbHandle.prepare('SELECT status FROM factory_work_items WHERE id = ?').get(workItemId);
    expect(item.status).not.toBe('rejected');
  });
});
