/**
 * Smart Scan — Import Parser
 *
 * Parses JS/TS files to extract import/require statements and resolves them
 * to absolute file paths. Used by context-stuffed providers to discover
 * which files to embed in prompts.
 *
 * Complementary to file-resolution.js (which resolves paths from task
 * descriptions). This module resolves imports FROM within source files.
 *
 * All filesystem access is async (fs/promises). This module runs on the
 * submission path (smart_submit_task / submit_task); blocking the event loop
 * with synchronous stat/read storms stalled every other MCP request and the
 * queue poll. A per-invocation directory-entry cache collapses the import
 * resolver's extension probe (previously up to 12 stat calls per unresolved
 * specifier) to one cached readdir per directory.
 */

const fsp = require('fs/promises');
const path = require('path');

/**
 * Extensions to try when resolving extensionless import specifiers.
 * Order matters — first match wins.
 */
const RESOLVE_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];

/**
 * Regex patterns for extracting import specifiers from JS/TS source code.
 *
 * [0] ES module static imports and re-exports:
 *     import { foo } from './utils'
 *     import foo from './bar'
 *     import * as ns from './baz'
 *     import './side-effect'
 *     export { x } from './re-export'
 *
 * [1] Dynamic imports:
 *     import('./dynamic.js')
 *     await import('./lazy')
 *
 * [2] CommonJS require:
 *     const a = require('./alpha')
 *     const { x } = require('./beta')
 *     require('./side-effect')
 *
 * Consumed via String.prototype.matchAll — stateless, so the same pattern
 * objects are safe to share across concurrent parseImports() calls (no
 * lastIndex mutation).
 */
const IMPORT_PATTERNS = [
  // ES module static imports and re-exports
  /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+(?:[\s\S]*?\s+from\s+))['"]([^'"]+)['"]/g,
  // Dynamic import()
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  // CommonJS require()
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Maximum file size in bytes. Files larger than this are skipped during scanning.
 */
const MAX_FILE_SIZE_BYTES = 200 * 1024;

/**
 * Concurrency cap for the breadth-first import scan. Import parsing is
 * I/O-bound (file read + extension-probe readdir); a handful of overlapping
 * reads hides per-call latency without saturating the disk. Tunable via
 * TORQUE_SMART_SCAN_CONCURRENCY; default 8 mirrors the codegraph indexer.
 */
function scanConcurrency() {
  const env = parseInt(process.env.TORQUE_SMART_SCAN_CONCURRENCY || '', 10);
  if (Number.isFinite(env) && env >= 1) return Math.min(env, 64);
  return 8;
}

/**
 * Create a fresh per-invocation scan cache. Threaded through resolveImportPath
 * and findConventionMatches so a directory is read from disk at most once per
 * smartScan() call. Standalone callers may omit it — each function lazily
 * creates its own when none is supplied.
 *
 * @returns {{ dirs: Map<string, Map<string, import('fs').Dirent>|null> }}
 */
function createScanCache() {
  return { dirs: new Map() };
}

/**
 * Read a directory's entries (name → Dirent) once, caching the result.
 * Returns null when the directory does not exist or cannot be read.
 *
 * @param {string} dir - Absolute directory path
 * @param {object} cache - Scan cache from createScanCache()
 * @returns {Promise<Map<string, import('fs').Dirent>|null>}
 */
async function getDirEntries(dir, cache) {
  if (cache.dirs.has(dir)) {
    return cache.dirs.get(dir);
  }
  let entries = null;
  try {
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    entries = new Map();
    for (const dirent of dirents) {
      entries.set(dirent.name, dirent);
    }
  } catch {
    entries = null;
  }
  cache.dirs.set(dir, entries);
  return entries;
}

/**
 * Whether `name` inside `dir` resolves to a regular file (symlinks followed).
 * Uses the cached directory listing; only symlink entries need a confirming
 * stat, so the common case costs zero stat calls.
 *
 * @param {string} dir - Absolute directory path
 * @param {string} name - Entry basename
 * @param {object} cache - Scan cache
 * @returns {Promise<boolean>}
 */
