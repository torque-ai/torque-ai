const fs = require('fs');
const os = require('os');
const path = require('path');

const { v4: uuidv4 } = require('uuid');

const db = require('../database');
const { getPeekFirstSliceCanonicalEntry } = require('../contracts/peek');
const peekHandlers = require('../handlers/peek-handlers');
const tools = require('../tools');

const INLINE_TOOL_HANDLERS = new Set(['ping', 'restart_server', 'unlock_all_tools', 'unlock_tier']);

function loadToolDefinitionNames() {
  const toolDefDir = path.join(__dirname, '../tool-defs');
  const toolDefFiles = fs.readdirSync(toolDefDir).filter((file) => file.endsWith('.js')).sort();

  const names = [];

  for (const file of toolDefFiles) {
    const defs = require(path.join(toolDefDir, file));
    expect(Array.isArray(defs)).toBe(true);

    for (const def of defs) {
      if (def && typeof def.name === 'string') {
        names.push(def.name);
      }
    }
  }

  return names;
}

function pascalToSnake(value) {
  return value.replace(/([A-Z])/g, (match, char, index) => (index > 0 ? '_' : '') + char.toLowerCase());
}

const HANDLE_TO_TOOL_FIXUPS = {
  export_report_c_s_v: 'export_report_csv',
  export_report_j_s_o_n: 'export_report_json',
};

function handleNameToToolName(handleName) {
  const base = handleName.startsWith('handle') ? handleName.slice(6) : handleName;
  const snake = pascalToSnake(base);
  return HANDLE_TO_TOOL_FIXUPS[snake] || snake;
}

function extractHandlerModules() {
  const toolsSource = fs.readFileSync(path.join(__dirname, '../tools.js'), 'utf8');
  const matches = [...toolsSource.matchAll(/require\(\s*['"]\.\/handlers\/([^'"]+)['"]\s*\)/g)];
  return [...new Set(matches.map((match) => path.join(__dirname, '../handlers', match[1])))].sort();
}

function collectRouteNamesFromModules() {
  const modulePaths = extractHandlerModules();

  const routeNames = new Set();
  const nonFunctionHandleExports = [];

  for (const handlerPath of modulePaths) {
    const exported = require(handlerPath);
    const handleExports = Object.entries(exported).filter(
      ([name]) => typeof name === 'string' && name.startsWith('handle'),
    );

    for (const [name, value] of handleExports) {
      if (typeof value !== 'function') {
        nonFunctionHandleExports.push(name);
        continue;
      }
      if (tools.INTERNAL_HANDLER_EXPORTS && tools.INTERNAL_HANDLER_EXPORTS.has(name)) continue;

      routeNames.add(handleNameToToolName(name));
    }
  }

  return { routeNames, nonFunctionHandleExports };
}

function getResultText(result) {
  if (!result || !result.content || !Array.isArray(result.content) || result.content.length === 0) return '';
  const first = result.content[0];
  if (!first || typeof first.text !== 'string') return '';
  return first.text;
}

async function expectToolError(toolName, args, expectedMessage) {
  let failureMessage = '';
  let gotResult = null;

  try {
    gotResult = await tools.handleToolCall(toolName, args);
  } catch (error) {
    failureMessage =
      error && typeof error.message === 'string'
        ? error.message
        : typeof error === 'string'
          ? error
          : JSON.stringify(error);
  }

  if (gotResult && gotResult.isError) {
    failureMessage = getResultText(gotResult);
  }

  expect(failureMessage).not.toBe('');

  if (expectedMessage instanceof RegExp) {
    expect(failureMessage).toMatch(expectedMessage);
    return;
  }

  if (Array.isArray(expectedMessage)) {
    expect(expectedMessage.some((candidate) => failureMessage.includes(candidate))).toBe(true);
    return;
  }

  expect(failureMessage).toContain(expectedMessage);
}

beforeAll(() => {
  db.init();
});

afterAll(() => {
  db.close();
});

