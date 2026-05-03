import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const factoryWorktrees = require('../db/factory-worktrees');
const { createScoutFindingsIntake } = require('../factory/scout-findings-intake');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES } = require('../factory/loop-states');

let dbModule;
let dbHandle;
let testDir;

function runDdl(db, sql) {
  return db['exec'](sql);
}

function ensureFactoryTables(db) {
  runDdl(db, `
    CREATE TABLE IF NOT EXISTS vc_worktrees (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      feature_name TEXT,
      base_branch TEXT DEFAULT 'main',
      status TEXT DEFAULT 'active',
      commit_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      last_activity_at TEXT
    );

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

    CREATE TABLE IF NOT EXISTS factory_health_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES factory_health_snapshots(id),
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      file_path TEXT,
      details_json TEXT
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

    CREATE INDEX IF NOT EXISTS idx_fd_project_time
      ON factory_decisions(project_id, created_at);

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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_loop_instances_stage_occupancy
      ON factory_loop_instances(project_id, loop_state)
      WHERE terminated_at IS NULL AND loop_state NOT IN ('IDLE');

    CREATE TABLE IF NOT EXISTS factory_worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id),
      batch_id TEXT NOT NULL,
      vc_worktree_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      base_branch TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      merged_at TEXT,
      abandoned_at TEXT
    );

    CREATE TABLE IF NOT EXISTS factory_scout_findings_intake (
      project_id TEXT NOT NULL,
      scan_path TEXT NOT NULL,
      finding_hash TEXT NOT NULL,
      work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, scan_path, finding_hash)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function resetFactoryTables(db) {
  for (const table of [
    'factory_scout_findings_intake',
    'factory_worktrees',
    'factory_loop_instances',
    'factory_decisions',
    'factory_health_findings',
    'factory_health_snapshots',
    'factory_work_items',
    'factory_projects',
    'vc_worktrees',
    'tasks',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

function wireFactoryDbModules(db) {
  factoryHealth.setDb(db);
  factoryIntake.setDb(db);
  factoryDecisions.setDb(db);
  factoryLoopInstances.setDb(db);
  factoryWorktrees.setDb(db);
}

function createProject({ name = 'Factory Hardening E2E', config = null } = {}) {
  const projectPath = path.join(testDir, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(projectPath, { recursive: true });
  const project = factoryHealth.registerProject({
    name,
    path: projectPath,
    brief: 'Factory hardening end-to-end fixture project',
    trust_level: 'supervised',
    config,
  });
  factoryHealth.updateProject(project.id, { status: 'running' });
  return factoryHealth.getProject(project.id);
}

function writeFindingsFile(dir, filename, title) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, [
    '# Factory Scan',
    '**Variant:** hardening',
    '',
    '## Findings',
    '',
    `### [HIGH] ${title}`,
    '- **File:** server/auth/api-authorization-contract.js:1',
    '- **Description:** This finding asks for another intake item instead of a code change.',
    '- **Suggested fix:** Suppress this meta item at intake time.',
    '',
  ].join('\n'), 'utf8');
  return filePath;
}

