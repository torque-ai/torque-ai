'use strict';

const realShared = require('../handlers/shared');

const mockUuid = {
  v4: vi.fn(() => 'mock-uuid-123')
};

const mockDb = {
  getWorkflowTemplateByName: vi.fn(),
  createWorkflowTemplate: vi.fn(),
  listWorkflowTemplates: vi.fn(),
  getWorkflowTemplate: vi.fn(),
  deleteWorkflowTemplate: vi.fn(),
  createWorkflow: vi.fn(),
  addWorkflowTask: vi.fn(),
  findEmptyWorkflowPlaceholder: vi.fn(),
  createTask: vi.fn(),
  addTaskDependency: vi.fn(),
  updateWorkflowCounts: vi.fn(),
  createTemplateCondition: vi.fn(),
  getTemplate: vi.fn()
};

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/workflow/templates')];
  installMock('uuid', mockUuid);
  installMock('../database', mockDb);
  installMock('../handlers/shared', realShared);
  return require('../handlers/workflow/templates');
}

function resetMocks() {
  mockUuid.v4.mockReset();
  mockUuid.v4.mockImplementation(() => 'mock-uuid-123');

  Object.values(mockDb).forEach((fn) => {
    if (fn && typeof fn.mockReset === 'function') {
      fn.mockReset();
    }
  });
}

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

