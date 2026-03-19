/**
 * Hashline Parser & Applicator Module
 *
 * Extracted from task-manager.js — hashline edit parsing, hash computation,
 * fuzzy matching, and edit application logic.
 *
 * Pure parsing/file operations — no DB dependency needed.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger').child({ component: 'hashline-parser' });
const { stripMarkdownFences, stripArtifactMarkers } = require('./sanitize');
const { SYNTAX_CHECK_EXTENSIONS } = require('../constants');

/**
 * Compute a 2-char FNV-1a hash of a line for hashline context markers.
 * Gives providers a verifiable identifier per line to cite in edits.
 * @param {string} line - Source line content
 * @returns {string} 2-char hex hash (00-ff)
 */
function computeLineHash(line) {
  const FNV_PRIME = 0x01000193;
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < line.length; i++) {
    hash ^= line.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return ((hash & 0xFF) >>> 0).toString(16).padStart(2, '0');
}

/**
 * Compute Levenshtein-based line similarity (0-1).
 * Used for fuzzy matching in SEARCH/REPLACE and hashline-lite parsing.
 * @param {string} a
 * @param {string} b
 * @returns {number} Similarity score (0 = different, 1 = identical)
 */
function lineSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  // Optimized Levenshtein for short strings; bail early for very different lengths
  if (Math.abs(a.length - b.length) / maxLen > 0.5) return 0.3;

  const matrix = [];
  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return 1 - matrix[a.length][b.length] / maxLen;
}

/**
 * Sliding-window search: find where SEARCH lines match in the original file.
 * Uses lineSimilarity for fuzzy matching (threshold: 80%).
 */
function findSearchMatch(searchLines, originalLines) {
  const searchLen = searchLines.length;
  if (searchLen === 0 || originalLines.length === 0) return null;

  let bestScore = 0;
  let bestStart = -1;

  for (let start = 0; start <= originalLines.length - searchLen; start++) {
    let totalSim = 0;
    let minSim = 1;
    for (let j = 0; j < searchLen; j++) {
      const sim = lineSimilarity(searchLines[j], originalLines[start + j]);
      totalSim += sim;
      if (sim < minSim) minSim = sim;
    }
    const avgSim = totalSim / searchLen;

    // Require minimum 80% average similarity AND no line below 50%
    if (avgSim >= 0.8 && minSim >= 0.5 && avgSim > bestScore) {
      bestScore = avgSim;
      bestStart = start;
    }
  }

  if (bestStart === -1) return null;

  return {
    startLine: bestStart + 1,  // 1-indexed
    endLine: bestStart + searchLen,
    score: Math.round(bestScore * 100) / 100
  };
}

/**
 * Parse hashline-lite SEARCH/REPLACE blocks from LLM output.
 * @param {string} output - Raw LLM output
 * @param {Map<string, string[]>} fileContextMap - Map of filePath -> array of original file lines
 * @returns {{ edits: Array, parseErrors: string[] }}
 */
