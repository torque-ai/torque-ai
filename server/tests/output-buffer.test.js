'use strict';

const { OutputBuffer } = require('../execution/output-buffer');

describe('OutputBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes at maxLines threshold', () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback });

    for (let index = 0; index < 20; index++) {
      buffer.append(`line-${index}`);
    }

    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith(
      Array.from({ length: 20 }, (_, index) => `line-${index}`)
    );

    buffer.destroy();
  });

  it('flushes on interval', () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback });

    for (let index = 0; index < 5; index++) {
      buffer.append(`line-${index}`);
    }

    vi.advanceTimersByTime(600);

    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith(
      Array.from({ length: 5 }, (_, index) => `line-${index}`)
    );

    buffer.destroy();
  });

  it('flush() sends remaining lines', () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback });

    buffer.append('line-1');
    buffer.append('line-2');
    buffer.append('line-3');
    buffer.flush();

    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith(['line-1', 'line-2', 'line-3']);

    buffer.destroy();
  });

  it('destroy() flushes and clears timer', () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback });

    buffer.append('line-1');
    buffer.append('line-2');

    expect(vi.getTimerCount()).toBe(1);

    buffer.destroy();

    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith(['line-1', 'line-2']);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(1000);
    expect(flushCallback).toHaveBeenCalledTimes(1);
  });

  it('no-op flush when buffer empty', () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback });

    buffer.flush();

    expect(flushCallback).not.toHaveBeenCalled();

    buffer.destroy();
  });

  it('multiple flushes accumulate correctly', () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback });

    for (let index = 0; index < 25; index++) {
      buffer.append(`line-${index}`);
    }
    buffer.flush();

    expect(flushCallback).toHaveBeenCalledTimes(2);
    expect(flushCallback).toHaveBeenNthCalledWith(
      1,
      Array.from({ length: 20 }, (_, index) => `line-${index}`)
    );
    expect(flushCallback).toHaveBeenNthCalledWith(
      2,
      Array.from({ length: 5 }, (_, index) => `line-${index + 20}`)
    );

    buffer.destroy();
  });

  it('starts its timer lazily on first append', () => {
    const flushCallback = vi.fn();
    const buffer = new OutputBuffer({ flushCallback });

    expect(vi.getTimerCount()).toBe(0);

    buffer.append('line-1');

    expect(vi.getTimerCount()).toBe(1);

    buffer.destroy();
  });

  it('validates constructor options and append input', () => {
    expect(() => new OutputBuffer()).toThrow('flushCallback must be a function');
    expect(() => new OutputBuffer({ flushCallback: () => {}, maxLines: 0 })).toThrow('maxLines must be a positive integer');
    expect(() => new OutputBuffer({ flushCallback: () => {}, flushIntervalMs: 0 })).toThrow('flushIntervalMs must be a positive integer');

    const buffer = new OutputBuffer({ flushCallback: vi.fn() });
    expect(() => buffer.append(123)).toThrow('line must be a string');
    buffer.destroy();
  });
});
