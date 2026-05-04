'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const strategy = require('../factory/recovery-strategies/discard-regenerable-merge-block');

function git(cwd, args) {
  const r = childProcess.spawnSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 'noreply@example.invalid',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 'noreply@example.invalid',
    },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return String(r.stdout || '').trim();
}

function setupRepo(workdir) {
  git(workdir, ['init', '--quiet']);
  git(workdir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(workdir, 'README.md'), 'baseline\n');
  git(workdir, ['add', 'README.md']);
  git(workdir, ['commit', '--quiet', '-m', 'init']);
}

function makeDeps(repoRoot) {
  return {
    factoryHealth: {
      getProject: (id) => ({ id, path: repoRoot }),
    },
    logger: { info: () => {}, warn: () => {} },
  };
}

describe('discard-regenerable-merge-block', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discard-mb-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('parsePorcelainLine', () => {
    it('parses untracked entry', () => {
      expect(strategy.parsePorcelainLine('?? docs/superpowers/plans/auto-generated/100.md'))
        .toEqual({ status: '??', path: 'docs/superpowers/plans/auto-generated/100.md' });
    });
    it('parses modified-tracked entry', () => {
      expect(strategy.parsePorcelainLine(' M src/foo.js'))
        .toEqual({ status: 'M', path: 'src/foo.js' });
    });
    it('normalizes Windows paths', () => {
      expect(strategy.parsePorcelainLine('?? docs\\superpowers\\plans\\auto-generated\\100.md').path)
        .toBe('docs/superpowers/plans/auto-generated/100.md');
    });
    it('returns null for empty line', () => {
      expect(strategy.parsePorcelainLine('')).toBe(null);
      expect(strategy.parsePorcelainLine('   ')).toBe(null);
    });
  });

  describe('classifyDirtyEntries', () => {
    it('puts auto-generated plans on the allowlist', () => {
      const entries = [
        { status: '??', path: 'docs/superpowers/plans/auto-generated/100.md' },
        { status: 'M', path: 'docs/plans/auto-generated/200.md' },
      ];
      const c = strategy.classifyDirtyEntries(entries);
      expect(c.allowlisted).toHaveLength(2);
      expect(c.blockers).toHaveLength(0);
    });

    it('puts repo source files in blockers', () => {
      const entries = [
        { status: 'M', path: 'src/foo.js' },
      ];
      const c = strategy.classifyDirtyEntries(entries);
      expect(c.allowlisted).toHaveLength(0);
      expect(c.blockers).toHaveLength(1);
    });

    it('separates allowlist from blockers in mixed input', () => {
      const entries = [
        { status: '??', path: 'docs/superpowers/plans/auto-generated/1.md' },
        { status: 'M', path: 'src/foo.js' },
        { status: '??', path: '.torque-checkpoints/x.json' },
      ];
      const c = strategy.classifyDirtyEntries(entries);
      expect(c.allowlisted.map(e => e.path).sort()).toEqual([
        '.torque-checkpoints/x.json',
        'docs/superpowers/plans/auto-generated/1.md',
      ]);
      expect(c.blockers.map(e => e.path)).toEqual(['src/foo.js']);
    });

    it('handles editor backup patterns', () => {
      const entries = [
        { status: '??', path: '.foo.swp' },
        { status: '??', path: 'src/bar.js.bak' },
        { status: '??', path: 'src/baz.js.orig' },
        { status: '??', path: 'src/qux.js~' },
      ];
      const c = strategy.classifyDirtyEntries(entries);
      expect(c.allowlisted).toHaveLength(4);
      expect(c.blockers).toHaveLength(0);
    });

    it('puts staged-added (A) into unhandledStatus even if path is allowlisted', () => {
      const entries = [
        { status: 'A', path: 'docs/superpowers/plans/auto-generated/1.md' },
      ];
      const c = strategy.classifyDirtyEntries(entries);
      expect(c.unhandledStatus).toHaveLength(1);
      expect(c.allowlisted).toHaveLength(0);
    });
  });

  describe('replan (end-to-end)', () => {
    it('discards untracked allowlisted files and signals retry', async () => {
      setupRepo(dir);
      fs.mkdirSync(path.join(dir, 'docs/superpowers/plans/auto-generated'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'docs/superpowers/plans/auto-generated/123.md'),
        '# stale plan\n'
      );

      const result = await strategy.replan({
        workItem: { id: 'wi-1', project_id: 'proj-1' },
        deps: makeDeps(dir),
      });

      expect(result.outcome).toBe('unblocked');
      expect(result.details.removed).toContain('docs/superpowers/plans/auto-generated/123.md');
      // File should be gone
      expect(fs.existsSync(path.join(dir, 'docs/superpowers/plans/auto-generated/123.md'))).toBe(false);
    });

    it('restores tracked-modified allowlisted files via git checkout', async () => {
      setupRepo(dir);
      fs.mkdirSync(path.join(dir, 'docs/superpowers/plans/auto-generated'), { recursive: true });
      const planPath = 'docs/superpowers/plans/auto-generated/456.md';
      fs.writeFileSync(path.join(dir, planPath), 'committed content\n');
      git(dir, ['add', planPath]);
      git(dir, ['commit', '--quiet', '-m', 'add plan']);
      // Now modify it
      fs.writeFileSync(path.join(dir, planPath), 'modified content\n');

      const result = await strategy.replan({
        workItem: { id: 'wi-2', project_id: 'proj-1' },
        deps: makeDeps(dir),
      });

      expect(result.outcome).toBe('unblocked');
      expect(result.details.restored).toContain(planPath);
      expect(fs.readFileSync(path.join(dir, planPath), 'utf8')).toBe('committed content\n');
    });

    it('refuses when non-regenerable files are dirty', async () => {
      setupRepo(dir);
      fs.writeFileSync(path.join(dir, 'src.js'), 'real work\n');

      const result = await strategy.replan({
        workItem: { id: 'wi-3', project_id: 'proj-1' },
        deps: makeDeps(dir),
      });

      expect(result.outcome).toBe('unrecoverable');
      expect(result.reason).toMatch(/non-regenerable/);
      // Real work file untouched
      expect(fs.existsSync(path.join(dir, 'src.js'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'src.js'), 'utf8')).toBe('real work\n');
    });

    it('signals unblocked with no dirty files (race against natural cleanup)', async () => {
      setupRepo(dir);
      // No dirty files

      const result = await strategy.replan({
        workItem: { id: 'wi-4', project_id: 'proj-1' },
        deps: makeDeps(dir),
      });

      expect(result.outcome).toBe('unblocked');
      expect(result.reason).toBe('merge_target_clean_at_recovery_time');
    });

    it('refuses cleanly when project has no path', async () => {
      const result = await strategy.replan({
        workItem: { id: 'wi-5', project_id: 'proj-no-path' },
        deps: {
          factoryHealth: { getProject: () => ({ id: 'proj-no-path' }) },
          logger: { info: () => {}, warn: () => {} },
        },
      });

      expect(result.outcome).toBe('unrecoverable');
      expect(result.reason).toMatch(/repo path unavailable/);
    });

    it('mixed dirty (allowlisted + blocker) refuses without touching anything', async () => {
      setupRepo(dir);
      fs.mkdirSync(path.join(dir, 'docs/superpowers/plans/auto-generated'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'docs/superpowers/plans/auto-generated/789.md'),
        '# stale plan\n'
      );
      fs.writeFileSync(path.join(dir, 'real.js'), 'work\n');

      const result = await strategy.replan({
        workItem: { id: 'wi-6', project_id: 'proj-1' },
        deps: makeDeps(dir),
      });

      expect(result.outcome).toBe('unrecoverable');
      // Both files still exist — strategy refused to touch anything
      expect(fs.existsSync(path.join(dir, 'docs/superpowers/plans/auto-generated/789.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'real.js'))).toBe(true);
    });
  });

  describe('strategy registration shape', () => {
    it('exports name + reasonPatterns + replan', () => {
      expect(strategy.name).toBe('discard-regenerable-merge-block');
      expect(strategy.reasonPatterns).toEqual(expect.arrayContaining([expect.any(RegExp)]));
      expect(typeof strategy.replan).toBe('function');
    });

    it('matches merge_target_dirty reasons', () => {
      const matches = (s) => strategy.reasonPatterns.some((re) => re.test(s));
      expect(matches('merge_target_dirty')).toBe(true);
      expect(matches('merge_target_dirty:foo')).toBe(true);
      expect(matches('merge_target_in_conflict_state')).toBe(false);
      expect(matches('something_else')).toBe(false);
    });
  });
});
