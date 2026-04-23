'use strict';
const { describe, it, expect, vi } = require('vitest');
const { createReflectionExecutor } = require('../memory/reflection-executor');

describe('reflectionExecutor', () => {
  it('debounces repeated submit calls within window', async () => {
    const reflect = vi.fn(async () => {});
    const exec = createReflectionExecutor({ reflect, debounceMs: 50 });
    exec.submit('run1');
    exec.submit('run1');
    exec.submit('run1');
    await new Promise(r => setTimeout(r, 80));
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(reflect).toHaveBeenCalledWith('run1');
  });

  it('separate keys reflect independently', async () => {
    const reflect = vi.fn(async () => {});
    const exec = createReflectionExecutor({ reflect, debounceMs: 30 });
    exec.submit('a');
    exec.submit('b');
    await new Promise(r => setTimeout(r, 60));
    expect(reflect).toHaveBeenCalledTimes(2);
  });

  it('cancel before fire prevents reflect', async () => {
    const reflect = vi.fn(async () => {});
    const exec = createReflectionExecutor({ reflect, debounceMs: 50 });
    exec.submit('x');
    exec.cancel('x');
    await new Promise(r => setTimeout(r, 80));
    expect(reflect).not.toHaveBeenCalled();
  });
});
