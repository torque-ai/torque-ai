'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');

const SUBJECT_PATH = require.resolve('../providers/agentic-git-safety');
const LOGGER_PATH = require.resolve('../logger');
const ORIGINAL_LOGGER_CACHE = require.cache[LOGGER_PATH];

let repoDir;
let tempDirs;
let trackedFiles;
let gitRepos;
let loggerMock;
let captureSnapshot;
let checkAndRevert;
let hydrateSnapshot;
let revertChangesSinceSnapshot;
let revertScopedChanges;
let serializeSnapshot;

function installMock(modulePath, exportsValue) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsValue,
  };
}

function formatGitOutput(text, encoding) {
  if (encoding === 'utf8' || encoding === 'utf-8') {
    return text;
  }
  return Buffer.from(text);
}

function normalizeRelative(rootDir, absolutePath) {
  return path.relative(rootDir, absolutePath).replace(/\\/g, '/');
}

function listFiles(rootDir) {
  const results = [];

  function visit(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      results.push(normalizeRelative(rootDir, fullPath));
    }
  }

  visit(rootDir);
  return results.sort();
}

function isIgnored(cwd, relativePath) {
  const ignorePath = path.join(cwd, '.gitignore');
  if (!fs.existsSync(ignorePath)) {
    return false;
  }

  const rules = fs.readFileSync(ignorePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return rules.some((rule) => {
    if (rule.endsWith('/')) {
      return relativePath.startsWith(rule);
    }
    return relativePath === rule;
  });
}

function getDirtyTrackedFiles(cwd) {
  const dirty = [];

  for (const [relativePath, baseline] of trackedFiles.entries()) {
    const fullPath = path.join(cwd, relativePath);
    if (!fs.existsSync(fullPath)) {
      dirty.push(relativePath);
      continue;
    }

    const current = fs.readFileSync(fullPath, 'utf8');
    if (current !== baseline) {
      dirty.push(relativePath);
    }
  }

  return dirty.sort();
}

function getUntrackedFiles(cwd) {
  return listFiles(cwd)
    .filter((relativePath) => !trackedFiles.has(relativePath) && !isIgnored(cwd, relativePath))
    .sort();
}

function buildGitMock() {
  return vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options = {}) => {
    if (file !== 'git') {
      throw new Error(`Unexpected command: ${file}`);
    }

    const cwd = options.cwd;
    if (!gitRepos.has(cwd)) {
      const err = new Error('not a git repository');
      err.status = 128;
      throw err;
    }

    const [subcommand, ...rest] = args;

    if (subcommand === 'diff' && rest.length === 1 && rest[0] === '--name-only') {
      const output = getDirtyTrackedFiles(cwd).join('\n');
      return formatGitOutput(output ? `${output}\n` : '', options.encoding);
    }

    if (subcommand === 'status' && rest.length === 1 && rest[0] === '--porcelain') {
      const output = getUntrackedFiles(cwd).map((relativePath) => `?? ${relativePath}`).join('\n');
      return formatGitOutput(output ? `${output}\n` : '', options.encoding);
    }

    if (subcommand === 'ls-files') {
      const relativeRoot = rest[rest.length - 1] || '';
      const output = getUntrackedFiles(cwd)
        .filter((relativePath) => relativePath.startsWith(relativeRoot))
        .join('\n');
      return formatGitOutput(output ? `${output}\n` : '', options.encoding);
    }

    if (subcommand === 'check-ignore') {
      const relativePath = rest[rest.length - 1];
      if (isIgnored(cwd, relativePath)) {
        return formatGitOutput('', options.encoding);
      }

      const err = new Error('not ignored');
      err.status = 1;
      throw err;
    }

    if (subcommand === 'checkout') {
      const relativePath = rest[rest.length - 1];
      const baseline = trackedFiles.get(relativePath);
      if (baseline === undefined) {
        const err = new Error(`pathspec '${relativePath}' did not match any file(s) known to git`);
        err.status = 1;
        throw err;
      }

      fs.mkdirSync(path.dirname(path.join(cwd, relativePath)), { recursive: true });
      fs.writeFileSync(path.join(cwd, relativePath), baseline, 'utf8');
      return formatGitOutput('', options.encoding);
    }

    return formatGitOutput('', options.encoding);
  });
}

function setupRepo() {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-git-'));
  tempDirs.push(repoDir);
  gitRepos.add(repoDir);

  trackedFiles = new Map([
    ['main.cs', 'original'],
    ['.gitignore', 'build/\n'],
  ]);

  fs.writeFileSync(path.join(repoDir, 'main.cs'), 'original', 'utf8');
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'build/\n', 'utf8');
}

function readFile(relativePath) {
  return fs.readFileSync(path.join(repoDir, relativePath), 'utf8');
}

function writeFile(relativePath, content) {
  const fullPath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(repoDir, relativePath));
}

