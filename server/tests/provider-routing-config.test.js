'use strict';

const CONFIG_MODULE_PATH = require.resolve('../db/provider-routing-core');
const CORE_MODULE_PATH = require.resolve('../db/provider-routing-core');
const DATABASE_MODULE_PATH = require.resolve('../database');
const LOGGER_MODULE_PATH = require.resolve('../logger');

const ORIGINAL_DATABASE_MODULE = require.cache[DATABASE_MODULE_PATH];
const ORIGINAL_LOGGER_MODULE = require.cache[LOGGER_MODULE_PATH];

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function restoreModuleCache(resolvedPath, originalEntry) {
  if (originalEntry) {
    require.cache[resolvedPath] = originalEntry;
    return;
  }
  delete require.cache[resolvedPath];
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function createProviderRow(provider, overrides = {}) {
  return {
    provider,
    enabled: 1,
    priority: 50,
    cli_path: null,
    cli_args: null,
    quota_error_patterns: '[]',
    max_concurrent: 1,
    transport: provider === 'codex' ? 'hybrid' : provider === 'claude-cli' ? 'cli' : 'api',
    ...overrides,
  };
}

function createMockDb(options = {}) {
  const state = {
    config: {
      default_provider: 'codex',
      ...clone(options.config || {}),
    },
    providerConfig: {
      codex: createProviderRow('codex', { priority: 10, max_concurrent: 4 }),
      'claude-cli': createProviderRow('claude-cli', { priority: 20, max_concurrent: 3 }),
      anthropic: createProviderRow('anthropic', { priority: 30 }),
      groq: createProviderRow('groq', { priority: 40 }),
      ollama: createProviderRow('ollama', { priority: 50 }),
      'aider-ollama': createProviderRow('aider-ollama', { priority: 60 }),
      'hashline-ollama': createProviderRow('hashline-ollama', { priority: 70 }),
      ...clone(options.providerConfig || {}),
    },
    templateConditions: clone(options.templateConditions || []),
    taskReplays: clone(options.taskReplays || []),
    rateLimits: clone(options.rateLimits || []),
    taskQuotas: clone(options.taskQuotas || []),
    integrationConfigs: clone(options.integrationConfigs || []),
    workflowForks: clone(options.workflowForks || []),
    routingRules: clone(options.routingRules || []),
    nextRoutingRuleId: 1,
  };

  const numericRuleIds = state.routingRules
    .map((rule) => Number(rule.id))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (numericRuleIds.length > 0) {
    state.nextRoutingRuleId = Math.max(...numericRuleIds) + 1;
  }

  function findApplicableProjectRow(rows, projectId, typeKey, typeValue) {
    const matching = rows.filter((row) => (
      row[typeKey] === typeValue && (row.project_id === projectId || row.project_id == null)
    ));

    const exact = matching.find((row) => row.project_id === projectId);
    if (exact) return exact;
    return matching.find((row) => row.project_id == null);
  }

  function deleteById(collection, id) {
    const index = collection.findIndex((row) => row.id === id);
    if (index === -1) return { changes: 0 };
    collection.splice(index, 1);
    return { changes: 1 };
  }

  const db = {
    state,
    transaction(fn) {
      return (...args) => fn(...args);
    },
    prepare(sql) {
      const normalized = normalizeSql(sql);

      if (normalized === 'SELECT value FROM config WHERE key = ?') {
        return {
          get(key) {
            if (!Object.prototype.hasOwnProperty.call(state.config, key)) {
              return undefined;
            }
            return { value: String(state.config[key]) };
          },
        };
      }

      if (normalized === 'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)') {
        return {
          run(key, value) {
            state.config[key] = String(value);
            return { changes: 1 };
          },
        };
      }

      if (normalized === 'SELECT * FROM provider_config WHERE provider = ?') {
        return {
          get(providerId) {
            const row = state.providerConfig[providerId];
            return row ? clone(row) : undefined;
          },
        };
      }

      if (normalized === 'SELECT * FROM provider_config ORDER BY priority ASC') {
        return {
          all() {
            return Object.values(state.providerConfig)
              .sort((a, b) => a.priority - b.priority)
              .map((row) => clone(row));
          },
        };
      }

      if (normalized.startsWith('UPDATE provider_config SET ') && normalized.endsWith(' WHERE provider = ?')) {
        const setClause = normalized
          .replace('UPDATE provider_config SET ', '')
          .replace(' WHERE provider = ?', '');
        const columns = setClause.split(', ').map((part) => part.replace(' = ?', ''));
        return {
          run(...values) {
            const providerId = values[values.length - 1];
            const row = state.providerConfig[providerId];
            if (!row) return { changes: 0 };
            columns.forEach((column, index) => {
              row[column] = values[index];
            });
            return { changes: 1 };
          },
        };
      }

      if (normalized.startsWith('INSERT INTO template_conditions')) {
        return {
          run(id, templateId, conditionType, conditionExpr, thenBlock, elseBlock, orderIndex, createdAt) {
            state.templateConditions.push({
              id,
              template_id: templateId,
              condition_type: conditionType,
              condition_expr: conditionExpr,
              then_block: thenBlock,
              else_block: elseBlock,
              order_index: orderIndex,
              created_at: createdAt,
            });
            return { changes: 1 };
          },
        };
      }

      if (normalized === 'SELECT * FROM template_conditions WHERE id = ?') {
        return {
          get(id) {
            return clone(state.templateConditions.find((row) => row.id === id));
          },
        };
      }

      if (normalized === 'SELECT * FROM template_conditions WHERE template_id = ? ORDER BY order_index ASC') {
        return {
          all(templateId) {
            return state.templateConditions
              .filter((row) => row.template_id === templateId)
              .sort((a, b) => a.order_index - b.order_index)
              .map((row) => clone(row));
          },
        };
      }

      if (normalized === 'DELETE FROM template_conditions WHERE id = ?') {
        return {
          run(id) {
            return deleteById(state.templateConditions, id);
          },
        };
      }

      if (normalized.startsWith('INSERT INTO task_replays')) {
        return {
          run(id, originalTaskId, replayTaskId, modifiedInputs, diffSummary, createdAt) {
            state.taskReplays.push({
              id,
              original_task_id: originalTaskId,
              replay_task_id: replayTaskId,
              modified_inputs: modifiedInputs,
              diff_summary: diffSummary,
              created_at: createdAt,
            });
            return { changes: 1 };
          },
        };
      }

      if (normalized === 'SELECT * FROM task_replays WHERE id = ?') {
        return {
          get(id) {
            return clone(state.taskReplays.find((row) => row.id === id));
          },
        };
      }

      if (normalized === 'SELECT * FROM task_replays WHERE original_task_id = ? ORDER BY created_at DESC') {
        return {
          all(originalTaskId) {
            return state.taskReplays
              .filter((row) => row.original_task_id === originalTaskId)
              .sort((a, b) => b.created_at.localeCompare(a.created_at))
              .map((row) => clone(row));
          },
        };
      }

      if (normalized.startsWith('INSERT INTO rate_limits')) {
        return {
          run(id, projectId, limitType, maxValue, windowSeconds, currentValue, windowStart, createdAt) {
            const existing = state.rateLimits.find((row) => row.id === id);
            if (existing) {
              existing.max_value = maxValue;
              existing.window_seconds = windowSeconds;
              return { changes: 1 };
            }
            state.rateLimits.push({
              id,
              project_id: projectId,
              limit_type: limitType,
              max_value: maxValue,
              window_seconds: windowSeconds,
              current_value: currentValue,
              window_start: windowStart,
              created_at: createdAt,
            });
            return { changes: 1 };
          },
        };
      }

      if (normalized === 'SELECT * FROM rate_limits WHERE id = ?') {
        return {
          get(id) {
            return clone(state.rateLimits.find((row) => row.id === id));
          },
        };
      }

      if (normalized === 'SELECT * FROM rate_limits WHERE project_id = ? OR project_id IS NULL') {
        return {
          all(projectId) {
            return state.rateLimits
              .filter((row) => row.project_id === projectId || row.project_id == null)
              .map((row) => clone(row));
          },
        };
      }

      if (normalized.includes('FROM rate_limits WHERE (project_id = ? OR project_id IS NULL) AND limit_type = ?')) {
        return {
          get(projectId, limitType) {
            return clone(findApplicableProjectRow(state.rateLimits, projectId, 'limit_type', limitType));
          },
        };
      }

      if (normalized === 'UPDATE rate_limits SET current_value = 1, window_start = ? WHERE id = ?') {
        return {
          run(windowStart, id) {
            const row = state.rateLimits.find((item) => item.id === id);
            if (!row) return { changes: 0 };
            row.current_value = 1;
            row.window_start = windowStart;
            return { changes: 1 };
          },
        };
      }

      if (normalized === 'UPDATE rate_limits SET current_value = current_value + 1 WHERE id = ?') {
        return {
          run(id) {
            const row = state.rateLimits.find((item) => item.id === id);
            if (!row) return { changes: 0 };
            row.current_value += 1;
            return { changes: 1 };
          },
        };
      }

      if (normalized === 'DELETE FROM rate_limits WHERE id = ?') {
        return {
          run(id) {
            return deleteById(state.rateLimits, id);
          },
        };
      }

      if (normalized.startsWith('INSERT INTO task_quotas')) {
        return {
          run(id, projectId, quotaType, maxValue, currentValue, resetPeriod, lastReset, createdAt) {
            const existing = state.taskQuotas.find((row) => row.id === id);
            if (existing) {
              existing.max_value = maxValue;
              existing.reset_period = resetPeriod;
              return { changes: 1 };
            }
            state.taskQuotas.push({
              id,
              project_id: projectId,
              quota_type: quotaType,
              max_value: maxValue,
              current_value: currentValue,
              reset_period: resetPeriod,
              last_reset: lastReset,
              created_at: createdAt,
            });
            return { changes: 1 };
          },
        };
      }

      if (normalized === 'SELECT * FROM task_quotas WHERE id = ?') {
        return {
          get(id) {
            return clone(state.taskQuotas.find((row) => row.id === id));
          },
        };
      }

      if (normalized.includes('FROM task_quotas WHERE (project_id = ? OR project_id IS NULL) AND quota_type = ?')) {
        return {
          get(projectId, quotaType) {
            return clone(findApplicableProjectRow(state.taskQuotas, projectId, 'quota_type', quotaType));
          },
        };
      }

      if (normalized === 'UPDATE task_quotas SET current_value = 1, last_reset = ? WHERE id = ?') {
        return {
          run(lastReset, id) {
            const row = state.taskQuotas.find((item) => item.id === id);
            if (!row) return { changes: 0 };
            row.current_value = 1;
            row.last_reset = lastReset;
            return { changes: 1 };
          },
        };
      }

      if (normalized === 'UPDATE task_quotas SET current_value = current_value + 1 WHERE id = ?') {
        return {
          run(id) {
            const row = state.taskQuotas.find((item) => item.id === id);
            if (!row) return { changes: 0 };
            row.current_value += 1;
            return { changes: 1 };
          },
        };
      }

      if (normalized === 'SELECT * FROM task_quotas WHERE project_id = ? OR project_id IS NULL') {
        return {
          all(projectId) {
            return state.taskQuotas
              .filter((row) => row.project_id === projectId || row.project_id == null)
              .map((row) => clone(row));
          },
        };
      }

      if (normalized === 'DELETE FROM task_quotas WHERE id = ?') {
        return {
          run(id) {
            return deleteById(state.taskQuotas, id);
          },
        };
      }

      if (normalized.startsWith('INSERT INTO integration_config')) {
        return {
          run(id, integrationType, configValue, enabled, createdAt) {
            const existing = state.integrationConfigs.find((row) => row.id === id);
            if (existing) {
              existing.config = configValue;
              existing.enabled = enabled;
              return { changes: 1 };
            }
            state.integrationConfigs.push({
              id,
              integration_type: integrationType,
              config: configValue,
              enabled,
              created_at: createdAt,
            });
            return { changes: 1 };
          },
        };
      }

      if (normalized === 'SELECT * FROM integration_config WHERE id = ?') {
        return {
          get(id) {
            return clone(state.integrationConfigs.find((row) => row.id === id));
          },
        };
      }

      if (normalized === 'SELECT * FROM integration_config WHERE integration_type = ?') {
        return {
          all(type) {
            return state.integrationConfigs
              .filter((row) => row.integration_type === type)
              .map((row) => clone(row));
          },
        };
      }

      if (normalized === 'SELECT * FROM integration_config') {
        return {
          all() {
            return state.integrationConfigs.map((row) => clone(row));
          },
        };
      }

      if (normalized === 'SELECT * FROM integration_config WHERE integration_type = ? AND enabled = 1 LIMIT 1') {
        return {
          get(type) {
            return clone(state.integrationConfigs.find((row) => row.integration_type === type && row.enabled === 1));
          },
        };
      }

      if (normalized === 'DELETE FROM integration_config WHERE id = ?') {
        return {
          run(id) {
            return deleteById(state.integrationConfigs, id);
          },
        };
      }

      if (normalized.startsWith('INSERT INTO workflow_forks')) {
        return {
          run(id, workflowId, forkPointTaskId, branchCount, branches, mergeStrategy, status, createdAt) {
            state.workflowForks.push({
              id,
              workflow_id: workflowId,
              fork_point_task_id: forkPointTaskId,
              branch_count: branchCount,
              branches,
              merge_strategy: mergeStrategy,
              status,
              created_at: createdAt,
            });
            return { changes: 1 };
          },
        };
      }

      if (normalized === 'SELECT * FROM workflow_forks WHERE id = ?') {
        return {
          get(id) {
            return clone(state.workflowForks.find((row) => row.id === id));
          },
        };
      }

      if (normalized === 'SELECT * FROM workflow_forks WHERE workflow_id = ? ORDER BY created_at ASC') {
        return {
          all(workflowId) {
            return state.workflowForks
              .filter((row) => row.workflow_id === workflowId)
              .sort((a, b) => a.created_at.localeCompare(b.created_at))
              .map((row) => clone(row));
          },
        };
      }

      if (normalized === 'UPDATE workflow_forks SET status = ? WHERE id = ?') {
        return {
          run(status, id) {
            const row = state.workflowForks.find((item) => item.id === id);
            if (!row) return { changes: 0 };
            row.status = status;
            return { changes: 1 };
          },
        };
      }

      if (normalized.startsWith('SELECT * FROM routing_rules WHERE 1=1')) {
        return {
          all(...params) {
            let rules = state.routingRules.map((row) => ({ ...row }));
            let paramIndex = 0;

            if (normalized.includes(' AND enabled = ?')) {
              const enabledValue = params[paramIndex];
              paramIndex += 1;
              rules = rules.filter((row) => row.enabled === enabledValue);
            }

            if (normalized.includes(' AND rule_type = ?')) {
              const ruleType = params[paramIndex];
              rules = rules.filter((row) => row.rule_type === ruleType);
            }

            return rules
              .sort((a, b) => a.priority - b.priority)
              .map((row) => clone(row));
          },
        };
      }

      if (normalized === 'SELECT * FROM routing_rules WHERE id = ? OR name = ?') {
        return {
          get(idOrName) {
            const rule = state.routingRules.find((row) => row.id === idOrName || row.name === idOrName);
            return clone(rule);
          },
        };
      }

      if (normalized.startsWith('INSERT INTO routing_rules')) {
        return {
          run(name, description, ruleType, pattern, targetProvider, priority, enabled, createdAt) {
            const id = state.nextRoutingRuleId;
            state.nextRoutingRuleId += 1;
            state.routingRules.push({
              id,
              name,
              description,
              rule_type: ruleType,
              pattern,
              target_provider: targetProvider,
              priority,
              enabled,
              created_at: createdAt,
              updated_at: null,
            });
            return { changes: 1, lastInsertRowid: id };
          },
        };
      }

      if (normalized.startsWith('UPDATE routing_rules SET ') && normalized.endsWith(' WHERE id = ?')) {
        const setClause = normalized
          .replace('UPDATE routing_rules SET ', '')
          .replace(' WHERE id = ?', '');
        const columns = setClause.split(', ').map((part) => part.replace(' = ?', ''));
        return {
          run(...values) {
            const id = values[values.length - 1];
            const row = state.routingRules.find((item) => item.id === id);
            if (!row) return { changes: 0 };
            columns.forEach((column, index) => {
              row[column] = values[index];
            });
            return { changes: 1 };
          },
        };
      }

      if (normalized === 'DELETE FROM routing_rules WHERE id = ?') {
        return {
          run(id) {
            return deleteById(state.routingRules, id);
          },
        };
      }

      throw new Error(`Unexpected SQL in provider-routing-config test mock: ${normalized}`);
    },
    getConfig(key) {
      if (!Object.prototype.hasOwnProperty.call(state.config, key)) {
        return null;
      }
      return String(state.config[key]);
    },
  };

  return { db, state };
}

function loadConfigWithDb(db) {
  delete require.cache[CONFIG_MODULE_PATH];

  // The module uses setDb() now, but we keep the repo's require.cache mock pattern
  // so the CJS load remains deterministic and consistent with nearby tests.
  installCjsModuleMock('../database', {
    getDbInstance: () => db,
    getDb: () => db,
  });

  const mod = require('../db/provider-routing-core');
  mod.setDb(db);
  return mod;
}

function loadCoreWithDb(db) {
  delete require.cache[CORE_MODULE_PATH];

  installCjsModuleMock('../database', {
    getDbInstance: () => db,
    getDb: () => db,
  });

  const loggerMock = {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  };
  installCjsModuleMock('../logger', loggerMock);

  const core = require('../db/provider-routing-core');
  core.setDb(db);
  core.setGetTask(() => null);
  core.setHostManagement(null);
  core.setOllamaHealthy(true);

  return { core, loggerMock };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[CONFIG_MODULE_PATH];
  delete require.cache[CORE_MODULE_PATH];
  restoreModuleCache(DATABASE_MODULE_PATH, ORIGINAL_DATABASE_MODULE);
  restoreModuleCache(LOGGER_MODULE_PATH, ORIGINAL_LOGGER_MODULE);
});

