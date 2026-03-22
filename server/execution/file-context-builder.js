'use strict';

/**
 * File Context Builder
 *
 * Extracted from task-manager.js — functions that build file context blocks,
 * detect JS/TS function boundaries, create stub target files, and parse
 * task output for edit detection.
 *
 * Uses init() dependency injection to receive server config and enrichment refs.
 */

const path = require('path');
const fs = require('fs');
const logger = require('../logger').child({ component: 'file-context-builder' });

let _serverConfig = null;
let _providerCfg = null;
let _contextEnrichment = null;
let _computeLineHash = null;
let _db = null;

function init(deps = {}) {
  if (deps.serverConfig) _serverConfig = deps.serverConfig;
  if (deps.providerCfg) _providerCfg = deps.providerCfg;
  if (deps.contextEnrichment) _contextEnrichment = deps.contextEnrichment;
  if (deps.computeLineHash) _computeLineHash = deps.computeLineHash;
  if (deps.db) _db = deps.db;
}

/**
 * Build formatted file context block from resolved files.
 * Reads files, adds line numbers with method markers, caps at maxBytes.
 * @param {Array<{mentioned: string, actual: string, confidence: string}>} resolvedFiles
 * @param {string} workingDirectory
 * @param {number} maxBytes - Total context budget (default 30KB)
 * @returns {string} Formatted context block or empty string
 */
/**
 * Try to build context from the symbol index instead of whole files.
 * Returns null if index is unavailable or empty (caller falls through to whole-file).
 */
function trySymbolLevelContext(resolvedFiles, workingDirectory, maxBytes, taskDescription) {
  try {
    const symbolIndexer = require('../utils/symbol-indexer');
    if (!_db) return null;
    const dbInst = typeof _db.getDbInstance === 'function' ? _db.getDbInstance() : _db;
    if (!dbInst) return null;

    symbolIndexer.init(dbInst);

    // Check if we have any indexed symbols for this project
    const testQuery = symbolIndexer.searchSymbols('', workingDirectory, { limit: 1 });
    if (!testQuery || testQuery.length === 0) return null;

    // Extract symbol names from the task description (camelCase, PascalCase, snake_case identifiers)
    const identifiers = (taskDescription || '').match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) || [];
    const uniqueIds = [...new Set(identifiers)];

    // Also get file outlines for all resolved files
    const symbolSections = [];
    let totalBytes = 0;

    // 1. Symbols mentioned in task description
    for (const id of uniqueIds) {
      if (totalBytes >= maxBytes) break;
      const matches = symbolIndexer.searchSymbols(id, workingDirectory, { mode: 'exact', limit: 3 });
      for (const sym of matches) {
        if (totalBytes >= maxBytes) break;
        const source = symbolIndexer.getSymbolSource(sym.id);
        if (!source || !source.source) continue;
        const shortPath = sym.file_path.split(/[/\\]/).slice(-3).join('/');
        const section = `\n### SYMBOL: ${sym.name} (${sym.kind}) — ${shortPath}:${sym.start_line}-${sym.end_line}\n\`\`\`\n${source.source}\n\`\`\``;
        if (totalBytes + section.length > maxBytes) break;
        symbolSections.push(section);
        totalBytes += section.length;
      }
    }

    // 2. File outlines for resolved files (compact — just signatures, no source)
    for (const { actual } of resolvedFiles) {
      if (totalBytes >= maxBytes) break;
      const fullPath = path.resolve(workingDirectory, actual);
      const outline = symbolIndexer.getFileOutline(fullPath, workingDirectory);
      if (outline.length === 0) continue;
      const outlineText = outline.map(s => `  ${s.kind} ${s.name} (L${s.start_line}-${s.end_line})`).join('\n');
      const section = `\n### OUTLINE: ${actual}\n${outlineText}`;
      if (totalBytes + section.length > maxBytes) break;
      symbolSections.push(section);
      totalBytes += section.length;
    }

    if (symbolSections.length === 0) return null;

    logger.info('[FileContext] Symbol-level context: ' + symbolSections.length + ' sections, ' + totalBytes + ' bytes (vs ' + maxBytes + ' budget)');
    return '## Referenced Symbols\n' + symbolSections.join('\n');
  } catch (e) {
    logger.info('[FileContext] Symbol index unavailable, falling back to whole-file: ' + e.message);
    return null;
  }
}