beforeEach(() => {
  tempDirs = [];
  gitRepos = new Set();
  loggerMock = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };

  buildGitMock();
  installMock(LOGGER_PATH, loggerMock);
  delete require.cache[SUBJECT_PATH];

  ({
    captureSnapshot,
    checkAndRevert,
    hydrateSnapshot,
    revertChangesSinceSnapshot,
    revertScopedChanges,
    serializeSnapshot,
  } = require('../providers/agentic-git-safety'));
  setupRepo();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[SUBJECT_PATH];
  if (ORIGINAL_LOGGER_CACHE) {
    require.cache[LOGGER_PATH] = ORIGINAL_LOGGER_CACHE;
  } else {
    delete require.cache[LOGGER_PATH];
  }

  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('captureSnapshot', () => {
  it('returns empty sets in a clean repo', () => {
    const snap = captureSnapshot(repoDir);
    expect(snap.isGitRepo).toBe(true);
    expect(snap.dirtyFiles.size).toBe(0);
    expect(snap.untrackedFiles.size).toBe(0);
  });

  it('captures pre-existing dirty tracked file', () => {
    writeFile('main.cs', 'modified');
    const snap = captureSnapshot(repoDir);
    expect(snap.dirtyFiles.has('main.cs')).toBe(true);
  });

  it('captures pre-existing untracked file', () => {
    writeFile('new-file.cs', 'hello');
    const snap = captureSnapshot(repoDir);
    expect(snap.untrackedFiles.has('new-file.cs')).toBe(true);
  });

  it('returns isGitRepo: false for non-git directory', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-nongit-'));
    tempDirs.push(nonGit);

    const snap = captureSnapshot(nonGit);
    expect(snap.isGitRepo).toBe(false);
    expect(snap.dirtyFiles.size).toBe(0);
    expect(snap.untrackedFiles.size).toBe(0);
  });
});

describe('checkAndRevert — no changes', () => {
  it('returns empty reverted and kept arrays when nothing changed after snapshot', () => {
    const snap = captureSnapshot(repoDir);
    const result = checkAndRevert(repoDir, snap, 'update AccountService', 'enforce');
    expect(result.reverted).toHaveLength(0);
    expect(result.kept).toHaveLength(0);
    expect(result.report).toBe('');
  });
});

describe('checkAndRevert — authorized change', () => {
  it('keeps a dirty tracked file whose name appears in the task description', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('main.cs', 'changed by task');
    const result = checkAndRevert(repoDir, snap, 'refactor main.cs to use async', 'enforce');
    expect(result.kept).toContain('main.cs');
    expect(result.reverted).not.toContain('main.cs');
    expect(readFile('main.cs')).toBe('changed by task');
  });

  it('keeps a new file whose parent directory name appears in the task description', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('Accounting/Account.cs', 'new accounting file');
    const result = checkAndRevert(repoDir, snap, 'add Accounting module', 'enforce');
    expect(result.kept.some((file) => file.includes('Accounting/Account.cs'))).toBe(true);
    expect(fileExists('Accounting/Account.cs')).toBe(true);
  });

  it('keeps an explicitly allowlisted file even when the task description is generic', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('src/Allowed.cs', 'new content');
    const result = checkAndRevert(repoDir, snap, 'implement the next task exactly as written', 'enforce', {
      authorizedPaths: ['src/Allowed.cs'],
    });
    expect(result.kept).toContain('src/Allowed.cs');
    expect(result.reverted).not.toContain('src/Allowed.cs');
    expect(readFile('src/Allowed.cs')).toBe('new content');
  });
});

describe('checkAndRevert — unauthorized tracked file change', () => {
  it('reverts a dirty tracked file not mentioned in the task description', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('main.cs', 'unauthorized modification');
    const result = checkAndRevert(repoDir, snap, 'update README', 'enforce');
    expect(result.reverted).toContain('main.cs');
    expect(result.kept).not.toContain('main.cs');
    expect(readFile('main.cs')).toBe('original');
  });

  it('includes reverted files in the report string', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('main.cs', 'unauthorized');
    const result = checkAndRevert(repoDir, snap, 'fix typo in docs', 'enforce');
    expect(result.report).toMatch(/Reverted 1 unauthorized change/);
    expect(result.report).toContain('main.cs');
  });
});

describe('checkAndRevert — unauthorized new file', () => {
  it('deletes an untracked file not mentioned in the task description', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('stray.tmp', 'surprise file');
    const result = checkAndRevert(repoDir, snap, 'update Invoice model', 'enforce');
    expect(result.reverted.some((file) => file.includes('stray.tmp'))).toBe(true);
    expect(fileExists('stray.tmp')).toBe(false);
  });
});

describe('checkAndRevert — gitignored new file', () => {
  it('leaves ignored files alone because git status omits them', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('build/output.dll', 'compiled');
    const result = checkAndRevert(repoDir, snap, 'compile project', 'enforce');
    expect(fileExists('build/output.dll')).toBe(true);
    expect(result.reverted.filter((file) => file.includes('build'))).toHaveLength(0);
    expect(result.kept.filter((file) => file.includes('build'))).toHaveLength(0);
  });
});