function writePlanFile() {
  const planPath = path.join(testDir, `plan-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
  fs.writeFileSync(planPath, [
    '# Zero Diff Plan',
    '',
    '## Task 1: Exercise zero diff guard',
    '',
    '- [ ] **Step 1: Touch implementation**',
    '',
    '    Edit server/factory/loop-controller.js.',
    '',
  ].join('\n'), 'utf8');
  return planPath;
}

function insertDecision({ projectId, batchId, action, createdAt }) {
  dbHandle.prepare(`
    INSERT INTO factory_decisions (
      project_id, stage, actor, action, reasoning,
      inputs_json, outcome_json, confidence, batch_id, created_at
    )
    VALUES (?, 'execute', 'executor', ?, ?, ?, ?, 1, ?, ?)
  `).run(
    projectId,
    action,
    'Auto-commit skipped because the factory worktree was clean.',
    JSON.stringify({ batch_id: batchId }),
    JSON.stringify({ files_changed: [], zero_diff_reason: 'unknown' }),
    batchId,
    createdAt,
  );
}

beforeEach(() => {
  ({ db: dbModule, testDir } = setupTestDbOnly('factory-hardening-e2e'));
  dbHandle = dbModule.getDbInstance();
  ensureFactoryTables(dbHandle);
  resetFactoryTables(dbHandle);
  wireFactoryDbModules(dbHandle);
  loopController.setWorktreeRunnerForTests(null);
  loopController.__testing__.setExecuteVerifyStageForTests(null);
});

afterEach(() => {
  loopController.__testing__.setExecuteVerifyStageForTests(null);
  loopController.setWorktreeRunnerForTests(null);
  factoryHealth.setDb(null);
  factoryIntake.setDb(null);
  factoryDecisions.setDb(null);
  factoryLoopInstances.setDb(null);
  factoryWorktrees.setDb(null);
  vi.restoreAllMocks();
  teardownTestDb();
});

describe('factory hardening end-to-end', () => {
  it('suppresses scout meta-intake findings without creating a work item', async () => {
    const project = createProject();
    const findingsDir = path.join(project.path, 'findings');
    writeFindingsFile(
      findingsDir,
      '2026-04-21-hardening-scan.md',
      'Create intake to re-enable ApiAuthorizationContract verification coverage',
    );

    const intake = createScoutFindingsIntake({ db: dbHandle, factoryIntake });
    const result = await intake.scan({ project_id: project.id, findings_dir: findingsDir });

    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'meta_task_no_code_output' }),
    ]));
    expect(dbHandle.prepare('SELECT COUNT(*) AS count FROM factory_work_items WHERE project_id = ?').get(project.id).count).toBe(0);
    expect(dbHandle.prepare('SELECT COUNT(*) AS count FROM factory_scout_findings_intake WHERE project_id = ?').get(project.id).count).toBe(0);
  });

  it('short-circuits two consecutive zero-diff EXECUTE attempts before VERIFY', async () => {
    const project = createProject({ config: { execute_mode: 'suppress' } });
    const planPath = writePlanFile();
    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'plan_file',
      title: 'Zero diff should not verify',
      description: 'The same batch has already produced two clean auto-commit decisions.',
      requestor: 'test',
      status: 'verifying',
      origin: { plan_path: planPath },
    });
    const batchId = `factory-${project.id}-${workItem.id}`;
    const instanceId = randomUUID();
    const now = new Date('2026-04-21T12:00:10.000Z').toISOString();

    factoryIntake.updateWorkItem(workItem.id, {
      batch_id: batchId,
      claimed_by_instance_id: instanceId,
    });
    dbHandle.prepare(`
      INSERT INTO factory_loop_instances (
        id, project_id, work_item_id, batch_id, loop_state, paused_at_stage, last_action_at, created_at
      )
      VALUES (?, ?, ?, ?, 'EXECUTE', NULL, ?, ?)
    `).run(instanceId, project.id, workItem.id, batchId, now, now);
    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.EXECUTE,
      loop_batch_id: batchId,
      loop_last_action_at: now,
      loop_paused_at_stage: null,
    });
    insertDecision({
      projectId: project.id,
      batchId,
      action: 'auto_commit_skipped_clean',
      createdAt: '2026-04-21T12:00:01.000Z',
    });
    insertDecision({
      projectId: project.id,
      batchId,
      action: 'auto_commit_skipped_clean',
      createdAt: '2026-04-21T12:00:05.000Z',
    });

    const verifyImpl = vi.fn(async () => {
      throw new Error('executeVerifyStage should not be called for zero-diff short-circuit');
    });
    const executeVerifySpy = vi.spyOn(loopController, 'executeVerifyStage').mockImplementation(verifyImpl);
    loopController.__testing__.setExecuteVerifyStageForTests(loopController.executeVerifyStage);

    const advanced = await loopController.advanceLoopForProject(project.id);

    expect(advanced).toMatchObject({
      previous_state: LOOP_STATES.EXECUTE,
      new_state: LOOP_STATES.IDLE,
      paused_at_stage: null,
      reason: 'zero_diff_across_retries',
    });
    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      status: 'unactionable',
      reject_reason: 'zero_diff_across_retries',
    });
    expect(dbHandle.prepare(`
      SELECT COUNT(*) AS count
      FROM factory_decisions
      WHERE project_id = ? AND batch_id = ? AND action = 'execute_zero_diff_short_circuit'
    `).get(project.id, batchId).count).toBe(1);
    expect(factoryLoopInstances.getInstance(instanceId)).toMatchObject({
      loop_state: LOOP_STATES.IDLE,
      terminated_at: expect.any(String),
    });
    expect(executeVerifySpy).not.toHaveBeenCalled();
    expect(verifyImpl).not.toHaveBeenCalled();
  });

  it('Phase E: zero-diff with prior auto_committed_task advances to VERIFY (not IDLE/unactionable)', async () => {
    // Regression for the live failure on DLPhone work item #2097
    // (2026-04-29). qwen3-coder:30b's first EXECUTE attempt landed
    // commit 507350f at 22:47:48 (a real C# test in the work item's
    // allowed_files). Two follow-up retries no-op'd at 22:51:36 and
    // 22:51:47 because the work was already done. Without this fix,
    // the zero-diff short-circuit rejected the work item even though
    // the diff had landed cleanly. The right behavior: detect the
    // prior auto_committed_task in the batch and advance to VERIFY
    // so the test that was just written gets validated.
    const project = createProject({ config: { execute_mode: 'suppress' } });
    const planPath = writePlanFile();
    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'plan_file',
      title: 'Diff already landed; retries were benign no-ops',
      description: 'Batch produced a real commit on the first attempt; subsequent retries had nothing to do.',
      requestor: 'test',
      status: 'verifying',
      origin: { plan_path: planPath },
    });
    const batchId = `factory-${project.id}-${workItem.id}`;
    const instanceId = randomUUID();
    const now = new Date('2026-04-29T22:51:50.000Z').toISOString();

    factoryIntake.updateWorkItem(workItem.id, {
      batch_id: batchId,
      claimed_by_instance_id: instanceId,
    });
    dbHandle.prepare(`
      INSERT INTO factory_loop_instances (
        id, project_id, work_item_id, batch_id, loop_state, paused_at_stage, last_action_at, created_at
      )
      VALUES (?, ?, ?, ?, 'EXECUTE', NULL, ?, ?)
    `).run(instanceId, project.id, workItem.id, batchId, now, now);
    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.EXECUTE,
      loop_batch_id: batchId,
      loop_last_action_at: now,
      loop_paused_at_stage: null,
    });

    // The real commit landed FIRST in the batch...
    insertDecision({
      projectId: project.id,
      batchId,
      action: 'auto_committed_task',
      createdAt: '2026-04-29T22:47:48.000Z',
    });
    // ...then two no-op retries (Phase D's verify-retry path with the
    // diff already done — nothing left to commit).
    insertDecision({
      projectId: project.id,
      batchId,
      action: 'auto_commit_skipped_clean',
      createdAt: '2026-04-29T22:51:36.000Z',
    });
    insertDecision({
      projectId: project.id,
      batchId,
      action: 'auto_commit_skipped_clean',
      createdAt: '2026-04-29T22:51:47.000Z',
    });

    const advanced = await loopController.advanceLoopForProject(project.id);

    // New state should be VERIFY (not IDLE), and the reason should
    // signal "completed after no-op retries" not "zero-diff rejection".
    expect(advanced).toMatchObject({
      previous_state: LOOP_STATES.EXECUTE,
      new_state: LOOP_STATES.VERIFY,
      paused_at_stage: null,
      reason: 'execute_completed_after_no_op_retries',
    });
    expect(advanced.stage_result).toMatchObject({
      status: 'completed',
      reason: 'execute_completed_after_no_op_retries',
    });

    // Work item must NOT be marked unactionable — the diff IS done.
    const wi = factoryIntake.getWorkItem(workItem.id);
    expect(wi.status).not.toBe('unactionable');
    expect(wi.reject_reason).not.toBe('zero_diff_across_retries');

    // The Phase E decision should be logged once; the legacy
    // execute_zero_diff_short_circuit decision should NOT fire.
    expect(dbHandle.prepare(`
      SELECT COUNT(*) AS count FROM factory_decisions
      WHERE project_id = ? AND batch_id = ? AND action = 'execute_completed_after_no_op_retries'
    `).get(project.id, batchId).count).toBe(1);
    expect(dbHandle.prepare(`
      SELECT COUNT(*) AS count FROM factory_decisions
      WHERE project_id = ? AND batch_id = ? AND action = 'execute_zero_diff_short_circuit'
    `).get(project.id, batchId).count).toBe(0);
  });

  it('zero-diff with agent self-commits ahead of master advances to VERIFY (not IDLE/unactionable)', async () => {
    // Regression for the live failure on bitsy work item #470 (2026-05-03,
    // "Add type stubs and py.typed marker"). Codex generated a 4-task plan
    // that passed the quality gate; claude-cli executed each task and
    // committed inside the worktree (3f2ecf5, 2e69d25, 43a6cd3, e355132 —
    // 337 lines, py.typed marker + 4 .pyi stubs + pyproject package-data
    // + 2 mypy-running tests). Phase E only checks for auto_committed_task
    // decisions (which fire when the FACTORY auto-commits leftover dirty
    // state), so 4 auto_commit_skipped_clean decisions (each meaning
    // "agent committed cleanly, factory had nothing extra") incorrectly
    // tripped the zero-diff short-circuit and marked WI 470 unactionable
    // despite the work having landed cleanly.
    //
    // The right behavior: when batchHasAutoCommittedTask returns false but
    // the branch has commits ahead of base, advance to VERIFY anyway —
    // the agent's self-commits did the work.
    const childProc = require('child_process');

    // Build a real git repo so the rev-list helper has something to count.
    const repoPath = path.join(testDir, 'agent-self-commit-repo');
    fs.mkdirSync(repoPath, { recursive: true });
    const gitOpts = { cwd: repoPath, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } };
    childProc.execFileSync('git', ['init', '-q', '--initial-branch=master'], gitOpts);
    childProc.execFileSync('git', ['config', 'commit.gpgsign', 'false'], gitOpts);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# base\n', 'utf8');
    childProc.execFileSync('git', ['add', '.'], gitOpts);
    childProc.execFileSync('git', ['commit', '-q', '-m', 'base'], gitOpts);
    childProc.execFileSync('git', ['checkout', '-q', '-b', 'feat/agent-self-commits'], gitOpts);
    fs.writeFileSync(path.join(repoPath, 'agent.txt'), 'agent committed this\n', 'utf8');
    childProc.execFileSync('git', ['add', '.'], gitOpts);
    childProc.execFileSync('git', ['commit', '-q', '-m', 'agent: typing stubs'], gitOpts);

    const project = createProject({ config: { execute_mode: 'suppress' } });
    const planPath = writePlanFile();
    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'plan_file',
      title: 'Agent committed via its own git tooling',
      description: 'Worktree is clean because the agent committed; not because no work was done.',
      requestor: 'test',
      status: 'verifying',
      origin: { plan_path: planPath },
    });
    const batchId = `factory-${project.id}-${workItem.id}`;
    const instanceId = randomUUID();
    const now = new Date('2026-05-03T02:30:00.000Z').toISOString();

    factoryIntake.updateWorkItem(workItem.id, {
      batch_id: batchId,
      claimed_by_instance_id: instanceId,
    });
    dbHandle.prepare(`
      INSERT INTO factory_loop_instances (
        id, project_id, work_item_id, batch_id, loop_state, paused_at_stage, last_action_at, created_at
      )
      VALUES (?, ?, ?, ?, 'EXECUTE', NULL, ?, ?)
    `).run(instanceId, project.id, workItem.id, batchId, now, now);
    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.EXECUTE,
      loop_batch_id: batchId,
      loop_last_action_at: now,
      loop_paused_at_stage: null,
    });

    // Record an active worktree row pointing at the real git repo above
    // with a branch that already has one commit ahead of master.
    factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: batchId,
      vc_worktree_id: randomUUID(),
      branch: 'feat/agent-self-commits',
      worktree_path: repoPath,
      base_branch: 'master',
    });

    // Two consecutive auto_commit_skipped_clean — agent committed each
    // time, factory had nothing extra to capture. NO auto_committed_task
    // decision fired (this is the gap Phase E missed).
    insertDecision({
      projectId: project.id,
      batchId,
      action: 'auto_commit_skipped_clean',
      createdAt: '2026-05-03T02:25:00.000Z',
    });
    insertDecision({
      projectId: project.id,
      batchId,
      action: 'auto_commit_skipped_clean',
      createdAt: '2026-05-03T02:27:00.000Z',
    });

    // Sanity-check: the worktree row should exist with base_branch set,
    // and the helper should report commits ahead of master. If either
    // fails, the loop transition will fall through to zero_diff_across_retries
    // and the assertion errors below won't pinpoint the cause.
    const wtRow = factoryWorktrees.getActiveWorktreeByBatch(batchId);
    expect(wtRow).toBeTruthy();
    expect(wtRow.baseBranch || wtRow.base_branch).toBe('master');
    expect(wtRow.worktreePath || wtRow.worktree_path).toBe(repoPath);
    expect(loopController.__testing__.batchBranchHasCommitsAhead(project.id, batchId)).toBe(true);

    const advanced = await loopController.advanceLoopForProject(project.id);

    expect(advanced).toMatchObject({
      previous_state: LOOP_STATES.EXECUTE,
      new_state: LOOP_STATES.VERIFY,
      paused_at_stage: null,
      reason: 'execute_completed_with_agent_self_commits',
    });
    expect(advanced.stage_result).toMatchObject({
      status: 'completed',
      reason: 'execute_completed_with_agent_self_commits',
    });

    // Work item must NOT be marked unactionable — real commits exist on
    // the branch, the factory just couldn't see them via decision history.
    const wi = factoryIntake.getWorkItem(workItem.id);
    expect(wi.status).not.toBe('unactionable');
    expect(wi.reject_reason).not.toBe('zero_diff_across_retries');

    expect(dbHandle.prepare(`
      SELECT COUNT(*) AS count FROM factory_decisions
      WHERE project_id = ? AND batch_id = ? AND action = 'execute_completed_with_agent_self_commits'
    `).get(project.id, batchId).count).toBe(1);
    expect(dbHandle.prepare(`
      SELECT COUNT(*) AS count FROM factory_decisions
      WHERE project_id = ? AND batch_id = ? AND action = 'execute_zero_diff_short_circuit'
    `).get(project.id, batchId).count).toBe(0);
  });

  it('zero-diff with no worktree row or no commits ahead still rejects (safety: no false-positive advance)', async () => {
    // Confirms the existing zero-diff rejection path still fires when
    // there's no positive evidence of agent commits — we only divert to
    // VERIFY when we can prove via git that the branch has commits ahead.
    const project = createProject({ config: { execute_mode: 'suppress' } });
    const planPath = writePlanFile();
    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'plan_file',
      title: 'Genuine zero-diff: no commits ahead, no auto_committed_task',
      description: 'Two no-op retries with no real work landed.',
      requestor: 'test',
      status: 'verifying',
      origin: { plan_path: planPath },
    });
    const batchId = `factory-${project.id}-${workItem.id}`;
    const instanceId = randomUUID();
    const now = new Date('2026-05-03T03:00:00.000Z').toISOString();

    factoryIntake.updateWorkItem(workItem.id, {
      batch_id: batchId,
      claimed_by_instance_id: instanceId,
    });
    dbHandle.prepare(`
      INSERT INTO factory_loop_instances (
        id, project_id, work_item_id, batch_id, loop_state, paused_at_stage, last_action_at, created_at
      )
      VALUES (?, ?, ?, ?, 'EXECUTE', NULL, ?, ?)
    `).run(instanceId, project.id, workItem.id, batchId, now, now);
    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.EXECUTE,
      loop_batch_id: batchId,
      loop_last_action_at: now,
      loop_paused_at_stage: null,
    });
    insertDecision({
      projectId: project.id,
      batchId,
      action: 'auto_commit_skipped_clean',
      createdAt: '2026-05-03T03:00:01.000Z',
    });
    insertDecision({
      projectId: project.id,
      batchId,
      action: 'auto_commit_skipped_clean',
      createdAt: '2026-05-03T03:00:05.000Z',
    });
    // Note: no factory_worktrees row recorded → batchBranchHasCommitsAhead
    // returns false (no row to look up).

    const advanced = await loopController.advanceLoopForProject(project.id);

    expect(advanced).toMatchObject({
      previous_state: LOOP_STATES.EXECUTE,
      new_state: LOOP_STATES.IDLE,
      reason: 'zero_diff_across_retries',
    });
    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      status: 'unactionable',
      reject_reason: 'zero_diff_across_retries',
    });
  });

  it('terminates VERIFY when verify review rejects and pauses the project', async () => {
    const project = createProject({ config: { verify_command: 'npm test' } });
    const planPath = writePlanFile();
    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'scout',
      title: 'Baseline broken should not linger in verify',
      description: 'The verify classifier rejected this item because baseline tests are already red.',
      requestor: 'test',
      status: 'verifying',
      origin: { plan_path: planPath },
    });
    const batchId = `factory-${project.id}-${workItem.id}`;
    const instanceId = randomUUID();
    const now = new Date('2026-04-21T12:03:00.000Z').toISOString();

    factoryIntake.updateWorkItem(workItem.id, {
      batch_id: batchId,
      claimed_by_instance_id: instanceId,
    });
    dbHandle.prepare(`
      INSERT INTO factory_loop_instances (
        id, project_id, work_item_id, batch_id, loop_state, paused_at_stage, last_action_at, created_at
      )
      VALUES (?, ?, ?, ?, 'VERIFY', NULL, ?, ?)
    `).run(instanceId, project.id, workItem.id, batchId, now, now);
    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.VERIFY,
      loop_batch_id: batchId,
      loop_last_action_at: now,
      loop_paused_at_stage: null,
    });

    loopController.__testing__.setExecuteVerifyStageForTests(async () => {
      factoryIntake.updateWorkItem(workItem.id, {
        status: 'rejected',
        reject_reason: 'verify_failed_baseline_unrelated',
      });
      const cfg = {
        verify_command: 'npm test',
        baseline_broken_since: '2026-04-21T12:03:10.000Z',
        baseline_broken_reason: 'verify_failed_baseline_unrelated',
        baseline_broken_evidence: { failing_tests: ['tests/baseline.test.js'] },
        baseline_broken_probe_attempts: 0,
        baseline_broken_tick_count: 0,
      };
      factoryHealth.updateProject(project.id, {
        status: 'paused',
        config_json: JSON.stringify(cfg),
      });
      return { status: 'rejected', reason: 'baseline_broken' };
    });

    const advanced = await loopController.advanceLoopForProject(project.id);

    expect(advanced).toMatchObject({
      previous_state: LOOP_STATES.VERIFY,
      new_state: LOOP_STATES.IDLE,
      paused_at_stage: null,
      reason: 'baseline_broken',
    });
    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      status: 'rejected',
      reject_reason: 'verify_failed_baseline_unrelated',
      claimed_by_instance_id: null,
    });
    expect(factoryLoopInstances.getInstance(instanceId)).toMatchObject({
      loop_state: LOOP_STATES.IDLE,
      terminated_at: expect.any(String),
    });
    expect(factoryHealth.getProject(project.id)).toMatchObject({
      status: 'paused',
      loop_state: LOOP_STATES.IDLE,
      loop_batch_id: null,
      loop_paused_at_stage: null,
    });
    const decision = dbHandle.prepare(`
      SELECT action, outcome_json
      FROM factory_decisions
      WHERE project_id = ? AND batch_id = ? AND action = 'verify_terminal_rejection_terminated'
    `).get(project.id, batchId);
    expect(decision).toBeTruthy();
    expect(JSON.parse(decision.outcome_json)).toMatchObject({
      work_item_id: workItem.id,
      instance_id: instanceId,
      reason: 'baseline_broken',
    });
  });
});
