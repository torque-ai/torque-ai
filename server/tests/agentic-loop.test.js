'use strict';

/**
 * agentic-loop.test.js — Tests for the adapter-agnostic agentic loop (ollama-agentic.js)
 *
 * Uses mock adapter + mock tool executor so no real HTTP or filesystem I/O is needed.
 */

const { runAgenticLoop, MAX_ITERATIONS } = require('../providers/ollama-agentic');

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock adapter that returns pre-configured responses in sequence.
 * After the last configured response, the last response is repeated.
 *
 * @param {Array<{ message: Object, usage?: Object }>} responses
 * @returns {{ chatCompletion: Function }}
 */
function mockAdapter(responses) {
  let callNum = 0;
  return {
    chatCompletion: async () => {
      const resp = responses[Math.min(callNum, responses.length - 1)];
      callNum++;
      return resp;
    },
  };
}

/**
 * Create a mock tool executor.
 *
 * @param {Object} results - Map from tool name to return value { result, error?, metadata? }
 * @returns {{ execute: Function, changedFiles: Set }}
 */
function mockToolExecutor(results = {}) {
  return {
    execute: (name, _args) => results[name] || { result: 'ok', metadata: {} },
    changedFiles: new Set(),
  };
}

/**
 * Build a standard adapter response with no tool calls (final text response).
 * @param {string} text
 * @param {Object} [usage]
 */
function textResponse(text, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return {
    message: { role: 'assistant', content: text },
    usage,
  };
}

/**
 * Build an adapter response that contains a structured tool call.
 * @param {string} toolName
 * @param {Object} toolArgs
 * @param {Object} [usage]
 */
function toolCallResponse(toolName, toolArgs, usage = { prompt_tokens: 20, completion_tokens: 10 }) {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          function: {
            name: toolName,
            arguments: toolArgs,
          },
        },
      ],
    },
    usage,
  };
}

// Default tools / tool executor that won't be used in most tests
const NOOP_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

// ---------------------------------------------------------------------------
// Test 1: completes when model returns no tool calls
// ---------------------------------------------------------------------------

describe('runAgenticLoop — no tool calls (single iteration)', () => {
  it('returns output containing model text after 1 iteration', async () => {
    const adapter = mockAdapter([
      textResponse('The task is complete.'),
    ]);
    const executor = mockToolExecutor();

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'You are a helpful assistant.',
      taskPrompt: 'Say hello.',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
    });

    expect(result.output).toContain('The task is complete.');
    expect(result.iterations).toBe(1);
    expect(result.toolLog).toHaveLength(0);
    expect(Array.isArray(result.changedFiles)).toBe(true);
  });

  it('requires a tool call before final output when evidence guard is enabled', async () => {
    const adapter = mockAdapter([
      textResponse('The repository is a .NET solution.'),
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'list_directory', arguments: JSON.stringify({ path: '.' }) },
          }],
        },
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      textResponse('Observed package.json from tool results.'),
    ]);
    const executor = mockToolExecutor({
      list_directory: { result: 'package.json\nsrc\ntests', metadata: {} },
    });

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'You are a helpful assistant.',
      taskPrompt: 'Inspect the repository.',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
      requireToolUseBeforeFinal: true,
    });

    expect(result.output).toContain('Observed package.json');
    expect(result.output).not.toContain('The repository is a .NET solution.');
    expect(result.toolLog).toHaveLength(1);
    expect(result.toolLog[0].name).toBe('list_directory');
  });

  it('stops instead of accepting a second no-tool final when evidence guard is enabled', async () => {
    const adapter = mockAdapter([
      textResponse('The repository is a .NET solution.'),
      textResponse('Still answering without tools.'),
    ]);
    const executor = mockToolExecutor();

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'You are a helpful assistant.',
      taskPrompt: 'Inspect the repository.',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
      requireToolUseBeforeFinal: true,
    });

    expect(result.output).toContain('model answered without using required repository tools');
    expect(result.stopReason).toBe('missing_tool_evidence');
    expect(result.toolLog).toHaveLength(0);
  });

  it('nudges read-only tasks that end with write-refusal boilerplate after tool use', async () => {
    const adapter = mockAdapter([
      toolCallResponse('list_directory', { path: '.' }),
      textResponse('I am unable to create or modify any files. This is read-only.'),
      textResponse('Observed package.json, README.md, src, and tests.'),
    ]);
    const executor = mockToolExecutor({
      list_directory: { result: 'package.json\nREADME.md\nsrc\ntests', metadata: {} },
    });

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'You are a helpful assistant.',
      taskPrompt: 'Read-only repository inspection. Do not create, edit, write, or delete files.',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
    });

    expect(result.output).toContain('Observed package.json');
    expect(result.output).not.toContain('unable to create');
    expect(result.toolLog).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 2: executes tool calls and continues loop
