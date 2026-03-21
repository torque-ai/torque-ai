'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const { hashContent, walkProjectFiles, LANGUAGE_MAP } = require('../utils/symbol-indexer');

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
      const indexer = require('../utils/symbol-indexer');
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
});
