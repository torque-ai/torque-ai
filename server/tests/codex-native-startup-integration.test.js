import { describe, it, expect } from 'vitest';
import path from 'node:path';

const { buildProviderStartupEnv } = require('../execution/task-startup');

describe('buildProviderStartupEnv — native codex PATH augmentation', () => {
  const baseArgs = {
    taskId: 'task-1',
    task: { workflow_id: 'wf-1', workflow_node_id: 'node-1' },
    taskMetadata: {},
    runDir: '/tmp/runs/task-1',
  };

  it('prepends the vendor path/ dir to PATH when nativeCodex is provided', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin' };
    const vendorPath = '/fake/vendor/x86_64-pc-windows-msvc/path';
    const result = buildProviderStartupEnv({
      ...baseArgs,
      env,
      nvmNodePath: null,
      nativeCodex: {
        pathPrepend: vendorPath,
        envAdditions: { CODEX_MANAGED_BY_NPM: '1' },
      },
    });

    const parts = result.PATH.split(path.delimiter);
    expect(parts[0]).toBe(vendorPath);
    expect(result.PATH).toContain('/usr/local/bin');
    expect(result.CODEX_MANAGED_BY_NPM).toBe('1');
  });

  it('does not prepend the vendor path dir when it is already on PATH', () => {
    const vendorPath = '/fake/vendor/path';
    const env = { PATH: `/usr/local/bin${path.delimiter}${vendorPath}${path.delimiter}/usr/bin` };
    const result = buildProviderStartupEnv({
      ...baseArgs,
      env,
      nvmNodePath: null,
      nativeCodex: {
        pathPrepend: vendorPath,
        envAdditions: {},
      },
    });

    const firstHits = result.PATH.split(path.delimiter).filter(p => p === vendorPath);
    expect(firstHits.length).toBe(1); // no duplication
    expect(result.PATH.startsWith('/usr/local/bin')).toBe(true);
  });

  it('does not touch PATH when nativeCodex is null (fallback behavior)', () => {
    const env = { PATH: '/usr/bin:/bin' };
    const result = buildProviderStartupEnv({
      ...baseArgs,
      env,
      nvmNodePath: null,
      nativeCodex: null,
    });

    expect(result.PATH).toBe('/usr/bin:/bin');
    expect(result.CODEX_MANAGED_BY_NPM).toBeUndefined();
  });

  it('applies envAdditions even when pathPrepend is null', () => {
    const env = { PATH: '/bin' };
    const result = buildProviderStartupEnv({
      ...baseArgs,
      env,
      nvmNodePath: null,
      nativeCodex: {
        pathPrepend: null,
        envAdditions: { CODEX_MANAGED_BY_NPM: '1' },
      },
    });

    expect(result.PATH).toBe('/bin');
    expect(result.CODEX_MANAGED_BY_NPM).toBe('1');
  });

  it('combines nvmNodePath prepend and nativeCodex prepend correctly', () => {
    const nvmPath = '/home/user/.nvm/versions/node/v20/bin';
    const vendorPath = '/codex/vendor/path';
    const env = { PATH: '/usr/bin' };
    const result = buildProviderStartupEnv({
      ...baseArgs,
      env,
      nvmNodePath: nvmPath,
      nativeCodex: {
        pathPrepend: vendorPath,
        envAdditions: {},
      },
    });

    const parts = result.PATH.split(path.delimiter);
    // vendor goes FIRST (prepended last), then nvm, then the original PATH
    expect(parts[0]).toBe(vendorPath);
    expect(parts[1]).toBe(nvmPath);
    expect(parts[2]).toBe('/usr/bin');
  });
});
