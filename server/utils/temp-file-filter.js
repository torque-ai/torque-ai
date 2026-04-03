'use strict';

/**
 * Default patterns for temp/debug files that should never be auto-committed.
 * Each pattern is tested against the full relative path (forward-slash normalized).
 * - Patterns ending with `/` match directory prefixes
 * - Patterns starting with `*.` match file extensions
 * - Patterns starting with a word match filename prefixes
 * - Patterns containing `*` in the middle match glob-style (e.g., `*.debug.*`)
 */
const DEFAULT_TEMP_PATTERNS = Object.freeze([
  // Directories
  'tmp/', 'temp/', '.tmp/', '.cache/', '__pycache__/',
  // Extensions
  '*.tmp', '*.bak', '*.orig', '*.log',
  // Prefix
  'debug-',
  // Glob
  '*.debug.*',
]);

function normalizePath(p) {
  return (p || '').replace(/\\/g, '/');
}

/**
 * Check if a file path matches any temp file pattern.
 * @param {string} filePath - relative file path
 * @param {string[]} [extraPatterns] - additional patterns to check (merged with defaults)
 * @returns {boolean}
 */
function isTempFile(filePath, extraPatterns) {
  const norm = normalizePath(filePath);
  const patterns = extraPatterns
    ? [...DEFAULT_TEMP_PATTERNS, ...extraPatterns]
    : DEFAULT_TEMP_PATTERNS;

  for (const pattern of patterns) {
    // Directory prefix: "tmp/" matches any path containing "/tmp/" or starting with "tmp/"
    if (pattern.endsWith('/')) {
      const dir = pattern;
      if (norm.startsWith(dir) || norm.includes(`/${dir}`)) return true;
      continue;
    }

    // Extension: "*.tmp" matches files ending with ".tmp"
    if (pattern.startsWith('*.') && !pattern.includes('*', 1)) {
      const ext = pattern.slice(1);
      if (norm.endsWith(ext)) return true;
      continue;
    }

    // Middle glob: "*.debug.*" matches any segment containing ".debug."
    if (pattern.includes('*')) {
      const inner = pattern.replace(/\*/g, '');
      const basename = norm.includes('/') ? norm.slice(norm.lastIndexOf('/') + 1) : norm;
      if (basename.includes(inner)) return true;
      continue;
    }

    // Prefix: "debug-" matches basename starting with "debug-"
    const basename = norm.includes('/') ? norm.slice(norm.lastIndexOf('/') + 1) : norm;
    if (basename.startsWith(pattern)) return true;
  }

  return false;
}

/**
 * Filter an array of file paths, separating temp files from real files.
 * @param {string[]} paths - file paths to filter
 * @param {string[]} [extraPatterns] - additional patterns beyond defaults
 * @returns {{ kept: string[], excluded: string[] }}
 */
function filterTempFiles(paths, extraPatterns) {
  const kept = [];
  const excluded = [];
  for (const filePath of paths) {
    if (isTempFile(filePath, extraPatterns)) {
      excluded.push(filePath);
    } else {
      kept.push(filePath);
    }
  }
  return { kept, excluded };
}

module.exports = { DEFAULT_TEMP_PATTERNS, isTempFile, filterTempFiles };
