'use strict';

/**
 * Hashline Verification Module
 *
 * Extracted from task-manager.js (Phase 10B) — verifies hashline references
 * in task output against actual file content and attempts fuzzy SEARCH/REPLACE
 * repair for failed edits.
 *
 * Uses init() dependency injection for hashline parser and post-task functions.
 */

const path = require('path');
const fs = require('fs');
const logger = require('../logger').child({ component: 'hashline-verify' });

// Dependency injection
let _computeLineHash = null;
let _getFileChangesForValidation = null;
let _lineSimilarity = null;

/**
 * Initialize dependencies for this module.
 * @param {Object} deps
 * @param {Function} deps.computeLineHash - From utils/hashline-parser
 * @param {Function} deps.getFileChangesForValidation - From validation/post-task
 * @param {Function} deps.lineSimilarity - From utils/hashline-parser
 */
function init(deps) {
  if (deps.computeLineHash) _computeLineHash = deps.computeLineHash;
  if (deps.getFileChangesForValidation) _getFileChangesForValidation = deps.getFileChangesForValidation;
  if (deps.lineSimilarity) _lineSimilarity = deps.lineSimilarity;
}

/**
 * Verify hashline references in task output against actual file content.
 * Parses L###:xx patterns from output, re-reads files, recomputes hashes,
 * and flags mismatches as stale edit warnings.
 * @param {string} taskId - Task ID
 * @param {string} output - Task output text
 * @param {string} workingDirectory - Working directory for file resolution
 * @returns {{ total: number, matched: number, mismatched: number, score: number }}
 */
