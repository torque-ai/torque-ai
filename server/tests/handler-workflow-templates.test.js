const workflowEngine = require('../db/workflow-engine');
const taskCore = require('../db/task-core');
const providerRoutingCore = require('../db/provider/routing-core');
const schedulingAutomation = require('../db/scheduling-automation');
const workflowHandlers = require('../handlers/workflow');
const handlers = require('../handlers/workflow/templates');

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

describe('workflow-templates handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('handleCreateWorkflowTemplate', () => {
    it('returns CONFLICT when template name already exists', () => {
      vi.spyOn(workflowEngine, 'getWorkflowTemplateByName').mockReturnValue({ id: 'tmpl-1' });

      const result = handlers.handleCreateWorkflowTemplate({
        name: 'existing-template',
        task_definitions: [],
        dependency_graph: {}
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('CONFLICT');
      expect(textOf(result)).toContain('already exists');
    });

    it('creates a template and includes variable names in output', () => {
      vi.spyOn(workflowEngine, 'getWorkflowTemplateByName').mockReturnValue(null);
      const createSpy = vi.spyOn(workflowEngine, 'createWorkflowTemplate').mockReturnValue(undefined);

      const result = handlers.handleCreateWorkflowTemplate({
        name: 'build-template',
        description: 'Build and test',
        task_definitions: [
          { node_id: 'build', task_description: 'Build {{project}}' }
        ],
        dependency_graph: {},
        variables: { project: 'default-app' }
      });

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.any(String),
        name: 'build-template',
        description: 'Build and test',
        variables: { project: 'default-app' }
      }));
      expect(textOf(result)).toContain('Workflow Template Created');
      expect(textOf(result)).toContain('build-template');
      expect(textOf(result)).toContain('**Variables:** project');
    });
  });

  describe('handleListWorkflowTemplates', () => {
    it('returns empty message when no templates exist', () => {
      vi.spyOn(workflowEngine, 'listWorkflowTemplates').mockReturnValue([]);
      const result = handlers.handleListWorkflowTemplates({});
      expect(textOf(result)).toContain('No workflow templates found');
    });

    it('uses safe default limit when limit is invalid', () => {
      const listSpy = vi.spyOn(workflowEngine, 'listWorkflowTemplates').mockReturnValue([
        { name: 'tmpl-a', description: 'A', task_definitions: [{}, {}] }
      ]);

      const result = handlers.handleListWorkflowTemplates({
        filter: 'tmpl',
        limit: 'not-a-number'
      });

      expect(listSpy).toHaveBeenCalledWith({
        filter: 'tmpl',
        limit: 20
      });
      expect(textOf(result)).toContain('Workflow Templates');
      expect(textOf(result)).toContain('| tmpl-a | 2 | A |');
    });
  });

  describe('handleInstantiateTemplate', () => {
    it('returns TEMPLATE_NOT_FOUND when template is missing', () => {
      vi.spyOn(workflowEngine, 'getWorkflowTemplate').mockReturnValue(null);
      vi.spyOn(workflowEngine, 'getWorkflowTemplateByName').mockReturnValue(null);

      const result = handlers.handleInstantiateTemplate({ template_id: 'missing-template' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('rejects templates with no task definitions before creating a workflow', () => {
      vi.spyOn(workflowEngine, 'getWorkflowTemplate').mockReturnValue({
        id: 'tmpl-empty',
        name: 'empty-template',
        description: 'No task defs',
        task_definitions: [],
        dependency_graph: {}
      });
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue(null);
      const createWorkflowSpy = vi.spyOn(workflowEngine, 'createWorkflow').mockReturnValue(undefined);

      const result = handlers.handleInstantiateTemplate({ template_id: 'tmpl-empty' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('has no task_definitions');
      expect(createWorkflowSpy).not.toHaveBeenCalled();
    });

    it('returns CONFLICT when an empty template instantiation would duplicate an existing placeholder', () => {
      vi.spyOn(workflowEngine, 'getWorkflowTemplate').mockReturnValue({
        id: 'tmpl-empty',
        name: 'empty-template',
        description: 'No task defs',
        task_definitions: [],
        dependency_graph: {}
      });
      vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue({
        id: 'wf-empty-template',
        status: 'pending'
      });

      const result = handlers.handleInstantiateTemplate({ template_id: 'tmpl-empty' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('CONFLICT');
      expect(textOf(result)).toContain('wf-empty-template');
    });

    it('instantiates from template name, substitutes variables, and wires dependencies', () => {
      const template = {
        id: 'tmpl-1',
        name: 'release-template',
        description: 'Release workflow',
        task_definitions: [
          {
            node_id: 'build',
            task_description: 'Build {{project}}',
            tags: ['{{project}}', 'ci'],
            timeout_minutes: 10,
            auto_approve: true
          },
          {
            node_id: 'deploy',
            task_description: 'Deploy {{project}} to {{env}}',
            tags: ['release-{{env}}']
          }
        ],
        dependency_graph: {
          deploy: [{ node: 'build', condition: 'exit_code == 0' }]
        }
      };

      vi.spyOn(workflowEngine, 'getWorkflowTemplate').mockReturnValue(null);
      vi.spyOn(workflowEngine, 'getWorkflowTemplateByName').mockReturnValue(template);
      const createWorkflowSpy = vi.spyOn(workflowEngine, 'createWorkflow').mockReturnValue(undefined);
      const createTaskSpy = vi.spyOn(taskCore, 'createTask').mockReturnValue(undefined);
      const addDepSpy = vi.spyOn(workflowEngine, 'addTaskDependency').mockReturnValue(undefined);
      const updateCountsSpy = vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);

      const result = handlers.handleInstantiateTemplate({
        template_id: 'release-template',
        variables: { project: 'payments-api' }
      });

      expect(createWorkflowSpy).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.any(String),
        name: expect.stringContaining('release-template'),
        description: 'Release workflow',
        template_id: 'tmpl-1'
      }));
      expect(createTaskSpy).toHaveBeenCalledWith(expect.objectContaining({
        workflow_node_id: 'build',
        status: 'pending',
        task_description: 'Build payments-api',
        tags: ['payments-api', 'ci']
      }));
      expect(createTaskSpy).toHaveBeenCalledWith(expect.objectContaining({
        workflow_node_id: 'deploy',
        status: 'blocked',
        task_description: 'Deploy payments-api to {{env}}',
        tags: ['release-{{env}}']
      }));
      expect(addDepSpy).toHaveBeenCalledWith(expect.objectContaining({
        workflow_id: expect.any(String),
        condition_expr: 'exit_code == 0',
        on_fail: 'skip'
      }));
      expect(updateCountsSpy).toHaveBeenCalledWith(expect.any(String));
      expect(textOf(result)).toContain('Workflow Created from Template');
      expect(textOf(result)).toContain('**Tasks Created:** 2');
    });

    it('auto-runs instantiated workflow when auto_run=true', () => {
      const template = {
        id: 'tmpl-2',
        name: 'quick-template',
        description: 'Quick workflow',
        task_definitions: [{ node_id: 'only', task_description: 'Only task' }],
        dependency_graph: {}
      };

      vi.spyOn(workflowEngine, 'getWorkflowTemplate').mockReturnValue(template);
      vi.spyOn(workflowEngine, 'createWorkflow').mockReturnValue(undefined);
      vi.spyOn(taskCore, 'createTask').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'addTaskDependency').mockReturnValue(undefined);
      vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
      const runSpy = vi.spyOn(workflowHandlers, 'handleRunWorkflow').mockReturnValue({
        content: [{ type: 'text', text: 'started' }]
      });

      const result = handlers.handleInstantiateTemplate({
        template_id: 'tmpl-2',
        auto_run: true,
        name: 'Custom Workflow Name'
      });

      expect(runSpy).toHaveBeenCalledWith({ workflow_id: expect.any(String) });
      expect(textOf(result)).toContain('Custom Workflow Name');
      expect(textOf(result)).toContain('**Status:** Running');
    });
  });

  describe('handleDeleteWorkflowTemplate', () => {
    it('returns TEMPLATE_NOT_FOUND when delete target is missing', () => {
      vi.spyOn(workflowEngine, 'deleteWorkflowTemplate').mockReturnValue(false);
      const result = handlers.handleDeleteWorkflowTemplate({ template_id: 'missing' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('returns confirmation when template is deleted', () => {
      vi.spyOn(workflowEngine, 'deleteWorkflowTemplate').mockReturnValue(true);
      const result = handlers.handleDeleteWorkflowTemplate({ template_id: 'tmpl-1' });
      expect(textOf(result)).toContain('Template deleted: tmpl-1');
    });
  });

  describe('handleCreateConditionalTemplate', () => {
    it('validates condition_type', () => {
      const result = handlers.handleCreateConditionalTemplate({
        template_id: 'tmpl-1',
        condition_type: 'loop',
        condition_expr: 'x == y'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('condition_type');
    });

    it('creates condition and includes then/else blocks in output', () => {
      vi.spyOn(providerRoutingCore, 'createTemplateCondition').mockReturnValue({ id: 'cond-1' });

      const result = handlers.handleCreateConditionalTemplate({
        template_id: 'tmpl-1',
        condition_type: 'if',
        condition_expr: 'env == "prod"',
        then_block: 'deploy production path',
        else_block: 'deploy staging path'
      });

      expect(textOf(result)).toContain('Conditional Template Created');
      expect(textOf(result)).toContain('cond-1');
      expect(textOf(result)).toContain('env == "prod"');
      expect(textOf(result)).toContain('**Then:** deploy production path');
      expect(textOf(result)).toContain('**Else:** deploy staging path');
    });
  });

  describe('handleTemplateLoop', () => {
    it('validates item count upper bound', () => {
      const result = handlers.handleTemplateLoop({
        template_id: 'tmpl-1',
        items: Array.from({ length: 101 }, (_, i) => `item-${i}`)
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('100 or fewer');
    });

    it('returns TEMPLATE_NOT_FOUND when template lookup fails', () => {
      vi.spyOn(schedulingAutomation, 'getTemplate').mockReturnValue(null);
      vi.spyOn(workflowEngine, 'getWorkflowTemplateByName').mockReturnValue(null);

      const result = handlers.handleTemplateLoop({
        template_id: 'missing-template',
        items: ['a', 'b']
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('expands loop tasks with escaped variable names and index substitution', () => {
      vi.spyOn(schedulingAutomation, 'getTemplate').mockReturnValue({
        task_template: 'echo ${item.name}-${index}'
      });
      const createTaskSpy = vi.spyOn(taskCore, 'createTask').mockReturnValue(undefined);

      const result = handlers.handleTemplateLoop({
        template_id: 'loop-template',
        items: ['alpha', 'beta'],
        variable_name: 'item.name',
        parallel: true
      });

      expect(createTaskSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
        id: expect.any(String),
        task_description: 'echo alpha-0',
        template_name: 'loop-template',
        status: 'queued'
      }));
      expect(createTaskSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
        id: expect.any(String),
        task_description: 'echo beta-1',
        template_name: 'loop-template',
        status: 'queued'
      }));
      expect(textOf(result)).toContain('Template Loop Executed');
      expect(textOf(result)).toContain('**Parallel:** true');
    });
  });
});
