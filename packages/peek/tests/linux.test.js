import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const LinuxPlatformAdapter = require('../src/platform/linux.js');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

function createFakeAdapter(options = {}) {
  const calls = [];
  const adapter = new LinuxPlatformAdapter({
    screenshotCommand: options.screenshotCommand,
    childProcess: {
      execFileSync(command, args, execOptions = {}) {
        calls.push({ command, args, options: execOptions });

        if (command === 'xdotool') {
          if (args[0] === 'search') return `${options.windowId || '12345'}\n`;
          if (args[0] === 'getwindowname') return options.title || 'Calculator';
          if (args[0] === 'getwindowpid') return String(options.pid || 321);
          if (args[0] === 'getwindowgeometry') {
            return [
              `WINDOW=${args[args.length - 1]}`,
              'X=10',
              'Y=20',
              'WIDTH=300',
              'HEIGHT=200',
              'SCREEN=0',
            ].join('\n');
          }
          return '';
        }

        if (command === 'xprop') {
          return [
            'WM_CLASS(STRING) = "calculator", "CalculatorApp"',
            `WM_WINDOW_ROLE(STRING) = "${options.role || 'browser'}"`,
            `_NET_WM_PID(CARDINAL) = ${options.pid || 321}`,
          ].join('\n');
        }

        if (command === 'which') {
          const tool = args[0];
          if (tool === 'maim' && options.missingMaim) throw Object.assign(new Error('maim missing'), { status: 1 });
          if (tool === 'import' && options.missingImport) throw Object.assign(new Error('import missing'), { status: 1 });
          return `/usr/bin/${tool}`;
        }

        if (command === 'maim' || command === 'import') {
          fs.writeFileSync(args[args.length - 1], PNG_1X1);
          return '';
        }

        if (command === 'xclip') {
          if (options.missingXclip) throw Object.assign(new Error('xclip missing'), { code: 'ENOENT' });
          if (args.includes('-out')) return options.clipboardText || 'clip text';
          return '';
        }

        if (command === 'xsel') {
          if (args.includes('--output')) return options.clipboardText || 'clip text';
          return '';
        }

        throw new Error(`Unexpected command: ${command}`);
      },
    },
  });

  return { adapter, calls };
}

describe('LinuxPlatformAdapter', () => {
  it('instantiates on any host and advertises Linux capabilities', () => {
    const adapter = new LinuxPlatformAdapter();

    expect(adapter.platform).toBe('linux');
    expect(adapter.name).toBe('Linux');
    expect(adapter.capabilities).toEqual(['capture', 'compare', 'interact', 'launch', 'windows']);
  });

  it('lists windows through xdotool and xprop', async () => {
    const { adapter, calls } = createFakeAdapter();

    const windows = await adapter.listWindows();

    expect(windows).toEqual([
      {
        id: '12345',
        window_id: '12345',
        title: 'Calculator',
        process: 'CalculatorApp',
        pid: 321,
        role: 'browser',
        geometry: { x: 10, y: 20, width: 300, height: 200 },
      },
    ]);
    expect(calls[0]).toMatchObject({
      command: 'xdotool',
      args: ['search', '--onlyvisible', '--name', '.'],
    });
    expect(calls.some((call) => call.command === 'xprop' && call.args[0] === '-id')).toBe(true);
    expect(calls.every((call) => call.options.shell === false)).toBe(true);
  });

  it('captures a target window with maim without shell interpolation', async () => {
    const hostileTitle = 'Calculator"; rm -rf /';
    const { adapter, calls } = createFakeAdapter();

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
      process: 'CalculatorApp',
      pid: 321,
      window_id: '12345',
      width: 1,
      height: 1,
      format: 'png',
      mime_type: 'image/png',
    });

    const searchCall = calls.find((call) => call.command === 'xdotool' && call.args[0] === 'search');
    expect(searchCall.args).toEqual(['search', '--onlyvisible', '--name', hostileTitle]);

    const maimCall = calls.find((call) => call.command === 'maim');
    expect(maimCall.args.slice(0, 4)).toEqual(['-f', 'png', '-g', '30x40+11+22']);
    expect(maimCall.options.shell).toBe(false);
  });

  it('falls back to ImageMagick import when maim is unavailable', async () => {
    const { adapter, calls } = createFakeAdapter({ missingMaim: true });

    const result = await adapter.capture({ mode: 'screen', format: 'png' });

    expect(result).toMatchObject({
      mode: 'screen',
      format: 'png',
      mime_type: 'image/png',
    });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'which', args: ['maim'] }),
      expect.objectContaining({ command: 'which', args: ['import'] }),
      expect.objectContaining({ command: 'import', args: expect.arrayContaining(['-window', 'root']) }),
    ]));
  });

  it('normalizes interactions before invoking xdotool or clipboard tools', async () => {
    const { adapter, calls } = createFakeAdapter({ missingXclip: true });

    await adapter.click({ process: 'CalculatorApp', x: 12, y: 34, button: 'right', double: true });
    await adapter.hotkey({ title: 'Editor', keys: 'Ctrl+Shift+P' });
    await adapter.clipboard({ action: 'set', text: 'hello' });

    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: 'xdotool',
        args: ['search', '--onlyvisible', '--class', 'CalculatorApp'],
      }),
      expect.objectContaining({
        command: 'xdotool',
        args: ['windowactivate', '--sync', '12345'],
      }),
      expect.objectContaining({
        command: 'xdotool',
        args: ['mousemove', '12', '34', 'click', '--repeat', '2', '3'],
      }),
      expect.objectContaining({
        command: 'xdotool',
        args: ['key', 'ctrl+Shift+P'],
      }),
      expect.objectContaining({
        command: 'xsel',
        args: ['--clipboard', '--input'],
        options: expect.objectContaining({ input: 'hello' }),
      }),
    ]));
  });

  it('rejects invalid inputs before invoking native tools', async () => {
    const { adapter, calls } = createFakeAdapter();

    await expect(adapter.click({ x: 1, y: 'nope' })).rejects.toThrow(/y must be/);
    await expect(adapter.capture({ mode: 'title' })).rejects.toThrow(/window capture requires/);
    await expect(adapter.clipboard({ action: 'append' })).rejects.toThrow(/clipboard action/);
    expect(calls).toEqual([]);
  });
});

const describeNative = process.platform === 'linux' && process.env.PEEK_NATIVE_SMOKE === '1'
  ? describe
  : describe.skip;

describeNative('LinuxPlatformAdapter native smoke', () => {
  it('lists visible windows on Linux', async () => {
    const adapter = new LinuxPlatformAdapter();

    const windows = await adapter.listWindows();

    expect(Array.isArray(windows)).toBe(true);
    if (windows.length > 0) {
      expect(windows[0]).toEqual(expect.objectContaining({
        title: expect.any(String),
        process: expect.any(String),
        pid: expect.any(Number),
        window_id: expect.any(String),
        geometry: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
          width: expect.any(Number),
          height: expect.any(Number),
        }),
      }));
    }
  });

  it('captures the screen on Linux', async () => {
    const adapter = new LinuxPlatformAdapter();

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
