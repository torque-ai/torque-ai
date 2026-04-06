'use strict';

/**
 * Unit Tests: auto-role-assigner -- assigns roles to discovered models by parameter size
 *
 * Uses an in-memory SQLite DB with model_registry and model_roles tables.
 */

const Database = require('better-sqlite3');
const { assignRolesForProvider } = require('../discovery/auto-role-assigner');
const { TEST_MODELS } = require('./test-helpers');

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS model_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      parameter_size_b REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      updated_at TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS model_roles (
      provider TEXT NOT NULL,
      role TEXT NOT NULL,
      model_name TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (provider, role)
    )
  `);

  return db;
}

function insertModel(db, provider, modelName, parameterSizeB, status) {
  if (status === undefined) status = 'approved';
  db.prepare(`
    INSERT INTO model_registry (provider, model_name, parameter_size_b, status, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(provider, modelName, parameterSizeB, status);
}

function insertRole(db, provider, role, modelName) {
  db.prepare(`
    INSERT INTO model_roles (provider, role, model_name, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(provider, role, modelName);
}

function getRole(db, provider, role) {
  return db.prepare('SELECT model_name FROM model_roles WHERE provider = ? AND role = ?').get(provider, role);
}

describe('assignRolesForProvider', () => {
  it('assigns fast to a 4B model, balanced to a 14B model, quality to a 32B model', () => {
    const db = makeDb();
    insertModel(db, 'ollama', 'gemma3:4b', 4);
    insertModel(db, 'ollama', 'deepseek-r1:14b', 14);
    insertModel(db, 'ollama', TEST_MODELS.QUALITY, 32);

    const result = assignRolesForProvider(db, 'ollama');

    const roles = Object.fromEntries(result.map(r => [r.role, r]));
    expect(roles.fast.model).toBe('gemma3:4b');
    expect(roles.fast.size).toBe(4);
    expect(roles.balanced.model).toBe('deepseek-r1:14b');
    expect(roles.balanced.size).toBe(14);
    expect(roles.quality.model).toBe(TEST_MODELS.QUALITY);
    expect(roles.quality.size).toBe(32);

    expect(getRole(db, 'ollama', 'fast').model_name).toBe('gemma3:4b');
    expect(getRole(db, 'ollama', 'balanced').model_name).toBe('deepseek-r1:14b');
    expect(getRole(db, 'ollama', 'quality').model_name).toBe(TEST_MODELS.QUALITY);
  });

  it('does NOT overwrite an existing role assignment when the model is still alive (status=approved)', () => {
    const db = makeDb();
    insertModel(db, 'ollama', 'gemma3:4b', 4);
    insertModel(db, 'ollama', TEST_MODELS.FAST, 3.8);
    insertRole(db, 'ollama', 'fast', 'gemma3:4b');

    const result = assignRolesForProvider(db, 'ollama');

    const fastAssignment = result.find(r => r.role === 'fast');
    expect(fastAssignment).toBeUndefined();
    expect(getRole(db, 'ollama', 'fast').model_name).toBe('gemma3:4b');
  });

  it('replaces a role if the existing model is no longer in the registry (status=removed)', () => {
    const db = makeDb();
    insertModel(db, 'ollama', 'old-small-model:4b', 4, 'removed');
    insertModel(db, 'ollama', TEST_MODELS.FAST, 3.8, 'approved');
    insertRole(db, 'ollama', 'fast', 'old-small-model:4b');

    const result = assignRolesForProvider(db, 'ollama');

    const fastAssignment = result.find(r => r.role === 'fast');
    expect(fastAssignment).toBeDefined();
    expect(fastAssignment.model).toBe(TEST_MODELS.FAST);
    expect(getRole(db, 'ollama', 'fast').model_name).toBe(TEST_MODELS.FAST);
  });

  it('assigns default role to the largest available model if no default exists', () => {
    const db = makeDb();
    insertModel(db, 'ollama', 'gemma3:4b', 4);
    insertModel(db, 'ollama', 'deepseek-r1:14b', 14);
    insertModel(db, 'ollama', TEST_MODELS.QUALITY, 32);

    const result = assignRolesForProvider(db, 'ollama');

    const defaultAssignment = result.find(r => r.role === 'default');
    expect(defaultAssignment).toBeDefined();
    expect(defaultAssignment.model).toBe(TEST_MODELS.QUALITY);
    expect(defaultAssignment.size).toBe(32);
    expect(getRole(db, 'ollama', 'default').model_name).toBe(TEST_MODELS.QUALITY);
  });

  it('returns a summary array of assignments made: [{role, model, size}]', () => {
    const db = makeDb();
    insertModel(db, 'ollama', TEST_MODELS.FAST, 3.8);

    const result = assignRolesForProvider(db, 'ollama');

    expect(Array.isArray(result)).toBe(true);
    for (const item of result) {
      expect(item).toHaveProperty('role');
      expect(item).toHaveProperty('model');
      expect(item).toHaveProperty('size');
      expect(typeof item.role).toBe('string');
      expect(typeof item.model).toBe('string');
      expect(typeof item.size).toBe('number');
    }
  });

  it('returns empty array when no approved models exist', () => {
    const db = makeDb();
    insertModel(db, 'ollama', 'pending-model:7b', 7, 'pending');
    insertModel(db, 'ollama', 'denied-model:14b', 14, 'denied');

    const result = assignRolesForProvider(db, 'ollama');

    expect(result).toEqual([]);
  });

  it('returns empty array when provider has no models at all', () => {
    const db = makeDb();
    const result = assignRolesForProvider(db, 'ollama');
    expect(result).toEqual([]);
  });

  it('does not assign roles for a different provider', () => {
    const db = makeDb();
    insertModel(db, 'deepinfra', 'llama3.1:70b', 70);

    const result = assignRolesForProvider(db, 'ollama');
    expect(result).toEqual([]);

    const result2 = assignRolesForProvider(db, 'deepinfra');
    expect(result2.length).toBeGreaterThan(0);
    expect(result2.find(r => r.role === 'quality')).toBeDefined();
  });

  it('handles models with null parameter_size_b by skipping them for role candidates', () => {
    const db = makeDb();
    insertModel(db, 'ollama', 'mystery-model:latest', null);

    const result = assignRolesForProvider(db, 'ollama');
    expect(result).toEqual([]);
  });
});
