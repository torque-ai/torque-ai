const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const MODULE_PATH = path.resolve(__dirname, '../tools.js');
const MODULE_SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');
const REQUIRE_FROM_TOOLS = createRequire(MODULE_PATH);
const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } = require('../core-tools');
const remoteAgentToolDefs = require('../plugins/remote-agents/tool-defs');
const realTools = require('../tools');

const INLINE_TOOL_NAMES = ['ping', 'restart_server', 'unlock_all_tools', 'unlock_tier'];
const EXPECTED_UNMAPPED_TOOL_NAMES = [
  'set_provider_api_key', 'clear_provider_api_key',
  'run_remote_command', 'run_tests',
  'strategic_config_get', 'strategic_config_set', 'strategic_config_templates', 'strategic_config_apply_template',
  'get_tool_schema',
];
// Route names derived from handler exports that don't match any tool-def name
const ALIASED_ROUTE_NAMES = [
  'set_api_key', 'clear_api_key',
  'config_get', 'config_set', 'config_reset', 'config_templates', 'config_apply_template',
  'subscribe_task_events', 'get_verification_ledger',
];
const TOOL_DEF_REQUESTS = [...new Set(
  [...MODULE_SOURCE.matchAll(/require\(\s*['"](\.\/tool-defs\/[^'"]+)['"]\s*\)/g)].map((match) => match[1]),
)];
const HANDLER_REQUESTS = [...new Set(
  [...MODULE_SOURCE.matchAll(/require\(\s*['"](\.\/handlers\/[^'"]+)['"]\s*\)/g)].map((match) => match[1]),
)];

function localPascalToSnake(value) {
  return value.replace(/([A-Z])/g, (match, char, index) => (index > 0 ? '_' : '') + char.toLowerCase());
}

function applyLiveFixup(toolName) {
  const fixups = {
    export_report_c_s_v: 'export_report_csv',
    export_report_j_s_o_n: 'export_report_json',
  };
  return fixups[toolName] || toolName;
}

function createLoggerMock() {
  const child = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const root = {
    child: vi.fn(() => child),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return { child, root };
}

function createToolsSubject(options = {}) {
  const logger = options.logger || createLoggerMock();
  const collisionLogger = {
    warn: vi.fn(),
    ...(options.collisionLogger || {}),
  };
  const hooks = {
    fireHook: vi.fn(async () => {}),
    ...(options.hooks || {}),
  };
  const taskManager = {
    getRunningTaskCount: vi.fn(() => 0),
    ...(options.taskManager || {}),
  };
  const database = {
    listTasks: vi.fn(() => []),
    ...(options.database || {}),
  };

  const injectedModules = {
    './logger': logger.root,
    './hooks/post-tool-hooks': hooks,
    './utils/logger': collisionLogger,
    './task-manager': taskManager,
    './database': database,
  };

  for (const request of TOOL_DEF_REQUESTS) {
    injectedModules[request] = [];
  }
  for (const request of HANDLER_REQUESTS) {
    if (request === './handlers/shared' && !(options.modules && Object.prototype.hasOwnProperty.call(options.modules, request))) {
      injectedModules[request] = REQUIRE_FROM_TOOLS(request);
      continue;
    }
    injectedModules[request] = {};
  }

  Object.assign(injectedModules, options.modules || {});

  const exportedModule = { exports: {} };
  const appendedSource = `
module.exports.__testHelpers = {
  pascalToSnake,
  FIXUPS,
  FILE_WRITE_TOOL_NAMES,
  isToolError,
  resolveWrittenFilePaths,
  readTaskExecutionContextFromEnv,
  applyTaskExecutionContext,
  resolveHookWorkingDirectory,
  maybeFireFileWriteHooks,
  handleRestartServer,
};
`;
  const compiled = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    `${MODULE_SOURCE}\n${appendedSource}`,
  );

  const customRequire = (request) => {
    if (Object.prototype.hasOwnProperty.call(injectedModules, request)) {
      return injectedModules[request];
    }
    return REQUIRE_FROM_TOOLS(request);
  };

  compiled(customRequire, exportedModule, exportedModule.exports, MODULE_PATH, path.dirname(MODULE_PATH));

  return {
    mod: exportedModule.exports,
    helpers: exportedModule.exports.__testHelpers,
    logger,
    collisionLogger,
    hooks,
    taskManager,
    database,
  };
}