// ---------------------------------------------------------------------------

describe('runAgenticLoop — tool call then final response', () => {
  it('executes one tool call then finishes, toolLog has 1 entry', async () => {
    const adapter = mockAdapter([
      toolCallResponse('read_file', { path: 'src/main.js' }),
      textResponse('I have read the file. Done.'),
    ]);
    const executor = mockToolExecutor({
      read_file: { result: '1\tconsole.log("hello");', metadata: {} },
    });

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'You are a coding assistant.',
      taskPrompt: 'Read the main file.',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
    });

    expect(result.toolLog).toHaveLength(1);
    expect(result.toolLog[0].name).toBe('read_file');
    expect(result.toolLog[0].error).toBe(false);
    expect(result.iterations).toBe(2);
    expect(result.output).toContain('Done.');
  });

  it('synthesizes OpenAI tool call messages for parsed pseudo tool calls', async () => {
    const adapterCalls = [];
    const responses = [
      textResponse('<list_directory path="." />'),
      textResponse('Directory listed. Done.'),
    ];
    const adapter = {
      chatCompletion: async (params) => {
        adapterCalls.push(params);
        return responses[Math.min(adapterCalls.length - 1, responses.length - 1)];
      },
    };
    const executor = mockToolExecutor({
      list_directory: { result: 'hello.txt', metadata: {} },
    });

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'list files',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
      maxIterations: 3,
    });

    expect(result.toolLog).toHaveLength(1);
    expect(result.toolLog[0].name).toBe('list_directory');
    expect(adapterCalls).toHaveLength(2);
    const secondMessages = adapterCalls[1].messages;
    const assistantToolMessage = secondMessages.find((message) => message.role === 'assistant' && message.tool_calls);
    const toolResultMessage = secondMessages.find((message) => message.role === 'tool');
    expect(assistantToolMessage.tool_calls[0]).toMatchObject({
      id: 'call_parsed_1_1',
      type: 'function',
      function: {
        name: 'list_directory',
        arguments: '{"path":"."}',
      },
    });
    expect(toolResultMessage).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_parsed_1_1',
      content: 'hello.txt',
    });
    expect(result.output).toContain('Done.');
  });

  it('tool log entry has expected shape', async () => {
    const adapter = mockAdapter([
      toolCallResponse('read_file', { path: 'foo.txt' }),
      textResponse('Done.'),
    ]);
    const executor = mockToolExecutor({
      read_file: { result: 'file contents here' },
    });

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'task',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
    });

    const entry = result.toolLog[0];
    expect(entry).toHaveProperty('iteration');
    expect(entry).toHaveProperty('name');
    expect(entry).toHaveProperty('arguments_preview');
    expect(entry).toHaveProperty('result_preview');
    expect(entry).toHaveProperty('error');
    expect(entry).toHaveProperty('duration_ms');
    expect(typeof entry.duration_ms).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Test 3: stuck loop detection — stops on identical consecutive tool calls
// ---------------------------------------------------------------------------

describe('runAgenticLoop — stuck loop detection', () => {
  it('stops early when identical tool calls repeat and output contains "stuck"', async () => {
    // Model always returns the same tool call
    const adapter = mockAdapter([
      toolCallResponse('read_file', { path: 'same.txt' }),
    ]);
    const executor = mockToolExecutor({
      read_file: { result: 'content' },
    });

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'task',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
      maxIterations: 10,
    });

    // Should stop well before maxIterations
    expect(result.iterations).toBeLessThan(10);
    expect(result.output.toLowerCase()).toContain('stuck');
  });
});