function parseHashlineLiteEdits(output, fileContextMap) {
  const edits = [];
  const parseErrors = [];

  if (!output || typeof output !== 'string') {
    return { edits, parseErrors };
  }

  // Strip markdown code fences
  const cleaned = stripMarkdownFences(output);
  const lines = cleaned.split('\n');

  let currentFile = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Detect file header: ### FILE: <path>
    const fileHeaderMatch = line.match(/^###\s*FILE:\s*(.+)$/);
    if (fileHeaderMatch) {
      currentFile = fileHeaderMatch[1].trim();
      i++;
      continue;
    }

    // Detect SEARCH block start
    if (line === '<<<<<<< SEARCH') {
      i++;
      const searchLines = [];
      const replaceLines = [];
      let inReplace = false;
      let foundEnd = false;

      while (i < lines.length) {
        const blockLine = lines[i];
        const trimmed = blockLine.trim();

        if (trimmed === '=======') {
          inReplace = true;
          i++;
          continue;
        }

        if (trimmed === '>>>>>>> REPLACE') {
          foundEnd = true;
          i++;
          break;
        }

        // Strip any leaked L###:xx: prefixes from content
        const strippedLine = blockLine.replace(/^L\d{1,4}:[a-zA-Z0-9]{2}:\s?/, '');

        if (inReplace) {
          replaceLines.push(strippedLine);
        } else {
          searchLines.push(strippedLine);
        }
        i++;
      }

      if (!foundEnd) {
        parseErrors.push(`Missing >>>>>>> REPLACE terminator${currentFile ? ` for ${currentFile}` : ''}`);
      }

      if (searchLines.length === 0) {
        parseErrors.push(`Empty SEARCH block${currentFile ? ` for ${currentFile}` : ''}`);
        continue;
      }

      // Determine file path — use explicit header or try to match against available files
      let filePath = currentFile;
      if (!filePath && fileContextMap.size === 1) {
        filePath = fileContextMap.keys().next().value;
      }
      if (!filePath) {
        parseErrors.push('SEARCH/REPLACE block without file path');
        continue;
      }

      // Match SEARCH content against original file lines using sliding window
      const originalLines = fileContextMap.get(filePath);
      if (!originalLines) {
        parseErrors.push(`File not in context: ${filePath}`);
        continue;
      }

      const match = findSearchMatch(searchLines, originalLines);
      if (!match) {
        parseErrors.push(`SEARCH block not found in ${filePath}: "${searchLines[0]}..."`);
        continue;
      }

      edits.push({
        type: 'replace',
        filePath,
        startLine: match.startLine,
        startHash: computeLineHash(originalLines[match.startLine - 1]),
        endLine: match.endLine,
        endHash: computeLineHash(originalLines[match.endLine - 1]),
        newContent: replaceLines.join('\n'),
        matchScore: match.score
      });
      continue;
    }

    i++;
  }

  return { edits, parseErrors };
}

/**
 * Apply hashline-lite edits by converting them to standard hashline format
 * and delegating to applyHashlineEdits.
 */
function applyHashlineLiteEdits(workingDir, edits) {
  if (!edits || edits.length === 0) {
    return { success: true, results: [] };
  }

  // Group by file
  const editsByFile = new Map();
  const resolvedRoot = path.resolve(workingDir);
  for (const edit of edits) {
    const absPath = path.isAbsolute(edit.filePath)
      ? edit.filePath
      : path.resolve(workingDir, edit.filePath);
    // Containment check: reject edits targeting files outside the working directory
    const rel = path.relative(resolvedRoot, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      logger.info(`[HashlineParser] Skipping edit outside working dir: ${edit.filePath}`);
      continue;
    }
    if (!editsByFile.has(absPath)) {
      editsByFile.set(absPath, { relPath: edit.filePath, edits: [] });
    }
    editsByFile.get(absPath).edits.push(edit);
  }

  const results = [];
  let totalRemoved = 0;
  let totalAdded = 0;

  for (const [absPath, { relPath, edits: fileEdits }] of editsByFile) {
    const result = applyHashlineEdits(absPath, fileEdits);
    results.push({ file: relPath, ...result });
    if (result.success) {
      totalRemoved += result.linesRemoved;
      totalAdded += result.linesAdded;
    }
  }

  const allSuccess = results.every(r => r.success);
  return { success: allSuccess, results, totalRemoved, totalAdded };
}

/**
 * Parse LLM output for structured hashline edit blocks.
 * Fault-tolerant: ignores explanatory text around blocks.
 * @param {string} output - Raw LLM output text
 * @returns {{ edits: Array<{type: string, filePath: string, startLine: number, startHash: string, endLine?: number, endHash?: string, newContent: string}>, parseErrors: string[] }}
 */