describe('provider-routing-config', () => {
  describe('template conditions', () => {
    it('creates, sorts, and deletes template conditions', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.createTemplateCondition({
        id: 'cond-1',
        template_id: 'tpl-1',
        condition_type: 'if',
        condition_expr: 'foo',
        order_index: 20,
      });

      mod.createTemplateCondition({
        id: 'cond-2',
        template_id: 'tpl-1',
        condition_type: 'if',
        condition_expr: 'bar',
        then_block: 'then-2',
        else_block: 'else-2',
        order_index: 5,
      });

      const rows = mod.listTemplateConditions('tpl-1');
      expect(rows.map((row) => row.id)).toEqual(['cond-2', 'cond-1']);
      expect(rows[0].then_block).toBe('then-2');
      expect(rows[1].then_block).toBeNull();
      expect(rows[1].else_block).toBeNull();

      expect(mod.deleteTemplateCondition('cond-1')).toBe(true);
      expect(mod.deleteTemplateCondition('cond-1')).toBe(false);
    });

    it('returns undefined when a template condition is missing', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      expect(mod.getTemplateCondition('missing-condition')).toBeUndefined();
    });
  });

  describe('task replays', () => {
    it('creates and reads task replays with parsed modified_inputs', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.createTaskReplay({
        id: 'replay-1',
        original_task_id: 'task-1',
        replay_task_id: 'task-2',
        modified_inputs: { retries: 2, strict: true },
        diff_summary: 'small delta',
      });

      expect(mod.getTaskReplay('replay-1')).toEqual(expect.objectContaining({
        id: 'replay-1',
        original_task_id: 'task-1',
        replay_task_id: 'task-2',
        modified_inputs: { retries: 2, strict: true },
        diff_summary: 'small delta',
      }));
    });

    it('lists replays newest-first and falls back to empty objects for invalid replay JSON', () => {
      const { db, state } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.createTaskReplay({
        id: 'replay-old',
        original_task_id: 'task-1',
        replay_task_id: 'task-2',
        modified_inputs: { version: 1 },
      });

      mod.createTaskReplay({
        id: 'replay-new',
        original_task_id: 'task-1',
        replay_task_id: 'task-3',
        modified_inputs: { version: 2 },
      });

      state.taskReplays.find((row) => row.id === 'replay-old').created_at = '2024-01-01T00:00:00.000Z';
      const newest = state.taskReplays.find((row) => row.id === 'replay-new');
      newest.created_at = '2025-01-01T00:00:00.000Z';
      newest.modified_inputs = '{broken-json';

      const rows = mod.listTaskReplays('task-1');
      expect(rows.map((row) => row.id)).toEqual(['replay-new', 'replay-old']);
      expect(rows[0].modified_inputs).toEqual({});
      expect(mod.getTaskReplay('missing-replay')).toBeUndefined();
    });
  });

  describe('rate limits', () => {
    it('saves rate limits and preserves usage fields on upsert', () => {
      const { db, state } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.setRateLimit({
        id: 'rl-1',
        project_id: 'proj-a',
        limit_type: 'submit',
        max_value: 2,
        window_seconds: 60,
      });

      state.rateLimits[0].current_value = 1;
      const originalWindowStart = state.rateLimits[0].window_start;

      mod.setRateLimit({
        id: 'rl-1',
        project_id: 'proj-a',
        limit_type: 'submit',
        max_value: 5,
        window_seconds: 300,
      });

      const row = mod.getRateLimit('rl-1');
      expect(row.max_value).toBe(5);
      expect(row.window_seconds).toBe(300);
      expect(row.current_value).toBe(1);
      expect(row.window_start).toBe(originalWindowStart);
    });

    it('returns project and global rate limits for a project', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.setRateLimit({
        id: 'rl-global',
        project_id: null,
        limit_type: 'submit',
        max_value: 10,
        window_seconds: 60,
      });

      mod.setRateLimit({
        id: 'rl-project',
        project_id: 'proj-a',
        limit_type: 'submit',
        max_value: 3,
        window_seconds: 60,
      });

      mod.setRateLimit({
        id: 'rl-other',
        project_id: 'proj-b',
        limit_type: 'submit',
        max_value: 4,
        window_seconds: 60,
      });

      expect(mod.getProjectRateLimits('proj-a').map((row) => row.id)).toEqual(['rl-global', 'rl-project']);
    });

    it('allows requests when no matching rate limit exists', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      expect(mod.checkRateLimit('proj-a', 'submit')).toEqual({
        allowed: true,
        reason: 'no_limit_configured',
      });
    });

    it('increments counters until the rate limit is exceeded', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.setRateLimit({
        id: 'rl-1',
        project_id: 'proj-a',
        limit_type: 'submit',
        max_value: 2,
        window_seconds: 600,
      });

      expect(mod.checkRateLimit('proj-a', 'submit')).toEqual({ allowed: true, remaining: 1 });
      expect(mod.checkRateLimit('proj-a', 'submit')).toEqual({ allowed: true, remaining: 0 });
      expect(mod.checkRateLimit('proj-a', 'submit')).toEqual(expect.objectContaining({
        allowed: false,
        reason: 'rate_limit_exceeded',
        limit: 2,
      }));
    });

    it('resets expired rate-limit windows', () => {
      const { db, state } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.setRateLimit({
        id: 'rl-1',
        project_id: 'proj-a',
        limit_type: 'submit',
        max_value: 4,
        window_seconds: 10,
      });

      state.rateLimits[0].current_value = 4;
      state.rateLimits[0].window_start = '2020-01-01T00:00:00.000Z';

      const result = mod.checkRateLimit('proj-a', 'submit');
      expect(result).toEqual({ allowed: true, remaining: 3 });
      expect(mod.getRateLimit('rl-1').current_value).toBe(1);
    });

    it('prefers project-specific rate limits over global ones', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.setRateLimit({
        id: 'rl-global',
        project_id: null,
        limit_type: 'build',
        max_value: 10,
        window_seconds: 600,
      });

      mod.setRateLimit({
        id: 'rl-project',
        project_id: 'proj-a',
        limit_type: 'build',
        max_value: 1,
        window_seconds: 600,
      });

      expect(mod.checkRateLimit('proj-a', 'build')).toEqual({ allowed: true, remaining: 0 });
      expect(mod.checkRateLimit('proj-a', 'build')).toEqual(expect.objectContaining({
        allowed: false,
        reason: 'rate_limit_exceeded',
        limit: 1,
      }));
    });

    it('deletes rate limits idempotently', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.setRateLimit({
        id: 'rl-delete',
        project_id: null,
        limit_type: 'cleanup',
        max_value: 1,
        window_seconds: 60,
      });

      expect(mod.deleteRateLimit('rl-delete')).toBe(true);
      expect(mod.deleteRateLimit('rl-delete')).toBe(false);
    });
  });

  describe('task quotas', () => {
    it('saves task quotas and preserves usage fields on upsert', () => {
      const { db, state } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.setTaskQuota({
        id: 'quota-1',
        project_id: 'proj-a',
        quota_type: 'daily',
        max_value: 2,
        reset_period: 'daily',
      });

      state.taskQuotas[0].current_value = 1;
      const originalLastReset = state.taskQuotas[0].last_reset;

      mod.setTaskQuota({
        id: 'quota-1',
        project_id: 'proj-a',
        quota_type: 'daily',
        max_value: 5,
        reset_period: 'weekly',
      });

      const row = mod.getTaskQuota('quota-1');
      expect(row.max_value).toBe(5);
      expect(row.reset_period).toBe('weekly');
      expect(row.current_value).toBe(1);
      expect(row.last_reset).toBe(originalLastReset);
    });

    it('returns created tasks when no quota is configured', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);
      const createTask = vi.fn(() => ({ id: 'task-new' }));

      expect(mod.checkTaskQuota('proj-a', 'daily', createTask)).toEqual({
        allowed: true,
        reason: 'no_quota_configured',
        task: { id: 'task-new' },
      });
      expect(createTask).toHaveBeenCalledTimes(1);
    });

    it('increments quota usage and blocks after the quota is exceeded', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.setTaskQuota({
        id: 'quota-1',
        project_id: 'proj-a',
        quota_type: 'daily',
        max_value: 2,
        reset_period: 'daily',
      });

      expect(mod.checkTaskQuota('proj-a', 'daily')).toEqual({ allowed: true, remaining: 1 });
      expect(mod.checkTaskQuota('proj-a', 'daily')).toEqual({ allowed: true, remaining: 0 });
      expect(mod.checkTaskQuota('proj-a', 'daily')).toEqual({
        allowed: false,
        reason: 'quota_exceeded',
        quota: 2,
        reset_period: 'daily',
      });
    });

    it('resets daily quotas when the reset window has passed', () => {
      const { db, state } = createMockDb();
      const mod = loadConfigWithDb(db);
      const createTask = vi.fn(() => ({ id: 'task-reset' }));

      mod.setTaskQuota({
        id: 'quota-1',
        project_id: 'proj-a',
        quota_type: 'daily',
        max_value: 3,
        reset_period: 'daily',
      });

      state.taskQuotas[0].current_value = 3;
      state.taskQuotas[0].last_reset = '2024-01-01T00:00:00.000Z';

      const result = mod.checkTaskQuota('proj-a', 'daily', createTask);
      expect(result).toEqual({
        allowed: true,
        remaining: 2,
        task: { id: 'task-reset' },
      });
      expect(mod.getTaskQuota('quota-1').current_value).toBe(1);
    });

    it('returns project and global quotas and deletes them idempotently', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.setTaskQuota({
        id: 'quota-global',
        project_id: null,
        quota_type: 'daily',
        max_value: 4,
        reset_period: 'daily',
      });

      mod.setTaskQuota({
        id: 'quota-project',
        project_id: 'proj-a',
        quota_type: 'daily',
        max_value: 2,
        reset_period: 'daily',
      });

      mod.setTaskQuota({
        id: 'quota-other',
        project_id: 'proj-b',
        quota_type: 'daily',
        max_value: 5,
        reset_period: 'daily',
      });

      expect(mod.getProjectQuotas('proj-a').map((row) => row.id)).toEqual(['quota-global', 'quota-project']);
      expect(mod.deleteTaskQuota('quota-project')).toBe(true);
      expect(mod.deleteTaskQuota('quota-project')).toBe(false);
    });
  });

  describe('integration config', () => {
    it('saves and loads integration config with parsed JSON and boolean enabled flags', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.saveIntegrationConfig({
        id: 'integration-1',
        integration_type: 'github',
        config: { token: 'abc', repo: 'torque' },
      });

      expect(mod.getIntegrationConfig('integration-1')).toEqual(expect.objectContaining({
        id: 'integration-1',
        integration_type: 'github',
        config: { token: 'abc', repo: 'torque' },
        enabled: true,
      }));
    });

    it('filters integration configs by type and returns only enabled integrations', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.saveIntegrationConfig({
        id: 'integration-1',
        integration_type: 'github',
        config: { repo: 'one' },
        enabled: false,
      });

      mod.saveIntegrationConfig({
        id: 'integration-2',
        integration_type: 'github',
        config: { repo: 'two' },
        enabled: true,
      });

      mod.saveIntegrationConfig({
        id: 'integration-3',
        integration_type: 'jira',
        config: { board: 'TOR' },
      });

      expect(mod.listIntegrationConfigs('github').map((row) => row.id)).toEqual(['integration-1', 'integration-2']);
      expect(mod.listIntegrationConfigs().map((row) => row.id)).toEqual([
        'integration-1',
        'integration-2',
        'integration-3',
      ]);
      expect(mod.getEnabledIntegration('github').id).toBe('integration-2');
    });

    it('deletes integration config idempotently', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.saveIntegrationConfig({
        id: 'integration-1',
        integration_type: 'github',
        config: { repo: 'torque' },
      });

      expect(mod.deleteIntegrationConfig('integration-1')).toBe(true);
      expect(mod.deleteIntegrationConfig('integration-1')).toBe(false);
    });
  });

  describe('workflow forks', () => {
    it('creates workflow forks with defaults and parses stored branches', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      const fork = mod.createWorkflowFork({
        id: 'fork-1',
        workflow_id: 'workflow-1',
        branches: [{ task: 'a' }, { task: 'b' }],
      });

      expect(fork).toEqual(expect.objectContaining({
        id: 'fork-1',
        workflow_id: 'workflow-1',
        branch_count: 2,
        merge_strategy: 'all',
        status: 'pending',
        branches: [{ task: 'a' }, { task: 'b' }],
      }));
    });

    it('lists workflow forks oldest-first and updates status', () => {
      const { db, state } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.createWorkflowFork({
        id: 'fork-old',
        workflow_id: 'workflow-1',
        branches: [{ task: 'old' }],
      });

      mod.createWorkflowFork({
        id: 'fork-new',
        workflow_id: 'workflow-1',
        branches: [{ task: 'new' }],
      });

      state.workflowForks.find((row) => row.id === 'fork-old').created_at = '2024-01-01T00:00:00.000Z';
      state.workflowForks.find((row) => row.id === 'fork-new').created_at = '2025-01-01T00:00:00.000Z';

      expect(mod.listWorkflowForks('workflow-1').map((row) => row.id)).toEqual(['fork-old', 'fork-new']);
      expect(mod.updateWorkflowForkStatus('fork-new', 'merged')).toEqual(expect.objectContaining({
        id: 'fork-new',
        status: 'merged',
      }));
    });

    it('returns null when updating a missing workflow fork', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      expect(mod.updateWorkflowForkStatus('missing-fork', 'merged')).toBeNull();
    });
  });

  describe('routing rules', () => {
    it('creates routing rules with defaults and fetches them by id or name', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      const rule = mod.createRoutingRule({
        name: 'docs-first',
        pattern: 'readme|docs',
        target_provider: 'groq',
      });

      expect(rule).toEqual(expect.objectContaining({
        id: 1,
        name: 'docs-first',
        rule_type: 'keyword',
        priority: 50,
        enabled: true,
      }));
      expect(mod.getRoutingRule(1).name).toBe('docs-first');
      expect(mod.getRoutingRule('docs-first').id).toBe(1);
    });

    it('updates routing rules by id and by name', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.createRoutingRule({
        name: 'docs-first',
        pattern: 'docs',
        target_provider: 'groq',
      });

      const updated = mod.updateRoutingRule('docs-first', {
        description: 'Prefer Groq for docs',
        target_provider: 'anthropic',
        priority: 5,
        enabled: false,
      });

      expect(updated).toEqual(expect.objectContaining({
        id: 1,
        description: 'Prefer Groq for docs',
        target_provider: 'anthropic',
        priority: 5,
        enabled: false,
      }));

      expect(mod.updateRoutingRule(1, { pattern: 'docs|readme' }).pattern).toBe('docs|readme');
    });

    it('returns the current rule when updateRoutingRule receives no changes', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.createRoutingRule({
        name: 'docs-first',
        pattern: 'docs',
        target_provider: 'groq',
      });

      expect(mod.updateRoutingRule('docs-first', {})).toEqual(expect.objectContaining({
        id: 1,
        name: 'docs-first',
        priority: 50,
      }));
    });

    it('lists routing rules filtered by enabled and rule_type in priority order', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.createRoutingRule({
        name: 'regex-rule',
        rule_type: 'regex',
        pattern: 'foo\\d+',
        target_provider: 'anthropic',
        priority: 30,
      });

      mod.createRoutingRule({
        name: 'disabled-keyword',
        pattern: 'docs',
        target_provider: 'groq',
        priority: 1,
        enabled: false,
      });

      mod.createRoutingRule({
        name: 'keyword-rule',
        pattern: 'readme',
        target_provider: 'groq',
        priority: 10,
      });

      expect(mod.getRoutingRules().map((row) => row.name)).toEqual([
        'disabled-keyword',
        'keyword-rule',
        'regex-rule',
      ]);
      expect(mod.getRoutingRules({ enabled: true }).map((row) => row.name)).toEqual([
        'keyword-rule',
        'regex-rule',
      ]);
      expect(mod.getRoutingRules({ rule_type: 'regex' }).map((row) => row.name)).toEqual(['regex-rule']);
    });

    it('deletes routing rules and throws on missing rules', () => {
      const { db } = createMockDb();
      const mod = loadConfigWithDb(db);

      mod.createRoutingRule({
        name: 'docs-first',
        pattern: 'docs',
        target_provider: 'groq',
      });

      expect(mod.deleteRoutingRule('docs-first')).toEqual(expect.objectContaining({
        deleted: true,
        rule: expect.objectContaining({ id: 1, name: 'docs-first' }),
      }));

      expect(() => mod.updateRoutingRule('missing-rule', { enabled: false })).toThrow(/Routing rule not found/i);
      expect(() => mod.deleteRoutingRule('missing-rule')).toThrow(/Routing rule not found/i);
    });
  });
});

