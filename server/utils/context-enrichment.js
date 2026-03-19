/**
 * Context Enrichment Module
 *
 * Pre-task context improvements for LLM harness:
 * 1. Import/Type Dependency Traversal — walk imports 1-2 levels, extract signatures
 * 2. Test File Auto-Inclusion — pattern-match source → test file
 * 3. Recent Git Context Injection — git log + file-level diff
 * 4. Few-Shot Example Retrieval — find similar past successful tasks
 *
 * "Move intelligence from the model to the harness."
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('../logger').child({ component: 'context-enrichment' });
const serverConfig = require('../config');

// SECURITY (M4): Sensitive file patterns — skip during import walking.
// Mirrors SENSITIVE_FILE_PATTERNS from context-stuffing.js to prevent
// leaking secrets/credentials when resolving import dependencies.
const SENSITIVE_FILE_PATTERNS = [
  /^\.env$/i, /^\.env\./i, /\.env\.local$/i, /\.env\.production$/i,
  /\.key$/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /\.cert$/i,
  /\.credentials$/i, /\.secrets?$/i, /\.pgpass$/i, /\.netrc$/i,
  /^id_rsa$/i, /^id_ed25519$/i, /^id_ecdsa$/i, /^id_dsa$/i,
  /^authorized_keys$/i, /^known_hosts$/i,
  /^\.aws\/credentials$/i, /^\.gcloud\/credentials\.json$/i,
  /^\.docker\/config\.json$/i, /^\.kube\/config$/i,
  /^\.npmrc$/i, /^\.pypirc$/i, /^\.git-credentials$/i,
  /secret/i,
];

function _isSensitiveFile(filePath) {
  const basename = path.basename(filePath);
  return SENSITIVE_FILE_PATTERNS.some(pattern => pattern.test(basename));
}

// ─── Configuration ─────────────────────────────────────────────────────

const MAX_IMPORT_DEPTH = 2;
const MAX_IMPORT_FILES = 8;
const MAX_SIGNATURE_BYTES = 4000;
const MAX_TEST_FILE_BYTES = 3000;
const MAX_GIT_CONTEXT_BYTES = 2000;
const MAX_FEWSHOT_BYTES = 3000;

// ─── 1. Import/Type Dependency Traversal ────────────────────────────────

/**
 * Extract import paths from a source file.
 * Handles: import/from (TS/JS), require(), using (C#), from X import (Python)
 * @param {string} content - File content
 * @param {string} ext - File extension (e.g., '.ts', '.cs')
 * @returns {string[]} Array of import specifiers (relative paths or module names)
 */
function extractImportPaths(content, ext) {
  if (!content) return [];
  const imports = [];

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
    // ES imports: import { X } from './path'
    const esImports = content.matchAll(/(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/g);
    for (const m of esImports) {
      if (m[1].startsWith('.')) imports.push(m[1]);
    }
    // CJS requires: require('./path')
    const cjsImports = content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const m of cjsImports) {
      if (m[1].startsWith('.')) imports.push(m[1]);
    }
  } else if (['.cs'].includes(ext)) {
    // C# using: using Namespace.Class;
    // Not file paths — we look for project-relative type sources instead
    const usings = content.matchAll(/using\s+([\w.]+)\s*;/g);
    for (const m of usings) imports.push(m[1]);
  } else if (['.py'].includes(ext)) {
    // Python: from module import X, import module
    const pyImports = content.matchAll(/(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g);
    for (const m of pyImports) imports.push(m[1] || m[2]);
  }

  return imports;
}

/**
 * Resolve an import specifier to an actual file path.
 * @param {string} importPath - The import specifier (e.g., './utils/helper')
 * @param {string} sourceDir - Directory of the importing file
 * @param {string} workingDir - Project root
 * @returns {string|null} Resolved absolute path, or null
 */