describe('workflow template handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMocks();
    handlers = loadHandlers();
  });

  describe('handleCreateWorkflowTemplate', () => {
    it('returns CONFLICT when the template name already exists', () => {
      mockDb.getWorkflowTemplateByName.mockReturnValue({ id: 'tmpl-existing' });

      const result = handlers.handleCreateWorkflowTemplate({
        name: 'release-template',
        description: 'Duplicate template',
        task_definitions: [{ node_id: 'build', task_description: 'Build project' }],
        dependency_graph: {}
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('CONFLICT');
      expect(textOf(result)).toContain("Template with name 'release-template' already exists");
      expect(mockDb.createWorkflowTemplate).not.toHaveBeenCalled();
    });

    it('creates a workflow template successfully', () => {
      mockDb.getWorkflowTemplateByName.mockReturnValue(null);

      const result = handlers.handleCreateWorkflowTemplate({
        name: 'release-template',
        description: 'Build and deploy',
        task_definitions: [
          { node_id: 'build', task_description: 'Build {{project}}' },
          { node_id: 'deploy', task_description: 'Deploy {{project}}' }
        ],
        dependency_graph: {
          deploy: [{ node: 'build' }]
        },
        variables: {
          project: 'torque'
        }
      });

      expect(mockDb.createWorkflowTemplate).toHaveBeenCalledWith({
        id: 'mock-uuid-123',
        name: 'release-template',
        description: 'Build and deploy',
        task_definitions: [
          { node_id: 'build', task_description: 'Build {{project}}' },
          { node_id: 'deploy', task_description: 'Deploy {{project}}' }
        ],
        dependency_graph: {
          deploy: [{ node: 'build' }]
        },
        variables: {
          project: 'torque'
        }
      });
      expect(textOf(result)).toContain('## Workflow Template Created');
      expect(textOf(result)).toContain('**ID:** mock-uuid-123');
      expect(textOf(result)).toContain('**Tasks:** 2');
      expect(textOf(result)).toContain('**Variables:** project');
    });
  });

  describe('handleListWorkflowTemplates', () => {
    it('returns a markdown table of templates', () => {
      mockDb.listWorkflowTemplates.mockReturnValue([
        {
          name: 'release-template',
          description: 'Build, test, and deploy the release train',
          task_definitions: [{}, {}]
        },
        {
          name: 'lint-template',
          description: null,
          task_definitions: [{}]
        }
      ]);

      const result = handlers.handleListWorkflowTemplates({
        filter: 'template',
        limit: 5
      });

      expect(mockDb.listWorkflowTemplates).toHaveBeenCalledWith({
        filter: 'template',
        limit: 5
      });
      expect(textOf(result)).toContain('## Workflow Templates');
      expect(textOf(result)).toContain('| release-template | 2 | Build, test, and deploy the release trai |');
      expect(textOf(result)).toContain('| lint-template | 1 | - |');
    });

    it('returns an empty-state message when no templates exist', () => {
      mockDb.listWorkflowTemplates.mockReturnValue([]);

      const result = handlers.handleListWorkflowTemplates({});

      expect(textOf(result)).toContain('No workflow templates found.');
    });
  });

  describe('handleInstantiateTemplate', () => {
    it('returns TEMPLATE_NOT_FOUND when the template does not exist', () => {
      mockDb.getWorkflowTemplate.mockReturnValue(null);
      mockDb.getWorkflowTemplateByName.mockReturnValue(null);

      const result = handlers.handleInstantiateTemplate({
        template_id: 'missing-template'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TEMPLATE_NOT_FOUND');
      expect(textOf(result)).toContain('Template not found: missing-template');
      expect(mockDb.createWorkflow).not.toHaveBeenCalled();
    });

    it('creates a workflow and tasks from the template successfully', () => {
      mockUuid.v4
        .mockReturnValueOnce('workflow-uuid')
        .mockReturnValueOnce('task-build-uuid')
        .mockReturnValueOnce('task-deploy-uuid');

      mockDb.getWorkflowTemplate.mockReturnValue({
        id: 'tmpl-1',
        name: 'release-template',
        description: 'Release workflow',
        task_definitions: [
          {
            node_id: 'build',
            task_description: 'Build {{project}}',
            timeout_minutes: 15,
            auto_approve: true,
            tags: ['{{project}}', 'build']
          },
          {
            node_id: 'deploy',
            task_description: 'Deploy {{project}} to {{env}}',
            tags: ['release']
          }
        ],
        dependency_graph: {
          deploy: [{ node: 'build', condition: 'exit_code == 0', on_fail: 'cancel' }]
        }
      });

      const result = handlers.handleInstantiateTemplate({
        template_id: 'tmpl-1',
        name: 'Release Friday',
        variables: {
          project: 'billing-api',
          env: 'prod'
        }
      });

      expect(mockDb.createWorkflow).toHaveBeenCalledWith({
        id: 'workflow-uuid',
        name: 'Release Friday',
        description: 'Release workflow',
        template_id: 'tmpl-1'
      });
      expect(mockDb.createTask).toHaveBeenNthCalledWith(1, {
        id: 'task-build-uuid',
        status: 'pending',
        task_description: 'Build billing-api',
        timeout_minutes: 15,
        auto_approve: true,
        tags: ['billing-api', 'build'],
        workflow_id: 'workflow-uuid',
        workflow_node_id: 'build'
      });
      expect(mockDb.createTask).toHaveBeenNthCalledWith(2, {
        id: 'task-deploy-uuid',
        status: 'blocked',
        task_description: 'Deploy billing-api to prod',
        timeout_minutes: 30,
        auto_approve: false,
        tags: ['release'],
        workflow_id: 'workflow-uuid',
        workflow_node_id: 'deploy'
      });
      expect(mockDb.addTaskDependency).toHaveBeenCalledWith({
        workflow_id: 'workflow-uuid',
        task_id: 'task-deploy-uuid',
        depends_on_task_id: 'task-build-uuid',
        condition_expr: 'exit_code == 0',
        on_fail: 'cancel'
      });
      expect(mockDb.updateWorkflowCounts).toHaveBeenCalledWith('workflow-uuid');
      expect(textOf(result)).toContain('## Workflow Created from Template');
      expect(textOf(result)).toContain('**Workflow ID:** workflow-uuid');
      expect(textOf(result)).toContain('**Tasks Created:** 2');
      expect(mockDb.addWorkflowTask).not.toHaveBeenCalled();
    });
  });

  describe('handleDeleteWorkflowTemplate', () => {
    it('returns TEMPLATE_NOT_FOUND when the template cannot be deleted', () => {
      mockDb.deleteWorkflowTemplate.mockReturnValue(false);

      const result = handlers.handleDeleteWorkflowTemplate({
        template_id: 'missing-template'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TEMPLATE_NOT_FOUND');
      expect(textOf(result)).toContain('Template not found: missing-template');
    });

    it('deletes a workflow template successfully', () => {
      mockDb.deleteWorkflowTemplate.mockReturnValue(true);

      const result = handlers.handleDeleteWorkflowTemplate({
        template_id: 'tmpl-1'
      });

      expect(textOf(result)).toContain('Template deleted: tmpl-1');
    });
  });

  describe('handleCreateConditionalTemplate', () => {
    it('validates the condition structure', () => {
      const result = handlers.handleCreateConditionalTemplate({
        template_id: 'tmpl-1',
        condition_type: 'loop',
        condition_expr: 'env == "prod"'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('condition_type must be "if", "switch", or "when"');
      expect(mockDb.createTemplateCondition).not.toHaveBeenCalled();
    });

    it('creates a conditional template definition with then and else blocks', () => {
      mockDb.createTemplateCondition.mockReturnValue({ id: 'condition-uuid' });

      const result = handlers.handleCreateConditionalTemplate({
        template_id: 'tmpl-1',
        condition_type: 'if',
        condition_expr: 'env == "prod"',
        then_block: 'deploy production path',
        else_block: 'deploy staging path'
      });

      expect(mockDb.createTemplateCondition).toHaveBeenCalledWith({
        id: 'mock-uuid-123',
        template_id: 'tmpl-1',
        condition_type: 'if',
        condition_expr: 'env == "prod"',
        then_block: 'deploy production path',
        else_block: 'deploy staging path'
      });
      expect(textOf(result)).toContain('## Conditional Template Created');
      expect(textOf(result)).toContain('**Condition ID:** `condition-uuid`');
      expect(textOf(result)).toContain('**Expression:** `env == "prod"`');
      expect(textOf(result)).toContain('**Then:** deploy production path...');
      expect(textOf(result)).toContain('**Else:** deploy staging path...');
    });
  });

  describe('handleTemplateLoop', () => {
    it('validates the iteration count upper bound', () => {
      const result = handlers.handleTemplateLoop({
        template_id: 'tmpl-loop',
        items: Array.from({ length: 101 }, (_, index) => `item-${index}`)
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('items must have 100 or fewer elements');
      expect(mockDb.createTask).not.toHaveBeenCalled();
    });

    it('creates queued tasks for each loop iteration', () => {
      mockUuid.v4
        .mockReturnValueOnce('loop-task-1')
        .mockReturnValueOnce('loop-task-2')
        .mockReturnValueOnce('loop-task-3');

      mockDb.getTemplate.mockReturnValue({
        task_template: 'Process ${item.name} at ${index}'
      });

      const result = handlers.handleTemplateLoop({
        template_id: 'tmpl-loop',
        items: ['alpha', 'beta', 'gamma'],
        variable_name: 'item.name',
        parallel: true
      });

      expect(mockDb.createTask).toHaveBeenCalledTimes(3);
      expect(mockDb.createTask).toHaveBeenNthCalledWith(1, {
        id: 'loop-task-1',
        task_description: 'Process alpha at 0',
        template_name: 'tmpl-loop',
        status: 'queued'
      });
      expect(mockDb.createTask).toHaveBeenNthCalledWith(2, {
        id: 'loop-task-2',
        task_description: 'Process beta at 1',
        template_name: 'tmpl-loop',
        status: 'queued'
      });
      expect(mockDb.createTask).toHaveBeenNthCalledWith(3, {
        id: 'loop-task-3',
        task_description: 'Process gamma at 2',
        template_name: 'tmpl-loop',
        status: 'queued'
      });
      expect(textOf(result)).toContain('## Template Loop Executed');
      expect(textOf(result)).toContain('**Items:** 3');
      expect(textOf(result)).toContain('**Variable:** `item.name`');
      expect(textOf(result)).toContain('**Parallel:** true');
    });
  });
});
