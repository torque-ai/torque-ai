'use strict';
/* global describe, it, expect, beforeAll, afterAll, beforeEach */

const Database = require('better-sqlite3');

const hostComplexity = require('../db/host/complexity');
const { setupTestDbOnly, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');
const { DEFAULT_FALLBACK_MODEL } = require('../constants');

function insertConfig(key, value) {
  rawDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

function createAlternateDb(config = {}) {
  const conn = new Database(':memory:');
  conn.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)');

  const stmt = conn.prepare('INSERT INTO config (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(config)) {
    stmt.run(key, String(value));
  }

  return conn;
}

describe('db/host/complexity (real DB)', () => {
  beforeAll(() => {
    setupTestDbOnly('db-host-cx');
    hostComplexity.setDb(rawDb());
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    resetTables('config');
    hostComplexity.setDb(rawDb());
  });

  describe('setDb and getModelTierForComplexity', () => {
    it('setDb switches config reads to the provided sqlite handle', () => {
      insertConfig('ollama_fast_model', 'raw-fast:model');
      const alternateDb = createAlternateDb({
        ollama_fast_model: 'alt-fast:model',
      });

      try {
        hostComplexity.setDb(alternateDb);

        expect(hostComplexity.getModelTierForComplexity('simple')).toMatchObject({
          tier: 'fast',
          modelConfig: 'alt-fast:model',
        });

        hostComplexity.setDb(rawDb());

        expect(hostComplexity.getModelTierForComplexity('simple')).toMatchObject({
          tier: 'fast',
          modelConfig: 'raw-fast:model',
        });
      } finally {
        hostComplexity.setDb(rawDb());
        alternateDb.close();
      }
    });

    it.each([
      ['simple', 'ollama_fast_model', 'fast', 'fast:model', 'Fast 8B model for docs, comments, simple renames'],
      ['normal', 'ollama_balanced_model', 'balanced', 'balanced:model', 'Balanced 22B model for single-file code, tests, explanations'],
      ['complex', 'ollama_quality_model', 'quality', 'quality:model', 'Quality 32B model for multi-file changes, complex logic'],
    ])('returns the configured %s model tier', (complexity, key, tier, modelConfig, description) => {
      insertConfig(key, modelConfig);

      expect(hostComplexity.getModelTierForComplexity(complexity)).toEqual({
        tier,
        modelConfig,
        description,
      });
    });

    it('uses the static fallback model when no model config is present', () => {
      expect(hostComplexity.getModelTierForComplexity('simple')).toEqual({
        tier: 'fast',
        modelConfig: DEFAULT_FALLBACK_MODEL,
        description: 'Fast 8B model for docs, comments, simple renames',
      });
    });

    it('falls back to the quality tier for unknown complexity values', () => {
      insertConfig('ollama_quality_model', 'quality:model');

      expect(hostComplexity.getModelTierForComplexity('unexpected')).toEqual({
        tier: 'quality',
        modelConfig: 'quality:model',
        description: 'Quality 32B model for multi-file changes, complex logic',
      });
    });
  });

  describe('determineTaskComplexity', () => {
    it('returns simple for documentation tasks', () => {
      expect(
        hostComplexity.determineTaskComplexity('write a runbook for routing diagnostics', ['docs.md'])
      ).toBe('simple');
    });

    it('returns normal for test-writing tasks', () => {
      expect(
        hostComplexity.determineTaskComplexity('write unit tests for host selection', ['host-selection.test.js'])
      ).toBe('normal');
    });

    it('returns normal for stub-fill tasks', () => {
      expect(
        hostComplexity.determineTaskComplexity('replace throw not implemented in the cache helpers', ['cache.js'])
      ).toBe('normal');
    });

    it('returns complex for multi-step wiring work', () => {
      expect(
        hostComplexity.determineTaskComplexity(
          'create a notification service and wire it to dependency injection',
          ['NotificationService.cs', 'Program.cs']
        )
      ).toBe('complex');
    });

    it('returns complex when the task description has five bullet points', () => {
      const taskDescription = [
        '- gather inputs',
        '- normalize values',
        '- validate dependencies',
        '- update handlers',
        '- record outcomes',
      ].join('\n');

      expect(hostComplexity.determineTaskComplexity(taskDescription, ['a.js', 'b.js'])).toBe('complex');
    });

    it('returns simple for a short single-file request', () => {
      expect(hostComplexity.determineTaskComplexity('rename host var', ['host.js'])).toBe('simple');
    });

    it('returns complex when more than five files are involved', () => {
      expect(
        hostComplexity.determineTaskComplexity('keep naming consistent across modules', [
          'a.js',
          'b.js',
          'c.js',
          'd.js',
          'e.js',
          'f.js',
        ])
      ).toBe('complex');
    });

    it('returns complex for descriptions longer than 500 characters', () => {
      expect(hostComplexity.determineTaskComplexity('x'.repeat(501), ['a.js', 'b.js'])).toBe('complex');
    });

    it('returns normal when no special patterns match', () => {
      expect(
        hostComplexity.determineTaskComplexity(
          'adjust the module so naming stays consistent with current conventions',
          ['a.js', 'b.js']
        )
      ).toBe('normal');
    });
  });

  describe('decomposeTask', () => {
    it('returns null for non-string task descriptions', () => {
      expect(hostComplexity.decomposeTask(null, 'src/services')).toBeNull();
    });

    it('decomposes service implementation tasks', () => {
      expect(hostComplexity.decomposeTask('implement a billing service', 'src/services')).toEqual([
        'Create file src/services/IBillingService.cs with interface IBillingService containing method signatures: Process(), Initialize(), and Dispose()',
        'Create file src/services/BillingService.cs implementing IBillingService with the core logic',
        'Add BillingService registration to dependency injection in src/services (find existing DI setup or create ServiceExtensions.cs)',
      ]);
    });

    it('decomposes build-with feature tasks', () => {
      expect(
        hostComplexity.decomposeTask('build a notification service with retry policies', 'src/services')
      ).toEqual([
        'Create file src/services/Notification.cs with a public class Notification containing private fields and a constructor',
        'Add public methods to src/services/Notification.cs for the core functionality',
        'Add retry policies to the Notification class in src/services/Notification.cs',
      ]);
    });

    it('decomposes create-and-wire tasks', () => {
      expect(
        hostComplexity.decomposeTask('create a notification service and wire it', 'src/services')
      ).toEqual([
        'Create file src/services/INotification.cs with interface INotification defining the contract',
        'Create file src/services/Notification.cs implementing INotification with core methods',
        'Register Notification in dependency injection container (find startup/DI config in src/services)',
      ]);
    });

    it('decomposes full workflow tasks', () => {
      expect(hostComplexity.decomposeTask('implement the full payment workflow', 'src/workflows')).toEqual([
        'Create file src/workflows/PaymentHandler.cs with class PaymentHandler containing a Handle() method as entry point',
        'Add validation and core logic methods to src/workflows/PaymentHandler.cs',
        'Add error handling with try-catch and result types to src/workflows/PaymentHandler.cs',
      ]);
    });

    it('decomposes API endpoint tasks', () => {
      expect(
        hostComplexity.decomposeTask('build an API endpoint for audit log entries', 'src/api')
      ).toEqual([
        'Create file src/api/AuditLogEntriesController.cs with route handlers for GET, POST, PUT, DELETE',
        'Create file src/api/AuditLogEntriesRequest.cs and AuditLogEntriesResponse.cs with DTOs and validation attributes',
        'Add business logic service methods that the controller will call',
      ]);
    });

    it('decomposes multi-provider implementation tasks', () => {
      expect(hostComplexity.decomposeTask('implement a notification with email and sms', 'src/providers')).toEqual([
        'Create file src/providers/INotificationProvider.cs with interface defining Send() method',
        'Create file src/providers/EmailNotificationProvider.cs implementing INotificationProvider for email',
        'Create file src/providers/SmsNotificationProvider.cs implementing INotificationProvider for sms',
      ]);
    });

    it('returns null when no decomposition pattern matches', () => {
      expect(hostComplexity.decomposeTask('rename the provider for clarity', 'src/services')).toBeNull();
    });
  });

  describe('getSplitAdvisory', () => {
    it('returns true for complex work spanning three files', () => {
      expect(hostComplexity.getSplitAdvisory('complex', ['a.ts', 'b.ts', 'c.ts'])).toBe(true);
    });

    it('returns false for complex work with too few files', () => {
      expect(hostComplexity.getSplitAdvisory('complex', ['a.ts'])).toBe(false);
    });

    it('returns false for non-complex work even with many files', () => {
      expect(hostComplexity.getSplitAdvisory('normal', ['a', 'b', 'c', 'd', 'e'])).toBe(false);
    });

    it('returns false when files are omitted', () => {
      expect(hostComplexity.getSplitAdvisory('complex')).toBe(false);
    });
  });
});