function resolveImportToFile(importPath, sourceDir) {
  // For relative imports (JS/TS)
  if (importPath.startsWith('.')) {
    const base = path.resolve(sourceDir, importPath);
    // Try with extensions
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', ''];
    for (const ext of exts) {
      const candidate = base + ext;
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch (err) { logger.debug("enrichment step skipped", { err: err.message }); /* skip */ }
    }
    // Try index files
    for (const ext of ['.ts', '.js']) {
      const candidate = path.join(base, 'index' + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch (err) { logger.debug("enrichment step skipped", { err: err.message }); /* skip */ }
    }
  }
  return null;
}

/**
 * Extract exported type signatures from a file (interfaces, types, classes, enums).
 * Returns a compact summary — not full file content.
 * @param {string} filePath - Absolute path to the file
 * @returns {string} Signature summary text
 */
function extractTypeSignatures(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) { logger.debug("enrichment step skipped", { err: err.message }); return ''; }

  const ext = path.extname(filePath).toLowerCase();
  const lines = content.split('\n');
  const signatures = [];
  let inBlock = false;
  let blockLines = [];
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!inBlock) {
      // Match exported type declarations
      const isSignature = (
        /^export\s+(interface|type|enum|abstract\s+class|class)\s+\w+/.test(trimmed) ||
        (['.cs'].includes(ext) && /^(?:public|internal)\s+(?:interface|class|enum|record|struct)\s+\w+/.test(trimmed))
      );

      if (isSignature) {
        inBlock = true;
        blockLines = [line];
        braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
        if (braceDepth <= 0 && line.includes('{') && line.includes('}')) {
          // Single-line declaration
          signatures.push(blockLines.join('\n'));
          inBlock = false;
          blockLines = [];
          continue;
        }
        if (braceDepth <= 0 && !line.includes('{')) {
          // Type alias: export type X = ...;
          signatures.push(blockLines.join('\n'));
          inBlock = false;
          blockLines = [];
        }
        continue;
      }
    }

    if (inBlock) {
      blockLines.push(line);
      braceDepth += (line.match(/{/g) || []).length;
      braceDepth -= (line.match(/}/g) || []).length;

      if (braceDepth <= 0) {
        signatures.push(blockLines.join('\n'));
        inBlock = false;
        blockLines = [];
      }
      // Safety: don't extract overly large blocks
      if (blockLines.length > 40) {
        blockLines.push('  // ... [truncated]');
        blockLines.push('}');
        signatures.push(blockLines.join('\n'));
        inBlock = false;
        blockLines = [];
      }
    }
  }

  return signatures.join('\n\n');
}

/**
 * Walk import graph and collect type signatures from dependencies.
 * @param {string} filePath - Absolute path to the source file
 * @param {string} workingDir - Project root
 * @param {number} depth - Current recursion depth
 * @param {Set<string>} visited - Already-visited files
 * @returns {Array<{file: string, signatures: string}>}
 */
function walkImportsForTypes(filePath, workingDir, depth = 0, visited = new Set()) {
  if (depth > MAX_IMPORT_DEPTH || visited.size >= MAX_IMPORT_FILES) return [];
  if (visited.has(filePath)) return [];
  visited.add(filePath);

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) { logger.debug("enrichment step skipped", { err: err.message }); return []; }

  const ext = path.extname(filePath).toLowerCase();
  const importPaths = extractImportPaths(content, ext);
  const results = [];

  for (const importPath of importPaths) {
    if (visited.size >= MAX_IMPORT_FILES) break;

    const resolved = resolveImportToFile(importPath, path.dirname(filePath), workingDir);
    if (!resolved || visited.has(resolved)) continue;

    // SECURITY (M4): Skip sensitive files during import resolution
    if (_isSensitiveFile(resolved)) continue;

    const signatures = extractTypeSignatures(resolved);
    if (signatures) {
      const relPath = path.relative(workingDir, resolved);
      results.push({ file: relPath, signatures });
    }

    // Recurse deeper
    if (depth + 1 <= MAX_IMPORT_DEPTH) {
      const deeper = walkImportsForTypes(resolved, workingDir, depth + 1, visited);
      results.push(...deeper);
    }
  }

  return results;
}

/**
 * Build import dependency context for resolved files.
 * @param {Array<{actual: string}>} resolvedFiles - Files resolved from task description
 * @param {string} workingDir - Project root
 * @returns {string} Formatted dependency context block
 */
