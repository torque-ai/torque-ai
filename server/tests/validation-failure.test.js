'use strict';

const realShared = require('../handlers/shared');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const addFailurePattern = vi.fn();
const getFailureMatches = vi.fn();
const listRetryRules = vi.fn();
const addRetryRule = vi.fn();
const getTask = vi.fn();

const mockDb = {
  addFailurePattern,
  getFailureMatches,
  listRetryRules,
  addRetryRule,
  getTask,
  saveFailurePattern: addFailurePattern,
  getRetryRules: listRetryRules,
  saveRetryRule: addRetryRule,
};

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/validation/failure')];
  installMock('../database', mockDb);
  installMock('../handlers/shared', realShared);
  return require('../handlers/validation/failure');
}

function resetMocks() {
  addFailurePattern.mockReset();
  getFailureMatches.mockReset();
  listRetryRules.mockReset();
  addRetryRule.mockReset();
  getTask.mockReset();
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('validation/failure handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMocks();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleAddFailurePattern', () => {
    it('returns MISSING_REQUIRED_PARAM when required fields are missing', () => {
      const result = handlers.handleAddFailurePattern({ name: 'Timeout' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('name, description, and signature are required');
      expect(addFailurePattern).not.toHaveBeenCalled();
    });

    it('saves a failure pattern and returns the markdown summary', () => {
      vi.spyOn(Date, 'now').mockReturnValue(123456);

      const result = handlers.handleAddFailurePattern({
        name: 'Dependency install failed',
        description: 'npm install exited non-zero',
        signature: 'ERESOLVE',
      });

      expect(addFailurePattern).toHaveBeenCalledWith({
        id: 'fp-123456',
        name: 'Dependency install failed',
        description: 'npm install exited non-zero',
        signature: 'ERESOLVE',
        provider: null,
        severity: 'medium',
      });
      expect(getText(result)).toContain('## Failure Pattern Added');
      expect(getText(result)).toContain('fp-123456');
      expect(getText(result)).toContain('Provider:** all');
      expect(getText(result)).toContain('Severity:** medium');
    });
  });

  describe('handleGetFailureMatches', () => {
    it('returns the missing task prompt when task_id is absent', () => {
      const result = handlers.handleGetFailureMatches({});

      expect(getText(result)).toContain('Please specify a task_id');
      expect(getFailureMatches).not.toHaveBeenCalled();
    });

    it('filters and limits failure matches before rendering them', () => {
      getFailureMatches.mockReturnValue([
        { pattern_id: 'p-1', pattern_name: 'Auth', severity: 'high', matched_at: '2026-01-01' },
        { pattern_id: 'p-2', pattern_name: 'Timeout', severity: 'low', matched_at: '2026-01-02' },
        { pattern_id: 'p-1', pattern_name: 'Auth', matched_at: '2026-01-03' },
      ]);

      const result = handlers.handleGetFailureMatches({
        task_id: 'task-1',
        pattern_id: 'p-1',
        limit: 1,
      });

      expect(getFailureMatches).toHaveBeenCalledWith('task-1');
      expect(getText(result)).toContain('## Failure Matches for task-1');
      expect(getText(result)).toContain('**Pattern:** Auth | **Severity:** high');
      expect(getText(result)).not.toContain('Timeout');
      expect((getText(result).match(/\*\*Pattern:\*\*/g) || []).length).toBe(1);
    });
  });

  describe('handleListRetryRules', () => {
    it('lists retry rules in a markdown table', () => {
      listRetryRules.mockReturnValue([
        {
          name: 'Transient Network',
          rule_type: 'network',
          fallback_provider: 'claude-cli',
          max_retries: 2,
          enabled: true,
        },
        {
          name: 'Escalate Auth',
          rule_type: 'auth',
          fallback_provider: 'gpt-4.1',
          max_retries: 1,
          enabled: false,
        },
      ]);

      const result = handlers.handleListRetryRules({ enabled_only: false });

      expect(listRetryRules).toHaveBeenCalledWith(false);
      expect(getText(result)).toContain('## Adaptive Retry Rules');
      expect(getText(result)).toContain('| Name | Type | Fallback | Max Retries | Enabled |');
      expect(getText(result)).toContain('| Transient Network | network | claude-cli | 2 | ✓ |');
      expect(getText(result)).toContain('| Escalate Auth | auth | gpt-4.1 | 1 | ✗ |');
    });
  });

  describe('handleAddRetryRule', () => {
    it('returns MISSING_REQUIRED_PARAM when required fields are missing', () => {
      const result = handlers.handleAddRetryRule({
        name: 'Missing trigger rule',
        description: 'No trigger provided',
        rule_type: 'error',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('name, description, rule_type, and trigger are required');
      expect(addRetryRule).not.toHaveBeenCalled();
    });

    it('saves a retry rule and returns the markdown summary', () => {
      vi.spyOn(Date, 'now').mockReturnValue(7890);

      const result = handlers.handleAddRetryRule({
        name: 'Retry on flaky timeout',
        description: 'Use fallback provider on timeout',
        rule_type: 'timeout',
        trigger: 'ETIMEDOUT',
      });

      expect(addRetryRule).toHaveBeenCalledWith({
        id: 'retry-7890',
        name: 'Retry on flaky timeout',
        description: 'Use fallback provider on timeout',
        rule_type: 'timeout',
        trigger: 'ETIMEDOUT',
        fallback_provider: 'claude-cli',
        max_retries: 1,
      });
      expect(getText(result)).toContain('## Retry Rule Added');
      expect(getText(result)).toContain('retry-7890');
      expect(getText(result)).toContain('Fallback:** claude-cli');
      expect(getText(result)).toContain('Max Retries:** 1');
    });
  });
});
