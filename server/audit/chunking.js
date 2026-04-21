'use strict';

const { readFile: readFileAsync } = require('node:fs/promises');

const DEFAULT_MAX_CHUNK_LINES = 800;
const OVERLAP_LINES = 50;
const SMALL_BATCH_SIZE = 3;

const BOUNDARY_PATTERNS = [
  /^\s*export\s+async\s+function\b/,
  /^\s*export\s+function\b/,
  /^\s*async\s+function\b/,
  /^\s*class\b/,
  /^\s*const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s+)?(?:function\b|[^=]+=>|\{|\[)/,
  /^\s*module\.exports\s*=/,
  /^\s*\/\/\s*-{3,}/,
];

const toInt = (value, fallback, minimum = 1) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const valueAsInt = Math.floor(parsed);

  if (valueAsInt < minimum) {
    return fallback;
  }

  return valueAsInt;
};

const splitContentLines = (content) => {
  if (typeof content !== 'string' || content.length === 0) {
    return [];
  }

  return content.split('\n');
};

const isBoundary = (line) => {
  if (typeof line !== 'string') {
    return false;
  }

  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return false;
  }

  return BOUNDARY_PATTERNS.some((pattern) => pattern.test(trimmed));
};

const splitAtLogicalBoundaries = (lines, maxChunkLines = DEFAULT_MAX_CHUNK_LINES) => {
  const chunks = [];

  if (!Array.isArray(lines) || lines.length === 0) {
    return chunks;
  }

  const maxLines = toInt(maxChunkLines, DEFAULT_MAX_CHUNK_LINES);
  const totalLines = lines.length;

  if (totalLines <= maxLines) {
    return [{
      startLine: 1,
      endLine: totalLines,
      lines: lines.slice(0, totalLines),
    }];
  }

  let chunkStart = 1;
  let chunkSize = 0;

  for (let index = 0; index < totalLines; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];

    if (chunkSize >= maxLines && isBoundary(line)) {
      chunks.push({
        startLine: chunkStart,
        endLine: lineNumber - 1,
        lines: lines.slice(chunkStart - 1, lineNumber - 1),
      });

      chunkStart = lineNumber;
      chunkSize = 0;
    }

    chunkSize += 1;
  }

  chunks.push({
    startLine: chunkStart,
    endLine: totalLines,
    lines: lines.slice(chunkStart - 1, totalLines),
  });

  return chunks;
};

const splitSlidingWindow = (lines, windowSize, overlap) => {
  const chunks = [];

  if (!Array.isArray(lines) || lines.length === 0) {
    return chunks;
  }

  const size = toInt(windowSize, DEFAULT_MAX_CHUNK_LINES);
  const overlapLines = Math.max(0, toInt(overlap, OVERLAP_LINES, 0));
  const safeOverlap = Math.min(overlapLines, size);
  const totalLines = lines.length;
  let startLine = 1;

  while (startLine <= totalLines) {
    const endLine = Math.min(startLine + size - 1, totalLines);
    const chunkLines = lines.slice(startLine - 1, endLine);

    chunks.push({
      startLine,
      endLine,
      lines: chunkLines,
    });

    if (endLine >= totalLines) {
      break;
    }

    const nextStartLine = endLine - safeOverlap;
    if (nextStartLine <= startLine) {
      break;
    }

    startLine = nextStartLine;
  }

  return chunks;
};