describe('provider-routing-core behaviors tied to config state', () => {
  it('loads provider configuration with normalized booleans, transports, and quota patterns', () => {
    const { db } = createMockDb({
      providerConfig: {
        ollama: createProviderRow('ollama', {
          enabled: 1,
          transport: null,
          quota_error_patterns: '["429","rate limit"]',
        }),
      },
    });

    const { core } = loadCoreWithDb(db);
    const provider = core.getProvider('ollama');

    expect(provider).toEqual(expect.objectContaining({
      provider: 'ollama',
      enabled: true,
      transport: 'api',
      quota_error_patterns: ['429', 'rate limit'],
    }));
    expect(core.listProviders()[0].provider).toBe('codex');
  });

  it('updates provider configuration, including enablement and transport', () => {
    const { db } = createMockDb();
    const { core } = loadCoreWithDb(db);

    const updated = core.updateProvider('codex', {
      enabled: 0,
      priority: 99,
      cli_path: '/tmp/codex',
      cli_args: '--json',
      max_concurrent: 6,
      quota_error_patterns: ['429'],
      transport: 'api',
    });

    expect(updated).toEqual(expect.objectContaining({
      provider: 'codex',
      enabled: false,
      priority: 99,
      cli_path: '/tmp/codex',
      cli_args: '--json',
      max_concurrent: 6,
      quota_error_patterns: ['429'],
      transport: 'api',
    }));
  });

  it('persists the default provider and rejects disabled providers', () => {
    const { db } = createMockDb({
      providerConfig: {
        anthropic: createProviderRow('anthropic', { enabled: 0, priority: 30 }),
      },
    });
    const { core } = loadCoreWithDb(db);

    expect(core.getDefaultProvider()).toBe('codex');
    expect(core.setDefaultProvider('claude-cli')).toBe('claude-cli');
    expect(core.getDefaultProvider()).toBe('claude-cli');
    expect(() => core.setDefaultProvider('anthropic')).toThrow(/disabled/i);
  });

  it('passes through host-selected model overrides from complexity routing', () => {
    const { db } = createMockDb({
      config: { smart_routing_enabled: '1' },
    });
    const { core } = loadCoreWithDb(db);
    const determineTaskComplexity = vi.fn(() => 'normal');
    const routeTask = vi.fn(() => ({
      provider: 'aider-ollama',
      hostId: 'desktop-17',
      model: 'qwen3:32b',
    }));

    core.setHostManagement({ determineTaskComplexity, routeTask });

    const result = core.analyzeTaskForRouting('Stabilize queue fairness for the scheduler', 'C:/repo');

    expect(determineTaskComplexity).toHaveBeenCalledWith('Stabilize queue fairness for the scheduler', []);
    expect(routeTask).toHaveBeenCalledWith('normal');
    expect(result).toEqual(expect.objectContaining({
      provider: 'aider-ollama',
      hostId: 'desktop-17',
      selectedHost: 'desktop-17',
      model: 'qwen3:32b',
    }));
  });

  it('evaluates routing rules in ascending priority order', () => {
    const { db } = createMockDb({
      config: { smart_routing_enabled: '1' },
      routingRules: [
        {
          id: 1,
          name: 'second-match',
          description: null,
          rule_type: 'keyword',
          pattern: 'queue',
          target_provider: 'anthropic',
          priority: 20,
          enabled: 1,
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: null,
        },
        {
          id: 2,
          name: 'first-match',
          description: null,
          rule_type: 'keyword',
          pattern: 'backlog',
          target_provider: 'groq',
          priority: 5,
          enabled: 1,
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: null,
        },
      ],
    });

    const { core } = loadCoreWithDb(db);
    const result = core.analyzeTaskForRouting('Queue backlog needs cleanup', 'C:/repo');

    expect(result.provider).toBe('groq');
    expect(result.reason).toContain('first-match');
  });
});
