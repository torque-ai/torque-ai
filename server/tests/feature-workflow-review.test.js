const featureWorkflow = require('../handlers/workflow/feature-workflow');
const workflowEngine = require('../db/workflow-engine');
const projectConfigCore = require('../db/project-config-core');
const taskCore = require('../db/task-core');

describe('handleCreateFeatureWorkflow adversarial review metadata', () => {
  function buildFeatureWorkflow(args) {
    return featureWorkflow.handleCreateFeatureWorkflow({
      feature_name: 'PlayerStats',
      working_directory: '/repo',
      types_task: 'Define types',
      events_task: 'Add events',
      data_task: 'Create data layer',
      system_task: 'Build system',
      tests_task: 'Write tests',
      wire_task: 'Wire dependencies',
      ...args,
    });
  }

  function getMetadataByNode(calls, nodeId) {
    const entry = calls.find((call) => call.workflow_node_id === nodeId);
    return entry?.metadata || null;
  }

  function hasAdversarialReview(metadata) {
    if (!metadata) {
      return false;
    }
    const parsed = JSON.parse(metadata);
    return Object.prototype.hasOwnProperty.call(parsed, 'adversarial_review');
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    featureWorkflow.init({
      startWorkflowExecution: vi.fn(),
      buildEmptyWorkflowCreationError: vi.fn(),
    });
    vi.spyOn(workflowEngine, 'findEmptyWorkflowPlaceholder').mockReturnValue(null);
    vi.spyOn(workflowEngine, 'createWorkflow').mockReturnValue(undefined);
    vi.spyOn(workflowEngine, 'addTaskDependency').mockReturnValue(undefined);
    vi.spyOn(workflowEngine, 'updateWorkflowCounts').mockReturnValue(undefined);
    vi.spyOn(taskCore, 'createTask').mockReturnValue(undefined);
    vi.spyOn(projectConfigCore, 'getProjectConfig').mockReturnValue({ adversarial_review: 'off' });
  });

  it('adds adversarial_review metadata on code-producing steps when adversarial review is enabled', () => {
    projectConfigCore.getProjectConfig.mockReturnValue({ adversarial_review: 'always' });

    buildFeatureWorkflow();

    const createCalls = taskCore.createTask.mock.calls.map(([task]) => task);
    const typesMeta = getMetadataByNode(createCalls, 'player-stats-types');
    const eventsMeta = getMetadataByNode(createCalls, 'player-stats-events');
    const dataMeta = getMetadataByNode(createCalls, 'player-stats-data');
    const systemMeta = getMetadataByNode(createCalls, 'player-stats-system');
    const wireMeta = getMetadataByNode(createCalls, 'player-stats-wire');
    const testsMeta = getMetadataByNode(createCalls, 'player-stats-tests');

    expect(hasAdversarialReview(typesMeta)).toBe(true);
    expect(hasAdversarialReview(eventsMeta)).toBe(true);
    expect(hasAdversarialReview(dataMeta)).toBe(true);
    expect(hasAdversarialReview(systemMeta)).toBe(true);
    expect(hasAdversarialReview(wireMeta)).toBe(true);
    expect(hasAdversarialReview(testsMeta)).toBe(false);
    expect(workflowEngine.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { adversarial_review_enabled: true },
      })
    );
  });

  it('does not add adversarial_review metadata when adversarial review is off', () => {
    projectConfigCore.getProjectConfig.mockReturnValue({ adversarial_review: 'off' });

    buildFeatureWorkflow();

    const createCalls = taskCore.createTask.mock.calls.map(([task]) => task);
    const typesMeta = getMetadataByNode(createCalls, 'player-stats-types');
    const eventsMeta = getMetadataByNode(createCalls, 'player-stats-events');
    const dataMeta = getMetadataByNode(createCalls, 'player-stats-data');
    const systemMeta = getMetadataByNode(createCalls, 'player-stats-system');
    const wireMeta = getMetadataByNode(createCalls, 'player-stats-wire');
    const testsMeta = getMetadataByNode(createCalls, 'player-stats-tests');

    expect(hasAdversarialReview(typesMeta)).toBe(false);
    expect(hasAdversarialReview(eventsMeta)).toBe(false);
    expect(hasAdversarialReview(dataMeta)).toBe(false);
    expect(hasAdversarialReview(systemMeta)).toBe(false);
    expect(hasAdversarialReview(wireMeta)).toBe(false);
    expect(hasAdversarialReview(testsMeta)).toBe(false);
    expect(workflowEngine.createWorkflow.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        context: undefined,
      })
    );
  });
});
