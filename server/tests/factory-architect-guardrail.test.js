'use strict';

const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');

let projectId;

describe('architect stuck-dimension guardrail', () => {
  beforeAll(() => {
    setupTestDb('architect-guardrail');
    const project = factoryHealth.registerProject({
      name: 'GuardrailTarget',
      path: '/tmp/guardrail-target',
      trust_level: 'supervised',
    });
    projectId = project.id;
  });

  afterAll(() => {
    teardownTestDb();
  });

  test('listResolvedWorkItems returns completed and shipped items only', () => {
    factoryIntake.createWorkItem({ project_id: projectId, source: 'manual', title: 'done item', status: 'completed' });
    factoryIntake.createWorkItem({ project_id: projectId, source: 'manual', title: 'shipped item', status: 'shipped' });
    factoryIntake.createWorkItem({ project_id: projectId, source: 'manual', title: 'stale shipped item', status: 'shipped_stale' });
    factoryIntake.createWorkItem({ project_id: projectId, source: 'manual', title: 'pending item', status: 'pending' });
    factoryIntake.createWorkItem({ project_id: projectId, source: 'manual', title: 'rejected item', status: 'rejected' });

    const resolved = factoryIntake.listResolvedWorkItems({ project_id: projectId });
    const titles = resolved.map(i => i.title);
    expect(titles).toContain('done item');
    expect(titles).toContain('shipped item');
    expect(titles).toContain('stale shipped item');
    expect(titles).not.toContain('pending item');
    expect(titles).not.toContain('rejected item');
  });
});
