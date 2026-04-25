'use strict';

/**
 * agentic-tools.test.js — Tests for ollama-tools.js tool executor
 *
 * Covers: path jail, edit_file replace_all, search_files, command sandbox,
 * parseToolCalls, and createToolExecutor factory API.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createToolExecutor,
  resolveSafePath,
  TOOL_DEFINITIONS,
  selectToolsForTask,
  parseToolCalls,
  MAX_FILE_READ_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
} = require('../providers/ollama-tools');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-tools-test-'));
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
// Factory API
// ---------------------------------------------------------------------------

describe('createToolExecutor factory', () => {
  it('returns execute function and changedFiles Set', () => {
    const dir = makeTempDir();
    const executor = createToolExecutor(dir);
    expect(typeof executor.execute).toBe('function');
    expect(executor.changedFiles).toBeInstanceOf(Set);
  });

  it('changedFiles tracks written files', () => {
    const dir = makeTempDir();
    const { execute, changedFiles } = createToolExecutor(dir);
    execute('write_file', { path: 'hello.txt', content: 'hi' });
    const expected = path.resolve(dir, 'hello.txt');
    expect(changedFiles.has(expected)).toBe(true);
  });

  it('execute returns { result, error?, metadata? }', () => {
    const dir = makeTempDir();
    writeFile(dir, 'a.txt', 'hello');
    const { execute } = createToolExecutor(dir);
    const res = execute('read_file', { path: 'a.txt' });
    expect(typeof res.result).toBe('string');
    expect(res.result).toContain('hello');
    expect(res.error).toBeUndefined();
  });

  it('unknown tool returns error', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir);
    const res = execute('nonexistent_tool', {});
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/unknown tool/i);
  });

  it('requires a write after configured initial reads are complete', () => {
    const dir = makeTempDir();
    writeFile(dir, 'docs/autodev/SESSION_LOG.md', '# Session');
    writeFile(dir, 'docs/autodev/NEXT_TASK.json', '{"goal":"repair"}');
    const { execute } = createToolExecutor(dir, {
      writeAfterReadPaths: [
        'docs/autodev/SESSION_LOG.md',
        'docs/autodev/NEXT_TASK.json',
      ],
    });

    expect(execute('read_file', { path: 'docs/autodev/SESSION_LOG.md' }).error).toBeUndefined();
    expect(execute('read_file', { path: 'docs/autodev/NEXT_TASK.json' }).error).toBeUndefined();

    const res = execute('read_file', { path: 'docs/autodev/SESSION_LOG.md' });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/next tool call must modify a file/i);
  });

  it('allows reads again after a successful write in write-after-read mode', () => {
    const dir = makeTempDir();
    writeFile(dir, 'docs/autodev/SESSION_LOG.md', '# Session');
    writeFile(dir, 'docs/autodev/NEXT_TASK.json', '{"goal":"repair"}');
    writeFile(dir, 'docs/autodev/NEXT_TASK.md', '# Next Task\n');
    const { execute } = createToolExecutor(dir, {
      writeAllowlist: ['docs/autodev/NEXT_TASK.md'],
      writeAfterReadPaths: [
        'docs/autodev/SESSION_LOG.md',
        'docs/autodev/NEXT_TASK.json',
      ],
    });

    execute('read_file', { path: 'docs/autodev/SESSION_LOG.md' });
    execute('read_file', { path: 'docs/autodev/NEXT_TASK.json' });

    const writeRes = execute('replace_lines', {
      path: 'docs/autodev/NEXT_TASK.md',
      start_line: 1,
      end_line: 1,
      new_text: '# Updated Next Task',
    });
    expect(writeRes.error).toBeUndefined();

    const readRes = execute('read_file', { path: 'docs/autodev/SESSION_LOG.md' });
    expect(readRes.error).toBeUndefined();
  });

  it('allows one diagnostic read after a failed command, then requires a write', () => {
    const dir = makeTempDir();
    writeFile(dir, 'src/app.cs', 'line 1\nline 2\nline 3\n');
    writeFile(dir, 'docs/note.md', '# note\n');
    const { execute } = createToolExecutor(dir, {
      commandMode: 'allowlist',
      commandAllowlist: ['node -e *'],
      diagnosticReadLimitAfterFailedCommand: 1,
    });

    const failRes = execute('run_command', { command: 'node -e "process.exit(1)"' });
    expect(failRes.error).toBe(true);

    const firstRead = execute('read_file', { path: 'src/app.cs', start_line: 1, end_line: 3 });
    expect(firstRead.error).toBeUndefined();

    const blockedRead = execute('read_file', { path: 'docs/note.md' });
    expect(blockedRead.error).toBe(true);
    expect(blockedRead.result).toMatch(/verification recovery mode is active/i);

    const writeRes = execute('replace_lines', {
      path: 'src/app.cs',
      start_line: 2,
      end_line: 2,
      new_text: 'updated line 2',
    });
    expect(writeRes.error).toBeUndefined();

    const readAfterWrite = execute('read_file', { path: 'docs/note.md' });
    expect(readAfterWrite.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveSafePath
// ---------------------------------------------------------------------------

describe('resolveSafePath', () => {
  it('returns allowed=true for path inside workingDir', () => {
    const dir = makeTempDir();
    const { resolvedPath, allowed } = resolveSafePath('subdir/file.txt', dir);
    expect(allowed).toBe(true);
    expect(resolvedPath).toBe(path.resolve(dir, 'subdir/file.txt'));
  });

  it('returns allowed=false for path outside workingDir via ../..', () => {
    const dir = makeTempDir();
    const { resolvedPath, allowed } = resolveSafePath('../../etc/passwd', dir);
    expect(allowed).toBe(false);
    expect(resolvedPath).not.toContain(dir);
  });

  it('returns allowed=true for path exactly at workingDir root', () => {
    const dir = makeTempDir();
    const { resolvedPath, allowed } = resolveSafePath('.', dir);
    expect(allowed).toBe(true);
    expect(resolvedPath).toBe(path.resolve(dir));
  });

  it('returns allowed=false for absolute path outside workingDir', () => {
    const dir = makeTempDir();
    const outside = os.tmpdir();
    const { allowed } = resolveSafePath(outside, dir);
    // outside is not inside dir (they are siblings), so allowed is false
    // unless dir happens to be inside tmpdir — in that case we use a more isolated path
    if (allowed) {
      // dir is inside tmpdir: use system root instead
      const { allowed: allowed2 } = resolveSafePath('C:\\Windows\\System32\\cmd.exe', dir);
      expect(allowed2).toBe(false);
    } else {
      expect(allowed).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Path Jail — write_file
// ---------------------------------------------------------------------------

describe('write_file path jail', () => {
  it('writes file inside working directory', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir);
    const res = execute('write_file', { path: 'output.txt', content: 'data' });
    expect(res.error).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'output.txt'), 'utf-8')).toBe('data');
  });

  it('creates subdirectories as needed', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir);
    const res = execute('write_file', { path: 'sub/dir/file.txt', content: 'nested' });
    expect(res.error).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'sub/dir/file.txt'))).toBe(true);
  });

  it('hard-refuses write outside working directory', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir);
    const res = execute('write_file', { path: '../../evil.txt', content: 'pwned' });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/outside working directory/i);
  });

  it('does NOT create the file when path is jailed', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir);
    const outsidePath = path.resolve(dir, '../../should-not-exist.txt');
    execute('write_file', { path: '../../should-not-exist.txt', content: 'pwned' });
    expect(fs.existsSync(outsidePath)).toBe(false);
  });

  it('changedFiles does NOT include rejected path', () => {
    const dir = makeTempDir();
    const { execute, changedFiles } = createToolExecutor(dir);
    execute('write_file', { path: '../../evil.txt', content: 'bad' });
    expect(changedFiles.size).toBe(0);
  });

  it('blocks writes outside the task write allowlist even when inside working directory', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir, {
      writeAllowlist: ['docs/autodev/SESSION_LOG.md'],
    });
    const res = execute('write_file', { path: 'src/output.txt', content: 'blocked' });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/outside the allowed scope/i);
    expect(fs.existsSync(path.join(dir, 'src/output.txt'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Path Jail — edit_file
// ---------------------------------------------------------------------------

describe('edit_file path jail', () => {
  it('edits file inside working directory', () => {
    const dir = makeTempDir();
    writeFile(dir, 'edit-me.txt', 'hello world');
    const { execute } = createToolExecutor(dir);
    const res = execute('edit_file', { path: 'edit-me.txt', old_text: 'hello', new_text: 'goodbye' });
    expect(res.error).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'edit-me.txt'), 'utf-8')).toBe('goodbye world');
  });

  it('hard-refuses edit outside working directory', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir);
    const res = execute('edit_file', { path: '../../target.txt', old_text: 'x', new_text: 'y' });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/outside working directory/i);
  });

  it('blocks replace_lines outside the task write allowlist', () => {
    const dir = makeTempDir();
    writeFile(dir, 'src/app.cs', 'line 1\nline 2\nline 3\n');
    const { execute } = createToolExecutor(dir, {
      writeAllowlist: ['docs/autodev/SESSION_LOG.md'],
    });
    const res = execute('replace_lines', {
      path: 'src/app.cs',
      start_line: 2,
      end_line: 2,
      new_text: 'updated line 2',
    });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/outside the allowed scope/i);
  });
});

// ---------------------------------------------------------------------------
// Path Jail — read_file (allowed outside workingDir)
// ---------------------------------------------------------------------------

describe('read_file outside working directory (read-only is safe)', () => {
  it('reads a file outside working directory', () => {
    const workDir = makeTempDir();
    const externalDir = makeTempDir();
    writeFile(externalDir, 'external.txt', 'external content');
    const { execute } = createToolExecutor(workDir);
    const res = execute('read_file', { path: path.join(externalDir, 'external.txt') });
    expect(res.error).toBeUndefined();
    expect(res.result).toContain('external content');
  });

  it('blocks reads outside the task read allowlist', () => {
    const dir = makeTempDir();
    writeFile(dir, 'docs/autodev/NEXT_TASK.md', '# Next Task');
    writeFile(dir, 'src/secret.txt', 'secret content');
    const { execute } = createToolExecutor(dir, {
      readAllowlist: ['docs/autodev/NEXT_TASK.md'],
    });
    const res = execute('read_file', { path: 'src/secret.txt' });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/outside the allowed scope/i);
  });
});

// ---------------------------------------------------------------------------
// edit_file — match semantics
// ---------------------------------------------------------------------------

describe('edit_file match semantics', () => {
  it('returns error when old_text not found', () => {
    const dir = makeTempDir();
    writeFile(dir, 'test.txt', 'line one\nline two\n');
    const { execute } = createToolExecutor(dir);
    const res = execute('edit_file', { path: 'test.txt', old_text: 'does not exist', new_text: 'x' });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/not found/i);
  });

  it('fails on multiple matches without replace_all', () => {
    const dir = makeTempDir();
    writeFile(dir, 'dupe.txt', 'foo bar\nfoo baz\n');
    const { execute } = createToolExecutor(dir);
    const res = execute('edit_file', { path: 'dupe.txt', old_text: 'foo', new_text: 'qux' });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/multiple/i);
  });

  it('replaces all occurrences with replace_all=true', () => {
    const dir = makeTempDir();
    writeFile(dir, 'multi.txt', 'foo bar\nfoo baz\nfoo end\n');
    const { execute } = createToolExecutor(dir);
    const res = execute('edit_file', { path: 'multi.txt', old_text: 'foo', new_text: 'qux', replace_all: true });
    expect(res.error).toBeUndefined();
    const content = fs.readFileSync(path.join(dir, 'multi.txt'), 'utf-8');
    expect(content).toBe('qux bar\nqux baz\nqux end\n');
    expect(content).not.toContain('foo');
  });

  it('metadata.replacements counts replacements when replace_all=true', () => {
    const dir = makeTempDir();
    writeFile(dir, 'count.txt', 'a b a c a');
    const { execute } = createToolExecutor(dir);
    const res = execute('edit_file', { path: 'count.txt', old_text: 'a', new_text: 'z', replace_all: true });
    expect(res.error).toBeUndefined();
    expect(res.metadata).toBeDefined();
    expect(res.metadata.replacements).toBe(3);
  });

  it('replaces single unique match without replace_all', () => {
    const dir = makeTempDir();
    writeFile(dir, 'single.txt', 'hello unique world');
    const { execute } = createToolExecutor(dir);
    const res = execute('edit_file', { path: 'single.txt', old_text: 'unique', new_text: 'special' });
    expect(res.error).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'single.txt'), 'utf-8')).toBe('hello special world');
  });

  it('returns error when file not found', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir);
    const res = execute('edit_file', { path: 'missing.txt', old_text: 'x', new_text: 'y' });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/not found/i);
  });

  it('adds edited file to changedFiles', () => {
    const dir = makeTempDir();
    writeFile(dir, 'track.txt', 'original text');
    const { execute, changedFiles } = createToolExecutor(dir);
    execute('edit_file', { path: 'track.txt', old_text: 'original', new_text: 'replaced' });
    expect(changedFiles.has(path.resolve(dir, 'track.txt'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// search_files — pure Node.js, no grep
// ---------------------------------------------------------------------------

describe('search_files (pure Node.js)', () => {
  it('finds pattern across files in a directory', () => {
    const dir = makeTempDir();
    writeFile(dir, 'file1.txt', 'hello world\nfoo bar\n');
    writeFile(dir, 'file2.txt', 'no match here\nhello again\n');
    const { execute } = createToolExecutor(dir);
    const res = execute('search_files', { pattern: 'hello', path: dir });
    expect(res.error).toBeUndefined();
    expect(res.result).toContain('hello world');
    expect(res.result).toContain('hello again');
  });

  it('finds pattern across subdirectories', () => {
    const dir = makeTempDir();
    writeFile(dir, 'top.txt', 'top level match');
    writeFile(dir, 'sub/deep.txt', 'deep level match');
    const { execute } = createToolExecutor(dir);
    const res = execute('search_files', { pattern: 'match', path: dir });
    expect(res.error).toBeUndefined();
    expect(res.result).toContain('top level match');
    expect(res.result).toContain('deep level match');
  });

  it('respects glob filter — only matches .txt files', () => {
    const dir = makeTempDir();
    writeFile(dir, 'file.txt', 'target pattern');
    writeFile(dir, 'file.js', 'target pattern');
    const { execute } = createToolExecutor(dir);
    const res = execute('search_files', { pattern: 'target', path: dir, glob: '*.txt' });
    expect(res.error).toBeUndefined();
    expect(res.result).toContain('file.txt');
    expect(res.result).not.toContain('file.js');
  });

  it('respects glob filter — only matches .cs files', () => {
    const dir = makeTempDir();
    writeFile(dir, 'Program.cs', 'namespace App {}');
    writeFile(dir, 'readme.md', 'namespace mentioned here');
    const { execute } = createToolExecutor(dir);
    const res = execute('search_files', { pattern: 'namespace', path: dir, glob: '*.cs' });
    expect(res.result).toContain('Program.cs');
    expect(res.result).not.toContain('readme.md');
  });

  it('handles regex patterns', () => {
    const dir = makeTempDir();
    writeFile(dir, 'data.txt', 'error: code 404\ninfo: ok\nwarning: code 500\n');
    const { execute } = createToolExecutor(dir);
    const res = execute('search_files', { pattern: 'code \\d+', path: dir });
    expect(res.error).toBeUndefined();
    expect(res.result).toContain('code 404');
    expect(res.result).toContain('code 500');
    expect(res.result).not.toContain('info: ok');
  });

  it('returns no matches message when pattern not found', () => {
    const dir = makeTempDir();
    writeFile(dir, 'empty.txt', 'no relevant content here');
    const { execute } = createToolExecutor(dir);
    const res = execute('search_files', { pattern: 'zzznomatch999', path: dir });
    expect(res.result).toMatch(/no matches/i);
  });

  it('output format is filePath:lineNo: lineContent', () => {
    const dir = makeTempDir();
    writeFile(dir, 'format.txt', 'line one\nfind me\nline three\n');
    const { execute } = createToolExecutor(dir);
    const res = execute('search_files', { pattern: 'find me', path: dir });
    // Should contain lineNo (2) and the content
    expect(res.result).toMatch(/:2:/);
    expect(res.result).toContain('find me');
  });

  it('caps results at 100 matches', () => {
    const dir = makeTempDir();
    const lines = Array.from({ length: 200 }, (_, i) => `match line ${i}`).join('\n');
    writeFile(dir, 'big.txt', lines);
    const { execute } = createToolExecutor(dir);
    const res = execute('search_files', { pattern: 'match line', path: dir });
    const matchCount = (res.result.match(/match line/g) || []).length;
    expect(matchCount).toBeLessThanOrEqual(100);
  });

  it('defaults path to working directory when not provided', () => {
    const dir = makeTempDir();
    writeFile(dir, 'implicit.txt', 'implicit path test');
    const { execute } = createToolExecutor(dir);
    const res = execute('search_files', { pattern: 'implicit path test' });
    expect(res.result).toContain('implicit path test');
  });

  it('rejects unsafe regex patterns', () => {
    const dir = makeTempDir();
    writeFile(dir, 'file.txt', 'hello world');
    const { execute } = createToolExecutor(dir);
    const res = execute('search_files', { pattern: 'a'.repeat(201), path: dir });
    expect(res).toEqual({ error: 'Unsafe regex pattern' });
  });

  it('blocks searches outside the task read allowlist', () => {
    const dir = makeTempDir();
    writeFile(dir, 'docs/autodev/NEXT_TASK.md', '# Next Task');
    writeFile(dir, 'src/app.js', 'const hidden = true;');
    const { execute } = createToolExecutor(dir, {
      readAllowlist: ['docs/autodev'],
    });
    const res = execute('search_files', { pattern: 'hidden', path: 'src' });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/outside the allowed scope/i);
  });
});

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

describe('list_directory', () => {
  it('lists files and directories', () => {
    const dir = makeTempDir();
    writeFile(dir, 'a.txt', '');
    writeFile(dir, 'b.txt', '');
    fs.mkdirSync(path.join(dir, 'subdir'));
    const { execute } = createToolExecutor(dir);
    const res = execute('list_directory', { path: '.' });
    expect(res.error).toBeUndefined();
    expect(res.result).toContain('a.txt');
    expect(res.result).toContain('b.txt');
    expect(res.result).toContain('subdir/');
  });

  it('returns error for nonexistent directory', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir);
    const res = execute('list_directory', { path: 'does-not-exist' });
    expect(res.error).toBe(true);
  });

  it('blocks directory listing outside the task read allowlist', () => {
    const dir = makeTempDir();
    writeFile(dir, 'docs/autodev/TASK_BRIEF.md', 'brief');
    writeFile(dir, 'src/file.txt', 'content');
    const { execute } = createToolExecutor(dir, {
      readAllowlist: ['docs/autodev'],
    });
    const res = execute('list_directory', { path: 'src' });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/outside the allowed scope/i);
  });
});

// ---------------------------------------------------------------------------
// run_command — command sandbox
// ---------------------------------------------------------------------------

describe('run_command command sandbox', () => {
  it('default command mode blocks commands until allowlisted', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir);
    const res = execute('run_command', { command: 'node -e "process.stdout.write(\'hello\')"' });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/not in allowlist/i);
  });

  it('allowlist mode blocks command not in allowlist', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir, {
      commandMode: 'allowlist',
      commandAllowlist: ['dotnet *', 'npm *'],
    });
    const res = execute('run_command', { command: 'rm -rf /' });
    expect(res.error).toBe(true);
    expect(res.result).toMatch(/not in allowlist/i);
  });

  it('allowlist mode allows matching command', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir, {
      commandMode: 'allowlist',
      commandAllowlist: ['node *'],
    });
    const res = execute('run_command', { command: 'node -e "process.stdout.write(\'ok\')"' });
    expect(res.error).toBeUndefined();
    expect(res.result).toContain('ok');
  });

  it('allowlist mode: wildcard * matches any suffix', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir, {
      commandMode: 'allowlist',
      commandAllowlist: ['dotnet *'],
    });
    const res1 = execute('run_command', { command: 'dotnet build' });
    // dotnet may not be installed, but the allowlist check should pass (not block)
    // The error here is from dotnet not found, NOT from allowlist rejection
    if (res1.error) {
      expect(res1.result).not.toMatch(/not in allowlist/i);
    }
    const { execute: executeSecond } = createToolExecutor(dir, {
      commandMode: 'allowlist',
      commandAllowlist: ['dotnet *'],
    });
    const res2 = executeSecond('run_command', { command: 'npm install' });
    expect(res2.error).toBe(true);
    expect(res2.result).toMatch(/not in allowlist/i);
  });

  it('allowlist mode: exact match (no wildcard) works', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir, {
      commandMode: 'allowlist',
      commandAllowlist: ['node --version'],
    });
    const allowed = execute('run_command', { command: 'node --version' });
    expect(allowed.result).not.toMatch(/not in allowlist/i);

    const blocked = execute('run_command', { command: 'node -e "1+1"' });
    expect(blocked.error).toBe(true);
    expect(blocked.result).toMatch(/not in allowlist/i);
  });

  it('unrestricted mode runs command in working directory', () => {
    const dir = makeTempDir();
    writeFile(dir, 'sentinel.txt', 'sentinel');
    const { execute } = createToolExecutor(dir, {
      commandMode: 'unrestricted',
    });
    // List current directory — should see sentinel.txt
    const cmd = process.platform === 'win32' ? 'dir /b' : 'ls';
    const res = execute('run_command', { command: cmd });
    expect(res.result).toContain('sentinel.txt');
  });

  it('captures stderr in failed command output', () => {
    const dir = makeTempDir();
    const { execute } = createToolExecutor(dir, {
      commandMode: 'unrestricted',
    });
    const res = execute('run_command', { command: 'node -e "process.stderr.write(\'err msg\'); process.exit(1)"' });
    expect(res.error).toBe(true);
    expect(res.result).toContain('err msg');
  });
});

// ---------------------------------------------------------------------------
// parseToolCalls
// ---------------------------------------------------------------------------

describe('parseToolCalls', () => {
  it('parses structured tool_calls field', () => {
    const message = {
      tool_calls: [
        { function: { name: 'read_file', arguments: { path: 'foo.txt' } } },
      ],
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].arguments).toEqual({ path: 'foo.txt' });
  });

  it('parses structured tool_calls with JSON string arguments', () => {
    const message = {
      tool_calls: [
        { function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'hi' }) } },
      ],
    };
    const calls = parseToolCalls(message);
    expect(calls[0].arguments).toEqual({ path: 'out.txt', content: 'hi' });
  });

  it('parses <tool_call> XML tags', () => {
    const message = {
      content: '<tool_call>{"name":"list_directory","arguments":{"path":"."}}</tool_call>',
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('list_directory');
    expect(calls[0].arguments).toEqual({ path: '.' });
  });

  it('parses multiple <tool_call> tags', () => {
    const message = {
      content: '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>\n<tool_call>{"name":"read_file","arguments":{"path":"b.txt"}}</tool_call>',
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(2);
    expect(calls[0].arguments.path).toBe('a.txt');
    expect(calls[1].arguments.path).toBe('b.txt');
  });

  it('parses OpenRouter free self-closing tool tags', () => {
    const message = {
      content: 'I will inspect the root.\n\n<list_directory path="C:\\repo\\NetSim" />',
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('list_directory');
    expect(calls[0].arguments).toEqual({ path: 'C:\\repo\\NetSim' });
  });

  it('parses Minimax invoke pseudo tool calls', () => {
    const message = {
      content: [
        '<minimax:tool_call>',
        '<invoke name="list_directory">',
        '<parameter name="path">C:\\repo\\NetSim</parameter>',
        '</invoke>',
        '</minimax:tool_call>',
      ].join('\n'),
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('list_directory');
    expect(calls[0].arguments).toEqual({ path: 'C:\\repo\\NetSim' });
  });

  it('parses nested OpenRouter tool tags', () => {
    const message = {
      content: [
        '<minimax:tool_call>',
        '<list_directory>',
        '<path>C:\\repo\\NetSim</path>',
        '</list_directory>',
        '</minimax:tool_call>',
      ].join('\n'),
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('list_directory');
    expect(calls[0].arguments).toEqual({ path: 'C:\\repo\\NetSim' });
  });

  it('parses bracketed OpenRouter pseudo tool calls', () => {
    const message = {
      content: [
        '[TOOL_CALL]',
        '{tool => "list_directory", args => {',
        '  --path "C:\\repo\\NetSim"',
        '}}',
        '[/TOOL_CALL]',
      ].join('\n'),
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('list_directory');
    expect(calls[0].arguments).toEqual({ path: 'C:\\repo\\NetSim' });
  });

  it('parses bracketed local Ollama pseudo tool calls', () => {
    const message = {
      content: 'I will inspect the tests.[TOOL_CALLS]list_directory[ARGS]{"path":"Modules/Tests"}',
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('list_directory');
    expect(calls[0].arguments).toEqual({ path: 'Modules/Tests' });
  });

  it('parses bracketed pseudo tool calls with braces in string arguments', () => {
    const message = {
      content: '[TOOL_CALLS]write_file[ARGS]{"path":"notes.txt","content":"keep {literal} braces"}',
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('write_file');
    expect(calls[0].arguments).toEqual({ path: 'notes.txt', content: 'keep {literal} braces' });
  });

  it('parses plain function-like pseudo tool calls', () => {
    const message = {
      content: 'read_file({path, C:\\repo\\NetSim\\})',
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].arguments).toEqual({ path: 'C:\\repo\\NetSim\\' });
  });

  it('parses raw JSON object in content', () => {
    const message = {
      content: '{"name":"run_command","arguments":{"command":"npm test"}}',
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('run_command');
    expect(calls[0].arguments.command).toBe('npm test');
  });

  it('parses JSON in markdown code block', () => {
    const message = {
      content: 'Sure, let me search:\n```json\n{"name":"search_files","arguments":{"pattern":"TODO"}}\n```',
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('search_files');
  });

  it('parses JSON in plain code block (no lang)', () => {
    const message = {
      content: '```\n{"name":"write_file","arguments":{"path":"x.txt","content":"y"}}\n```',
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('write_file');
  });

  it('returns empty array for empty message content', () => {
    expect(parseToolCalls({ content: '' })).toEqual([]);
    expect(parseToolCalls({ content: null })).toEqual([]);
    expect(parseToolCalls({})).toEqual([]);
  });

  it('returns empty array for non-tool content', () => {
    const message = { content: 'I will now edit the file for you.' };
    expect(parseToolCalls(message)).toEqual([]);
  });

  it('skips malformed JSON in <tool_call> tags gracefully', () => {
    const message = {
      content: '<tool_call>not json</tool_call><tool_call>{"name":"read_file","arguments":{}}</tool_call>',
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
  });

  it('structured tool_calls takes priority over content', () => {
    const message = {
      tool_calls: [
        { function: { name: 'read_file', arguments: { path: 'structured.txt' } } },
      ],
      content: '{"name":"write_file","arguments":{"path":"content.txt","content":"x"}}',
    };
    const calls = parseToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
  });
});

// ---------------------------------------------------------------------------
// TOOL_DEFINITIONS
// ---------------------------------------------------------------------------

describe('TOOL_DEFINITIONS', () => {
  it('is an array with 7 entries', () => {
    expect(Array.isArray(TOOL_DEFINITIONS)).toBe(true);
    expect(TOOL_DEFINITIONS).toHaveLength(7);
  });

  it('each entry has type "function" and a function.name', () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.type).toBe('function');
      expect(typeof def.function.name).toBe('string');
      expect(def.function.name.length).toBeGreaterThan(0);
    }
  });

  it('contains all 7 expected tool names', () => {
    const names = TOOL_DEFINITIONS.map(d => d.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('list_directory');
    expect(names).toContain('search_files');
    expect(names).toContain('replace_lines');
    expect(names).toContain('run_command');
  });

  it('edit_file includes optional replace_all boolean parameter', () => {
    const editDef = TOOL_DEFINITIONS.find(d => d.function.name === 'edit_file');
    expect(editDef).toBeDefined();
    const props = editDef.function.parameters.properties;
    expect(props.replace_all).toBeDefined();
    expect(props.replace_all.type).toBe('boolean');
    // replace_all must NOT be in required
    const required = editDef.function.parameters.required || [];
    expect(required).not.toContain('replace_all');
  });
});

describe('selectToolsForTask', () => {
  it('omits run_command when command allowlist is empty', () => {
    const names = selectToolsForTask('Edit docs/autodev/NEXT_TASK.json', {
      commandMode: 'allowlist',
      commandAllowlist: [],
    }).map((tool) => tool.function.name);
    expect(names).not.toContain('run_command');
    expect(names).toContain('edit_file');
  });

  it('retains run_command when commands are allowlisted', () => {
    const names = selectToolsForTask('Edit docs/autodev/NEXT_TASK.json', {
      commandMode: 'allowlist',
      commandAllowlist: ['pwsh -File scripts/autodev-verify.ps1*'],
    }).map((tool) => tool.function.name);
    expect(names).toContain('run_command');
  });

  it('respects a task-level tool allowlist for modification tasks', () => {
    const names = selectToolsForTask('Repair the baseline compile failure.', {
      commandMode: 'allowlist',
      commandAllowlist: ['pwsh -File scripts/autodev-verify.ps1*'],
      toolAllowlist: ['read_file', 'replace_lines', 'run_command'],
    }).map((tool) => tool.function.name);
    expect(names).toEqual(['read_file', 'replace_lines', 'run_command']);
    expect(names).not.toContain('search_files');
    expect(names).not.toContain('edit_file');
  });
});

// ---------------------------------------------------------------------------
// Safety limits — exported constants
// ---------------------------------------------------------------------------

describe('safety limit constants', () => {
  it('MAX_FILE_READ_BYTES is 512KB', () => {
    expect(MAX_FILE_READ_BYTES).toBe(512 * 1024);
  });

  it('MAX_COMMAND_TIMEOUT_MS is 30s', () => {
    expect(MAX_COMMAND_TIMEOUT_MS).toBe(30_000);
  });

  it('MAX_OUTPUT_BYTES is 128KB', () => {
    expect(MAX_OUTPUT_BYTES).toBe(128 * 1024);
  });
});
