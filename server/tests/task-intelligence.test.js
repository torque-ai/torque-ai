/**
 * Unit tests for task-intelligence.js handler functions.
 *
 * These tests mock the database, task manager, and logger dependencies at the
 * module boundary so the handler logic can be exercised directly.
 */

vi.mock('../database', () => ({
  getTask() { return null; },
  getLatestStreamChunks() { return []; },
  getTaskLogs() { return []; },
  createEventSubscription() { return 'sub-123'; },
  pollSubscription() { return { expired: false, events: [] }; },
  saveTaskCheckpoint() {},
  pauseTask() {},
  getTaskCheckpoint() { return null; },
  clearPauseState() {},
  recordTaskEvent() {},
  listPausedTasks() { return []; },
  generateTaskSuggestions() { return []; },
  findSimilarTasks() { return []; },
  learnFromRecentTasks() { return { tasksProcessed: 0, patternsLearned: 0 }; },
  getTaskPatterns() { return []; },
  getSmartDefaults() {
    return {
      timeout_minutes: 30,
      auto_approve: false,
      priority: 0,
      confidence: 0,
      matched_patterns: [],
    };
  },
  addTaskComment() { return 42; },
  recordAuditLog() {},
  getTaskComments() { return []; },
  getTaskTimeline() { return []; },
  dryRunBulkOperation() { return { total_tasks: 0, preview: [] }; },
  getBulkOperation() { return null; },
  listBulkOperations() { return []; },
  predictDuration() {
    return {
      predicted_minutes: 0,
      confidence: 0,
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
  updateTaskStatus() {},
  setTaskReviewStatus() {},
  getTasksPendingReview() { return []; },
  getTasksNeedingCorrection() { return []; },
  routeTask() {
    return {
      provider: 'desktop',
      rule: 'Default',
    };
  },
  deleteTasks() {
    return {
      deleted: 0,
      status: 'queued',
    };
  },
  deleteTask() {
    return {
      id: 'deleted-task',
      status: 'completed',
    };
  },
}));

vi.mock('../task-manager', () => ({
  pauseTask() { return true; },
  getTaskProgress() { return null; },
  resumeTask() { return true; },
  processQueue() {},
}));

vi.mock('../logger', () => {
  const childLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };

  return {
    child() { return childLogger; },
  };
});

const db = require('../database');
const taskManager = require('../task-manager');
const logger = require('../logger');
const handlers = require('../handlers/task/intelligence');
const taskLogger = logger.child();

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function makeTask(overrides = {}) {
  return {
    id: '12345678-1234-1234-1234-1234567890ab',
    task_description: 'Write tests for intelligent task handlers',
    status: 'running',
    error_output: '',
    paused_at: null,
    ...overrides,
  };
}

function expectError(result, errorCode, textFragment) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(errorCode);
  if (textFragment) {
    expect(getText(result)).toContain(textFragment);
  }
}

