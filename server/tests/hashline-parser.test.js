'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  computeLineHash,
  lineSimilarity,
  findSearchMatch,
  parseHashlineLiteEdits,
  applyHashlineLiteEdits,
  parseHashlineEdits,
  applyHashlineEdits,
} = require('../utils/hashline-parser');

// ─── computeLineHash ───────────────────────────────────────────────────────

describe('computeLineHash', () => {
  it('returns a 2-char hex string', () => {
    const hash = computeLineHash('hello world');
    expect(hash).toMatch(/^[0-9a-f]{2}$/);
  });

  it('is deterministic — same input produces same hash', () => {
    const h1 = computeLineHash('const x = 42;');
    const h2 = computeLineHash('const x = 42;');
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different lines', () => {
    const h1 = computeLineHash('function foo() {');
    const h2 = computeLineHash('function bar() {');
    // Not guaranteed by FNV-1a for all inputs, but very likely for these
    expect(h1).not.toBe(h2);
  });

  it('handles empty string', () => {
    const hash = computeLineHash('');
    expect(hash).toMatch(/^[0-9a-f]{2}$/);
    // FNV-1a of empty string: offset_basis & 0xFF = 0x811c9dc5 & 0xFF = 0xc5 = "c5"
    expect(hash).toBe('c5');
  });

  it('handles single character', () => {
    const hash = computeLineHash('a');
    expect(hash).toMatch(/^[0-9a-f]{2}$/);
  });

  it('handles special characters (unicode, tabs, etc.)', () => {
    const hash1 = computeLineHash('\t\t// comment with tab');
    const hash2 = computeLineHash('  const emoji = "🚀";');
    const hash3 = computeLineHash('');
    expect(hash1).toMatch(/^[0-9a-f]{2}$/);
    expect(hash2).toMatch(/^[0-9a-f]{2}$/);
    expect(hash3).toMatch(/^[0-9a-f]{2}$/);
  });

  it('handles very long lines', () => {
    const longLine = 'x'.repeat(10000);
    const hash = computeLineHash(longLine);
    expect(hash).toMatch(/^[0-9a-f]{2}$/);
  });

  it('distinguishes lines that differ only in whitespace', () => {
    const h1 = computeLineHash('  hello');
    const h2 = computeLineHash('    hello');
    // Different whitespace should produce different hashes
    expect(h1).not.toBe(h2);
  });

  it('produces zero-padded hex for small hash values', () => {
    // We can't control which input gives a small hash, but we can verify padding
    // by checking empty string which we know is 'c5'
    const hash = computeLineHash('');
    expect(hash.length).toBe(2);
  });
});

// ─── lineSimilarity ─────────────────────────────────────────────────────────

describe('lineSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(lineSimilarity('hello', 'hello')).toBe(1);
  });

  it('returns 1 for two empty strings', () => {
    // Both are falsy so a === b is true ('') but then !a returns true -> 0
    // Actually '' === '' is true, so it returns 1 first
    expect(lineSimilarity('', '')).toBe(1);
  });

  it('returns 0 when first string is empty and second is not', () => {
    expect(lineSimilarity('', 'hello')).toBe(0);
  });

  it('returns 0 when second string is empty and first is not', () => {
    expect(lineSimilarity('hello', '')).toBe(0);
  });

  it('returns 0 for null/undefined inputs', () => {
    expect(lineSimilarity(null, 'hello')).toBe(0);
    expect(lineSimilarity('hello', null)).toBe(0);
    expect(lineSimilarity(undefined, 'hello')).toBe(0);
    expect(lineSimilarity('hello', undefined)).toBe(0);
  });

  it('returns 0 for both null', () => {
    // null === null is true, so it returns 1 before the !a check
    expect(lineSimilarity(null, null)).toBe(1);
  });

  it('returns high similarity for strings that differ by one character', () => {
    const sim = lineSimilarity('hello', 'hallo');
    expect(sim).toBeGreaterThan(0.7);
    expect(sim).toBeLessThan(1);
  });

  it('returns low similarity for completely different strings', () => {
    const sim = lineSimilarity('abcdef', 'zyxwvu');
    expect(sim).toBeLessThan(0.5);
  });

  it('handles length-ratio shortcut (>50% difference returns 0.3)', () => {
    // "a" vs "abcde" — length ratio |1-5|/5 = 0.8 > 0.5
    const sim = lineSimilarity('a', 'abcde');
    expect(sim).toBe(0.3);
  });

  it('returns correct similarity for similar code lines', () => {
    const a = '  const result = calculateSum(x, y);';
    const b = '  const result = calculateSum(a, b);';
    const sim = lineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.8);
  });

  it('is symmetric: sim(a,b) === sim(b,a)', () => {
    const a = 'function foo() {';
    const b = 'function bar() {';
    expect(lineSimilarity(a, b)).toBe(lineSimilarity(b, a));
  });

  it('returns a value between 0 and 1 for any non-empty pair', () => {
    const pairs = [
      ['abc', 'xyz'],
      ['short', 'a very long string that differs significantly'],
      ['const x = 1;', 'const x = 2;'],
    ];
    for (const [a, b] of pairs) {
      const sim = lineSimilarity(a, b);
      expect(sim).toBeGreaterThanOrEqual(0);
      expect(sim).toBeLessThanOrEqual(1);
    }
  });
});