function isTransientDbError(error) {
  if (!error) return false;

  const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';

  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    message.includes('database is locked') ||
    message.includes('database is busy') ||
    message.includes('sqlite_busy') ||
    message.includes('sqlite_locked') ||
    message.includes('timeout')
  );
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithDbRetry(operation, { retries = 3, baseDelayMs = 25 } = {}) {
  let lastError;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return operation();
    } catch (error) {
      lastError = error;

      if (!isTransientDbError(error) || attempt === retries - 1) {
        throw error;
      }

      await sleepMs(baseDelayMs * (attempt + 1));
    }
  }

  throw lastError;
}

function listTasksWithRetry(query) {
  return runWithDbRetry(() => db.listTasks(query), { retries: 4, baseDelayMs: 40 });
}

describe('test-hardening parity', () => {
  describe('JSON parsing', () => {
    it('safeJsonParse handles null', () => {
      const result = db.safeJsonParse(null, 'default');
      expect(result).toBe('default');
    });

    it('safeJsonParse handles invalid JSON', () => {
      const result = db.safeJsonParse('not valid json', []);
      expect(Array.isArray(result)).toBe(true);
    });

    it('safeJsonParse parses valid JSON', () => {
      const result = db.safeJsonParse('{"key":"value"}', null);
      expect(result.key).toBe('value');
    });
  });

  describe('Schema migration', () => {
    it('safeAddColumn tolerates duplicate columns', () => {
      const result = db.safeAddColumn('tasks', 'status TEXT');
      expect([false, true]).toContain(result);
    });
  });

  describe('Input validation', () => {
    it('queue_task rejects empty task', async () => {
      await expectToolError('queue_task', { task: '' }, 'non-empty string');
    });

    it('queue_task rejects invalid timeout', async () => {
      await expectToolError('queue_task', { task: 'test', timeout_minutes: -5 }, 'positive number');
    });

    it('schedule_task rejects invalid schedule_type', async () => {
      await expectToolError('schedule_task', { task: 'test', schedule_type: 'invalid' }, /(once|interval)/i);
    });

    it('batch_cancel rejects invalid tags type', async () => {
      await expectToolError('batch_cancel', { tags: 'not-an-array' }, 'array');
    });

    it('share_context rejects empty content', async () => {
      await expectToolError('share_context', { task_id: 'test', content: '' }, 'non-empty string');
    });

    it('sync_files rejects invalid direction', async () => {
      await expectToolError('sync_files', { task_id: 'test', files: ['a.txt'], direction: 'invalid' }, ['push', 'pull']);
    });
  });

  describe('Tag filtering', () => {
    it('listTasks handles oversized tags gracefully', () => {
      const longTag = 'a'.repeat(200);
      const tasks = db.listTasks({ tags: [longTag] });
      expect(Array.isArray(tasks)).toBe(true);
    });

    it('listTasks handles too many tags', async () => {
      const manyTags = Array.from({ length: 50 }, () => 'tag');
      const tasks = await listTasksWithRetry({ tags: manyTags });
      expect(Array.isArray(tasks)).toBe(true);
    });

    it('listTasks handles valid tags', () => {
      const tasks = db.listTasks({ tags: ['test-tag'] });
      expect(Array.isArray(tasks)).toBe(true);
    });
  });

  describe('Security', () => {
    it('share_context sanitizes context_type', async () => {
      const taskId = uuidv4();
      db.createTask({
        id: taskId,
        status: 'pending',
        task_description: 'test task',
        working_directory: process.cwd(),
      });

      try {
        const result = await tools.handleToolCall('share_context', {
          task_id: taskId,
          content: 'test content',
          context_type: '../../../etc/passwd',
        });

        expect(result).toBeTruthy();
        expect(result.isError || false).toBe(false);
      } finally {
        db.updateTaskStatus(taskId, 'cancelled');
      }
    });

    it('sync_files blocks path traversal', async () => {
      const taskId = uuidv4();
      const workspaceDir = path.join(os.tmpdir(), `test-task-${taskId.slice(0, 8)}`);
      fs.mkdirSync(workspaceDir, { recursive: true });

      db.createTask({
        id: taskId,
        status: 'pending',
        task_description: 'test task',
        working_directory: workspaceDir,
      });

      try {
        const result = await tools.handleToolCall('sync_files', {
          task_id: taskId,
          files: ['../../../etc/passwd'],
          direction: 'pull',
        });

        expect(result).toBeTruthy();
        expect(result.isError || false).toBe(false);
        const text = getResultText(result);
        expect(text).toMatch(/traversal blocked|Not found/i);
      } finally {
        db.updateTaskStatus(taskId, 'cancelled');
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          // cleanup best effort
        }
      }
    });

    it('validateColumnName blocks SQL injection', () => {
      expect(() => db.validateColumnName('status; DROP TABLE tasks;--')).toThrowError(/Invalid column name/);
    });

    it('validateColumnName allows valid columns', () => {
      const result = db.validateColumnName('status');
      expect(result).toBe('status');
    });
  });

  describe('Wave 4 input validation', () => {
    it('save_template rejects empty name', async () => {
      await expectToolError('save_template', { name: '', task_template: 'test' }, 'non-empty string');
    });

    it('save_template rejects empty task_template', async () => {
      await expectToolError('save_template', { name: 'test', task_template: '' }, 'non-empty string');
    });

    it('add_webhook rejects invalid URL', async () => {
      await expectToolError('add_webhook', { name: 'test', url: 'not-a-url' }, /(valid HTTP|valid URL)/);
    });

    it('add_budget_alert rejects invalid alert_type', async () => {
      const result = await tools.handleToolCall('add_budget_alert', {
        alert_type: 'invalid',
        threshold_value: 100,
      });
      expect(result).toBeTruthy();
      expect(result.isError).toBe(true);
      expect(getResultText(result)).toContain('must be one of');
    });

    it('add_budget_alert rejects negative threshold', async () => {
      await expectToolError('add_budget_alert', { alert_type: 'daily_tasks', threshold_value: -5 }, 'positive number');
    });

    it('set_breakpoint rejects invalid regex', async () => {
      await expectToolError('set_breakpoint', { pattern: '[invalid(' }, 'valid regular expression');
    });

    it('set_breakpoint rejects invalid pattern_type', async () => {
      await expectToolError('set_breakpoint', { pattern: 'test', pattern_type: 'invalid' }, 'pattern_type');
    });

    it('create_workflow rejects empty name', async () => {
      await expectToolError('create_workflow', { name: '' }, 'non-empty string');
    });

    it('create_pipeline rejects empty steps', async () => {
      await expectToolError('create_pipeline', { name: 'test', steps: [] }, 'non-empty array');
    });

    it('add_approval_rule rejects invalid rule_type', async () => {
      await expectToolError('add_approval_rule', { name: 'test', rule_type: 'invalid' }, 'rule_type must be');
    });
  });

  describe('Wave 5 safe parsing and limits', () => {
    it('safeLimit handles very large values', async () => {
      const tasks = await listTasksWithRetry({ limit: 9_999_999 });
      expect(Array.isArray(tasks)).toBe(true);
    });

    it('cleanupHealthHistory accepts valid day value', async () => {
      const result = await runWithDbRetry(() => db.cleanupHealthHistory(7));
      expect(typeof result).toBe('number');
    });

    it('import_data rejects oversized batch', async () => {
      const largeTasks = Array.from({ length: 1001 }, (_, index) => ({
        task: `task-${index}`,
        working_directory: process.cwd(),
      }));
      const result = await tools.handleToolCall('import_data', { json_data: JSON.stringify({ tasks: largeTasks }) });

      expect(result).toBeTruthy();
      expect(result.isError).toBe(true);
      expect(getResultText(result)).toContain('Too many tasks');
    });

    it('sync_files rejects oversized files array', async () => {
      const taskId = uuidv4();
      const workspaceDir = path.join(os.tmpdir(), `test-task-${taskId.slice(0, 8)}`);
      fs.mkdirSync(workspaceDir, { recursive: true });

      db.createTask({
        id: taskId,
        status: 'pending',
        task_description: 'test task',
        working_directory: workspaceDir,
      });

      try {
        const largeFiles = Array.from({ length: 101 }, () => 'test.txt');
        await expectToolError(
          'sync_files',
          {
            task_id: taskId,
            files: largeFiles,
            direction: 'pull',
          },
          'cannot exceed',
        );
      } finally {
        db.updateTaskStatus(taskId, 'cancelled');
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          // cleanup best effort
        }
      }
    });
  });
});

