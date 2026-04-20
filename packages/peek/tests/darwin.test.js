import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const DarwinPlatformAdapter = require('../src/platform/darwin.js');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

function parseInput(options = {}) {
  return options.env && options.env.PEEK_INPUT
    ? JSON.parse(options.env.PEEK_INPUT)
    : {};
}

function createFakeAdapter(responseForCall) {
  const calls = [];
  const adapter = new DarwinPlatformAdapter({
    childProcess: {
      execFileSync(command, args, options = {}) {
        const payload = parseInput(options);
        calls.push({ command, args, options, payload });

        if (command === 'screencapture') {
          fs.writeFileSync(args[args.length - 1], PNG_1X1);
          return '';
        }

        return JSON.stringify(responseForCall({ command, args, options, payload }));
      },
    },
  });

  return { adapter, calls };
}

describe('DarwinPlatformAdapter', () => {
  it('instantiates on any host and advertises macOS capabilities', () => {
    const adapter = new DarwinPlatformAdapter();

    expect(adapter.platform).toBe('darwin');
    expect(adapter.name).toBe('macOS');
    expect(adapter.capabilities).toEqual(['capture', 'compare', 'interact', 'launch', 'windows']);
  });

  it('lists windows through osascript and normalizes the response array', async () => {
    const { adapter, calls } = createFakeAdapter(() => ({
      windows: [
        {
          title: 'Calculator',
          process: 'Calculator',
          pid: 123,
          geometry: { x: 10, y: 20, width: 300, height: 400 },
        },
      ],
    }));

    const windows = await adapter.listWindows();

    expect(windows).toEqual([
      {
        title: 'Calculator',
        process: 'Calculator',
        pid: 123,
        geometry: { x: 10, y: 20, width: 300, height: 400 },
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('osascript');
    expect(calls[0].args[0]).toBe('-l');
    expect(calls[0].args[1]).toBe('JavaScript');
    expect(calls[0].options.shell).toBe(false);
  });

  it('passes capture input through PEEK_INPUT and captures with screencapture', async () => {
    const hostileTitle = 'Calculator"; do shell script "rm -rf /"';
    const { adapter, calls } = createFakeAdapter(({ command }) => {
      if (command === 'osascript') {
        return {
          window: {
            title: 'Calculator',
            process: 'Calculator',
            pid: 123,
            geometry: { x: 10, y: 20, width: 300, height: 200 },
          },
        };
      }
      return {};
    });

    const result = await adapter.capture({
      mode: 'title',
      name: hostileTitle,
      format: 'png',
      crop: '1,2,30,40',
    });

    expect(result).toMatchObject({
      image: expect.any(String),
      mode: 'window',
      title: 'Calculator',
      process: 'Calculator',
      pid: 123,
      width: 1,
      height: 1,
      format: 'png',
      mime_type: 'image/png',
    });

    const osascriptCall = calls.find((call) => call.command === 'osascript');
    expect(osascriptCall.args[2]).not.toContain(hostileTitle);
    expect(osascriptCall.payload).toMatchObject({
      mode: 'title',
      name: hostileTitle,
      format: 'png',
      quality: 80,
      crop: { x: 1, y: 2, w: 30, h: 40 },
    });

    const captureCall = calls.find((call) => call.command === 'screencapture');
    const regionIndex = captureCall.args.indexOf('-R');
    expect(regionIndex).toBeGreaterThanOrEqual(0);
    expect(captureCall.args[regionIndex + 1]).toBe('11,22,30,40');
    expect(captureCall.args).toContain('-x');
    expect(captureCall.args).toContain('-t');
    expect(captureCall.args).toContain('png');
  });

  it('normalizes interaction payloads before invoking osascript', async () => {
    const { adapter, calls } = createFakeAdapter(({ payload }) => ({
      success: true,
      action: payload.action,
      payload,
    }));

    await adapter.click({ process: 'TextEdit', x: 12, y: 34, button: 'right', double: true });
    await adapter.hotkey({ title: 'Editor', keys: 'Command+Shift+P' });
    await adapter.clipboard({ action: 'set', text: 'hello' });

    expect(calls.map((call) => call.payload)).toEqual([
      {
        action: 'click',
        mode: 'process',
        name: 'TextEdit',
        x: 12,
        y: 34,
        button: 'right',
        double: true,
      },
      {
        action: 'hotkey',
        mode: 'title',
        name: 'Editor',
        keys: ['Command', 'Shift', 'P'],
      },
      {
        action: 'clipboard',
        operation: 'set',
        text: 'hello',
      },
    ]);
  });

  it('rejects invalid inputs before invoking osascript or screencapture', async () => {
    const { adapter, calls } = createFakeAdapter(() => ({ success: true }));

    await expect(adapter.click({ x: 1, y: 'nope' })).rejects.toThrow(/y must be/);
    await expect(adapter.capture({ mode: 'title' })).rejects.toThrow(/window capture requires/);
    await expect(adapter.clipboard({ action: 'append' })).rejects.toThrow(/clipboard action/);
    expect(calls).toEqual([]);
  });
});

const describeNative = process.platform === 'darwin' && process.env.PEEK_NATIVE_SMOKE === '1'
  ? describe
  : describe.skip;

describeNative('DarwinPlatformAdapter native smoke', () => {
  it('lists visible windows on macOS', async () => {
    const adapter = new DarwinPlatformAdapter();

    const windows = await adapter.listWindows();

    expect(Array.isArray(windows)).toBe(true);
    if (windows.length > 0) {
      expect(windows[0]).toEqual(expect.objectContaining({
        title: expect.any(String),
        process: expect.any(String),
        pid: expect.any(Number),
        geometry: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
          width: expect.any(Number),
          height: expect.any(Number),
        }),
      }));
    }
  });

  it('captures the screen on macOS', async () => {
    const adapter = new DarwinPlatformAdapter();

    const capture = await adapter.capture({ mode: 'screen', format: 'png' });

    expect(capture).toMatchObject({
      image: expect.any(String),
      mode: 'screen',
      width: expect.any(Number),
      height: expect.any(Number),
      format: 'png',
      mime_type: 'image/png',
    });
    expect(Buffer.from(capture.image, 'base64').length).toBeGreaterThan(0);
  });
});