function buildImportContext(resolvedFiles, workingDir) {
  if (!resolvedFiles || resolvedFiles.length === 0) return '';

  const sourceFiles = new Set();
  const allDeps = [];

  // Mark source files so we don't include their own signatures in results
  for (const { actual } of resolvedFiles) {
    sourceFiles.add(path.resolve(workingDir, actual));
  }

  for (const { actual } of resolvedFiles) {
    const fullPath = path.resolve(workingDir, actual);
    // Walk imports starting from this file, but don't pre-mark it as visited
    // so walkImportsForTypes can read its content and follow its imports
    const deps = walkImportsForTypes(fullPath, workingDir, 0, new Set());
    for (const dep of deps) {
      const depFullPath = path.resolve(workingDir, dep.file);
      // Skip if this is one of the source files being edited
      if (sourceFiles.has(depFullPath)) continue;
      if (!allDeps.find(d => d.file === dep.file)) {
        allDeps.push(dep);
      }
    }
  }

  if (allDeps.length === 0) return '';

  let context = '\n\n### IMPORTED TYPE SIGNATURES\n';
  context += 'Types/interfaces from imported dependencies (for reference, do not modify these files):\n';
  let bytes = context.length;

  for (const dep of allDeps) {
    const section = `\n// ${dep.file}\n${dep.signatures}\n`;
    if (bytes + section.length > MAX_SIGNATURE_BYTES) break;
    context += section;
    bytes += section.length;
  }

  return context;
}

// ─── 2. Test File Auto-Inclusion ────────────────────────────────────────

/**
 * Find test files that correspond to source files.
 * @param {Array<{actual: string}>} resolvedFiles - Source files
 * @param {string} workingDir - Project root
 * @returns {Array<{source: string, testFile: string, content: string}>}
 */
function findRelatedTestFiles(resolvedFiles, workingDir) {
  if (!resolvedFiles || resolvedFiles.length === 0) return [];

  const results = [];

  for (const { actual } of resolvedFiles) {
    const ext = path.extname(actual);
    const base = path.basename(actual, ext);
    const dir = path.dirname(actual);

    // Common test file patterns
    const candidates = [
      // Same directory: foo.test.ts, foo.spec.ts
      path.join(dir, `${base}.test${ext}`),
      path.join(dir, `${base}.spec${ext}`),
      // __tests__ subdirectory
      path.join(dir, '__tests__', `${base}.test${ext}`),
      path.join(dir, '__tests__', `${base}${ext}`),
      // tests/ sibling directory
      path.join(dir, '..', 'tests', `${base}.test${ext}`),
      path.join(dir, '..', 'tests', `${base}${ext}`),
      // test/ sibling directory
      path.join(dir, '..', 'test', `${base}.test${ext}`),
      // JS/TS specific: .test.js for .ts files
      path.join(dir, `${base}.test.js`),
      path.join(dir, '..', 'tests', `${base}.test.js`),
    ];

    for (const candidate of candidates) {
      const fullPath = path.resolve(workingDir, candidate);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const content = fs.readFileSync(fullPath, 'utf8');
          // Extract just test names and key assertions for context
          const testSummary = extractTestSummary(content);
          if (testSummary) {
            results.push({
              source: actual,
              testFile: path.relative(workingDir, fullPath),
              content: testSummary
            });
          }
          break; // Found a test file for this source
        }
      } catch (err) { logger.debug("enrichment step skipped", { err: err.message }); /* skip */ }
    }
  }

  return results;
}

/**
 * Extract a compact test summary (test names + key expectations).
 * @param {string} content - Full test file content
 * @returns {string} Compact summary
 */
