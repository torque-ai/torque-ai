/**
 * File Resolution Module
 *
 * Extracted from task-manager.js — file path validation, reference extraction,
 * file indexing, and resolution from task descriptions.
 *
 * Pure filesystem operations — no DB dependency needed.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger').child({ component: 'file-resolution' });
const { FILE_INDEX_EXTENSIONS } = require('../constants');

// File index cache for pre-execution file resolution
// Maps working directory → { index: Map<lowercaseBasename, relativePath[]>, timestamp }
const fileIndexCache = new Map();
const FILE_INDEX_TTL_MS = 300000; // 5 min
const FILE_INDEX_MAX_ENTRIES = 10;

/**
 * Validate that a cache entry contains expected shape and live values.
 *
 * @param {*} entry
 * @returns {boolean} True when entry can be reused
 */
function hasValidCacheEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!(entry.index instanceof Map)) return false;
  if (typeof entry.timestamp !== 'number' || !Number.isFinite(entry.timestamp)) return false;
  return true;
}

/** Directories to skip during file indexing */
const FILE_INDEX_SKIP_DIRS = new Set([
  'node_modules', '.git', 'bin', 'obj', 'dist', 'build',
  '.vs', 'packages', '__pycache__', 'target', '.next',
  'coverage', '.nuget', 'TestResults', 'artifacts'
]);

/**
 * Check if a string is safe for shell usage (no injection characters)
 * @param {string} str - String to validate
 * @returns {boolean} True if safe, false if contains dangerous chars
 */
