'use strict';

const { describe, it, expect } = require('vitest');
const { createTestContainer } = require('./test-container');

describe('createTestContainer', () => {
  it('returns a booted container with db access', () => {
    const { container, db } = createTestContainer();
    expect(container.get('db')).toBeDefined();
    expect(container.get('dbInstance')).toBeDefined();
    expect(db.getDbInstance()).toBeDefined();
  });

  it('provides isolated database state', () => {
    const { db: db1 } = createTestContainer();
    db1.createTask({
      id: 'isolation-test-1',
      task_description: 'test task for isolation',
      working_directory: '/tmp/test',
      status: 'queued',
      priority: 0,
    });

    const { db: db2 } = createTestContainer();
    const tasks = db2.listTasks({ limit: 100 });
    // Second container should have a clean slate
    expect(tasks.length).toBe(0);
  });

  it('has core db modules registered', () => {
    const { container } = createTestContainer();
    expect(container.get('taskCore')).toBeDefined();
    expect(container.get('configCore')).toBeDefined();
    expect(container.get('hostManagement')).toBeDefined();
    expect(container.get('workflowEngine')).toBeDefined();
    expect(container.get('coordination')).toBeDefined();
    expect(container.get('providerRoutingCore')).toBeDefined();
  });

  it('has stateless utility modules registered', () => {
    const { container } = createTestContainer();
    expect(container.get('configKeys')).toBeDefined();
    expect(container.get('queryFilters')).toBeDefined();
    expect(container.get('schemaSeeds')).toBeDefined();
  });

  it('container lists all registered services', () => {
    const { container } = createTestContainer();
    const services = container.list();
    expect(services.length).toBeGreaterThan(30);
    expect(services).toContain('db');
    expect(services).toContain('taskCore');
    expect(services).toContain('configCore');
  });
});
