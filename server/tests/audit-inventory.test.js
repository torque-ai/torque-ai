'use strict';

const os = require('node:os');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const {
  classifyTier,
  extractImportPaths,
  inventoryFiles,
} = require('../audit/inventory');

const writeLineFile = (filePath, lines) => {
  const content = Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
};

describe('audit inventory', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-inventory-'));

    const srcDir = path.join(tempDir, 'src');
    const nodeModulesDir = path.join(srcDir, 'node_modules');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(nodeModulesDir, { recursive: true });

    writeLineFile(path.join(srcDir, 'small.js'), 50);
    writeLineFile(path.join(srcDir, 'medium.js'), 600);
    writeLineFile(path.join(srcDir, 'large.js'), 1500);
    writeLineFile(path.join(nodeModulesDir, 'dep.js'), 10);
    fs.writeFileSync(path.join(srcDir, 'readme.md'), 'not source');

    const importsFile = [
      "const child = require('child_process');",
      "const local = require('./local-util');",
      "import { resolve } from 'path';",
      "import os from 'os';",
      "import './polyfill.js';",
      '',
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'imports.js'), importsFile, 'utf8');

    const duplicateImportsFile = [
      "const first = require('./fixture');",
      "import { join } from 'path';",
      '',
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'duplicates.test.js'), duplicateImportsFile, 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns FileEntry array with expected fields', async () => {
    const entries = await inventoryFiles(tempDir);
    const target = entries.find((entry) => entry.name === 'small.js');
    expect(target).toBeDefined();
    expect(target.relativePath).toBe('src/small.js');
    expect(target.ext).toBe('.js');
    expect(target.tier).toBe('small');
    expect(Array.isArray(target.importPaths)).toBe(true);
  });

  it('excludes node_modules content', async () => {
    const entries = await inventoryFiles(tempDir);
    expect(entries.some((entry) => entry.name === 'dep.js')).toBe(false);
  });

  it('excludes non-source extensions', async () => {
    const entries = await inventoryFiles(tempDir);
    expect(entries.some((entry) => entry.name === 'readme.md')).toBe(false);
  });

  it('classifies tiers at boundaries', () => {
    expect(classifyTier(50)).toBe('small');
    expect(classifyTier(399)).toBe('small');
    expect(classifyTier(400)).toBe('medium');
    expect(classifyTier(1199)).toBe('medium');
    expect(classifyTier(1200)).toBe('large');
  });

  it('assigns the expected tier to each file', async () => {
    const entries = await inventoryFiles(tempDir);
    const byName = new Map(entries.map((entry) => [entry.name, entry.tier]));
    expect(byName.get('small.js')).toBe('small');
    expect(byName.get('medium.js')).toBe('medium');
    expect(byName.get('large.js')).toBe('large');
  });

  it('reports byte size separately from line count', async () => {
    const content = [
      "const message = 'alpha beta gamma';",
      'const total = message.length;',
      'module.exports = total;',
    ].join('\n');
    fs.writeFileSync(path.join(tempDir, 'src', 'byte-size.js'), content, 'utf8');

    const entries = await inventoryFiles(tempDir, { sourceDirs: ['src'] });
    const target = entries.find((entry) => entry.name === 'byte-size.js');

    expect(target).toBeDefined();
    expect(target.size).toBe(Buffer.byteLength(content, 'utf8'));
    expect(target.lines).toBe(content.split('\n').length);
    expect(target.size).not.toBe(target.lines);
  });

  it('reads each source file once while extracting imports', async () => {
    const readFileSpy = vi.spyOn(fsPromises, 'readFile');

    try {
      const entries = await inventoryFiles(tempDir, { sourceDirs: ['src'] });
      const sourceReadCounts = new Map();

      for (const [filePath] of readFileSpy.mock.calls) {
        if (typeof filePath !== 'string' || !filePath.startsWith(tempDir)) {
          continue;
        }

        sourceReadCounts.set(filePath, (sourceReadCounts.get(filePath) || 0) + 1);
      }

      expect(sourceReadCounts.size).toBe(entries.length);
      for (const entry of entries) {
        expect(sourceReadCounts.get(entry.path)).toBe(1);
      }
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it('extractImportPaths finds require and import paths', () => {
    const content = [
      "const fs = require('fs');",
      "const local = require('./local');",
      "import path from 'path';",
      "import './setup';",
      '',
    ].join('\n');
    const paths = extractImportPaths(content);
    expect(paths).toContain('fs');
    expect(paths).toContain('./local');
    expect(paths).toContain('path');
    expect(paths).toContain('./setup');
    expect(paths).toHaveLength(4);
  });

  it('extracts importPaths for JS files', async () => {
    const entries = await inventoryFiles(tempDir);
    const importsFile = entries.find((entry) => entry.name === 'imports.js');
    expect(importsFile).toBeDefined();
    expect(importsFile.importPaths.length).toBeGreaterThanOrEqual(3);
  });

  it('supports ignorePatterns', async () => {
    const entriesWithIgnore = await inventoryFiles(tempDir, {
      ignorePatterns: ['*.test.js'],
    });
    expect(entriesWithIgnore.some((entry) => entry.name === 'duplicates.test.js')).toBe(false);
  });
});
