import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WindowsPlatformAdapter = require('../src/platform/win32.js');

function createFakeAdapter(responseForPayload) {
  const calls = [];
  const adapter = new WindowsPlatformAdapter({
    childProcess: {
      execFileSync(command, args, options) {
        const payload = JSON.parse(options.env.PEEK_INPUT || '{}');
        calls.push({ command, args, options, payload });
        return JSON.stringify(responseForPayload(payload, args[2]));
      },
    },
  });

  return { adapter, calls };
}

describe('WindowsPlatformAdapter', () => {
  it('instantiates on any host and advertises Windows capabilities', () => {
    const adapter = new WindowsPlatformAdapter();

    expect(adapter.platform).toBe('win32');
    expect(adapter.name).toBe('Windows');
    expect(adapter.capabilities).toEqual(['capture', 'compare', 'interact', 'launch', 'windows']);
  });

  it('lists windows through PowerShell and normalizes the response array', async () => {
    const { adapter, calls } = createFakeAdapter(() => ({
      windows: [
        {
          title: 'Calculator',
          process: 'CalculatorApp',
          pid: 123,
          hwnd: '0xABC',
          geometry: { x: 10, y: 20, width: 300, height: 400 },
        },
      ],
    }));

    const windows = await adapter.listWindows();

    expect(windows).toEqual([
      {
        title: 'Calculator',
        process: 'CalculatorApp',
        pid: 123,
        hwnd: '0xABC',
        geometry: { x: 10, y: 20, width: 300, height: 400 },
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('powershell');
    expect(calls[0].args[0]).toBe('-NoProfile');
    expect(calls[0].args[1]).toBe('-Command');
    expect(calls[0].options.shell).toBe(false);
  });

  it('passes capture input through PEEK_INPUT instead of interpolating user text', async () => {
    const hostileTitle = 'Calculator"; Remove-Item -Recurse C:\\important';
    const { adapter, calls } = createFakeAdapter(() => ({
      image: Buffer.from('fake-png').toString('base64'),
      mode: 'title',
      title: 'Calculator',
      process: 'CalculatorApp',
      width: 300,
      height: 200,
      size_bytes: 8,
      format: 'jpeg',
      mime_type: 'image/jpeg',
    }));

    const result = await adapter.capture({
      mode: 'title',
      name: hostileTitle,
      format: 'jpg',
      quality: 70,
      max_width: '800',
      crop: '1,2,30,40',
    });

    expect(result.mime_type).toBe('image/jpeg');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toHaveLength(3);
    expect(calls[0].args[2]).not.toContain(hostileTitle);
    expect(calls[0].payload).toMatchObject({
      mode: 'title',
      name: hostileTitle,
      format: 'jpeg',
      quality: 70,
      max_width: 800,
      crop: { x: 1, y: 2, w: 30, h: 40 },
    });
  });

  it('normalizes interaction payloads before invoking PowerShell', async () => {
    const { adapter, calls } = createFakeAdapter((payload) => ({
      success: true,
      action: payload.action,
      payload,
    }));

    await adapter.click({ process: 'notepad.exe', x: 12, y: 34, button: 'right', double: true });
    await adapter.hotkey({ title: 'Editor', keys: 'Ctrl+Shift+P' });
    await adapter.clipboard({ action: 'set', text: 'hello' });

    expect(calls.map((call) => call.payload)).toEqual([
      {
        action: 'click',
        mode: 'process',
        name: 'notepad.exe',
        x: 12,
        y: 34,
        button: 'right',
        double: true,
      },
      {
        action: 'hotkey',
        mode: 'title',
        name: 'Editor',
        keys: ['Ctrl', 'Shift', 'P'],
      },
      {
        action: 'clipboard',
        operation: 'set',
        text: 'hello',
      },
    ]);
  });

  it('rejects invalid inputs before invoking PowerShell', async () => {
    const { adapter, calls } = createFakeAdapter(() => ({ success: true }));

    await expect(adapter.click({ x: 1, y: 'nope' })).rejects.toThrow(/y must be/);
    await expect(adapter.capture({ mode: 'title' })).rejects.toThrow(/window capture requires/);
    await expect(adapter.clipboard({ action: 'append' })).rejects.toThrow(/clipboard action/);
    expect(calls).toEqual([]);
  });
});

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip;

describeOnWindows('WindowsPlatformAdapter native smoke', () => {
  it('lists visible windows on Windows', async () => {
    const adapter = new WindowsPlatformAdapter();

    const windows = await adapter.listWindows();

    expect(Array.isArray(windows)).toBe(true);
    if (windows.length > 0) {
      expect(windows[0]).toEqual(expect.objectContaining({
        title: expect.any(String),
        process: expect.any(String),
        pid: expect.any(Number),
        hwnd: expect.any(String),
        geometry: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
          width: expect.any(Number),
          height: expect.any(Number),
        }),
      }));
    }
  });

  it('captures the screen on Windows', async () => {
    const adapter = new WindowsPlatformAdapter();

    const capture = await adapter.capture({ mode: 'screen', format: 'png', max_width: 800 });

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