function extractTestSummary(content) {
  if (!content) return '';

  const lines = content.split('\n');
  const summary = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Include describe/it/test declarations
    if (/^(?:describe|it|test)\s*\(/.test(trimmed) ||
        /^(?:describe|it|test)\.(?:only|skip)\s*\(/.test(trimmed)) {
      summary.push(trimmed);
    }
    // Include key expect patterns (up to first 30)
    if (summary.length < 30 && /expect\s*\(/.test(trimmed)) {
      summary.push('  ' + trimmed);
    }
  }

  return summary.join('\n');
}

/**
 * Build test file context block.
 * @param {Array<{actual: string}>} resolvedFiles - Source files
 * @param {string} workingDir - Project root
 * @returns {string}
 */
function buildTestContext(resolvedFiles, workingDir) {
  const testFiles = findRelatedTestFiles(resolvedFiles, workingDir);
  if (testFiles.length === 0) return '';

  let context = '\n\n### RELATED TEST FILES\n';
  context += 'Existing tests for these files (shows expected behavior and edge cases):\n';
  let bytes = context.length;

  for (const { source, testFile, content } of testFiles) {
    const section = `\n// Tests for ${source} → ${testFile}\n${content}\n`;
    if (bytes + section.length > MAX_TEST_FILE_BYTES) break;
    context += section;
    bytes += section.length;
  }

  return context;
}

// ─── 3. Recent Git Context Injection ────────────────────────────────────

/**
 * Get recent git context for a working directory.
 * @param {string} workingDir - Project root
 * @param {Array<{actual: string}>} resolvedFiles - Files being worked on
 * @returns {string} Formatted git context block
 */
function buildGitContext(workingDir, resolvedFiles) {
  if (!workingDir) return '';

  try {
    // Check if it's a git repo
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: workingDir, encoding: 'utf8', timeout: 5000
    });
  } catch (err) {
    logger.debug("enrichment step skipped", { err: err.message });
    return ''; // Not a git repo
  }

  let context = '\n\n### RECENT GIT CONTEXT\n';
  let bytes = context.length;

  try {
    // Recent commits
    const log = execFileSync('git', ['log', '--oneline', '-5'], {
      cwd: workingDir, encoding: 'utf8', timeout: 5000
    }).trim();
    if (log) {
      const section = `Recent commits:\n${log}\n`;
      if (bytes + section.length < MAX_GIT_CONTEXT_BYTES) {
        context += section;
        bytes += section.length;
      }
    }
  } catch (err) { logger.debug("enrichment step skipped", { err: err.message }); /* skip */ }

  // Per-file recent changes (if files resolved)
  if (resolvedFiles && resolvedFiles.length > 0) {
    for (const { actual } of resolvedFiles.slice(0, 3)) {
      try {
        const fileDiff = execFileSync('git', ['log', '--oneline', '-3', '--', actual], {
          cwd: workingDir, encoding: 'utf8', timeout: 5000
        }).trim();
        if (fileDiff) {
          const section = `\nRecent changes to ${actual}:\n${fileDiff}\n`;
          if (bytes + section.length < MAX_GIT_CONTEXT_BYTES) {
            context += section;
            bytes += section.length;
          }
        }
      } catch (err) { logger.debug("enrichment step skipped", { err: err.message }); /* skip */ }
    }
  }

  return context.length > 30 ? context : '';
}

// ─── 4. Few-Shot Example Retrieval ──────────────────────────────────────

/**
 * Find a similar past successful task and return its diff as a few-shot example.
 * Uses the existing task database to find completed tasks with similar descriptions.
 * @param {string} taskDescription - Current task description
 * @param {object} db - Database instance (must have query methods)
 * @returns {string} Formatted few-shot context block, or empty string
 */
