/**
 * Smart Scan — Import Parser
 *
 * Parses JS/TS files to extract import/require statements and resolves them
 * to absolute file paths. Used by context-stuffed providers to discover
 * which files to embed in prompts.
 *
 * Complementary to file-resolution.js (which resolves paths from task
 * descriptions). This module resolves imports FROM within source files.
 */

const fs = require('fs');
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
 * Resolve a relative import specifier to an absolute file path.
 *
 * Resolution strategy (first match wins):
 * 1. Exact path (specifier already has an extension that exists)
 * 2. Append each RESOLVE_EXTENSIONS in order
 * 3. Treat as directory and try index files with each extension
 *
 * @param {string} specifier - Relative import specifier (e.g., './utils')
 * @param {string} importerDir - Absolute path to the directory of the importing file
 * @returns {string|null} Absolute path to the resolved file, or null if unresolvable
 */
function resolveImportPath(specifier, importerDir) {
  const basePath = path.resolve(importerDir, specifier);

  // 1. Try exact path
  if (fileExists(basePath)) {
    return basePath;
  }

  // 2. Try appending each extension
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = basePath + ext;
    if (fileExists(withExt)) {
      return withExt;
    }
  }

  // 3. Try as directory with index file
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexPath = path.join(basePath, 'index' + ext);
    if (fileExists(indexPath)) {
      return indexPath;
    }
  }

  return null;
}

/**
 * Check if a path exists and is a file (not a directory).
 * @param {string} filePath
 * @returns {boolean}
 */
function fileExists(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
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
 * @returns {string[]} Array of absolute paths to resolved import targets
 */
function parseImports(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const importerDir = path.dirname(filePath);
  const resolved = new Set();

  for (const pattern of IMPORT_PATTERNS) {
    // Reset lastIndex since patterns have the global flag
    pattern.lastIndex = 0;

    let match;
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1];

      // Skip bare specifiers (node builtins, npm packages)
      if (!isRelativeImport(specifier)) {
        continue;
      }

      const resolvedPath = resolveImportPath(specifier, importerDir);
      if (resolvedPath) {
        resolved.add(resolvedPath);
      }
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
 * @returns {string[]} Array of absolute paths to convention-matched files
 */
function findConventionMatches(filePath, conventionPatterns) {
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
      if (fileExists(candidate)) {
        results.push(candidate);
      }
    }
  }

  return results;
}

/**
 * Maximum file size in bytes. Files larger than this are skipped during scanning.
 */
const MAX_FILE_SIZE_BYTES = 200 * 1024;

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
 * @param {Object} options
 * @param {string[]} options.files - Explicit file paths (absolute or relative to workingDirectory)
 * @param {string} [options.workingDirectory] - Base directory for resolving relative paths
 * @param {number} [options.contextDepth=1] - How many levels of imports to follow
 * @param {Array} [options.conventionPatterns] - Convention rules (default: DEFAULT_CONVENTION_PATTERNS)
 * @returns {{ contextFiles: string[], skipped: string[], reasons: Map<string, string> }}
 */
function smartScan({ files, workingDirectory, contextDepth = 1, conventionPatterns }) {
  const contextFiles = [];
  const skipped = [];
  const reasons = new Map();
  const seen = new Set();

  /**
   * Internal helper — adds a file if not already seen, within size limit.
   * @param {string} filePath - Absolute path
   * @param {string} reason - Why this file was included
   */
  function addFile(filePath, reason) {
    const normalized = path.resolve(filePath);
    if (seen.has(normalized)) return;
    seen.add(normalized);

    // Size guard
    try {
      const stat = fs.statSync(normalized);
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

  // Phase 1: Explicit files
  for (const file of files) {
    const abs = workingDirectory ? path.resolve(workingDirectory, file) : path.resolve(file);
    addFile(abs, 'explicit');
  }

  // Phase 2: Breadth-first import discovery
  // Start with the explicit files as the frontier for level 1
  let frontier = contextFiles.slice(); // snapshot of explicit files

  for (let level = 1; level <= contextDepth; level++) {
    const nextFrontier = [];
    for (const file of frontier) {
      const imports = parseImports(file);
      for (const imp of imports) {
        const reasonLabel = level === 1
          ? `import:${path.basename(imp)}`
          : `import-level-${level}:${path.basename(imp)}`;
        const beforeLen = contextFiles.length;
        addFile(imp, reasonLabel);
        // Only add to next frontier if it was actually new
        if (contextFiles.length > beforeLen) {
          nextFrontier.push(imp);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Phase 3: Convention matches for ALL discovered files so far
  const allSoFar = contextFiles.slice();
  for (const file of allSoFar) {
    const matches = findConventionMatches(file, conventionPatterns);
    for (const match of matches) {
      addFile(match, `convention:${path.basename(match)}`);
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
 * @returns {{ contextFiles: string[], skipped: string[], reasons: Map<string, string> }}
 */
function resolveContextFiles({ taskDescription, workingDirectory, files = [], contextDepth = 1, conventionPatterns } = {}) {
  const explicitFiles = [...files];

  // Extract file references from description using existing file-resolution utility
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
  resolveImportPath,
  parseImports,
  DEFAULT_CONVENTION_PATTERNS,
  findConventionMatches,
  MAX_FILE_SIZE_BYTES,
  smartScan,
  resolveContextFiles,
};