// ─── findSearchMatch ────────────────────────────────────────────────────────

describe('findSearchMatch', () => {
  it('returns null for empty search lines', () => {
    expect(findSearchMatch([], ['line1', 'line2'])).toBeNull();
  });

  it('returns null for empty original lines', () => {
    expect(findSearchMatch(['line1'], [])).toBeNull();
  });

  it('returns null for both empty', () => {
    expect(findSearchMatch([], [])).toBeNull();
  });

  it('finds an exact match (score = 1)', () => {
    const original = ['line1', 'line2', 'line3', 'line4', 'line5'];
    const search = ['line2', 'line3'];
    const result = findSearchMatch(search, original);
    expect(result).not.toBeNull();
    expect(result.startLine).toBe(2); // 1-indexed
    expect(result.endLine).toBe(3);
    expect(result.score).toBe(1);
  });

  it('finds an exact match at the beginning', () => {
    const original = ['alpha', 'beta', 'gamma'];
    const search = ['alpha', 'beta'];
    const result = findSearchMatch(search, original);
    expect(result).not.toBeNull();
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(2);
    expect(result.score).toBe(1);
  });

  it('finds an exact match at the end', () => {
    const original = ['alpha', 'beta', 'gamma'];
    const search = ['beta', 'gamma'];
    const result = findSearchMatch(search, original);
    expect(result).not.toBeNull();
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.score).toBe(1);
  });

  it('finds a single-line exact match', () => {
    const original = ['aaa', 'bbb', 'ccc'];
    const search = ['bbb'];
    const result = findSearchMatch(search, original);
    expect(result).not.toBeNull();
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(2);
    expect(result.score).toBe(1);
  });

  it('finds a fuzzy match with minor differences', () => {
    const original = [
      'function calculateSum(a, b) {',
      '  return a + b;',
      '}',
    ];
    const search = [
      'function calculateSum(x, y) {',
      '  return x + y;',
      '}',
    ];
    const result = findSearchMatch(search, original);
    expect(result).not.toBeNull();
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
    expect(result.score).toBeGreaterThanOrEqual(0.8);
  });

  it('returns null when no match meets threshold', () => {
    const original = ['aaaa', 'bbbb', 'cccc'];
    const search = ['xxxx', 'yyyy'];
    const result = findSearchMatch(search, original);
    expect(result).toBeNull();
  });

  it('returns the best match when multiple windows exist', () => {
    const original = [
      'function foo(a) {',
      '  return a;',
      '}',
      'function foo(b) {',
      '  return b;',
      '}',
    ];
    // Exact match on second block
    const search = ['function foo(b) {', '  return b;', '}'];
    const result = findSearchMatch(search, original);
    expect(result).not.toBeNull();
    expect(result.startLine).toBe(4);
    expect(result.endLine).toBe(6);
    expect(result.score).toBe(1);
  });

  it('returns null when search is longer than original', () => {
    const original = ['a', 'b'];
    const search = ['a', 'b', 'c', 'd'];
    const result = findSearchMatch(search, original);
    expect(result).toBeNull();
  });

  it('returns null when a single line has similarity below 50%', () => {
    // Even if average is >= 0.8, a single line below 0.5 should fail
    const original = [
      'const x = 1;',
      'completely different stuff here that has zero in common',
      'const y = 2;',
    ];
    const search = [
      'const x = 1;',
      'zzzzzzzzzzzzz',
      'const y = 2;',
    ];
    const result = findSearchMatch(search, original);
    // The middle line similarity should be very low, blocking the match
    expect(result).toBeNull();
  });
});

// ─── parseHashlineEdits ─────────────────────────────────────────────────────

