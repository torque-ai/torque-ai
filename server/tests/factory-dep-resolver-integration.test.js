'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

const factoryArchitect = require('../db/factory-architect');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const factoryWorktrees = require('../db/factory-worktrees');

function ensureFactoryTables(dbHandle) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS factory_projects (
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
    )`,
    `CREATE TABLE IF NOT EXISTS factory_decisions (
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
    )`,
    `CREATE TABLE IF NOT EXISTS factory_worktrees (
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
    )`,
  ];
  for (const sql of stmts) dbHandle.prepare(sql).run();
  try { dbHandle.prepare('ALTER TABLE factory_worktrees ADD COLUMN base_branch TEXT').run(); } catch { /* exists */ }
  try { dbHandle.prepare('ALTER TABLE factory_worktrees ADD COLUMN updated_at TEXT').run(); } catch { /* exists */ }
}

function wireFactoryDbModules(dbHandle) {
  factoryArchitect.setDb(dbHandle);
  factoryDecisions.setDb(dbHandle);
  factoryHealth.setDb(dbHandle);
  factoryIntake.setDb(dbHandle);
  factoryLoopInstances.setDb(dbHandle);
  factoryWorktrees.setDb(dbHandle);
}

function seedProjectItemAndWorktree(db, { trust = 'autonomous', cfgOverrides = {} } = {}) {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-e2e-'));
  const worktreeAbsPath = path.join(tempPath, '.worktrees', 'feat-dep');
  fs.mkdirSync(worktreeAbsPath, { recursive: true });
  const projectId = `proj-dep-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const cfg = { verify_command: 'python -m pytest tests/', ...cfgOverrides };
  db.prepare(`INSERT INTO factory_projects (id, name, path, trust_level, status, config_json, created_at, updated_at)
              VALUES (?, 'DepE2E', ?, ?, 'running', ?, datetime('now'), datetime('now'))`)
    .run(projectId, tempPath, trust, JSON.stringify(cfg));
  const { lastInsertRowid: workItemId } = db.prepare(
    `INSERT INTO factory_work_items (project_id, source, title, description, priority, status, origin_json, created_at, updated_at)
     VALUES (?, 'architect', 'dep item', 'd', 50, 'executing', ?, datetime('now'), datetime('now'))`
  ).run(projectId, JSON.stringify({ plan_path: path.join(tempPath, 'plan.md') }));
  const batchId = `factory-${projectId}-${workItemId}`;
  db.prepare(
    `INSERT INTO factory_worktrees (project_id, work_item_id, batch_id, branch, base_branch, worktree_path, vc_worktree_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'main', ?, 'vcid1', 'active', datetime('now'), datetime('now'))`
  ).run(projectId, workItemId, batchId, `feat/factory-${workItemId}`, worktreeAbsPath);
  return { projectId, workItemId, batchId, tempPath, worktreeAbsPath };
}