// ---------------------------------------------------------------------------
// Test 4: consecutive error detection — stops when same tool errors twice
// ---------------------------------------------------------------------------

describe('runAgenticLoop — consecutive error detection', () => {
  it('stops when same tool errors twice in a row', async () => {
    // Model keeps calling the same tool with different args (to avoid stuck detection)
    // but the tool always errors
    let callNum = 0;
    const errorAdapter = {
      chatCompletion: async () => {
        // Use different args each call so stuck detection doesn't fire
        return toolCallResponse('run_command', { command: `bad_cmd_${callNum++}` });
      },
    };
    const executor = mockToolExecutor({
      run_command: { result: 'Error: command not found', error: true },
    });

    const result = await runAgenticLoop({
      adapter: errorAdapter,
      systemPrompt: 'sys',
      taskPrompt: 'run commands',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
      maxIterations: 10,
    });

    expect(result.iterations).toBeLessThan(10);
    expect(result.output.toLowerCase()).toContain('consecutive errors');
    expect(result.output).toContain('run_command');
  });
});

// ---------------------------------------------------------------------------
// Test 5: token usage accumulation across iterations
// ---------------------------------------------------------------------------

describe('runAgenticLoop — token usage tracking', () => {
  it('accumulates token usage across iterations', async () => {
    const adapter = mockAdapter([
      toolCallResponse('read_file', { path: 'a.txt' }, { prompt_tokens: 100, completion_tokens: 50 }),
      textResponse('Done.', { prompt_tokens: 200, completion_tokens: 30 }),
    ]);
    const executor = mockToolExecutor({
      read_file: { result: 'some content' },
    });

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'task',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
    });

    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage.prompt_tokens).toBe(300);       // 100 + 200
    expect(result.tokenUsage.completion_tokens).toBe(80);    // 50 + 30
  });

  it('starts with zero token usage when adapter provides none', async () => {
    const adapter = {
      chatCompletion: async () => ({
        message: { role: 'assistant', content: 'Done' },
        // no usage field
      }),
    };
    const executor = mockToolExecutor();

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'task',
      tools: [],
      toolExecutor: executor,
    });

    expect(result.tokenUsage.prompt_tokens).toBe(0);
    expect(result.tokenUsage.completion_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6: context truncation
// ---------------------------------------------------------------------------

describe('runAgenticLoop — context budget truncation', () => {
  it('truncates oldest tool results when context budget is exceeded', async () => {
    // Tool returns a large result that exceeds the budget
    const largeResult = 'X'.repeat(10000); // 10k chars = ~2500 tokens

    // Iteration 1: tool call with large result
    // Iteration 2: another tool call
    // Iteration 3: final text response
    let capturedMessages = null;
    const executor = {
      execute: (name, args) => {
        if (args.path === 'big.txt') return { result: largeResult };
        return { result: 'small content' };
      },
      changedFiles: new Set(),
    };

    // Spy on adapter to capture messages at third call
    let callCount = 0;
    const responses = [
      toolCallResponse('read_file', { path: 'big.txt' }),
      toolCallResponse('read_file', { path: 'small.txt' }),
      textResponse('Done with both files.'),
    ];
    const spyAdapter = {
      chatCompletion: async (opts) => {
        const resp = responses[Math.min(callCount, responses.length - 1)];
        callCount++;
        if (callCount === 3) {
          capturedMessages = JSON.parse(JSON.stringify(opts.messages));
        }
        return resp;
      },
    };

    const result = await runAgenticLoop({
      adapter: spyAdapter,
      systemPrompt: 'sys',
      taskPrompt: 'task',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
      contextBudget: 1000, // Very tight budget to force truncation
    });

    expect(result.output).toContain('Done with both files.');

    // The first tool result (10k chars) should have been truncated
    if (capturedMessages) {
      const toolMessages = capturedMessages.filter(m => m.role === 'tool');
      // At least one should be truncated
      const truncated = toolMessages.some(m => m.content && m.content.includes('[result truncated'));
      expect(truncated).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7: parse failure recovery
// ---------------------------------------------------------------------------

describe('runAgenticLoop — parse failure recovery', () => {
  it('executes OpenRouter action/parameters JSON as a parsed tool call', async () => {
    const adapter = mockAdapter([
      textResponse(JSON.stringify({
        action: 'list_directory',
        parameters: { path: '.' },
      })),
      textResponse('Observed package.json and src. No edits were made.'),
    ]);
    const calls = [];
    const executor = {
      execute: (name, args) => {
        calls.push({ name, args });
        return { result: 'package.json\nsrc\ntests', metadata: {} };
      },
      changedFiles: new Set(),
    };

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'Read-only list directory.',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
    });

    expect(calls).toEqual([{ name: 'list_directory', args: { path: '.' } }]);
    expect(result.toolLog).toHaveLength(1);
    expect(result.output).toContain('Observed package.json');
  });

  it('executes nested OpenRouter command JSON as a parsed tool call', async () => {
    const adapter = mockAdapter([
      textResponse(JSON.stringify({
        command: {
          action: 'list_directory',
          parameters: { path: 'src' },
        },
      })),
      textResponse('Observed source files.'),
    ]);
    const calls = [];
    const executor = {
      execute: (name, args) => {
        calls.push({ name, args });
        return { result: 'index.js\nproviders', metadata: {} };
      },
      changedFiles: new Set(),
    };

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'Read-only list src.',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
    });

    expect(calls).toEqual([{ name: 'list_directory', args: { path: 'src' } }]);
    expect(result.toolLog).toHaveLength(1);
    expect(result.output).toContain('Observed source files');
  });

  it('normalizes OpenRouter search_files query parameter to pattern', async () => {
    const adapter = mockAdapter([
      textResponse(JSON.stringify({
        action: 'search_files',
        parameters: { query: 'parser', path: '.' },
      })),
      textResponse('Observed parser matches.'),
    ]);
    const calls = [];
    const executor = {
      execute: (name, args) => {
        calls.push({ name, args });
        return { result: 'src/parser.js:1: parser', metadata: {} };
      },
      changedFiles: new Set(),
    };

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'Search for parser.',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
    });

    expect(calls).toEqual([{ name: 'search_files', args: { path: '.', pattern: 'parser' } }]);
    expect(result.toolLog).toHaveLength(1);
    expect(result.output).toContain('Observed parser matches');
  });

  it('injects correction message when response contains "name" but no valid tool call, then treats next response as final', async () => {
    // First response: malformed JSON with "name" in content but no parseable tool call
    const malformedResponse = {
      message: {
        role: 'assistant',
        content: 'I want to call {"name": "read_file"} but forgot the format',
      },
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    const finalResponse = textResponse('I have completed the task.');

    const executor = mockToolExecutor();

    const capturedMessages = [];
    let callCount = 0;
    const spyAdapter = {
      chatCompletion: async (opts) => {
        callCount++;
        // Capture messages at second call to verify correction was injected
        if (callCount === 2) {
          capturedMessages.push(...opts.messages);
        }
        if (callCount === 1) return malformedResponse;
        return finalResponse;
      },
    };

    const result = await runAgenticLoop({
      adapter: spyAdapter,
      systemPrompt: 'sys',
      taskPrompt: 'task',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
    });

    // Should eventually finish with the final text response
    expect(result.output).toContain('I have completed the task.');

    // The second call should have a correction message in context
    const correctionMsg = capturedMessages.find(
      m => m.role === 'user' && m.content && m.content.includes('not a valid tool call')
    );
    expect(correctionMsg).toBeDefined();
  });

  it('does not inject correction twice — only one retry', async () => {
    // Both responses are malformed — the second attempt should be treated as final text
    const malformedResponse = {
      message: {
        role: 'assistant',
        content: 'Trying to use {"name": "read_file"} incorrectly again',
      },
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    let callCount = 0;
    const spyAdapter = {
      chatCompletion: async () => {
        callCount++;
        return malformedResponse;
      },
    };

    const result = await runAgenticLoop({
      adapter: spyAdapter,
      systemPrompt: 'sys',
      taskPrompt: 'task',
      tools: NOOP_TOOLS,
      toolExecutor: mockToolExecutor(),
      maxIterations: 10,
    });

    // After one correction injection, the next malformed response is treated as final
    // so the loop should not continue indefinitely
    expect(callCount).toBeLessThanOrEqual(3);
    // Output should contain the model text, not a max-iterations error
    expect(result.output).toContain('Trying to use');
  });
});

// ---------------------------------------------------------------------------
// Test 8: signal abort
// ---------------------------------------------------------------------------

describe('runAgenticLoop — signal abort', () => {
  it('throws Task cancelled when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const adapter = mockAdapter([textResponse('should not reach this')]);
    const executor = mockToolExecutor();

    await expect(
      runAgenticLoop({
        adapter,
        systemPrompt: 'sys',
        taskPrompt: 'task',
        tools: [],
        toolExecutor: executor,
        signal: controller.signal,
      })
    ).rejects.toThrow('Task cancelled');
  });
});

// ---------------------------------------------------------------------------
// Test 9: max iterations reached
// ---------------------------------------------------------------------------

describe('runAgenticLoop — max iterations', () => {
  it('stops at maxIterations and includes iteration count in output', async () => {
    // Model always calls a tool (no stuck detection because args change)
    let callNum = 0;
    const adapter = {
      chatCompletion: async () => {
        return toolCallResponse('read_file', { path: `file${callNum++}.txt` });
      },
    };
    const executor = mockToolExecutor({
      read_file: { result: 'content' },
    });

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'task',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
      maxIterations: 3,
    });

    expect(result.iterations).toBe(3);
    expect(result.output).toContain('maximum iterations');
  });
});

