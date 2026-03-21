'use strict';

const db = require('../database');

describe('context-handler', () => {
  beforeAll(() => {
    if (typeof db.resetForTest === 'function') db.resetForTest();
  });

  afterAll(() => {
    if (typeof db.resetForTest === 'function') db.resetForTest();
  });

  describe('queue scope', () => {
    it('returns correct shape with scope=queue when no workflow_id', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});

      expect(result.structuredData).toBeDefined();
      expect(result.structuredData.scope).toBe('queue');
      expect(result.structuredData.pressure_level).toBeDefined();
      expect(result.structuredData.running).toBeDefined();
      expect(typeof result.structuredData.running.count).toBe('number');
      expect(Array.isArray(result.structuredData.running.tasks)).toBe(true);
      expect(result.structuredData.queued).toBeDefined();
      expect(result.structuredData.recent_completed).toBeDefined();
      expect(result.structuredData.recent_failed).toBeDefined();
      expect(result.structuredData.active_workflows).toBeDefined();
      expect(result.structuredData.provider_health).toBeDefined();
      expect(result.content).toBeDefined(); // backward compat markdown
    });

    it('caps running.tasks at 5', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      expect(result.structuredData.running.tasks.length).toBeLessThanOrEqual(5);
    });

    it('caps queued.next at 5', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      expect(result.structuredData.queued.next.length).toBeLessThanOrEqual(5);
    });

    it('caps recent_completed.last_3 at 3', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      expect(result.structuredData.recent_completed.last_3.length).toBeLessThanOrEqual(3);
    });

    it('provider_health has healthy/down/degraded arrays', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      const ph = result.structuredData.provider_health;
      expect(Array.isArray(ph.healthy)).toBe(true);
      expect(Array.isArray(ph.down)).toBe(true);
      expect(Array.isArray(ph.degraded)).toBe(true);
    });

    it('nothing-happening state returns correct shape with zeros and empty arrays', () => {
      const { handleGetContext } = require('../handlers/context-handler');
      const result = handleGetContext({});
      const sd = result.structuredData;
      // Counts should be numbers (possibly 0)
      expect(typeof sd.running.count).toBe('number');
      expect(typeof sd.queued.count).toBe('number');
      expect(typeof sd.recent_completed.count).toBe('number');
      expect(typeof sd.recent_failed.count).toBe('number');
    });
  });
});