describe('executeVerifyStage + dep-resolver integration', () => {
  let dbModule;
  let db;
  beforeEach(() => {
    ({ db: dbModule } = setupTestDbOnly('dep-resolver-e2e'));
    db = dbModule.getDbInstance();
    ensureFactoryTables(db);
    wireFactoryDbModules(db);
  });
  afterEach(() => {
    try {
      const loopController = require('../factory/loop-controller');
      loopController.setWorktreeRunnerForTests(null);
    } catch { /* ok */ }
    vi.restoreAllMocks();
    teardownTestDb();
  });

  function mockResolverAndVerify({ verifyOutputs, resolveOutputs = [], escalateOutput = null, reviewOutputs }) {
    const loopController = require('../factory/loop-controller');
    const verifyReview = require('../factory/verify-review');
    const depResolver = require('../factory/dep-resolver/index');
    const escalation = require('../factory/dep-resolver/escalation');
    const guardrailRunner = require('../factory/guardrail-runner');
    const routingModule = require('../handlers/integration/routing');
    const awaitModule = require('../handlers/workflow/await');
    const taskCore = require('../db/task-core');

    const verify = vi.fn();
    for (const out of verifyOutputs) verify.mockResolvedValueOnce(out);
    loopController.setWorktreeRunnerForTests({ verify });

    const reviewSpy = vi.spyOn(verifyReview, 'reviewVerifyFailure');
    for (const r of reviewOutputs) reviewSpy.mockResolvedValueOnce(r);

    const resolveSpy = vi.spyOn(depResolver, 'resolve');
    for (const r of resolveOutputs) resolveSpy.mockResolvedValueOnce(r);

    let escalateSpy = null;
    if (escalateOutput) {
      escalateSpy = vi.spyOn(escalation, 'escalate').mockResolvedValue(escalateOutput);
    }

    // After verify finally passes, the function falls through to
    // runPostBatchChecks. Stub to a clean passed result so scenarios that
    // reach the happy path return status:'passed'.
    vi.spyOn(guardrailRunner, 'runPostBatchChecks').mockReturnValue({
      status: 'passed',
      passed: true,
      results: [],
    });

    // For the kill-switch scenario (dep_resolver disabled), the existing
    // retry path submits fix tasks. Stub those so we don't hit the network.
    vi.spyOn(routingModule, 'handleSmartSubmitTask').mockResolvedValue({ task_id: 't-retry' });
    vi.spyOn(awaitModule, 'handleAwaitTask').mockResolvedValue({ status: 'completed' });
    vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 't-retry', status: 'completed', output: '', error_output: null });

    return { verify, reviewSpy, resolveSpy, escalateSpy };
  }

  it('Scenario 1 (happy path): resolved then re-verify passes', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db);
    mockResolverAndVerify({
      verifyOutputs: [
        { passed: false, exitCode: 1, stdout: "ModuleNotFoundError: No module named 'cv2'", stderr: '', output: '...', durationMs: 100, timedOut: false },
        { passed: true, exitCode: 0, stdout: 'PASS', stderr: '', output: 'PASS', durationMs: 50, timedOut: false },
      ],
      reviewOutputs: [
        { classification: 'missing_dep', manager: 'python', package_name: 'opencv-python', module_name: 'cv2', error_output: "ModuleNotFoundError: No module named 'cv2'" },
      ],
      resolveOutputs: [
        { outcome: 'resolved', reverifyNeeded: true, taskId: 'r1', package: 'opencv-python', manager: 'python', manifest: 'pyproject.toml' },
      ],
    });
    const r = await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-1', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(r.status).toBe('passed');
    const project = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('running');
    const cfg = JSON.parse(project.config_json);
    expect(cfg.dep_resolve_history).toHaveLength(1);
    expect(cfg.dep_resolve_history[0].package).toBe('opencv-python');
  });

  it('Scenario 2 (cascade cap): 3 resolves, 4th missing_dep → pause', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db, { cfgOverrides: { verify_command: 'x' } });
    const fail = (pkg) => ({ passed: false, exitCode: 1, stdout: `ModuleNotFoundError: No module named '${pkg}'`, stderr: '', output: '', durationMs: 1, timedOut: false });
    const rev = (pkg) => ({ classification: 'missing_dep', manager: 'python', package_name: pkg + '-pkg', module_name: pkg, error_output: '' });
    mockResolverAndVerify({
      verifyOutputs: [fail('a'), fail('b'), fail('c'), fail('d')],
      reviewOutputs: [rev('a'), rev('b'), rev('c'), rev('d')],
      resolveOutputs: [
        { outcome: 'resolved', reverifyNeeded: true, taskId: 'r1', package: 'a-pkg', manager: 'python' },
        { outcome: 'resolved', reverifyNeeded: true, taskId: 'r2', package: 'b-pkg', manager: 'python' },
        { outcome: 'resolved', reverifyNeeded: true, taskId: 'r3', package: 'c-pkg', manager: 'python' },
      ],
    });
    const r = await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-2', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('dep_cascade_exhausted');
    const project = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('paused');
    const cfg = JSON.parse(project.config_json);
    expect(cfg.baseline_broken_reason).toBe('dep_cascade_exhausted');
  });

  it('Scenario 3 (resolver fails → escalation retry → pass)', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db);
    mockResolverAndVerify({
      verifyOutputs: [
        { passed: false, exitCode: 1, stdout: "ModuleNotFoundError: No module named 'sklearn'", stderr: '', output: '', durationMs: 1, timedOut: false },
        { passed: true, exitCode: 0, stdout: 'PASS', stderr: '', output: '', durationMs: 50, timedOut: false },
      ],
      reviewOutputs: [
        { classification: 'missing_dep', manager: 'python', package_name: 'sklearn-wrong', module_name: 'sklearn', error_output: '' },
      ],
      resolveOutputs: [
        { outcome: 'resolver_task_failed', reverifyNeeded: false, reason: 'could not find package sklearn-wrong on PyPI' },
        { outcome: 'resolved', reverifyNeeded: true, taskId: 'r-retry', package: 'scikit-learn', manager: 'python' },
      ],
      escalateOutput: { action: 'retry', revisedPrompt: 'Install scikit-learn (not sklearn)', reason: 'correct_package_name' },
    });
    const r = await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-3', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(r.status).toBe('passed');
  });

  it('Scenario 4 (resolver fails → escalation pause)', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db);
    mockResolverAndVerify({
      verifyOutputs: [
        { passed: false, exitCode: 1, stdout: "ModuleNotFoundError: No module named 'internal_lib'", stderr: '', output: '', durationMs: 1, timedOut: false },
      ],
      reviewOutputs: [
        { classification: 'missing_dep', manager: 'python', package_name: 'internal-lib', module_name: 'internal_lib', error_output: '' },
      ],
      resolveOutputs: [
        { outcome: 'resolver_task_failed', reverifyNeeded: false, reason: '404 on PyPI' },
      ],
      escalateOutput: { action: 'pause', reason: 'appears to be a private/internal package' },
    });
    const r = await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-4', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('dep_resolver_unresolvable');
    const project = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('paused');
    const cfg = JSON.parse(project.config_json);
    expect(cfg.baseline_broken_reason).toBe('dep_resolver_unresolvable');
  });

  it('Scenario 5 (supervised trust): emits pending_approval, does not auto-submit', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db, { trust: 'supervised' });
    const { resolveSpy } = mockResolverAndVerify({
      verifyOutputs: [
        { passed: false, exitCode: 1, stdout: "ModuleNotFoundError: No module named 'cv2'", stderr: '', output: '', durationMs: 1, timedOut: false },
      ],
      reviewOutputs: [
        { classification: 'missing_dep', manager: 'python', package_name: 'opencv-python', module_name: 'cv2', error_output: '' },
      ],
      resolveOutputs: [],
    });
    const r = await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-5', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(r.status).toBe('paused');
    expect(r.reason).toBe('dep_resolver_pending_approval');
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('Scenario 6 (kill switch): dep_resolver.enabled=false → falls through, no resolver call', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db, { cfgOverrides: { dep_resolver: { enabled: false }, verify_command: 'x' } });
    const { resolveSpy } = mockResolverAndVerify({
      verifyOutputs: [
        { passed: false, exitCode: 1, stdout: "ModuleNotFoundError: No module named 'cv2'", stderr: '', output: '', durationMs: 1, timedOut: false },
        { passed: false, exitCode: 1, stdout: '', stderr: '', output: '', durationMs: 1, timedOut: false },
        { passed: false, exitCode: 1, stdout: '', stderr: '', output: '', durationMs: 1, timedOut: false },
        { passed: false, exitCode: 1, stdout: '', stderr: '', output: '', durationMs: 1, timedOut: false },
      ],
      reviewOutputs: [
        { classification: 'missing_dep', manager: 'python', package_name: 'opencv-python', module_name: 'cv2', error_output: '' },
        { classification: 'task_caused', confidence: 'high', modifiedFiles: [], failingTests: [], intersection: [], environmentSignals: [], llmVerdict: null, llmCritique: null, suggestedRejectReason: null },
        { classification: 'task_caused', confidence: 'high', modifiedFiles: [], failingTests: [], intersection: [], environmentSignals: [], llmVerdict: null, llmCritique: null, suggestedRejectReason: null },
        { classification: 'task_caused', confidence: 'high', modifiedFiles: [], failingTests: [], intersection: [], environmentSignals: [], llmVerdict: null, llmCritique: null, suggestedRejectReason: null },
      ],
    });
    await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-6', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('Scenario 7 (escalation LLM unavailable): pause with escalation_llm_unavailable reason', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db);
    mockResolverAndVerify({
      verifyOutputs: [
        { passed: false, exitCode: 1, stdout: "ModuleNotFoundError: No module named 'x'", stderr: '', output: '', durationMs: 1, timedOut: false },
      ],
      reviewOutputs: [
        { classification: 'missing_dep', manager: 'python', package_name: 'x-pkg', module_name: 'x', error_output: '' },
      ],
      resolveOutputs: [
        { outcome: 'resolver_task_failed', reverifyNeeded: false, reason: 'pip error' },
      ],
      escalateOutput: { action: 'pause', reason: 'escalation_llm_unavailable: submit_threw' },
    });
    const r = await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-7', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('dep_resolver_unresolvable');
    const project = db.prepare('SELECT config_json FROM factory_projects WHERE id = ?').get(projectId);
    const cfg = JSON.parse(project.config_json);
    expect(cfg.baseline_broken_evidence.escalation_reason).toMatch(/escalation_llm_unavailable/);
  });
});
