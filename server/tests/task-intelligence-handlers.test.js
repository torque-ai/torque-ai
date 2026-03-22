'use strict';

/**
 * Unit tests for task-intelligence.js handler functions.
 *
 * These tests mock database/task-manager dependencies at the module boundary
 * and exercise the handlers directly.
 */

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db/task-core', () => ({
  getTask() { return null; },
  updateTaskStatus() {},
  deleteTasks(status) {
    return {
      deleted: 0,
      status,
    };
  },
  deleteTask(taskId) {
    return {
      id: taskId,
      status: 'completed',
    };
  },
}));

vi.mock('../db/webhooks-streaming', () => ({
  getLatestStreamChunks() { return []; },
  getTaskLogs() { return []; },
  createEventSubscription() { return 'sub-123'; },
  pollSubscription() { return null; },
  pauseTask() {},
  saveTaskCheckpoint() {},
  getTaskCheckpoint() { return null; },
  clearPauseState() {},
  recordTaskEvent() {},
  listPausedTasks() { return []; },
}));

vi.mock('../db/task-metadata', () => ({
  generateTaskSuggestions() { return []; },
  findSimilarTasks() { return []; },
  learnFromRecentTasks() {
    return {
      tasksProcessed: 0,
      patternsLearned: 0,
    };
  },
  getTaskPatterns() { return []; },
  getSmartDefaults() {
    return {
      timeout_minutes: 30,
      auto_approve: false,
      priority: 5,
      confidence: 0,
      matched_patterns: [],
    };
  },
  addTaskComment() { return 'comment-1'; },
  getTaskComments() { return []; },
  getTaskTimeline() { return []; },
  dryRunBulkOperation() {
    return {
      total_tasks: 0,
      preview: [],
    };
  },
  getBulkOperation() { return null; },
  listBulkOperations() { return []; },
}));

vi.mock('../db/scheduling-automation', () => ({
  recordAuditLog() {},
}));

vi.mock('../db/analytics', () => ({
  predictDuration() {
    return {
      predicted_minutes: 30,
      confidence: 0.8,
      factors: [],
    };
  },
  getDurationInsights() {
    return {
      accuracy: {
        total_predictions: 0,
        avg_error_percent: null,
        within_20_percent: null,
      },
      models: [],
      recent_predictions: [],
    };
  },
  calibratePredictionModels() {
    return {
      models_updated: 0,
      samples_processed: 0,
    };
  },
}));

vi.mock('../db/host-management', () => ({
  setTaskReviewStatus() {},
  getTasksPendingReview() { return []; },
  getTasksNeedingCorrection() { return []; },
  routeTask() {
    return {
      provider: 'desktop',
      rule: 'Default',
    };
  },
}));

vi.mock('../task-manager', () => ({
  pauseTask() { return true; },
  getTaskProgress() { return null; },
  resumeTask() { return true; },
  processQueue() {},
}));

vi.mock('../logger', () => ({
  child: vi.fn(() => loggerMock),
}));

const taskCore = require('../db/task-core');
const webhooksStreaming = require('../db/webhooks-streaming');
const taskMetadata = require('../db/task-metadata');
const schedulingAutomation = require('../db/scheduling-automation');
const analytics = require('../db/analytics');
const hostManagement = require('../db/host-management');
const taskManager = require('../task-manager');
const handlers = require('../handlers/task/intelligence');
const shared = require('../handlers/shared');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function makeTask(overrides = {}) {
  return {
    id: 'task-12345678',
    status: 'running',
    task_description: 'Investigate flaky test output for CI failures',
    error_output: '',
    paused_at: null,
    metadata: null,
    ...overrides,
  };
}

function expectError(result, code, snippet) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(code);
  if (snippet) {
    expect(getText(result)).toContain(snippet);
  }
}