describe('checkAndRevert — pre-existing dirty state preserved', () => {
  it('does not revert files that were already dirty before snapshot', () => {
    writeFile('main.cs', 'pre-existing modification');
    const snap = captureSnapshot(repoDir);
    const result = checkAndRevert(repoDir, snap, 'update README', 'enforce');
    expect(result.reverted).not.toContain('main.cs');
    expect(readFile('main.cs')).toBe('pre-existing modification');
  });

  it('does not revert pre-existing untracked files', () => {
    writeFile('pre-existing.cs', 'was here before');
    const snap = captureSnapshot(repoDir);
    const result = checkAndRevert(repoDir, snap, 'unrelated task', 'enforce');
    expect(result.reverted.some((file) => file.includes('pre-existing.cs'))).toBe(false);
    expect(fileExists('pre-existing.cs')).toBe(true);
  });
});

describe('checkAndRevert — mode=warn', () => {
  it('does not revert unauthorized changes but includes them in kept', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('main.cs', 'unauthorized in warn mode');
    const result = checkAndRevert(repoDir, snap, 'update README', 'warn');
    expect(readFile('main.cs')).toBe('unauthorized in warn mode');
    expect(result.reverted).toHaveLength(0);
    expect(result.kept).toContain('main.cs');
  });

  it('does not delete unauthorized new files in warn mode', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('sneaky.cs', 'surprise');
    const result = checkAndRevert(repoDir, snap, 'update Invoice', 'warn');
    expect(fileExists('sneaky.cs')).toBe(true);
    expect(result.reverted).toHaveLength(0);
    expect(result.kept).toContain('sneaky.cs');
  });
});

describe('checkAndRevert — mode=off', () => {
  it('skips all checks and returns empty results', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('main.cs', 'modified');
    writeFile('extra.cs', 'new file');
    const result = checkAndRevert(repoDir, snap, 'unrelated task', 'off');
    expect(result.reverted).toHaveLength(0);
    expect(result.kept).toHaveLength(0);
    expect(result.report).toBe('');
    expect(readFile('main.cs')).toBe('modified');
    expect(fileExists('extra.cs')).toBe(true);
  });
});

describe('checkAndRevert — non-git directory', () => {
  it('returns empty results gracefully when snapshot has isGitRepo: false', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-nongit-'));
    tempDirs.push(nonGit);

    const snap = captureSnapshot(nonGit);
    expect(snap.isGitRepo).toBe(false);

    const result = checkAndRevert(nonGit, snap, 'any task', 'enforce');
    expect(result.reverted).toHaveLength(0);
    expect(result.kept).toHaveLength(0);
    expect(result.report).toBe('');
  });
});

describe('revertScopedChanges', () => {
  it('reverts only the requested tracked file changed after snapshot', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('main.cs', 'failed task change');
    writeFile('README.md', 'leave this alone');

    const result = revertScopedChanges(repoDir, snap, [path.join(repoDir, 'main.cs')]);

    expect(result.reverted).toContain('main.cs');
    expect(result.reverted).not.toContain('README.md');
    expect(readFile('main.cs')).toBe('original');
    expect(readFile('README.md')).toBe('leave this alone');
  });

  it('deletes only the requested untracked file changed after snapshot', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('failed.tmp', 'remove me');
    writeFile('keep.tmp', 'keep me');

    const result = revertScopedChanges(repoDir, snap, ['failed.tmp']);

    expect(result.reverted).toContain('failed.tmp');
    expect(fileExists('failed.tmp')).toBe(false);
    expect(fileExists('keep.tmp')).toBe(true);
  });
});

describe('restart-safe snapshot rollback', () => {
  it('serializes and hydrates snapshots for cross-restart rollback', () => {
    writeFile('preexisting.tmp', 'already here');
    const snap = captureSnapshot(repoDir);
    const serialized = serializeSnapshot(snap, repoDir);
    const hydrated = hydrateSnapshot(serialized);

    expect(serialized.working_directory).toBe(repoDir);
    expect(serialized.untrackedFiles).toContain('preexisting.tmp');
    expect(hydrated.isGitRepo).toBe(true);
    expect(hydrated.untrackedFiles.has('preexisting.tmp')).toBe(true);
  });

  it('reverts all post-snapshot changes while preserving pre-existing dirt', () => {
    writeFile('preexisting.tmp', 'already here');
    const snap = hydrateSnapshot(serializeSnapshot(captureSnapshot(repoDir), repoDir));

    writeFile('main.cs', 'interrupted edit');
    writeFile('new-output.txt', 'interrupted new file');

    const result = revertChangesSinceSnapshot(repoDir, snap);

    expect(result.reverted).toEqual(expect.arrayContaining(['main.cs', 'new-output.txt']));
    expect(readFile('main.cs')).toBe('original');
    expect(fileExists('new-output.txt')).toBe(false);
    expect(fileExists('preexisting.tmp')).toBe(true);
  });
});
