import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const childProcess = require('child_process');
const database = require('../database');
const attemptHistory = require('../db/factory-attempt-history');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryWorktrees = require('../db/factory-worktrees');
const taskCore = require('../db/task-core');
const { taskEvents } = require('../hooks/event-dispatch');

const MODULE_PATH = require.resolve('../factory/worktree-auto-commit');
const originalExecFileSync = childProcess._realExecFileSync || childProcess.execFileSync;

function runRealGit(cwd, args, options = {}) {
  return originalExecFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id),
      batch_id TEXT NOT NULL,
      vc_worktree_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      merged_at TEXT,
      abandoned_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_factory_worktrees_project_active
      ON factory_worktrees(project_id, status);

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

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      task_description TEXT,
      working_directory TEXT,
      timeout_minutes INTEGER,
      auto_approve INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      context TEXT,
      output TEXT,
      error_output TEXT,
      exit_code INTEGER,
      pid INTEGER,
      progress_percent INTEGER,
      files_modified TEXT,
      tags TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      cancel_reason TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      depends_on TEXT,
      template_name TEXT,
      isolated_workspace TEXT,
      git_before_sha TEXT,
      git_after_sha TEXT,
      git_stash_ref TEXT,
      project TEXT,
      retry_strategy TEXT,
      retry_delay_seconds INTEGER,
      last_retry_at TEXT,
      group_id TEXT,
      paused_at TEXT,
      pause_reason TEXT,
      approval_status TEXT,
      workflow_id TEXT,
      workflow_node_id TEXT,
      claimed_by_agent TEXT,
      required_capabilities TEXT,
      ollama_host_id TEXT,
      provider TEXT,
      model TEXT,
      original_provider TEXT,
      provider_switched_at TEXT,
      mcp_instance_id TEXT,
      complexity TEXT,
      task_metadata TEXT,
      partial_output TEXT,
      resume_context TEXT,
      review_status TEXT,
      stall_timeout_seconds INTEGER,
      server_epoch INTEGER
    );

    CREATE TABLE IF NOT EXISTS factory_attempt_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('execute', 'verify_retry')),
      task_id TEXT NOT NULL,
      files_touched TEXT,
      file_count INTEGER NOT NULL DEFAULT 0,
      stdout_tail TEXT,
      zero_diff_reason TEXT,
      classifier_source TEXT NOT NULL DEFAULT 'none' CHECK (classifier_source IN ('heuristic', 'llm', 'none')),
      classifier_conf REAL,
      verify_output_tail TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function loadAutoCommitModule() {
  delete require.cache[MODULE_PATH];
  return require('../factory/worktree-auto-commit');
}

function initGitWorktree(tempDirs) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-worktree-auto-commit-'));
  tempDirs.push(repoPath);
  runRealGit(repoPath, ['init', '--initial-branch=main']);
  runRealGit(repoPath, ['config', 'user.name', 'Factory Test']);
  runRealGit(repoPath, ['config', 'user.email', 'factory-test@example.com']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'seed\n');
  runRealGit(repoPath, ['add', 'README.md']);
  runRealGit(repoPath, ['commit', '-m', 'initial commit']);

  const worktreePath = path.join(repoPath, '.worktrees', 'feat-auto-commit');
  runRealGit(repoPath, ['worktree', 'add', '-b', 'feat/auto-commit', worktreePath, 'main']);

  return { repoPath, worktreePath };
}

