'use strict';

const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { recordExperience, findRelatedExperiences } = require('../experience/store');

describe('experience store', () => {
  beforeAll(() => {
    setupTestDb('experience-store');
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('records and retrieves similar experiences', async () => {
    await recordExperience({
      project: 'p',
      task_description: 'Add a database migration to create users table',
      output_summary: 'Created migration 0042_users.sql',
      files_modified: ['db/migrations/0042_users.sql'],
      provider: 'codex',
    });

    await recordExperience({
      project: 'p',
      task_description: 'Refactor logger to use pino',
      output_summary: 'Migrated all logger.info calls',
      files_modified: ['logger.js'],
      provider: 'codex',
    });

    const related = await findRelatedExperiences({
      project: 'p',
      task_description: 'Add a database migration for posts table',
      top_k: 1,
      min_similarity: 0.1,
    });

    expect(related).toHaveLength(1);
    expect(related[0].task_description).toMatch(/database migration/i);
  });
});