describe('task-intelligence handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('handleStreamTaskOutput', () => {
    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      const result = handlers.handleStreamTaskOutput({ task_id: 'missing-task' });

      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: missing-task');
    });

    it('combines chunks and sanitizes sequence and limit values', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({ status: 'running' }));
      const getLatestStreamChunks = vi.spyOn(webhooksStreaming, 'getLatestStreamChunks').mockReturnValue([
        { sequence_num: 4, chunk_data: 'hello ' },
        { sequence_num: 6, chunk_data: 'world' },
      ]);

      const result = handlers.handleStreamTaskOutput({
        task_id: 'task-12345678',
        since_sequence: -25,
        limit: 9999,
      });

      const payload = JSON.parse(getText(result));

      expect(getLatestStreamChunks).toHaveBeenCalledWith('task-12345678', 0, 500);
      expect(payload).toMatchObject({
        task_id: 'task-12345678',
        status: 'running',
        chunk_count: 2,
        last_sequence: 6,
        output: 'hello world',
      });
      expect(payload.has_more).toBe(false);
    });

    it('uses the requested since_sequence when no new chunks exist', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({ status: 'queued' }));
      vi.spyOn(webhooksStreaming, 'getLatestStreamChunks').mockReturnValue([]);

      const result = handlers.handleStreamTaskOutput({
        task_id: 'task-12345678',
        since_sequence: 12,
      });

      expect(JSON.parse(getText(result))).toMatchObject({
        chunk_count: 0,
        last_sequence: 12,
        output: '',
      });
    });
  });

  describe('handleGetTaskLogs', () => {
    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      const result = handlers.handleGetTaskLogs({ task_id: 'missing-task' });

      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: missing-task');
    });

    it('formats stdout and stderr log entries and forwards filters', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({ status: 'failed' }));
      const getTaskLogs = vi.spyOn(webhooksStreaming, 'getTaskLogs').mockReturnValue([
        { timestamp: '2026-03-12T10:00:00.000Z', type: 'stdout', content: 'first line\n' },
        { timestamp: '2026-03-12T10:01:00.000Z', type: 'stderr', content: 'second line' },
      ]);

      const result = handlers.handleGetTaskLogs({
        task_id: 'task-12345678',
        level: 'error',
        search: 'second',
        limit: 10,
      });

      expect(getTaskLogs).toHaveBeenCalledWith('task-12345678', {
        level: 'error',
        search: 'second',
        limit: 10,
      });
      expect(getText(result)).toContain('## Task Logs: task-12345678');
      expect(getText(result)).toContain('[OUT] first line');
      expect(getText(result)).toContain('[ERR] second line');
      expect(getText(result)).toContain('level=error, search=second');
    });
  });

  describe('handleSubscribeTaskEvents', () => {
    it('rejects non-array event_types', () => {
      const result = handlers.handleSubscribeTaskEvents({ event_types: 'status_change' });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'event_types must be an array');
    });

    it('rejects unsupported event types', () => {
      const result = handlers.handleSubscribeTaskEvents({ event_types: ['status_change', 'bogus'] });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'Invalid event type: bogus');
    });

    it('rejects invalid expiration values', () => {
      const result = handlers.handleSubscribeTaskEvents({ expires_in_minutes: 0 });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'expires_in_minutes must be a positive number');
    });

    it('creates a subscription for all tasks with default values', () => {
      const createEventSubscription = vi.spyOn(webhooksStreaming, 'createEventSubscription').mockReturnValue('sub-789');

      const result = handlers.handleSubscribeTaskEvents({});

      expect(createEventSubscription).toHaveBeenCalledWith(undefined, ['status_change'], 60);
      expect(getText(result)).toContain('Subscription ID:** `sub-789`');
      expect(getText(result)).toContain('**Task:** All tasks');
    });
  });

  describe('handlePollTaskEvents', () => {
    it('returns SUBSCRIPTION_NOT_FOUND when the subscription is missing', () => {
      vi.spyOn(webhooksStreaming, 'pollSubscription').mockReturnValue(null);

      const result = handlers.handlePollTaskEvents({ subscription_id: 'sub-missing' });

      expectError(result, shared.ErrorCodes.SUBSCRIPTION_NOT_FOUND.code, 'Subscription not found: sub-missing');
    });

    it('reports expired subscriptions', () => {
      vi.spyOn(webhooksStreaming, 'pollSubscription').mockReturnValue({ expired: true, events: [] });

      const result = handlers.handlePollTaskEvents({ subscription_id: 'sub-123' });

      expect(getText(result)).toContain('Subscription Expired');
      expect(getText(result)).toContain('sub-123');
    });

    it('reports empty event queues', () => {
      vi.spyOn(webhooksStreaming, 'pollSubscription').mockReturnValue({ expired: false, events: [] });

      const result = handlers.handlePollTaskEvents({ subscription_id: 'sub-123' });

      expect(getText(result)).toContain('No New Events');
    });

    it('formats returned task events with changes and data', () => {
      vi.spyOn(webhooksStreaming, 'pollSubscription').mockReturnValue({
        expired: false,
        events: [
          {
            event_type: 'status_change',
            task_id: 'task-12345678',
            created_at: '2026-03-12T10:00:00.000Z',
            old_value: 'queued',
            new_value: 'running',
            event_data: 'worker-1',
          },
        ],
      });

      const result = handlers.handlePollTaskEvents({ subscription_id: 'sub-123' });

      expect(getText(result)).toContain('## Task Events');
      expect(getText(result)).toContain('queued → running');
      expect(getText(result)).toContain('worker-1');
    });
  });

  describe('handlePauseTask', () => {
    it('rejects non-running tasks', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({ status: 'queued' }));

      const result = handlers.handlePauseTask({ task_id: 'task-12345678' });

      expectError(result, shared.ErrorCodes.INVALID_STATUS_TRANSITION.code, 'Cannot pause task with status');
    });

    it('returns OPERATION_FAILED when task-manager pause fails', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({ status: 'running' }));
      vi.spyOn(taskManager, 'pauseTask').mockReturnValue(false);

      const result = handlers.handlePauseTask({ task_id: 'task-12345678' });

      expectError(result, shared.ErrorCodes.OPERATION_FAILED.code, 'Failed to pause task: task-12345678');
    });

    it('pauses the task and saves a checkpoint when progress is available', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({ status: 'running' }));
      vi.spyOn(taskManager, 'pauseTask').mockReturnValue(true);
      vi.spyOn(taskManager, 'getTaskProgress').mockReturnValue({ step: 3, percent: 50 });
      const saveTaskCheckpoint = vi.spyOn(webhooksStreaming, 'saveTaskCheckpoint').mockImplementation(() => {});
      const pauseTask = vi.spyOn(webhooksStreaming, 'pauseTask').mockImplementation(() => {});

      const result = handlers.handlePauseTask({
        task_id: 'task-12345678',
        reason: 'manual review',
      });

      expect(saveTaskCheckpoint).toHaveBeenCalledWith('task-12345678', { step: 3, percent: 50 }, 'pause');
      expect(pauseTask).toHaveBeenCalledWith('task-12345678', 'manual review');
      expect(getText(result)).toContain('Task Paused');
      expect(getText(result)).toContain('manual review');
    });
  });

  describe('handleResumeTask', () => {
    it('rejects non-paused tasks', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({ status: 'running' }));

      const result = handlers.handleResumeTask({ task_id: 'task-12345678' });

      expectError(result, shared.ErrorCodes.INVALID_STATUS_TRANSITION.code, 'Cannot resume task with status');
    });

    it('returns OPERATION_FAILED when task-manager resume fails', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({ status: 'paused' }));
      vi.spyOn(webhooksStreaming, 'getTaskCheckpoint').mockReturnValue(null);
      vi.spyOn(taskManager, 'resumeTask').mockReturnValue(false);

      const result = handlers.handleResumeTask({ task_id: 'task-12345678' });

      expectError(result, shared.ErrorCodes.OPERATION_FAILED.code, 'Failed to resume task: task-12345678');
    });

    it('resumes the task, restores checkpoint state, and records the status change', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T12:00:00.000Z'));

      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({
        status: 'paused',
        paused_at: '2026-03-12T11:45:00.000Z',
      }));
      vi.spyOn(webhooksStreaming, 'getTaskCheckpoint').mockReturnValue({ step: 7 });
      vi.spyOn(taskManager, 'resumeTask').mockReturnValue(true);
      const clearPauseState = vi.spyOn(webhooksStreaming, 'clearPauseState').mockImplementation(() => {});
      const recordTaskEvent = vi.spyOn(webhooksStreaming, 'recordTaskEvent').mockImplementation(() => {});

      const result = handlers.handleResumeTask({ task_id: 'task-12345678' });

      expect(clearPauseState).toHaveBeenCalledWith('task-12345678');
      expect(recordTaskEvent).toHaveBeenCalledWith('task-12345678', 'status_change', 'paused', 'running', null);
      expect(getText(result)).toContain('Was paused for:** 15 minutes');
      expect(getText(result)).toContain('Checkpoint restored:** Yes');
    });
  });

  describe('handleListPausedTasks', () => {
    it('shows an empty state when no paused tasks exist', () => {
      vi.spyOn(webhooksStreaming, 'listPausedTasks').mockReturnValue([]);

      const result = handlers.handleListPausedTasks({ project: 'torque' });

      expect(getText(result)).toContain('No paused tasks found for project: torque.');
    });

    it('renders a table of paused tasks with truncated descriptions', () => {
      vi.spyOn(webhooksStreaming, 'listPausedTasks').mockReturnValue([
        {
          id: 'task-12345678',
          task_description: 'A'.repeat(45),
          paused_minutes: 3.4,
          pause_reason: 'waiting',
        },
        {
          id: 'task-87654321',
          task_description: 'Short description',
          paused_minutes: null,
          pause_reason: null,
        },
      ]);

      const result = handlers.handleListPausedTasks({ limit: 10 });

      expect(getText(result)).toContain('| task-123 | AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA... | 3 min | waiting |');
      expect(getText(result)).toContain('| task-876 | Short description | Unknown | - |');
      expect(getText(result)).toContain('**Total:** 2 paused task(s)');
    });
  });

  describe('handleSuggestImprovements', () => {
    it('rejects non-failed tasks', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({ status: 'completed' }));

      const result = handlers.handleSuggestImprovements({ task_id: 'task-12345678' });

      expectError(result, shared.ErrorCodes.INVALID_STATUS_TRANSITION.code, 'Only failed tasks can be analyzed');
    });

    it('shows a no-suggestions message when no improvements are found', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({
        status: 'failed',
        error_output: 'connection refused',
      }));
      vi.spyOn(taskMetadata, 'generateTaskSuggestions').mockReturnValue([]);

      const result = handlers.handleSuggestImprovements({ task_id: 'task-12345678' });

      expect(getText(result)).toContain('No Suggestions Found');
      expect(getText(result)).toContain('connection refused');
    });

    it('sorts improvement suggestions by confidence and includes truncated error output', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({
        status: 'failed',
        error_output: 'E'.repeat(320),
      }));
      vi.spyOn(taskMetadata, 'generateTaskSuggestions').mockReturnValue([
        { type: 'retry', confidence: 0.45, suggestion: 'Add retry logic.' },
        { type: 'timeout', confidence: 0.9, suggestion: 'Increase timeout.' },
      ]);

      const result = handlers.handleSuggestImprovements({ task_id: 'task-12345678' });
      const text = getText(result);

      expect(text).toContain('Improvement Suggestions for Task task-123');
      expect(text.indexOf('**timeout**')).toBeLessThan(text.indexOf('**retry**'));
      expect(text).toContain('Error Output (truncated)');
    });
  });

  describe('handleFindSimilarTasks', () => {
    it('shows an empty state when no similar tasks are found', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask());
      vi.spyOn(taskMetadata, 'findSimilarTasks').mockReturnValue([]);

      const result = handlers.handleFindSimilarTasks({
        task_id: 'task-12345678',
        min_similarity: 0.42,
      });

      expect(getText(result)).toContain('No Similar Tasks Found');
      expect(getText(result)).toContain('42%');
    });

    it('forwards similarity filters and renders matched tasks', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask());
      const findSimilarTasks = vi.spyOn(taskMetadata, 'findSimilarTasks').mockReturnValue([
        {
          similarity: 0.87,
          task: {
            id: 'task-87654321',
            status: 'completed',
            task_description: 'Prepare a release verification summary for the nightly build',
          },
        },
      ]);

      const result = handlers.handleFindSimilarTasks({
        task_id: 'task-12345678',
        limit: 5,
        min_similarity: 0.5,
        status_filter: 'completed',
      });

      expect(findSimilarTasks).toHaveBeenCalledWith('task-12345678', {
        limit: 5,
        minSimilarity: 0.5,
        statusFilter: 'completed',
      });
      expect(getText(result)).toContain('| 87% | task-876 | completed | Prepare a release verification summary f... |');
      expect(getText(result)).toContain('**Found:** 1 similar task(s)');
    });
  });

  describe('handleLearnDefaults', () => {
    it('reports when no patterns have been learned yet', () => {
      vi.spyOn(taskMetadata, 'learnFromRecentTasks').mockReturnValue({
        tasksProcessed: 4,
        patternsLearned: 0,
      });
      vi.spyOn(taskMetadata, 'getTaskPatterns').mockReturnValue([]);

      const result = handlers.handleLearnDefaults({ task_limit: 4 });

      expect(getText(result)).toContain('Tasks analyzed:** 4');
      expect(getText(result)).toContain('No patterns learned yet');
    });

    it('renders learned pattern rows after processing recent tasks', () => {
      vi.spyOn(taskMetadata, 'learnFromRecentTasks').mockReturnValue({
        tasksProcessed: 12,
        patternsLearned: 3,
      });
      vi.spyOn(taskMetadata, 'getTaskPatterns').mockReturnValue([
        {
          pattern_type: 'project',
          pattern_value: 'Torque',
          hit_count: 6,
          success_rate: 0.83,
          suggested_config: {
            timeout_minutes: 20,
            priority: 7,
          },
        },
      ]);

      const result = handlers.handleLearnDefaults({ task_limit: 12 });

      expect(getText(result)).toContain('| project | Torque | 6 | 83% | timeout=20m, priority=7 |');
    });
  });

  describe('handleApplySmartDefaults', () => {
    it('shows default values when no patterns match', () => {
      vi.spyOn(taskMetadata, 'getSmartDefaults').mockReturnValue({
        timeout_minutes: 30,
        auto_approve: false,
        priority: 5,
        confidence: 0,
        matched_patterns: [],
      });

      const result = handlers.handleApplySmartDefaults({
        task_description: 'Investigate a flaky telemetry summary',
      });

      expect(getText(result)).toContain('No patterns matched. Using default values.');
      expect(getText(result)).toContain('| timeout_minutes | 30 | default |');
    });

    it('renders matched patterns and project-specific suggestions', () => {
      vi.spyOn(taskMetadata, 'getSmartDefaults').mockReturnValue({
        timeout_minutes: 45,
        auto_approve: true,
        priority: 9,
        confidence: 0.82,
        matched_patterns: [
          {
            type: 'project',
            value: 'Torque',
            hit_count: 4,
            success_rate: 0.75,
          },
        ],
      });

      const result = handlers.handleApplySmartDefaults({
        task_description: 'Generate a release readiness summary for queued tasks',
        project: 'Torque',
      });

      expect(getText(result)).toContain('**Project:** Torque');
      expect(getText(result)).toContain('| auto_approve | true | 82% |');
      expect(getText(result)).toContain('**project:** "Torque" (4 hits, 75% success)');
      expect(getText(result)).toContain('"priority": 9');
    });
  });

  describe('handleAddComment', () => {
    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      const result = handlers.handleAddComment({
        task_id: 'missing-task',
        comment: 'Need more logs',
      });

      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: missing-task');
    });

    it('adds a comment and writes an audit entry', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask());
      const addTaskComment = vi.spyOn(taskMetadata, 'addTaskComment').mockReturnValue('comment-77');
      const recordAuditLog = vi.spyOn(schedulingAutomation, 'recordAuditLog');

      const result = handlers.handleAddComment({
        task_id: 'task-12345678',
        comment: 'Blocked on provider output.',
        comment_type: 'blocker',
        author: 'alice',
      });

      expect(addTaskComment).toHaveBeenCalledWith('task-12345678', 'Blocked on provider output.', {
        author: 'alice',
        commentType: 'blocker',
      });
      expect(recordAuditLog).toHaveBeenCalledWith(
        'comment',
        'comment-77',
        'create',
        'alice',
        null,
        null,
        JSON.stringify({
          task_id: 'task-12345678',
          comment_type: 'blocker',
          comment: 'Blocked on provider output.',
        }),
      );
      expect(getText(result)).toContain('Comment added to task task-123');
      expect(getText(result)).toContain('**Author:** alice');
    });

    it('swallows audit-log failures and still returns success', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask());
      vi.spyOn(taskMetadata, 'addTaskComment').mockReturnValue('comment-78');
      const recordAuditLog = vi.spyOn(schedulingAutomation, 'recordAuditLog').mockImplementation(() => {
        throw new Error('audit offline');
      });

      const result = handlers.handleAddComment({
        task_id: 'task-12345678',
        comment: 'Resolution posted',
        comment_type: 'resolution',
      });

      expect(getText(result)).toContain('Resolution posted');
      expect(result.isError).not.toBe(true);
      expect(recordAuditLog).toHaveBeenCalled();
    });
  });

  describe('handleListComments', () => {
    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      const result = handlers.handleListComments({ task_id: 'missing-task' });

      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: missing-task');
    });

    it('shows an empty state when no comments match the filter', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask());
      vi.spyOn(taskMetadata, 'getTaskComments').mockReturnValue([]);

      const result = handlers.handleListComments({
        task_id: 'task-12345678',
        comment_type: 'blocker',
      });

      expect(getText(result)).toContain("No comments found of type 'blocker'.");
    });

    it('renders comment entries and forwards the comment type filter', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask());
      const getTaskComments = vi.spyOn(taskMetadata, 'getTaskComments').mockReturnValue([
        {
          comment_type: 'resolution',
          author: 'alice',
          created_at: '2026-03-12T10:00:00.000Z',
          comment_text: 'Issue resolved after retry.',
        },
      ]);

      const result = handlers.handleListComments({
        task_id: 'task-12345678',
        comment_type: 'resolution',
      });

      expect(getTaskComments).toHaveBeenCalledWith('task-12345678', { commentType: 'resolution' });
      expect(getText(result)).toContain('RESOLUTION by alice');
      expect(getText(result)).toContain('Issue resolved after retry.');
      expect(getText(result)).toContain('**Total:** 1 comment(s)');
    });
  });

  describe('handleTaskTimeline', () => {
    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      const result = handlers.handleTaskTimeline({ task_id: 'missing-task' });

      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: missing-task');
    });

    it('shows an empty state when no timeline events exist', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask());
      vi.spyOn(taskMetadata, 'getTaskTimeline').mockReturnValue([]);

      const result = handlers.handleTaskTimeline({ task_id: 'task-12345678' });

      expect(getText(result)).toContain('No timeline events found.');
    });

    it('renders timeline entries using event_type and fallback type fields', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({ status: 'failed' }));
      vi.spyOn(taskMetadata, 'getTaskTimeline').mockReturnValue([
        {
          event_type: 'status_change',
          timestamp: '2026-03-12T10:00:00.000Z',
          details: 'Task moved from queued to running.',
        },
        {
          type: 'comment',
          timestamp: '2026-03-12T11:00:00.000Z',
          details: 'Added a reviewer note.',
        },
      ]);

      const result = handlers.handleTaskTimeline({ task_id: 'task-12345678' });

      expect(getText(result)).toContain('STATUS CHANGE');
      expect(getText(result)).toContain('COMMENT');
      expect(getText(result)).toContain('Task moved from queued to running.');
      expect(getText(result)).toContain('**Total Events:** 2');
    });
  });

  describe('handleDryRunBulk', () => {
    it('shows an empty state when no tasks match the filters', () => {
      vi.spyOn(taskMetadata, 'dryRunBulkOperation').mockReturnValue({
        total_tasks: 0,
        preview: [],
      });

      const result = handlers.handleDryRunBulk({
        operation: 'cancel',
        status: 'queued',
      });

      expect(getText(result)).toContain('Total Tasks Affected:** 0');
      expect(getText(result)).toContain('No tasks match the specified filters.');
    });

    it('normalizes filter criteria and renders preview rows', () => {
      const dryRunBulkOperation = vi.spyOn(taskMetadata, 'dryRunBulkOperation').mockReturnValue({
        total_tasks: 12,
        preview: [
          { id: 'task-12345678', status: 'queued', description: 'First task' },
          { id: 'task-87654321', status: 'queued', description: 'Second task' },
        ],
      });

      const result = handlers.handleDryRunBulk({
        operation: 'cancel',
        status: 'queued',
        tags: ['nightly'],
        older_than_hours: 24,
        project: 'Torque',
      });

      expect(dryRunBulkOperation).toHaveBeenCalledWith('cancel', {
        status: ['queued'],
        tags: ['nightly'],
        older_than_hours: 24,
        project: 'Torque',
      });
      expect(getText(result)).toContain('"status": [\n    "queued"\n  ]');
      expect(getText(result)).toContain('| task-123... | queued | First task |');
      expect(getText(result)).toContain('...and 2 more tasks');
    });
  });

  describe('handleBulkOperationStatus', () => {
    it('returns RESOURCE_NOT_FOUND when the bulk operation does not exist', () => {
      vi.spyOn(taskMetadata, 'getBulkOperation').mockReturnValue(null);

      const result = handlers.handleBulkOperationStatus({ operation_id: 'bulk-missing' });

      expectError(result, shared.ErrorCodes.RESOURCE_NOT_FOUND.code, 'Bulk operation not found: bulk-missing');
    });

    it('renders bulk operation progress, error text, and results', () => {
      vi.spyOn(taskMetadata, 'getBulkOperation').mockReturnValue({
        id: 'bulk-12345678',
        operation_type: 'cancel',
        status: 'completed',
        created_at: '2026-03-12T17:00:00.000Z',
        completed_at: '2026-03-12T17:05:00.000Z',
        total_tasks: 4,
        succeeded_tasks: 3,
        failed_tasks: 1,
        error: 'one task failed',
        results: { succeeded: ['task-1'], failed: ['task-2'] },
      });

      const result = handlers.handleBulkOperationStatus({ operation_id: 'bulk-12345678' });

      expect(getText(result)).toContain('Bulk Operation: bulk-123');
      expect(getText(result)).toContain('| Total Tasks | 4 |');
      expect(getText(result)).toContain('one task failed');
      expect(getText(result)).toContain('"failed": [');
    });
  });

  describe('handleListBulkOperations', () => {
    it('shows an empty state when no bulk operations exist', () => {
      vi.spyOn(taskMetadata, 'listBulkOperations').mockReturnValue([]);

      const result = handlers.handleListBulkOperations({});

      expect(getText(result)).toContain('No bulk operations found.');
    });

    it('forwards filters and applies the default limit for invalid values', () => {
      const listBulkOperations = vi.spyOn(taskMetadata, 'listBulkOperations').mockReturnValue([
        {
          id: 'bulk-12345678',
          operation_type: 'retry',
          status: 'running',
          total_tasks: 7,
          created_at: '2026-03-12T10:00:00.000Z',
        },
      ]);

      const result = handlers.handleListBulkOperations({
        operation_type: 'retry',
        status: 'running',
        limit: 0,
      });

      expect(listBulkOperations).toHaveBeenCalledWith({
        operation_type: 'retry',
        status: 'running',
        limit: 20,
      });
      expect(getText(result)).toContain('| bulk-123... | retry | running | 7 |');
      expect(getText(result)).toContain('**Total:** 1 operations');
    });
  });

  describe('handlePredictDuration', () => {
    it('renders duration factors for confident predictions', () => {
      vi.spyOn(analytics, 'predictDuration').mockReturnValue({
        predicted_minutes: 18,
        confidence: 0.8,
        factors: [
          { source: 'project', name: 'Torque', value: 900, weight: 0.7 },
          { source: 'template', name: 'review', value: 300, weight: 0.3 },
        ],
      });

      const result = handlers.handlePredictDuration({
        task_description: 'Review release evidence bundle',
        template_name: 'review',
        project: 'Torque',
      });

      expect(getText(result)).toContain('| Predicted Duration | 18 minutes |');
      expect(getText(result)).toContain('| project | Torque | 900 | 70% |');
      expect(getText(result)).not.toContain('Low confidence prediction');
    });

    it('shows a note for low-confidence predictions', () => {
      vi.spyOn(analytics, 'predictDuration').mockReturnValue({
        predicted_minutes: 5,
        confidence: 0.2,
        factors: [],
      });

      const result = handlers.handlePredictDuration({
        task_description: 'Rare one-off task',
      });

      expect(getText(result)).toContain('Low confidence prediction');
    });
  });

  describe('handleDurationInsights', () => {
    it('renders accuracy metrics when no models or recent predictions are available', () => {
      vi.spyOn(analytics, 'getDurationInsights').mockReturnValue({
        accuracy: {
          total_predictions: 0,
          avg_error_percent: null,
          within_20_percent: null,
        },
        models: [],
        recent_predictions: [],
      });

      const result = handlers.handleDurationInsights({ project: 'Torque' });

      expect(getText(result)).toContain('| Total Predictions | 0 |');
      expect(getText(result)).toContain('| Average Error | N/A% |');
      expect(getText(result)).not.toContain('### Prediction Models');
    });

    it('renders models and recent predictions while clamping invalid limits', () => {
      const getDurationInsights = vi.spyOn(analytics, 'getDurationInsights').mockReturnValue({
        accuracy: {
          total_predictions: 12,
          avg_error_percent: 14,
          within_20_percent: 75,
        },
        models: [
          { model_type: 'project', model_key: 'Torque', sample_count: 4, avg_seconds: 610 },
        ],
        recent_predictions: [
          {
            task_id: 'task-12345678',
            predicted_seconds: 900,
            actual_seconds: 1080,
            error_percent: 20,
          },
        ],
      });

      const result = handlers.handleDurationInsights({
        project: 'Torque',
        limit: 0,
      });

      expect(getDurationInsights).toHaveBeenCalledWith({
        project: 'Torque',
        limit: 20,
      });
      expect(getText(result)).toContain('| project | Torque | 4 | 610 |');
      expect(getText(result)).toContain('| task-123... | 15m | 18m | 20% |');
    });
  });

  describe('handleCalibratePredictions', () => {
    it('reports when no models were updated', () => {
      vi.spyOn(analytics, 'calibratePredictionModels').mockReturnValue({
        models_updated: 0,
        samples_processed: 1,
      });

      const result = handlers.handleCalibratePredictions({});

      expect(getText(result)).toContain('Models Updated:** 0');
      expect(getText(result)).toContain('No models were updated');
    });

    it('reports updated calibration results when models are recalculated', () => {
      vi.spyOn(analytics, 'calibratePredictionModels').mockReturnValue({
        models_updated: 3,
        samples_processed: 22,
      });

      const result = handlers.handleCalibratePredictions({});

      expect(getText(result)).toContain('Models Updated:** 3');
      expect(getText(result)).toContain('Use `duration_insights` to view the updated models.');
    });
  });

  describe('handleStartPendingTask', () => {
    it('requires a task_id', () => {
      const result = handlers.handleStartPendingTask({});

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'task_id is required');
    });

    it('rejects tasks that are not pending', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({ status: 'queued' }));

      const result = handlers.handleStartPendingTask({ task_id: 'task-12345678' });

      expectError(result, shared.ErrorCodes.INVALID_STATUS_TRANSITION.code, 'is not pending');
    });

    it('queues pending tasks and renders aggregation metadata when present', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({
        status: 'pending',
        metadata: {
          is_aggregation: true,
          chunk_task_ids: ['chunk-1', 'chunk-2'],
          file_path: 'server/handlers/task/intelligence.js',
        },
      }));
      const updateTaskStatus = vi.spyOn(taskCore, 'updateTaskStatus');
      const processQueue = vi.spyOn(taskManager, 'processQueue');

      const result = handlers.handleStartPendingTask({ task_id: 'task-12345678' });

      expect(updateTaskStatus).toHaveBeenCalledWith('task-12345678', 'queued');
      expect(processQueue).toHaveBeenCalled();
      expect(getText(result)).toContain('| New Status | queued |');
      expect(getText(result)).toContain('aggregate 2 chunk reviews');
    });
  });

  describe('handleSetTaskReviewStatus', () => {
    it('requires a non-empty task_id string', () => {
      const result = handlers.handleSetTaskReviewStatus({ status: 'approved' });

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'task_id must be a non-empty string');
    });

    it('rejects invalid review statuses', () => {
      const result = handlers.handleSetTaskReviewStatus({
        task_id: 'task-12345678',
        status: 'done',
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'status must be one of');
    });

    it('updates review status and includes notes and reviewed timestamp', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T12:34:56.000Z'));
      const setTaskReviewStatus = vi.spyOn(hostManagement, 'setTaskReviewStatus').mockImplementation(() => {});

      const result = handlers.handleSetTaskReviewStatus({
        task_id: 'task-12345678',
        status: 'needs_correction',
        notes: 'Fix the missing validation.',
      });

      expect(setTaskReviewStatus).toHaveBeenCalledWith('task-12345678', 'needs_correction', 'Fix the missing validation.');
      expect(getText(result)).toContain('| Notes | Fix the missing validation. |');
      expect(getText(result)).toContain('| Reviewed At | 2026-03-12T12:34:56.000Z |');
    });
  });

  describe('handleListPendingReviews', () => {
    it('shows an empty state when there are no pending reviews', () => {
      vi.spyOn(hostManagement, 'getTasksPendingReview').mockReturnValue([]);

      const result = handlers.handleListPendingReviews({});

      expect(getText(result)).toContain('No Tasks Pending Review');
    });

    it('renders pending review rows and clamps oversized limits', () => {
      const getTasksPendingReview = vi.spyOn(hostManagement, 'getTasksPendingReview').mockReturnValue([
        {
          id: 'task-12345678',
          task_description: 'Review nightly regression report for the routing dashboard',
          complexity: 'complex',
          provider: 'codex',
          completed_at: '2026-03-12T09:00:00.000Z',
        },
      ]);

      const result = handlers.handleListPendingReviews({ limit: 99999 });

      expect(getTasksPendingReview).toHaveBeenCalledWith(shared.MAX_LIMIT);
      expect(getText(result)).toContain('Tasks Pending Review (1)');
      expect(getText(result)).toContain('| task-12345678 | Review nightly regression report for the routing d... | complex | codex | 2026-03-12T09:00:00.000Z |');
    });
  });

  describe('handleListTasksNeedingCorrection', () => {
    it('shows an empty state when no tasks need correction', () => {
      vi.spyOn(hostManagement, 'getTasksNeedingCorrection').mockReturnValue([]);

      const result = handlers.handleListTasksNeedingCorrection({});

      expect(getText(result)).toContain('No Tasks Needing Correction');
    });

    it('renders tasks needing correction with notes and next steps', () => {
      vi.spyOn(hostManagement, 'getTasksNeedingCorrection').mockReturnValue([
        {
          id: 'task-12345678',
          task_description: 'Update routing docs after API changes',
          complexity: 'normal',
          review_notes: 'Need a migration note.',
          reviewed_at: '2026-03-12T08:00:00.000Z',
        },
      ]);

      const result = handlers.handleListTasksNeedingCorrection({});

      expect(getText(result)).toContain('### task-12345678');
      expect(getText(result)).toContain('Need a migration note.');
      expect(getText(result)).toContain('Resubmit corrected tasks');
    });
  });

  describe('handleSetTaskComplexity', () => {
    it('requires a non-empty task_id string', () => {
      const result = handlers.handleSetTaskComplexity({ complexity: 'simple' });

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'task_id must be a non-empty string');
    });

    it('rejects invalid complexity values', () => {
      const result = handlers.handleSetTaskComplexity({
        task_id: 'task-12345678',
        complexity: 'mega',
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'complexity must be one of');
    });

    it('updates the task complexity while preserving the existing status', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(makeTask({ status: 'completed' }));
      const updateTaskStatus = vi.spyOn(taskCore, 'updateTaskStatus');

      const result = handlers.handleSetTaskComplexity({
        task_id: 'task-12345678',
        complexity: 'complex',
      });

      expect(updateTaskStatus).toHaveBeenCalledWith('task-12345678', 'completed', { complexity: 'complex' });
      expect(getText(result)).toContain('Task task-12345678 complexity set to **complex**.');
    });
  });

  describe('handleGetComplexityRouting', () => {
    it('rejects invalid complexity values', () => {
      const result = handlers.handleGetComplexityRouting({ complexity: 'mega' });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'complexity must be one of');
    });

    it('renders routing details including host and model when provided', () => {
      vi.spyOn(hostManagement, 'routeTask').mockReturnValue({
        provider: 'ollama',
        host: 'desktop-01',
        model: 'qwen2.5-coder:32b',
        rule: 'Complexity routing table',
      });

      const result = handlers.handleGetComplexityRouting({ complexity: 'complex' });

      expect(getText(result)).toContain('| Provider | ollama |');
      expect(getText(result)).toContain('| Host | desktop-01 |');
      expect(getText(result)).toContain('| Model | qwen2.5-coder:32b |');
    });
  });

  describe('handleDeleteTask', () => {
    it('requires either task_id or status', () => {
      const result = handlers.handleDeleteTask({});

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'Provide either task_id');
    });

    it('bulk-deletes tasks by status', () => {
      const deleteTasks = vi.spyOn(taskCore, 'deleteTasks').mockReturnValue({
        deleted: 2,
        status: 'cancelled',
      });

      const result = handlers.handleDeleteTask({ status: 'cancelled' });

      expect(deleteTasks).toHaveBeenCalledWith('cancelled');
      expect(getText(result)).toContain("Deleted 2 task(s) with status 'cancelled'.");
    });

    it('returns INTERNAL_ERROR when bulk deletion throws', () => {
      vi.spyOn(taskCore, 'deleteTasks').mockImplementation(() => {
        throw new Error('sqlite busy');
      });

      const result = handlers.handleDeleteTask({ status: 'cancelled' });

      expectError(result, shared.ErrorCodes.INTERNAL_ERROR.code, 'Failed to delete tasks: sqlite busy');
    });

    it('deletes a single task by id', () => {
      const deleteTask = vi.spyOn(taskCore, 'deleteTask').mockReturnValue({
        id: 'task-12345678',
        status: 'completed',
      });

      const result = handlers.handleDeleteTask({ task_id: 'task-12345678' });

      expect(deleteTask).toHaveBeenCalledWith('task-12345678');
      expect(getText(result)).toContain("Deleted task task-12345678 (was 'completed').");
    });

    it('returns TASK_NOT_FOUND when deleting a single task throws', () => {
      vi.spyOn(taskCore, 'deleteTask').mockImplementation(() => {
        throw new Error('missing row');
      });

      const result = handlers.handleDeleteTask({ task_id: 'task-missing' });

      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Failed to delete task: missing row');
    });
  });
});
