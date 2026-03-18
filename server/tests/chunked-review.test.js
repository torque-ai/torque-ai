const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  estimateTokens,
  extractJSFunctions,
  extractFunctions,
  generateReviewChunks,
  generateChunkTasks,
  generateAggregationTask
} = require('../chunked-review');

const buildTempDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'torque-chunked-review-tests-'));

let tmpDir;

function writeTempFile(content, fileName = 'sample.js') {
  const filePath = path.join(tmpDir, fileName);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('chunked-review module', () => {
  beforeEach(() => {
    tmpDir = buildTempDir();
  });

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  describe('estimateTokens', () => {
    it('returns 0 for an empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('returns 0 for null-like values', () => {
      expect(estimateTokens(null)).toBe(0);
      expect(estimateTokens(undefined)).toBe(0);
    });

    it('estimates exact token boundaries for short multiples', () => {
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('abcdefgh')).toBe(2);
    });

    it('uses ceiling for short non-multiple lengths', () => {
      expect(estimateTokens('abcde')).toBe(2);
      expect(estimateTokens('abcdefg')).toBe(2);
    });

    it('stays accurate on a short sentence', () => {
      expect(estimateTokens('function() { return 1; }')).toBe(6);
    });

    it('estimates large payloads consistently', () => {
      const longText = 'a'.repeat(12345);
      expect(estimateTokens(longText)).toBe(Math.ceil(12345 / 4));
    });
  });

  describe('extractJSFunctions', () => {
    it('extracts function declarations with line ranges', () => {
      const content = [
        'function add(a, b) {',
        '  return a + b;',
        '}',
        ''
      ].join('\n');
      const functions = extractJSFunctions(content);

      expect(functions).toHaveLength(1);
      expect(functions[0]).toEqual({
        name: 'add',
        startLine: 1,
        endLine: 3,
        type: 'function'
      });
    });

    it('extracts async function declarations', () => {
      const content = [
        'async function load() {',
        '  return true;',
        '}'
      ].join('\n');
      const functions = extractJSFunctions(content);

      expect(functions).toHaveLength(1);
      expect(functions[0].name).toBe('load');
      expect(functions[0].type).toBe('function');
    });

    it('extracts arrow functions with parameter list', () => {
      const content = [
        'const compute = (a, b) => {',
        '  return a + b;',
        '};'
      ].join('\n');
      const functions = extractJSFunctions(content);

      expect(functions).toHaveLength(1);
      expect(functions[0]).toMatchObject({
        name: 'compute',
        startLine: 1,
        type: 'function'
      });
      expect(functions[0].endLine).toBe(3);
    });

    it('extracts single-parameter arrow functions', () => {
      const content = [
        'const double = value => value * 2;',
      ].join('\n');
      const functions = extractJSFunctions(content);

      expect(functions).toHaveLength(1);
      expect(functions[0].name).toBe('double');
      expect(functions[0].type).toBe('function');
    });

    it('extracts class declarations and method-style signatures', () => {
      const content = [
        'class Parser {',
        '  parse(input) {',
        '    return input;',
        '  }',
        '}',
        '',
        'format(value) {',
        '  return `${value}`;',
        '}'
      ].join('\n');
      const functions = extractJSFunctions(content);

      const names = functions.map((f) => f.name);
      expect(names).toEqual(['Parser', 'format']);
      expect(functions[0].type).toBe('class');
      expect(functions[1].type).toBe('function');
      expect(functions[1].startLine).toBe(7);
    });

    it('ignores braces inside string literals when tracking JS function depth', () => {
      const content = [
        'function parseTemplate() {',
        '  const template = "{";',
        '  return template;',
        '}',
        '',
        'function second() {',
        '  return 2;',
        '}'
      ].join('\n');
      const functions = extractJSFunctions(content);

      expect(functions.map((fn) => fn.name)).toEqual(['parseTemplate', 'second']);
      expect(functions[0].endLine).toBe(4);
      expect(functions[1].startLine).toBe(6);
      expect(functions[1].endLine).toBe(8);
    });
  });

  describe('generateReviewChunks: language and fallback behavior', () => {
    it('returns a single chunk for short files under the token limit', () => {
      const filePath = writeTempFile('function ok() { return 42; }', 'short.js');
      const result = generateReviewChunks(filePath, 32000);

      expect(result.needsChunking).toBe(false);
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]).toMatchObject({
        startLine: 1,
        endLine: 1,
        tokens: result.totalTokens,
        description: 'Full file'
      });
    });

    it('uses function-based chunking when parsable JS functions stay within limits', () => {
      const makeFunction = (index) => [
        `function fn${index}() {`,
        `  const payload = '${'x'.repeat(120)}';`,
        '  return payload;',
        '}',
        ''
      ].join('\n');

      const content = Array.from({ length: 25 }, (_, i) => makeFunction(i)).join('');
      const filePath = writeTempFile(content, 'function-chunks.js');
      const result = generateReviewChunks(filePath, 2400);

      expect(result.needsChunking).toBe(true);
      expect(result.strategy).toBe('function-based');
      expect(result.chunks.length).toBeGreaterThan(1);
      expect(result.chunks.every((chunk) => Array.isArray(chunk.functions))).toBe(true);
      expect(result.chunks.some((chunk) => chunk.functions.length > 0)).toBe(true);
    });

    it('switches to hybrid splitting when a single function exceeds the effective limit', () => {
      const body = Array.from({ length: 220 }, () => '  return 1;').join('\n');
      const content = [
        'function oversized() {',
        body,
        '}',
      ].join('\n');
      const filePath = writeTempFile(content, 'hybrid.js');
      const result = generateReviewChunks(filePath, 2400);

      expect(result.needsChunking).toBe(true);
      expect(result.strategy).toBe('hybrid');
      expect(result.chunks.length).toBeGreaterThan(1);
      expect(result.chunks.some((chunk) => /large function split/.test(chunk.description))).toBe(true);
      expect(result.chunks.some((chunk) => chunk.functions && chunk.functions.length)).toBe(false);
    });

    it('falls back to line-based chunks when JS function extraction returns no boundaries', () => {
      const noFuncs = Array.from({ length: 500 }, () => 'const value = 1;').join('\n');
      const filePath = writeTempFile(noFuncs, 'plain.txt');
      const result = generateReviewChunks(filePath, 2400);

      expect(result.strategy).toBe('line-based');
      expect(result.chunks.length).toBeGreaterThan(1);
      expect(result.chunks.every((chunk) => chunk.startLine >= 1)).toBe(true);
      expect(result.chunks.some((chunk) => chunk.description.startsWith('Lines'))).toBe(true);
      expect(result.chunks.every((chunk) => !chunk.functions)).toBe(true);
    });

    it('preserves overlap between adjacent line-based chunks when token limit is exceeded', () => {
      const noFuncs = Array.from({ length: 500 }, (_, i) => `const value = ${i};`).join('\n');
      const filePath = writeTempFile(noFuncs, 'overlap.js');
      const result = generateReviewChunks(filePath, 2400);

      expect(result.strategy).toBe('line-based');
      expect(result.chunks.length).toBeGreaterThan(1);

      for (let i = 1; i < result.chunks.length; i++) {
        const prev = result.chunks[i - 1];
        const current = result.chunks[i];
        expect(current.startLine).toBeLessThanOrEqual(prev.endLine);
      }
    });

    it('handles empty files without crashing and returns a full-file chunk', () => {
      const filePath = writeTempFile('', 'empty.js');
      const result = generateReviewChunks(filePath, 32000);

      expect(result.needsChunking).toBe(false);
      expect(result.totalTokens).toBe(0);
      expect(result.totalLines).toBe(1);
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]).toMatchObject({
        startLine: 1,
        endLine: 1,
        tokens: 0,
        description: 'Full file'
      });
    });
  });

  describe('extractFunctions multi-language dispatch', () => {
    it('extracts Python boundaries for .py files', () => {
      const content = [
        'class Loader:',
        '    def load(self):',
        '        return True',
        '',
        'def parse_file(path):',
        '    return path',
        ''
      ].join('\n');

      const funcs = extractFunctions(content, '/tmp/scrape.py');

      expect(funcs).toHaveLength(2);
      expect(funcs.map((f) => f.name)).toEqual(['load', 'parse_file']);
      expect(funcs[0].type).toBe('function');
      expect(funcs[1].type).toBe('function');
    });

    it('extracts C# boundaries for .cs files', () => {
      const content = [
        'public class Parser {',
        '  public string Format(string input) {',
        '    return input;',
        '  }',
        '}'
      ].join('\n');

      const funcs = extractFunctions(content, '/tmp/parser.cs');

      expect(funcs.length).toBeGreaterThanOrEqual(1);
      expect(funcs.map((f) => f.name)).toContain('Parser');
      expect(funcs.map((f) => f.type)).toContain('class');
    });

    it('returns no boundaries for unsupported extensions', () => {
      const content = 'some text with no function-like structure at all';
      const funcs = extractFunctions(content, '/tmp/readme.md');

      expect(funcs).toEqual([]);
    });
  });

  describe('task generation helpers', () => {
    it('returns a base task with null chunk for non-chunked review info', () => {
      const filePath = writeTempFile('function ok() { return 1; }', 'single.js');
      const chunkInfo = generateReviewChunks(filePath, 32000);
      const tasks = generateChunkTasks(filePath, 'Review file.js for quality', chunkInfo);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].chunk).toBeNull();
    });

    it('creates numbered chunk tasks with line scoping for chunked review info', () => {
      const content = [
        'const data = [1,2,3];',
        ...Array.from({ length: 600 }, (_, i) => `const v${i} = ${i};`)
      ].join('\n');
      const filePath = writeTempFile(content, 'tasks.js');
      const chunkInfo = generateReviewChunks(filePath, 2400);
      const tasks = generateChunkTasks(filePath, 'Review tasks.js for performance', chunkInfo);

      expect(tasks.length).toBeGreaterThan(1);
      expect(tasks[0].task).toContain('Part 1/');
      expect(tasks[0].task).toContain('IMPORTANT: Review ONLY lines');
      expect(tasks[0].chunk).toMatchObject({
        number: 1,
        total: tasks.length,
      });
    });

    it('creates an aggregation task with chunk IDs and chunk count', () => {
      const task = generateAggregationTask('/tmp/project.js', 3, ['a1', 'a2', 'a3']);

      expect(task).toEqual(
        expect.objectContaining({
          isAggregation: true,
          chunkTaskIds: ['a1', 'a2', 'a3']
        })
      );
      expect(task.task).toContain('Aggregate and summarize the 3 chunk reviews for project.js');
      expect(task.task).toContain('Chunk task IDs to aggregate: a1, a2, a3');
    });
  });
});
