'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const logger = require('../logger').child({ component: 'project-files' });

// Resolve execFileSync with a guarded preference for the real (unpatched)
// implementation. vitest's worker-setup.js monkey-patches
// child_process.execFileSync to stub git calls — without bypassing that stub
// tryGitListFiles would get empty output instead of real `git ls-files`
// results. The guard mirrors git-worktree.js: only prefer _realExecFileSync
// when the current export is the test guard (not an intentional test mock).
function resolveExecFileSync() {
  const current = childProcess.execFileSync;
  const isMockFunction = Boolean(current && (current._isMockFunction || current.mock));
  if (
    childProcess._realExecFileSync
    && current?.__torqueTestGuard === true
    && !isMockFunction
  ) {
    return childProcess._realExecFileSync;
  }
  return current;
}

// Directories excluded from the project file census.
// Applied as the primary filter in the non-git fallback walk only.
// When git enumeration succeeds, its output is the authoritative file
// list and no additional static filtering is applied.
const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__', '.venv',
  '.cache', '.vitest-tmp', '.vitest-logs', '.tmp-vitest',
  '.codex-temp', '.codex-context', '.codex-worktrees',
  '.worktrees', '.aider.tags.cache.v4',
  // Vendored / generated / build-output dirs that are git-ignored in well-formed
  // projects but pollute the census when a directory is scanned without git.
  'Library', 'PackageCache', 'Temp', 'Logs', 'obj', 'bin', 'target',
  'vendor', 'Pods', '.gradle', 'DerivedData',
];

const DEFAULT_IGNORE_PREFIXES = ['.tmp', '.tmp-'];

// Returns relative paths from `git ls-files`, or null when `rootDir` is not a
// git repo / git is unavailable / the command fails.
function tryGitListFiles(rootDir) {
  const execFileSync = resolveExecFileSync();
  const runGit = (args) => execFileSync.call(childProcess, 'git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  let tracked;
  let untracked;
  try {
    tracked = runGit(['ls-files', '-z']);
    untracked = runGit(['ls-files', '-z', '--others', '--exclude-standard']);
  } catch (err) {
    logger.debug(`[project-files] git enumeration unavailable for ${rootDir}: ${err.message || err}`);
    return null;
  }
  const seen = new Set();
  for (const out of [tracked, untracked]) {
    for (const part of String(out).split('\0')) {
      if (part) seen.add(part);
    }
  }
  return Array.from(seen);
}

// Recursive filesystem walk used only when git enumeration is unavailable.
function walkDirFallback(rootDir, ignoreDirs, ignorePrefixes) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      if (dir === rootDir) throw err;
      return;
    }
    for (const entry of entries) {
      if (ignoreDirs.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (ignorePrefixes.some(p => entry.name === p || entry.name.startsWith(p + '-'))) continue;
        walk(fullPath);
      } else if (stat.isFile()) {
        out.push(path.relative(rootDir, fullPath));
      }
    }
  }
  walk(rootDir);
  return out;
}

// Enumerates the project's own files under rootDir. Returns objects shaped
// exactly like the previous handleScanProject walkDir output:
//   { path, relativePath, name, ext, size, lines }
function listProjectFiles(rootDir, options = {}) {
  const ignoreDirs = options.ignoreDirs instanceof Set
    ? options.ignoreDirs
    : new Set(options.ignoreDirs || DEFAULT_IGNORE_DIRS);
  const ignorePrefixes = options.ignorePrefixes || DEFAULT_IGNORE_PREFIXES;

  const gitRelPaths = tryGitListFiles(rootDir);
  // When git enumeration succeeds, its output is already gitignore-filtered
  // and is the authoritative file list — the static dir filter is NOT applied
  // (doing so would strip negation-rescued paths like `build/keep.txt` that
  // git explicitly included). The dir filter is the primary filter in the
  // fallback (non-git) walk only.
  const useGit = gitRelPaths !== null;
  const relPaths = useGit
    ? gitRelPaths
    : walkDirFallback(rootDir, ignoreDirs, ignorePrefixes);

  const files = [];
  for (const relPath of relPaths) {
    const fullPath = path.join(rootDir, relPath);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      // Tracked-but-deleted file, submodule gitlink, or a race — skip.
      continue;
    }
    if (!stat.isFile()) continue;
    files.push({
      path: fullPath,
      // Both sources already produce a clean repo-relative path: git hands one
      // back directly, and walkDirFallback uses path.relative. Recomputing it
      // here via path.relative(rootDir, path.join(rootDir, relPath)) would only
      // round-trip the value and can shift casing on Windows — use it as-is.
      relativePath: relPath,
      name: path.basename(relPath),
      ext: path.extname(relPath).toLowerCase(),
      size: stat.size,
      lines: null,
    });
  }
  return files;
}

module.exports = { listProjectFiles, DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_PREFIXES };
