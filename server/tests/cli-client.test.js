describe('CLI client', () => {
  function createIo() {
    const stdout = [];
    const stderr = [];

    return {
      stdout: {
        write: vi.fn((chunk) => {
          stdout.push(String(chunk));
        }),
      },
      stderr: {
        write: vi.fn((chunk) => {
          stderr.push(String(chunk));
        }),
      },
      getStdout: () => stdout.join(''),
      getStderr: () => stderr.join(''),
    };
  }

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete global.fetch;
  });

  it('status command returns formatted server health', async () => {
    const { runCli } = require('../../cli/torque-cli');
    const io = createIo();

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          status: 'healthy',
          database: 'connected',
          ollama: 'healthy',
          queue_depth: 2,
          running_tasks: 1,
          uptime_seconds: 45,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          tool: 'list_tasks',
          result: [
            '## Tasks (running)',
            '',
            '| ID | Status | Model | Host | Description | Created |',
            '|----|--------|-------|------|-------------|--------|',
            '| abc12345... | running | qwen3 | host-a | Build parser... | 2026-03-08 10:00 |',
          ].join('\n'),
        }),
      });

    const exitCode = await runCli(['status'], { ...io, cwd: '/tmp/test-project' });

    expect(exitCode).toBe(0);
    expect(io.getStdout()).toContain('Server Health');
    expect(io.getStdout()).toContain('Database: connected');
    expect(io.getStdout()).toContain('Running Tasks');
    expect(io.getStdout()).toContain('abc12345');
  });

  it('submit command sends correct POST body', async () => {
    const { executeCommand } = require('../../cli/commands');

    global.fetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        tool: 'smart_submit_task',
        result: [
          '## Task Submitted with Smart Routing',
          '',
          '| Field | Value |',
          '|-------|-------|',
          '| Task ID | `task-123` |',
          '| Status | queued |',
          '| Provider | **ollama** |',
        ].join('\n'),
      }),
    });

    const result = await executeCommand({
      command: 'submit',
      description: 'Ship the CLI',
      provider: 'ollama',
      model: 'qwen3:8b',
    }, {
      cwd: 'C:\\work\\repo',
    });

    expect(result.command).toBe('submit');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3457/api/tasks',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: 'Ship the CLI',
          provider: 'ollama',
          model: 'qwen3:8b',
          working_directory: 'C:\\work\\repo',
        }),
      }),
    );
  });

  it('list command handles status filter', async () => {
    const { executeCommand } = require('../../cli/commands');

    global.fetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ tool: 'list_tasks', result: 'ok' }),
    });

    await executeCommand({
      command: 'list',
      status: 'failed',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3457/api/tasks?status=failed&limit=20',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('result command fetches specific task', async () => {
    const { executeCommand } = require('../../cli/commands');

    global.fetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ tool: 'get_result', result: 'ok' }),
    });

    await executeCommand({
      command: 'result',
      taskId: 'task-789',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3457/api/tasks/task-789',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('cancel command sends DELETE', async () => {
    const { executeCommand } = require('../../cli/commands');

    global.fetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ tool: 'cancel_task', result: 'Task cancelled' }),
    });

    await executeCommand({
      command: 'cancel',
      taskId: 'task-456',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3457/api/tasks/task-456?confirm=true',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('health command shows server status', async () => {
    const { runCli } = require('../../cli/torque-cli');
    const io = createIo();

    global.fetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        status: 'degraded',
        database: 'connected',
        ollama: 'timeout',
        queue_depth: 0,
        running_tasks: 0,
        uptime_seconds: 12,
      }),
    });

    const exitCode = await runCli(['health'], io);

    expect(exitCode).toBe(0);
    expect(io.getStdout()).toContain('Server Health');
    expect(io.getStdout()).toContain('degraded');
    expect(io.getStdout()).toContain('timeout');
  });

  it('shows a friendly message when the server is unreachable', async () => {
    const { runCli } = require('../../cli/torque-cli');
    const io = createIo();
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ECONNREFUSED' };

    global.fetch.mockRejectedValue(error);

    const exitCode = await runCli(['health'], io);

    expect(exitCode).toBe(1);
    expect(io.getStderr()).toContain('Unable to reach TORQUE API at http://127.0.0.1:3457');
  });

  it('await command polls until task completes', async () => {
    const { executeCommand } = require('../../cli/commands');

    let callCount = 0;
    global.fetch.mockImplementation(async () => {
      callCount += 1;
      const status = callCount < 3 ? 'running' : 'completed';
      return {
        ok: true,
        text: async () => JSON.stringify({
          tool: 'get_result',
          result: `## Task Result: task-poll\n\n**Status:** ${status}\n**Provider:** codex`,
        }),
      };
    });

    const result = await executeCommand({
      command: 'await',
      taskId: 'task-poll',
      poll: '100',
      timeout: '10000',
      _log: () => {},
    });

    expect(result.command).toBe('result');
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('await command throws on timeout', async () => {
    const { executeCommand } = require('../../cli/commands');

    global.fetch.mockImplementation(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        tool: 'get_result',
        result: '## Task Result: task-stuck\n\n**Status:** running',
      }),
    }));

    await expect(executeCommand({
      command: 'await',
      taskId: 'task-stuck',
      poll: '50',
      timeout: '200',
      _log: () => {},
    })).rejects.toThrow(/timed out/i);
  });

  it('--json flag outputs raw JSON', async () => {
    const { runCli } = require('../../cli/torque-cli');
    const io = createIo();

    global.fetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        status: 'healthy',
        database: 'connected',
        ollama: 'healthy',
        queue_depth: 1,
        running_tasks: 0,
        uptime_seconds: 99,
      }),
    });

    const exitCode = await runCli(['health', '--json'], io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.getStdout())).toEqual({
      status: 'healthy',
      database: 'connected',
      ollama: 'healthy',
      queue_depth: 1,
      running_tasks: 0,
      uptime_seconds: 99,
    });
  });
});
