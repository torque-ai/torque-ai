'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('node:child_process');
const {
  verifyCompletedTaskArtifacts,
  countCommitsAheadOfBase,
  createPlanExecutor,
} = require('../factory/plan-executor');
const { parsePlanFile } = require('../factory/plan-parser');

function git(cwd, args) {
  const r = childProcess.spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return String(r.stdout || '').trim();
}

function setupRepo(workdir) {
  // `git init -b <branch>` requires git 2.28+, which isn't guaranteed on
  // every host (the remote workstation in pre-push gate has older git).
  // Init with default branch name, then rename to 'master' after the
  // first commit — works on any git version.
  git(workdir, ['init', '--quiet']);
  git(workdir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(workdir, 'README.md'), 'baseline\n');
  git(workdir, ['add', 'README.md']);
  git(workdir, ['commit', '--quiet', '-m', 'initial']);
  // -M renames the current branch (force-rename, idempotent).
  git(workdir, ['branch', '-M', 'master']);
}

function makeTaskWithEditTarget(targetRelPath) {
  const md = `## Task 1: edit thing\n\n- [ ] **Step 1: edit \`${targetRelPath}\`**\n\n\`\`\`text\nDo the work.\n\`\`\`\n`;
  const parsed = parsePlanFile(`# Plan\n\n${md}`);
  return parsed.tasks[0];
}