function collectLiveExpectedRoutes() {
  const expected = [];

  for (const request of HANDLER_REQUESTS) {
    const exported = require(path.resolve(path.dirname(MODULE_PATH), request));
    for (const [fnName, fn] of Object.entries(exported)) {
      if (!fnName.startsWith('handle') || typeof fn !== 'function') continue;
      if (realTools.INTERNAL_HANDLER_EXPORTS && realTools.INTERNAL_HANDLER_EXPORTS.has(fnName)) continue;
      expected.push(applyLiveFixup(localPascalToSnake(fnName.slice(6))));
    }
  }

  return [...new Set(expected)].sort();
}

function getToolNames() {
  return realTools.TOOLS.map((tool) => tool.name);
}

function getTierLabel(tier, toolCount) {
  const count = toolCount !== undefined ? toolCount : getToolNames().length;
  const labels = {
    1: `core (~${CORE_TOOL_NAMES.length} tools)`,
    2: `extended (~${EXTENDED_TOOL_NAMES.length} tools)`,
    3: `all (~${count} tools)`,
  };
  return labels[tier];
}

function restoreTorqueEnv(originalEnv) {
  for (const key of ['TORQUE_TASK_ID', 'TORQUE_WORKFLOW_ID', 'TORQUE_WORKFLOW_NODE_ID']) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
}

