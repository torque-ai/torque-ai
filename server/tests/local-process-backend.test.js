'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLocalProcessBackend } = require('../sandbox/backends/local-process');

describe('localProcessBackend', () => {
  let backend;
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
    backend = createLocalProcessBackend({ workDir: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('create + runCommand runs in sandbox cwd', async () => {
    const { sandboxId } = await backend.create({ name: 'test' });
    const { stdout, exitCode } = await backend.runCommand(sandboxId, {
      cmd: process.execPath,
      args: ['-e', 'console.log("hi")'],
    });

    expect(stdout.trim()).toBe('hi');
    expect(exitCode).toBe(0);
  });

  it('fs.write + fs.read roundtrips a file', async () => {
    const { sandboxId } = await backend.create({});
    await backend.fs.write(sandboxId, 'a.txt', 'hello');

    const buffer = await backend.fs.read(sandboxId, 'a.txt');

    expect(buffer.toString()).toBe('hello');
  });

  it('fs.list enumerates written files', async () => {
    const { sandboxId } = await backend.create({});
    await backend.fs.write(sandboxId, 'x.txt', '1');
    await backend.fs.write(sandboxId, 'y.txt', '22');

    const files = await backend.fs.list(sandboxId, '.');

    expect(files.sort((left, right) => left.name.localeCompare(right.name))).toEqual([
      { name: 'x.txt', type: 'file', size: 1 },
      { name: 'y.txt', type: 'file', size: 2 },
    ]);
  });

  it('destroy removes sandbox directory', async () => {
    const { sandboxId } = await backend.create({});
    await backend.fs.write(sandboxId, 'a.txt', 'x');
    await backend.destroy(sandboxId);

    await expect(
      backend.runCommand(sandboxId, {
        cmd: process.execPath,
        args: ['-e', 'console.log("hi")'],
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('runCommand rejects cwd that escapes the sandbox', async () => {
    const { sandboxId } = await backend.create({});

    await expect(
      backend.runCommand(sandboxId, {
        cmd: process.execPath,
        args: ['-e', 'console.log("hi")'],
        cwd: path.join('..', '..'),
      }),
    ).rejects.toThrow(/escape/i);
  });

  it('runCommand honors timeoutMs', async () => {
    const { sandboxId } = await backend.create({});

    await expect(
      backend.runCommand(sandboxId, {
        cmd: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 5000)'],
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/timeout/i);
  });
});
