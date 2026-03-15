const os = require('os');

const { setupTestDb, teardownTestDb } = require('./vitest-setup');

const configMod = require('../db/provider-routing-core');

let db;
let seq = 0;

function rawDb() {
  return db.getDb ? db.getDb() : db.getDbInstance();
}

function nextId(prefix) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

function createTask(overrides = {}) {
  const id = overrides.id || nextId('task');
  db.createTask({
    id,
    task_description: overrides.task_description || `Task ${id}`,
    working_directory: overrides.working_directory || os.tmpdir(),
    status: overrides.status || 'queued',
    project: overrides.project || 'config-tests',
    provider: overrides.provider || 'codex',
    ...overrides,
    id,
  });
  return id;
}

function createWorkflow(overrides = {}) {
  const id = overrides.id || nextId('workflow');
  rawDb().prepare(`
    INSERT INTO workflows (id, name, status, created_at)
    VALUES (?, ?, ?, ?)
  `).run(
    id,
    overrides.name || `Workflow ${id}`,
    overrides.status || 'pending',
    new Date().toISOString(),
  );
  return id;
}

beforeEach(() => {
  ({ db } = setupTestDb('provider-routing-config'));
  configMod.setDb(rawDb());
});

afterEach(() => {
  teardownTestDb();
  db = null;
});

