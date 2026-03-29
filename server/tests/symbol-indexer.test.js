'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const indexer = require('../utils/symbol-indexer');
const { hashContent, walkProjectFiles, LANGUAGE_MAP } = indexer;

describe('symbol-indexer', () => {
  describe('hashContent', () => {
    it('returns consistent hash for same content', () => {
      const h1 = hashContent('hello world');
      const h2 = hashContent('hello world');
      expect(h1).toBe(h2);
      expect(h1.length).toBe(16);
    });

    it('returns different hash for different content', () => {
      expect(hashContent('hello')).not.toBe(hashContent('world'));
    });
  });

  describe('LANGUAGE_MAP', () => {
    it('maps common extensions', () => {
      expect(LANGUAGE_MAP['.js']).toBe('javascript');
      expect(LANGUAGE_MAP['.ts']).toBe('typescript');
      expect(LANGUAGE_MAP['.py']).toBe('python');
      expect(LANGUAGE_MAP['.rs']).toBe('rust');
      expect(LANGUAGE_MAP['.go']).toBe('go');
    });
  });

  describe('walkProjectFiles', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-idx-'));
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function main() {}');
      fs.writeFileSync(path.join(tmpDir, 'util.ts'), 'export function helper() {}');
      fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# Readme');
      fs.mkdirSync(path.join(tmpDir, 'src'));
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.py'), 'def main(): pass');
      fs.mkdirSync(path.join(tmpDir, 'node_modules'));
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep.js'), 'module.exports = 1');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('finds parseable files', () => {
      const files = walkProjectFiles(tmpDir);
      const names = files.map(f => path.basename(f.path)).sort();
      expect(names).toContain('app.js');
      expect(names).toContain('util.ts');
      expect(names).toContain('index.py');
    });

    it('skips node_modules', () => {
      const files = walkProjectFiles(tmpDir);
      const inNodeModules = files.filter(f => f.path.includes('node_modules'));
      expect(inNodeModules).toHaveLength(0);
    });

    it('skips non-parseable files', () => {
      const files = walkProjectFiles(tmpDir);
      const mdFiles = files.filter(f => f.path.endsWith('.md'));
      expect(mdFiles).toHaveLength(0);
    });
  });

  describe('init + DB', () => {
    let db;

    beforeEach(() => {
      db = new Database(':memory:');
      indexer.init(db);
    });

    afterEach(() => {
      db.close();
    });

    it('creates symbol_index table', () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_index'").get();
      expect(tables).toBeTruthy();
    });

    it('creates indexes', () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_symbol%'").all();
      expect(indexes.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('search and retrieval', () => {
    let db;
    let tmpDir;
    let workingDir;

    beforeEach(() => {
      db = new Database(':memory:');
      indexer.init(db);
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-idx-search-'));
      workingDir = tmpDir;
    });

    afterEach(() => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('searchSymbols finds by partial name match', async () => {
      const filePath = path.join(tmpDir, 'search.js');
      fs.writeFileSync(filePath, 'function findUser() {}\\nfunction findOrder() {}\\nconst parseData = () => {};\\n');
      const content = fs.readFileSync(filePath, 'utf8');
      await indexer.indexFile(filePath, content, workingDir);

      const symbols = indexer.searchSymbols('find', workingDir, {});
      const names = symbols.map(function(s) { return s.name; });
      expect(names).toContain('findUser');
      expect(names).toContain('findOrder');
    });

    it('searchSymbols filters by kind', async () => {
      const filePath = path.join(tmpDir, 'kind.ts');
      fs.writeFileSync(filePath, 'class UserService {}\\nfunction userServiceHelper() {}\\n');
      const content = fs.readFileSync(filePath, 'utf8');
      await indexer.indexFile(filePath, content, workingDir);

      const classes = indexer.searchSymbols('User', workingDir, { kind: 'class' });
      expect(classes.length).toBe(1);
      expect(classes[0].name).toBe('UserService');
    });

    it('searchSymbols exact match', async () => {
      const filePath = path.join(tmpDir, 'exact.js');
      fs.writeFileSync(filePath, 'function parseData() {}\\nfunction parseDataAdvanced() {}\\n');
      const content = fs.readFileSync(filePath, 'utf8');
      await indexer.indexFile(filePath, content, workingDir);

      const exact = indexer.searchSymbols('parseData', workingDir, { exact: true });
      expect(exact.length).toBe(1);
      expect(exact[0].name).toBe('parseData');
    });

    it('getSymbolSource reads correct lines from file', () => {
      const filePath = path.join(tmpDir, 'source.txt');
      fs.writeFileSync(filePath, 'line1\\nline2\\nline3\\nline4\\nline5\\n');
      const source = indexer.getSymbolSource(filePath, 2, 4);
      expect(source).toBe('line2\\nline3\\nline4');
    });

    it('getFileOutline returns symbols sorted by line number', async () => {
      const filePath = path.join(tmpDir, 'outline.js');
      fs.writeFileSync(filePath, 'function alpha() {}\\n\\nclass Zeta {}\\n\\nfunction beta() {}\\n');
      const content = fs.readFileSync(filePath, 'utf8');
      await indexer.indexFile(filePath, content, workingDir);

      const outline = indexer.getFileOutline(filePath, workingDir);
      expect(outline).toHaveLength(3);
      expect(outline.map(function(s) { return s.startLine; })).toEqual([1, 3, 5]);
      expect(outline).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'alpha',
          kind: 'function',
          startLine: 1,
          endLine: 1,
          exported: false,
        }),
      ]));
    });

    it('getSymbolsForFiles batch query returns symbols for multiple files', async () => {
      const fileOne = path.join(tmpDir, 'one.js');
      const fileTwo = path.join(tmpDir, 'two.js');
      fs.writeFileSync(fileOne, 'function one() {}\\n');
      fs.writeFileSync(fileTwo, 'function two() {}\\n');
      await indexer.indexFile(fileOne, fs.readFileSync(fileOne, 'utf8'), workingDir);
      await indexer.indexFile(fileTwo, fs.readFileSync(fileTwo, 'utf8'), workingDir);

      const symbols = indexer.getSymbolsForFiles([fileOne, fileTwo], workingDir);
      const names = symbols.map(function(s) { return s.name; });
      expect(names).toContain('one');
      expect(names).toContain('two');
      expect(names.length).toBe(2);
    });
  });
});