async function isFileInDir(dir, name, cache) {
  const entries = await getDirEntries(dir, cache);
  if (!entries) return false;
  const dirent = entries.get(name);
  if (!dirent) return false;
  if (dirent.isFile()) return true;
  if (dirent.isSymbolicLink()) {
    // stat() follows the symlink — matches the previous statSync().isFile().
    try {
      return (await fsp.stat(path.join(dir, name))).isFile();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Check whether an import specifier is a relative path (starts with ./ or ../).
 * Bare specifiers (e.g., 'express', 'fs', '@scope/pkg') are not relative.
 *
 * @param {string} specifier - The import specifier string
 * @returns {boolean}
 */
function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Check if a path exists and is a file (not a directory). Symlinks followed.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    return (await fsp.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a relative import specifier to an absolute file path.
 *
 * Resolution strategy (first match wins):
 * 1. Exact path (specifier already has an extension that exists)
 * 2. Append each RESOLVE_EXTENSIONS in order
 * 3. Treat as directory and try index files with each extension
 *
 * @param {string} specifier - Relative import specifier (e.g., './utils')
 * @param {string} importerDir - Absolute path to the directory of the importing file
 * @param {object} [cache] - Scan cache; created per-call when omitted
 * @returns {Promise<string|null>} Absolute path to the resolved file, or null if unresolvable
 */
async function resolveImportPath(specifier, importerDir, cache) {
  const scanCache = cache || createScanCache();
  const basePath = path.resolve(importerDir, specifier);
  const baseDir = path.dirname(basePath);
  const baseName = path.basename(basePath);

  // 1. Exact path, and 2. each appended extension — all share one readdir
  //    of the specifier's parent directory.
  if (await isFileInDir(baseDir, baseName, scanCache)) {
    return basePath;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (await isFileInDir(baseDir, baseName + ext, scanCache)) {
      return basePath + ext;
    }
  }

  // 3. Directory index — basePath itself is treated as a directory.
  for (const ext of RESOLVE_EXTENSIONS) {
    if (await isFileInDir(basePath, 'index' + ext, scanCache)) {
      return path.join(basePath, 'index' + ext);
    }
  }

  return null;
}

/**
 * Parse all import/require statements from a JS/TS file and resolve them
 * to absolute file paths.
 *
 * - Only resolves relative imports (./ and ../)
 * - Skips bare specifiers (node_modules, Node builtins)
 * - Skips imports that don't resolve to existing files
 * - Deduplicates results
 *
 * @param {string} filePath - Absolute path to the source file to parse
 * @param {object} [cache] - Scan cache; created per-call when omitted
 * @returns {Promise<string[]>} Array of absolute paths to resolved import targets
 */
async function parseImports(filePath, cache) {
  const scanCache = cache || createScanCache();
  let content;
  try {
    content = await fsp.readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const importerDir = path.dirname(filePath);

  // Collect unique relative specifiers in deterministic order: pattern order,
  // then match order within each pattern.
  const specifiers = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (isRelativeImport(specifier)) {
        specifiers.add(specifier);
      }
    }
  }

  const resolved = new Set();
  for (const specifier of specifiers) {
    const resolvedPath = await resolveImportPath(specifier, importerDir, scanCache);
    if (resolvedPath) {
      resolved.add(resolvedPath);
    }
  }

  return Array.from(resolved);
}

/**
 * Default convention patterns for discovering related files.
 *
 * Each entry has:
 *   match   — regex tested against the basename
 *   guard   — (optional) extra regex the basename must NOT match
 *   generate — function(basename, dir) → array of candidate absolute paths
 *
 * Candidates are checked for existence on disk; only real files are returned.
 */
const DEFAULT_CONVENTION_PATTERNS = [
  // Source file → test file (.test.EXT)
  {
    match: /^(.+)\.(js|ts|jsx|tsx|mjs|cjs)$/,
    guard: /\.(test|spec)\./,
    generate: (basename, dir) => {
      const m = basename.match(/^(.+)\.(js|ts|jsx|tsx|mjs|cjs)$/);
      if (!m) return [];
      return [path.join(dir, `${m[1]}.test.${m[2]}`)];
    },
  },
  // Source file → spec file (.spec.EXT)
  {
    match: /^(.+)\.(js|ts|jsx|tsx|mjs|cjs)$/,
    guard: /\.(test|spec)\./,
    generate: (basename, dir) => {
      const m = basename.match(/^(.+)\.(js|ts|jsx|tsx|mjs|cjs)$/);
      if (!m) return [];
      return [path.join(dir, `${m[1]}.spec.${m[2]}`)];
    },
  },
  // Test file → source file (strip .test.EXT)
  {
    match: /^(.+)\.test\.(js|ts|jsx|tsx|mjs|cjs)$/,
    generate: (basename, dir) => {
      const m = basename.match(/^(.+)\.test\.(js|ts|jsx|tsx|mjs|cjs)$/);
      if (!m) return [];
      return [path.join(dir, `${m[1]}.${m[2]}`)];
    },
  },
  // Spec file → source file (strip .spec.EXT)
  {
    match: /^(.+)\.spec\.(js|ts|jsx|tsx|mjs|cjs)$/,
    generate: (basename, dir) => {
      const m = basename.match(/^(.+)\.spec\.(js|ts|jsx|tsx|mjs|cjs)$/);
      if (!m) return [];
      return [path.join(dir, `${m[1]}.${m[2]}`)];
    },
  },
  // *System.ts → types.ts, constants.ts in same directory
  {
    match: /^.+System\.ts$/,
    generate: (_basename, dir) => {
      return [
        path.join(dir, 'types.ts'),
        path.join(dir, 'constants.ts'),
      ];
    },
  },
];

/**
 * Find convention-based related files for a given file path.
 *
 * Applies each convention pattern against the file's basename. When a pattern
 * matches (and its guard, if present, does NOT match), the generate function
 * produces candidate paths. Only candidates that exist on disk are returned.
 *
 * @param {string} filePath - Absolute path to the source file
 * @param {Array} [conventionPatterns=DEFAULT_CONVENTION_PATTERNS] - Convention rules
 * @param {object} [cache] - Scan cache; created per-call when omitted
 * @returns {Promise<string[]>} Array of absolute paths to convention-matched files
 */
async function findConventionMatches(filePath, conventionPatterns, cache) {
  const scanCache = cache || createScanCache();
  const patterns = conventionPatterns || DEFAULT_CONVENTION_PATTERNS;
  const basename = path.basename(filePath);
  const dir = path.dirname(filePath);
  const results = [];
  const seen = new Set();

  for (const pattern of patterns) {
    if (!pattern.match.test(basename)) continue;
    if (pattern.guard && pattern.guard.test(basename)) continue;

    const candidates = pattern.generate(basename, dir);
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      // Generated candidates always live in `dir`, so one cached readdir
      // covers every pattern for this file.
      if (await isFileInDir(path.dirname(candidate), path.basename(candidate), scanCache)) {
        results.push(candidate);
      }
    }
  }

  return results;
}

/**
 * Run an async mapper over an array with a bounded number of in-flight calls.
 * Results preserve input order. Workers pull from a shared cursor so a slow
 * item never blocks the others.
 *
 * @template T,R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @param {number} limit - Max concurrent mapper calls
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, mapper, limit) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Smart Scan — Orchestrator function.
 *
 * Discovers context files for a set of explicit files by:
 * 1. Adding explicit files (reason: 'explicit')
 * 2. Breadth-first import discovery up to contextDepth levels
 * 3. Convention matches for ALL discovered files
 *
 * Files larger than MAX_FILE_SIZE_BYTES are skipped.
 * Duplicates are suppressed — first occurrence wins.
 *
 * Import parsing within each BFS level runs with bounded concurrency, but
 * addFile is applied in deterministic frontier order so contextFiles ordering
 * is identical to a fully-sequential scan.
 *
 * @param {Object} options
 * @param {string[]} options.files - Explicit file paths (absolute or relative to workingDirectory)
 * @param {string} [options.workingDirectory] - Base directory for resolving relative paths
 * @param {number} [options.contextDepth=1] - How many levels of imports to follow
 * @param {Array} [options.conventionPatterns] - Convention rules (default: DEFAULT_CONVENTION_PATTERNS)
 * @returns {Promise<{ contextFiles: string[], skipped: string[], reasons: Map<string, string> }>}
 */
async function smartScan({ files, workingDirectory, contextDepth = 1, conventionPatterns }) {
  const cache = createScanCache();
  const contextFiles = [];
  const skipped = [];
  const reasons = new Map();
  const seen = new Set();
  const concurrency = scanConcurrency();

  /**
   * Internal helper — adds a file if not already seen, within size limit.
   * @param {string} filePath - Absolute path
   * @param {string} reason - Why this file was included
   */
  async function addFile(filePath, reason) {
    const normalized = path.resolve(filePath);
    if (seen.has(normalized)) return;
    seen.add(normalized);

    // Size guard — needs the actual byte count, so a stat is unavoidable.
    // The `seen` set keeps it to one stat per unique file.
    try {
      const stat = await fsp.stat(normalized);
      if (!stat.isFile()) return;
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        skipped.push(normalized);
        return;
      }
    } catch {
      // File doesn't exist — skip silently
      return;
    }

    contextFiles.push(normalized);
    reasons.set(normalized, reason);
  }

  // Phase 1: Explicit files — sequential to preserve insertion order.
  for (const file of files) {
    const abs = workingDirectory ? path.resolve(workingDirectory, file) : path.resolve(file);
    await addFile(abs, 'explicit');
  }

  // Phase 2: Breadth-first import discovery.
  // Start with the explicit files as the frontier for level 1.
  let frontier = contextFiles.slice(); // snapshot of explicit files

  for (let level = 1; level <= contextDepth; level++) {
    // Parse every frontier file's imports in parallel (bounded), then apply
    // addFile in frontier order so the result is order-identical to a
    // sequential scan.
    const importLists = await mapWithConcurrency(
      frontier,
      (file) => parseImports(file, cache),
      concurrency,
    );

    const nextFrontier = [];
    for (let i = 0; i < frontier.length; i++) {
      for (const imp of importLists[i]) {
        const reasonLabel = level === 1
          ? `import:${path.basename(imp)}`
          : `import-level-${level}:${path.basename(imp)}`;
        const beforeLen = contextFiles.length;
        await addFile(imp, reasonLabel);
        // Only add to next frontier if it was actually new
        if (contextFiles.length > beforeLen) {
          nextFrontier.push(imp);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Phase 3: Convention matches for ALL discovered files so far.
  const allSoFar = contextFiles.slice();
  const matchLists = await mapWithConcurrency(
    allSoFar,
    (file) => findConventionMatches(file, conventionPatterns, cache),
    concurrency,
  );
  for (let i = 0; i < allSoFar.length; i++) {
    for (const match of matchLists[i]) {
      await addFile(match, `convention:${path.basename(match)}`);
    }
  }

  return { contextFiles, skipped, reasons };
}

/**
 * Convenience wrapper: resolve context files from a task description + explicit file list.
 *
 * 1. Starts with `files` (explicit).
 * 2. Extracts file references from `taskDescription` via file-resolution.js.
 * 3. Feeds the combined list into `smartScan()` for import + convention discovery.
 *
 * @param {Object} options
 * @param {string} [options.taskDescription] - Task description to scan for file references
 * @param {string} [options.workingDirectory] - Project root
 * @param {string[]} [options.files=[]] - Explicit file paths
 * @param {number} [options.contextDepth=1] - Import depth for smartScan
 * @param {Array} [options.conventionPatterns] - Convention rules for smartScan
 * @returns {Promise<{ contextFiles: string[], skipped: string[], reasons: Map<string, string> }>}
 */
async function resolveContextFiles({ taskDescription, workingDirectory, files = [], contextDepth = 1, conventionPatterns } = {}) {
  const explicitFiles = [...files];

  // Extract file references from description using existing file-resolution
  // utility. resolveFileReferences is synchronous — left as-is; its own
  // filesystem access is out of scope for this module.
  if (taskDescription && workingDirectory) {
    try {
      const { resolveFileReferences } = require('./file-resolution');
      const resolution = resolveFileReferences(taskDescription, workingDirectory);
      if (resolution && resolution.resolved) {
        for (const rf of resolution.resolved) {
          const actual = rf.actual || rf;
          const abs = path.isAbsolute(actual) ? actual : path.resolve(workingDirectory, actual);
          if (!explicitFiles.includes(abs)) explicitFiles.push(abs);
        }
      }
    } catch {
      // Non-fatal — proceed with explicit files only
    }
  }

  if (explicitFiles.length === 0) {
    return { contextFiles: [], skipped: [], reasons: new Map() };
  }

  return smartScan({ files: explicitFiles, workingDirectory, contextDepth, conventionPatterns });
}

module.exports = {
  IMPORT_PATTERNS,
  RESOLVE_EXTENSIONS,
  isRelativeImport,
  fileExists,
  resolveImportPath,
  parseImports,
  DEFAULT_CONVENTION_PATTERNS,
  findConventionMatches,
  MAX_FILE_SIZE_BYTES,
  createScanCache,
  smartScan,
  resolveContextFiles,
};