// ---------------------------------------------------------------------------
// Test 10: write_file arguments preview uses hash instead of content
// ---------------------------------------------------------------------------

describe('runAgenticLoop — write_file arguments preview', () => {
  it('stores content_hash and content_bytes instead of raw content for write_file', async () => {
    const largeContent = 'A'.repeat(1000);
    const adapter = mockAdapter([
      toolCallResponse('write_file', { path: 'out.txt', content: largeContent }),
      textResponse('File written.'),
    ]);
    const executor = mockToolExecutor({
      write_file: { result: 'File written: out.txt (1000 bytes)' },
    });

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'write a file',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
    });

    expect(result.toolLog).toHaveLength(1);
    const preview = result.toolLog[0].arguments_preview;
    // arguments_preview should be a string containing hash/bytes info, NOT raw content
    expect(preview).toContain('content_hash');
    expect(preview).toContain('content_bytes');
    expect(preview).not.toContain('A'.repeat(100)); // large content not in preview
  });
});

// ---------------------------------------------------------------------------
// Test 11: onProgress and onToolCall callbacks
// ---------------------------------------------------------------------------

describe('runAgenticLoop — callbacks', () => {
  it('calls onProgress for each iteration', async () => {
    const progressCalls = [];
    const adapter = mockAdapter([
      toolCallResponse('read_file', { path: 'a.txt' }),
      textResponse('Done.'),
    ]);
    const executor = mockToolExecutor({ read_file: { result: 'ok' } });

    await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'task',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
      onProgress: (iter, max, lastTool) => progressCalls.push({ iter, max, lastTool }),
    });

    expect(progressCalls.length).toBeGreaterThanOrEqual(2);
    expect(progressCalls[0].iter).toBe(1);
  });

  it('calls onToolCall for each tool execution', async () => {
    const toolCallLog = [];
    const adapter = mockAdapter([
      toolCallResponse('read_file', { path: 'b.txt' }),
      textResponse('Done.'),
    ]);
    const executor = mockToolExecutor({ read_file: { result: 'file content' } });

    await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'task',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
      onToolCall: (name, args, execResult) => toolCallLog.push({ name, args, execResult }),
    });

    expect(toolCallLog).toHaveLength(1);
    expect(toolCallLog[0].name).toBe('read_file');
    expect(toolCallLog[0].execResult.result).toBe('file content');
  });

  it('passes onChunk through to the adapter for streaming heartbeats', async () => {
    const chunks = [];
    const adapter = {
      chatCompletion: async ({ onChunk }) => {
        onChunk?.('working');
        return textResponse('Done.');
      },
    };
    const executor = mockToolExecutor();

    await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'task',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
      onChunk: (text) => chunks.push(text),
    });

    expect(chunks).toEqual(['working']);
  });
});

