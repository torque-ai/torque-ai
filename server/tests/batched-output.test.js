'use strict';

const { OutputBuffer } = require('../execution/output-buffer');

describe('batched output persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes when maxLines reached (20 lines)', () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback, maxLines: 20, flushIntervalMs: 500 });

    for (let index = 0; index < 20; index += 1) {
      buffer.append(`line-${index}`);
    }

    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith(
      Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n')
    );
  });

  it('flushes after flushIntervalMs timeout', () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback, flushIntervalMs: 500 });

    buffer.append('line-1');
    buffer.append('line-2');

    vi.advanceTimersByTime(499);
    expect(flushCallback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith('line-1\nline-2');
  });

  it('destroy() flushes remaining buffered lines', () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback, flushIntervalMs: 500 });

    buffer.append('line-1');
    buffer.append('line-2');
    buffer.destroy();

    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith('line-1\nline-2');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("doesn't trigger flush callback for an empty buffer", () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback, flushIntervalMs: 500 });

    buffer.flush();
    buffer.destroy();

    expect(flushCallback).not.toHaveBeenCalled();
  });

  it('batches multiple appends within the interval into a single flush', () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback, flushIntervalMs: 500 });

    buffer.append('line-1');
    vi.advanceTimersByTime(200);
    buffer.append('line-2');
    vi.advanceTimersByTime(200);
    buffer.append('line-3');

    expect(flushCallback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith('line-1\nline-2\nline-3');
  });

  it('passes joined lines with newlines to the flush callback', () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback, flushIntervalMs: 500 });

    buffer.append('alpha');
    buffer.append('beta');
    buffer.append('gamma');
    buffer.flush();

    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith('alpha\nbeta\ngamma');
  });
});
