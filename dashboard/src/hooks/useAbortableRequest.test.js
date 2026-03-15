import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAbortableRequest } from './useAbortableRequest.js';

describe('useAbortableRequest', () => {
  it('returns an execute function', () => {
    const { result } = renderHook(() => useAbortableRequest());
    expect(result.current).toHaveProperty('execute');
    expect(typeof result.current.execute).toBe('function');
  });

  it('execute() returns async function result when mounted', async () => {
    const { result } = renderHook(() => useAbortableRequest());

    let value;
    await act(async () => {
      value = await result.current.execute(async () => 42);
    });

    expect(value).toBe(42);
  });

  it('passes isCurrent callback to async function', async () => {
    const { result } = renderHook(() => useAbortableRequest());

    let receivedIsCurrent;
    await act(async () => {
      await result.current.execute(async (isCurrent) => {
        receivedIsCurrent = isCurrent;
        return 'ok';
      });
    });

    expect(typeof receivedIsCurrent).toBe('function');
  });

  it('isCurrent() returns true while mounted and no newer request', async () => {
    const { result } = renderHook(() => useAbortableRequest());

    let isCurrentValue;
    await act(async () => {
      await result.current.execute(async (isCurrent) => {
        isCurrentValue = isCurrent();
        return 'ok';
      });
    });

    expect(isCurrentValue).toBe(true);
  });

  it('returns undefined when component unmounts during request', async () => {
    const { result, unmount } = renderHook(() => useAbortableRequest());

    // Capture execute before unmount (result.current becomes null after unmount)
    const execute = result.current.execute;

    let resolve;
    const asyncOp = new Promise((r) => { resolve = r; });

    const promise = execute(async () => {
      const data = await asyncOp;
      return data;
    });

    // Unmount while request is in flight
    unmount();

    // Resolve the async operation after unmount
    resolve('data');
    const value = await promise;

    expect(value).toBeUndefined();
  });

  it('returns undefined when newer request supersedes', async () => {
    const { result } = renderHook(() => useAbortableRequest());
    const execute = result.current.execute;

    let resolve1;
    const asyncOp1 = new Promise((r) => { resolve1 = r; });

    // Start first request (will be superseded)
    const promise1 = execute(async () => {
      const data = await asyncOp1;
      return data;
    });

    // Start second request (supersedes the first by incrementing counter)
    const promise2 = execute(async () => 'second');

    // Resolve first request after second one started
    resolve1('first');

    const [value1, value2] = await Promise.all([promise1, promise2]);

    expect(value1).toBeUndefined();
    expect(value2).toBe('second');
  });

  it('swallows errors when component unmounts during request', async () => {
    const { result, unmount } = renderHook(() => useAbortableRequest());
    const execute = result.current.execute;

    let reject;
    const asyncOp = new Promise((_, r) => { reject = r; });

    const promise = execute(async () => {
      return await asyncOp;
    });

    // Unmount then reject
    unmount();
    reject(new Error('network error'));
    const value = await promise;

    expect(value).toBeUndefined();
  });

  it('rethrows errors when component is still mounted', async () => {
    const { result } = renderHook(() => useAbortableRequest());

    let caughtError;
    await act(async () => {
      try {
        await result.current.execute(async () => {
          throw new Error('api error');
        });
      } catch (err) {
        caughtError = err;
      }
    });

    expect(caughtError).toBeDefined();
    expect(caughtError.message).toBe('api error');
  });

  it('swallows errors when superseded by newer request', async () => {
    const { result } = renderHook(() => useAbortableRequest());
    const execute = result.current.execute;

    let reject1;
    const asyncOp1 = new Promise((_, r) => { reject1 = r; });

    const promise1 = execute(async () => {
      return await asyncOp1;
    });

    const promise2 = execute(async () => 'second');

    // Reject first request after second started
    reject1(new Error('stale error'));

    const [value1, value2] = await Promise.all([promise1, promise2]);

    // First request error is swallowed (returns undefined), second succeeds
    expect(value1).toBeUndefined();
    expect(value2).toBe('second');
  });

  it('execute identity is stable across renders', () => {
    const { result, rerender } = renderHook(() => useAbortableRequest());
    const firstExecute = result.current.execute;
    rerender();
    expect(result.current.execute).toBe(firstExecute);
  });

  it('handles multiple sequential requests correctly', async () => {
    const { result } = renderHook(() => useAbortableRequest());

    const values = [];
    await act(async () => {
      values.push(await result.current.execute(async () => 'a'));
    });
    await act(async () => {
      values.push(await result.current.execute(async () => 'b'));
    });
    await act(async () => {
      values.push(await result.current.execute(async () => 'c'));
    });

    expect(values).toEqual(['a', 'b', 'c']);
  });
});