// ---------------------------------------------------------------------------
// Test 12: tool_call → text (mixed sequence — common real-world pattern)
// ---------------------------------------------------------------------------

describe('runAgenticLoop — tool_call followed by text response (common pattern)', () => {
  it('executes tool, receives result, then final text response', async () => {
    // First iteration: model returns a tool call
    // Second iteration: model returns a text response (final answer)
    const adapter = mockAdapter([
      toolCallResponse('read_file', { path: 'src/index.js' }),
      textResponse('I read the file. The implementation looks correct.'),
    ]);
    const executor = mockToolExecutor({
      read_file: { result: 'const x = 42;', metadata: {} },
    });

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'You are a code reviewer.',
      taskPrompt: 'Review the implementation.',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
    });

    // Tool was executed
    expect(result.toolLog).toHaveLength(1);
    expect(result.toolLog[0].name).toBe('read_file');
    expect(result.toolLog[0].error).toBe(false);

    // Final output is the text response, not a tool call
    expect(result.output).toContain('I read the file.');

    // Loop ran exactly 2 iterations (1 tool call + 1 final text)
    expect(result.iterations).toBe(2);

    // No files were changed (read-only tool)
    expect(result.changedFiles).toHaveLength(0);
  });

  it('carries tool result content into the conversation context', async () => {
    // Verify that the tool result is visible in the messages passed to the second adapter call
    let secondCallMessages = null;
    let callCount = 0;

    const responses = [
      toolCallResponse('read_file', { path: 'config.json' }),
      textResponse('The config file has been processed.'),
    ];

    const spyAdapter = {
      chatCompletion: async (opts) => {
        callCount++;
        if (callCount === 2) {
          secondCallMessages = JSON.parse(JSON.stringify(opts.messages));
        }
        return responses[Math.min(callCount - 1, responses.length - 1)];
      },
    };

    const executor = mockToolExecutor({
      read_file: { result: '{"version": "1.0", "debug": false}' },
    });

    await runAgenticLoop({
      adapter: spyAdapter,
      systemPrompt: 'sys',
      taskPrompt: 'read config',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
    });

    // The second call should include a tool-role message with the result
    expect(secondCallMessages).not.toBeNull();
    const toolResultMsg = secondCallMessages.find(m => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.content).toContain('"version"');
  });
});