describe('task-intelligence handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();

    vi.spyOn(db, 'getTask').mockImplementation((taskId) => makeTask({ id: taskId }));
    vi.spyOn(db, 'getLatestStreamChunks').mockReturnValue([]);
    vi.spyOn(db, 'getTaskLogs').mockReturnValue([]);
    vi.spyOn(db, 'createEventSubscription').mockReturnValue('sub-123');
    vi.spyOn(db, 'pollSubscription').mockReturnValue({ expired: false, events: [] });
    vi.spyOn(db, 'saveTaskCheckpoint').mockImplementation(() => {});
    vi.spyOn(db, 'pauseTask').mockImplementation(() => {});
    vi.spyOn(db, 'getTaskCheckpoint').mockReturnValue(null);
    vi.spyOn(db, 'clearPauseState').mockImplementation(() => {});
    vi.spyOn(db, 'recordTaskEvent').mockImplementation(() => {});
    vi.spyOn(db, 'listPausedTasks').mockReturnValue([]);
    vi.spyOn(db, 'generateTaskSuggestions').mockReturnValue([]);
    vi.spyOn(db, 'findSimilarTasks').mockReturnValue([]);
    vi.spyOn(db, 'learnFromRecentTasks').mockReturnValue({ tasksProcessed: 0, patternsLearned: 0 });
    vi.spyOn(db, 'getTaskPatterns').mockReturnValue([]);
    vi.spyOn(db, 'getSmartDefaults').mockReturnValue({
      timeout_minutes: 30,
      auto_approve: false,
      priority: 0,
      confidence: 0,
      matched_patterns: [],
    });
    vi.spyOn(db, 'addTaskComment').mockReturnValue(42);
    vi.spyOn(db, 'recordAuditLog').mockImplementation(() => {});
    vi.spyOn(db, 'getTaskComments').mockReturnValue([]);
    vi.spyOn(db, 'getTaskTimeline').mockReturnValue([]);
    vi.spyOn(db, 'dryRunBulkOperation').mockReturnValue({ total_tasks: 0, preview: [] });
    vi.spyOn(db, 'getBulkOperation').mockReturnValue(null);
    vi.spyOn(db, 'listBulkOperations').mockReturnValue([]);
    vi.spyOn(db, 'predictDuration').mockReturnValue({
      predicted_minutes: 0,
      confidence: 0,
      factors: [],
    });
    vi.spyOn(db, 'getDurationInsights').mockReturnValue({
      accuracy: {
        total_predictions: 0,
        avg_error_percent: null,
        within_20_percent: null,
      },
      models: [],
      recent_predictions: [],
    });
    vi.spyOn(db, 'calibratePredictionModels').mockReturnValue({
      models_updated: 0,
      samples_processed: 0,
    });
    vi.spyOn(db, 'updateTaskStatus').mockImplementation(() => {});
    vi.spyOn(db, 'setTaskReviewStatus').mockImplementation(() => {});
    vi.spyOn(db, 'getTasksPendingReview').mockReturnValue([]);
    vi.spyOn(db, 'getTasksNeedingCorrection').mockReturnValue([]);
    vi.spyOn(db, 'routeTask').mockReturnValue({
      provider: 'desktop',
      rule: 'Default',
    });
    vi.spyOn(db, 'deleteTasks').mockReturnValue({
      deleted: 0,
      status: 'queued',
    });
    vi.spyOn(db, 'deleteTask').mockReturnValue({
      id: 'deleted-task',
      status: 'completed',
    });

    vi.spyOn(taskManager, 'pauseTask').mockReturnValue(true);
    vi.spyOn(taskManager, 'getTaskProgress').mockReturnValue(null);
    vi.spyOn(taskManager, 'resumeTask').mockReturnValue(true);
    vi.spyOn(taskManager, 'processQueue').mockImplementation(() => {});

    vi.spyOn(taskLogger, 'debug').mockImplementation(() => {});
    vi.spyOn(taskLogger, 'info').mockImplementation(() => {});
    vi.spyOn(taskLogger, 'warn').mockImplementation(() => {});
    vi.spyOn(taskLogger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('handleStreamTaskOutput', () => {
    it('returns a task-not-found error for missing tasks', () => {
      db.getTask.mockReturnValue(null);

      const result = handlers.handleStreamTaskOutput({ task_id: 'missing-task' });

      expectError(result, 'TASK_NOT_FOUND', 'Task not found: missing-task');
    });

    it('sanitizes sequence and limit values and merges chunk output', () => {
      db.getLatestStreamChunks.mockReturnValue([
        { sequence_num: 2, chunk_data: 'hello ' },
        { sequence_num: 3, chunk_data: 'world' },
      ]);

      const result = handlers.handleStreamTaskOutput({
        task_id: 'task-stream',
        since_sequence: -5,
        limit: 999,
      });

      expect(db.getLatestStreamChunks).toHaveBeenCalledWith('task-stream', 0, 500);

      const payload = JSON.parse(getText(result));
      expect(payload.task_id).toBe('task-stream');
      expect(payload.status).toBe('running');
      expect(payload.chunk_count).toBe(2);
      expect(payload.last_sequence).toBe(3);
      expect(payload.output).toBe('hello world');
      expect(payload.has_more).toBe(false);
    });

    it('returns empty output and preserves the requested sequence when no chunks exist', () => {
      const result = handlers.handleStreamTaskOutput({
        task_id: 'task-stream',
        since_sequence: 7,
        limit: 2,
      });

      const payload = JSON.parse(getText(result));
      expect(payload.chunk_count).toBe(0);
      expect(payload.last_sequence).toBe(7);
      expect(payload.output).toBe('');
      expect(payload.has_more).toBe(false);
    });
  });

  describe('handleGetTaskLogs', () => {
    it('returns a task-not-found error for missing tasks', () => {
      db.getTask.mockReturnValue(null);

      const result = handlers.handleGetTaskLogs({ task_id: 'missing-task' });

      expectError(result, 'TASK_NOT_FOUND', 'Task not found: missing-task');
    });

    it('passes filters through and formats stdout/stderr content', () => {
      db.getTask.mockReturnValue(makeTask({ id: 'task-logs', status: 'failed' }));
      db.getTaskLogs.mockReturnValue([
        {
          timestamp: '2026-03-12T12:00:00.000Z',
          type: 'stdout',
          content: 'line one',
        },
        {
          timestamp: '2026-03-12T12:01:00.000Z',
          type: 'stderr',
          content: 'line two\n',
        },
      ]);

      const result = handlers.handleGetTaskLogs({
        task_id: 'task-logs',
        level: 'error',
        search: 'line',
        limit: 3,
      });

      expect(db.getTaskLogs).toHaveBeenCalledWith('task-logs', {
        level: 'error',
        search: 'line',
        limit: 3,
      });

      const text = getText(result);
      expect(text).toContain('## Task Logs: task-logs');
      expect(text).toContain('**Status:** failed');
      expect(text).toContain('**Results:** 2 entries');
      expect(text).toMatch(/\[OUT\] line one\n/);
      expect(text).toContain('[ERR] line two');
    });
  });

  describe('handleSubscribeTaskEvents', () => {
    it('returns a task-not-found error when subscribing to a missing task', () => {
      db.getTask.mockReturnValue(null);

      const result = handlers.handleSubscribeTaskEvents({ task_id: 'missing-task' });

      expectError(result, 'TASK_NOT_FOUND', 'Task not found: missing-task');
    });

    it('rejects non-array event types', () => {
      const result = handlers.handleSubscribeTaskEvents({
        task_id: 'task-1',
        event_types: 'status_change',
      });

      expectError(result, 'INVALID_PARAM', 'event_types must be an array');
    });

    it('rejects unsupported event types', () => {
      const result = handlers.handleSubscribeTaskEvents({
        task_id: 'task-1',
        event_types: ['status_change', 'mystery'],
      });

      expectError(result, 'INVALID_PARAM', 'Invalid event type: mystery');
    });

    it('rejects invalid expiration windows', () => {
      const result = handlers.handleSubscribeTaskEvents({
        task_id: 'task-1',
        expires_in_minutes: 0,
      });

      expectError(result, 'INVALID_PARAM', 'expires_in_minutes must be a positive number');
    });

    it('creates an all-task subscription with default values', () => {
      db.createEventSubscription.mockReturnValue('sub-all');

      const result = handlers.handleSubscribeTaskEvents({});

      expect(db.createEventSubscription).toHaveBeenCalledWith(
        undefined,
        ['status_change'],
        60
      );
      expect(getText(result)).toContain('**Subscription ID:** `sub-all`');
      expect(getText(result)).toContain('**Task:** All tasks');
      expect(getText(result)).toContain('status_change');
    });
  });

  describe('handlePollTaskEvents', () => {
    it('returns an error for unknown subscriptions', () => {
      db.pollSubscription.mockReturnValue(null);

      const result = handlers.handlePollTaskEvents({ subscription_id: 'sub-missing' });

      expectError(result, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found: sub-missing');
    });

    it('reports expired subscriptions', () => {
      db.pollSubscription.mockReturnValue({ expired: true, events: [] });

      const result = handlers.handlePollTaskEvents({ subscription_id: 'sub-expired' });

      expect(result.isError).not.toBe(true);
      expect(getText(result)).toContain('## Subscription Expired');
      expect(getText(result)).toContain('sub-expired');
    });

    it('reports when no new events are available', () => {
      const result = handlers.handlePollTaskEvents({ subscription_id: 'sub-idle' });

      expect(result.isError).not.toBe(true);
      expect(getText(result)).toContain('## No New Events');
      expect(getText(result)).toContain('sub-idle');
    });

    it('renders event details including status changes and data payloads', () => {
      db.pollSubscription.mockReturnValue({
        expired: false,
        events: [
          {
            event_type: 'status_change',
            task_id: 'task-1',
            created_at: '2026-03-12T12:00:00.000Z',
            old_value: 'queued',
            new_value: 'running',
            event_data: '{"attempt":1}',
          },
          {
            event_type: 'output',
            task_id: 'task-2',
            created_at: '2026-03-12T12:05:00.000Z',
            old_value: null,
            new_value: null,
            event_data: 'chunk ready',
          },
        ],
      });

      const result = handlers.handlePollTaskEvents({ subscription_id: 'sub-live' });
      const text = getText(result);

      expect(text).toContain('## Task Events');
      expect(text).toContain('### status_change');
      expect(text).toContain('- **Change:** queued → running');
      expect(text).toContain('- **Data:** {"attempt":1}');
      expect(text).toContain('### output');
      expect(text).toContain('chunk ready');
    });
  });

  describe('handlePauseTask', () => {
    it('rejects pausing tasks that are not running', () => {
      db.getTask.mockReturnValue(makeTask({ id: 'task-pause', status: 'queued' }));

      const result = handlers.handlePauseTask({ task_id: 'task-pause' });

      expectError(result, 'INVALID_STATUS_TRANSITION', 'Cannot pause task with status');
    });

    it('returns an operation error when the task manager cannot pause the task', () => {
      db.getTask.mockReturnValue(makeTask({ id: 'task-pause', status: 'running' }));
      taskManager.pauseTask.mockReturnValue(false);

      const result = handlers.handlePauseTask({
        task_id: 'task-pause',
        reason: 'operator request',
      });

      expectError(result, 'OPERATION_FAILED', 'Failed to pause task: task-pause');
    });

    it('saves a checkpoint and updates pause state for running tasks', () => {
      db.getTask.mockReturnValue(makeTask({ id: 'task-pause', status: 'running' }));
      taskManager.getTaskProgress.mockReturnValue({ step: 3, progress: 50 });

      const result = handlers.handlePauseTask({
        task_id: 'task-pause',
        reason: 'maintenance window',
      });

      expect(taskManager.pauseTask).toHaveBeenCalledWith('task-pause', 'maintenance window');
      expect(db.saveTaskCheckpoint).toHaveBeenCalledWith(
        'task-pause',
        { step: 3, progress: 50 },
        'pause'
      );
      expect(db.pauseTask).toHaveBeenCalledWith('task-pause', 'maintenance window');
      expect(getText(result)).toContain('## Task Paused');
      expect(getText(result)).toContain('maintenance window');
    });
  });

  describe('handleResumeTask', () => {
    it('rejects resuming tasks that are not paused', () => {
      db.getTask.mockReturnValue(makeTask({ id: 'task-resume', status: 'running' }));

      const result = handlers.handleResumeTask({ task_id: 'task-resume' });

      expectError(result, 'INVALID_STATUS_TRANSITION', 'Cannot resume task with status');
    });

    it('returns an operation error when the task manager cannot resume the task', () => {
      db.getTask.mockReturnValue(makeTask({ id: 'task-resume', status: 'paused' }));
      taskManager.resumeTask.mockReturnValue(false);

      const result = handlers.handleResumeTask({ task_id: 'task-resume' });

      expectError(result, 'OPERATION_FAILED', 'Failed to resume task: task-resume');
    });

    it('clears pause state, records an event, and reports checkpoint restoration', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T12:30:00.000Z'));
      db.getTask.mockReturnValue(makeTask({
        id: 'task-resume',
        status: 'paused',
        paused_at: '2026-03-12T12:00:00.000Z',
      }));
      db.getTaskCheckpoint.mockReturnValue({ step: 5 });

      const result = handlers.handleResumeTask({ task_id: 'task-resume' });
      const text = getText(result);

      expect(taskManager.resumeTask).toHaveBeenCalledWith('task-resume');
      expect(db.clearPauseState).toHaveBeenCalledWith('task-resume');
      expect(db.recordTaskEvent).toHaveBeenCalledWith(
        'task-resume',
        'status_change',
        'paused',
        'running',
        null
      );
      expect(text).toContain('## Task Resumed');
      expect(text).toContain('30 minutes');
      expect(text).toContain('**Checkpoint restored:** Yes');
    });
  });

  describe('handleListPausedTasks', () => {
    it('reports when no paused tasks exist for a project', () => {
      const result = handlers.handleListPausedTasks({ project: 'alpha' });

      expect(db.listPausedTasks).toHaveBeenCalledWith({ project: 'alpha', limit: 50 });
      expect(getText(result)).toContain('No paused tasks found for project: alpha.');
    });

    it('formats paused task rows with truncation and fallback duration text', () => {
      db.listPausedTasks.mockReturnValue([
        {
          id: 'abcdef12-1234-1234-1234-1234567890ab',
          task_description: 'This is a deliberately long task description that should be truncated',
          paused_minutes: 12.6,
          pause_reason: 'Awaiting approval',
        },
        {
          id: 'fedcba98-1234-1234-1234-1234567890ab',
          task_description: 'Short description',
          paused_minutes: null,
          pause_reason: null,
        },
      ]);

      const result = handlers.handleListPausedTasks({ limit: 2 });
      const text = getText(result);

      expect(db.listPausedTasks).toHaveBeenCalledWith({ project: undefined, limit: 2 });
      expect(text).toContain('| abcdef12 | This is a deliberately long task descrip...');
      expect(text).toContain('| 13 min | Awaiting approval |');
      expect(text).toContain('| fedcba98 | Short description | Unknown | - |');
      expect(text).toContain('**Total:** 2 paused task(s)');
    });
  });

  describe('handleSuggestImprovements', () => {
    it('rejects tasks that are not failed', () => {
      db.getTask.mockReturnValue(makeTask({ id: 'task-suggest', status: 'completed' }));

      const result = handlers.handleSuggestImprovements({ task_id: 'task-suggest' });

      expectError(result, 'INVALID_STATUS_TRANSITION', 'Task is not failed');
    });

    it('returns a no-suggestions message when analysis finds nothing actionable', () => {
      db.getTask.mockReturnValue(makeTask({
        id: 'task-suggest',
        status: 'failed',
        error_output: 'Compilation failed on line 12',
      }));

      const result = handlers.handleSuggestImprovements({ task_id: 'task-suggest' });
      const text = getText(result);

      expect(text).toContain('## No Suggestions Found');
      expect(text).toContain('Compilation failed on line 12');
    });

    it('sorts suggestions by confidence and truncates the error output section', () => {
      db.getTask.mockReturnValue(makeTask({
        id: 'task-suggest',
        status: 'failed',
        task_description: 'Investigate repeated timeout failures in the indexing worker',
        error_output: 'E'.repeat(320),
      }));
      db.generateTaskSuggestions.mockReturnValue([
        { type: 'retry', confidence: 0.35, suggestion: 'Retry after checking transient failures.' },
        { type: 'timeout', confidence: 0.92, suggestion: 'Increase timeout or break the task down.' },
      ]);

      const result = handlers.handleSuggestImprovements({ task_id: 'task-suggest' });
      const text = getText(result);

      expect(db.generateTaskSuggestions).toHaveBeenCalledWith('task-suggest');
      expect(text.indexOf('**timeout**')).toBeLessThan(text.indexOf('**retry**'));
      expect(text).toContain('92%');
      expect(text).toContain('### Error Output (truncated):');
      expect(text).toContain(`${'E'.repeat(300)}...`);
    });
  });

  describe('handleFindSimilarTasks', () => {
    it('returns a no-results message when no similar tasks are found', () => {
      db.getTask.mockReturnValue(makeTask({
        id: 'task-similar',
        task_description: 'Build a routing diagnostic report',
      }));

      const result = handlers.handleFindSimilarTasks({
        task_id: 'task-similar',
        min_similarity: 0.45,
      });

      expect(db.findSimilarTasks).toHaveBeenCalledWith('task-similar', {
        limit: 10,
        minSimilarity: 0.45,
        statusFilter: undefined,
      });
      expect(getText(result)).toContain('No tasks found with similarity >= 45%');
    });

    it('formats similar task results and forwards the status filter', () => {
      db.getTask.mockReturnValue(makeTask({
        id: 'task-similar',
        task_description: 'Write authentication unit tests with retries',
      }));
      db.findSimilarTasks.mockReturnValue([
        {
          similarity: 0.83,
          task: {
            id: 'abcdefff-1234-1234-1234-1234567890ab',
            status: 'completed',
            task_description: 'Write authentication integration tests with fixtures',
          },
        },
      ]);

      const result = handlers.handleFindSimilarTasks({
        task_id: 'task-similar',
        limit: 5,
        min_similarity: 0.25,
        status_filter: 'completed',
      });

      expect(db.findSimilarTasks).toHaveBeenCalledWith('task-similar', {
        limit: 5,
        minSimilarity: 0.25,
        statusFilter: 'completed',
      });
      expect(getText(result)).toContain('## Similar Tasks for task-sim');
      expect(getText(result)).toContain('| 83% | abcdefff | completed |');
      expect(getText(result)).toContain('**Found:** 1 similar task(s)');
    });
  });

  describe('handleLearnDefaults', () => {
    it('reports when no patterns have been learned yet', () => {
      db.learnFromRecentTasks.mockReturnValue({ tasksProcessed: 4, patternsLearned: 0 });

      const result = handlers.handleLearnDefaults({ task_limit: 4 });

      expect(db.learnFromRecentTasks).toHaveBeenCalledWith(4);
      expect(db.getTaskPatterns).toHaveBeenCalledWith({ minHitCount: 1, limit: 20 });
      expect(getText(result)).toContain('**Tasks analyzed:** 4');
      expect(getText(result)).toContain('No patterns learned yet');
    });

    it('renders learned pattern rows with suggested configuration values', () => {
      db.learnFromRecentTasks.mockReturnValue({ tasksProcessed: 12, patternsLearned: 3 });
      db.getTaskPatterns.mockReturnValue([
        {
          pattern_type: 'keyword',
          pattern_value: 'test',
          hit_count: 5,
          success_rate: 0.8,
          suggested_config: { timeout_minutes: 45, priority: 2 },
        },
      ]);

      const result = handlers.handleLearnDefaults({});
      const text = getText(result);

      expect(text).toContain('### Learned Patterns (1):');
      expect(text).toContain('| keyword | test | 5 | 80% | timeout=45m, priority=2 |');
    });
  });

  describe('handleApplySmartDefaults', () => {
    it('shows base defaults when no patterns match', () => {
      db.getSmartDefaults.mockReturnValue({
        timeout_minutes: 30,
        auto_approve: false,
        priority: 0,
        confidence: 0,
        matched_patterns: [],
      });

      const result = handlers.handleApplySmartDefaults({
        task_description: 'A brand new task description with no prior history',
      });

      const text = getText(result);
      expect(db.getSmartDefaults).toHaveBeenCalledWith(
        'A brand new task description with no prior history',
        undefined
      );
      expect(text).toContain('| timeout_minutes | 30 | default |');
      expect(text).toContain('*No patterns matched. Using default values.');
      expect(text).toContain('"auto_approve": false');
    });

    it('renders matched pattern details and confidence values', () => {
      db.getSmartDefaults.mockReturnValue({
        timeout_minutes: 90,
        auto_approve: true,
        priority: 3,
        confidence: 0.76,
        matched_patterns: [
          {
            type: 'project',
            value: 'alpha',
            hit_count: 4,
            success_rate: 0.75,
          },
        ],
      });

      const result = handlers.handleApplySmartDefaults({
        task_description: 'Refactor alpha build pipeline',
        project: 'alpha',
      });

      const text = getText(result);
      expect(text).toContain('**Project:** alpha');
      expect(text).toContain('| timeout_minutes | 90 | 76% |');
      expect(text).toContain('| auto_approve | true | 76% |');
      expect(text).toContain('- **project:** "alpha" (4 hits, 75% success)');
      expect(text).toContain('"priority": 3');
    });
  });

  describe('handleAddComment', () => {
    it('returns a task-not-found error for missing tasks', () => {
      db.getTask.mockReturnValue(null);

      const result = handlers.handleAddComment({
        task_id: 'missing-task',
        comment: 'Needs follow-up',
      });

      expectError(result, 'TASK_NOT_FOUND', 'Task not found: missing-task');
    });

    it('adds the comment and writes an audit entry', () => {
      db.addTaskComment.mockReturnValue(77);

      const result = handlers.handleAddComment({
        task_id: 'task-comment',
        comment: 'Blocked on fixture refresh',
        comment_type: 'blocker',
        author: 'alice',
      });

      expect(db.addTaskComment).toHaveBeenCalledWith('task-comment', 'Blocked on fixture refresh', {
        author: 'alice',
        commentType: 'blocker',
      });
      expect(db.recordAuditLog).toHaveBeenCalledWith(
        'comment',
        '77',
        'create',
        'alice',
        null,
        JSON.stringify({
          task_id: 'task-comment',
          comment_type: 'blocker',
          comment: 'Blocked on fixture refresh',
        })
      );
      expect(getText(result)).toContain('🚫 Comment added to task task-com');
      expect(getText(result)).toContain('**Author:** alice');
    });

    it('keeps succeeding when audit logging fails', () => {
      db.recordAuditLog.mockImplementation(() => {
        throw new Error('disk full');
      });

      const result = handlers.handleAddComment({
        task_id: 'task-comment',
        comment: 'Resolved after rerun',
        comment_type: 'resolution',
        author: 'bob',
      });

      expect(result.isError).not.toBe(true);
      expect(getText(result)).toContain('✅ Comment added to task task-com');
      expect(getText(result)).toContain('Resolved after rerun');
    });
  });

  describe('handleListComments', () => {
    it('reports when no comments exist for the requested type', () => {
      const result = handlers.handleListComments({
        task_id: 'task-comment',
        comment_type: 'blocker',
      });

      expect(db.getTaskComments).toHaveBeenCalledWith('task-comment', { commentType: 'blocker' });
      expect(getText(result)).toContain("No comments found of type 'blocker'.");
    });

    it('formats task comments with icons and totals', () => {
      db.getTaskComments.mockReturnValue([
        {
          comment_type: 'note',
          author: 'alice',
          created_at: '2026-03-12T12:00:00.000Z',
          comment_text: 'Investigating a flaky failure.',
        },
        {
          comment_type: 'resolution',
          author: 'bob',
          created_at: '2026-03-12T12:30:00.000Z',
          comment_text: 'Fixed by seeding fixtures first.',
        },
      ]);

      const result = handlers.handleListComments({ task_id: 'task-comment' });
      const text = getText(result);

      expect(text).toContain('### 📝 NOTE by alice');
      expect(text).toContain('Investigating a flaky failure.');
      expect(text).toContain('### ✅ RESOLUTION by bob');
      expect(text).toContain('Fixed by seeding fixtures first.');
      expect(text).toContain('**Total:** 2 comment(s)');
    });
  });

  describe('handleTaskTimeline', () => {
    it('reports when a task has no timeline events', () => {
      const result = handlers.handleTaskTimeline({ task_id: 'task-timeline' });

      expect(db.getTaskTimeline).toHaveBeenCalledWith('task-timeline');
      expect(getText(result)).toContain('No timeline events found.');
    });

    it('renders known and unknown timeline event types with details', () => {
      db.getTask.mockReturnValue(makeTask({
        id: 'task-timeline',
        status: 'failed',
        task_description: 'Audit the route capture timeline',
      }));
      db.getTaskTimeline.mockReturnValue([
        {
          event_type: 'created',
          timestamp: '2026-03-12T11:00:00.000Z',
          details: 'Task was queued from the dashboard.',
        },
        {
          type: 'custom_event',
          timestamp: '2026-03-12T11:15:00.000Z',
          details: 'Custom telemetry marker was attached.',
        },
      ]);

      const result = handlers.handleTaskTimeline({ task_id: 'task-timeline' });
      const text = getText(result);

      expect(text).toContain('## Timeline for Task task-tim');
      expect(text).toContain('**Current Status:** failed');
      expect(text).toContain('### 🆕 CREATED');
      expect(text).toContain('Task was queued from the dashboard.');
      expect(text).toContain('### 📌 CUSTOM EVENT');
      expect(text).toContain('Custom telemetry marker was attached.');
      expect(text).toContain('**Total Events:** 2');
    });
  });

  describe('handleDryRunBulk', () => {
    it('passes normalized filter criteria and reports zero matches', () => {
      db.dryRunBulkOperation.mockReturnValue({ total_tasks: 0, preview: [] });

      const result = handlers.handleDryRunBulk({
        operation: 'cancel',
        status: 'queued',
        tags: ['bug'],
        older_than_hours: 12,
        project: 'alpha',
      });

      expect(db.dryRunBulkOperation).toHaveBeenCalledWith('cancel', {
        status: ['queued'],
        tags: ['bug'],
        older_than_hours: 12,
        project: 'alpha',
      });
      expect(getText(result)).toContain('## Dry Run: CANCEL Operation');
      expect(getText(result)).toContain('**Total Tasks Affected:** 0');
      expect(getText(result)).toContain('No tasks match the specified filters.');
    });

    it('renders a preview table and overflow notice when more than ten tasks match', () => {
      const preview = Array.from({ length: 10 }, (_, index) => ({
        id: `task-${index}-12345678`,
        status: 'failed',
        description: `Preview task ${index}`,
      }));
      db.dryRunBulkOperation.mockReturnValue({
        total_tasks: 12,
        preview,
      });

      const result = handlers.handleDryRunBulk({
        operation: 'retry',
        status: ['failed', 'timeout'],
      });

      const text = getText(result);
      expect(db.dryRunBulkOperation).toHaveBeenCalledWith('retry', {
        status: ['failed', 'timeout'],
      });
      expect(text).toContain('```json');
      expect(text).toContain('"status": [');
      expect(text).toContain('| task-0-1... | failed | Preview task 0 |');
      expect(text).toContain('*...and 2 more tasks*');
      expect(text).toContain('Use the actual batch operation');
    });
  });

  describe('handleBulkOperationStatus', () => {
    it('returns a resource-not-found error for unknown operations', () => {
      const result = handlers.handleBulkOperationStatus({ operation_id: 'bulk-missing' });

      expectError(result, 'RESOURCE_NOT_FOUND', 'Bulk operation not found: bulk-missing');
    });

    it('formats progress, errors, and JSON results for existing operations', () => {
      db.getBulkOperation.mockReturnValue({
        id: 'bulk-12345678',
        operation_type: 'retry',
        status: 'completed',
        created_at: '2026-03-12T12:00:00.000Z',
        completed_at: '2026-03-12T12:15:00.000Z',
        total_tasks: 12,
        succeeded_tasks: 10,
        failed_tasks: 2,
        error: '2 tasks exceeded retry budget',
        results: { retried: ['task-1'], failed: ['task-2'] },
      });

      const result = handlers.handleBulkOperationStatus({ operation_id: 'bulk-12345678' });
      const text = getText(result);

      expect(text).toContain('## Bulk Operation: bulk-123...');
      expect(text).toContain('**Type:** retry');
      expect(text).toContain('**Status:** completed');
      expect(text).toContain('| Total Tasks | 12 |');
      expect(text).toContain('| Succeeded | 10 |');
      expect(text).toContain('| Failed | 2 |');
      expect(text).toContain('2 tasks exceeded retry budget');
      expect(text).toContain('"retried": [');
    });
  });

  describe('handleListBulkOperations', () => {
    it('lists bulk operations with filter arguments', () => {
      db.listBulkOperations.mockReturnValue([
        {
          id: 'bulk-12345678',
          operation_type: 'cancel',
          status: 'completed',
          total_tasks: 4,
          created_at: '2026-03-12T12:00:00.000Z',
        },
      ]);

      const result = handlers.handleListBulkOperations({
        operation_type: 'cancel',
        status: 'completed',
        limit: 3,
      });
      const text = getText(result);

      expect(db.listBulkOperations).toHaveBeenCalledWith({
        operation_type: 'cancel',
        status: 'completed',
        limit: 3,
      });
      expect(text).toContain('## Bulk Operations');
      expect(text).toContain('| bulk-123... | cancel | completed | 4 |');
      expect(text).toContain('**Total:** 1 operations');
    });
  });

  describe('handlePredictDuration', () => {
    it('formats prediction output and low-confidence guidance', () => {
      db.predictDuration.mockReturnValue({
        predicted_minutes: 42,
        confidence: 0.41,
        factors: [
          { source: 'keyword', name: 'integration', value: 1800.4, weight: 0.65 },
          { source: 'project', name: 'alpha', value: 900.2, weight: 0.35 },
        ],
      });

      const result = handlers.handlePredictDuration({
        task_description: 'Run integration verification for alpha services',
        template_name: 'verify',
        project: 'alpha',
      });
      const text = getText(result);

      expect(db.predictDuration).toHaveBeenCalledWith(
        'Run integration verification for alpha services',
        {
          template_name: 'verify',
          project: 'alpha',
        }
      );
      expect(text).toContain('## Duration Prediction');
      expect(text).toContain('| Predicted Duration | 42 minutes |');
      expect(text).toContain('| Confidence | 41% |');
      expect(text).toContain('| keyword | integration | 1800 | 65% |');
      expect(text).toContain('Low confidence prediction');
    });
  });

  describe('handleDurationInsights', () => {
    it('renders accuracy metrics, models, and recent prediction rows', () => {
      db.getDurationInsights.mockReturnValue({
        accuracy: {
          total_predictions: 9,
          avg_error_percent: 18,
          within_20_percent: 78,
        },
        models: [
          {
            model_type: 'project',
            model_key: 'alpha',
            sample_count: 5,
            avg_seconds: 1240,
          },
        ],
        recent_predictions: [
          {
            task_id: 'task-12345678',
            predicted_seconds: 1800,
            actual_seconds: 2100,
            error_percent: 17,
          },
        ],
      });

      const result = handlers.handleDurationInsights({ project: 'alpha', limit: 5 });
      const text = getText(result);

      expect(db.getDurationInsights).toHaveBeenCalledWith({
        project: 'alpha',
        limit: 5,
      });
      expect(text).toContain('| Total Predictions | 9 |');
      expect(text).toContain('| Average Error | 18% |');
      expect(text).toContain('| project | alpha | 5 | 1240 |');
      expect(text).toContain('| task-123... | 30m | 35m | 17% |');
    });
  });

  describe('handleCalibratePredictions', () => {
    it('reports when prediction models were updated', () => {
      db.calibratePredictionModels.mockReturnValue({
        models_updated: 3,
        samples_processed: 27,
      });

      const result = handlers.handleCalibratePredictions({});
      const text = getText(result);

      expect(text).toContain('**Models Updated:** 3');
      expect(text).toContain('**Samples Processed:** 27');
      expect(text).toContain('Prediction models have been recalculated');
    });

    it('reports when calibration has insufficient historical data', () => {
      db.calibratePredictionModels.mockReturnValue({
        models_updated: 0,
        samples_processed: 1,
      });

      const result = handlers.handleCalibratePredictions({});

      expect(getText(result)).toContain('No models were updated');
    });
  });

  describe('handleStartPendingTask', () => {
    it('requires a task_id', () => {
      const result = handlers.handleStartPendingTask({});

      expectError(result, 'MISSING_REQUIRED_PARAM', 'task_id is required');
    });

    it('rejects tasks that are not pending', () => {
      db.getTask.mockReturnValue(makeTask({ id: 'task-start', status: 'queued' }));

      const result = handlers.handleStartPendingTask({ task_id: 'task-start' });

      expectError(result, 'INVALID_STATUS_TRANSITION', 'Task task-start is not pending');
    });

    it('queues pending tasks and includes aggregation details from metadata', () => {
      db.getTask.mockReturnValue(makeTask({
        id: 'task-start',
        status: 'pending',
        metadata: JSON.stringify({
          is_aggregation: true,
          chunk_task_ids: ['chunk-1', 'chunk-2'],
          file_path: 'src/task.js',
        }),
      }));

      const result = handlers.handleStartPendingTask({ task_id: 'task-start' });
      const text = getText(result);

      expect(db.updateTaskStatus).toHaveBeenCalledWith('task-start', 'queued');
      expect(taskManager.processQueue).toHaveBeenCalledTimes(1);
      expect(text).toContain('## Task Started');
      expect(text).toContain('| Previous Status | pending |');
      expect(text).toContain('This task will aggregate 2 chunk reviews for `src/task.js`.');
    });
  });

  describe('handleSetTaskReviewStatus', () => {
    it('validates required task IDs and review statuses', () => {
      const missingTask = handlers.handleSetTaskReviewStatus({ status: 'approved' });
      const invalidStatus = handlers.handleSetTaskReviewStatus({
        task_id: 'task-review',
        status: 'reopened',
      });

      expectError(missingTask, 'MISSING_REQUIRED_PARAM', 'task_id must be a non-empty string');
      expectError(invalidStatus, 'INVALID_PARAM', 'status must be one of: pending, approved, needs_correction');
    });

    it('updates review status and includes notes in the response', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T12:45:00.000Z'));

      const result = handlers.handleSetTaskReviewStatus({
        task_id: 'task-review',
        status: 'needs_correction',
        notes: 'Retry with stricter verification output.',
      });
      const text = getText(result);

      expect(db.setTaskReviewStatus).toHaveBeenCalledWith(
        'task-review',
        'needs_correction',
        'Retry with stricter verification output.'
      );
      expect(text).toContain('## Task Review Status Updated');
      expect(text).toContain('| Status | needs_correction |');
      expect(text).toContain('| Notes | Retry with stricter verification output. |');
      expect(text).toContain('| Reviewed At | 2026-03-12T12:45:00.000Z |');
    });
  });

  describe('handleListPendingReviews', () => {
    it('reports when no completed tasks are awaiting review', () => {
      const result = handlers.handleListPendingReviews({});

      expect(db.getTasksPendingReview).toHaveBeenCalledWith(20);
      expect(getText(result)).toContain('## No Tasks Pending Review');
    });

    it('formats pending review rows and next-step guidance', () => {
      db.getTasksPendingReview.mockReturnValue([
        {
          id: 'task-review-1',
          task_description: 'Review the output bundle for the routing verification workflow',
          complexity: 'complex',
          provider: 'codex',
          completed_at: '2026-03-12T12:00:00.000Z',
        },
      ]);

      const result = handlers.handleListPendingReviews({ limit: 1 });
      const text = getText(result);

      expect(db.getTasksPendingReview).toHaveBeenCalledWith(1);
      expect(text).toContain('## Tasks Pending Review (1)');
      expect(text).toContain('| task-review-1 | Review the output bundle for the routing verificat...');
      expect(text).toContain('| complex | codex | 2026-03-12T12:00:00.000Z |');
      expect(text).toContain('Use `set_task_review_status` to approve or mark tasks for correction');
    });
  });

  describe('handleListTasksNeedingCorrection', () => {
    it('formats tasks requiring correction with fallback notes', () => {
      db.getTasksNeedingCorrection.mockReturnValue([
        {
          id: 'task-correct-1',
          task_description: 'Fix the validation step so routing bundles include every manifest artifact',
          complexity: 'normal',
          review_notes: '',
          reviewed_at: null,
        },
      ]);

      const result = handlers.handleListTasksNeedingCorrection({});
      const text = getText(result);

      expect(text).toContain('## Tasks Needing Correction (1)');
      expect(text).toContain('### task-correct-1');
      expect(text).toContain('**Complexity:** normal');
      expect(text).toContain('**Review Notes:** No notes provided');
      expect(text).toContain('Resubmit corrected tasks using `submit_task` or `smart_submit_task`');
    });
  });

  describe('handleSetTaskComplexity', () => {
    it('validates complexity values', () => {
      const result = handlers.handleSetTaskComplexity({
        task_id: 'task-complexity',
        complexity: 'expert',
      });

      expectError(result, 'INVALID_PARAM', 'complexity must be one of: simple, normal, complex');
    });

    it('updates task complexity while preserving the current status', () => {
      db.getTask.mockReturnValue(makeTask({ id: 'task-complexity', status: 'running' }));

      const result = handlers.handleSetTaskComplexity({
        task_id: 'task-complexity',
        complexity: 'complex',
      });

      expect(db.updateTaskStatus).toHaveBeenCalledWith(
        'task-complexity',
        'running',
        { complexity: 'complex' }
      );
      expect(getText(result)).toContain('Task task-complexity complexity set to **complex**.');
      expect(getText(result)).toContain('complex → Codex');
    });
  });

  describe('handleGetComplexityRouting', () => {
    it('validates complexity values before routing', () => {
      const result = handlers.handleGetComplexityRouting({ complexity: 'expert' });

      expectError(result, 'INVALID_PARAM', 'complexity must be one of: simple, normal, complex');
    });

    it('renders provider, host, model, and rule data', () => {
      db.routeTask.mockReturnValue({
        provider: 'ollama',
        host: 'desktop-01',
        model: 'qwen2.5-coder:32b',
        rule: 'Complexity map',
      });

      const result = handlers.handleGetComplexityRouting({ complexity: 'complex' });
      const text = getText(result);

      expect(db.routeTask).toHaveBeenCalledWith('complex');
      expect(text).toContain('## Complexity Routing for "complex"');
      expect(text).toContain('| Provider | ollama |');
      expect(text).toContain('| Host | desktop-01 |');
      expect(text).toContain('| Model | qwen2.5-coder:32b |');
      expect(text).toContain('| Rule | Complexity map |');
    });
  });

  describe('handleDeleteTask', () => {
    it('requires either a task_id or a status selector', () => {
      const result = handlers.handleDeleteTask({});

      expectError(result, 'MISSING_REQUIRED_PARAM', 'Provide either task_id (single) or status (bulk) to delete tasks.');
    });

    it('deletes tasks in bulk by status', () => {
      db.deleteTasks.mockReturnValue({
        deleted: 4,
        status: 'failed',
      });

      const result = handlers.handleDeleteTask({ status: 'failed' });

      expect(db.deleteTasks).toHaveBeenCalledWith('failed');
      expect(getText(result)).toContain("Deleted 4 task(s) with status 'failed'.");
    });

    it('maps single-task delete failures to task-not-found errors', () => {
      db.deleteTask.mockImplementation(() => {
        throw new Error('task-delete missing');
      });

      const result = handlers.handleDeleteTask({ task_id: 'task-delete' });

      expectError(result, 'TASK_NOT_FOUND', 'Failed to delete task: task-delete missing');
    });
  });
});
