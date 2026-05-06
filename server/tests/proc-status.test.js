'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkProcStatusLinux } = require('../utils/proc-status');

describe('checkProcStatusLinux', () => {
  let fakeProc;

  beforeEach(() => {
    fakeProc = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeproc-'));
  });

  afterEach(() => {
    try { fs.rmSync(fakeProc, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function writeStatus(pid, body) {
    const dir = path.join(fakeProc, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status'), body, 'utf8');
  }

  test('returns "alive" for a running process (State: R)', () => {
    writeStatus(1234, 'Name:\tnode\nUmask:\t0022\nState:\tR (running)\nTgid:\t1234\n');
    const r = checkProcStatusLinux(1234, { procRoot: fakeProc, platformOverride: 'linux' });
    expect(r).toBe('alive');
  });

  test('returns "alive" for a sleeping process (State: S)', () => {
    writeStatus(1234, 'Name:\tnode\nState:\tS (sleeping)\n');
    const r = checkProcStatusLinux(1234, { procRoot: fakeProc, platformOverride: 'linux' });
    expect(r).toBe('alive');
  });

  test('returns "zombie" for State: Z', () => {
    writeStatus(1234, 'Name:\tcodex\nState:\tZ (zombie)\nTgid:\t1234\n');
    const r = checkProcStatusLinux(1234, { procRoot: fakeProc, platformOverride: 'linux' });
    expect(r).toBe('zombie');
  });

  test('returns "zombie" for State: X (transitional dead)', () => {
    writeStatus(1234, 'Name:\tcodex\nState:\tX (dead)\n');
    const r = checkProcStatusLinux(1234, { procRoot: fakeProc, platformOverride: 'linux' });
    expect(r).toBe('zombie');
  });

  test('returns "dead" when /proc/<pid>/status is missing (ENOENT)', () => {
    // No file written for pid 9999
    const r = checkProcStatusLinux(9999, { procRoot: fakeProc, platformOverride: 'linux' });
    expect(r).toBe('dead');
  });

  test('returns "unknown" when status file is unparseable', () => {
    writeStatus(1234, 'malformed content with no State line\n');
    const r = checkProcStatusLinux(1234, { procRoot: fakeProc, platformOverride: 'linux' });
    expect(r).toBe('unknown');
  });

  test('returns "unknown" on non-Linux platforms', () => {
    writeStatus(1234, 'Name:\tnode\nState:\tR (running)\n');
    expect(checkProcStatusLinux(1234, { procRoot: fakeProc, platformOverride: 'win32' })).toBe('unknown');
    expect(checkProcStatusLinux(1234, { procRoot: fakeProc, platformOverride: 'darwin' })).toBe('unknown');
    expect(checkProcStatusLinux(1234, { procRoot: fakeProc, platformOverride: 'freebsd' })).toBe('unknown');
  });

  test('returns "unknown" for invalid PIDs', () => {
    expect(checkProcStatusLinux(0, { procRoot: fakeProc, platformOverride: 'linux' })).toBe('unknown');
    expect(checkProcStatusLinux(-1, { procRoot: fakeProc, platformOverride: 'linux' })).toBe('unknown');
    expect(checkProcStatusLinux(NaN, { procRoot: fakeProc, platformOverride: 'linux' })).toBe('unknown');
    expect(checkProcStatusLinux(1.5, { procRoot: fakeProc, platformOverride: 'linux' })).toBe('unknown');
    expect(checkProcStatusLinux('1234', { procRoot: fakeProc, platformOverride: 'linux' })).toBe('unknown');
    expect(checkProcStatusLinux(null, { procRoot: fakeProc, platformOverride: 'linux' })).toBe('unknown');
  });

  test('does not throw on permission errors (returns unknown)', () => {
    // We can't easily simulate EACCES cross-platform; just verify the path
    // when readFileSync throws a non-ENOENT error returns 'unknown' rather than throwing.
    // Use a procRoot that exists but has no reasonable status file format.
    const dir = path.join(fakeProc, '99999');
    fs.mkdirSync(dir, { recursive: true });
    // Don't write status — would normally hit ENOENT. To exercise non-ENOENT,
    // make the path a directory instead so readFileSync hits EISDIR.
    fs.mkdirSync(path.join(dir, 'status'));
    const r = checkProcStatusLinux(99999, { procRoot: fakeProc, platformOverride: 'linux' });
    expect(r).toBe('unknown');
  });

  test('parses State: code even without parenthetical', () => {
    writeStatus(1234, 'Name:\ttest\nState:\tD\nTgid:\t1234\n');
    expect(checkProcStatusLinux(1234, { procRoot: fakeProc, platformOverride: 'linux' })).toBe('alive');
  });

  test('handles State: appearing on a non-first line', () => {
    writeStatus(1234, 'Name:\tnode\nUmask:\t0022\nState:\tZ (zombie)\nTgid:\t1234\n');
    expect(checkProcStatusLinux(1234, { procRoot: fakeProc, platformOverride: 'linux' })).toBe('zombie');
  });
});