function verifyHashlineReferences(taskId, output, workingDirectory) {
  if (!output || !workingDirectory) return { total: 0, matched: 0, mismatched: 0, score: 100 };

  // Parse L###:xx patterns from output
  const hashlinePattern = /L(\d{3}):([0-9a-f]{2}):/g;
  const references = [];
  let match;
  while ((match = hashlinePattern.exec(output)) !== null) {
    references.push({ lineNum: parseInt(match[1], 10), hash: match[2] });
  }

  if (references.length === 0) return { total: 0, matched: 0, mismatched: 0, score: 100 };

  // Try to resolve which files the references point to by checking recently modified files
  let fileLines = null;
  try {
    const changedFiles = _getFileChangesForValidation(workingDirectory, 5);
    for (const fc of changedFiles) {
      const fullPath = path.join(workingDirectory, fc.path);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');
        // Check if any references match this file
        const firstRef = references[0];
        if (firstRef.lineNum <= lines.length) {
          const actualHash = _computeLineHash(lines[firstRef.lineNum - 1] || '');
          if (actualHash === firstRef.hash) {
            fileLines = lines;
            break;
          }
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* ignore */ }

  if (!fileLines) return { total: references.length, matched: 0, mismatched: 0, score: 100 };

  let matched = 0;
  let mismatched = 0;
  for (const ref of references) {
    if (ref.lineNum > fileLines.length) {
      mismatched++;
      continue;
    }
    const actualHash = _computeLineHash(fileLines[ref.lineNum - 1] || '');
    if (actualHash === ref.hash) {
      matched++;
    } else {
      mismatched++;
    }
  }

  if (mismatched > 0) {
    logger.info(`[Hashline] Task ${taskId}: ${mismatched}/${references.length} stale hashline references detected`);
  }

  const score = references.length > 0 ? Math.round((matched / references.length) * 100) : 100;
  return { total: references.length, matched, mismatched, score };
}

/**
 * Attempt fuzzy repair of a failed SEARCH/REPLACE block.
 * Parses the failed SEARCH block from output, fuzzy-matches against actual file content,
 * and applies the corrected edit if similarity >= 80%.
 * @param {string} taskId - Task ID
 * @param {string} output - Task output containing failed SEARCH block
 * @param {string} workingDirectory - Working directory
 * @returns {{ repaired: boolean, file: string|null, similarity: number }}
 */
function attemptFuzzySearchRepair(taskId, output, workingDirectory) {
  if (!output || !workingDirectory) return { repaired: false, file: null, similarity: 0 };

  // Parse failed SEARCH block: look for "<<<<<<< SEARCH" ... "=======" ... ">>>>>>> REPLACE" patterns
  // Also match the file reference before the SEARCH block
  const failurePattern = /(?:Can't edit|FAILED to apply)[^\n]*?(\S+\.\w+)/i;
  const failureMatch = failurePattern.exec(output);
  if (!failureMatch) return { repaired: false, file: null, similarity: 0 };

  const targetFile = failureMatch[1];
  const fullPath = path.resolve(workingDirectory, targetFile);

  // Containment check: reject targets outside the working directory
  const relCheck = path.relative(path.resolve(workingDirectory), fullPath);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return { repaired: false, file: targetFile, similarity: 0 };
  }

  if (!fs.existsSync(fullPath)) return { repaired: false, file: targetFile, similarity: 0 };

  // Extract the SEARCH and REPLACE blocks
  const searchReplacePattern = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
  const blocks = [];
  let srMatch;
  while ((srMatch = searchReplacePattern.exec(output)) !== null) {
    blocks.push({ search: srMatch[1], replace: srMatch[2] });
  }

  if (blocks.length === 0) return { repaired: false, file: targetFile, similarity: 0 };

  let fileContent;
  try {
    fileContent = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return { repaired: false, file: targetFile, similarity: 0 };
  }

  const fileLines = fileContent.split('\n');
  let anyRepaired = false;
  let bestSimilarity = 0;

  // Phase 1: find the best fuzzy match position for each block (read-only pass)
  for (const block of blocks) {
    const searchLines = block.search.split('\n');
    block._searchLines = searchLines;

    let bestMatchStart = -1;
    let bestMatchScore = 0;

    for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
      let totalSimilarity = 0;
      for (let j = 0; j < searchLines.length; j++) {
        totalSimilarity += _lineSimilarity(searchLines[j], fileLines[i + j]);
      }
      const avgSimilarity = totalSimilarity / searchLines.length;
      if (avgSimilarity > bestMatchScore) {
        bestMatchScore = avgSimilarity;
        bestMatchStart = i;
      }
    }

    block._matchStart = bestMatchStart;
    block._matchScore = bestMatchScore;
    bestSimilarity = Math.max(bestSimilarity, bestMatchScore);
  }

  // Phase 2: apply repairs in reverse line order so earlier splices don't shift
  // the indices of blocks that appear higher up in the file.
  blocks.sort((a, b) => b._matchStart - a._matchStart);

  for (const block of blocks) {
    const { _searchLines: searchLines, _matchStart: bestMatchStart, _matchScore: bestMatchScore } = block;

    // Apply repair if similarity >= 80%
    if (bestMatchScore >= 0.8 && bestMatchStart >= 0) {
      const replaceLines = block.replace.split('\n');
      fileLines.splice(bestMatchStart, searchLines.length, ...replaceLines);
      anyRepaired = true;
      logger.info(`[FuzzyRepair] Task ${taskId}: repaired SEARCH block in ${targetFile} (similarity: ${(bestMatchScore * 100).toFixed(1)}%)`);
    }
  }

  if (anyRepaired) {
    try {
      fs.writeFileSync(fullPath, fileLines.join('\n'), 'utf8');
      logger.info(`[FuzzyRepair] Task ${taskId}: wrote repaired file ${targetFile}`);
    } catch (e) {
      logger.info(`[FuzzyRepair] Task ${taskId}: failed to write repaired file: ${e.message}`);
      return { repaired: false, file: targetFile, similarity: bestSimilarity };
    }
  }

  return { repaired: anyRepaired, file: targetFile, similarity: bestSimilarity };
}

module.exports = {
  init,
  verifyHashlineReferences,
  attemptFuzzySearchRepair,
};
