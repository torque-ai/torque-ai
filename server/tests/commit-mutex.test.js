'use strict';

const commitMutex = require('../utils/commit-mutex');

const { acquire, isLocked, waitingCount, _reset } = commitMutex;

beforeEach(() => {
  _reset();
});

describe('commit-mutex', () => {
  it('acquires and releases', async () => {
    const release = await acquire();

    expect(isLocked()).toBe(true);
    expect(waitingCount()).toBe(0);

    release();

    expect(isLocked()).toBe(false);
    expect(waitingCount()).toBe(0);
  });

  it('serializes concurrent acquires', async () => {
    const releaseFirst = await acquire();
    let secondAcquired = false;

    const secondAcquire = acquire().then((releaseSecond) => {
      secondAcquired = true;
      return releaseSecond;
    });

    expect(secondAcquired).toBe(false);
    expect(waitingCount()).toBe(1);

    releaseFirst();

    const releaseSecond = await secondAcquire;

    expect(secondAcquired).toBe(true);
    expect(isLocked()).toBe(true);
    expect(waitingCount()).toBe(0);

    releaseSecond();

    expect(isLocked()).toBe(false);
  });

  it('times out when mutex held too long', async () => {
    const releaseFirst = await acquire();
    const blockedAcquire = acquire(50);

    await expect(blockedAcquire).rejects.toThrow('CommitMutex: acquire timeout');
    expect(waitingCount()).toBe(0);
    expect(isLocked()).toBe(true);

    releaseFirst();

    expect(isLocked()).toBe(false);
  });

  it('FIFO ordering', async () => {
    const order = [];
    const releaseFirst = await acquire();
    order.push('first');

    const secondAcquire = acquire().then((releaseSecond) => {
      order.push('second');
      return releaseSecond;
    });

    const thirdAcquire = acquire().then((releaseThird) => {
      order.push('third');
      return releaseThird;
    });

    expect(waitingCount()).toBe(2);

    releaseFirst();
    const releaseSecond = await secondAcquire;

    expect(order).toEqual(['first', 'second']);
    expect(waitingCount()).toBe(1);

    releaseSecond();
    const releaseThird = await thirdAcquire;

    expect(order).toEqual(['first', 'second', 'third']);
    expect(waitingCount()).toBe(0);

    releaseThird();

    expect(isLocked()).toBe(false);
  });

  it('waitingCount reflects queue depth', async () => {
    const releaseFirst = await acquire();

    const secondAcquire = acquire();
    const thirdAcquire = acquire();
    const fourthAcquire = acquire();

    expect(waitingCount()).toBe(3);

    releaseFirst();
    const releaseSecond = await secondAcquire;
    releaseSecond();

    const releaseThird = await thirdAcquire;
    releaseThird();

    const releaseFourth = await fourthAcquire;
    releaseFourth();

    expect(isLocked()).toBe(false);
    expect(waitingCount()).toBe(0);
  });

  it('_reset clears all state', async () => {
    const releaseFirst = await acquire();
    const blockedAcquire = acquire(25).catch((error) => error);

    expect(isLocked()).toBe(true);
    expect(waitingCount()).toBe(1);

    _reset();

    expect(isLocked()).toBe(false);
    expect(waitingCount()).toBe(0);

    const timeoutError = await blockedAcquire;
    expect(timeoutError).toBeInstanceOf(Error);
    expect(timeoutError.message).toBe('CommitMutex: acquire timeout');

    releaseFirst();
    expect(isLocked()).toBe(false);
  });
});
