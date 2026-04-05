'use strict';

const os = require('node:os');
const path = require('node:path');

const {
  buildChunkContextHeader,
  createReviewUnits,
  splitAtLogicalBoundaries,
  splitSlidingWindow,
} = require('../audit/chunking');

const makeFile = (name, lines, tier) => ({
  path: path.join(os.tmpdir(), `${name}.js`),
  relativePath: `${name}.js`,
  name: `${name}.js`,
  ext: '.js',
  lines,
  tier,
  importPaths: ['./dep'],
});

const buildReadFile = (files) => (filePath) => {
  const file = files.find((candidate) => candidate.path === filePath);
  if (!file) {
    return '';
  }

  return Array.from({ length: file.lines }, (_, i) => `line ${i + 1}`).join('\n');
};

describe('audit chunking', () => {
  it('batches small files into groups of SMALL_BATCH_SIZE', async () => {
    const files = [
      makeFile('small-a', 100, 'small'),
      makeFile('small-b', 150, 'small'),
      makeFile('small-c', 200, 'small'),
      makeFile('small-d', 250, 'small'),
    ];

    const units = await createReviewUnits(files, {
      readFile: buildReadFile(files),
    });

    expect(units).toHaveLength(2);
    expect(units[0].files).toHaveLength(3);
    expect(units[1].files).toHaveLength(1);
  });

  it('assigns each medium file to its own non-chunked unit', async () => {
    const files = [
      makeFile('medium-a', 600, 'medium'),
      makeFile('medium-b', 700, 'medium'),
    ];

    const units = await createReviewUnits(files, {
      readFile: buildReadFile(files),
    });

    expect(units).toHaveLength(2);
    for (const unit of units) {
      expect(unit.chunked).toBe(false);
      expect(unit.files).toHaveLength(1);
      expect(unit.chunkIndex).toBe(1);
      expect(unit.totalChunks).toBe(1);
    }
  });

  it('splits large files into multiple chunked units', async () => {
    const files = [
      makeFile('large-a', 1700, 'large'),
    ];

    const units = await createReviewUnits(files, {
      maxChunkLines: 800,
      readFile: buildReadFile(files),
    });

    expect(units).toHaveLength(3);
    expect(units.every((unit) => unit.chunked)).toBe(true);
    expect(units[0].chunkContext).toContain('[CHUNK CONTEXT]');
    expect(units[0].chunkIndex).toBe(1);
    expect(units[0].totalChunks).toBe(3);
  });

  it('splitAtLogicalBoundaries splits on function declaration boundaries', () => {
    const lines = [
      'const value = 1;',
      'const flag = true;',
      'const helper = () => {',
      '  return value;',
      '}',
      'export function first() {',
      '  return 1;',
      '}',
      'class Widget {',
      '}',
      'module.exports = Widget;',
    ];
    const chunks = splitAtLogicalBoundaries(lines, 4);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[1].startLine).toBe(6);
    expect(chunks[0].endLine).toBe(5);
    expect(chunks[0].lines[0]).toBe('const value = 1;');
  });

  it('splitAtLogicalBoundaries returns a single chunk for small files', () => {
    const lines = [
      'const value = 1;',
      'const helper = () => value;',
      'module.exports = { helper };',
    ];

    const chunks = splitAtLogicalBoundaries(lines, 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(3);
  });

  it('splitSlidingWindow creates overlapping chunks', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const chunks = splitSlidingWindow(lines, 4, 1);

    expect(chunks).toHaveLength(4);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(4);
    expect(chunks[1].startLine).toBe(3);
    expect(chunks[1].startLine).toBeLessThan(chunks[0].endLine);
  });

  it('buildChunkContextHeader contains chunk metadata', () => {
    const header = buildChunkContextHeader({
      filePath: 'server/database.js',
      totalLines: 2228,
      chunkIndex: 2,
      totalChunks: 4,
      chunkSummaries: [
        { startLine: 1, endLine: 560 },
        { startLine: 561, endLine: 1120 },
        { startLine: 1121, endLine: 1680 },
        { startLine: 1681, endLine: 2228 },
      ],
    });

    expect(header).toContain('[CHUNK CONTEXT]');
    expect(header).toContain('This is chunk 2 of 4 for server/database.js (2228 lines total).');
    expect(header).toContain('Chunk 1: lines 1-560');
  });
});
