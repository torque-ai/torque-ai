'use strict';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: 'ok',
    stderr: '',
  })),
  spawn: vi.fn(() => {
    const EventEmitter = require('events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = vi.fn();
    child.stderr.setEncoding = vi.fn();
    child.kill = vi.fn();
    setTimeout(() => { child.emit('close', 0); }, 5);
    return child;
  }),
}));

const { createTestRunnerRegistry } = require('../test-runner-registry');

describe('TestRunnerRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = createTestRunnerRegistry();
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
});
