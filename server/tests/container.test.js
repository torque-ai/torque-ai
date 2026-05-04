'use strict';

const { createContainer } = require('../container');

describe('container', () => {
  let container;

  beforeEach(() => {
    container = createContainer();
  });

  describe('register + get', () => {
    it('registers and retrieves a service', () => {
      container.register('logger', [], () => ({ info: () => {} }));
      container.boot();
      expect(container.get('logger')).toBeDefined();
      expect(container.get('logger').info).toBeInstanceOf(Function);
    });

    it('throws on get before boot', () => {
      container.register('logger', [], () => ({ info: () => {} }));
      expect(() => container.get('logger')).toThrow(/boot/i);
    });

    it('throws on get for unknown service', () => {
      container.boot();
      expect(() => container.get('nonexistent')).toThrow(/not registered/i);
    });
  });

  describe('dependency injection', () => {
    it('injects dependencies into factory', () => {
      container.register('config', [], () => ({ port: 3000 }));
      container.register('server', ['config'], ({ config }) => ({
        port: config.port,
        start: () => {},
      }));
      container.boot();
      expect(container.get('server').port).toBe(3000);
    });

    it('resolves transitive dependencies', () => {
      container.register('a', [], () => ({ name: 'a' }));
      container.register('b', ['a'], ({ a }) => ({ name: 'b', a }));
      container.register('c', ['b'], ({ b }) => ({ name: 'c', b }));
      container.boot();
      const c = container.get('c');
      expect(c.b.a.name).toBe('a');
    });
  });

  describe('topological sort', () => {
    it('detects circular dependencies', () => {
      container.register('a', ['b'], () => ({}));
      container.register('b', ['a'], () => ({}));
      expect(() => container.boot()).toThrow(/circular/i);
    });

    it('detects missing dependencies', () => {
      container.register('a', ['missing'], () => ({}));
      expect(() => container.boot()).toThrow(/missing/i);
    });

    it('boots services in dependency order', () => {
      const order = [];
      container.register('c', ['b'], () => { order.push('c'); return {}; });
      container.register('a', [], () => { order.push('a'); return {}; });
      container.register('b', ['a'], () => { order.push('b'); return {}; });
      container.boot();
      expect(order).toEqual(['a', 'b', 'c']);
    });
  });

  describe('freeze', () => {
    it('prevents registration after boot', () => {
      container.boot();
      expect(() => container.register('late', [], () => ({}))).toThrow(/frozen|boot/i);
    });

    it('throws if called before boot', () => {
      expect(() => container.freeze()).toThrow(/boot/i);
    });
  });

  describe('resetForTest', () => {
    it('resets the container to a fresh state', () => {
      container.register('svc', [], () => ({ id: Math.random() }));
      container.boot();
      const id1 = container.get('svc').id;
      container.resetForTest();
      container.boot();
      const id2 = container.get('svc').id;
      expect(id2).not.toBe(id1);
    });
  });

  describe('registerValue', () => {
    it('registers a pre-built value (no factory)', () => {
      container.registerValue('eventBus', { emit: () => {} });
      container.boot();
      expect(container.get('eventBus').emit).toBeInstanceOf(Function);
    });
  });

  describe('has', () => {
    it('returns true for registered services', () => {
      container.register('svc', [], () => ({}));
      expect(container.has('svc')).toBe(true);
    });

    it('returns false for unregistered services', () => {
      expect(container.has('nope')).toBe(false);
    });
  });

  describe('list', () => {
    it('returns all registered service names', () => {
      container.register('a', [], () => ({}));
      container.register('b', ['a'], () => ({}));
      container.boot();
      expect(container.list().sort()).toEqual(['a', 'b']);
    });
  });

  describe('dispose', () => {
    it('runs dispose() on services in reverse-topo order', async () => {
      const order = [];
      container.register('a', [], () => ({
        dispose: () => { order.push('a-disposed'); },
      }));
      container.register('b', ['a'], () => ({
        dispose: () => { order.push('b-disposed'); },
      }));
      container.register('c', ['b'], () => ({
        dispose: () => { order.push('c-disposed'); },
      }));
      container.boot();

      await container.dispose();
      // Reverse topo: dependents (c) shut down before their deps (a)
      expect(order).toEqual(['c-disposed', 'b-disposed', 'a-disposed']);
    });

    it('skips services that do not expose a dispose method', async () => {
      container.register('plain', [], () => ({ value: 1 })); // no dispose
      let withDisposeCalled = false;
      container.register('withDispose', [], () => ({
        dispose: () => { withDisposeCalled = true; },
      }));
      container.boot();
      await container.dispose();
      expect(withDisposeCalled).toBe(true);
    });

    it('awaits async dispose handlers', async () => {
      let asyncDoneAt = 0;
      container.register('async', [], () => ({
        dispose: () => new Promise((resolve) => {
          setTimeout(() => { asyncDoneAt = Date.now(); resolve(); }, 10);
        }),
      }));
      container.boot();
      const start = Date.now();
      await container.dispose();
      expect(asyncDoneAt).toBeGreaterThanOrEqual(start);
    });

    it('continues after a dispose throws; reports errored names', async () => {
      const calls = [];
      container.register('a', [], () => ({
        dispose: () => { calls.push('a'); },
      }));
      container.register('b', ['a'], () => ({
        dispose: () => { calls.push('b-throws'); throw new Error('boom'); },
      }));
      container.register('c', ['b'], () => ({
        dispose: () => { calls.push('c'); },
      }));
      container.boot();

      const result = await container.dispose();
      expect(result.errored).toEqual(['b']);
      // All three were attempted, in reverse-topo order
      expect(calls).toEqual(['c', 'b-throws', 'a']);
    });

    it('returns container to pre-boot state — re-boot works', async () => {
      let count = 0;
      container.register('svc', [], () => {
        count += 1;
        return { generation: count };
      });
      container.boot();
      expect(container.get('svc').generation).toBe(1);

      await container.dispose();

      container.boot();
      expect(container.get('svc').generation).toBe(2);
    });

    it('lifts a previous freeze() so dispose + re-boot pattern works', async () => {
      container.register('svc', [], () => ({}));
      container.boot();
      container.freeze();
      await container.dispose();
      // After dispose, container is unfrozen and re-bootable
      container.register('svc2', [], () => ({ ok: true }));
      container.boot();
      expect(container.get('svc2')).toEqual({ ok: true });
    });

    it('is a no-op when called before boot()', async () => {
      const result = await container.dispose();
      expect(result.errored).toEqual([]);
    });
  });

  describe('boot({ failFast })', () => {
    it('throws synchronously by default when a factory fails', () => {
      container.register('bad', [], () => { throw new Error('boom'); });
      expect(() => container.boot()).toThrow(/boom/);
    });

    it('with failFast=false, logs and continues; returns failed names', () => {
      container.register('good', [], () => ({ ok: true }));
      container.register('bad', [], () => { throw new Error('boom'); });
      const result = container.boot({ failFast: false });
      expect(result.failed).toEqual(['bad']);
      expect(container.get('good')).toEqual({ ok: true });
      // The failed service has no instance — get() throws.
      expect(() => container.get('bad')).toThrow(/not registered/i);
    });

    it('with failFast=false, dependents of a failed service receive undefined dep', () => {
      // Documented behavior: a dependent of a failed factory will see
      // `undefined` for its missing dep. If the dependent's own factory
      // crashes as a result, it gets logged + reported in `failed` too.
      container.register('bad', [], () => { throw new Error('boom'); });
      container.register('depends', ['bad'], ({ bad }) => {
        if (!bad) throw new Error('missing dep');
        return { bad };
      });
      const result = container.boot({ failFast: false });
      expect(result.failed.sort()).toEqual(['bad', 'depends']);
    });

    it('clean boot returns empty failed array', () => {
      container.register('a', [], () => ({}));
      const result = container.boot();
      expect(result.failed).toEqual([]);
    });
  });

  describe('override', () => {
    it('replaces a service before boot — dependents resolve the override', () => {
      container.register('db', [], () => ({ real: true }));
      container.register('store', ['db'], ({ db }) => ({ db }));
      container.override('db', { mock: true });
      container.boot();
      expect(container.get('store').db).toEqual({ mock: true });
      expect(container.get('db')).toEqual({ mock: true });
    });

    it('replaces a cached instance after boot for subsequent get() calls', () => {
      container.register('db', [], () => ({ real: true }));
      container.boot();
      expect(container.get('db')).toEqual({ real: true });
      container.override('db', { mock: true });
      expect(container.get('db')).toEqual({ mock: true });
    });

    it('does not re-resolve dependents that already resolved before override', () => {
      // Documented behavior: post-boot override only affects subsequent
      // get(name) calls. Dependents that captured `db` via closure during
      // boot keep the original reference. Tests that need late-binding
      // should look up the dep via container.get(...) inside their methods.
      container.register('db', [], () => ({ real: true }));
      container.register('store', ['db'], ({ db }) => ({
        getDb: () => db, // captures via closure
      }));
      container.boot();
      const store = container.get('store');
      container.override('db', { mock: true });
      expect(store.getDb()).toEqual({ real: true });
      expect(container.get('db')).toEqual({ mock: true });
    });

    it('refuses to override after freeze()', () => {
      container.boot();
      container.freeze();
      expect(() => container.override('x', { mock: true })).toThrow(/freeze/i);
    });

    it('can introduce a brand-new name pre-boot for tests', () => {
      // Useful pattern: a test sets up a mock for a name the production
      // container hasn't registered yet (e.g. while a feature is being
      // migrated). The override seeds it as a pre-built value.
      container.override('experimentalThing', { ok: true });
      container.boot();
      expect(container.get('experimentalThing')).toEqual({ ok: true });
    });
  });
});
