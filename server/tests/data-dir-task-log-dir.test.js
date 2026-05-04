'use strict';

const path = require('path');
const dataDir = require('../data-dir');

describe('getTaskLogDir', () => {
  beforeEach(() => {
    dataDir.setDataDir('/tmp/torque-test-root');
  });

  afterEach(() => {
    dataDir.setDataDir(null);
  });

  it('resolves to <data-dir>/task-logs/<taskId>/', () => {
    const result = dataDir.getTaskLogDir('abc-123');
    expect(result).toBe(path.join('/tmp/torque-test-root', 'task-logs', 'abc-123'));
  });

  it('preserves alphanumerics, dots, dashes, and underscores', () => {
    const id = 'taskId.with-mixed_chars.123';
    expect(dataDir.getTaskLogDir(id)).toBe(
      path.join('/tmp/torque-test-root', 'task-logs', id)
    );
  });

  it('replaces unsafe path-traversal characters with underscores', () => {
    // The sanitizer keeps dots (legitimate part of UUIDs / file names)
    // but replaces anything else, including slashes. So
    // '../../../etc/passwd' becomes '.._.._.._etc_passwd' — a single
    // directory name with no real path-segment boundaries left.
    // path.join then anchors it inside <data-dir>/task-logs.
    const input = '../../../etc/passwd';
    const result = dataDir.getTaskLogDir(input);
    const expectedLeaf = '.._.._.._etc_passwd';
    expect(result).toBe(path.join('/tmp/torque-test-root', 'task-logs', expectedLeaf));
    // Crucially the resolved path stays inside the task-logs root —
    // node's path.resolve never sees the literal '..' boundary
    // because the slashes were sanitized first.
    const taskLogsRoot = path.resolve(path.join('/tmp/torque-test-root', 'task-logs'));
    expect(path.resolve(result).startsWith(taskLogsRoot)).toBe(true);
  });

  it('rejects empty / non-string taskId', () => {
    expect(() => dataDir.getTaskLogDir('')).toThrow(/non-empty taskId/);
    expect(() => dataDir.getTaskLogDir(null)).toThrow(/non-empty taskId/);
    expect(() => dataDir.getTaskLogDir(undefined)).toThrow(/non-empty taskId/);
    expect(() => dataDir.getTaskLogDir(123)).toThrow(/non-empty taskId/);
  });

  it('rejects taskIds that sanitize to dot or double-dot', () => {
    expect(() => dataDir.getTaskLogDir('.')).toThrow(/unsafe value/);
    expect(() => dataDir.getTaskLogDir('..')).toThrow(/unsafe value/);
  });
});
