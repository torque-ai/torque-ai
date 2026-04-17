'use strict';

const { describe, it, expect, vi } = require('vitest');
const { createSandboxManager } = require('../sandbox/sandbox-manager');

describe('sandboxManager', () => {
  it('registerBackend + create routes to the named backend', async () => {
    const fakeBackend = {
      create: vi.fn(async () => ({ sandboxId: 'sb-1', backend: 'fake' })),
    };
    const mgr = createSandboxManager();

    mgr.registerBackend('fake', fakeBackend);
    const sb = await mgr.create({ backend: 'fake', image: 'x' });

    expect(sb.sandboxId).toBe('sb-1');
    expect(fakeBackend.create).toHaveBeenCalledWith({ image: 'x' });
  });

  it('throws on unknown backend', async () => {
    const mgr = createSandboxManager();
    await expect(mgr.create({ backend: 'nope' })).rejects.toThrow(/unknown/i);
  });

  it('list returns all active sandboxes; destroy removes them', async () => {
    let counter = 0;
    const backend = {
      create: vi.fn(async () => ({ sandboxId: `sb-${counter++}`, backend: 'fake' })),
      destroy: vi.fn(async () => ({ destroyed: true })),
    };
    const mgr = createSandboxManager();

    mgr.registerBackend('fake', backend);
    const a = await mgr.create({ backend: 'fake' });
    await mgr.create({ backend: 'fake' });

    expect(mgr.list().length).toBe(2);

    await mgr.destroy(a.sandboxId);

    expect(mgr.list().length).toBe(1);
  });
});