function seedFactoryProject(db, worktreePath, batchId = 'factory-project-1-7') {
  db.prepare(`
    INSERT INTO factory_projects (id, name, path, trust_level, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'project-1',
    'Factory Auto Commit',
    worktreePath,
    'supervised',
    'paused',
    '2026-04-14T00:00:00.000Z',
    '2026-04-14T00:00:00.000Z',
  );

  const workItemInfo = db.prepare(`
    INSERT INTO factory_work_items (project_id, source, title, description, batch_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'project-1',
    'manual',
    'Auto commit pending approval task',
    'Close the worktree auto-commit gap.',
    batchId,
    '2026-04-14T00:00:00.000Z',
    '2026-04-14T00:00:00.000Z',
  );

  db.prepare(`
    INSERT INTO vc_worktrees (
      id,
      repo_path,
      worktree_path,
      branch,
      feature_name,
      base_branch,
      status,
      commit_count,
      created_at,
      last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'vc-worktree-1',
    worktreePath,
    worktreePath,
    'feat/auto-commit',
    'auto-commit',
    'main',
    'active',
    0,
    '2026-04-14T00:00:00.000Z',
    '2026-04-14T00:00:00.000Z',
  );

  db.prepare(`
    INSERT INTO factory_worktrees (
      project_id,
      work_item_id,
      batch_id,
      vc_worktree_id,
      branch,
      worktree_path,
      status,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'project-1',
    workItemInfo.lastInsertRowid,
    batchId,
    'vc-worktree-1',
    'feat/auto-commit',
    worktreePath,
    'active',
    '2026-04-14T00:00:00.000Z',
  );
}

function insertTask(db, {
  taskId,
  status = 'completed',
  tags = [],
  workingDirectory,
  taskDescription = 'Plan: Auto Commit\nTask 3: Add audit logging\n',
  metadata = null,
}) {
  db.prepare(`
    INSERT INTO tasks (id, status, task_description, working_directory, tags, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    status,
    taskDescription,
    workingDirectory,
    JSON.stringify(tags),
    metadata ? JSON.stringify(metadata) : null,
    '2026-04-14T00:00:00.000Z',
  );
}

function listDecisionRows(db) {
  return db.prepare(`
    SELECT id, action, outcome_json
    FROM factory_decisions
    ORDER BY id ASC
  `).all().map((row) => ({
    ...row,
    outcome: row.outcome_json ? JSON.parse(row.outcome_json) : null,
  }));
}

function countCommits(worktreePath) {
  return Number(runRealGit(worktreePath, ['rev-list', '--count', 'HEAD']).trim());
}

describe('factory worktree auto-commit', () => {
  let db;
  let autoCommit;
  let tempDirs;
  let originalGetDbInstance;

  beforeEach(() => {
    vi.restoreAllMocks();
    childProcess.execFileSync = originalExecFileSync;
    tempDirs = [];
    db = createDb();
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;
    attemptHistory.setDb(db);
    factoryHealth.setDb(db);
    factoryWorktrees.setDb(db);
    factoryDecisions.setDb(db);
    taskCore.setDb(db);
    autoCommit = loadAutoCommitModule();
    autoCommit.resetFactoryWorktreeAutoCommitForTests();
  });

  afterEach(() => {
    autoCommit?.resetFactoryWorktreeAutoCommitForTests();
    delete require.cache[MODULE_PATH];
    database.getDbInstance = originalGetDbInstance;
    attemptHistory.setDb(null);
    factoryHealth.setDb(null);
    factoryWorktrees.setDb(null);
    factoryDecisions.setDb(null);
    taskCore.setDb(null);
    if (db) {
      db.close();
    }
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    childProcess.execFileSync = originalExecFileSync;
  });

  async function waitForAutoCommitListener() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function runAutoCommitListenerWithStdoutTail(opts) {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath, opts.batchId);

    for (const dirtyFile of opts.dirtyFiles) {
      const targetPath = path.join(worktreePath, dirtyFile);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'dummy content\n');
    }

    taskCore.createTask({
      id: opts.taskId,
      status: 'completed',
      task_description: `Plan: Auto Commit\nTask ${opts.planTaskNumber}: Add audit logging\n`,
      working_directory: worktreePath,
      tags: [
        `factory:batch_id=${opts.batchId}`,
        `factory:work_item_id=${opts.workItemId}`,
        `factory:plan_task_number=${opts.planTaskNumber}`,
        ...(opts.extraTags || []),
      ],
    });
    taskCore.updateTask(opts.taskId, { output: opts.stdoutTail });

    const task = taskCore.getTask(opts.taskId);
    expect(autoCommit.initFactoryWorktreeAutoCommit()).toBe(true);
    taskEvents.emit('task:completed', { id: task.id, status: 'completed' });
    await waitForAutoCommitListener();

    return { result: task, worktreePath };
  }

  it('registers the listener when only "dark" trust-level projects exist (regression: skipped pre-fix)', () => {
    // Earlier ELIGIBLE_TRUST_LEVELS = ['supervised', 'autonomous'] silently
    // excluded 'dark', the most automated trust level. Result: with only
    // dark projects registered, the boot-time init returned false and the
    // listener never attached. Codex output never got committed back to
    // factory feat branches; LEARN merges always failed "no commits ahead";
    // EXECUTE re-ran the same plan tasks forever. This test pins down that
    // dark trust qualifies for auto-commit.
    db.prepare(`
      INSERT INTO factory_projects (id, name, path, trust_level, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'project-dark',
      'Factory Dark Trust',
      '/tmp/factory-dark',
      'dark',
      'running',
      '2026-04-19T00:00:00.000Z',
      '2026-04-19T00:00:00.000Z',
    );

    expect(autoCommit.initFactoryWorktreeAutoCommit()).toBe(true);
  });

  it('preserves full paths from porcelain status lines when reporting drift', () => {
    expect(autoCommit._internalForTests.parsePorcelainPaths([
      ' M docs/superpowers/plans/2026-04-11-fabro-102-procedural-memory.md',
      ' M server/db/migrations.js',
      '?? server/memory/',
      '',
    ].join('\n'))).toEqual([
      'docs/superpowers/plans/2026-04-11-fabro-102-procedural-memory.md',
      'server/db/migrations.js',
      'server/memory/',
    ]);

    expect(autoCommit._internalForTests.parsePorcelainPaths(
      'M docs/superpowers/plans/2026-04-11-fabro-102-procedural-memory.md\n',
    )).toEqual([
      'docs/superpowers/plans/2026-04-11-fabro-102-procedural-memory.md',
    ]);
  });

  it('ignores stale completed tasks from an older batch instead of committing the current active worktree', async () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath, 'factory-project-1-134');
    const staleWorktreePath = path.join(path.dirname(worktreePath), 'feat-factory-133-stale');
    insertTask(db, {
      taskId: 'task-stale-batch',
      workingDirectory: staleWorktreePath,
      tags: [
        'factory:batch_id=factory-project-1-133',
        'factory:work_item_id=133',
        'factory:plan_task_number=2',
        'factory:pending_approval',
      ],
    });
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'current batch change\n');

    expect(autoCommit.initFactoryWorktreeAutoCommit()).toBe(true);
    taskEvents.emit('task:completed', { id: 'task-stale-batch', status: 'completed' });
    await waitForAutoCommitListener();

    const decisions = listDecisionRows(db);
    const statusOutput = runRealGit(worktreePath, ['status', '--porcelain']).trim();

    expect(countCommits(worktreePath)).toBe(1);
    expect(statusOutput).toContain('feature.txt');
    expect(decisions).toHaveLength(0);
  });

  it('commits dirty factory worktree changes after a completed plan task and logs auto_committed_task', async () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-commit',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=3',
        'factory:pending_approval',
      ],
      metadata: {
        plan_task_title: 'Add audit logging',
      },
    });
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello\n');

    expect(autoCommit.initFactoryWorktreeAutoCommit()).toBe(true);
    taskEvents.emit('task:completed', { id: 'task-commit', status: 'completed' });
    await waitForAutoCommitListener();

    const lastSubject = runRealGit(worktreePath, ['log', '-1', '--pretty=%s']).trim();
    const headSha = runRealGit(worktreePath, ['rev-parse', 'HEAD']).trim();
    const decisions = listDecisionRows(db);

    expect(lastSubject).toBe('feat(factory): plan task 3 — Add audit logging');
    expect(countCommits(worktreePath)).toBe(2);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'auto_committed_task',
      outcome: {
        commit_sha: headSha,
        task_id: 'task-commit',
        plan_task_number: 3,
      },
    });
    expect(decisions[0].outcome.files_changed).toContain('feature.txt');
  });

  it('cleans factory run artifacts and plan progress churn without committing them', async () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-artifacts-only',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=4',
        'factory:pending_approval',
      ],
      metadata: { plan_task_title: 'Skip artifact churn' },
    });

    const planPath = path.join(worktreePath, 'docs', 'superpowers', 'plans', 'factory-plan.md');
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, '# Factory Plan\n\n- [ ] original step\n');
    runRealGit(worktreePath, ['add', 'docs/superpowers/plans/factory-plan.md']);
    runRealGit(worktreePath, ['commit', '-m', 'test: seed plan file']);
    const commitCountBefore = countCommits(worktreePath);

    fs.writeFileSync(planPath, '# Factory Plan\n\n- [x] original step\n');
    const runManifest = path.join(worktreePath, 'runs', 'artifact-run', 'manifest.json');
    fs.mkdirSync(path.dirname(runManifest), { recursive: true });
    fs.writeFileSync(runManifest, '{"ok":true}\n');

    autoCommit.initFactoryWorktreeAutoCommit();
    taskEvents.emit('task:completed', { id: 'task-artifacts-only', status: 'completed' });
    await waitForAutoCommitListener();

    const decisions = listDecisionRows(db);
    expect(countCommits(worktreePath)).toBe(commitCountBefore);
    expect(runRealGit(worktreePath, ['status', '--porcelain']).trim()).toBe('');
    expect(fs.readFileSync(planPath, 'utf8')).toContain('- [ ] original step');
    expect(fs.existsSync(runManifest)).toBe(false);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'auto_commit_skipped_clean',
      outcome: {
        task_id: 'task-artifacts-only',
        plan_task_number: 4,
        files_changed: [],
      },
    });
    expect(decisions[0].outcome.skipped_non_product_files).toEqual(
      expect.arrayContaining([
        'docs/superpowers/plans/factory-plan.md',
        'runs/artifact-run/manifest.json',
      ]),
    );
    expect(decisions[0].outcome.cleaned_non_product_files).toEqual(
      expect.arrayContaining([
        'docs/superpowers/plans/factory-plan.md',
        'runs/artifact-run/manifest.json',
      ]),
    );
  });

  it('commits product files while cleaning non-product factory artifacts', async () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-product-plus-artifacts',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=5',
        'factory:pending_approval',
      ],
      metadata: { plan_task_title: 'Commit product only' },
    });

    const productPath = path.join(worktreePath, 'server', 'factory', 'product-change.js');
    fs.mkdirSync(path.dirname(productPath), { recursive: true });
    fs.writeFileSync(productPath, 'module.exports = true;\n');
    const runManifest = path.join(worktreePath, 'runs', 'artifact-run', 'manifest.json');
    fs.mkdirSync(path.dirname(runManifest), { recursive: true });
    fs.writeFileSync(runManifest, '{"ok":true}\n');

    autoCommit.initFactoryWorktreeAutoCommit();
    taskEvents.emit('task:completed', { id: 'task-product-plus-artifacts', status: 'completed' });
    await waitForAutoCommitListener();

    const decisions = listDecisionRows(db);
    const committedFiles = runRealGit(worktreePath, ['show', '--name-only', '--pretty=', 'HEAD'])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(countCommits(worktreePath)).toBe(2);
    expect(runRealGit(worktreePath, ['status', '--porcelain']).trim()).toBe('');
    expect(fs.existsSync(runManifest)).toBe(false);
    expect(committedFiles).toContain('server/factory/product-change.js');
    expect(committedFiles).not.toContain('runs/artifact-run/manifest.json');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'auto_committed_task',
      outcome: {
        task_id: 'task-product-plus-artifacts',
        plan_task_number: 5,
      },
    });
    expect(decisions[0].outcome.files_changed).toEqual(['server/factory/product-change.js']);
    expect(decisions[0].outcome.skipped_non_product_files).toEqual(['runs/artifact-run/manifest.json']);
    expect(decisions[0].outcome.cleaned_non_product_files).toEqual(['runs/artifact-run/manifest.json']);
  });

  it('rejects verify retry edits outside the existing branch and plan scope before committing', async () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);

    const scopedFile = path.join(worktreePath, 'server', 'tests', 'metrics.test.js');
    fs.mkdirSync(path.dirname(scopedFile), { recursive: true });
    fs.writeFileSync(scopedFile, 'expect(metric).toBe("torque_tasks_total");\n');
    runRealGit(worktreePath, ['add', 'server/tests/metrics.test.js']);
    runRealGit(worktreePath, ['commit', '-m', 'fix(metrics): seed branch scope']);
    const commitCountBefore = countCommits(worktreePath);

    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-retry-plan-'));
    tempDirs.push(planDir);
    const planPath = path.join(planDir, '584-metrics.md');
    fs.writeFileSync(planPath, 'Edit server/tests/metrics.test.js only.\n');

    insertTask(db, {
      taskId: 'task-off-scope-retry',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:work_item_id=7',
        'factory:plan_task_number=1001',
        'factory:verify_retry=1',
      ],
      metadata: {
        plan_path: planPath,
        plan_task_title: 'verify auto-retry #1',
      },
    });

    const offScopePath = path.join(worktreePath, 'server', 'handlers', 'auto-recovery-handlers.js');
    fs.mkdirSync(path.dirname(offScopePath), { recursive: true });
    fs.writeFileSync(offScopePath, 'module.exports = { unrelated: true };\n');

    expect(autoCommit.initFactoryWorktreeAutoCommit()).toBe(true);
    taskEvents.emit('task:completed', { id: 'task-off-scope-retry', status: 'completed' });
    await waitForAutoCommitListener();

    const decisions = listDecisionRows(db);
    expect(countCommits(worktreePath)).toBe(commitCountBefore);
    expect(runRealGit(worktreePath, ['status', '--porcelain']).trim()).toBe('');
    expect(fs.existsSync(offScopePath)).toBe(false);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'auto_commit_rejected_off_scope',
      outcome: {
        task_id: 'task-off-scope-retry',
        plan_task_number: 1001,
      },
    });
    expect(decisions[0].outcome.off_scope_files).toContain('server/handlers/auto-recovery-handlers.js');
    expect(decisions[0].outcome.scope_envelope).toEqual(
      expect.arrayContaining(['server/tests/metrics.test.js']),
    );
  });

  it('passes --no-verify to git commit so the pre-commit hook does not deadlock on the TORQUE HTTP API', async () => {
    // Regression test for the LEARN-stage worktree_merge_failed chain:
    // the per-task auto-commit runs via execFileSync and the pre-commit
    // hook's PII-guard re-enters TORQUE via HTTP. When the call site is
    // inside TORQUE's own event loop, that HTTP call deadlocks and the
    // fallback regex scanner false-positives on RFC1918 IPs in test
    // fixtures. The factory has already PII-sanitized inline before
    // staging, so the hook is a duplicate check. Skipping it via
    // --no-verify is the fix — this test pins that flag in place.
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-no-verify',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=5',
        'factory:pending_approval',
      ],
      metadata: { plan_task_title: 'Smoke test' },
    });
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello\n');

    const gitSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options) => (
      originalExecFileSync(file, args, options)
    ));

    expect(autoCommit.initFactoryWorktreeAutoCommit()).toBe(true);
    taskEvents.emit('task:completed', { id: 'task-no-verify', status: 'completed' });
    await waitForAutoCommitListener();

    const commitCalls = gitSpy.mock.calls.filter(
      ([file, args]) => file === 'git' && Array.isArray(args) && args[0] === 'commit'
    );

    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0][1]).toContain('--no-verify');
    expect(countCommits(worktreePath)).toBe(2);
  });

  it('logs auto_commit_skipped_clean when the worktree is already clean', async () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-clean',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=3',
        'factory:pending_approval',
      ],
    });

    const gitSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options) => (
      originalExecFileSync(file, args, options)
    ));

    autoCommit.initFactoryWorktreeAutoCommit();
    taskEvents.emit('task:completed', { id: 'task-clean', status: 'completed' });
    await waitForAutoCommitListener();

    const decisions = listDecisionRows(db);
    const commitCalls = gitSpy.mock.calls.filter(([file, args]) => file === 'git' && Array.isArray(args) && args[0] === 'commit');

    expect(countCommits(worktreePath)).toBe(1);
    expect(commitCalls).toHaveLength(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'auto_commit_skipped_clean',
      outcome: {
        task_id: 'task-clean',
        plan_task_number: 3,
        files_changed: [],
      },
    });
  });

  it('ignores completed tasks that do not carry factory plan tags', async () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-non-factory',
      workingDirectory: worktreePath,
      tags: ['project:test'],
    });
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello\n');

    const gitSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options) => (
      originalExecFileSync(file, args, options)
    ));

    autoCommit.initFactoryWorktreeAutoCommit();
    taskEvents.emit('task:completed', { id: 'task-non-factory', status: 'completed' });
    await waitForAutoCommitListener();

    const commitCalls = gitSpy.mock.calls.filter(([file, args]) => file === 'git' && Array.isArray(args) && args[0] === 'commit');

    expect(countCommits(worktreePath)).toBe(1);
    expect(commitCalls).toHaveLength(0);
    expect(listDecisionRows(db)).toHaveLength(0);
    expect(runRealGit(worktreePath, ['status', '--porcelain']).trim()).toContain('feature.txt');
  });

  it('does nothing when a factory task fails instead of completing', () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-failed',
      status: 'failed',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=3',
        'factory:pending_approval',
      ],
    });
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello\n');

    const gitSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options) => (
      originalExecFileSync(file, args, options)
    ));

    autoCommit.initFactoryWorktreeAutoCommit();
    taskEvents.emit('task:failed', { id: 'task-failed', status: 'failed' });

    const commitCalls = gitSpy.mock.calls.filter(([file, args]) => file === 'git' && Array.isArray(args) && args[0] === 'commit');

    expect(countCommits(worktreePath)).toBe(1);
    expect(commitCalls).toHaveLength(0);
    expect(listDecisionRows(db)).toHaveLength(0);
  });

  it('logs auto_commit_failed when git commit throws and preserves the dirty worktree', async () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-commit-fail',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=3',
        'factory:pending_approval',
      ],
      metadata: {
        plan_task_title: 'Add audit logging',
      },
    });
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello\n');

    vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options) => {
      if (file === 'git' && Array.isArray(args) && args[0] === 'commit') {
        const error = new Error('simulated commit failure');
        error.stderr = 'simulated commit failure';
        throw error;
      }
      return originalExecFileSync(file, args, options);
    });

    autoCommit.initFactoryWorktreeAutoCommit();
    taskEvents.emit('task:completed', { id: 'task-commit-fail', status: 'completed' });
    await waitForAutoCommitListener();

    const decisions = listDecisionRows(db);
    const statusOutput = runRealGit(worktreePath, ['status', '--porcelain']).trim();

    expect(countCommits(worktreePath)).toBe(1);
    expect(statusOutput).toContain('feature.txt');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'auto_commit_failed',
      outcome: {
        task_id: 'task-commit-fail',
        plan_task_number: 3,
      },
    });
    expect(decisions[0].outcome.error).toContain('simulated commit failure');
  });

  describe('worktree-auto-commit — attempt history + rationale', () => {
    it('writes an attempt_history row with classifier fields when the worktree is clean and Codex said "already in place"', async () => {
      await runAutoCommitListenerWithStdoutTail({
        stdoutTail: 'The change is already in place.',
        dirtyFiles: [],
        batchId: 'batch-h1',
        workItemId: 'wi-h1',
        taskId: 'task-h1',
        planTaskNumber: 1,
      });

      const rows = db.prepare('SELECT * FROM factory_attempt_history WHERE batch_id=?').all('batch-h1');
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('execute');
      expect(rows[0].file_count).toBe(0);
      expect(rows[0].zero_diff_reason).toBe('already_in_place');
      expect(rows[0].classifier_source).toBe('heuristic');
      expect(JSON.parse(rows[0].files_touched)).toEqual([]);

      const decision = db.prepare("SELECT * FROM factory_decisions WHERE action='auto_commit_skipped_clean' AND batch_id=?").get('batch-h1');
      const outcome = JSON.parse(decision.outcome_json || decision.outcome);
      expect(outcome.zero_diff_reason).toBe('already_in_place');
      expect(outcome.classifier_source).toBe('heuristic');
    });

    it('writes an attempt_history row with classifier_source=none on the successful commit path', async () => {
      await runAutoCommitListenerWithStdoutTail({
        stdoutTail: 'Created two files.',
        dirtyFiles: ['src/a.js', 'src/b.js'],
        batchId: 'batch-h2',
        workItemId: 'wi-h2',
        taskId: 'task-h2',
        planTaskNumber: 1,
      });
      const row = db.prepare('SELECT * FROM factory_attempt_history WHERE batch_id=?').get('batch-h2');
      expect(row.file_count).toBe(2);
      expect(JSON.parse(row.files_touched).sort()).toEqual(['src/a.js', 'src/b.js'].sort());
      expect(row.classifier_source).toBe('none');
      expect(row.zero_diff_reason).toBeNull();
    });

    it('sets kind=verify_retry when the task tag factory:verify_retry=N is present', async () => {
      await runAutoCommitListenerWithStdoutTail({
        stdoutTail: 'already in place',
        dirtyFiles: [],
        batchId: 'batch-h3',
        workItemId: 'wi-h3',
        taskId: 'task-h3',
        planTaskNumber: 1002,
        extraTags: ['factory:verify_retry=2'],
      });
      const row = db.prepare('SELECT * FROM factory_attempt_history WHERE batch_id=?').get('batch-h3');
      expect(row.kind).toBe('verify_retry');
    });
  });
});