function buildFewShotContext(taskDescription, db) {
  if (!taskDescription || !db) return '';

  try {
    // Find recent successful tasks with similar descriptions using simple keyword matching
    // (TF-IDF is in project-config.js but requires more setup — use keyword overlap for now)
    const words = taskDescription.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3);

    if (words.length === 0) return '';

    // Get recent completed tasks
    const stmt = db.getDbInstance().prepare(`
      SELECT id, task_description, output, completed_at
      FROM tasks
      WHERE status = 'completed'
        AND output IS NOT NULL
        AND length(output) > 50
        AND length(output) < 5000
      ORDER BY completed_at DESC
      LIMIT 50
    `);
    const candidates = stmt.all();

    if (candidates.length === 0) return '';

    // Score by keyword overlap
    let bestScore = 0;
    let bestTask = null;

    for (const task of candidates) {
      const desc = (task.task_description || '').toLowerCase();
      let score = 0;
      for (const word of words) {
        if (desc.includes(word)) score++;
      }
      // Normalize by total words
      const normalized = score / words.length;
      if (normalized > bestScore && normalized >= 0.3) {
        bestScore = normalized;
        bestTask = task;
      }
    }

    if (!bestTask) return '';

    // Truncate output for context
    let output = bestTask.output;
    if (output.length > MAX_FEWSHOT_BYTES) {
      output = output.slice(0, MAX_FEWSHOT_BYTES) + '\n... [truncated]';
    }

    return `\n\n### SIMILAR PAST TASK (few-shot example)\n` +
      `A similar task was completed successfully:\n` +
      `Task: ${bestTask.task_description.slice(0, 200)}\n` +
      `Output:\n${output}\n`;
  } catch (e) {
    logger.info(`[FewShot] Error finding similar task: ${e.message}`);
    return '';
  }
}

// ─── 5. Error-Feedback Context Builder ──────────────────────────────────

/**
 * Build an error-feedback prompt for retry attempts.
 * Instead of creating a new cold-start task, feeds compiler errors
 * back into the original context for a focused fix.
 * @param {string} originalDescription - Original task description
 * @param {string} originalOutput - Original task output
 * @param {string} errors - Compiler/validation errors
 * @returns {string} Enhanced retry prompt
 */
function buildErrorFeedbackPrompt(originalDescription, originalOutput, errors) {
  if (!errors) return originalDescription;

  return `${originalDescription}

---
PREVIOUS ATTEMPT PRODUCED ERRORS — FIX THEM:

The previous edit attempt produced the following errors. Fix ONLY these errors.
Do NOT rewrite the entire file — make minimal targeted fixes.

Errors:
${errors}

Previous output (for context of what was already done):
${(originalOutput || '').slice(0, 2000)}`;
}

// ─── 6. Hashline Error-Feedback Context Builder ─────────────────────────

/**
 * Build a hashline-annotated error-feedback prompt for in-context retry.
 * Reads the current (post-edit) content of each modified file, re-annotates
 * with fresh lineNum|hash anchors, and combines with the error list.
 * Used by the error-feedback loop in hashline-ollama to fix syntax errors
 * without cold-starting a new task.
 *
 * @param {string} workingDir - Project root directory
 * @param {string[]} modifiedFiles - Relative paths of files to re-annotate
 * @param {string[]} errors - Array of error strings from checkSyntax
 * @param {string} editFormat - 'hashline' or 'hashline-lite'
 * @param {Object} [options] - Optional settings
 * @param {string} [options.typeContext] - Pre-built import type signatures (from buildImportContext)
 * @returns {string} Focused error-fix prompt with re-annotated file content
 */