const buildChunkContextHeader = ({
  filePath,
  totalLines,
  chunkIndex,
  totalChunks,
  chunkSummaries,
}) => {
  const total = Number.isFinite(totalLines) ? totalLines : 0;
  const current = Number.isFinite(chunkIndex) ? chunkIndex : 0;
  const allChunks = Number.isFinite(totalChunks) ? totalChunks : 0;
  const file = typeof filePath === 'string' ? filePath : '';
  const summaries = Array.isArray(chunkSummaries) ? chunkSummaries : [];

  const chunkLines = summaries.map((summary, index) => {
    if (typeof summary === 'string') {
      return `Chunk ${index + 1}: ${summary}`;
    }

    if (
      summary &&
      Number.isFinite(summary.startLine) &&
      Number.isFinite(summary.endLine)
    ) {
      return `Chunk ${index + 1}: lines ${summary.startLine}-${summary.endLine}`;
    }

    return `Chunk ${index + 1}: lines unknown`;
  });

  return [
    '[CHUNK CONTEXT]',
    `This is chunk ${current} of ${allChunks} for ${file} (${total} lines total).`,
    ...chunkLines,
  ].join('\n');
};

const resolveTier = (file) => {
  const tier = typeof file?.tier === 'string' ? file.tier.toLowerCase() : '';
  if (tier === 'small' || tier === 'medium' || tier === 'large') {
    return tier;
  }

  const lineCount = Number(file?.lines);

  if (Number.isFinite(lineCount)) {
    if (lineCount < 400) {
      return 'small';
    }

    if (lineCount < 1200) {
      return 'medium';
    }
  }

  return 'large';
};

const createReviewUnits = async (files, options = {}) => {
  if (!Array.isArray(files)) {
    return [];
  }

  const maxChunkLines = toInt(options.maxChunkLines, DEFAULT_MAX_CHUNK_LINES);
  const readFile = typeof options.readFile === 'function'
    ? options.readFile
    : (filePath) => readFileAsync(filePath, 'utf8');

  const units = [];
  const small = [];
  const medium = [];
  const large = [];

  for (const file of files) {
    const tier = resolveTier(file);

    if (tier === 'small') {
      small.push(file);
      continue;
    }

    if (tier === 'medium') {
      medium.push(file);
      continue;
    }

    large.push(file);
  }

  let unitIndex = 1;

  const makeId = () => `review-unit-${unitIndex++}`;

  for (let start = 0; start < small.length; start += SMALL_BATCH_SIZE) {
    units.push({
      id: makeId(),
      files: small.slice(start, start + SMALL_BATCH_SIZE),
      chunked: false,
      chunkIndex: 1,
      totalChunks: 1,
    });
  }

  for (const file of medium) {
    units.push({
      id: makeId(),
      files: [file],
      chunked: false,
      chunkIndex: 1,
      totalChunks: 1,
    });
  }

  for (const file of large) {
    const filePath = file && file.path ? file.path : '';
    const fileContent = await readFile(filePath, file);
    const fileLines = splitContentLines(fileContent);
    const totalLines = fileLines.length;
    const chunkSummaries = [];
    let chunks = splitAtLogicalBoundaries(fileLines, maxChunkLines);

    if (chunks.length <= 1) {
      chunks = splitSlidingWindow(fileLines, maxChunkLines, OVERLAP_LINES);
    }

    chunks.forEach((chunk) => {
      chunkSummaries.push({ startLine: chunk.startLine, endLine: chunk.endLine });
    });

    if (chunkSummaries.length === 0) {
      chunkSummaries.push({ startLine: 1, endLine: totalLines });
    }

    const contextChunks = chunkSummaries;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      units.push({
        id: makeId(),
        files: [file],
        chunked: true,
        chunkIndex: chunkIndex + 1,
        totalChunks: chunks.length,
        chunkContent: chunk.lines.join('\n'),
        chunkContext: buildChunkContextHeader({
          filePath: filePath,
          totalLines,
          chunkIndex: chunkIndex + 1,
          totalChunks: chunks.length,
          chunkSummaries: contextChunks,
        }),
      });
    }
  }

  return units;
};

module.exports = {
  createReviewUnits,
  splitAtLogicalBoundaries,
  splitSlidingWindow,
  buildChunkContextHeader,
  DEFAULT_MAX_CHUNK_LINES,
  OVERLAP_LINES,
  SMALL_BATCH_SIZE,
};
