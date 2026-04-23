'use strict';

const childProcess = require('child_process');

const {
  isGitCommand,
  isAgentCliCommand,
  getSubcommand,
  stubGitOutput,
} = require('./worker-setup');

describe('worker setup git interception', () => {
  it('keeps git command helpers and sync stubs available', () => {
    expect(isGitCommand('git')).toBe(true);
    expect(isGitCommand('C:\\Program Files\\Git\\cmd\\git.exe')).toBe(true);
    expect(isGitCommand('node')).toBe(false);
    expect(getSubcommand(['--no-pager', 'status', '--short'])).toBe('status');

    expect(stubGitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], 'utf8')).toBe('main\n');
    expect(childProcess.execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })).toBe('/mock/repo\n');

    const status = childProcess.spawnSync('git', ['status'], { encoding: 'utf8' });
    expect(status.status).toBe(0);
    expect(status.stdout).toBe('');
    expect(childProcess._realExecFileSync).toBeTypeOf('function');
    expect(childProcess._realSpawnSync).toBeTypeOf('function');
  });

  it('preserves check-ignore not-ignored semantics', () => {
    expect(() => stubGitOutput(['check-ignore', 'server/tools.js'], 'utf8')).toThrow('not ignored');

    try {
      childProcess.execFileSync('git', ['check-ignore', 'server/tools.js'], { encoding: 'utf8' });
      throw new Error('expected check-ignore stub to throw');
    } catch (err) {
      expect(err.status).toBe(1);
      expect(err.stdout).toBe('');
      expect(err.stderr).toBe('');
    }
  });

  it('blocks real agent CLI spawns and closes synthetic streams', async () => {
    expect(isAgentCliCommand('codex.cmd')).toBe(true);
    expect(isAgentCliCommand('node')).toBe(false);

    const child = childProcess.spawn('codex', ['exec', '--full-auto']);
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

    const close = await new Promise((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    });

    expect(close).toEqual({ code: 1, signal: null });
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(stderr.join('')).toContain('blocked real agent CLI spawn');
  });
});
