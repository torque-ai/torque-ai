const { safeExecChain } = require('../utils/safe-exec');

const REMOTE_EXEC_OPTIONS = { encoding: 'utf8', timeout: 30000 };

describe('safe-exec', { timeout: 60000 }, () => {
  it('runs a single command', () => {
    const result = safeExecChain('node -e process.exit(0)', REMOTE_EXEC_OPTIONS);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('');
    expect(result.error).toBeUndefined();
  });

  it('runs chained commands', () => {
    const result = safeExecChain('node -e process.stdout.write("hello") && node -e process.stdout.write("world")', REMOTE_EXEC_OPTIONS);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('helloworld');
    expect(result.error).toBeUndefined();
  });

  it('stops the chain when a command fails', () => {
    const result = safeExecChain('node -e process.stderr.write("bad");process.exit(1) && node -e process.stdout.write(" not-run")', REMOTE_EXEC_OPTIONS);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('bad');
    expect(result.output).not.toContain('not-run');
  });

  it('captures output from the command chain', () => {
    const result = safeExecChain('node -e process.stdout.write("segment-1") && node -e process.stdout.write("segment-2")', REMOTE_EXEC_OPTIONS);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('segment-1segment-2');
  });

  it('runs the fallback side of an || chain after a failure', () => {
    const result = safeExecChain('node -e process.exit(1) || node -e process.stdout.write("fallback")', REMOTE_EXEC_OPTIONS);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('fallback');
    expect(result.error).toBeUndefined();
  });

  it('short-circuits || chains after the first success', () => {
    const result = safeExecChain('node -e process.stdout.write("primary") || node -e process.stdout.write("not-run")', REMOTE_EXEC_OPTIONS);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('primary');
    expect(result.output).not.toContain('not-run');
  });

  it('supports mixed && and || short-circuit semantics', () => {
    const result = safeExecChain('node -e process.exit(1) && node -e process.stdout.write("nope") || node -e process.stdout.write("recovered")', REMOTE_EXEC_OPTIONS);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('recovered');
    expect(result.output).not.toContain('nope');
  });
});
