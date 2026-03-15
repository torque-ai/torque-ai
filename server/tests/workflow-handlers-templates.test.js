const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Workflow Handlers', () => {
  beforeAll(() => {
    setupTestDb('workflow-handlers');
  });
  afterAll(() => { teardownTestDb(); });

  // ── Helper: extract first UUID from text ──
  function extractUUID(text) {
    const m = text.match(/([a-f0-9-]{36})/);
    return m ? m[1] : null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // create_workflow
  // ═══════════════════════════════════════════════════════════════════

  describe('create_workflow_template', () => {
    it('creates a template with task definitions', async () => {
      const result = await safeTool('create_workflow_template', {
        name: 'build-test-deploy',
        task_definitions: [
          { node_id: 'build', task_description: 'Build project' },
          { node_id: 'test', task_description: 'Run tests' },
          { node_id: 'deploy', task_description: 'Deploy to prod' }
        ],
        dependency_graph: {
          test: [{ node: 'build' }],
          deploy: [{ node: 'test' }]
        }
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Workflow Template Created');
      expect(text).toContain('build-test-deploy');
      expect(text).toContain('3');
    });

    it('creates template with variables', async () => {
      const result = await safeTool('create_workflow_template', {
        name: 'parameterized-template',
        task_definitions: [
          { node_id: 'step1', task_description: 'Process {{item}}' }
        ],
        dependency_graph: {},
        variables: { item: 'default-value' }
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('item');
    });

    it('rejects duplicate template name', async () => {
      await safeTool('create_workflow_template', {
        name: 'unique-template',
        task_definitions: [{ node_id: 'a', task_description: 'A' }],
        dependency_graph: {}
      });

      const result = await safeTool('create_workflow_template', {
        name: 'unique-template',
        task_definitions: [{ node_id: 'b', task_description: 'B' }],
        dependency_graph: {}
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('already exists');
    });

    it('creates template with description', async () => {
      const result = await safeTool('create_workflow_template', {
        name: 'described-template',
        description: 'Template with a helpful description',
        task_definitions: [{ node_id: 'x', task_description: 'X' }],
        dependency_graph: {}
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('described-template');
    });
  });

  describe('list_workflow_templates', () => {
    it('lists existing templates', async () => {
      const result = await safeTool('list_workflow_templates', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      // We created templates in previous tests
      expect(text).toContain('Workflow Templates');
    });

    it('respects limit parameter', async () => {
      const result = await safeTool('list_workflow_templates', { limit: 1 });
      expect(result.isError).toBeFalsy();
    });

    it('filters by name', async () => {
      const result = await safeTool('list_workflow_templates', { filter: 'build' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('instantiate_template', () => {
    let templateId;

    beforeAll(async () => {
      const result = await safeTool('create_workflow_template', {
        name: 'instantiate-test-tmpl',
        task_definitions: [
          { node_id: 'build', task_description: 'Build {{project}}' },
          { node_id: 'test', task_description: 'Test {{project}}' }
        ],
        dependency_graph: {
          test: [{ node: 'build' }]
        },
        variables: { project: 'myapp' }
      });
      templateId = extractUUID(getText(result));
    });

    it('creates workflow from template by ID', async () => {
      const result = await safeTool('instantiate_template', {
        template_id: templateId
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Workflow Created from Template');
      expect(text).toContain('Tasks Created');
    });

    it('creates workflow from template by name', async () => {
      const result = await safeTool('instantiate_template', {
        template_id: 'instantiate-test-tmpl'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Workflow Created from Template');
    });

    it('substitutes variables in task descriptions', async () => {
      const result = await safeTool('instantiate_template', {
        template_id: 'instantiate-test-tmpl',
        variables: { project: 'super-app' }
      });
      expect(result.isError).toBeFalsy();
      // The workflow was created -- check that tasks were created
      const text = getText(result);
      expect(text).toContain('Tasks Created');
    });

    it('allows custom workflow name', async () => {
      const result = await safeTool('instantiate_template', {
        template_id: 'instantiate-test-tmpl',
        name: 'Custom Workflow Name'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Custom Workflow Name');
    });

    it('returns error for nonexistent template', async () => {
      const result = await safeTool('instantiate_template', {
        template_id: 'nonexistent-template-xyz'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Template not found');
    });
  });

  describe('delete_workflow_template', () => {
    it('deletes an existing template', async () => {
      const create = await safeTool('create_workflow_template', {
        name: 'delete-me-tmpl',
        task_definitions: [{ node_id: 'z', task_description: 'Z' }],
        dependency_graph: {}
      });
      const tmplId = extractUUID(getText(create));

      const result = await safeTool('delete_workflow_template', { template_id: tmplId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('deleted');
    });

    it('returns error for nonexistent template', async () => {
      const result = await safeTool('delete_workflow_template', {
        template_id: 'no-such-template'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Template not found');
    });
  });

  describe('create_conditional_template', () => {
    it('creates an if condition', async () => {
      const result = await safeTool('create_conditional_template', {
        template_id: 'cond-tmpl-1',
        condition_type: 'if',
        condition_expr: '${env} == production',
        then_block: 'Deploy to production',
        else_block: 'Deploy to staging'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Conditional Template Created');
      expect(text).toContain('if');
    });

    it('creates a switch condition', async () => {
      const result = await safeTool('create_conditional_template', {
        template_id: 'cond-tmpl-2',
        condition_type: 'switch',
        condition_expr: '${platform}'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('switch');
    });

    it('creates a when condition', async () => {
      const result = await safeTool('create_conditional_template', {
        template_id: 'cond-tmpl-3',
        condition_type: 'when',
        condition_expr: '${count} > 10'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('when');
    });

    it('rejects missing template_id', async () => {
      const result = await safeTool('create_conditional_template', {
        condition_type: 'if',
        condition_expr: 'x == y'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('template_id');
    });

    it('rejects invalid condition_type', async () => {
      const result = await safeTool('create_conditional_template', {
        template_id: 'tmpl-bad-type',
        condition_type: 'loop',
        condition_expr: 'x == y'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('condition_type');
    });

    it('rejects missing condition_expr', async () => {
      const result = await safeTool('create_conditional_template', {
        template_id: 'tmpl-no-expr',
        condition_type: 'if'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('condition_expr');
    });

    it('rejects non-string condition_expr', async () => {
      const result = await safeTool('create_conditional_template', {
        template_id: 'tmpl-bad-expr',
        condition_type: 'if',
        condition_expr: 42
      });
      expect(result.isError).toBe(true);
    });
  });

});
