'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { EventEmitter } = require('events');
const child_process = require('node:child_process');
const verifyReview = require('../factory/verify-review');

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('verify-review getModifiedFiles', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns [] for missing args without spawning git', async () => {
    const spawnSpy = vi.spyOn(child_process, 'spawn');
    expect(await verifyReview.getModifiedFiles('', 'feat/x', 'master')).toEqual([]);
    expect(await verifyReview.getModifiedFiles('/tmp', '', 'master')).toEqual([]);
    expect(await verifyReview.getModifiedFiles('/tmp', 'feat/x', '')).toEqual([]);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('returns parsed file list when git diff exits 0', async () => {
    const child = makeFakeChild();
    vi.spyOn(child_process, 'spawn').mockReturnValue(child);
    const promise = verifyReview.getModifiedFiles('/tmp/repo', 'feat/x', 'master');
    child.stdout.emit('data', Buffer.from('src/a.js\nsrc/b.js\n'));
    child.emit('close', 0);
    const result = await promise;
    expect(result).toEqual(['src/a.js', 'src/b.js']);
  });

  it('returns [] when git diff exits non-zero', async () => {
    const child = makeFakeChild();
    vi.spyOn(child_process, 'spawn').mockReturnValue(child);
    const promise = verifyReview.getModifiedFiles('/tmp/repo', 'feat/x', 'master');
    child.stdout.emit('data', Buffer.from('partial\n'));
    child.emit('close', 1);
    expect(await promise).toEqual([]);
  });

  it('returns [] and SIGKILLs the child when git hangs past the timeout', async () => {
    const child = makeFakeChild();
    vi.spyOn(child_process, 'spawn').mockReturnValue(child);
    const promise = verifyReview.getModifiedFiles('/tmp/repo', 'feat/x', 'master');

    // Drive past the 15s internal timeout without ever firing close/error.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await promise).toEqual([]);
  });

  it('returns [] when spawn itself throws', async () => {
    vi.spyOn(child_process, 'spawn').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(await verifyReview.getModifiedFiles('/tmp/repo', 'feat/x', 'master')).toEqual([]);
  });
});