describe('runAgenticLoop — actionless iteration guard', () => {
  it('stops modification tasks after the configured number of actionless iterations', async () => {
    const adapter = mockAdapter([
      toolCallResponse('read_file', { path: 'src/FixMe.cs' }),
      toolCallResponse('read_file', { path: 'src/FixMe.cs' }),
      textResponse('This response should never be reached.'),
    ]);
    const executor = mockToolExecutor({
      read_file: { result: 'class FixMe {}', metadata: {} },
    });

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'You are a coding assistant.',
      taskPrompt: 'Fix the compile error in src/FixMe.cs and verify the repair.',
      tools: NOOP_TOOLS,
      toolExecutor: executor,
      actionlessIterationLimit: 2,
      maxIterations: 5,
    });

    expect(result.stopReason).toBe('actionless_iterations');
    expect(result.output).toContain('without any write or verification attempt');
    expect(result.iterations).toBe(2);
    expect(result.toolLog).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Test 14: MAX_ITERATIONS exported constant
// ---------------------------------------------------------------------------

describe('MAX_ITERATIONS export', () => {
  it('is a positive integer', () => {
    expect(typeof MAX_ITERATIONS).toBe('number');
    expect(MAX_ITERATIONS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_ITERATIONS)).toBe(true);
  });

  it('defaults are respected when maxIterations is not provided', async () => {
    // Just verify the loop runs without throwing when using defaults
    const adapter = mockAdapter([textResponse('done')]);
    const executor = mockToolExecutor();

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'sys',
      taskPrompt: 'task',
      tools: [],
      toolExecutor: executor,
    });

    expect(result.iterations).toBe(1);
  });
});
