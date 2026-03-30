'use strict';

const fs = require('fs');
const path = require('path');
const { ErrorCodes, makeError } = require('./shared');

// ─── FNV-1a Line Hashing (matches task-manager.js computeLineHash) ──────────

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

function lineSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
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

// ─── In-Memory File Cache ───────────────────────────────────────────────────

// Map<filePath, { mtime: number, lines: Array<{ num: number, hash: string, content: string }> }>
const fileCache = new Map();
const MAX_CACHE_ENTRIES = 50;

function evictOldest() {
  if (fileCache.size <= MAX_CACHE_ENTRIES) return;
  // Note: uses FIFO eviction (insertion order). Consider LRU for better cache hit rates.
  const firstKey = fileCache.keys().next().value;
  if (firstKey) fileCache.delete(firstKey);
}

function getCachedFile(filePath) {
  const entry = fileCache.get(filePath);
  if (!entry) return null;
  // Check if file has been modified since caching
  try {
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs !== entry.mtime) return null;
  } catch {
    return null;
  }
  return entry;
}

function cacheFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const stat = fs.statSync(filePath);
  const rawLines = content.split('\n');
  const lines = rawLines.map((line, i) => ({
    num: i + 1,
    hash: computeLineHash(line),
    content: line,
  }));
  evictOldest();
  const entry = { mtime: stat.mtimeMs, lines, rawContent: content };
  fileCache.set(filePath, entry);
  return entry;
}

// ─── hashline_read ──────────────────────────────────────────────────────────

function handleHashlineRead(args) {
  const filePath = args.file_path;
  if (!filePath) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path is required');
  }
  if (!fs.existsSync(filePath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${filePath}`);
  }

  const offset = Math.max(1, Math.floor(args.offset || 1));
  const limit = args.limit ? Math.max(1, Math.floor(args.limit)) : null;

  // Read and cache
  let cached = getCachedFile(filePath);
  if (!cached) {
    cached = cacheFile(filePath);
  }

  const totalLines = cached.lines.length;
  const startIdx = offset - 1;
  const endIdx = limit ? Math.min(startIdx + limit, totalLines) : totalLines;
  const slice = cached.lines.slice(startIdx, endIdx);

  // Format: right-aligned line number, colon, 2-char hash, tab, content
  const numWidth = String(endIdx).length;
  const formatted = slice.map(l => {
    const num = String(l.num).padStart(numWidth, ' ');
    return `${num}:${l.hash}\t${l.content}`;
  }).join('\n');

  const header = `## ${path.basename(filePath)} (${totalLines} lines)`;
  const range = limit ? ` [lines ${offset}-${endIdx}]` : '';

  return {
    content: [{
      type: 'text',
      text: `${header}${range}\n\n${formatted}\n`
    }],
  };
}

// ─── hashline_edit ──────────────────────────────────────────────────────────

function handleHashlineEdit(args) {
  const filePath = args.file_path;
  if (!filePath) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path is required');
  }
  if (!fs.existsSync(filePath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${filePath}`);
  }

  const edits = args.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'edits array is required and must be non-empty');
  }

  // Ensure we have a cached version (or refresh it)
  let cached = getCachedFile(filePath);
  if (!cached) {
    cached = cacheFile(filePath);
  }

  // Validate all edits before applying any
  const validatedEdits = [];
  for (const edit of edits) {
    const startLine = edit.start_line;
    const startHash = edit.start_hash;
    const endLine = edit.end_line !== undefined ? edit.end_line : startLine;
    const endHash = edit.end_hash !== undefined ? edit.end_hash : startHash;
    const newContent = edit.new_content;

    if (!startLine || !startHash) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'each edit requires start_line and start_hash');
    }
    if (newContent === undefined || newContent === null) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'each edit requires new_content (use empty string to delete)');
    }
    if (startLine < 1 || startLine > cached.lines.length) {
      return makeError(ErrorCodes.INVALID_PARAM, `start_line ${startLine} out of range (1-${cached.lines.length})`);
    }
    if (endLine < startLine || endLine > cached.lines.length) {
      return makeError(ErrorCodes.INVALID_PARAM, `end_line ${endLine} out of range (${startLine}-${cached.lines.length})`);
    }

    // Verify hashes match cached content (stale detection)
    const startCached = cached.lines[startLine - 1];
    if (startCached.hash !== startHash) {
      return makeError(ErrorCodes.CONFLICT, `Stale hash at line ${startLine}. Expected ${startHash}, got ${startCached.hash}.\nCurrent content: \`${startCached.content}\`\nRe-read the file with hashline_read to get fresh hashes.`);
    }
    const endCached = cached.lines[endLine - 1];
    if (endCached.hash !== endHash) {
      return makeError(ErrorCodes.CONFLICT, `Stale hash at line ${endLine}. Expected ${endHash}, got ${endCached.hash}.\nCurrent content: \`${endCached.content}\`\nRe-read the file with hashline_read to get fresh hashes.`);
    }

    validatedEdits.push({ startLine, endLine, newContent });
  }

  // Sort edits bottom-to-top so line numbers stay valid as we apply them
  validatedEdits.sort((a, b) => b.startLine - a.startLine);

  // Check for overlapping edits
  for (let i = 0; i < validatedEdits.length - 1; i++) {
    const current = validatedEdits[i];
    const next = validatedEdits[i + 1];
    if (next.endLine >= current.startLine) {
      return makeError(ErrorCodes.INVALID_PARAM, `Overlapping edits at lines ${next.startLine}-${next.endLine} and ${current.startLine}-${current.endLine}`);
    }
  }

  // Apply edits to the lines array
  const lines = cached.lines.map(l => l.content);
  let totalRemoved = 0;
  let totalAdded = 0;

  for (const edit of validatedEdits) {
    const newLines = edit.newContent === '' ? [] : edit.newContent.split('\n');
    const removeCount = edit.endLine - edit.startLine + 1;
    lines.splice(edit.startLine - 1, removeCount, ...newLines);
    totalRemoved += removeCount;
    totalAdded += newLines.length;
  }

  // Write back to disk
  const newFileContent = lines.join('\n');
  fs.writeFileSync(filePath, newFileContent, 'utf8');

  // Refresh cache
  const freshCached = cacheFile(filePath);

  // Show context around each edit (3 lines before/after)
  let output = `## Edited ${path.basename(filePath)}\n\n`;
  output += `**Edits applied:** ${validatedEdits.length} | `;
  output += `**Lines:** -${totalRemoved} +${totalAdded} (${freshCached.lines.length} total)\n\n`;

  // Show relevant lines from the fresh cache for verification
  const editRegions = validatedEdits.slice().reverse(); // back to top-to-bottom order
  for (const edit of editRegions) {
    const contextStart = Math.max(1, edit.startLine - 2);
    const newLines = edit.newContent === '' ? [] : edit.newContent.split('\n');
    const contextEnd = Math.min(freshCached.lines.length, edit.startLine + newLines.length + 1);
    const numWidth = String(contextEnd).length;
    output += '```\n';
    for (let i = contextStart - 1; i < contextEnd; i++) {
      const l = freshCached.lines[i];
      if (l) {
        const num = String(l.num).padStart(numWidth, ' ');
        output += `${num}:${l.hash}\t${l.content}\n`;
      }
    }
    output += '```\n\n';
  }

  return { content: [{ type: 'text', text: output }] };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  handleHashlineRead,
  handleHashlineEdit,
  computeLineHash,
  lineSimilarity,
};
