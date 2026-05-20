'use strict';

const {
  acquireHostLock,
  getHostLockSnapshot,
  _resetHostLocksForTests,
} = require('../providers/host-mutex');

describe('host-mutex', () => {
  beforeEach(() => {
    _resetHostLocksForTests();
  });

  afterEach(() => {
    _resetHostLocksForTests();
  });

  it('serializes concurrent operations on the same host', async () => {
    const order = [];

    const run = async (id, delayMs) => {
      const release = await acquireHostLock('test-host');
      order.push(`start-${id}`);
      await new Promise(r => setTimeout(r, delayMs));
      order.push(`end-${id}`);
      release();
    };

    // Launch two concurrent operations on the same host
    const p1 = run('A', 50);
    const p2 = run('B', 10);

    await Promise.all([p1, p2]);

    // A should start and finish before B starts
    expect(order).toEqual(['start-A', 'end-A', 'start-B', 'end-B']);
  });

  it('allows concurrent operations on different hosts', async () => {
    const order = [];

    const run = async (hostId, id, delayMs) => {
      const release = await acquireHostLock(hostId);
      order.push(`start-${id}`);
      await new Promise(r => setTimeout(r, delayMs));
      order.push(`end-${id}`);
      release();
    };

    // Launch two concurrent operations on DIFFERENT hosts
    const p1 = run('host-1', 'A', 50);
    const p2 = run('host-2', 'B', 10);

    await Promise.all([p1, p2]);

    // B should finish before A (different hosts, no serialization)
    expect(order[0]).toBe('start-A');
    expect(order[1]).toBe('start-B');
    expect(order[2]).toBe('end-B');
    expect(order[3]).toBe('end-A');
  });

  it('serializes three tasks on the same host in order', async () => {
    const order = [];

    const run = async (id) => {
      const release = await acquireHostLock('serial-host');
      order.push(id);
      await new Promise(r => setTimeout(r, 10));
      release();
    };

    await Promise.all([run('1'), run('2'), run('3')]);

    expect(order).toEqual(['1', '2', '3']);
  });

  it('release allows next waiter to proceed', async () => {
    let secondStarted = false;

    const release1 = await acquireHostLock('release-test');

    const p2 = acquireHostLock('release-test').then(release2 => {
      secondStarted = true;
      release2();
    });

    expect(secondStarted).toBe(false);
    release1();
    await p2;
    expect(secondStarted).toBe(true);
  });

  it('removes an aborted waiter without blocking later waiters', async () => {
    const release1 = await acquireHostLock('abort-wait-host', { taskId: 'holder' });
    const controller = new AbortController();
    const abortedWaiter = acquireHostLock('abort-wait-host', {
      taskId: 'waiter',
      signal: controller.signal,
    });

    await new Promise(resolve => setImmediate(resolve));
    expect(getHostLockSnapshot('abort-wait-host')).toEqual(expect.objectContaining({
      holder: expect.objectContaining({ taskId: 'holder' }),
      queueLength: 1,
    }));

    controller.abort();
    await expect(abortedWaiter).rejects.toMatchObject({
      name: 'AbortError',
      code: 'HOST_LOCK_ABORTED',
    });
    expect(getHostLockSnapshot('abort-wait-host')).toEqual(expect.objectContaining({
      holder: expect.objectContaining({ taskId: 'holder' }),
      queueLength: 0,
    }));

    let thirdStarted = false;
    const third = acquireHostLock('abort-wait-host', { taskId: 'third' }).then(release3 => {
      thirdStarted = true;
      release3();
    });

    expect(thirdStarted).toBe(false);
    release1();
    await third;
    expect(thirdStarted).toBe(true);
    expect(getHostLockSnapshot('abort-wait-host')).toEqual({
      holder: null,
      queueLength: 0,
      waiters: [],
    });
  });

  it('releases an acquired lock when the holder signal aborts', async () => {
    const controller = new AbortController();
    const release1 = await acquireHostLock('abort-held-host', {
      taskId: 'holder',
      signal: controller.signal,
    });
    const order = [];

    const second = acquireHostLock('abort-held-host', { taskId: 'second' }).then(release2 => {
      order.push('second');
      release2();
    });

    await new Promise(resolve => setImmediate(resolve));
    expect(getHostLockSnapshot('abort-held-host')).toEqual(expect.objectContaining({
      holder: expect.objectContaining({ taskId: 'holder' }),
      queueLength: 1,
    }));

    controller.abort();
    await second;

    expect(order).toEqual(['second']);
    release1();
    expect(getHostLockSnapshot('abort-held-host')).toEqual({
      holder: null,
      queueLength: 0,
      waiters: [],
    });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(acquireHostLock('pre-aborted-host', {
      taskId: 'pre-aborted',
      signal: controller.signal,
    })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'HOST_LOCK_ABORTED',
    });

    expect(getHostLockSnapshot('pre-aborted-host')).toEqual({
      holder: null,
      queueLength: 0,
      waiters: [],
    });
  });

  it('makes release idempotent and advances the queue once', async () => {
    const order = [];
    const release1 = await acquireHostLock('idempotent-release-host', { taskId: 'first' });
    const second = acquireHostLock('idempotent-release-host', { taskId: 'second' }).then(release2 => {
      order.push('second');
      release2();
    });

    release1();
    release1();
    await second;

    expect(order).toEqual(['second']);
    expect(getHostLockSnapshot('idempotent-release-host')).toEqual({
      holder: null,
      queueLength: 0,
      waiters: [],
    });
  });
});