function buildFileContext(resolvedFiles, workingDirectory, maxBytes = 30000, taskDescription = '') {
  if (!resolvedFiles || resolvedFiles.length === 0) return '';

  // Try symbol-level context first (90%+ token savings when index exists)
  const symbolContext = trySymbolLevelContext(resolvedFiles, workingDirectory, maxBytes, taskDescription);
  if (symbolContext) return symbolContext;

  const MAX_FILE_BYTES = 15000;
  const MAX_FILE_LINES = 350;
  const methodPattern = /^\s*(public|private|protected|internal|static|async|override|virtual|abstract|def |function |class |interface |export |const |let |var )\b/;

  const hashlineEnabled = _serverConfig && _serverConfig.getBool('hashline_context_enabled');
  let totalBytes = 0;
  const sections = [];

  for (const { mentioned, actual } of resolvedFiles) {
    if (totalBytes >= maxBytes) break;

    const fullPath = path.resolve(workingDirectory, actual);
    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue; // Skip unreadable files
    }

    const lines = content.split('\n');
    const ext = path.extname(actual).replace('.', '');

    // Add line numbers with content hashes and method markers
    // Format: L###:xx:marker where xx is a 2-char FNV-1a hash of line content
    const numberedLines = lines.slice(0, MAX_FILE_LINES).map((line, idx) => {
      const lineNum = String(idx + 1).padStart(3, '0');
      const isMethod = methodPattern.test(line);
      const marker = isMethod ? '>>>' : '   ';
      if (hashlineEnabled && _computeLineHash) {
        const hash = _computeLineHash(line);
        return `L${lineNum}:${hash}:${marker} ${line}`;
      }
      return `L${lineNum}:${marker} ${line}`;
    });

    let numberedContent = numberedLines.join('\n');
    if (numberedContent.length > MAX_FILE_BYTES) {
      numberedContent = numberedContent.slice(0, MAX_FILE_BYTES) + '\n... [truncated]';
    }
    if (lines.length > MAX_FILE_LINES) {
      numberedContent += `\n... [${lines.length - MAX_FILE_LINES} more lines]`;
    }

    const section = `\n### FILE: ${actual} (referenced as: ${mentioned})\n\`\`\`${ext}\n${numberedContent}\n\`\`\``;

    if (totalBytes + section.length > maxBytes) {
      // Partial fit: only if nothing added yet
      if (sections.length === 0) {
        sections.push(section.slice(0, maxBytes));
      }
      break;
    }

    sections.push(section);
    totalBytes += section.length;
  }

  if (sections.length === 0) return '';

  // Context enrichment: import types, test files, git context, few-shot examples
  let enrichment = '';
  const enrichCfg = _providerCfg && _providerCfg.getEnrichmentConfig();
  if (enrichCfg && enrichCfg.enabled) {
    try {
      enrichment = _contextEnrichment.enrichResolvedContext(
        resolvedFiles, workingDirectory, taskDescription, _db, enrichCfg
      );
    } catch (e) {
      logger.info(`[BuildFileContext] Non-fatal enrichment error: ${e.message}`);
    }
  }

  if (hashlineEnabled) {
    return `\n\n---\nRESOLVED FILE CONTEXT (lines prefixed with L###:xx:)\n` +
      `Each line has format \`L###:xx:marker\` where \`xx\` is a 2-char content hash.\n` +
      `${sections.length} file(s) resolved from task description.\n` +
      `Cite line numbers AND hashes when describing edits (e.g., "L062:a3: contains the bug").` +
      sections.join('') + enrichment + '\n';
  }
  return `\n\n---\nRESOLVED FILE CONTEXT (lines prefixed with L###:)\n` +
    `${sections.length} file(s) resolved from task description.\n` +
    `Cite the EXACT line number where issues occur (e.g., "Line 62:" if you see "L062: problematic code").` +
    sections.join('') + enrichment + '\n';
}

