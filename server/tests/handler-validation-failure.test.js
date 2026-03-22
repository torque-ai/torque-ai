const validationRules = require('../db/validation-rules');
const handlers = require('../handlers/validation/failure');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('handler:validation-failure-handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('failure pattern handlers', () => {
    it('requires name, description, and signature when adding a failure pattern', () => {
      const result = handlers.handleAddFailurePattern({ name: 'Timeout' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('persists failure pattern with defaults and returns formatted summary', () => {
      vi.spyOn(Date, 'now').mockReturnValue(123456);
      const saveSpy = vi.spyOn(validationRules,'saveFailurePattern').mockReturnValue(undefined);

      const result = handlers.handleAddFailurePattern({
        name: 'Dependency install failed',
        description: 'npm install exited non-zero',
        signature: 'ERESOLVE'
      });

      expect(saveSpy).toHaveBeenCalledWith({
        id: 'fp-123456',
        name: 'Dependency install failed',
        description: 'npm install exited non-zero',
        signature: 'ERESOLVE',
        provider: null,
        severity: 'medium'
      });
      expect(getText(result)).toContain('## Failure Pattern Added');
      expect(getText(result)).toContain('fp-123456');
      expect(getText(result)).toContain('Provider:** all');
    });

    it('uses explicit provider and severity when adding failure patterns', () => {
      vi.spyOn(Date, 'now').mockReturnValue(456789);
      const saveSpy = vi.spyOn(validationRules,'saveFailurePattern').mockReturnValue(undefined);

      const result = handlers.handleAddFailurePattern({
        name: 'Secrets leaked',
        description: 'Credential printed to logs',
        signature: 'AKIA',
        provider: 'openai',
        severity: 'high'
      });

      expect(saveSpy).toHaveBeenCalledWith({
        id: 'fp-456789',
        name: 'Secrets leaked',
        description: 'Credential printed to logs',
        signature: 'AKIA',
        provider: 'openai',
        severity: 'high'
      });
      expect(getText(result)).toContain('Provider:** openai');
      expect(getText(result)).toContain('Severity:** high');
    });

    it('asks for task_id when listing failure matches', () => {
      const result = handlers.handleGetFailureMatches({});
      expect(getText(result)).toContain('Please specify a task_id');
    });

    it('filters matches by pattern_id and applies result limits', () => {
      vi.spyOn(validationRules,'getFailureMatches').mockReturnValue([
        { pattern_id: 'p-1', pattern_name: 'Auth', severity: 'high', matched_at: '2026-01-01' },
        { pattern_id: 'p-2', pattern_name: 'Timeout', severity: 'low', matched_at: '2026-01-02' },
        { pattern_id: 'p-1', pattern_name: 'Auth', severity: 'high', matched_at: '2026-01-03' }
      ]);

      const result = handlers.handleGetFailureMatches({
        task_id: 'task-1',
        pattern_id: 'p-1',
        limit: 1
      });

      const text = getText(result);
      expect(text).toContain('## Failure Matches for task-1');
      expect(text).toContain('**Pattern:** Auth');
      expect(text).not.toContain('Timeout');
      expect((text.match(/\*\*Pattern:\*\*/g) || []).length).toBe(1);
    });

    it('returns no-match message when no failure signatures are found', () => {
      vi.spyOn(validationRules,'getFailureMatches').mockReturnValue([]);
      const result = handlers.handleGetFailureMatches({ task_id: 'task-2' });
      expect(getText(result)).toContain('No failure pattern matches found for task task-2');
    });
  });

  describe('retry recommendation handlers', () => {
    it('uses enabled_only=true by default when listing retry rules', () => {
      const listSpy = vi.spyOn(validationRules,'getRetryRules').mockReturnValue([]);
      handlers.handleListRetryRules({});
      expect(listSpy).toHaveBeenCalledWith(true);
    });

    it('returns empty-state message when no retry rules exist', () => {
      vi.spyOn(validationRules,'getRetryRules').mockReturnValue([]);
      const result = handlers.handleListRetryRules({});
      expect(getText(result)).toContain('No retry rules found');
    });

    it('renders retry rule table including enabled marker', () => {
      vi.spyOn(validationRules,'getRetryRules').mockReturnValue([
        {
          name: 'Transient Network',
          rule_type: 'network',
          fallback_provider: 'claude-cli',
          max_retries: 2,
          enabled: true
        }
      ]);

      const result = handlers.handleListRetryRules({ enabled_only: false });
      const text = getText(result);
      expect(text).toContain('## Adaptive Retry Rules');
      expect(text).toContain('| Transient Network | network | claude-cli | 2 |');
      expect(text).toContain('| Name | Type | Fallback | Max Retries | Enabled |');
    });

    it('requires all key fields when adding retry rules', () => {
      const result = handlers.handleAddRetryRule({
        name: 'Missing trigger rule',
        description: 'No trigger provided',
        rule_type: 'error'
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('persists retry rules with defaults and returns recommendation summary', () => {
      vi.spyOn(Date, 'now').mockReturnValue(7890);
      const saveSpy = vi.spyOn(validationRules,'saveRetryRule').mockReturnValue(undefined);

      const result = handlers.handleAddRetryRule({
        name: 'Retry on flaky timeout',
        description: 'Use fallback provider on timeout',
        rule_type: 'timeout',
        trigger: 'ETIMEDOUT'
      });

      expect(saveSpy).toHaveBeenCalledWith({
        id: 'retry-7890',
        name: 'Retry on flaky timeout',
        description: 'Use fallback provider on timeout',
        rule_type: 'timeout',
        trigger: 'ETIMEDOUT',
        fallback_provider: 'claude-cli',
        max_retries: 1
      });
      expect(getText(result)).toContain('## Retry Rule Added');
      expect(getText(result)).toContain('retry-7890');
      expect(getText(result)).toContain('Max Retries:** 1');
    });

    it('persists retry rules with custom fallback provider and retry count', () => {
      vi.spyOn(Date, 'now').mockReturnValue(9876);
      const saveSpy = vi.spyOn(validationRules,'saveRetryRule').mockReturnValue(undefined);

      handlers.handleAddRetryRule({
        name: 'Escalate auth failures',
        description: 'Use stronger model for auth retries',
        rule_type: 'auth',
        trigger: '401',
        fallback_provider: 'gpt-4.1',
        max_retries: 3
      });

      expect(saveSpy).toHaveBeenCalledWith({
        id: 'retry-9876',
        name: 'Escalate auth failures',
        description: 'Use stronger model for auth retries',
        rule_type: 'auth',
        trigger: '401',
        fallback_provider: 'gpt-4.1',
        max_retries: 3
      });
    });
  });
});
