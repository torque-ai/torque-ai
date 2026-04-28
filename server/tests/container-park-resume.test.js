'use strict';
/* global describe, it, expect, beforeEach */

const { createContainer, defaultContainer } = require('../container');

describe('container — park-resume handler wiring', () => {
  it('exposes parkResumeHandler in the DI registry (pre-boot)', () => {
    expect(defaultContainer.has('parkResumeHandler')).toBe(true);
  });

  it('park-resume-handler module exports a factory function', () => {
    const mod = require('../factory/park-resume-handler');
    expect(typeof mod.createParkResumeHandler).toBe('function');
  });

  describe('runtime behaviour (fresh container with in-memory db)', () => {
    let container;
    let handlers;
    let eventBus;

    beforeEach(() => {
      const Database = require('better-sqlite3');
      const rawDb = new Database(':memory:');
      rawDb.prepare(
        'CREATE TABLE IF NOT EXISTS factory_work_items ' +
        '(id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL DEFAULT \'pending\', updated_at TEXT)'
      ).run();

      handlers = {};
      eventBus = {
        on(event, handler) {
          if (!handlers[event]) handlers[event] = [];
          handlers[event].push(handler);
        },
        _emit(event, payload) {
          (handlers[event] || []).forEach(function(h) { h(payload); });
        },
      };

      container = createContainer();
      container.registerValue('db', rawDb);
      container.registerValue('eventBus', eventBus);
      container.registerValue('logger', { info: function() {}, warn: function() {} });

      container.register(
        'parkResumeHandler',
        ['db', 'eventBus', 'logger'],
        function(deps) {
          const db = deps.db;
          const eb = deps.eventBus;
          const log = deps.logger;
          const mod = require('../factory/park-resume-handler');
          return mod.createParkResumeHandler({ db: db, eventBus: eb, logger: log });
        }
      );

      container.boot();
    });

    it('parkResumeHandler is constructible without throwing', () => {
      expect(() => container.get('parkResumeHandler')).not.toThrow();
    });

    it('subscribed handler responds to circuit:recovered for codex without throwing', () => {
      container.get('parkResumeHandler');
      expect(() => eventBus._emit('circuit:recovered', { provider: 'codex', reason: 'smoke' })).not.toThrow();
    });

    it('ignores circuit:recovered for non-codex providers', () => {
      container.get('parkResumeHandler');
      expect(() => eventBus._emit('circuit:recovered', { provider: 'groq' })).not.toThrow();
    });
  });
});
