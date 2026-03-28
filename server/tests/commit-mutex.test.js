'use strict';

const { CommitMutex } = require('../utils/commit-mutex');

let mutex;

beforeEach(() => {
  mutex = new CommitMutex();
});

describe('commit-mutex', () => {
  it('acquire returns a release function, isLocked() is true while held', async () => {
    const release = await mutex.acquire();

    expect(typeof release).toBe('function');
    expect(mutex.isLocked()).toBe(true);
    expect(mutex.waitingCount()).toBe(0);

    release();
  });

  it('release makes isLocked() false', async () => {
    const release = await mutex.acquire();
    release();

    expect(mutex.isLocked()).toBe(false);
    expect(mutex.waitingCount()).toBe(0);
  });

  it('serializes concurrent acquires', async () => {
    const releaseFirst = await mutex.acquire();
    let secondAcquired = false;

    const secondAcquire = mutex.acquire().then((releaseSecond) => {
      secondAcquired = true;
      return releaseSecond;
    });

    expect(secondAcquired).toBe(false);
    expect(mutex.waitingCount()).toBe(1);

    releaseFirst();

    const releaseSecond = await secondAcquire;

    expect(secondAcquired).toBe(true);
    expect(mutex.isLocked()).toBe(true);
    expect(mutex.waitingCount()).toBe(0);

    releaseSecond();

    expect(mutex.isLocked()).toBe(false);
  });

  it('times out when mutex held too long', async () => {
    const releaseFirst = await mutex.acquire();
    const blockedAcquire = mutex.acquire(40);

    await expect(blockedAcquire).rejects.toThrow('CommitMutex: acquire timeout');
    expect(mutex.waitingCount()).toBe(0);
    expect(mutex.isLocked()).toBe(true);

    releaseFirst();

    expect(mutex.isLocked()).toBe(false);
  });

  it('FIFO ordering', async () => {
    const order = [];
    const releaseFirst = await mutex.acquire();
    order.push('first');

    const secondAcquire = mutex.acquire().then((releaseSecond) => {
      order.push('second');
      return releaseSecond;
    });

    const thirdAcquire = mutex.acquire().then((releaseThird) => {
      order.push('third');
      return releaseThird;
    });

    expect(mutex.waitingCount()).toBe(2);

    releaseFirst();
    const releaseSecond = await secondAcquire;

    expect(order).toEqual(['first', 'second']);
    expect(mutex.waitingCount()).toBe(1);

    releaseSecond();
    const releaseThird = await thirdAcquire;

    expect(order).toEqual(['first', 'second', 'third']);
    expect(mutex.waitingCount()).toBe(0);

    releaseThird();

    expect(mutex.isLocked()).toBe(false);
  });

  it('waitingCount reflects queue depth', async () => {
    const releaseFirst = await mutex.acquire();

    const secondAcquire = mutex.acquire();
    const thirdAcquire = mutex.acquire();
    const fourthAcquire = mutex.acquire();

    expect(mutex.waitingCount()).toBe(3);

    releaseFirst();
    const releaseSecond = await secondAcquire;
    releaseSecond();

    const releaseThird = await thirdAcquire;
    releaseThird();

    const releaseFourth = await fourthAcquire;
    releaseFourth();

    expect(mutex.isLocked()).toBe(false);
    expect(mutex.waitingCount()).toBe(0);
  });

  it('double-release is a no-op', async () => {
    const release = await mutex.acquire();

    expect(mutex.isLocked()).toBe(true);
    expect(mutex.waitingCount()).toBe(0);

    release();
    expect(mutex.isLocked()).toBe(false);

    release();
    expect(mutex.isLocked()).toBe(false);
  });
});