/**
 * Extract function boundaries from a JavaScript/TypeScript file.
 * Returns an array of { name, startLine, endLine, lineCount } objects.
 * Used by auto-decomposition to split large-file tasks into function-level batches.
 * @param {string} filePath - Absolute or relative path to the JS/TS file
 * @returns {Array<{name: string, startLine: number, endLine: number, lineCount: number}>}
 */
function extractJsFunctionBoundaries(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const boundaries = [];

    const functionPatterns = [
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(/,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?[^)]*\)?\s*=>/,
      /^module\.exports\.(\w+)\s*=\s*(?:async\s+)?function\s*\(/,
      /^[ ]{0,2}(\w+)\s*\([^)]*\)\s*\{/
    ];

    const SKIP_NAMES = new Set(['if', 'else', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'delete', 'void', 'throw', 'class', 'import', 'export', 'require']);

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

      for (const pattern of functionPatterns) {
        const match = trimmed.match(pattern);
        if (match && match[1] && !SKIP_NAMES.has(match[1])) {
          boundaries.push({ name: match[1], startLine: i + 1 });
          break;
        }
      }
    }

    for (let i = 0; i < boundaries.length; i++) {
      boundaries[i].endLine = (i + 1 < boundaries.length) ? boundaries[i + 1].startLine - 1 : lines.length;
      boundaries[i].lineCount = boundaries[i].endLine - boundaries[i].startLine + 1;
    }

    return boundaries;
  } catch (err) {
    return [];
  }
}

/**
 * Ensure target files exist on disk (create stubs if needed).
 * Creates empty files so that edit-based providers can target them
 * without interactive approval prompts.
 * @param {string} workingDir - The working directory
 * @param {string[]} filePaths - Relative file paths to ensure exist
 * @returns {string[]} Array of absolute paths that were created or already existed
 */
function ensureTargetFilesExist(workingDir, filePaths) {
  const resolvedPaths = [];

  for (const relPath of filePaths) {
    const absPath = path.resolve(workingDir, relPath);

    // Safety: ensure the resolved path is inside the working directory
    const rel = path.relative(path.resolve(workingDir), absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      logger.warn(`[FileContext] Skipping target file outside working dir: ${relPath}`);
      continue;
    }

    try {
      if (!fs.existsSync(absPath)) {
        // Create parent directories
        const dir = path.dirname(absPath);
        fs.mkdirSync(dir, { recursive: true });

        // Create stub file with a comment indicating it's a placeholder
        const ext = path.extname(absPath).toLowerCase();
        let stub = '';
        if (ext === '.cs') {
          stub = '// Placeholder — to be generated by LLM\n';
        } else if (ext === '.js' || ext === '.ts' || ext === '.jsx' || ext === '.tsx') {
          stub = '// Placeholder — to be generated by LLM\n';
        } else if (ext === '.py') {
          stub = '# Placeholder — to be generated by LLM\n';
        } else {
          stub = '// Placeholder\n';
        }
        fs.writeFileSync(absPath, stub, 'utf8');
        logger.info(`[FileContext] Created stub file: ${relPath}`);
      }
      resolvedPaths.push(absPath);
    } catch (e) {
      logger.warn(`[FileContext] Failed to ensure file exists: ${relPath} — ${e.message}`);
    }
  }

  return resolvedPaths;
}

module.exports = {
  init,
  buildFileContext,
  extractJsFunctionBoundaries,
  ensureTargetFilesExist,
};