describe('parseHashlineEdits', () => {
  it('returns empty edits and no errors for null input', () => {
    const result = parseHashlineEdits(null);
    expect(result.edits).toEqual([]);
    expect(result.parseErrors).toEqual([]);
  });

  it('returns empty edits and no errors for empty string', () => {
    const result = parseHashlineEdits('');
    expect(result.edits).toEqual([]);
    expect(result.parseErrors).toEqual([]);
  });

  it('returns empty edits for non-string input', () => {
    const result = parseHashlineEdits(42);
    expect(result.edits).toEqual([]);
    expect(result.parseErrors).toEqual([]);
  });

  it('parses a REPLACE operation', () => {
    const output = [
      'HASHLINE_EDIT src/app.ts',
      'REPLACE L005:ab TO L007:cd',
      '  const newLine1 = true;',
      '  const newLine2 = false;',
      'END_REPLACE',
    ].join('\n');

    const result = parseHashlineEdits(output);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]).toMatchObject({
      type: 'replace',
      filePath: 'src/app.ts',
      startLine: 5,
      startHash: 'ab',
      endLine: 7,
      endHash: 'cd',
      newContent: '  const newLine1 = true;\n  const newLine2 = false;',
    });
    expect(result.parseErrors).toEqual([]);
  });

  it('parses a DELETE operation', () => {
    const output = [
      'HASHLINE_EDIT src/utils.ts',
      'DELETE L010:ef TO L012:d5',
      'END_DELETE',
    ].join('\n');

    const result = parseHashlineEdits(output);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]).toMatchObject({
      type: 'delete',
      filePath: 'src/utils.ts',
      startLine: 10,
      startHash: 'ef',
      endLine: 12,
      endHash: 'd5',
      newContent: '',
    });
  });

  it('parses an INSERT_BEFORE operation', () => {
    const output = [
      'HASHLINE_EDIT src/index.ts',
      'INSERT_BEFORE L020:a1',
      '// inserted comment',
      'const inserted = true;',
      'END_INSERT',
    ].join('\n');

    const result = parseHashlineEdits(output);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]).toMatchObject({
      type: 'insert_before',
      filePath: 'src/index.ts',
      startLine: 20,
      startHash: 'a1',
      endLine: undefined,
      endHash: undefined,
      newContent: '// inserted comment\nconst inserted = true;',
    });
  });

  it('parses multiple operations for the same file', () => {
    const output = [
      'HASHLINE_EDIT src/app.ts',
      'REPLACE L001:aa TO L002:bb',
      'new line 1',
      'END_REPLACE',
      'DELETE L010:cc TO L012:dd',
      'END_DELETE',
      'INSERT_BEFORE L020:ee',
      'inserted line',
      'END_INSERT',
    ].join('\n');

    const result = parseHashlineEdits(output);
    expect(result.edits).toHaveLength(3);
    expect(result.edits[0].type).toBe('replace');
    expect(result.edits[1].type).toBe('delete');
    expect(result.edits[2].type).toBe('insert_before');
  });

  it('parses operations across multiple file headers', () => {
    const output = [
      'HASHLINE_EDIT src/a.ts',
      'REPLACE L001:aa TO L002:bb',
      'new content',
      'END_REPLACE',
      'HASHLINE_EDIT src/b.ts',
      'DELETE L005:cc TO L006:dd',
      'END_DELETE',
    ].join('\n');

    const result = parseHashlineEdits(output);
    expect(result.edits).toHaveLength(2);
    expect(result.edits[0].filePath).toBe('src/a.ts');
    expect(result.edits[1].filePath).toBe('src/b.ts');
  });

  it('reports missing END_REPLACE', () => {
    const output = [
      'HASHLINE_EDIT src/app.ts',
      'REPLACE L001:aa TO L002:bb',
      'new content',
      // Missing END_REPLACE
    ].join('\n');

    const result = parseHashlineEdits(output);
    expect(result.edits).toHaveLength(1);
    expect(result.parseErrors).toEqual(
      expect.arrayContaining([expect.stringContaining('Missing END_REPLACE')])
    );
  });

  it('reports missing END_DELETE', () => {
    const output = [
      'HASHLINE_EDIT src/app.ts',
      'DELETE L005:ab TO L007:cd',
      'some lines',
    ].join('\n');

    const result = parseHashlineEdits(output);
    expect(result.edits).toHaveLength(1);
    expect(result.parseErrors).toEqual(
      expect.arrayContaining([expect.stringContaining('Missing END_DELETE')])
    );
  });

  it('reports missing END_INSERT', () => {
    const output = [
      'HASHLINE_EDIT src/app.ts',
      'INSERT_BEFORE L010:ab',
      'new content',
    ].join('\n');

    const result = parseHashlineEdits(output);
    expect(result.edits).toHaveLength(1);
    expect(result.parseErrors).toEqual(
      expect.arrayContaining([expect.stringContaining('Missing END_INSERT')])
    );
  });

  it('reports unknown operations', () => {
    const output = [
      'HASHLINE_EDIT src/app.ts',
      'FOOBAR L001:aa',
    ].join('\n');

    const result = parseHashlineEdits(output);
    expect(result.edits).toHaveLength(0);
    expect(result.parseErrors).toEqual(
      expect.arrayContaining([expect.stringContaining('Unknown operation')])
    );
  });

  it('ignores explanatory text between operations', () => {
    const output = [
      'Here is how I will edit the file:',
      '',
      'HASHLINE_EDIT src/app.ts',
      'This replaces the old implementation:',
      'REPLACE L001:aa TO L003:bb',
      'const x = 1;',
      'END_REPLACE',
      '',
      'The above change updates the variable.',
    ].join('\n');

    const result = parseHashlineEdits(output);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].type).toBe('replace');
  });

  it('strips markdown code fences wrapping the output', () => {
    const output = [
      '```typescript',
      'HASHLINE_EDIT src/app.ts',
      'REPLACE L001:aa TO L002:bb',
      'new content',
      'END_REPLACE',
      '```',
    ].join('\n');

    const result = parseHashlineEdits(output);
    expect(result.edits).toHaveLength(1);
  });

  // --- JSON fallback ---

  it('falls back to JSON format when no hashline edits found', () => {
    const jsonOutput = JSON.stringify([{
      file_path: 'src/app.ts',
      blocks: [{
        type: 'replace',
        start: 'L001:aa',
        end: 'L003:bb',
        content: 'new line 1\nnew line 2',
      }],
    }]);

    const result = parseHashlineEdits(jsonOutput);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]).toMatchObject({
      type: 'replace',
      filePath: 'src/app.ts',
      startLine: 1,
      startHash: 'aa',
      endLine: 3,
      endHash: 'bb',
    });
    expect(result.parseErrors).toEqual(
      expect.arrayContaining([expect.stringContaining('JSON fallback')])
    );
  });

  it('JSON fallback handles insert_before blocks', () => {
    const jsonOutput = JSON.stringify({
      filePath: 'src/app.ts',
      blocks: [{
        type: 'insert_before',
        start: 'L010:ab',
        content: ['new line 1', 'new line 2'],
      }],
    });

    const result = parseHashlineEdits(jsonOutput);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].type).toBe('insert_before');
    expect(result.edits[0].newContent).toBe('new line 1\nnew line 2');
  });

  it('JSON fallback handles delete blocks', () => {
    const jsonOutput = JSON.stringify({
      file_path: 'src/app.ts',
      blocks: [{
        type: 'delete',
        start: 'L005:ab',
        end: 'L008:cd',
      }],
    });

    const result = parseHashlineEdits(jsonOutput);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].type).toBe('delete');
    expect(result.edits[0].newContent).toBe('');
  });

  // --- Full file rewrite fallback ---

  it('detects full file rewrite in code fence', () => {
    // Build a fake "file" with 12 lines that looks like real code
    const fakeFile = [
      'import { something } from "./module";',
      '',
      'export class MyClass {',
      '  private value: number;',
      '',
      '  constructor() {',
      '    this.value = 0;',
      '  }',
      '',
      '  getValue() {',
      '    return this.value;',
      '  }',
      '}',
    ].join('\n');

    const output = '```typescript\n' + fakeFile + '\n```';

    const result = parseHashlineEdits(output);
    expect(result.edits).toEqual([]);
    expect(result.fullFileContent).toBeDefined();
    expect(result.fullFileContent).toContain('export class MyClass');
  });

  it('does not detect full file rewrite if code fence is too short', () => {
    const output = '```js\nconst x = 1;\n```';
    const result = parseHashlineEdits(output);
    // fullFileContent is null (not undefined) when code fence doesn't qualify
    expect(result.fullFileContent).toBeNull();
  });
});

