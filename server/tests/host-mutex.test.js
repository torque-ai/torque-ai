'use strict';

const { acquireHostLock } = require('../providers/host-mutex');

describe('host-mutex', () => {
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
});
