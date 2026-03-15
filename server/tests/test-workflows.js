/**
 * Workflow & Pipeline Tests
 */

const { setupTestDb, teardownTestDb, safeTool } = require('./vitest-setup');
const { uniqueId } = require('./test-helpers');

describe('Workflows & Pipelines', () => {
  beforeAll(() => { setupTestDb('workflows'); });
  afterAll(() => { teardownTestDb(); });

  describe('Workflow Creation', () => {
    it('create_workflow creates workflow', async () => {
      const result = await safeTool('create_workflow', {
        name: uniqueId('workflow'),
        description: 'Test workflow',
        tasks: [{ node_id: 'wf-smoke', task_description: 'Smoke workflow task' }]
      });
      expect(result.isError).toBeFalsy();
    });

    it('create_workflow rejects empty name', async () => {
      const result = await safeTool('create_workflow', { name: '' });
      expect(result.isError).toBe(true);
    });

    it('create_workflow rejects missing tasks', async () => {
      const result = await safeTool('create_workflow', {
        name: uniqueId('workflow-no-tasks')
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('Workflow Listing', () => {
    it('list_workflows returns results', async () => {
      const result = await safeTool('list_workflows', { limit: 10 });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('Pipelines', () => {
    it('create_pipeline creates pipeline', async () => {
      const result = await safeTool('create_pipeline', {
        name: uniqueId('pipeline'),
        steps: [
          { name: 'build', task_template: 'Build the project' },
          { name: 'test', task_template: 'Run tests' }
        ]
      });
      expect(result.isError).toBeFalsy();
    });

    it('create_pipeline rejects empty steps', async () => {
      const result = await safeTool('create_pipeline', {
        name: 'empty',
        steps: []
      });
      expect(result.isError).toBe(true);
    });

    it('list_pipelines returns pipelines', async () => {
      const result = await safeTool('list_pipelines', {});
      expect(result.isError).toBeFalsy();
    });
  });

  describe('Workflow Templates', () => {
    it('list_workflow_templates returns results', async () => {
      const result = await safeTool('list_workflow_templates', {});
      expect(result.isError).toBeFalsy();
    });
  });
});