describe('tools.js aggregator source-loader', () => {
  const originalEnv = {
    TORQUE_TASK_ID: process.env.TORQUE_TASK_ID,
    TORQUE_WORKFLOW_ID: process.env.TORQUE_WORKFLOW_ID,
    TORQUE_WORKFLOW_NODE_ID: process.env.TORQUE_WORKFLOW_NODE_ID,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.TORQUE_TASK_ID;
    delete process.env.TORQUE_WORKFLOW_ID;
    delete process.env.TORQUE_WORKFLOW_NODE_ID;
  });

  afterEach(() => {
    restoreTorqueEnv(originalEnv);
    vi.restoreAllMocks();
  });

  describe('routeMap construction', () => {
    it('routes handle* function exports to snake_case tool names', () => {
      const handleSubmitTask = vi.fn();
      const handleRunWorkflow = vi.fn();
      const subject = createToolsSubject({
        modules: {
          './handlers/task': { handleSubmitTask },
          './handlers/workflow': { handleRunWorkflow },
        },
      });

      expect(subject.mod.routeMap.get('submit_task')).toBe(handleSubmitTask);
      expect(subject.mod.routeMap.get('run_workflow')).toBe(handleRunWorkflow);
    });

    it('ignores non-handle exports and non-function handle exports', () => {
      const handleSubmitTask = vi.fn();
      const subject = createToolsSubject({
        modules: {
          './handlers/task': {
            handleSubmitTask,
            handleNotAFunction: 'nope',
            helperValue: vi.fn(),
            submitTask: vi.fn(),
          },
        },
      });

      expect(subject.mod.routeMap.has('submit_task')).toBe(true);
      expect(subject.mod.routeMap.get('submit_task')).toBe(handleSubmitTask);
      expect(subject.mod.routeMap.has('not_a_function')).toBe(false);
      expect(subject.mod.routeMap.has('helper_value')).toBe(false);
    });

    it('applies the CSV fixup for handleExportReportCSV', () => {
      const handleExportReportCSV = vi.fn();
      const subject = createToolsSubject({
        modules: {
          './handlers/integration': { handleExportReportCSV },
        },
      });

      expect(subject.mod.routeMap.has('export_report_csv')).toBe(true);
      expect(subject.mod.routeMap.has('export_report_c_s_v')).toBe(false);
      expect(subject.mod.routeMap.get('export_report_csv')).toBe(handleExportReportCSV);
    });

    it('applies the JSON fixup for handleExportReportJSON', () => {
      const handleExportReportJSON = vi.fn();
      const subject = createToolsSubject({
        modules: {
          './handlers/integration': { handleExportReportJSON },
        },
      });

      expect(subject.mod.routeMap.has('export_report_json')).toBe(true);
      expect(subject.mod.routeMap.has('export_report_j_s_o_n')).toBe(false);
      expect(subject.mod.routeMap.get('export_report_json')).toBe(handleExportReportJSON);
    });

    it('warns and overwrites when two handlers map to the same tool name', () => {
      const first = vi.fn();
      const second = vi.fn();
      const subject = createToolsSubject({
        modules: {
          './handlers/task': { handleSubmitTask: first },
          './handlers/workflow': { handleSubmitTask: second },
        },
      });

      expect(subject.mod.routeMap.get('submit_task')).toBe(second);
      expect(subject.logger.child.warn).toHaveBeenCalledWith(
        expect.stringContaining('routeMap collision: "submit_task"'),
      );
    });

    it('counts only unique routed tool names after fixups', () => {
      const handleSubmitTask = vi.fn();
      const handleTaskInfo = vi.fn();
      const handleRunWorkflow = vi.fn();
      const handleExportReportCSV = vi.fn();
      const subject = createToolsSubject({
        modules: {
          './handlers/task': {
            handleSubmitTask,
            handleTaskInfo,
          },
          './handlers/workflow': {
            handleRunWorkflow,
          },
          './handlers/integration': {
            handleExportReportCSV,
          },
        },
      });

      // Verify all 4 handler-derived routes exist with correct handlers
      expect(subject.mod.routeMap.get('submit_task')).toBe(handleSubmitTask);
      expect(subject.mod.routeMap.get('task_info')).toBe(handleTaskInfo);
      expect(subject.mod.routeMap.get('run_workflow')).toBe(handleRunWorkflow);
      expect(subject.mod.routeMap.get('export_report_csv')).toBe(handleExportReportCSV);
    });
  });

  describe('private helpers', () => {
    it('pascalToSnake converts mixed-case tool names', () => {
      const { helpers } = createToolsSubject();

      expect(helpers.pascalToSnake('TaskInfo')).toBe('task_info');
      expect(helpers.pascalToSnake('PeekUi')).toBe('peek_ui');
    });

    it('pascalToSnake splits consecutive capitals one letter at a time', () => {
      const { helpers } = createToolsSubject();

      expect(helpers.pascalToSnake('ExportReportCSV')).toBe('export_report_c_s_v');
      expect(helpers.pascalToSnake('JSON')).toBe('j_s_o_n');
    });

    it('isToolError returns true only for objects with isError=true', () => {
      const { helpers } = createToolsSubject();

      expect(helpers.isToolError({ isError: true })).toBe(true);
      expect(helpers.isToolError({ isError: false })).toBe(false);
      expect(helpers.isToolError(null)).toBe(false);
      expect(helpers.isToolError('oops')).toBe(false);
    });

    it('resolveWrittenFilePaths trims and dedupes explicit file_path and file_paths values', () => {
      const { helpers } = createToolsSubject();
      const fileOne = path.resolve('tmp-tools-aggregator-a.ts');
      const fileTwo = path.resolve('tmp-tools-aggregator-b.ts');

      expect(helpers.resolveWrittenFilePaths('hashline_edit', {
        file_path: `  ${fileOne}  `,
        file_paths: [fileTwo, ` ${fileOne} `, '', null],
      })).toEqual([fileOne, fileTwo]);
    });

    it('readTaskExecutionContextFromEnv returns null when TORQUE_TASK_ID is missing', () => {
      const { helpers } = createToolsSubject();

      delete process.env.TORQUE_TASK_ID;
      process.env.TORQUE_WORKFLOW_ID = 'wf-ignore';

      expect(helpers.readTaskExecutionContextFromEnv()).toBeNull();
    });

    it('readTaskExecutionContextFromEnv returns trimmed task and workflow identifiers', () => {
      const { helpers } = createToolsSubject();

      process.env.TORQUE_TASK_ID = '  task-123  ';
      process.env.TORQUE_WORKFLOW_ID = '  wf-9  ';
      process.env.TORQUE_WORKFLOW_NODE_ID = '  node-a  ';

      expect(helpers.readTaskExecutionContextFromEnv()).toEqual({
        __taskId: 'task-123',
        __workflowId: 'wf-9',
        __workflowNodeId: 'node-a',
      });
    });

    it('applyTaskExecutionContext merges env context into object args', () => {
      const { helpers } = createToolsSubject();

      process.env.TORQUE_TASK_ID = 'task-7';
      process.env.TORQUE_WORKFLOW_ID = 'wf-7';
      process.env.TORQUE_WORKFLOW_NODE_ID = 'node-7';

      expect(helpers.applyTaskExecutionContext({ prompt: 'ship it' })).toEqual({
        prompt: 'ship it',
        __taskId: 'task-7',
        __workflowId: 'wf-7',
        __workflowNodeId: 'node-7',
      });
    });

    it('applyTaskExecutionContext preserves explicit ids instead of overwriting them', () => {
      const { helpers } = createToolsSubject();

      process.env.TORQUE_TASK_ID = 'task-env';
      process.env.TORQUE_WORKFLOW_ID = 'wf-env';
      process.env.TORQUE_WORKFLOW_NODE_ID = 'node-env';

      expect(helpers.applyTaskExecutionContext({
        prompt: 'manual',
        __taskId: 'task-manual',
        __workflowId: 'wf-manual',
        __workflowNodeId: 'node-manual',
      })).toEqual({
        prompt: 'manual',
        __taskId: 'task-manual',
        __workflowId: 'wf-manual',
        __workflowNodeId: 'node-manual',
      });
    });

    it('applyTaskExecutionContext normalizes non-object args when env context exists', () => {
      const { helpers } = createToolsSubject();

      process.env.TORQUE_TASK_ID = 'task-array';

      expect(helpers.applyTaskExecutionContext(['not', 'an', 'object'])).toEqual({
        __taskId: 'task-array',
      });
    });

    it('resolveHookWorkingDirectory prefers working_directory over any file path', () => {
      const { helpers } = createToolsSubject();
      const workspaceDir = path.resolve('tmp-hook-workspace');

      expect(helpers.resolveHookWorkingDirectory({
        working_directory: ` ${workspaceDir} `,
      }, path.join(workspaceDir, 'src', 'file.ts'))).toBe(workspaceDir);
    });

    it('resolveHookWorkingDirectory falls back to the absolute file path dirname', () => {
      const { helpers } = createToolsSubject();
      const filePath = path.resolve('tmp-hook-workspace', 'src', 'feature.ts');

      expect(helpers.resolveHookWorkingDirectory({}, filePath)).toBe(path.dirname(filePath));
    });

    it('resolveHookWorkingDirectory returns null for relative file paths without a workspace', () => {
      const { helpers } = createToolsSubject();

      expect(helpers.resolveHookWorkingDirectory({}, 'src/feature.ts')).toBeNull();
    });
  });

  describe('file-write hooks', () => {
    it('fires one hook per unique resolved file path', async () => {
      const subject = createToolsSubject();
      const workspaceDir = path.resolve('tmp-hook-workspace');
      const fileOne = path.join(workspaceDir, 'src', 'one.ts');
      const fileTwo = path.join(workspaceDir, 'src', 'two.ts');

      await subject.helpers.maybeFireFileWriteHooks('hashline_edit', {
        working_directory: workspaceDir,
        file_path: fileOne,
        file_paths: [fileTwo, fileOne],
      }, { ok: true });

      expect(subject.hooks.fireHook).toHaveBeenCalledTimes(2);
      expect(subject.hooks.fireHook).toHaveBeenNthCalledWith(1, 'file_write', expect.objectContaining({
        tool_name: 'hashline_edit',
        file_path: fileOne,
        working_directory: workspaceDir,
      }));
      expect(subject.hooks.fireHook).toHaveBeenNthCalledWith(2, 'file_write', expect.objectContaining({
        tool_name: 'hashline_edit',
        file_path: fileTwo,
        working_directory: workspaceDir,
      }));
    });

    it('skips hooks for tools that are not tracked as file writers', async () => {
      const subject = createToolsSubject();

      await subject.helpers.maybeFireFileWriteHooks('submit_task', {
        file_path: path.resolve('tmp-hook-workspace', 'ignored.ts'),
      }, { ok: true });

      expect(subject.hooks.fireHook).not.toHaveBeenCalled();
    });

    it('skips hooks when the handler result is a tool error', async () => {
      const subject = createToolsSubject();

      await subject.helpers.maybeFireFileWriteHooks('hashline_edit', {
        file_path: path.resolve('tmp-hook-workspace', 'ignored.ts'),
        working_directory: path.resolve('tmp-hook-workspace'),
      }, { isError: true });

      expect(subject.hooks.fireHook).not.toHaveBeenCalled();
    });

    it('logs and swallows hook failures', async () => {
      const subject = createToolsSubject({
        hooks: {
          fireHook: vi.fn(async () => {
            throw new Error('hook offline');
          }),
        },
      });
      const filePath = path.resolve('tmp-hook-workspace', 'src', 'fail.ts');

      await expect(subject.helpers.maybeFireFileWriteHooks('hashline_edit', {
        file_path: filePath,
        working_directory: path.dirname(filePath),
      }, { ok: true })).resolves.toBeUndefined();

      expect(subject.logger.child.info).toHaveBeenCalledWith(
        '[Hooks] file_write hook failed after hashline_edit: hook offline',
      );
    });
  });

  describe('handleToolCall', () => {
    it('dispatches routed tools to the matching handler and returns the handler result', async () => {
      const expected = { ok: true, source: 'handler' };
      const handleSubmitTask = vi.fn(async () => expected);
      const subject = createToolsSubject({
        modules: {
          './handlers/task': { handleSubmitTask },
        },
      });

      const result = await subject.mod.handleToolCall('submit_task', { prompt: 'hi' });

      expect(handleSubmitTask).toHaveBeenCalledWith({ prompt: 'hi' });
      expect(result).toBe(expected);
    });

    it('injects task execution context into routed handlers', async () => {
      const handleSubmitTask = vi.fn(async (args) => ({ args }));
      const subject = createToolsSubject({
        modules: {
          './handlers/task': { handleSubmitTask },
        },
      });
      process.env.TORQUE_TASK_ID = 'task-env-1';
      process.env.TORQUE_WORKFLOW_ID = 'wf-env-1';
      process.env.TORQUE_WORKFLOW_NODE_ID = 'node-env-1';

      await subject.mod.handleToolCall('submit_task', { prompt: 'context' });

      expect(handleSubmitTask).toHaveBeenCalledWith({
        prompt: 'context',
        __taskId: 'task-env-1',
        __workflowId: 'wf-env-1',
        __workflowNodeId: 'node-env-1',
      });
    });

    it('does not overwrite explicit task execution context supplied by the caller', async () => {
      const handleSubmitTask = vi.fn(async (args) => ({ args }));
      const subject = createToolsSubject({
        modules: {
          './handlers/task': { handleSubmitTask },
        },
      });
      process.env.TORQUE_TASK_ID = 'task-env';

      await subject.mod.handleToolCall('submit_task', {
        prompt: 'manual',
        __taskId: 'task-manual',
      });

      expect(handleSubmitTask).toHaveBeenCalledWith({
        prompt: 'manual',
        __taskId: 'task-manual',
      });
    });

    it('fires file-write hooks after a successful routed write tool', async () => {
      const handleHashlineEdit = vi.fn(async (args) => ({ saved: true, args }));
      const subject = createToolsSubject({
        modules: {
          './handlers/hashline-handlers': { handleHashlineEdit },
        },
      });
      const workspaceDir = path.resolve('tmp-handle-tool-call');
      const filePath = path.join(workspaceDir, 'src', 'edited.ts');

      await subject.mod.handleToolCall('hashline_edit', {
        file_path: filePath,
        working_directory: workspaceDir,
      });

      expect(subject.hooks.fireHook).toHaveBeenCalledTimes(1);
      expect(subject.hooks.fireHook).toHaveBeenCalledWith('file_write', expect.objectContaining({
        tool_name: 'hashline_edit',
        file_path: filePath,
        working_directory: workspaceDir,
      }));
    });

    it('handles ping inline without touching routeMap', async () => {
      const subject = createToolsSubject();

      const result = await subject.mod.handleToolCall('ping', { message: 'alive' });

      expect(result.pong).toBe(true);
      expect(result.message).toBe('alive');
      expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
      expect(subject.mod.routeMap.has('ping')).toBe(false);
    });

    it('returns the unlock_all_tools inline response', async () => {
      const subject = createToolsSubject();

      await expect(subject.mod.handleToolCall('unlock_all_tools', {})).resolves.toEqual({
        __unlock_all_tools: true,
        content: [{ type: 'text', text: 'All TORQUE tools are now unlocked (Tier 3). The tools list has been refreshed.' }],
      });
    });

    it('returns a tier-specific unlock response for valid tier requests', async () => {
      const subject = createToolsSubject();
      const sandboxedToolCount = subject.mod.TOOLS.length;

      await expect(subject.mod.handleToolCall('unlock_tier', { tier: '2' })).resolves.toEqual({
        __unlock_tier: 2,
        content: [{ type: 'text', text: `Unlocked Tier 2: ${getTierLabel(2, sandboxedToolCount)}. The tools list has been refreshed.` }],
      });
    });

    it('returns a tool error payload for invalid unlock tiers', async () => {
      const subject = createToolsSubject();
      const sandboxedToolCount = subject.mod.TOOLS.length;

      await expect(subject.mod.handleToolCall('unlock_tier', { tier: '9' })).resolves.toEqual({
        content: [{
          type: 'text',
          text: `Invalid tier. Use 1 (${getTierLabel(1, sandboxedToolCount)}), 2 (${getTierLabel(2, sandboxedToolCount)}), or 3 (${getTierLabel(3, sandboxedToolCount)}).`,
        }],
        isError: true,
      });
    });

    it('throws a JSON-RPC style error for unknown tool names', async () => {
      const subject = createToolsSubject();

      await expect(subject.mod.handleToolCall('missing_tool', {})).rejects.toMatchObject({
        code: -32602,
        message: 'Unknown tool: missing_tool',
      });
    });

    it('dispatches plugin-provided tools via the lazy-loaded plugin handler registry', async () => {
      const pluginHandler = vi.fn(async (args) => ({ plugin: true, args }));
      const createHandlers = vi.fn(() => ({ register_remote_agent: pluginHandler }));
      const RemoteAgentRegistry = vi.fn(function RemoteAgentRegistry(db) {
        this.db = db;
      });
      const dbHandle = { prepare: vi.fn() };
      const subject = createToolsSubject({
        database: {
          getDbInstance: vi.fn(() => dbHandle),
        },
        modules: {
          './plugins/remote-agents/tool-defs': [{
            name: 'register_remote_agent',
            description: 'Register a remote agent',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
              },
            },
          }],
          './plugins/remote-agents/agent-registry': { RemoteAgentRegistry },
          './plugins/remote-agents/handlers': { createHandlers },
        },
      });

      const result = await subject.mod.handleToolCall('register_remote_agent', { name: 'agent-1' });

      expect(subject.mod.routeMap.has('register_remote_agent')).toBe(false);
      expect(createHandlers).toHaveBeenCalledTimes(1);
      expect(RemoteAgentRegistry).toHaveBeenCalledTimes(1);
      expect(pluginHandler).toHaveBeenCalledWith({ name: 'agent-1' });
      expect(result).toEqual({ plugin: true, args: { name: 'agent-1' } });
    });

    it('returns schemas for plugin-provided tools via get_tool_schema', async () => {
      const subject = createToolsSubject({
        modules: {
          './plugins/remote-agents/tool-defs': [{
            name: 'register_remote_agent',
            description: 'Register a remote agent',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
              },
            },
          }],
        },
      });

      const result = await subject.mod.handleToolCall('get_tool_schema', {
        tool_name: 'register_remote_agent',
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredData).toMatchObject({
        name: 'register_remote_agent',
        description: 'Register a remote agent',
      });
    });
  });
});

