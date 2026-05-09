'use strict';

const childProcess = require('child_process');
let spawnSyncSpy;

const { createTestRunnerRegistry } = require('../test-runner-registry');

describe('TestRunnerRegistry', () => {
  let registry;

  beforeEach(() => {
    if (spawnSyncSpy) {
      spawnSyncSpy.mockRestore();
      spawnSyncSpy = undefined;
    }
    registry = createTestRunnerRegistry();
    spawnSyncSpy = vi.spyOn(childProcess, 'spawnSync');
    spawnSyncSpy.mockClear();
  });

  afterEach(() => {
    if (spawnSyncSpy) {
      spawnSyncSpy.mockRestore();
      spawnSyncSpy = undefined;
    }
  });

  it('should have default local-only runVerifyCommand', async () => {
    const result = await registry.runVerifyCommand('echo hello', '/tmp', {});
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('remote', false);
  });

  it('should have default local-only runRemoteOrLocal', async () => {
    const result = await registry.runRemoteOrLocal('echo', ['hello'], '/tmp', {});
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('remote', false);
  });

  it('should allow overriding runVerifyCommand', async () => {
    const custom = vi.fn().mockResolvedValue({
      success: true, output: 'custom', error: '', exitCode: 0, durationMs: 1, remote: true,
    });
    registry.register({ runVerifyCommand: custom });
    const result = await registry.runVerifyCommand('test cmd', '/tmp', {});
    expect(result.remote).toBe(true);
    expect(custom).toHaveBeenCalledWith('test cmd', '/tmp', {});
  });

  it('should allow overriding runRemoteOrLocal', async () => {
    const custom = vi.fn().mockResolvedValue({
      success: true, output: 'custom', error: '', exitCode: 0, durationMs: 1, remote: true,
    });
    registry.register({ runRemoteOrLocal: custom });
    const result = await registry.runRemoteOrLocal('npx', ['vitest'], '/tmp', {});
    expect(result.remote).toBe(true);
    expect(custom).toHaveBeenCalledWith('npx', ['vitest'], '/tmp', {});
  });

  it('should allow unregistering back to local defaults', async () => {
    const custom = vi.fn().mockResolvedValue({
      success: true, output: '', error: '', exitCode: 0, durationMs: 0, remote: true,
    });
    registry.register({ runVerifyCommand: custom });
    registry.unregister();
    const result = await registry.runVerifyCommand('echo test', '/tmp', {});
    expect(result.remote).toBe(false);
  });

  it('should return empty success for blank verify command', async () => {
    const result = await registry.runVerifyCommand('', '/tmp', {});
    expect(result.success).toBe(true);
    expect(result.durationMs).toBe(0);
  });

  it('quotes arguments when running local command via shell form', async () => {
    const command = process.platform === 'win32'
      ? 'echo "hello world"'
      : "echo 'hello world'";

    await registry.runRemoteOrLocal('echo', ['hello world'], '/tmp', {});

    expect(spawnSyncSpy).toHaveBeenCalledTimes(1);
    expect(spawnSyncSpy.mock.calls[0][0]).toContain(command);
    expect(spawnSyncSpy.mock.calls[0][1]).toMatchObject({
      cwd: '/tmp',
      shell: true,
    });
  });

  it('extends the local verify timeout while stdout keeps streaming', async () => {
    const script = "let n=0;process.stdout.write('tick '+n+'\\n');let t=setInterval(()=>{n+=1,process.stdout.write('tick '+n+'\\n'),n===4&&clearInterval(t)},200);setTimeout(()=>process.exit(0),950)";
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

    const result = await registry.runVerifyCommand(command, process.cwd(), { timeout: 500 });

    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
      timedOut: false,
    });
    expect(result.output).toContain('tick 4');
  });

  it.skipIf(process.platform !== 'win32')('lets Windows PowerShell autoload built-in modules from the local verify shell', async () => {
    const result = await registry.runVerifyCommand(
      'powershell -NoProfile -Command "Get-Command Get-FileHash -ErrorAction Stop | Select-Object -ExpandProperty Source"',
      process.cwd(),
      { timeout: 60000 }
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Microsoft.PowerShell.Utility');
  });
});
