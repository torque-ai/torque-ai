'use strict';

const mockWorkflowEngine = {
  getWorkflow: vi.fn(),
};

const mockConflictResolver = {
  resolveWorkflowConflicts: vi.fn(),
};

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/conflict-resolution-handlers')];
  installMock('../db/workflow-engine', mockWorkflowEngine);
  installMock('../execution/conflict-resolver', mockConflictResolver);
  installMock('../handlers/error-codes', require('../handlers/error-codes'));
  installMock('../handlers/shared', {
    ...require('../handlers/shared'),
    ErrorCodes: require('../handlers/error-codes').ErrorCodes,
    makeError: require('../handlers/error-codes').makeError,
  });
  return require('../handlers/conflict-resolution-handlers');
}

describe('conflict-resolution-handlers', () => {
  let handlers;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockWorkflowEngine.getWorkflow.mockReset();
    mockConflictResolver.resolveWorkflowConflicts.mockReset();
    handlers = loadHandlers();
  });

  describe('handleResolveWorkflowConflicts', () => {
    it('returns error when workflow_id is missing', () => {
      const result = handlers.handleResolveWorkflowConflicts({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when workflow_id is not a string', () => {
      const result = handlers.handleResolveWorkflowConflicts({ workflow_id: 123 });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when workflow is not found', () => {
      mockWorkflowEngine.getWorkflow.mockReturnValue(null);
      const result = handlers.handleResolveWorkflowConflicts({ workflow_id: 'wf-missing' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('returns conflict resolution result with merged files', () => {
      const workflow = { id: 'wf-1', name: 'Test Workflow' };
      mockWorkflowEngine.getWorkflow.mockReturnValue(workflow);
      mockConflictResolver.resolveWorkflowConflicts.mockReturnValue({
        merged: [
          { file_path: 'src/a.ts', task_ids: ['t1', 't2'], action: 'merge', strategy: 'append' },
        ],
        conflicts: [],
      });

      const result = handlers.handleResolveWorkflowConflicts({ workflow_id: 'wf-1' });

      expect(result.isError).toBeUndefined();
      expect(result.merged).toHaveLength(1);
      expect(result.conflicts).toHaveLength(0);
      expect(result.content[0].text).toContain('Test Workflow');
      expect(result.content[0].text).toContain('Merged files:** 1');
      expect(result.content[0].text).toContain('Manual conflicts:** 0');
      expect(mockConflictResolver.resolveWorkflowConflicts).toHaveBeenCalledWith('wf-1');
    });

    it('returns conflict resolution result with manual conflicts', () => {
      const workflow = { id: 'wf-2', name: 'Conflicted Workflow' };
      mockWorkflowEngine.getWorkflow.mockReturnValue(workflow);
      mockConflictResolver.resolveWorkflowConflicts.mockReturnValue({
        merged: [],
        conflicts: [
          { file_path: 'src/b.ts', task_ids: ['t3', 't4'], reason: 'overlapping edits' },
        ],
      });

      const result = handlers.handleResolveWorkflowConflicts({ workflow_id: 'wf-2' });

      expect(result.isError).toBeUndefined();
      expect(result.merged).toHaveLength(0);
      expect(result.conflicts).toHaveLength(1);
      expect(result.content[0].text).toContain('Manual Resolution Required');
    });

    it('shows no-conflict message when both arrays are empty', () => {
      const workflow = { id: 'wf-3', name: 'Clean Workflow' };
      mockWorkflowEngine.getWorkflow.mockReturnValue(workflow);
      mockConflictResolver.resolveWorkflowConflicts.mockReturnValue({
        merged: [],
        conflicts: [],
      });

      const result = handlers.handleResolveWorkflowConflicts({ workflow_id: 'wf-3' });

      expect(result.content[0].text).toContain('No conflicted files');
    });

    it('returns error when resolver throws', () => {
      const workflow = { id: 'wf-4', name: 'Error Workflow' };
      mockWorkflowEngine.getWorkflow.mockReturnValue(workflow);
      mockConflictResolver.resolveWorkflowConflicts.mockImplementation(() => {
        throw new Error('Resolver crashed');
      });

      const result = handlers.handleResolveWorkflowConflicts({ workflow_id: 'wf-4' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INTERNAL_ERROR');
    });
  });
});
