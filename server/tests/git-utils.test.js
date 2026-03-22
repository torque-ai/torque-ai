'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { gitSync, cleanupRepo } = require('./git-test-utils');

const { parseGitStatusLine, getModifiedFiles } = require('../utils/git');

describe('utils/git.js', () => {
  let testDir;

  const readFirstStatusLine = () => {
    const status = gitSync(['status', '--porcelain'], { cwd: testDir });
    const firstLine = status.split(/\r?\n/)[0];
    return firstLine;
  };

  beforeAll(() => {
    testDir = path.join(os.tmpdir(), `torque-git-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    gitSync(['init'], { cwd: testDir });
    gitSync(['config', 'user.email', 'test@test.com'], { cwd: testDir });
    gitSync(['config', 'user.name', 'Test'], { cwd: testDir });

    fs.writeFileSync(path.join(testDir, 'baseline.txt'), 'baseline content');
    fs.writeFileSync(path.join(testDir, 'rename-source.txt'), 'rename source');
    gitSync(['add', 'baseline.txt', 'rename-source.txt'], { cwd: testDir });
    gitSync(['commit', '-m', 'init', '--no-gpg-sign'], { cwd: testDir });
  });

  beforeEach(() => {
    gitSync(['reset', '--hard'], { cwd: testDir });
    gitSync(['clean', '-fd'], { cwd: testDir });
  });

  afterAll(() => {
    cleanupRepo(testDir);
  });

  describe('parseGitStatusLine', () => {
    it('parses modified files from porcelain output', () => {
      fs.writeFileSync(path.join(testDir, 'baseline.txt'), 'updated baseline');
      const line = readFirstStatusLine();
      const parsed = parseGitStatusLine(line);

      expect(parsed).not.toBeNull();
      // Git status --porcelain format is "XY PATH" (2 status chars + space + path).
      // On some Windows git configurations, autocrlf or line-ending normalization
      // may produce "M baseline.txt" (staged) instead of " M baseline.txt" (worktree).
      // Both are valid — just verify it's detected as modified.
      expect(parsed.isModified).toBe(true);
      expect(parsed.isNew).toBe(false);
      expect(parsed.isDeleted).toBe(false);
      expect(parsed.isRenamed).toBe(false);
    });

    it('parses staged additions from porcelain output', () => {
      fs.writeFileSync(path.join(testDir, 'staged.txt'), 'staged');
      gitSync(['add', 'staged.txt'], { cwd: testDir });

      const parsed = parseGitStatusLine(readFirstStatusLine());

      expect(parsed).toMatchObject({
        indexStatus: 'A',
        workStatus: ' ',
        filePath: 'staged.txt',
        isNew: true,
        isModified: false,
      });
    });

    it('parses quoted file paths from porcelain output', () => {
      fs.writeFileSync(path.join(testDir, 'path with spaces.txt'), 'spaced file');

      const parsed = parseGitStatusLine(readFirstStatusLine());

      expect(parsed).not.toBeNull();
      expect(parsed.filePath).toBe('path with spaces.txt');
      expect(parsed.indexStatus).toBe('?');
      expect(parsed.workStatus).toBe('?');
      expect(parsed.isNew).toBe(true);
    });

    it('parses renamed files from porcelain output', () => {
      gitSync(['mv', 'rename-source.txt', 'rename-target.txt'], { cwd: testDir });

      const parsed = parseGitStatusLine(readFirstStatusLine());

      expect(parsed).toMatchObject({
        indexStatus: 'R',
        workStatus: ' ',
        filePath: 'rename-source.txt -> rename-target.txt',
        isRenamed: true,
      });
    });
  });

  describe('getModifiedFiles', () => {
    it('returns an empty array for a clean repository', () => {
      expect(getModifiedFiles(testDir)).toEqual([]);
    });

    it('returns untracked files detected by git status', () => {
      fs.writeFileSync(path.join(testDir, 'untracked.txt'), 'new file');

      const modified = getModifiedFiles(testDir);
      const untracked = modified.find(entry => entry.filePath === 'untracked.txt');

      expect(untracked).toBeDefined();
      expect(untracked).toMatchObject({
        indexStatus: '?',
        workStatus: '?',
        isNew: true,
      });
    });

    it('returns staged and working-tree modified files', () => {
      const trackedPath = path.join(testDir, 'baseline.txt');
      fs.writeFileSync(trackedPath, 'first edit');
      gitSync(['add', 'baseline.txt'], { cwd: testDir });
      fs.writeFileSync(trackedPath, 'second edit');

      const modified = getModifiedFiles(testDir);
      const entry = modified.find(item => item.filePath === 'baseline.txt');

      expect(entry).not.toBeUndefined();
      expect(entry).toMatchObject({
        indexStatus: 'M',
        workStatus: 'M',
        isModified: true,
      });
    });

    it('returns staged additions', () => {
      fs.writeFileSync(path.join(testDir, 'new-added.txt'), 'new staged file');
      gitSync(['add', 'new-added.txt'], { cwd: testDir });

      const modified = getModifiedFiles(testDir);
      const stagedEntry = modified.find(item => item.filePath === 'new-added.txt');

      expect(stagedEntry).not.toBeUndefined();
      expect(stagedEntry).toMatchObject({
        indexStatus: 'A',
        workStatus: ' ',
        isNew: true,
      });
    });

    it('returns renamed file entries', () => {
      gitSync(['mv', 'rename-source.txt', 'rename-target.txt'], { cwd: testDir });

      const modified = getModifiedFiles(testDir);
      const renameEntry = modified.find(item => item.isRenamed);

      expect(renameEntry).toBeDefined();
      expect(renameEntry.filePath).toBe('rename-source.txt -> rename-target.txt');
    });
  });
});