function isShellSafe(str) {
  if (!str) return true;
  // Block characters that could allow command injection
  const dangerousChars = /[`$|;&<>(){}[\]\n\r\\]/;
  return !dangerousChars.test(str);
}

/**
 * Check if a string looks like a valid file path
 */
function isValidFilePath(str) {
  if (!str || str.length < 3 || str.length > 300) return false;

  // Must contain a path separator
  if (!str.includes('/') && !str.includes('\\')) return false;

  // Must not contain XML/HTML tags or common code fragments
  if (str.includes('<') || str.includes('>') || str.includes('</')) return false;
  if (str.includes('///') || str.includes('//')) return false;  // Comments
  if (str.includes('(') || str.includes(')')) return false;  // Method calls
  if (str.includes('{') || str.includes('}')) return false;  // Code blocks
  if (str.includes('=')) return false;  // Assignments

  // Reject error messages and descriptive text
  const errorPatterns = [
    /SearchReplaceNoExactMatch/i,
    /failed to/i,
    /error:/i,
    /warning:/i,
    /exception/i,
    /cannot find/i,
    /not found/i,
    /unable to/i,
    /SEARCH block/i,
    /match lines/i,
    /does not exist/i,
  ];
  if (errorPatterns.some(pattern => pattern.test(str))) return false;

  // File paths shouldn't have multiple colons (except Windows drive letter)
  const colonCount = (str.match(/:/g) || []).length;
  if (colonCount > 1) return false;
  if (colonCount === 1 && str.indexOf(':') !== 1) return false;

  // Must have a valid extension
  const hasValidExt = [...FILE_INDEX_EXTENSIONS].some(ext => str.toLowerCase().endsWith(ext));
  if (!hasValidExt) return false;

  // Must not start with invalid characters
  if (str.startsWith('.') && !str.startsWith('./') && !str.startsWith('../')) return false;

  return true;
}

/**
 * Extract target file paths from a task description.
 * Matches patterns like "create file at <path>", "modify <path>", backtick-quoted paths.
 * @param {string} description - The task description text
 * @returns {string[]} Array of file paths extracted from the description
 */
function extractTargetFilesFromDescription(description) {
  if (!description || typeof description !== 'string') return [];

  const files = new Set();

  // Pattern 1: "Create a [new] [test] file at <path>" / "create <path>"
  const createPatterns = [
    /(?:create|write|generate)\s+(?:a\s+)?(?:new\s+)?(?:test\s+)?file\s+(?:at|in|to)\s+([^\s,`'"]+\.\w{1,5})/gi,
    /(?:create|write)\s+([^\s,`'"]+\.\w{1,5})/gi,
  ];

  // Pattern 2: "modify <path>" / "edit <path>" / "update <path>"
  const modifyPatterns = [
    /(?:modify|edit|update|change)\s+(?:the\s+)?(?:file\s+)?(?:at\s+)?([^\s,`'"]+\.\w{1,5})/gi,
  ];

  // Pattern 3: Paths inside backticks or code blocks that look like file paths
  const backtickPattern = /`([a-zA-Z][\w./\\-]+\.\w{1,5})`/g;

  for (const pattern of [...createPatterns, ...modifyPatterns]) {
    let match;
    while ((match = pattern.exec(description)) !== null) {
      const filePath = match[1].replace(/[`'"]/g, '');
      if (filePath.length > 3 && filePath.length < 200 && !filePath.startsWith('http')) {
        files.add(filePath);
      }
    }
  }

  // Only use backtick paths if they look like project file paths (have directory separators)
  let match;
  while ((match = backtickPattern.exec(description)) !== null) {
    const filePath = match[1];
    if ((filePath.includes('/') || filePath.includes('\\')) &&
        filePath.length > 3 && filePath.length < 200 &&
        !filePath.startsWith('http')) {
      files.add(filePath);
    }
  }

  return Array.from(files);
}

/**
 * Extract file references from task description (expanded patterns).
 * Broader than extractTargetFilesFromDescription — catches bare filenames.
 * @param {string} description - Task description
 * @returns {string[]} Array of file references (may be bare names or paths)
 */
function extractFileReferencesExpanded(description) {
  if (!description || typeof description !== 'string') return [];

  const refs = new Set();

  // Pattern 1: Path references — src/Foo/Bar.cs, ./path/to/file.ts, Domain/Entities/Part.cs
  const pathPattern = /(?:^|[\s:,(`])((\.{0,2}\/)?(?:[\w-]+\/)+[\w.-]+\.\w{1,5})/g;
  let match;
  while ((match = pathPattern.exec(description)) !== null) {
    const ref = match[1].trim();
    if (ref.length > 3 && ref.length < 200 && !ref.startsWith('http')) {
      refs.add(ref);
    }
  }

  // Also match Windows-style paths: Domain\Entities\Part.cs
  const winPathPattern = /(?:^|[\s:,(`])(([\w-]+\\)+[\w.-]+\.\w{1,5})/g;
  while ((match = winPathPattern.exec(description)) !== null) {
    const ref = match[1].trim();
    if (ref.length > 3 && ref.length < 200) {
      refs.add(ref);
    }
  }

  // Pattern 2: Backtick-quoted — `Part.cs`, `src/Utils/Helper.ts`
  const backtickPattern = /`([\w./-\\]+\.\w{1,5})`/g;
  while ((match = backtickPattern.exec(description)) !== null) {
    const ref = match[1].trim();
    if (ref.length > 2 && ref.length < 200 && !ref.startsWith('http')) {
      refs.add(ref);
    }
  }

  // Pattern 3: Bare filenames with code extensions after contextual words
  // e.g., "Add XML docs to Part.cs", "Review ValidationBehaviour.cs"
  const bareFilePattern = /\b([\w.-]+\.(?:cs|js|ts|py|go|rs|rb|java|cpp|c|h|hpp|jsx|tsx|vue|svelte|xaml|css|scss|html|xml|json|yaml|yml|sql|csproj|sln))\b/gi;
  while ((match = bareFilePattern.exec(description)) !== null) {
    const ref = match[1];
    // Avoid false positives: skip version-like strings (e.g., "v1.2.cs" unlikely)
    if (ref.length > 3 && !/^\d+\./.test(ref)) {
      refs.add(ref);
    }
  }

  // Merge with results from existing function for backward compat
  const legacyRefs = extractTargetFilesFromDescription(description);
  for (const r of legacyRefs) {
    refs.add(r);
  }

  return Array.from(refs);
}

/**
 * Build a file index for a working directory.
 * Returns Map<lowercaseBasename, relativePath[]> with caching.
 * @param {string} workingDirectory - Absolute path to scan
 * @returns {Map<string, string[]>}
 */
function buildFileIndex(workingDirectory) {
  // Check cache
  const cached = fileIndexCache.get(workingDirectory);
  if (hasValidCacheEntry(cached)) {
    const age = Date.now() - cached.timestamp;
    if (Number.isFinite(age) && age >= 0 && age < FILE_INDEX_TTL_MS) {
      return cached.index;
    }

    fileIndexCache.delete(workingDirectory);
  } else if (cached !== undefined) {
    // Remove corrupted cache entry and rebuild
    fileIndexCache.delete(workingDirectory);
  }

  const index = new Map();

  function walk(dir, relativeBase) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or not a directory
    }

    for (const entry of entries) {
      if (FILE_INDEX_SKIP_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;

      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (FILE_INDEX_EXTENSIONS.has(ext)) {
          const key = entry.name.toLowerCase();
          if (!index.has(key)) {
            index.set(key, []);
          }
          index.get(key).push(relativePath);
        }
      }
    }
  }

  try {
    walk(workingDirectory, '');
  } catch (e) {
    logger.info(`[FileIndex] Error building index for ${workingDirectory}: ${e.message}`);
    return index;
  }

  // Evict oldest entries if cache is full
  if (fileIndexCache.size >= FILE_INDEX_MAX_ENTRIES) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, val] of fileIndexCache) {
      if (!hasValidCacheEntry(val)) {
        fileIndexCache.delete(key);
        continue;
      }

      if (val.timestamp < oldestTime) {
        oldestTime = val.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) fileIndexCache.delete(oldestKey);
  }

  fileIndexCache.set(workingDirectory, { index, timestamp: Date.now() });
  logger.info(`[FileIndex] Built index for ${workingDirectory}: ${index.size} unique basenames`);
  return index;
}

/**
 * Resolve file references to actual paths in the working directory.
 * Three-strategy resolution: exact path, unique basename, path similarity.
 * @param {string} description - Task description
 * @param {string} workingDirectory - Absolute path to the project root
 * @returns {{ resolved: Array<{mentioned: string, actual: string, confidence: string}>, unresolved: string[] }}
 */
function resolveFileReferences(description, workingDirectory) {
  const result = { resolved: [], unresolved: [] };

  if (!description || !workingDirectory) return result;

  let fileRefs;
  try {
    fileRefs = extractFileReferencesExpanded(description);
  } catch (e) {
    logger.info(`[FileResolve] Error extracting refs: ${e.message}`);
    return result;
  }

  if (fileRefs.length === 0) return result;

  let index;
  try {
    index = buildFileIndex(workingDirectory);
  } catch (e) {
    logger.info(`[FileResolve] Error building index: ${e.message}`);
    return result;
  }

  const alreadyResolved = new Set();

  for (const ref of fileRefs) {
    // Strategy 1: Exact path — resolve and check existence (files only, not directories)
    const normalized = ref.replace(/\\/g, '/');
    const exactPath = path.resolve(workingDirectory, normalized);
    // Containment check: resolved path must be inside workingDirectory
    const relCheck = path.relative(workingDirectory, exactPath);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      result.unresolved.push(ref);
      continue;
    }
    let exists = false;
    try {
      exists = fs.existsSync(exactPath);
    } catch (e) {
      logger.info(`[FileResolve] Cannot check existence of ${exactPath}: ${e.message}`);
    }

    if (exists) {
      try {
        if (fs.statSync(exactPath).isFile() && !alreadyResolved.has(exactPath)) {
          const relPath = path.relative(workingDirectory, exactPath);
          alreadyResolved.add(exactPath);
          result.resolved.push({ mentioned: ref, actual: relPath, confidence: 'exact' });
          continue;
        }
      } catch (e) {
        // stat failed — fall through to basename strategies
        logger.info(`[FileResolve] Cannot stat ${exactPath}: ${e.message}`);
      }
    }
    // Strategy 2: Unique basename match
    const basename = path.basename(ref).toLowerCase();
    const candidates = index.get(basename);

    if (!candidates || candidates.length === 0) {
      result.unresolved.push(ref);
      continue;
    }

    if (candidates.length === 1) {
      const absPath = path.resolve(workingDirectory, candidates[0]);
      if (!alreadyResolved.has(absPath)) {
        alreadyResolved.add(absPath);
        result.resolved.push({ mentioned: ref, actual: candidates[0], confidence: 'unique-basename' });
      }
      continue;
    }

    // Strategy 3: Path similarity scoring — multiple matches
    const refParts = normalized.toLowerCase().split('/').filter(Boolean);
    const descLower = description.toLowerCase();

    let bestScore = -1;
    let bestCandidate = null;

    for (const candidate of candidates) {
      const candParts = candidate.toLowerCase().replace(/\\/g, '/').split('/').filter(Boolean);
      let score = 0;

      // Score matching path segments (excluding basename which always matches)
      for (const part of refParts.slice(0, -1)) {
        if (candParts.includes(part)) score += 3;
      }

      // Score description keyword overlap with path segments
      for (const part of candParts.slice(0, -1)) {
        if (part.length > 2 && descLower.includes(part.toLowerCase())) score += 2;
      }

      // Prefer shorter paths (closer to root = more likely the intended file)
      score -= candParts.length * 0.1;

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    // Require at least some path overlap (score > 0) for multi-candidate resolution (bug #9)
    if (bestCandidate && bestScore > 0) {
      const absPath = path.resolve(workingDirectory, bestCandidate);
      if (!alreadyResolved.has(absPath)) {
        alreadyResolved.add(absPath);
        result.resolved.push({ mentioned: ref, actual: bestCandidate, confidence: 'path-similarity' });
      }
    } else {
      result.unresolved.push(ref);
    }
  }

  if (result.resolved.length > 0) {
    logger.info(`[FileResolve] Resolved ${result.resolved.length} file(s): ${result.resolved.map(r => `${r.mentioned} → ${r.actual} (${r.confidence})`).join(', ')}`);
  }
  if (result.unresolved.length > 0) {
    logger.info(`[FileResolve] Unresolved ${result.unresolved.length} file(s): ${result.unresolved.join(', ')}`);
  }

  return result;
}

/**
 * Extract modified files from Codex output (fallback for non-git repos)
 * NOTE: This is less accurate and may include files that were only mentioned, not modified
 */
function extractModifiedFiles(output) {
  const files = [];
  const patterns = [
    /(?:Created|Modified|Wrote|Updated|Edited)\s+(?:file\s+)?[`']?([^`'\n]+)[`']?/gi,
    /Writing to\s+([^\n]+)/gi,
    /written to:\s*(?:\r?\n\s*)?([^\n]+)/gi,
    /saved to:\s*(?:\r?\n\s*)?([^\n]+)/gi,
    /File:\s+([^\n]+)/gi,
    // Aider-specific patterns - handle both same-line and next-line file paths
    /Applied edit to\s+(\S+\.(?:cs|ts|js|py|java|go|rs|cpp|c|h|hpp|xaml|json|yaml|yml|md|txt|csproj|sln|xml))/gi,
    /Applied edit to\s*\n\s*(\S+\.(?:cs|ts|js|py|java|go|rs|cpp|c|h|hpp|xaml|json|yaml|yml|md|txt|csproj|sln|xml))/gi,
    /Commit [a-f0-9]+.*\n.*\n\s+([^\n|]+)/gi,  // Commit message followed by file path
    // Codex-specific patterns — apply_patch output and git diff headers
    /^diff --git a\/(\S+) b\/\S+/gm,
    /^[MADR]\s+(\S+\.(?:cs|ts|tsx|js|jsx|py|java|go|rs|cpp|c|h|hpp|xaml|json|yaml|yml|md|txt|csproj|sln|xml|css|scss|html|vue|svelte))/gm,
    /apply_patch.*\n[+-]{3}\s+[ab]\/(\S+)/gm,
    /Success\.\s+Updated the following files:\n(?:M\s+(\S+))/gm,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(output)) !== null) {
      const file = match[1].trim();
      // Validate that this looks like an actual file path, not XML docs or code
      if (file && !files.includes(file) && isValidFilePath(file)) {
        files.push(file);
      }
    }
  }

  return files;
}

module.exports = {
  isShellSafe,
  isValidFilePath,
  extractTargetFilesFromDescription,
  extractFileReferencesExpanded,
  buildFileIndex,
  resolveFileReferences,
  extractModifiedFiles,
  // Expose constants for testing
  FILE_INDEX_SKIP_DIRS,
  _getFileIndexCache: () => fileIndexCache,
  _clearFileIndexCache: () => fileIndexCache.clear(),
};