describe('db/provider-routing-config', () => {
  describe('template conditions and task replay', () => {
    it('creates, lists, and deletes template conditions', () => {
      const templateId = nextId('tpl');
      const condA = nextId('cond-a');
      const condB = nextId('cond-b');

      configMod.createTemplateCondition({
        id: condA,
        template_id: templateId,
        condition_type: 'if',
        condition_expr: 'x > 1',
        then_block: 'then-a',
        else_block: 'else-a',
        order_index: 2,
      });

      configMod.createTemplateCondition({
        id: condB,
        template_id: templateId,
        condition_type: 'if',
        condition_expr: 'x < 1',
        order_index: 1,
      });

      const list = configMod.listTemplateConditions(templateId);
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(condB);
      expect(list[1].id).toBe(condA);

      expect(configMod.deleteTemplateCondition(condA)).toBe(true);
      expect(configMod.deleteTemplateCondition(condA)).toBe(false);
    });

    it('creates task replays and parses modified_inputs JSON', () => {
      const originalTaskId = createTask({ project: 'replay-project' });
      const replayTaskId = createTask({ project: 'replay-project' });
      const replayId = nextId('replay');

      configMod.createTaskReplay({
        id: replayId,
        original_task_id: originalTaskId,
        replay_task_id: replayTaskId,
        modified_inputs: { retries: 2, mode: 'strict' },
        diff_summary: 'small delta',
      });

      const replay = configMod.getTaskReplay(replayId);
      expect(replay.id).toBe(replayId);
      expect(replay.modified_inputs).toEqual({ retries: 2, mode: 'strict' });
      expect(replay.diff_summary).toBe('small delta');
    });

    it('lists task replays newest-first by created_at', () => {
      const originalTaskId = createTask({ project: 'replay-order-project' });
      const replayId1 = nextId('replay-old');
      const replayId2 = nextId('replay-new');

      configMod.createTaskReplay({
        id: replayId1,
        original_task_id: originalTaskId,
        replay_task_id: createTask(),
        modified_inputs: { value: 1 },
      });

      configMod.createTaskReplay({
        id: replayId2,
        original_task_id: originalTaskId,
        replay_task_id: createTask(),
        modified_inputs: { value: 2 },
      });

      rawDb().prepare('UPDATE task_replays SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', replayId1);
      rawDb().prepare('UPDATE task_replays SET created_at = ? WHERE id = ?').run('2030-01-01T00:00:00.000Z', replayId2);

      const rows = configMod.listTaskReplays(originalTaskId);
      expect(rows[0].id).toBe(replayId2);
      expect(rows[1].id).toBe(replayId1);
    });

    it('falls back to empty objects when replay JSON is invalid and returns undefined for missing replays', () => {
      const replayId = nextId('replay-bad-json');
      configMod.createTaskReplay({
        id: replayId,
        original_task_id: createTask(),
        replay_task_id: createTask(),
        modified_inputs: { keep: true },
      });

      rawDb().prepare('UPDATE task_replays SET modified_inputs = ? WHERE id = ?').run('{broken-json', replayId);

      expect(configMod.getTaskReplay(replayId).modified_inputs).toEqual({});
      expect(configMod.getTaskReplay(nextId('missing-replay'))).toBeUndefined();
    });
  });

  describe('rate limit management', () => {
    it('creates and retrieves a rate limit record', () => {
      const id = nextId('rl');
      configMod.setRateLimit({
        id,
        project_id: 'proj-a',
        limit_type: 'submit',
        max_value: 3,
        window_seconds: 60,
      });

      const row = configMod.getRateLimit(id);
      expect(row.id).toBe(id);
      expect(row.project_id).toBe('proj-a');
      expect(row.limit_type).toBe('submit');
      expect(row.max_value).toBe(3);
    });

    it('updates existing rate limits while preserving current window usage', () => {
      const id = nextId('rl-upsert');
      configMod.setRateLimit({
        id,
        project_id: 'proj-upsert',
        limit_type: 'submit',
        max_value: 2,
        window_seconds: 30,
      });

      rawDb().prepare('UPDATE rate_limits SET current_value = 1 WHERE id = ?').run(id);

      configMod.setRateLimit({
        id,
        project_id: 'proj-upsert',
        limit_type: 'submit',
        max_value: 9,
        window_seconds: 120,
      });

      const row = configMod.getRateLimit(id);
      expect(row.max_value).toBe(9);
      expect(row.window_seconds).toBe(120);
      expect(row.current_value).toBe(1);
    });

    it('getProjectRateLimits includes global and matching project rows but excludes unrelated projects', () => {
      configMod.setRateLimit({
        id: nextId('rl-global'),
        project_id: null,
        limit_type: 'global',
        max_value: 10,
        window_seconds: 60,
      });

      configMod.setRateLimit({
        id: nextId('rl-project'),
        project_id: 'proj-b',
        limit_type: 'project',
        max_value: 5,
        window_seconds: 60,
      });

      configMod.setRateLimit({
        id: nextId('rl-other'),
        project_id: 'proj-c',
        limit_type: 'project',
        max_value: 8,
        window_seconds: 60,
      });

      const rows = configMod.getProjectRateLimits('proj-b');
      expect(rows.some((r) => r.project_id === null)).toBe(true);
      expect(rows.some((r) => r.project_id === 'proj-b')).toBe(true);
      expect(rows.some((r) => r.project_id === 'proj-c')).toBe(false);
    });

    it('checkRateLimit allows requests when no matching limit exists', () => {
      const result = configMod.checkRateLimit('proj-none', 'type-none');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('no_limit_configured');
    });

    it('checkRateLimit increments usage and blocks after max_value', () => {
      const id = nextId('rl-block');
      configMod.setRateLimit({
        id,
        project_id: 'proj-c',
        limit_type: 'submit',
        max_value: 2,
        window_seconds: 3600,
      });

      const first = configMod.checkRateLimit('proj-c', 'submit');
      const second = configMod.checkRateLimit('proj-c', 'submit');
      const third = configMod.checkRateLimit('proj-c', 'submit');

      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);
      expect(third.allowed).toBe(false);
      expect(third.reason).toBe('rate_limit_exceeded');
    });

    it('checkRateLimit resets expired windows', () => {
      const id = nextId('rl-reset');
      configMod.setRateLimit({
        id,
        project_id: 'proj-d',
        limit_type: 'submit',
        max_value: 4,
        window_seconds: 10,
      });

      rawDb().prepare('UPDATE rate_limits SET current_value = 4, window_start = ? WHERE id = ?')
        .run(new Date(Date.now() - 60000).toISOString(), id);

      const result = configMod.checkRateLimit('proj-d', 'submit');
      const row = configMod.getRateLimit(id);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(3);
      expect(row.current_value).toBe(1);
    });

    it('project-specific limits take precedence over global limits', () => {
      configMod.setRateLimit({
        id: nextId('rl-global-pref'),
        project_id: null,
        limit_type: 'build',
        max_value: 10,
        window_seconds: 3600,
      });

      configMod.setRateLimit({
        id: nextId('rl-project-pref'),
        project_id: 'proj-e',
        limit_type: 'build',
        max_value: 1,
        window_seconds: 3600,
      });

      const first = configMod.checkRateLimit('proj-e', 'build');
      const second = configMod.checkRateLimit('proj-e', 'build');
      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(false);
      expect(second.reason).toBe('rate_limit_exceeded');
    });

    it('deletes rate limits idempotently', () => {
      const id = nextId('rl-delete');
      configMod.setRateLimit({
        id,
        project_id: null,
        limit_type: 'delete',
        max_value: 1,
        window_seconds: 1,
      });

      expect(configMod.deleteRateLimit(id)).toBe(true);
      expect(configMod.deleteRateLimit(id)).toBe(false);
    });
  });

  describe('task quotas', () => {
    it('creates and retrieves task quotas', () => {
      const id = nextId('quota');
      configMod.setTaskQuota({
        id,
        project_id: 'proj-q1',
        quota_type: 'daily',
        max_value: 3,
        reset_period: 'daily',
      });

      const quota = configMod.getTaskQuota(id);
      expect(quota.id).toBe(id);
      expect(quota.max_value).toBe(3);
      expect(quota.reset_period).toBe('daily');
    });

    it('checkTaskQuota returns no_quota_configured and supports createTask callback', () => {
      let called = 0;
      const result = configMod.checkTaskQuota('proj-none', 'quota-none', () => {
        called += 1;
        return { id: 'simulated-task' };
      });

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('no_quota_configured');
      expect(result.task).toEqual({ id: 'simulated-task' });
      expect(called).toBe(1);
    });

    it('checkTaskQuota increments usage and blocks once quota is exhausted', () => {
      const id = nextId('quota-block');
      configMod.setTaskQuota({
        id,
        project_id: 'proj-q2',
        quota_type: 'submit',
        max_value: 2,
        reset_period: null,
      });

      const one = configMod.checkTaskQuota('proj-q2', 'submit');
      const two = configMod.checkTaskQuota('proj-q2', 'submit');
      const three = configMod.checkTaskQuota('proj-q2', 'submit');

      expect(one.allowed).toBe(true);
      expect(two.allowed).toBe(true);
      expect(three.allowed).toBe(false);
      expect(three.reason).toBe('quota_exceeded');
    });

    it('resets daily and weekly quotas when their reset window elapses', () => {
      const dailyId = nextId('quota-daily');
      configMod.setTaskQuota({
        id: dailyId,
        project_id: 'proj-q3',
        quota_type: 'daily',
        max_value: 3,
        reset_period: 'daily',
      });
      rawDb().prepare('UPDATE task_quotas SET current_value = 3, last_reset = ? WHERE id = ?')
        .run(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), dailyId);

      const daily = configMod.checkTaskQuota('proj-q3', 'daily');
      expect(daily.allowed).toBe(true);
      expect(daily.remaining).toBe(2);

      const weeklyId = nextId('quota-weekly');
      configMod.setTaskQuota({
        id: weeklyId,
        project_id: 'proj-q4',
        quota_type: 'weekly',
        max_value: 4,
        reset_period: 'weekly',
      });
      rawDb().prepare('UPDATE task_quotas SET current_value = 4, last_reset = ? WHERE id = ?')
        .run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), weeklyId);

      const weekly = configMod.checkTaskQuota('proj-q4', 'weekly');
      expect(weekly.allowed).toBe(true);
      expect(weekly.remaining).toBe(3);
    });

    it('resets monthly quotas when month changes', () => {
      const id = nextId('quota-monthly');
      configMod.setTaskQuota({
        id,
        project_id: 'proj-q5',
        quota_type: 'monthly',
        max_value: 2,
        reset_period: 'monthly',
      });

      rawDb().prepare('UPDATE task_quotas SET current_value = 2, last_reset = ? WHERE id = ?')
        .run('2021-01-01T00:00:00.000Z', id);

      const result = configMod.checkTaskQuota('proj-q5', 'monthly');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });

    it('lists project quotas including global rows and deletes quotas idempotently', () => {
      const globalId = nextId('quota-global');
      const projectId = nextId('quota-project');

      configMod.setTaskQuota({
        id: globalId,
        project_id: null,
        quota_type: 'global',
        max_value: 100,
      });
      configMod.setTaskQuota({
        id: projectId,
        project_id: 'proj-q6',
        quota_type: 'project',
        max_value: 5,
      });

      const quotas = configMod.getProjectQuotas('proj-q6');
      expect(quotas.some((q) => q.project_id === null)).toBe(true);
      expect(quotas.some((q) => q.project_id === 'proj-q6')).toBe(true);

      expect(configMod.deleteTaskQuota(projectId)).toBe(true);
      expect(configMod.deleteTaskQuota(projectId)).toBe(false);
    });

    it('does not invoke the createTask callback once a quota is exhausted', () => {
      const id = nextId('quota-callback-block');
      configMod.setTaskQuota({
        id,
        project_id: 'proj-q7',
        quota_type: 'submit',
        max_value: 1,
        reset_period: null,
      });

      configMod.checkTaskQuota('proj-q7', 'submit');

      let called = 0;
      const result = configMod.checkTaskQuota('proj-q7', 'submit', () => {
        called += 1;
        return { id: 'should-not-exist' };
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('quota_exceeded');
      expect(called).toBe(0);
      expect(result.task).toBeUndefined();
    });
  });

  describe('integration and workflow config', () => {
    it('saves, lists, and retrieves enabled integration configs', () => {
      const enabledId = nextId('integration-enabled');
      const disabledId = nextId('integration-disabled');

      configMod.saveIntegrationConfig({
        id: enabledId,
        integration_type: 'slack',
        config: { webhook: 'abc' },
        enabled: true,
      });
      configMod.saveIntegrationConfig({
        id: disabledId,
        integration_type: 'slack',
        config: { webhook: 'def' },
        enabled: false,
      });

      const rows = configMod.listIntegrationConfigs('slack');
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.integration_type === 'slack')).toBe(true);
      expect(configMod.getEnabledIntegration('slack').id).toBe(enabledId);
      expect(configMod.getIntegrationConfig(enabledId).config).toEqual({ webhook: 'abc' });
    });

    it('lists integrations without a type filter and returns null when no enabled integration exists', () => {
      configMod.saveIntegrationConfig({
        id: nextId('integration-email'),
        integration_type: 'email',
        config: { smtp: 'localhost' },
        enabled: false,
      });
      configMod.saveIntegrationConfig({
        id: nextId('integration-webhook'),
        integration_type: 'webhook',
        config: { url: 'https://example.test' },
        enabled: true,
      });

      const rows = configMod.listIntegrationConfigs();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((row) => typeof row.enabled === 'boolean')).toBe(true);
      expect(configMod.getEnabledIntegration('email')).toBeUndefined();
    });

    it('falls back to an empty object when integration config JSON is invalid', () => {
      const id = nextId('integration-bad-json');
      configMod.saveIntegrationConfig({
        id,
        integration_type: 'slack',
        config: { webhook: 'ok' },
        enabled: true,
      });

      rawDb().prepare('UPDATE integration_config SET config = ? WHERE id = ?').run('{invalid-json', id);

      const row = configMod.getIntegrationConfig(id);
      expect(row.config).toEqual({});
      expect(row.enabled).toBe(true);
    });

    it('deletes integration configs and updates workflow fork statuses', () => {
      const integrationId = nextId('integration-delete');
      configMod.saveIntegrationConfig({
        id: integrationId,
        integration_type: 'email',
        config: { smtp: 'localhost' },
        enabled: true,
      });
      expect(configMod.deleteIntegrationConfig(integrationId)).toBe(true);
      expect(configMod.deleteIntegrationConfig(integrationId)).toBe(false);

      const workflowId = createWorkflow();
      const forkId = nextId('fork');
      configMod.createWorkflowFork({
        id: forkId,
        workflow_id: workflowId,
        fork_point_task_id: createTask(),
        branches: [{ name: 'A' }, { name: 'B' }],
      });

      const updated = configMod.updateWorkflowForkStatus(forkId, 'running');
      expect(updated.status).toBe('running');
      const list = configMod.listWorkflowForks(workflowId);
      expect(list).toHaveLength(1);
      expect(list[0].branches).toEqual([{ name: 'A' }, { name: 'B' }]);
    });

    it('returns null for missing workflow forks and falls back to empty branches arrays', () => {
      const workflowId = createWorkflow();
      const forkId = nextId('fork-bad-json');

      configMod.createWorkflowFork({
        id: forkId,
        workflow_id: workflowId,
        branches: [{ name: 'only-branch' }],
      });

      rawDb().prepare('UPDATE workflow_forks SET branches = ? WHERE id = ?').run('{bad-json', forkId);

      expect(configMod.getWorkflowFork(forkId).branches).toEqual([]);
      expect(configMod.listWorkflowForks(workflowId)[0].branches).toEqual([]);
      expect(configMod.updateWorkflowForkStatus(nextId('missing-fork'), 'running')).toBeNull();
    });
  });

  describe('routing rule CRUD', () => {
    it('creates rules with defaults and supports lookups by id and name', () => {
      const rule = configMod.createRoutingRule({
        name: nextId('rule'),
        pattern: 'alpha|beta',
        target_provider: 'codex',
      });

      expect(rule.rule_type).toBe('keyword');
      expect(rule.priority).toBe(50);
      expect(rule.enabled).toBe(true);
      expect(configMod.getRoutingRule(rule.id).id).toBe(rule.id);
      expect(configMod.getRoutingRule(rule.name).id).toBe(rule.id);
    });

    it('returns undefined for missing rules and rejects duplicate rule names', () => {
      const name = nextId('rule-duplicate');

      configMod.createRoutingRule({
        name,
        pattern: 'alpha',
        target_provider: 'codex',
      });

      expect(configMod.getRoutingRule(nextId('missing-rule'))).toBeUndefined();
      expect(() => configMod.createRoutingRule({
        name,
        pattern: 'beta',
        target_provider: 'claude-cli',
      })).toThrow(/unique|constraint/i);
    });

    it('filters rules by enabled and type while preserving priority order', () => {
      const base = nextId('rule-filter');
      configMod.createRoutingRule({
        name: `${base}-a`,
        rule_type: 'keyword',
        pattern: 'alpha',
        target_provider: 'codex',
        priority: 5,
        enabled: true,
      });
      configMod.createRoutingRule({
        name: `${base}-b`,
        rule_type: 'keyword',
        pattern: 'beta',
        target_provider: 'codex',
        priority: 10,
        enabled: false,
      });
      configMod.createRoutingRule({
        name: `${base}-c`,
        rule_type: 'regex',
        pattern: 'gamma',
        target_provider: 'claude-cli',
        priority: 1,
        enabled: true,
      });

      const rows = configMod.getRoutingRules({ enabled: true, rule_type: 'keyword' });
      const scopedRows = rows.filter((row) => row.name.startsWith(base));

      expect(scopedRows).toHaveLength(1);
      expect(scopedRows[0].name).toBe(`${base}-a`);
      expect(rows.every((r) => r.enabled && r.rule_type === 'keyword')).toBe(true);
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i - 1].priority).toBeLessThanOrEqual(rows[i].priority);
      }
    });

    it('can query disabled rules and returns booleans for enabled flags', () => {
      const base = nextId('rule-disabled');
      configMod.createRoutingRule({
        name: `${base}-enabled`,
        pattern: 'alpha',
        target_provider: 'codex',
        enabled: true,
      });
      configMod.createRoutingRule({
        name: `${base}-disabled`,
        pattern: 'beta',
        target_provider: 'claude-cli',
        enabled: false,
      });

      const disabledRows = configMod.getRoutingRules({ enabled: false });
      const scopedRows = disabledRows.filter((row) => row.name.startsWith(base));

      expect(scopedRows).toHaveLength(1);
      expect(scopedRows[0].name).toBe(`${base}-disabled`);
      expect(scopedRows[0].enabled).toBe(false);
    });

    it('updates routing rules by name and returns unchanged rule for empty updates', () => {
      const created = configMod.createRoutingRule({
        name: nextId('rule-update'),
        rule_type: 'keyword',
        pattern: 'before',
        target_provider: 'codex',
      });

      const updated = configMod.updateRoutingRule(created.name, {
        description: 'after',
        pattern: 'after',
        target_provider: 'claude-cli',
        enabled: false,
        priority: 1,
      });
      expect(updated.description).toBe('after');
      expect(updated.pattern).toBe('after');
      expect(updated.target_provider).toBe('claude-cli');
      expect(updated.enabled).toBe(false);
      expect(updated.priority).toBe(1);
      expect(updated.updated_at).toBeTruthy();

      const unchanged = configMod.updateRoutingRule(created.id, {});
      expect(unchanged.id).toBe(created.id);
      expect(() => configMod.updateRoutingRule('no-such-rule', { pattern: 'x' })).toThrow(/not found/i);
    });

    it('deletes routing rules and throws if deleting a missing rule', () => {
      const created = configMod.createRoutingRule({
        name: nextId('rule-delete'),
        rule_type: 'keyword',
        pattern: 'remove-me',
        target_provider: 'codex',
      });

      const deleted = configMod.deleteRoutingRule(created.name);
      expect(deleted.deleted).toBe(true);
      expect(deleted.rule.id).toBe(created.id);
      expect(configMod.getRoutingRule(created.id)).toBeUndefined();
      expect(() => configMod.deleteRoutingRule(created.id)).toThrow(/not found/i);
    });
  });
});