describe('Phase X7: branch-state gate for [x] trust', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-x7-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('countCommitsAheadOfBase', () => {
    it('returns 0 for a fresh branch with no commits ahead of base', () => {
      setupRepo(dir);
      git(dir, ['checkout', '--quiet', '-b', 'feat/empty']);
      expect(countCommitsAheadOfBase(dir, 'master')).toBe(0);
    });

    it('returns >0 when the branch has commits ahead of base', () => {
      setupRepo(dir);
      git(dir, ['checkout', '--quiet', '-b', 'feat/work']);
      fs.writeFileSync(path.join(dir, 'work.txt'), 'work\n');
      git(dir, ['add', 'work.txt']);
      git(dir, ['commit', '--quiet', '-m', 'add work']);
      expect(countCommitsAheadOfBase(dir, 'master')).toBe(1);
    });

    it('returns null when the directory is not a git repo', () => {
      // dir is a fresh tmpdir, no `git init`
      expect(countCommitsAheadOfBase(dir, 'master')).toBe(null);
    });

    it('returns null when baseBranch is missing', () => {
      setupRepo(dir);
      expect(countCommitsAheadOfBase(dir, '')).toBe(null);
      expect(countCommitsAheadOfBase(dir, null)).toBe(null);
    });

    it('returns null when baseBranch does not exist', () => {
      setupRepo(dir);
      // 'nonexistent' isn't a ref → git rev-list errors out
      expect(countCommitsAheadOfBase(dir, 'nonexistent')).toBe(null);
    });
  });

  describe('verifyCompletedTaskArtifacts with baseBranch', () => {
    it('refuses trust when branch has 0 commits ahead, even when cited files exist', () => {
      setupRepo(dir);
      git(dir, ['checkout', '--quiet', '-b', 'feat/empty']);
      // Cited file exists in the working dir (e.g., as repo boilerplate)
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'existing\n');
      const task = makeTaskWithEditTarget('src/app.js');

      const v = verifyCompletedTaskArtifacts(task, dir, 'master');

      expect(v.trust).toBe(false);
      expect(v.reason).toBe('branch_no_commits_ahead');
      expect(v.commitsAhead).toBe(0);
      expect(v.baseBranch).toBe('master');
    });

    it('trusts when branch has commits ahead and cited files exist', () => {
      setupRepo(dir);
      git(dir, ['checkout', '--quiet', '-b', 'feat/work']);
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'real work\n');
      git(dir, ['add', 'src/app.js']);
      git(dir, ['commit', '--quiet', '-m', 'real work']);
      const task = makeTaskWithEditTarget('src/app.js');

      const v = verifyCompletedTaskArtifacts(task, dir, 'master');

      expect(v.trust).toBe(true);
      expect(v.reason).toBe('all_artifacts_present');
    });

    it('refuses trust when branch has commits but cited files are missing', () => {
      setupRepo(dir);
      git(dir, ['checkout', '--quiet', '-b', 'feat/work']);
      // Add some unrelated commit so branch has commits ahead
      fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'noise\n');
      git(dir, ['add', 'unrelated.txt']);
      git(dir, ['commit', '--quiet', '-m', 'unrelated']);
      const task = makeTaskWithEditTarget('src/app.js');

      const v = verifyCompletedTaskArtifacts(task, dir, 'master');

      expect(v.trust).toBe(false);
      expect(v.reason).toBe('no_artifacts_present');
    });

    it('falls through to path check when baseBranch is null (back-compat)', () => {
      // No git init, no baseBranch — the gate is skipped entirely.
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'exists\n');
      const task = makeTaskWithEditTarget('src/app.js');

      const v = verifyCompletedTaskArtifacts(task, dir, null);

      expect(v.trust).toBe(true);
      expect(v.reason).toBe('all_artifacts_present');
    });

    it('falls through when baseBranch is set but the dir is not a git repo', () => {
      // Plain tmpdir, baseBranch passed but no git → git fails → null →
      // fall through to path check.
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'exists\n');
      const task = makeTaskWithEditTarget('src/app.js');

      const v = verifyCompletedTaskArtifacts(task, dir, 'master');

      expect(v.trust).toBe(true);
      expect(v.reason).toBe('all_artifacts_present');
    });

    it('returns trust=true when no working_directory is provided', () => {
      const task = makeTaskWithEditTarget('src/app.js');
      const v = verifyCompletedTaskArtifacts(task, null, 'master');
      expect(v.trust).toBe(true);
      expect(v.reason).toBe('no_working_directory');
    });
  });

  describe('executor reuse path with branch-state gate', () => {
    it('does NOT reuse a completed task when the branch has no commits ahead', async () => {
      setupRepo(dir);
      git(dir, ['checkout', '--quiet', '-b', 'feat/empty']);
      // Cited file exists but no real branch work.
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'preexisting\n');
      const planPath = path.join(dir, 'plan.md');
      fs.writeFileSync(
        planPath,
        `# Reuse Plan

## Task 1: ship it

- [ ] **Step 1: edit \`src/app.js\`**

\`\`\`text
Do the work.
\`\`\`
`
      );

      const submitMock = vi.fn(async () => ({ task_id: 'fresh-task' }));
      const awaitMock = vi.fn(async () => ({ status: 'completed', verify_status: 'passed' }));
      const findReusableTask = vi.fn(async () => ({ task_id: 'old-completed-task', status: 'completed' }));

      const executor = createPlanExecutor({
        submit: submitMock,
        awaitTask: awaitMock,
        findReusableTask,
      });

      const result = await executor.execute({
        plan_path: planPath,
        project: 'test',
        working_directory: dir,
        execution_mode: 'live',
        baseBranch: 'master',
      });

      // Reuse should NOT fire — the gate says branch has no commits ahead,
      // so the old completed task can't possibly have produced its work
      // here. Executor must submit fresh.
      expect(submitMock).toHaveBeenCalledTimes(1);
      expect(awaitMock).toHaveBeenCalledWith(expect.objectContaining({
        task_id: 'fresh-task',
      }));
      expect(result.completed_tasks).toEqual([1]);
    });

    it('DOES reuse a completed task when the branch already has commits ahead', async () => {
      setupRepo(dir);
      git(dir, ['checkout', '--quiet', '-b', 'feat/work']);
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'real change\n');
      git(dir, ['add', 'src/app.js']);
      git(dir, ['commit', '--quiet', '-m', 'real change']);
      const planPath = path.join(dir, 'plan.md');
      fs.writeFileSync(
        planPath,
        `# Reuse Plan

## Task 1: ship it

- [ ] **Step 1: edit \`src/app.js\`**

\`\`\`text
Do the work.
\`\`\`
`
      );

      const submitMock = vi.fn(async () => ({ task_id: 'fresh-task' }));
      const awaitMock = vi.fn(async () => ({ status: 'completed', verify_status: 'passed' }));
      const findReusableTask = vi.fn(async () => ({ task_id: 'reused-task', status: 'completed' }));

      const executor = createPlanExecutor({
        submit: submitMock,
        awaitTask: awaitMock,
        findReusableTask,
      });

      const result = await executor.execute({
        plan_path: planPath,
        project: 'test',
        working_directory: dir,
        execution_mode: 'live',
        baseBranch: 'master',
      });

      // Branch has commits → reuse is allowed → no fresh submit, no await.
      expect(submitMock).not.toHaveBeenCalled();
      expect(awaitMock).not.toHaveBeenCalled();
      expect(result.completed_tasks).toEqual([1]);
      expect(fs.readFileSync(planPath, 'utf8')).toContain('[x]');
    });
  });
});
