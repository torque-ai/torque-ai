import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkDependencies,
  detectPlatform,
  getCapabilities,
} = require('../src/platform/detect.js');

function fakeRunner(availableTools, calls = []) {
  const available = new Set(availableTools);
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (!available.has(args[0])) {
      throw new Error(`${args[0]} not found`);
    }
    return Buffer.from(`/usr/bin/${args[0]}`);
  };
}

describe('detectPlatform', () => {
  it('returns adapter metadata for supported platforms', () => {
    expect(detectPlatform({ platform: 'win32' })).toMatchObject({
      platform: 'win32',
      supported: true,
      adapter: 'win32',
      name: 'Windows',
    });
    expect(detectPlatform({ platform: 'darwin' })).toMatchObject({
      platform: 'darwin',
      supported: true,
      adapter: 'darwin',
      name: 'macOS',
    });
    expect(detectPlatform({ platform: 'linux' })).toMatchObject({
      platform: 'linux',
      supported: true,
      adapter: 'linux',
      name: 'Linux',
    });
  });

  it('marks unknown platforms unsupported without selecting an adapter', () => {
    expect(detectPlatform({ platform: 'freebsd' })).toEqual({
      platform: 'freebsd',
      supported: false,
      adapter: null,
      name: 'freebsd',
    });
  });
});

describe('checkDependencies', () => {
  it('uses where on Windows and reports PowerShell-backed capabilities', () => {
    const calls = [];
    const result = checkDependencies({
      platform: 'win32',
      execFileSync: fakeRunner(['powershell'], calls),
    });

    expect(result.ok).toBe(true);
    expect(result.available).toEqual(['powershell']);
    expect(result.missing).toEqual([]);
    expect(result.capabilities).toEqual(['capture', 'compare', 'interact', 'launch', 'windows']);
    expect(calls).toEqual([
      { command: 'where', args: ['powershell'], options: { stdio: 'ignore' } },
    ]);
  });

  it('uses which on macOS and reports missing tools', () => {
    const calls = [];
    const result = checkDependencies({
      platform: 'darwin',
      execFileSync: fakeRunner(['osascript'], calls),
    });

    expect(result.ok).toBe(false);
    expect(result.available).toEqual(['osascript']);
    expect(result.missing).toEqual(['screencapture']);
    expect(result.capabilities).toEqual(['compare', 'interact', 'launch', 'windows']);
    expect(calls.map((call) => call.command)).toEqual(['which', 'which']);
    expect(calls.map((call) => call.args[0])).toEqual(['screencapture', 'osascript']);
  });

  it('accepts either maim or ImageMagick import for Linux capture', () => {
    const result = checkDependencies({
      platform: 'linux',
      execFileSync: fakeRunner(['xdotool', 'xprop', 'import']),
    });

    expect(result.ok).toBe(true);
    expect(result.available).toEqual(['xdotool', 'xprop', 'import']);
    expect(result.missing).toEqual([]);
    expect(result.checks.find((check) => check.name === 'linux-screenshot')).toMatchObject({
      anyOf: ['maim', 'import'],
      available: true,
      availableTools: ['import'],
    });
    expect(result.capabilities).toEqual(['capture', 'compare', 'interact', 'launch', 'windows']);
  });

  it('reports a Linux screenshot dependency as missing only when all alternatives are absent', () => {
    const result = checkDependencies({
      platform: 'linux',
      execFileSync: fakeRunner(['xdotool', 'xprop']),
    });

    expect(result.ok).toBe(false);
    expect(result.available).toEqual(['xdotool', 'xprop']);
    expect(result.missing).toEqual(['maim or import']);
    expect(result.capabilities).toEqual(['compare', 'interact', 'launch', 'windows']);
  });

  it('returns an unsupported-platform result without probing tools', () => {
    const calls = [];
    const result = checkDependencies({
      platform: 'sunos',
      execFileSync: fakeRunner([], calls),
    });

    expect(result).toMatchObject({
      platform: 'sunos',
      supported: false,
      adapter: null,
      ok: false,
      available: [],
      missing: [],
      checks: [],
      capabilities: [],
    });
    expect(result.error).toMatch(/Unsupported platform: sunos/);
    expect(calls).toEqual([]);
  });
});

describe('getCapabilities', () => {
  it('checks dependencies when no available tool list is provided', () => {
    expect(getCapabilities({
      platform: 'darwin',
      execFileSync: fakeRunner(['screencapture', 'osascript']),
    })).toEqual(['capture', 'compare', 'interact', 'launch', 'windows']);
  });

  it('maps Windows dependencies to capture, interaction, and window capabilities', () => {
    expect(getCapabilities({ platform: 'win32', available: ['powershell'] })).toEqual([
      'capture',
      'compare',
      'interact',
      'launch',
      'windows',
    ]);
  });

  it('maps partial macOS dependencies to partial capabilities', () => {
    expect(getCapabilities({ platform: 'darwin', available: ['screencapture'] })).toEqual([
      'capture',
      'compare',
      'launch',
    ]);
  });

  it('requires xdotool plus a screenshot tool for Linux capture', () => {
    expect(getCapabilities({ platform: 'linux', available: ['maim'] })).toEqual([
      'compare',
      'launch',
    ]);
    expect(getCapabilities({ platform: 'linux', available: ['xdotool', 'maim'] })).toEqual([
      'capture',
      'compare',
      'interact',
      'launch',
    ]);
  });
});
