'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
// Use the real (unpatched) execFileSync when running under vitest's worker
// setup, which monkey-patches child_process.execFileSync to stub git calls.
// Without this, tryGitListFiles would get empty stub output instead of the
// actual `git ls-files` results.
const execFileSync = childProcess._realExecFileSync || childProcess.execFileSync;
const logger = require('../logger').child({ component: 'project-files' });

// Directories excluded from the project file census. Used as the non-git
// fallback walk filter, and as a secondary filter even when git enumeration
// succeeds (so the manual ignore_dirs arg keeps working and committed-but-
// generated output stays excludable).
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
  const runGit = (args) => execFileSync('git', args, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
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
  for (const buf of [tracked, untracked]) {
    for (const part of buf.toString('utf8').split('\0')) {
      if (part) seen.add(part);
    }
  }
  return Array.from(seen);
}

// True when any *directory* segment of relPath is ignored.
function isIgnoredRelPath(relPath, ignoreDirs, ignorePrefixes) {
  const segments = relPath.split(/[\\/]/);
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (ignoreDirs.has(seg)) return true;
    if (ignorePrefixes.some(p => seg === p || seg.startsWith(p + '-'))) return true;
  }
  return false;
}

// Recursive filesystem walk used only when git enumeration is unavailable.
function walkDirFallback(rootDir, ignoreDirs, ignorePrefixes) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
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
  // and is the authoritative file list — do not apply the static dir filter
  // on top of it (doing so would strip negation-rescued paths like
  // `build/keep.txt` that git explicitly included). The dir filter is only
  // used as the primary filter in the fallback (non-git) walk.
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
      relativePath: path.relative(rootDir, fullPath),
      name: path.basename(relPath),
      ext: path.extname(relPath).toLowerCase(),
      size: stat.size,
      lines: null,
    });
  }
  return files;
}

module.exports = { listProjectFiles, DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_PREFIXES };
