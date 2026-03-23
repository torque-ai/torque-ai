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
});
