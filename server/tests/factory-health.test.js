import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const path = require('path');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const factoryHealth = require('../db/factory-health');

let testDir;

describe('factory health database handle', () => {
  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`factory-health-${Date.now()}`));
  });

  afterEach(() => {
    factoryHealth.setDb(null);
    teardownTestDb();
  });

  test('falls back to the active database module when its module handle is cleared', () => {
    factoryHealth.setDb(null);

    const project = factoryHealth.registerProject({
      name: 'Fallback DB',
      path: path.join(testDir, 'repo'),
      trust_level: 'supervised',
    });

    expect(factoryHealth.getProject(project.id)).toMatchObject({
      id: project.id,
      name: 'Fallback DB',
    });
  });
});
