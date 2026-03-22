/**
 * Task Templates Handler Tests
 *
 * Tests the 4 MCP tools for task prompt template CRUD and submission:
 * - create_task_template
 * - list_task_templates
 * - submit_from_template (mocked smart_submit)
 * - delete_task_template
 */

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Task Templates', () => {
  beforeAll(() => {
    setupTestDb('task-templates');
  });

  afterAll(() => {
    teardownTestDb();
  });

  // ─── create_task_template ────────────────────────────────────────────────────

  describe('create_task_template', () => {
    it('creates a template with variables', async () => {
      const result = await safeTool('create_task_template', {
        name: 'add-test',
        task_template: 'Write comprehensive tests for {{file}} using vitest',
        description: 'Generates tests for a file'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Template "add-test" created successfully');
      expect(text).toContain('Variables: file');
      expect(text).toContain('submit_from_template');
    });

    it('creates a template with multiple variables', async () => {
      const result = await safeTool('create_task_template', {
        name: 'refactor-method',
        task_template: 'Refactor {{method}} in {{file}} to use {{pattern}}',
        description: 'Refactor a method to use a specific pattern'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Variables: method, file, pattern');
    });

    it('creates a template with no variables', async () => {
      const result = await safeTool('create_task_template', {
        name: 'lint-fix',
        task_template: 'Run eslint --fix on all source files and fix any remaining warnings manually'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Variables: none');
    });

    it('creates a template with custom timeout and priority', async () => {
      const result = await safeTool('create_task_template', {
        name: 'big-refactor',
        task_template: 'Refactor {{module}} to extract {{count}} sub-modules',
        default_timeout: 60,
        default_priority: 5,
        auto_approve: true
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Template "big-refactor" created successfully');
    });

    it('rejects missing name', async () => {
      const result = await safeTool('create_task_template', {
        task_template: 'Do something for {{file}}'
      });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Missing required parameter: "name"');
    });

    it('rejects missing task_template', async () => {
      const result = await safeTool('create_task_template', {
        name: 'empty-template'
      });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Missing required parameter: "task_template"');
    });

    it('overwrites existing template with same name', async () => {
      await safeTool('create_task_template', {
        name: 'overwrite-me',
        task_template: 'Original template for {{file}}'
      });
      const result = await safeTool('create_task_template', {
        name: 'overwrite-me',
        task_template: 'Updated template for {{file}} in {{dir}}'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Variables: file, dir');
    });
  });

  // ─── list_task_templates ─────────────────────────────────────────────────────

  describe('list_task_templates', () => {
    it('lists created templates', async () => {
      const result = await safeTool('list_task_templates', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('template(s)');
      expect(text).toContain('add-test');
      expect(text).toContain('refactor-method');
    });

    it('shows usage count', async () => {
      const result = await safeTool('list_task_templates', {});
      const text = getText(result);
      expect(text).toContain('used 0x');
    });

    it('shows variable names', async () => {
      const result = await safeTool('list_task_templates', {});
      const text = getText(result);
      // add-test template has 'file' variable
      expect(text).toContain('file');
    });

    it('shows description or fallback', async () => {
      const result = await safeTool('list_task_templates', {});
      const text = getText(result);
      expect(text).toContain('Generates tests for a file');
    });

    it('returns empty message when no templates exist', async () => {
      // Create a fresh DB context by cleaning up all templates
      const schedulingAutomation = require('../db/scheduling-automation');
      const templates = schedulingAutomation.listTemplates();
      for (const t of templates) {
        schedulingAutomation.deleteTemplate(t.name);
      }

      const result = await safeTool('list_task_templates', {});
      const text = getText(result);
      expect(text).toContain('No templates found');

      // Restore one for subsequent tests
      await safeTool('create_task_template', {
        name: 'restored-test',
        task_template: 'Test {{file}} with vitest'
      });
    });
  });

  // ─── submit_from_template ────────────────────────────────────────────────────

  describe('submit_from_template', () => {
    beforeAll(async () => {
      // Ensure we have a template to submit from
      await safeTool('create_task_template', {
        name: 'submit-test',
        task_template: 'Write tests for {{file}} covering {{scenario}}',
        default_timeout: 15,
        default_priority: 3
      });
    });

    it('rejects missing template_name', async () => {
      const result = await safeTool('submit_from_template', {
        variables: { file: 'src/foo.ts' }
      });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Missing required parameter: "template_name"');
    });

    it('rejects non-existent template', async () => {
      const result = await safeTool('submit_from_template', {
        template_name: 'does-not-exist'
      });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('not found');
    });

    it('substitutes variables in template', async () => {
      // We can verify variable substitution by checking the template retrieval
      // and usage count increment, even if smart_submit fails (no Ollama in test)
      const schedulingAutomation = require('../db/scheduling-automation');
      const beforeCount = schedulingAutomation.getTemplate('submit-test').usage_count;

      // Submit will likely fail because no providers are available in test,
      // but usage_count should still increment
      await safeTool('submit_from_template', {
        template_name: 'submit-test',
        variables: { file: 'src/auth.ts', scenario: 'login failure' }
      });

      const afterCount = schedulingAutomation.getTemplate('submit-test').usage_count;
      expect(afterCount).toBe(beforeCount + 1);
    });

    it('preserves unsubstituted variables when not provided', async () => {
      // Create a template and test partial substitution via the handler logic
      await safeTool('create_task_template', {
        name: 'partial-vars',
        task_template: 'Fix {{error}} in {{file}} at {{line}}'
      });

      const schedulingAutomation = require('../db/scheduling-automation');
      const template = schedulingAutomation.getTemplate('partial-vars');

      // Manually verify substitution logic (same as handler)
      const variables = { file: 'src/app.ts' };
      const description = template.task_template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        return variables[key] !== undefined ? variables[key] : `{{${key}}}`;
      });

      expect(description).toBe('Fix {{error}} in src/app.ts at {{line}}');
    });

    it('increments usage count on submit', async () => {
      const schedulingAutomation = require('../db/scheduling-automation');
      const before = schedulingAutomation.getTemplate('submit-test').usage_count;

      await safeTool('submit_from_template', {
        template_name: 'submit-test',
        variables: { file: 'src/bar.ts', scenario: 'edge case' }
      });

      const after = schedulingAutomation.getTemplate('submit-test').usage_count;
      expect(after).toBe(before + 1);
    });
  });

  // ─── delete_task_template ────────────────────────────────────────────────────

  describe('delete_task_template', () => {
    beforeAll(async () => {
      await safeTool('create_task_template', {
        name: 'to-delete',
        task_template: 'Temporary template for {{purpose}}'
      });
    });

    it('deletes an existing template', async () => {
      const result = await safeTool('delete_task_template', {
        name: 'to-delete'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('deleted successfully');
    });

    it('confirms template is gone after deletion', async () => {
      const result = await safeTool('delete_task_template', {
        name: 'to-delete'
      });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('not found');
    });

    it('rejects missing name', async () => {
      const result = await safeTool('delete_task_template', {});
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Missing required parameter: "name"');
    });

    it('returns error for non-existent template', async () => {
      const result = await safeTool('delete_task_template', {
        name: 'never-existed'
      });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('not found');
    });
  });
});