function buildHashlineErrorFeedbackPrompt(workingDir, modifiedFiles, errors, editFormat, options = {}) {
  if (!errors || errors.length === 0) return '';
  if (!modifiedFiles || modifiedFiles.length === 0) return '';

  const { computeLineHash } = require('./hashline-parser');
  const fileSections = [];

  for (const relPath of modifiedFiles) {
    const fullPath = path.resolve(workingDir, relPath);
    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch (err) {
      logger.debug("enrichment step skipped", { err: err.message });
      continue;
    }

    const fileLines = content.split('\n');
    const annotatedLines = fileLines.map((line, idx) => {
      const lineNum = String(idx + 1).padStart(3, '0');
      const hash = computeLineHash(line);
      return `L${lineNum}:${hash}: ${line}`;
    });

    const ext = path.extname(relPath).replace('.', '');
    fileSections.push(`### FILE: ${relPath}\n\`\`\`${ext}\n${annotatedLines.join('\n')}\n\`\`\``);
  }

  if (fileSections.length === 0) return '';

  const formatInstruction = editFormat === 'hashline-lite'
    ? 'Use <<<<<<< SEARCH / ======= / >>>>>>> REPLACE format to fix the errors.'
    : 'Use HASHLINE_EDIT format with REPLACE/INSERT_BEFORE/DELETE operations to fix the errors.';

  // Add hints for common error patterns
  const hints = [];
  const ts2339Errors = errors.filter(e => e.includes('TS2339') && e.includes('does not exist on type'));
  if (ts2339Errors.length > 0) {
    // Extract missing property names from TS2339 errors
    const missingProps = new Set();
    for (const e of ts2339Errors) {
      const m = e.match(/Property '(\w+)' does not exist on type/);
      if (m) missingProps.add(m[1]);
    }
    const propList = [...missingProps].map(p => `\`${p}\``).join(', ');
    hints.push(`FIX: The properties ${propList} are used but NOT declared in the class. Add a property declaration for each one (e.g., \`private ${[...missingProps][0]}: <type>;\`) in a SEARCH/REPLACE block targeting the existing \`private\` property declarations at the top of the class.`);
  }
  const hasTS2532 = errors.some(e => e.includes('TS2532') || e.includes('TS18048'));
  if (hasTS2532) {
    hints.push('FIX: "Object is possibly undefined" — use `|| 0` for numbers, `?? defaultValue` for other types, or add an `if` check before using the value.');
  }
  const hasTS2393 = errors.some(e => e.includes('TS2393'));
  if (hasTS2393) {
    hints.push('FIX: "Duplicate function implementation" means a method was defined twice. SEARCH for the duplicate and DELETE it (empty REPLACE block).');
  }
  const hintSection = hints.length > 0 ? '\n\n' + hints.join('\n') : '';

  // Include type context if provided (helps LLM reference correct types during fix)
  const typeSection = options.typeContext ? `\n\n${options.typeContext}` : '';

  return `FIX THE FOLLOWING ERRORS — make minimal targeted fixes only.

ERRORS:
${errors.map(e => `- ${e}`).join('\n')}${hintSection}
${typeSection}
CURRENT FILE CONTENT (lines prefixed with L###:xx:):
${fileSections.join('\n\n')}

${formatInstruction}
Do NOT rewrite the entire file. Fix ONLY the lines causing the errors above.
Stop output after your last >>>>>>> REPLACE.`;
}

// ─── Orchestrator ───────────────────────────────────────────────────────

/**
 * Enrich resolved file context with import types, test files, git context, and few-shot examples.
 * Called from buildFileContext pipeline.
 * @param {Array<{mentioned: string, actual: string}>} resolvedFiles
 * @param {string} workingDir
 * @param {string} taskDescription
 * @param {object} db - Database instance (optional, for few-shot)
 * @param {object} options - { enableImports, enableTests, enableGit, enableFewShot }
 * @returns {string} Combined enrichment context
 */
function enrichResolvedContext(resolvedFiles, workingDir, taskDescription, db, options = {}) {
  const {
    enableImports = true,
    enableTests = true,
    enableGit = true,
    enableFewShot = true,
  } = options;

  let enrichment = '';

  try {
    if (enableImports) {
      enrichment += buildImportContext(resolvedFiles, workingDir);
    }
  } catch (e) {
    logger.info(`[Enrichment] Import traversal error: ${e.message}`);
  }

  try {
    if (enableTests) {
      enrichment += buildTestContext(resolvedFiles, workingDir);
    }
  } catch (e) {
    logger.info(`[Enrichment] Test file error: ${e.message}`);
  }

  try {
    if (enableGit) {
      enrichment += buildGitContext(workingDir, resolvedFiles);
    }
  } catch (e) {
    logger.info(`[Enrichment] Git context error: ${e.message}`);
  }

  try {
    if (enableFewShot && db) {
      enrichment += buildFewShotContext(taskDescription, db);
    }
  } catch (e) {
    logger.info(`[Enrichment] Few-shot error: ${e.message}`);
  }

  if (enrichment) {
    logger.info(`[Enrichment] Added ${enrichment.length} bytes of enriched context (imports: ${enableImports}, tests: ${enableTests}, git: ${enableGit}, fewshot: ${enableFewShot})`);
  }

  return enrichment;
}

// ─── Async Orchestrator (tsserver-augmented) ────────────────────────────

