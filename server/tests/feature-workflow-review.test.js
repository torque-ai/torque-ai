// Mock the dependencies BEFORE they're imported by feature-workflow
const mockCreateTask = vi.fn();
const mockCreateWorkflow = vi.fn();
const mockAddTaskDependency = vi.fn();
const mockUpdateWorkflowCounts = vi.fn();
const mockFindEmptyWorkflowPlaceholder = vi.fn().mockReturnValue(null);
const mockGetProjectConfig = vi.fn().mockReturnValue({ adversarial_review: 'off' });

vi.mock('../db/task-core', () => ({
  createTask: mockCreateTask,
}));

vi.mock('../db/workflow-engine', () => ({
  createWorkflow: mockCreateWorkflow,
  addTaskDependency: mockAddTaskDependency,
  updateWorkflowCounts: mockUpdateWorkflowCounts,
  findEmptyWorkflowPlaceholder: mockFindEmptyWorkflowPlaceholder,
}));

vi.mock('../db/project-config-core', () => ({
  getProjectConfig: mockGetProjectConfig,
}));

const featureWorkflow = require('../handlers/workflow/feature-workflow');

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
    if (!metadata) return false;
    const parsed = JSON.parse(metadata);
    return Object.prototype.hasOwnProperty.call(parsed, 'adversarial_review');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    featureWorkflow.init({
      startWorkflowExecution: vi.fn(),
      buildEmptyWorkflowCreationError: vi.fn(),
    });
  });

  it('adds adversarial_review metadata on code-producing steps when enabled', () => {
    mockGetProjectConfig.mockReturnValue({ adversarial_review: 'always' });

    buildFeatureWorkflow();

    const createCalls = mockCreateTask.mock.calls.map(([task]) => task);
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
  });

  it('does not add adversarial_review metadata when review is off', () => {
    mockGetProjectConfig.mockReturnValue({ adversarial_review: 'off' });

    buildFeatureWorkflow();

    const createCalls = mockCreateTask.mock.calls.map(([task]) => task);
    for (const task of createCalls) {
      expect(hasAdversarialReview(task.metadata)).toBe(false);
    }
  });
});