function parseHashlineEdits(output) {
  const edits = [];
  const parseErrors = [];

  if (!output || typeof output !== 'string') {
    return { edits, parseErrors };
  }

  // Extract code-fenced content BEFORE stripping (for full-rewrite fallback)
  const codeFenceMatch = output.match(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/);

  // Strip markdown code fences that may wrap the entire output
  const cleaned = stripMarkdownFences(output);

  // Split into lines for processing
  const lines = cleaned.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for HASHLINE_EDIT <file_path>
    const editHeaderMatch = line.match(/^HASHLINE_EDIT\s+(.+)$/);
    if (!editHeaderMatch) {
      i++;
      continue;
    }

    const filePath = editHeaderMatch[1].trim();
    i++;

    // Inner loop: parse all operations under this HASHLINE_EDIT header
    // Supports multiple operations per file block (e.g., multiple INSERT_BEFORE)
    while (i < lines.length) {
      const opLine = lines[i].trim();

      // Stop if we hit another HASHLINE_EDIT header (will be picked up by outer loop)
      if (opLine.match(/^HASHLINE_EDIT\s+/)) break;

      // Skip blank lines and explanatory text between operations
      if (!opLine) {
        i++;
        continue;
      }
      const isKnownOp = opLine.match(/^(REPLACE|DELETE|INSERT_BEFORE)\s+/i);
      const looksLikeOp = opLine.match(/^\w+\s+L\d+:/);
      if (!isKnownOp && !looksLikeOp) {
        i++;
        continue;
      }
      if (!isKnownOp && looksLikeOp) {
        parseErrors.push(`Unknown operation in HASHLINE_EDIT for ${filePath}: ${opLine}`);
        i++;
        continue;
      }

      // REPLACE L088:83 TO L093:d5
      const replaceMatch = opLine.match(/^REPLACE\s+L(\d+):([a-f0-9]{2}):?\s+TO\s+L(\d+):([a-f0-9]{2}):?$/i);
      if (replaceMatch) {
        i++;
        const contentLines = [];
        let foundEnd = false;
        while (i < lines.length) {
          if (lines[i].trim() === 'END_REPLACE') {
            foundEnd = true;
            i++;
            break;
          }
          contentLines.push(lines[i]);
          i++;
        }
        if (!foundEnd) {
          parseErrors.push(`Missing END_REPLACE for ${filePath} L${replaceMatch[1]}`);
        }
        edits.push({
          type: 'replace',
          filePath,
          startLine: parseInt(replaceMatch[1], 10),
          startHash: replaceMatch[2],
          endLine: parseInt(replaceMatch[3], 10),
          endHash: replaceMatch[4],
          newContent: contentLines.join('\n')
        });
        continue;
      }

      // DELETE L005:8f TO L007:a5
      const deleteMatch = opLine.match(/^DELETE\s+L(\d+):([a-f0-9]{2}):?\s+TO\s+L(\d+):([a-f0-9]{2}):?$/i);
      if (deleteMatch) {
        i++;
        let foundEnd = false;
        while (i < lines.length) {
          if (lines[i].trim() === 'END_DELETE') {
            foundEnd = true;
            i++;
            break;
          }
          i++;
        }
        if (!foundEnd) {
          parseErrors.push(`Missing END_DELETE for ${filePath} L${deleteMatch[1]}`);
        }
        edits.push({
          type: 'delete',
          filePath,
          startLine: parseInt(deleteMatch[1], 10),
          startHash: deleteMatch[2],
          endLine: parseInt(deleteMatch[3], 10),
          endHash: deleteMatch[4],
          newContent: ''
        });
        continue;
      }

      // INSERT_BEFORE L088:83
      const insertMatch = opLine.match(/^INSERT_BEFORE\s+L(\d+):([a-f0-9]{2}):?$/i);
      if (insertMatch) {
        i++;
        const contentLines = [];
        let foundEnd = false;
        while (i < lines.length) {
          if (lines[i].trim() === 'END_INSERT') {
            foundEnd = true;
            i++;
            break;
          }
          contentLines.push(lines[i]);
          i++;
        }
        if (!foundEnd) {
          parseErrors.push(`Missing END_INSERT for ${filePath} L${insertMatch[1]}`);
        }
        edits.push({
          type: 'insert_before',
          filePath,
          startLine: parseInt(insertMatch[1], 10),
          startHash: insertMatch[2],
          endLine: undefined,
          endHash: undefined,
          newContent: contentLines.join('\n')
        });
        continue;
      }

      // Unrecognized operation line — skip it
      parseErrors.push(`Unknown operation in HASHLINE_EDIT for ${filePath}: ${opLine}`);
      i++;
    }
  }

  // === FALLBACK 1: JSON-formatted edit blocks (deepseek-coder-v2 style) ===
  if (edits.length === 0) {
    try {
      // Broad regex: matches the first [ or { to the last ] or } in the string.
      // This is intentionally permissive to handle LLM responses that embed JSON
      // inside prose. It can produce false positives on non-JSON content, but
      // the JSON.parse guard below rejects invalid matches.
      const jsonMatch = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        const files = Array.isArray(parsed) ? parsed : [parsed];
        for (const file of files) {
          const fp = file.file_path || file.filePath;
          if (!fp || !file.blocks) continue;
          for (const block of file.blocks) {
            const type = (block.type || '').toLowerCase();
            const startMatch = (block.start || '').match(/^L(\d+):([a-f0-9]{2})/i);
            const endMatch = (block.end || '').match(/^L(\d+):([a-f0-9]{2})/i);
            if (!startMatch) continue;
            const content = Array.isArray(block.content) ? block.content.join('\n') : (block.content || '');
            if (type === 'replace' && endMatch) {
              edits.push({
                type: 'replace', filePath: fp,
                startLine: parseInt(startMatch[1], 10), startHash: startMatch[2],
                endLine: parseInt(endMatch[1], 10), endHash: endMatch[2],
                newContent: content
              });
            } else if (type === 'delete' && endMatch) {
              edits.push({
                type: 'delete', filePath: fp,
                startLine: parseInt(startMatch[1], 10), startHash: startMatch[2],
                endLine: parseInt(endMatch[1], 10), endHash: endMatch[2],
                newContent: ''
              });
            } else if (type === 'insert_before' || type === 'insert') {
              edits.push({
                type: 'insert_before', filePath: fp,
                startLine: parseInt(startMatch[1], 10), startHash: startMatch[2],
                endLine: undefined, endHash: undefined,
                newContent: content
              });
            }
          }
        }
        if (edits.length > 0) {
          parseErrors.push(`[JSON fallback] Parsed ${edits.length} edits from JSON format`);
        }
      }
    } catch {
      // JSON parse failed — not JSON format
    }
  }

  // === FALLBACK 2: Full file rewrite in code fence (deepseek-r1 style) ===
  let fullFileContent = null;
  if (edits.length === 0 && codeFenceMatch) {
    const fencedContent = codeFenceMatch[1].trimEnd();
    // Must look like a real file: has exports/imports and is at least 10 lines
    const lineCount = fencedContent.split('\n').length;
    if (lineCount >= 10 && /^(export |import |\/)/m.test(fencedContent)) {
      fullFileContent = fencedContent;
    }
  }

  return { edits, parseErrors, fullFileContent };
}