const MAX_TSSERVER_TYPE_BYTES = 3000;

/**
 * Async wrapper around enrichResolvedContext that adds tsserver type information.
 * Calls the sync enrichResolvedContext first, then queries tsserver for
 * quick info on imported symbols. Does NOT modify the sync function.
 *
 * @param {Array<{mentioned: string, actual: string}>} resolvedFiles
 * @param {string} workingDir
 * @param {string} taskDescription
 * @param {object} db
 * @param {object} options
 * @returns {Promise<string>} Combined enrichment context
 */
async function enrichResolvedContextAsync(resolvedFiles, workingDir, taskDescription, db, options = {}) {
  // Start with the sync enrichment (imports, tests, git, fewshot)
  let enrichment = enrichResolvedContext(resolvedFiles, workingDir, taskDescription, db, options);

  // Add tsserver type context if enabled
  if (db && serverConfig.isOptIn('tsserver_enabled')) {
    try {
      const tsContext = await buildTsserverTypeContext(resolvedFiles, workingDir);
      if (tsContext) {
        enrichment += tsContext;
        logger.info(`[Enrichment] Added ${tsContext.length} bytes of tsserver type context`);
      }
    } catch (e) {
      logger.info(`[Enrichment] Non-fatal tsserver error: ${e.message}`);
    }
  }

  return enrichment;
}

/**
 * Query tsserver for type information on imported symbols in resolved files.
 * Opens each file, finds import lines, gets quick info for imported names.
 *
 * @param {Array<{actual: string}>} resolvedFiles
 * @param {string} workingDir
 * @returns {Promise<string>} Formatted type context block
 */
async function buildTsserverTypeContext(resolvedFiles, workingDir) {
  let tsserverClient;
  try {
    tsserverClient = require('./tsserver-client');
  } catch (err) {
    logger.debug("enrichment step skipped", { err: err.message });
    return '';
  }

  if (!resolvedFiles || resolvedFiles.length === 0) return '';

  const tsExtensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
  const typeEntries = [];
  let bytes = 0;

  for (const { actual } of resolvedFiles) {
    const ext = path.extname(actual).toLowerCase();
    if (!tsExtensions.has(ext)) continue;

    const fullPath = path.resolve(workingDir, actual);
    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch (err) { logger.debug("enrichment step skipped", { err: err.message }); continue; }

    // Find import lines and query quick info for imported names
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && i < 50; i++) {
      const line = lines[i];
      // Match: import { Foo, Bar } from '...'
      const importMatch = line.match(/import\s+\{([^}]+)\}\s+from/);
      if (!importMatch) continue;

      const names = importMatch[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);

      for (const name of names) {
        if (bytes >= MAX_TSSERVER_TYPE_BYTES) break;

        // Find the column offset of this name in the line
        const nameIdx = line.indexOf(name, line.indexOf('{'));
        if (nameIdx === -1) continue;

        const info = await tsserverClient.getQuickInfo(workingDir, fullPath, i + 1, nameIdx + 1);
        if (info && info.displayString) {
          const entry = `  ${name}: ${info.displayString}`;
          if (bytes + entry.length > MAX_TSSERVER_TYPE_BYTES) break;
          typeEntries.push(entry);
          bytes += entry.length;
        }
      }
    }
  }

  if (typeEntries.length === 0) return '';

  return '\n\n### TSSERVER TYPE SIGNATURES\n' +
    'Precise type info from TypeScript compiler (for reference):\n' +
    typeEntries.join('\n') + '\n';
}

module.exports = {
  // Core functions
  extractImportPaths,
  resolveImportToFile,
  extractTypeSignatures,
  walkImportsForTypes,
  buildImportContext,
  findRelatedTestFiles,
  extractTestSummary,
  buildTestContext,
  buildGitContext,
  buildFewShotContext,
  buildErrorFeedbackPrompt,
  buildHashlineErrorFeedbackPrompt,
  // Orchestrator
  enrichResolvedContext,
  enrichResolvedContextAsync,
  buildTsserverTypeContext,
  // Constants (for testing)
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_FILES,
};