describe('tools.js live registry integration', () => {
  it.each([
    ['submit_task', 'handleSubmitTask'],
    ['list_tasks', 'handleListTasks'],
    ['task_info', 'handleTaskInfo'],
    ['await_task', 'handleAwaitTask'],
    ['create_workflow', 'handleCreateWorkflow'],
    ['run_workflow', 'handleRunWorkflow'],
    ['await_workflow', 'handleAwaitWorkflow'],
    ['add_webhook', 'handleAddWebhook'],
    ['run_batch', 'handleRunBatch'],
    ['hashline_read', 'handleHashlineRead'],
    ['list_policies', 'handleListPolicies'],
    ['export_report_csv', 'handleExportReportCSV'],
    ['export_report_json', 'handleExportReportJSON'],
  ])('contains %s routed to %s', (toolName, handlerName) => {
    expect(realTools.routeMap.has(toolName)).toBe(true);
    expect(realTools.routeMap.get(toolName)).toEqual(expect.any(Function));
    expect(realTools.routeMap.get(toolName).name).toBe(handlerName);
  });

  it('omits inline-only tools from the auto-built routeMap', () => {
    expect([...realTools.routeMap.keys()]).not.toEqual(
      expect.arrayContaining(INLINE_TOOL_NAMES),
    );
  });

  it('does not expose SnapScope or peek routes from the core routeMap', () => {
    expect([...realTools.routeMap.keys()]).not.toEqual(
      expect.arrayContaining(['peek_ui', 'capture_screenshots', 'peek_diagnose', 'list_peek_hosts']),
    );
  });

  it('keeps remote-agent plugin tools out of the core TOOLS array and core routeMap', () => {
    const pluginToolNames = remoteAgentToolDefs.map((tool) => tool.name);

    expect(getToolNames()).not.toEqual(expect.arrayContaining(pluginToolNames));
    expect([...realTools.routeMap.keys()]).not.toEqual(expect.arrayContaining(pluginToolNames));
  });

  it('matches the live route names computed from handle* exports in HANDLER_MODULES', () => {
    expect([...realTools.routeMap.keys()].sort()).toEqual(collectLiveExpectedRoutes());
  });

  it('keeps the routeMap count aligned with tool definitions plus inline handlers', () => {
    const unmappedCount = EXPECTED_UNMAPPED_TOOL_NAMES.length;
    const aliasedCount = ALIASED_ROUTE_NAMES.length;
    expect(realTools.routeMap.size).toBe(realTools.TOOLS.length - INLINE_TOOL_NAMES.length - unmappedCount + aliasedCount);
    expect(realTools.routeMap.size + INLINE_TOOL_NAMES.length + unmappedCount - aliasedCount).toBe(getToolNames().length);
  });

  it('keeps routed handler signatures constrained to zero or one declared parameter', () => {
    const arities = [...realTools.routeMap.values()].map((handler) => handler.length);

    expect(arities.every((arity) => arity === 0 || arity === 1)).toBe(true);
    expect(arities).toContain(0);
    expect(arities).toContain(1);
  });
});
