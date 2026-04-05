import { beforeEach, describe, expect, it, vi } from 'vitest';

let runAgenticLoop;
let truncateOldestToolResults;
let MAX_ITERATIONS;

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

function textResponse(content, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return {
    message: {
      role: 'assistant',
      content,
    },
    usage,
  };
}

function toolResponse(calls, usage = { prompt_tokens: 20, completion_tokens: 10 }) {
  const normalizedCalls = (Array.isArray(calls) ? calls : [calls]).map((call, index) => ({
    id: call.id ?? `call-${index + 1}`,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.arguments,
    },
  }));

  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: normalizedCalls,
    },
    usage,
  };
}

function createAdapter(responses) {
  const sequence = Array.isArray(responses) ? responses : [responses];
  let index = 0;

  return {
    chatCompletion: vi.fn(async (opts) => {
      const response = sequence[Math.min(index, sequence.length - 1)];
      index++;

      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response(opts, index - 1);
      return response;
    }),
  };
}

function createToolExecutor(handler = () => ({ result: 'ok' })) {
  const changedFiles = new Set();

  return {
    changedFiles,
    execute: vi.fn((name, args) => handler(name, args, changedFiles)),
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();

  const mod = await import('../providers/ollama-agentic.js');
  const subject = mod.default ?? mod;

  runAgenticLoop = subject.runAgenticLoop;
  truncateOldestToolResults = subject.truncateOldestToolResults;
  MAX_ITERATIONS = subject.MAX_ITERATIONS;
});