/**
 * Apply hashline edits to a file. Validates hashes against current content.
 * @param {string} filePath - Absolute path to the file
 * @param {Array} edits - Parsed edits from parseHashlineEdits
 * @returns {{ success: boolean, error?: string, linesRemoved: number, linesAdded: number }}
 */
function applyHashlineEdits(filePath, edits) {
  if (!edits || edits.length === 0) {
    return { success: true, linesRemoved: 0, linesAdded: 0 };
  }

  // Read current file
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { success: false, error: `Cannot read file: ${e.message}`, linesRemoved: 0, linesAdded: 0 };
  }

  const fileLines = content.split('\n');
  const lineHashes = fileLines.map(line => computeLineHash(line));

  // Validate all hashes before applying any edits.
  // Fuzzy fallback: when hash mismatches, search ±2 lines for the expected hash.
  // Models often get line numbers right but hallucinate the 2-char hash.
  const HASH_SEARCH_WINDOW = 2;
  let fuzzyFixups = 0;

  function findLineByHash(expectedHash, nominalLine) {
    // Exact match first
    if (nominalLine >= 1 && nominalLine <= fileLines.length && lineHashes[nominalLine - 1] === expectedHash) {
      return nominalLine;
    }
    // Search ±window
    for (let offset = 1; offset <= HASH_SEARCH_WINDOW; offset++) {
      for (const delta of [-offset, offset]) {
        const candidate = nominalLine + delta;
        if (candidate >= 1 && candidate <= fileLines.length && lineHashes[candidate - 1] === expectedHash) {
          return candidate;
        }
      }
    }
    return null;
  }

  function resolveLineReference(edit, lineField, hashField) {
    const nominalLine = edit[lineField];
    const expectedHash = edit[hashField];
    const actualHash = lineHashes[nominalLine - 1];
    const lineLabel = lineField === 'startLine' ? 'start' : 'end';

    if (actualHash === expectedHash) {
      return { ok: true };
    }

    const corrected = findLineByHash(expectedHash, nominalLine);
    if (corrected !== null) {
      logger.warn(`[HashlineEdit] Fuzzy hash match: ${lineLabel} L${nominalLine}:${expectedHash} -> L${corrected} in ${path.basename(filePath)}`);
      edit[lineField] = corrected;
      fuzzyFixups++;
      return { ok: true };
    }

    if (nominalLine >= 1 && nominalLine <= fileLines.length) {
      logger.warn(`[HashlineEdit] Fuzzy line-number fallback: using ${lineLabel} L${nominalLine} in ${path.basename(filePath)} despite hash mismatch (expected ${expectedHash}, got ${actualHash})`);
      fuzzyFixups++;
      return { ok: true };
    }

    return {
      ok: false,
      error: `Stale hash at line ${nominalLine}: expected ${expectedHash}, got ${actualHash}`
    };
  }

  for (const edit of edits) {
    // Check start line range
    if (edit.startLine < 1 || edit.startLine > fileLines.length) {
      return {
        success: false,
        error: `Line ${edit.startLine} out of range (1-${fileLines.length})`,
        linesRemoved: 0, linesAdded: 0
      };
    }

    // Validate start hash. Preserve nearby-hash correction, then fall back to
    // the cited line number when the hash drifts but the line reference is valid.
    const startResolution = resolveLineReference(edit, 'startLine', 'startHash');
    if (!startResolution.ok) {
      return {
        success: false,
        error: startResolution.error,
        linesRemoved: 0, linesAdded: 0
      };
    }

    // For replace/delete: validate end line
    if (edit.type === 'replace' || edit.type === 'delete') {
      if (edit.endLine < edit.startLine || edit.endLine > fileLines.length) {
        return {
          success: false,
          error: `End line ${edit.endLine} out of range (${edit.startLine}-${fileLines.length})`,
          linesRemoved: 0, linesAdded: 0
        };
      }
      const endResolution = resolveLineReference(edit, 'endLine', 'endHash');
      if (!endResolution.ok) {
        return {
          success: false,
          error: endResolution.error,
          linesRemoved: 0, linesAdded: 0
        };
      }
    }
  }

  // Normalize edits for overlap checking: compute effective ranges
  const normalizedEdits = edits.map(edit => {
    if (edit.type === 'insert_before') {
      // Insert doesn't remove any lines — range is empty at startLine
      return { ...edit, effectiveStart: edit.startLine, effectiveEnd: edit.startLine - 1 };
    }
    return { ...edit, effectiveStart: edit.startLine, effectiveEnd: edit.endLine };
  });

  // Sort bottom-to-top to preserve line numbers during edits
  normalizedEdits.sort((a, b) => b.startLine - a.startLine);

  // Check for overlapping edits and auto-merge abutting ones (after sorting)
  for (let i = 0; i < normalizedEdits.length - 1; i++) {
    const current = normalizedEdits[i];
    const next = normalizedEdits[i + 1]; // higher in file (lower line number)
    // Overlap: next's effective range reaches into current's range
    if (next.effectiveEnd >= current.effectiveStart && next.type !== 'insert_before') {
      // Auto-merge abutting edits (next.effectiveEnd == current.effectiveStart)
      // This happens when models split edits at a boundary line
      if (next.effectiveEnd === current.effectiveStart && next.type === 'replace' && current.type === 'replace') {
        // Merge: extend next to cover current's range, combine content
        next.endLine = current.endLine;
        next.endHash = current.endHash;
        next.effectiveEnd = current.effectiveEnd;
        next.newContent = next.newContent + '\n' + current.newContent;
        normalizedEdits.splice(i, 1); // Remove current (it's merged into next)
        i--; // Re-check in case of chain merges
        continue;
      }
      return {
        success: false,
        error: `Overlapping edits at lines ${next.startLine}-${next.effectiveEnd} and ${current.startLine}-${current.effectiveEnd}`,
        linesRemoved: 0, linesAdded: 0
      };
    }
  }

  // Apply edits bottom-to-top
  let linesRemoved = 0;
  let linesAdded = 0;

  for (const edit of normalizedEdits) {
    const newLines = edit.newContent === '' ? [] : edit.newContent.split('\n');

    if (edit.type === 'insert_before') {
      // Insert before the specified line (no removal)
      fileLines.splice(edit.startLine - 1, 0, ...newLines);
      linesAdded += newLines.length;
    } else if (edit.type === 'delete') {
      const removeCount = edit.endLine - edit.startLine + 1;
      fileLines.splice(edit.startLine - 1, removeCount);
      linesRemoved += removeCount;
    } else {
      // replace
      const removeCount = edit.endLine - edit.startLine + 1;
      fileLines.splice(edit.startLine - 1, removeCount, ...newLines);
      linesRemoved += removeCount;
      linesAdded += newLines.length;
    }
  }

  // Post-edit sanitization: strip LLM artifact markers and detect brace corruption
  let sanitized = 0;
  for (let j = 0; j < fileLines.length; j++) {
    const original = fileLines[j];
    // Strip hashline edit markers that LLMs sometimes leave in output
    const cleaned = stripArtifactMarkers(original);
    if (cleaned !== original) {
      fileLines[j] = cleaned;
      sanitized++;
    }
  }

  // Post-edit syntax gate: reject edits that introduce brace imbalance or JS parse errors.
  // Drill 7 proved hashline-ollama consistently corrupts files with extra closing braces.
  // This gate blocks the write and returns success:false with syntaxGateReject flag.
  const ext = path.extname(filePath).toLowerCase();
  if (SYNTAX_CHECK_EXTENSIONS.has(ext)) {
    const editedContent = fileLines.join('\n');
    const openBraces = (editedContent.match(/\{/g) || []).length;
    const closeBraces = (editedContent.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      const delta = closeBraces - openBraces;

      // Auto-repair: if there are 1-4 extra closing braces at EOF, try removing them
      let repaired = false;
      if (delta > 0 && delta <= 4) {
        // Count trailing brace-only lines, skipping trailing empty/whitespace lines
        let trailingBraceLines = 0;
        for (let k = fileLines.length - 1; k >= 0; k--) {
          if (/^\s*$/.test(fileLines[k])) {
            continue;
          }
          if (/^\s*\}\s*$/.test(fileLines[k])) {
            trailingBraceLines++;
          } else {
            break;
          }
        }
        if (trailingBraceLines >= delta) {
          // Remove exactly `delta` trailing brace-only lines from the end
          let removed = 0;
          for (let k = fileLines.length - 1; k >= 0 && removed < delta; k--) {
            if (/^\s*$/.test(fileLines[k])) continue;  // skip empty lines
            if (/^\s*\}\s*$/.test(fileLines[k])) {
              fileLines.splice(k, 1);
              removed++;
            }
          }
          // Re-verify balance
          const repairedContent = fileLines.join('\n');
          const newOpen = (repairedContent.match(/\{/g) || []).length;
          const newClose = (repairedContent.match(/\}/g) || []).length;
          if (newOpen === newClose) {
            repaired = true;
            logger.info(`[HashlineEdit] AUTO-REPAIRED: removed ${delta} trailing brace(s) from ${path.basename(filePath)}`);
          } else {
            // Repair didn't fix it — restore lines (fall through to rejection)
            // We can't restore popped lines, so recalculate from scratch
            // This path is unlikely since we only removed exactly delta braces
          }
        }
      }

      if (!repaired) {
        logger.info(`[HashlineEdit] SYNTAX GATE REJECT: Brace imbalance in ${path.basename(filePath)}: ${openBraces} open, ${closeBraces} close (delta: ${delta > 0 ? '+' : ''}${delta})`);
        return {
          success: false,
          error: `Syntax gate: brace imbalance after edit (${openBraces} open, ${closeBraces} close). File not written.`,
          linesRemoved, linesAdded, syntaxGateReject: true
        };
      }
    }

    // For JS files, also validate syntax via vm.Script
    if (ext === '.js') {
      try {
        const vm = require('vm');
        const currentContent = fileLines.join('\n');
        new vm.Script(currentContent, { filename: path.basename(filePath) });
      } catch (syntaxErr) {
        logger.info(`[HashlineEdit] SYNTAX GATE REJECT: Parse error in ${path.basename(filePath)}: ${syntaxErr.message}`);
        return {
          success: false,
          error: `Syntax gate: JS parse error after edit: ${syntaxErr.message}. File not written.`,
          linesRemoved, linesAdded, syntaxGateReject: true
        };
      }
    }
  }

  if (sanitized > 0) {
    logger.info(`[HashlineEdit] Stripped ${sanitized} LLM artifact marker(s) from ${path.basename(filePath)}`);
  }

  // Write back — file passed syntax gate
  try {
    fs.writeFileSync(filePath, fileLines.join('\n'), 'utf8');
  } catch (e) {
    return { success: false, error: `Cannot write file: ${e.message}`, linesRemoved, linesAdded };
  }

  return { success: true, linesRemoved, linesAdded, sanitized, fuzzyFixups };
}

module.exports = {
  computeLineHash,
  lineSimilarity,
  findSearchMatch,
  parseHashlineLiteEdits,
  applyHashlineLiteEdits,
  parseHashlineEdits,
  applyHashlineEdits,
};