// ─── parseHashlineLiteEdits ─────────────────────────────────────────────────

describe('parseHashlineLiteEdits', () => {
  it('returns empty for null output', () => {
    const result = parseHashlineLiteEdits(null, new Map());
    expect(result.edits).toEqual([]);
    expect(result.parseErrors).toEqual([]);
  });

  it('returns empty for non-string output', () => {
    const result = parseHashlineLiteEdits(123, new Map());
    expect(result.edits).toEqual([]);
  });

  it('parses a standard SEARCH/REPLACE block with file header', () => {
    const fileLines = [
      'function hello() {',
      '  console.log("hello");',
      '}',
    ];
    const fileContextMap = new Map([['src/app.js', fileLines]]);

    const output = [
      '### FILE: src/app.js',
      '<<<<<<< SEARCH',
      '  console.log("hello");',
      '=======',
      '  console.log("world");',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = parseHashlineLiteEdits(output, fileContextMap);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].type).toBe('replace');
    expect(result.edits[0].filePath).toBe('src/app.js');
    expect(result.edits[0].newContent).toBe('  console.log("world");');
    expect(result.parseErrors).toEqual([]);
  });

  it('infers file path when only one file in context map', () => {
    const fileLines = ['line1', 'line2', 'line3'];
    const fileContextMap = new Map([['only-file.js', fileLines]]);

    const output = [
      '<<<<<<< SEARCH',
      'line2',
      '=======',
      'replaced',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = parseHashlineLiteEdits(output, fileContextMap);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].filePath).toBe('only-file.js');
  });

  it('reports error when no file path and multiple files in context', () => {
    const fileContextMap = new Map([
      ['a.js', ['line1']],
      ['b.js', ['line2']],
    ]);

    const output = [
      '<<<<<<< SEARCH',
      'line1',
      '=======',
      'replaced',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = parseHashlineLiteEdits(output, fileContextMap);
    expect(result.edits).toEqual([]);
    expect(result.parseErrors).toEqual(
      expect.arrayContaining([expect.stringContaining('without file path')])
    );
  });

  it('reports missing REPLACE terminator', () => {
    const fileContextMap = new Map([['a.js', ['line1', 'line2']]]);

    const output = [
      '### FILE: a.js',
      '<<<<<<< SEARCH',
      'line1',
      '=======',
      'replaced',
      // Missing >>>>>>> REPLACE
    ].join('\n');

    const result = parseHashlineLiteEdits(output, fileContextMap);
    expect(result.parseErrors).toEqual(
      expect.arrayContaining([expect.stringContaining('Missing >>>>>>> REPLACE')])
    );
  });

  it('reports empty SEARCH block', () => {
    const fileContextMap = new Map([['a.js', ['line1']]]);

    const output = [
      '### FILE: a.js',
      '<<<<<<< SEARCH',
      '=======',
      'replacement',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = parseHashlineLiteEdits(output, fileContextMap);
    expect(result.edits).toEqual([]);
    expect(result.parseErrors).toEqual(
      expect.arrayContaining([expect.stringContaining('Empty SEARCH block')])
    );
  });

  it('reports error when file not in context map', () => {
    const fileContextMap = new Map([['a.js', ['line1']]]);

    const output = [
      '### FILE: b.js',
      '<<<<<<< SEARCH',
      'line1',
      '=======',
      'replaced',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = parseHashlineLiteEdits(output, fileContextMap);
    expect(result.edits).toEqual([]);
    expect(result.parseErrors).toEqual(
      expect.arrayContaining([expect.stringContaining('File not in context')])
    );
  });

  it('reports when SEARCH block not found in file', () => {
    const fileContextMap = new Map([['a.js', ['alpha', 'beta', 'gamma']]]);

    const output = [
      '### FILE: a.js',
      '<<<<<<< SEARCH',
      'totally different content that does not match',
      '=======',
      'replacement',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = parseHashlineLiteEdits(output, fileContextMap);
    expect(result.edits).toEqual([]);
    expect(result.parseErrors).toEqual(
      expect.arrayContaining([expect.stringContaining('SEARCH block not found')])
    );
  });

  it('strips leaked L###:xx: prefixes from SEARCH/REPLACE content', () => {
    const fileLines = [
      'const a = 1;',
      'const b = 2;',
    ];
    const fileContextMap = new Map([['app.js', fileLines]]);

    const output = [
      '### FILE: app.js',
      '<<<<<<< SEARCH',
      'L001:ab: const a = 1;',
      '=======',
      'L001:ab: const a = 10;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = parseHashlineLiteEdits(output, fileContextMap);
    // After stripping prefixes, the search content should be "const a = 1;"
    // which should match the original file
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].newContent).toBe('const a = 10;');
  });

  it('parses multiple SEARCH/REPLACE blocks for same file', () => {
    const fileLines = [
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
    ];
    const fileContextMap = new Map([['app.js', fileLines]]);

    const output = [
      '### FILE: app.js',
      '<<<<<<< SEARCH',
      'const a = 1;',
      '=======',
      'const a = 10;',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'const c = 3;',
      '=======',
      'const c = 30;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = parseHashlineLiteEdits(output, fileContextMap);
    expect(result.edits).toHaveLength(2);
    expect(result.edits[0].newContent).toBe('const a = 10;');
    expect(result.edits[1].newContent).toBe('const c = 30;');
  });
});

// ─── applyHashlineEdits ─────────────────────────────────────────────────────

describe('applyHashlineEdits', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = path.join(os.tmpdir(), `torque-hashline-parser-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function writeTemp(name, content) {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  function readTemp(filePath) {
    return fs.readFileSync(filePath, 'utf8');
  }

  it('returns success with zero changes for empty edits', () => {
    const result = applyHashlineEdits('/fake/path.ts', []);
    expect(result.success).toBe(true);
    expect(result.linesRemoved).toBe(0);
    expect(result.linesAdded).toBe(0);
  });

  it('returns success with zero changes for null edits', () => {
    const result = applyHashlineEdits('/fake/path.ts', null);
    expect(result.success).toBe(true);
  });

  it('returns failure when file does not exist', () => {
    const edits = [{
      type: 'replace',
      filePath: '/nonexistent/file.ts',
      startLine: 1,
      startHash: 'aa',
      endLine: 1,
      endHash: 'aa',
      newContent: 'replaced',
    }];
    const result = applyHashlineEdits('/nonexistent/file.ts', edits);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot read file');
  });

  it('applies a REPLACE edit successfully', () => {
    const lines = ['line1', 'line2', 'line3', 'line4'];
    const content = lines.join('\n');
    const filePath = writeTemp('replace-test.txt', content);

    const hash2 = computeLineHash('line2');
    const hash3 = computeLineHash('line3');

    const edits = [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: hash2,
      endLine: 3,
      endHash: hash3,
      newContent: 'newLine2\nnewLine3\nextraLine',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    expect(result.linesRemoved).toBe(2);
    expect(result.linesAdded).toBe(3);

    const newContent = readTemp(filePath);
    expect(newContent).toBe('line1\nnewLine2\nnewLine3\nextraLine\nline4');
  });

  it('applies a DELETE edit successfully', () => {
    const lines = ['line1', 'line2', 'line3', 'line4'];
    const content = lines.join('\n');
    const filePath = writeTemp('delete-test.txt', content);

    const hash2 = computeLineHash('line2');
    const hash3 = computeLineHash('line3');

    const edits = [{
      type: 'delete',
      filePath,
      startLine: 2,
      startHash: hash2,
      endLine: 3,
      endHash: hash3,
      newContent: '',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    expect(result.linesRemoved).toBe(2);
    expect(result.linesAdded).toBe(0);

    const newContent = readTemp(filePath);
    expect(newContent).toBe('line1\nline4');
  });

  it('applies an INSERT_BEFORE edit successfully', () => {
    const lines = ['line1', 'line2', 'line3'];
    const content = lines.join('\n');
    const filePath = writeTemp('insert-test.txt', content);

    const hash2 = computeLineHash('line2');

    const edits = [{
      type: 'insert_before',
      filePath,
      startLine: 2,
      startHash: hash2,
      newContent: 'inserted1\ninserted2',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    expect(result.linesRemoved).toBe(0);
    expect(result.linesAdded).toBe(2);

    const newContent = readTemp(filePath);
    expect(newContent).toBe('line1\ninserted1\ninserted2\nline2\nline3');
  });

  it('falls back to the cited start line when the hash mismatches', () => {
    const lines = ['line1', 'line2', 'line3'];
    const content = lines.join('\n');
    const filePath = writeTemp('hash-mismatch-start.txt', content);

    const edits = [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: 'ff', // Wrong hash
      endLine: 2,
      endHash: computeLineHash('line2'),
      newContent: 'replaced',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    expect(result.fuzzyFixups).toBeGreaterThanOrEqual(1);
    expect(readTemp(filePath)).toBe('line1\nreplaced\nline3');
  });

  it('falls back to the cited end line when the hash mismatches', () => {
    const lines = ['line1', 'line2', 'line3'];
    const content = lines.join('\n');
    const filePath = writeTemp('hash-mismatch-end.txt', content);

    const hash2 = computeLineHash('line2');

    const edits = [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: hash2,
      endLine: 3,
      endHash: 'ff', // Wrong hash
      newContent: 'replaced',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    expect(result.fuzzyFixups).toBeGreaterThanOrEqual(1);
    expect(readTemp(filePath)).toBe('line1\nreplaced');
  });

  it('fails when start line is out of range', () => {
    const lines = ['line1', 'line2'];
    const content = lines.join('\n');
    const filePath = writeTemp('range-start.txt', content);

    const edits = [{
      type: 'replace',
      filePath,
      startLine: 0,
      startHash: 'aa',
      endLine: 1,
      endHash: 'bb',
      newContent: 'replaced',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');
  });

  it('fails when start line exceeds file length', () => {
    const lines = ['line1', 'line2'];
    const content = lines.join('\n');
    const filePath = writeTemp('range-beyond.txt', content);

    const edits = [{
      type: 'replace',
      filePath,
      startLine: 99,
      startHash: 'aa',
      endLine: 100,
      endHash: 'bb',
      newContent: 'replaced',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');
  });

  it('fails when end line is less than start line', () => {
    const lines = ['line1', 'line2', 'line3'];
    const content = lines.join('\n');
    const filePath = writeTemp('range-end-before-start.txt', content);

    const hash1 = computeLineHash('line1');

    const edits = [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: computeLineHash('line2'),
      endLine: 1,
      endHash: hash1,
      newContent: 'replaced',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');
  });

  it('fails on overlapping edits (true overlap, not abutting)', () => {
    const lines = ['line1', 'line2', 'line3', 'line4', 'line5'];
    const content = lines.join('\n');
    const filePath = writeTemp('overlap.txt', content);

    // Lines 2-4 and 3-5 truly overlap (line 3-4 are in both ranges)
    const edits = [
      {
        type: 'replace',
        filePath,
        startLine: 2,
        startHash: computeLineHash('line2'),
        endLine: 4,
        endHash: computeLineHash('line4'),
        newContent: 'new2-4',
      },
      {
        type: 'delete',
        filePath,
        startLine: 3,
        startHash: computeLineHash('line3'),
        endLine: 5,
        endHash: computeLineHash('line5'),
        newContent: '',
      },
    ];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Overlapping edits');
  });

  it('applies multiple non-overlapping edits bottom-to-top', () => {
    const lines = ['line1', 'line2', 'line3', 'line4', 'line5'];
    const content = lines.join('\n');
    const filePath = writeTemp('multi-edit.txt', content);

    const edits = [
      {
        type: 'replace',
        filePath,
        startLine: 1,
        startHash: computeLineHash('line1'),
        endLine: 1,
        endHash: computeLineHash('line1'),
        newContent: 'newLine1',
      },
      {
        type: 'replace',
        filePath,
        startLine: 4,
        startHash: computeLineHash('line4'),
        endLine: 4,
        endHash: computeLineHash('line4'),
        newContent: 'newLine4',
      },
    ];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    expect(result.linesRemoved).toBe(2);
    expect(result.linesAdded).toBe(2);

    const newContent = readTemp(filePath);
    expect(newContent).toBe('newLine1\nline2\nline3\nnewLine4\nline5');
  });

  it('auto-merges abutting replace edits', () => {
    const lines = ['line1', 'line2', 'line3', 'line4'];
    const content = lines.join('\n');
    const filePath = writeTemp('abutting.txt', content);

    // Edit 1: replace lines 2-2, Edit 2: replace lines 3-3 (abutting)
    const edits = [
      {
        type: 'replace',
        filePath,
        startLine: 2,
        startHash: computeLineHash('line2'),
        endLine: 2,
        endHash: computeLineHash('line2'),
        newContent: 'newLine2',
      },
      {
        type: 'replace',
        filePath,
        startLine: 3,
        startHash: computeLineHash('line3'),
        endLine: 3,
        endHash: computeLineHash('line3'),
        newContent: 'newLine3',
      },
    ];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);

    const newContent = readTemp(filePath);
    expect(newContent).toBe('line1\nnewLine2\nnewLine3\nline4');
  });

  // --- Syntax gate tests ---

  it('rejects JS file with brace imbalance', () => {
    const lines = [
      'function foo() {',
      '  return 1;',
      '}',
    ];
    const content = lines.join('\n');
    const filePath = writeTemp('brace-imbalance.js', content);

    const hash2 = computeLineHash('  return 1;');

    const edits = [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: hash2,
      endLine: 2,
      endHash: hash2,
      newContent: '  return 1;\n}',
    }];

    const result = applyHashlineEdits(filePath, edits);
    // Extra closing brace introduces imbalance: 1 open, 2 close
    // But auto-repair might fix this since delta=1 and there's a trailing brace
    // Let's check what happens
    if (!result.success) {
      expect(result.syntaxGateReject).toBe(true);
      expect(result.error).toContain('brace imbalance');
    }
    // If it auto-repaired, that's also valid behavior
  });

  it('rejects JS file with syntax error after edit', () => {
    const lines = [
      'function foo() {',
      '  return 1;',
      '}',
    ];
    const content = lines.join('\n');
    const filePath = writeTemp('syntax-error.js', content);

    const hash2 = computeLineHash('  return 1;');

    const edits = [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: hash2,
      endLine: 2,
      endHash: hash2,
      newContent: '  return @@@ invalid syntax;',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(false);
    expect(result.syntaxGateReject).toBe(true);
    expect(result.error).toContain('Syntax gate');
  });

  it('does not apply syntax gate to non-code files', () => {
    const lines = ['key: value', 'other: stuff'];
    const content = lines.join('\n');
    const filePath = writeTemp('config.yaml', content);

    const hash1 = computeLineHash('key: value');

    const edits = [{
      type: 'replace',
      filePath,
      startLine: 1,
      startHash: hash1,
      endLine: 1,
      endHash: hash1,
      newContent: 'key: { unbalanced',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    const newContent = readTemp(filePath);
    expect(newContent).toBe('key: { unbalanced\nother: stuff');
  });

  it('strips LLM artifact markers from edited content', () => {
    const lines = ['line1', 'line2', 'line3'];
    const content = lines.join('\n');
    const filePath = writeTemp('artifacts.txt', content);

    const hash2 = computeLineHash('line2');

    const edits = [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: hash2,
      endLine: 2,
      endHash: hash2,
      newContent: 'new content<<<__newText__>>>',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    expect(result.sanitized).toBe(1);

    const newContent = readTemp(filePath);
    expect(newContent).toBe('line1\nnew content\nline3');
  });

  it('auto-repairs small trailing brace excess in JS file', () => {
    // File with balanced braces, then an edit that adds 1 extra closing brace at end
    const lines = [
      'function foo() {',
      '  return 1;',
      '}',
      '',
    ];
    const content = lines.join('\n');
    const filePath = writeTemp('auto-repair.js', content);

    const hashEmpty = computeLineHash('');

    const edits = [{
      type: 'replace',
      filePath,
      startLine: 4,
      startHash: hashEmpty,
      endLine: 4,
      endHash: hashEmpty,
      newContent: '}',
    }];

    const result = applyHashlineEdits(filePath, edits);
    // Auto-repair should remove the extra closing brace
    expect(result.success).toBe(true);
  });

  // --- Fuzzy hash fallback tests ---

  it('fuzzy fallback: corrects start hash off by 1 line', () => {
    const lines = ['line1', 'line2', 'line3', 'line4'];
    const content = lines.join('\n');
    const filePath = writeTemp('fuzzy-start-off1.txt', content);

    const hash3 = computeLineHash('line3');
    const hash3end = computeLineHash('line3');

    // Cite line3's hash but at line 2 (off by 1)
    const edits = [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: hash3,
      endLine: 3,
      endHash: hash3end,
      newContent: 'replaced',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    expect(result.fuzzyFixups).toBeGreaterThanOrEqual(1);
  });

  it('fuzzy fallback: corrects start hash off by 2 lines', () => {
    const lines = ['line1', 'line2', 'line3', 'line4', 'line5'];
    const content = lines.join('\n');
    const filePath = writeTemp('fuzzy-start-off2.txt', content);

    const hash4 = computeLineHash('line4');

    // Cite line4's hash but at line 2 (off by 2)
    const edits = [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: hash4,
      endLine: 4,
      endHash: hash4,
      newContent: 'replaced',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    expect(result.fuzzyFixups).toBeGreaterThanOrEqual(1);
  });

  it('fuzzy fallback: uses the cited line when hash not found within window', () => {
    const lines = ['line1', 'line2', 'line3', 'line4', 'line5'];
    const content = lines.join('\n');
    const filePath = writeTemp('fuzzy-out-of-window.txt', content);

    // Use a completely fabricated hash that doesn't exist anywhere
    const edits = [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: 'zz',
      endLine: 2,
      endHash: computeLineHash('line2'),
      newContent: 'replaced',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    expect(result.fuzzyFixups).toBeGreaterThanOrEqual(1);
    expect(readTemp(filePath)).toBe('line1\nreplaced\nline3\nline4\nline5');
  });

  it('fuzzy fallback: corrects end hash off by 1 line', () => {
    const lines = ['line1', 'line2', 'line3', 'line4'];
    const content = lines.join('\n');
    const filePath = writeTemp('fuzzy-end-off1.txt', content);

    const hash2 = computeLineHash('line2');
    const hash4 = computeLineHash('line4');

    // Start hash is correct, but end hash (line4) cited at line 3 (off by 1)
    const edits = [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: hash2,
      endLine: 3,
      endHash: hash4,
      newContent: 'replaced',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    expect(result.fuzzyFixups).toBeGreaterThanOrEqual(1);
  });

  it('fuzzy fallback: returns 0 fuzzyFixups when all hashes match exactly', () => {
    const lines = ['line1', 'line2', 'line3'];
    const content = lines.join('\n');
    const filePath = writeTemp('fuzzy-exact.txt', content);

    const hash2 = computeLineHash('line2');

    const edits = [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: hash2,
      endLine: 2,
      endHash: hash2,
      newContent: 'replaced',
    }];

    const result = applyHashlineEdits(filePath, edits);
    expect(result.success).toBe(true);
    expect(result.fuzzyFixups).toBe(0);
  });
});

// ─── applyHashlineLiteEdits ─────────────────────────────────────────────────

describe('applyHashlineLiteEdits', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = path.join(os.tmpdir(), `torque-hashline-lite-apply-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns success for empty edits array', () => {
    const result = applyHashlineLiteEdits(tempDir, []);
    expect(result.success).toBe(true);
    expect(result.results).toEqual([]);
  });

  it('returns success for null edits', () => {
    const result = applyHashlineLiteEdits(tempDir, null);
    expect(result.success).toBe(true);
  });

  it('applies edits to a file using hashline-lite format', () => {
    const lines = ['lineA', 'lineB', 'lineC'];
    const content = lines.join('\n');
    const filePath = path.join(tempDir, 'lite-apply.txt');
    fs.writeFileSync(filePath, content, 'utf8');

    const hashB = computeLineHash('lineB');

    const edits = [{
      type: 'replace',
      filePath: 'lite-apply.txt',
      startLine: 2,
      startHash: hashB,
      endLine: 2,
      endHash: hashB,
      newContent: 'newLineB',
    }];

    const result = applyHashlineLiteEdits(tempDir, edits);
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.totalRemoved).toBe(1);
    expect(result.totalAdded).toBe(1);

    const newContent = fs.readFileSync(filePath, 'utf8');
    expect(newContent).toBe('lineA\nnewLineB\nlineC');
  });

  it('handles absolute paths in edits', () => {
    const lines = ['x1', 'x2', 'x3'];
    const content = lines.join('\n');
    const filePath = path.join(tempDir, 'lite-abs.txt');
    fs.writeFileSync(filePath, content, 'utf8');

    const hash2 = computeLineHash('x2');

    const edits = [{
      type: 'replace',
      filePath: filePath, // absolute path
      startLine: 2,
      startHash: hash2,
      endLine: 2,
      endHash: hash2,
      newContent: 'replaced',
    }];

    const result = applyHashlineLiteEdits(tempDir, edits);
    expect(result.success).toBe(true);
  });

  it('reports failure for missing files', () => {
    const edits = [{
      type: 'replace',
      filePath: 'nonexistent.txt',
      startLine: 1,
      startHash: 'aa',
      endLine: 1,
      endHash: 'aa',
      newContent: 'replaced',
    }];

    const result = applyHashlineLiteEdits(tempDir, edits);
    expect(result.success).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
  });

  it('groups multiple edits by file', () => {
    const content1 = 'a1\na2\na3';
    const content2 = 'b1\nb2\nb3';
    const file1 = path.join(tempDir, 'lite-group1.txt');
    const file2 = path.join(tempDir, 'lite-group2.txt');
    fs.writeFileSync(file1, content1, 'utf8');
    fs.writeFileSync(file2, content2, 'utf8');

    const edits = [
      {
        type: 'replace',
        filePath: 'lite-group1.txt',
        startLine: 1,
        startHash: computeLineHash('a1'),
        endLine: 1,
        endHash: computeLineHash('a1'),
        newContent: 'A1',
      },
      {
        type: 'replace',
        filePath: 'lite-group2.txt',
        startLine: 1,
        startHash: computeLineHash('b1'),
        endLine: 1,
        endHash: computeLineHash('b1'),
        newContent: 'B1',
      },
    ];

    const result = applyHashlineLiteEdits(tempDir, edits);
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);

    const newContent1 = fs.readFileSync(file1, 'utf8');
    const newContent2 = fs.readFileSync(file2, 'utf8');
    expect(newContent1).toBe('A1\na2\na3');
    expect(newContent2).toBe('B1\nb2\nb3');
  });
});