describe('ollama-agentic', () => {
  it('runAgenticLoop returns final text output when adapter returns no tool calls', async () => {
    const adapter = createAdapter(textResponse('Task complete.'));
    const toolExecutor = createToolExecutor();

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'System prompt',
      taskPrompt: 'Summarize the task.',
      tools: TOOL_DEFINITIONS,
      toolExecutor,
    });

    expect(result.output).toBe('Task complete.');
    expect(result.iterations).toBe(1);
    expect(result.toolLog).toEqual([]);
    expect(result.changedFiles).toEqual([]);
    expect(adapter.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('runAgenticLoop processes tool calls and continues iterating', async () => {
    const adapter = createAdapter([
      toolResponse({ name: 'read_file', arguments: { path: 'src/index.js' } }),
      textResponse('Read complete.'),
    ]);
    const toolExecutor = createToolExecutor((name, args) => ({
      result: `1: contents from ${name}(${args.path})`,
    }));

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'System prompt',
      taskPrompt: 'Inspect the file.',
      tools: TOOL_DEFINITIONS,
      toolExecutor,
    });

    expect(toolExecutor.execute).toHaveBeenCalledWith('read_file', { path: 'src/index.js' });
    expect(result.toolLog).toHaveLength(1);
    expect(result.toolLog[0].name).toBe('read_file');
    expect(result.iterations).toBe(2);
    expect(result.output).toContain('Read complete.');

    const secondCallMessages = adapter.chatCompletion.mock.calls[1][0].messages;
    expect(
      secondCallMessages.some(
        (message) => message.role === 'tool' && message.content.includes('contents from read_file')
      )
    ).toBe(true);
  });

  it('runAgenticLoop stops at MAX_ITERATIONS and includes iteration count in output', async () => {
    let callCount = 0;
    const adapter = {
      chatCompletion: vi.fn(async () =>
        toolResponse({
          name: 'read_file',
          arguments: { path: `src/file-${callCount++}.js` },
        }, { prompt_tokens: 1, completion_tokens: 1 })
      ),
    };
    const toolExecutor = createToolExecutor((_name, args) => ({
      result: `file content for ${args.path}`,
    }));

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'System prompt',
      taskPrompt: 'Inspect repository files only.',
      tools: TOOL_DEFINITIONS,
      toolExecutor,
    });

    expect(result.iterations).toBe(MAX_ITERATIONS);
    expect(result.toolLog).toHaveLength(MAX_ITERATIONS);
    expect(result.output).toContain(`Task reached maximum iterations (${MAX_ITERATIONS})`);
    expect(adapter.chatCompletion).toHaveBeenCalledTimes(MAX_ITERATIONS);
  });

  it('runAgenticLoop tracks changed files from write_file and edit_file tool calls', async () => {
    const writtenContent = 'export const value = 1;\n';
    const adapter = createAdapter([
      toolResponse([
        {
          name: 'write_file',
          arguments: { path: 'src/new-file.js', content: writtenContent },
        },
        {
          name: 'edit_file',
          arguments: { path: 'src/existing.js', old_text: 'oldValue', new_text: 'newValue' },
        },
      ]),
      textResponse('Updated both files.'),
    ]);
    const toolExecutor = createToolExecutor((name, args, changedFiles) => {
      if (name === 'write_file' || name === 'edit_file') changedFiles.add(args.path);
      return { result: `${name} completed for ${args.path}` };
    });

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'System prompt',
      taskPrompt: 'Update these files.',
      tools: TOOL_DEFINITIONS,
      toolExecutor,
    });

    expect(result.changedFiles).toEqual(['src/new-file.js', 'src/existing.js']);
    expect(result.output).toContain('--- Files Modified (2) ---');
    expect(result.output).toContain('src/new-file.js');
    expect(result.output).toContain('src/existing.js');
    expect(result.toolLog[0].arguments_preview).toContain('content_hash');
    expect(result.toolLog[0].arguments_preview).toContain('content_bytes');
    expect(result.toolLog[0].arguments_preview).not.toContain(writtenContent.trim());
  });

  it('runAgenticLoop handles repeated tool errors gracefully via the consecutive error limit', async () => {
    let callCount = 0;
    const adapter = {
      chatCompletion: vi.fn(async () =>
        toolResponse({
          name: 'run_command',
          arguments: { command: `bad-command-${callCount++}` },
        })
      ),
    };
    const toolExecutor = createToolExecutor(() => ({
      result: 'command failed',
      error: true,
    }));

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'System prompt',
      taskPrompt: 'Inspect the command result.',
      tools: TOOL_DEFINITIONS,
      toolExecutor,
      maxIterations: 6,
    });

    expect(result.output).toContain('Task stopped: consecutive errors from run_command');
    expect(result.toolLog).toHaveLength(2);
    expect(result.toolLog.every((entry) => entry.error)).toBe(true);
  });

  it('truncateOldestToolResults does nothing when under budget', () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'read the file' },
      { role: 'tool', content: 'small tool result', tool_call_id: 'call-1' },
      { role: 'assistant', content: 'done' },
    ];
    const original = JSON.parse(JSON.stringify(messages));

    truncateOldestToolResults(messages, 1000);

    expect(messages).toEqual(original);
  });

  it('truncateOldestToolResults truncates oldest tool messages when over budget while preserving the system prompt and last 2 messages', () => {
    const latestAssistant = 'latest assistant message';
    const latestTool = 'latest tool result';
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'start work' },
      { role: 'tool', content: 'A'.repeat(5000), tool_call_id: 'call-1' },
      { role: 'assistant', content: 'first assistant message' },
      { role: 'tool', content: 'B'.repeat(5000), tool_call_id: 'call-2' },
      { role: 'assistant', content: latestAssistant },
      { role: 'tool', content: latestTool, tool_call_id: 'call-3' },
    ];

    truncateOldestToolResults(messages, 600);

    expect(messages[0].content).toBe('system prompt');
    expect(messages[messages.length - 2].content).toBe(latestAssistant);
    expect(messages[messages.length - 1].content).toBe(latestTool);
    expect(messages[2].content).toContain('[result truncated');
    expect(messages[2]._truncated).toBe(true);
    expect(messages[4].content).toContain('[result truncated');
    expect(messages[4]._truncated).toBe(true);
    expect(messages[6]._truncated).toBeUndefined();
  });

  it('runAgenticLoop returns token usage statistics', async () => {
    const adapter = createAdapter([
      toolResponse(
        { name: 'read_file', arguments: { path: 'src/feature.js' } },
        { prompt_tokens: 120, completion_tokens: 30 }
      ),
      textResponse('Summary ready.', { prompt_tokens: 80, completion_tokens: 20 }),
    ]);
    const toolExecutor = createToolExecutor(() => ({ result: 'feature contents' }));

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'System prompt',
      taskPrompt: 'Inspect the feature.',
      tools: TOOL_DEFINITIONS,
      toolExecutor,
    });

    expect(result.tokenUsage).toEqual({
      prompt_tokens: 200,
      completion_tokens: 50,
    });
  });

  it('runAgenticLoop handles an abort signal correctly', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runAgenticLoop({
        adapter: createAdapter(textResponse('should not be returned')),
        systemPrompt: 'System prompt',
        taskPrompt: 'Do the work.',
        tools: TOOL_DEFINITIONS,
        toolExecutor: createToolExecutor(),
        signal: controller.signal,
      })
    ).rejects.toThrow('Task cancelled at iteration 1');
  });

  it('MAX_ITERATIONS constant equals 15', () => {
    expect(MAX_ITERATIONS).toBe(15);
  });
});
