'use strict';

/**
 * agentic-tool-path-resolution.test.js — Bug #2 regression tests
 *
 * Verifies that all file-system tools (read_file, write_file, edit_file,
 * list_directory, search_files) correctly resolve relative paths against
 * the working directory, and that relative paths with ../ traversal that
 * escape the working directory are blocked.
 *
 * Bug: cerebras/google-ai agentic tasks submit relative paths like
 * "SpudgetBooks.Domain/Budgeting" which must resolve against workingDir.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createToolExecutor,
  resolveSafePath,
} = require('../providers/ollama-tools');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-resolution-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tempDirs = [];
});

// ---------------------------------------------------------------------------
// list_directory — relative path resolution
// ---------------------------------------------------------------------------

describe('list_directory — relative path resolution', () => {
  it('resolves a relative subdirectory path against workingDir', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'Domain', 'Budgeting'), { recursive: true });
    writeFile(dir, 'Domain/Budgeting/Budget.cs', 'class Budget {}');
    writeFile(dir, 'Domain/Budgeting/Entry.cs', 'class Entry {}');

    const { execute } = createToolExecutor(dir);
    const res = execute('list_directory', { path: 'Domain/Budgeting' });

    expect(res.error).toBeUndefined();
    expect(res.result).toContain('Budget.cs');
    expect(res.result).toContain('Entry.cs');
  });

  it('resolves a nested relative path like "SpudgetBooks.Domain/Budgeting"', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'SpudgetBooks.Domain', 'Budgeting'), { recursive: true });
    writeFile(dir, 'SpudgetBooks.Domain/Budgeting/Budget.cs', 'class Budget {}');

    const { execute } = createToolExecutor(dir);
    const res = execute('list_directory', { path: 'SpudgetBooks.Domain/Budgeting' });

    expect(res.error).toBeUndefined();
    expect(res.result).toContain('Budget.cs');
  });

  it('resolves "." to the working directory itself', () => {
    const dir = makeTempDir();
    writeFile(dir, 'readme.txt', 'hello');

    const { execute } = createToolExecutor(dir);
    const res = execute('list_directory', { path: '.' });

    expect(res.error).toBeUndefined();
    expect(res.result).toContain('readme.txt');
  });

  it('defaults to "." when path is omitted', () => {
    const dir = makeTempDir();
    writeFile(dir, 'file.txt', 'content');

    const { execute } = createToolExecutor(dir);
    const res = execute('list_directory', {});

    expect(res.error).toBeUndefined();
    expect(res.result).toContain('file.txt');
  });

  it('allows absolute paths to external directories (read-only)', () => {
    const workDir = makeTempDir();
    const externalDir = makeTempDir();
    writeFile(externalDir, 'external.txt', 'content');

    const { execute } = createToolExecutor(workDir);
    const res = execute('list_directory', { path: externalDir });

    expect(res.error).toBeUndefined();
    expect(res.result).toContain('external.txt');
  });

  it('blocks relative paths that traverse outside working directory via ../', () => {
    const parent = makeTempDir();
    const workDir = path.join(parent, 'project');
    fs.mkdirSync(workDir, { recursive: true });
    writeFile(parent, 'secret.txt', 'secret');

    const { execute } = createToolExecutor(workDir);
    const res = execute('list_directory', { path: '..' });

    expect(res.error).toBe(true);
    expect(res.result).toMatch(/path traversal/i);
  });

  it('blocks deep relative traversal like "../../etc"', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir);
    const res = execute('list_directory', { path: '../../etc' });

    expect(res.error).toBe(true);
    expect(res.result).toMatch(/path traversal/i);
  });
});

// ---------------------------------------------------------------------------
// read_file — relative path resolution
// ---------------------------------------------------------------------------

describe('read_file — relative path resolution', () => {
  it('resolves a relative file path against workingDir', () => {
    const dir = makeTempDir();
    writeFile(dir, 'src/main.cs', 'using System;');

    const { execute } = createToolExecutor(dir);
    const res = execute('read_file', { path: 'src/main.cs' });

    expect(res.error).toBeUndefined();
    expect(res.result).toContain('using System;');
  });

  it('resolves dotted directory names in relative paths', () => {
    const dir = makeTempDir();
    writeFile(dir, 'SpudgetBooks.Domain/Models/Account.cs', 'class Account {}');

    const { execute } = createToolExecutor(dir);
    const res = execute('read_file', { path: 'SpudgetBooks.Domain/Models/Account.cs' });

    expect(res.error).toBeUndefined();
    expect(res.result).toContain('class Account {}');
  });

  it('blocks relative paths that traverse outside working directory', () => {
    const parent = makeTempDir();
    const workDir = path.join(parent, 'project');
    fs.mkdirSync(workDir, { recursive: true });
    writeFile(parent, 'secret.txt', 'secret data');

    const { execute } = createToolExecutor(workDir);
    const res = execute('read_file', { path: '../secret.txt' });

    expect(res.error).toBe(true);
    expect(res.result).toMatch(/path traversal/i);
  });
});

// ---------------------------------------------------------------------------
// search_files — relative path resolution
// ---------------------------------------------------------------------------

describe('search_files — relative path resolution', () => {
  it('resolves a relative search path against workingDir', () => {
    const dir = makeTempDir();
    writeFile(dir, 'src/app.js', 'const x = 42;');

    const { execute } = createToolExecutor(dir);
    const res = execute('search_files', { pattern: 'const x', path: 'src' });

    expect(res.error).toBeUndefined();
    expect(res.result).toContain('const x = 42');
  });

  it('defaults to working directory when path is omitted', () => {
    const dir = makeTempDir();
    writeFile(dir, 'data.txt', 'findme123');

    const { execute } = createToolExecutor(dir);
    const res = execute('search_files', { pattern: 'findme123' });

    expect(res.error).toBeUndefined();
    expect(res.result).toContain('findme123');
  });

  it('blocks relative paths that traverse outside working directory', () => {
    const parent = makeTempDir();
    const workDir = path.join(parent, 'project');
    fs.mkdirSync(workDir, { recursive: true });

    const { execute } = createToolExecutor(workDir);
    const res = execute('search_files', { pattern: 'secret', path: '..' });

    expect(res.error).toBe(true);
    expect(res.result).toMatch(/path traversal/i);
  });
});

// ---------------------------------------------------------------------------
// write_file — relative path resolution (already had path jail)
// ---------------------------------------------------------------------------

describe('write_file — relative path resolution', () => {
  it('resolves a relative file path and writes inside workingDir', () => {
    const dir = makeTempDir();

    const { execute } = createToolExecutor(dir);
    const res = execute('write_file', { path: 'output/result.txt', content: 'done' });

    expect(res.error).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'output/result.txt'), 'utf-8')).toBe('done');
  });

  it('blocks relative paths that traverse outside working directory', () => {
    const parent = makeTempDir();
    const workDir = path.join(parent, 'project');
    fs.mkdirSync(workDir, { recursive: true });

    const { execute } = createToolExecutor(workDir);
    const res = execute('write_file', { path: '../escape.txt', content: 'malicious' });

    expect(res.error).toBe(true);
    expect(res.result).toMatch(/outside working directory/i);
    // Verify file was NOT written
    expect(fs.existsSync(path.join(parent, 'escape.txt'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// edit_file — relative path resolution (already had path jail)
// ---------------------------------------------------------------------------

describe('edit_file — relative path resolution', () => {
  it('resolves a relative file path for editing', () => {
    const dir = makeTempDir();
    writeFile(dir, 'src/config.js', 'const port = 3000;');

    const { execute } = createToolExecutor(dir);
    const res = execute('edit_file', {
      path: 'src/config.js',
      old_text: 'const port = 3000;',
      new_text: 'const port = 8080;',
    });

    expect(res.error).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'src/config.js'), 'utf-8')).toBe('const port = 8080;');
  });

  it('blocks relative paths that traverse outside working directory', () => {
    const parent = makeTempDir();
    const workDir = path.join(parent, 'project');
    fs.mkdirSync(workDir, { recursive: true });
    writeFile(parent, 'important.cfg', 'key=value');

    const { execute } = createToolExecutor(workDir);
    const res = execute('edit_file', {
      path: '../important.cfg',
      old_text: 'key=value',
      new_text: 'key=hacked',
    });

    expect(res.error).toBe(true);
    expect(res.result).toMatch(/outside working directory/i);
    // Verify file was NOT modified
    expect(fs.readFileSync(path.join(parent, 'important.cfg'), 'utf-8')).toBe('key=value');
  });
});

// ---------------------------------------------------------------------------
// resolveSafePath — unit tests for the helper
// ---------------------------------------------------------------------------

describe('resolveSafePath — relative path handling', () => {
  it('resolves relative path against workingDir', () => {
    const dir = makeTempDir();
    const { resolvedPath, allowed } = resolveSafePath('sub/file.txt', dir);

    expect(resolvedPath).toBe(path.resolve(dir, 'sub/file.txt'));
    expect(allowed).toBe(true);
  });

  it('resolves dotted directory names correctly', () => {
    const dir = makeTempDir();
    const { resolvedPath, allowed } = resolveSafePath('My.Project/src/file.cs', dir);

    expect(resolvedPath).toBe(path.resolve(dir, 'My.Project/src/file.cs'));
    expect(allowed).toBe(true);
  });

  it('marks ../ traversal as not allowed', () => {
    const dir = makeTempDir();
    const { allowed } = resolveSafePath('../outside', dir);

    expect(allowed).toBe(false);
  });

  it('marks deep traversal as not allowed', () => {
    const dir = makeTempDir();
    const { allowed } = resolveSafePath('../../etc/passwd', dir);

    expect(allowed).toBe(false);
  });

  it('marks "." as allowed (resolves to workingDir itself)', () => {
    const dir = makeTempDir();
    const { resolvedPath, allowed } = resolveSafePath('.', dir);

    expect(resolvedPath).toBe(path.resolve(dir));
    expect(allowed).toBe(true);
  });

  it('marks absolute path outside workingDir as not allowed', () => {
    const workDir = makeTempDir();
    const otherDir = makeTempDir();
    const { allowed } = resolveSafePath(otherDir, workDir);

    // Both are in os.tmpdir() but are different directories
    // allowed should be false since otherDir is not inside workDir
    expect(allowed).toBe(false);
  });
});