describe('handler/tool wiring parity', () => {
  it('all handler modules referenced by tools.js export handle* functions', () => {
    const modulePaths = extractHandlerModules();
    for (const handlerPath of modulePaths) {
      const exported = require(handlerPath);
      const handleExports = Object.entries(exported).filter(
        ([name]) => typeof name === 'string' && name.startsWith('handle'),
      );

      expect(handleExports.length).toBeGreaterThanOrEqual(0);
      expect(handleExports.every(([, value]) => typeof value === 'function')).toBe(true);
    }
  });

  it('maps all tool definitions to handlers', () => {
    const toolDefinitionNames = loadToolDefinitionNames();
    const missing = toolDefinitionNames.filter((name) => !tools.routeMap.has(name) && !INLINE_TOOL_HANDLERS.has(name));
    expect(missing).toEqual([]);
  });

  it('has no orphaned tool definitions', () => {
    const toolDefinitionNames = loadToolDefinitionNames();
    const defSet = new Set(toolDefinitionNames);
    const orphaned = [...tools.routeMap.keys()].filter((name) => !defSet.has(name) && !INLINE_TOOL_HANDLERS.has(name));
    expect(orphaned).toEqual([]);
  });

  it('has no orphaned handlers', () => {
    const { routeNames } = collectRouteNamesFromModules();
    const defSet = new Set(loadToolDefinitionNames());

    const orphaned = [...routeNames].filter((name) => !defSet.has(name));
    expect(orphaned).toEqual([]);
  });

  it('routes the canonical first-slice diagnose entry through exactly one tool path', () => {
    const canonicalEntry = getPeekFirstSliceCanonicalEntry();
    const handler = peekHandlers[canonicalEntry.handler_name];
    const matchingToolNames = [...tools.routeMap.entries()]
      .filter(([, value]) => value === handler)
      .map(([name]) => name)
      .sort();

    expect(matchingToolNames).toEqual([canonicalEntry.tool_name]);
    expect(tools.routeMap.get(canonicalEntry.tool_name)).toBe(handler);
  });

  it('collects valid handler exports from routed modules', () => {
    const { nonFunctionHandleExports } = collectRouteNamesFromModules();
    expect(nonFunctionHandleExports).toEqual([]);
  });

  it('injects provider task context from env into routed tool calls', async () => {
    const originalTaskId = process.env.TORQUE_TASK_ID;
    const originalWorkflowId = process.env.TORQUE_WORKFLOW_ID;
    const originalNodeId = process.env.TORQUE_WORKFLOW_NODE_ID;
    const handler = vi.fn(async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(args) }],
    }));

    tools.routeMap.set('peek_context_probe', handler);
    process.env.TORQUE_TASK_ID = 'task-env-1';
    process.env.TORQUE_WORKFLOW_ID = 'wf-env-1';
    process.env.TORQUE_WORKFLOW_NODE_ID = 'diagnose-ui';

    try {
      const result = await tools.handleToolCall('peek_context_probe', { host: 'omen' });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        host: 'omen',
        __taskId: 'task-env-1',
        __workflowId: 'wf-env-1',
        __workflowNodeId: 'diagnose-ui',
      }));
      expect(getResultText(result)).toContain('task-env-1');
    } finally {
      tools.routeMap.delete('peek_context_probe');
      if (originalTaskId === undefined) delete process.env.TORQUE_TASK_ID;
      else process.env.TORQUE_TASK_ID = originalTaskId;
      if (originalWorkflowId === undefined) delete process.env.TORQUE_WORKFLOW_ID;
      else process.env.TORQUE_WORKFLOW_ID = originalWorkflowId;
      if (originalNodeId === undefined) delete process.env.TORQUE_WORKFLOW_NODE_ID;
      else process.env.TORQUE_WORKFLOW_NODE_ID = originalNodeId;
    }
  });
});
