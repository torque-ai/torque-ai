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
  // eslint-disable-next-line torque/no-reset-modules-in-each -- dynamic import re-loads ollama-agentic fresh each run
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

  it('does not apply modification no-progress guards when taskExpectsModification is false', async () => {
    const readResponses = Array.from({ length: 8 }, (_, index) =>
      toolResponse({ name: 'read_file', arguments: { path: `src/file-${index}.cs` } })
    );
    const adapter = createAdapter([
      ...readResponses,
      textResponse('## Task 1: Add a focused startup diagnostic test\n\nVerify the relay reports a typed LAN startup failure reason.'),
    ]);
    const toolExecutor = createToolExecutor((name, args) => ({
      result: `${name} result for ${args.path}`,
    }));

    const result = await runAgenticLoop({
      adapter,
      systemPrompt: 'System prompt',
      taskPrompt: 'Generate an execution plan to fix LAN startup failure reason handling.',
      tools: TOOL_DEFINITIONS,
      toolExecutor,
      maxIterations: 12,
      taskExpectsModification: false,
    });

    expect(adapter.chatCompletion).toHaveBeenCalledTimes(9);
    expect(result.stopReason).toBe('model_finished');
    expect(result.output).toContain('## Task 1:');
    expect(result.toolLog).toHaveLength(8);
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
    expect(result.output).toContain('after 3 iterations');
    expect(result.toolLog).toHaveLength(3);
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

  it('MAX_ITERATIONS constant equals the free-agentic default', () => {
    expect(MAX_ITERATIONS).toBe(25);
  });

  describe('Fix #3 — relaxed early-stop and allowlist-rejection skip', () => {
    it('does NOT trigger early-stop on 2 same-tool real errors (was the threshold before)', async () => {
      const adapter = createAdapter([
        toolResponse({ name: 'read_file', arguments: { path: 'a.js' } }),
        toolResponse({ name: 'read_file', arguments: { path: 'b.js' } }),
        toolResponse({ name: 'read_file', arguments: { path: 'c.js' } }),
        textResponse('Done.'),
      ]);
      const toolExecutor = createToolExecutor((_name, args) => {
        if (args.path === 'c.js') return { result: 'contents of c.js' };
        return { result: `ENOENT: ${args.path}`, error: true };
      });

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Read some files.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      expect(result.stopReason).not.toBe('consecutive_tool_errors');
      expect(result.output).toContain('Done.');
    });

    it('DOES trigger early-stop on 3 same-tool real errors', async () => {
      const adapter = createAdapter([
        toolResponse({ name: 'read_file', arguments: { path: 'a.js' } }),
        toolResponse({ name: 'read_file', arguments: { path: 'b.js' } }),
        toolResponse({ name: 'read_file', arguments: { path: 'c.js' } }),
        textResponse('Should not reach here.'),
      ]);
      const toolExecutor = createToolExecutor((_name, args) => ({
        result: `ENOENT: ${args.path}`,
        error: true,
      }));

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Read some files.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      expect(result.stopReason).toBe('consecutive_tool_errors');
      expect(result.output).toContain('consecutive errors from read_file');
    });

    it('skips the counter when error has _allowlist_rejection marker', async () => {
      const adapter = createAdapter([
        toolResponse({ name: 'run_command', arguments: { command: 'cat foo' } }),
        toolResponse({ name: 'run_command', arguments: { command: 'cat bar' } }),
        toolResponse({ name: 'run_command', arguments: { command: 'cat baz' } }),
        toolResponse({ name: 'read_file', arguments: { path: 'foo.txt' } }),
        textResponse('Read foo.'),
      ]);
      const toolExecutor = createToolExecutor((name) => {
        if (name === 'run_command') {
          return {
            result: 'Error: cat is not allowed; try read_file',
            error: true,
            _allowlist_rejection: true,
          };
        }
        return { result: 'foo contents' };
      });

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Read foo.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      expect(result.stopReason).not.toBe('consecutive_tool_errors');
      expect(result.output).toContain('Read foo.');
    });

    it('mix: real error + allowlist rejection + same-tool real errors does not trigger early-stop', async () => {
      // Sequence:
      //   iter 0: read_file a.js — real error (counter=1, lastErrorTool=read_file)
      //   iter 1: run_command — _allowlist_rejection (counter resets to 0)
      //   iter 2: read_file b.js — real error (counter=1, lastErrorTool=read_file again)
      //   iter 3: read_file c.js — real error (counter=2; threshold 3 not yet hit)
      //   iter 4: text response 'Done.'
      const adapter = createAdapter([
        toolResponse({ name: 'read_file', arguments: { path: 'a.js' } }),
        toolResponse({ name: 'run_command', arguments: { command: 'cat foo' } }),
        toolResponse({ name: 'read_file', arguments: { path: 'b.js' } }),
        toolResponse({ name: 'read_file', arguments: { path: 'c.js' } }),
        textResponse('Done.'),
      ]);
      const toolExecutor = createToolExecutor((name, args) => {
        if (name === 'run_command') {
          return {
            result: 'Error: cat is not allowed; try read_file',
            error: true,
            _allowlist_rejection: true,
          };
        }
        return { result: `ENOENT: ${args.path}`, error: true };
      });

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Mix of failures.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      expect(result.stopReason).not.toBe('consecutive_tool_errors');
      expect(result.output).toContain('Done.');
    });

    it('different-tool error breaks the consecutive count', async () => {
      // iter 0: read_file errors (counter=1, lastErrorTool=read_file)
      // iter 1: run_command errors (different tool; resets to counter=1, lastErrorTool=run_command)
      // iter 2: read_file errors (different from lastErrorTool=run_command; resets again)
      // iter 3: text response 'Done.'
      const adapter = createAdapter([
        toolResponse({ name: 'read_file', arguments: { path: 'a.js' } }),
        toolResponse({ name: 'run_command', arguments: { command: 'echo hi' } }),
        toolResponse({ name: 'read_file', arguments: { path: 'b.js' } }),
        textResponse('Done.'),
      ]);
      const toolExecutor = createToolExecutor((name, args) => {
        if (name === 'run_command') {
          // NOT an allowlist rejection — a genuine command-execution error.
          return { result: 'command failed', error: true };
        }
        return { result: `ENOENT: ${args.path}`, error: true };
      });

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Different tool errors.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      expect(result.stopReason).not.toBe('consecutive_tool_errors');
      expect(result.output).toContain('Done.');
    });
  });

  describe('Fix #1B — first-iteration validator', () => {
    const CORRECTIVE_REPROMPT_FRAGMENT = 'Your previous response had no tool calls';

    function messagesContainCorrectivePrompt(messages) {
      return messages.some(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(CORRECTIVE_REPROMPT_FRAGMENT)
      );
    }

    it('fires on iter 0 with text-only response > 50 chars', async () => {
      const longProse = 'I will create the migration file by writing SQL CREATE TABLE statements directly in the response without using tools.';
      expect(longProse.length).toBeGreaterThan(50);

      const adapter = createAdapter([
        // iter 0: text-only prose response — validator should fire
        textResponse(longProse),
        // iter 0 retry: model now uses a tool
        toolResponse({
          name: 'write_file',
          arguments: { path: 'm.sql', content: 'CREATE TABLE foo (id INT);' },
        }),
        // iter 1: final summary
        textResponse('Done.'),
      ]);
      const toolExecutor = createToolExecutor((name, args, changedFiles) => {
        if (name === 'write_file') changedFiles.add(args.path);
        return { result: `${name} completed for ${args.path}` };
      });

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Create the migration file at m.sql.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      // Adapter should have been called at least 3 times (iter 0, retry, iter 1)
      expect(adapter.chatCompletion.mock.calls.length).toBeGreaterThanOrEqual(3);

      // The retry call (2nd adapter call) must have the corrective prompt in its messages
      const retryMessages = adapter.chatCompletion.mock.calls[1][0].messages;
      expect(messagesContainCorrectivePrompt(retryMessages)).toBe(true);

      // Task completes normally with the iter-1 final response
      expect(result.output).toContain('Done.');
      // The write_file call should be in the toolLog
      expect(result.toolLog.some((entry) => entry.name === 'write_file')).toBe(true);
    });

    it('does NOT fire when content < 50 chars', async () => {
      // Short text-only response — validator must NOT fire; falls through to normal final-response handling
      const adapter = createAdapter([
        textResponse('ok'),
      ]);
      const toolExecutor = createToolExecutor();

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Confirm receipt.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      // Only one adapter call — model finished, no validator retry
      expect(adapter.chatCompletion).toHaveBeenCalledTimes(1);
      // Final response is the short content
      expect(result.output).toBe('ok');
      // No corrective prompt anywhere
      const allMessages = adapter.chatCompletion.mock.calls.flatMap((c) => c[0].messages);
      expect(messagesContainCorrectivePrompt(allMessages)).toBe(false);
    });

    it('does NOT fire when tool_calls is non-empty', async () => {
      // Model returns prose AND a tool_call — the tool_calls.length === 0 gate must skip the validator
      const adapter = createAdapter([
        {
          message: {
            role: 'assistant',
            content: 'I will read foo to gather context before answering the question properly.',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: { path: 'foo.js' },
                },
              },
            ],
          },
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        textResponse('Done.'),
      ]);
      const toolExecutor = createToolExecutor(() => ({ result: 'file content' }));

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Read foo.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      // Validator must NOT have fired
      const allMessages = adapter.chatCompletion.mock.calls.flatMap((c) => c[0].messages);
      expect(messagesContainCorrectivePrompt(allMessages)).toBe(false);
      // Read happened, then final summary
      expect(result.toolLog.some((entry) => entry.name === 'read_file')).toBe(true);
      expect(result.output).toContain('Done.');
    });

    it('does NOT fire on iter > 0 (only fires on iter 0)', async () => {
      const proseSummary = 'After examining the file thoroughly I have determined the answer is forty-two and that the structure is well-organized for future maintenance.';
      expect(proseSummary.length).toBeGreaterThan(50);

      const adapter = createAdapter([
        // iter 0: tool call (no validator trigger)
        toolResponse({ name: 'read_file', arguments: { path: 'foo.js' } }),
        // iter 1: text-only prose > 50 chars — validator MUST NOT fire (iter > 0)
        textResponse(proseSummary),
      ]);
      const toolExecutor = createToolExecutor(() => ({ result: 'foo contents' }));

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Inspect foo and summarize.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      // Validator must NOT have fired
      const allMessages = adapter.chatCompletion.mock.calls.flatMap((c) => c[0].messages);
      expect(messagesContainCorrectivePrompt(allMessages)).toBe(false);
      // Final output is the iter-1 prose summary
      expect(result.output).toContain(proseSummary);
    });

    it('fires at most once per task — second text-only retry falls through', async () => {
      const firstProse = 'I will create the migration file by writing SQL CREATE TABLE statements directly in the response without tools.';
      const secondProse = 'Sorry, I cannot use tools right now. Here is the SQL you need: CREATE TABLE foo (id INT, name TEXT NOT NULL);';
      expect(firstProse.length).toBeGreaterThan(50);
      expect(secondProse.length).toBeGreaterThan(50);

      const adapter = createAdapter([
        // iter 0: prose — validator fires
        textResponse(firstProse),
        // iter 0 retry: more prose — validator must NOT fire again; falls through to final
        textResponse(secondProse),
      ]);
      const toolExecutor = createToolExecutor();

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Create migration.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      // Adapter called exactly twice — no third retry attempt
      expect(adapter.chatCompletion).toHaveBeenCalledTimes(2);
      // Exactly ONE corrective prompt across all calls' messages
      const allMessages = adapter.chatCompletion.mock.calls.flatMap((c) => c[0].messages);
      const correctiveCount = allMessages.filter(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(CORRECTIVE_REPROMPT_FRAGMENT)
      ).length;
      expect(correctiveCount).toBe(1);
      // Final output is the second prose response (validator's retry, not third)
      expect(result.output).toContain(secondProse);
    });
  });

  describe('Integration — small-model robustness composition', () => {
    // Each test composes 2+ of the Task 1-5 fixes in a single runAgenticLoop run.
    // Uses the same vi.resetModules() + dynamic-import harness as Fix #3 and Fix #1B
    // (handled by the top-level beforeEach which resets modules and re-imports).

    const CORRECTIVE_REPROMPT_FRAGMENT = 'Your previous response had no tool calls';

    function messagesContainCorrectivePrompt(messages) {
      return messages.some(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(CORRECTIVE_REPROMPT_FRAGMENT)
      );
    }

    it('Scenario A: markdown-then-recovery — model produces prose on iter 0, validator nudges, model tool_calls, completes', async () => {
      // Composes: Fix #1B (first-iter validator) + Fix #4 (few-shot system prompt / normal agentic flow)
      //
      // Adapter sequence:
      //   call 1 (iter 0): long prose text-only — validator fires, sends corrective reprompt
      //   call 2 (iter 0 retry): tool call (write_file) — succeeds
      //   call 3 (iter 1): final text "Done. Created m.sql."
      const longProse = "I'll create the migration. Here is the SQL:\n```sql\nCREATE TABLE x (id INTEGER PRIMARY KEY);\n```\nThat's the schema definition for the new table.";
      expect(longProse.length).toBeGreaterThan(50);

      const adapter = createAdapter([
        textResponse(longProse),
        toolResponse({ name: 'write_file', arguments: { path: 'm.sql', content: 'CREATE TABLE x (id INTEGER PRIMARY KEY);' } }),
        textResponse('Done. Created m.sql.'),
      ]);
      const toolExecutor = createToolExecutor((name, args, changedFiles) => {
        if (name === 'write_file') changedFiles.add(args.path);
        return { result: `${name} completed for ${args.path}` };
      });

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Create the migration file at m.sql.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      // Task completes normally — not stopped by error guard
      expect(result.stopReason).not.toBe('consecutive_tool_errors');
      // Final output contains the completion message from iter 1
      expect(result.output).toContain('Done. Created m.sql.');
      // The write_file call is in the toolLog — exactly 1 tool call executed
      expect(result.toolLog).toHaveLength(1);
      expect(result.toolLog[0].name).toBe('write_file');
      // The 2nd adapter call (the retry) must have the corrective prompt in its messages
      const retryMessages = adapter.chatCompletion.mock.calls[1][0].messages;
      expect(messagesContainCorrectivePrompt(retryMessages)).toBe(true);
      // 3 adapter calls total: iter-0 prose, iter-0 retry with tool, iter-1 final
      expect(adapter.chatCompletion).toHaveBeenCalledTimes(3);
    });

    it('Scenario B: allowlist-recovery — model uses cat (rejected with suggestion), then read_file (success), counter not incremented', async () => {
      // Composes: Task 2 (allowlist rejection + suggestion) + Task 3 (counter skip on _allowlist_rejection)
      //
      // Adapter sequence:
      //   iter 0: run_command 'cat src/foo.js' — executor returns _allowlist_rejection (counter stays at 0)
      //   iter 1: read_file 'src/foo.js' — succeeds
      //   iter 2: final text summarizing findings
      const adapter = createAdapter([
        toolResponse({ name: 'run_command', arguments: { command: 'cat src/foo.js' } }),
        toolResponse({ name: 'read_file', arguments: { path: 'src/foo.js' } }),
        textResponse('Read foo.js — it has a default export and 3 helpers.'),
      ]);
      const toolExecutor = createToolExecutor((name, args) => {
        if (name === 'run_command' && args.command === 'cat src/foo.js') {
          return {
            result: 'Error: Command not in allowlist: cat src/foo.js — use read_file({path}) instead',
            error: true,
            _allowlist_rejection: true,
          };
        }
        if (name === 'read_file' && args.path === 'src/foo.js') {
          return { result: '1\texport default function foo() {}\n' };
        }
        return { result: 'ok' };
      });

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Read and describe src/foo.js.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      // The allowlist rejection did NOT increment the consecutive-error counter — no early stop
      expect(result.stopReason).not.toBe('consecutive_tool_errors');
      // Final output contains the successful summary
      expect(result.output).toContain('Read foo.js');
      // Two tool entries: the rejected run_command + the successful read_file
      expect(result.toolLog).toHaveLength(2);
      expect(result.toolLog[0].name).toBe('run_command');
      expect(result.toolLog[0].error).toBe(true);
      expect(result.toolLog[1].name).toBe('read_file');
      expect(result.toolLog[1].error).toBe(false);
      // The tool result message for the first call contains the suggestion text
      const allMessages = adapter.chatCompletion.mock.calls.flatMap((c) => c[0].messages);
      const toolResultMessages = allMessages.filter((m) => m.role === 'tool');
      expect(toolResultMessages.some((m) => m.content.includes('use read_file'))).toBe(true);
    });

    it('Scenario C: relaxed early-stop — 2 same-tool errors do NOT bail; 3rd error triggers stop', async () => {
      // Composes: Task 3 (threshold 2→3 for consecutive errors)
      //
      // Adapter sequence:
      //   iter 0: read_file bad0.js — ENOENT error (counter=1)
      //   iter 1: read_file bad1.js — ENOENT error (counter=2, threshold NOT hit)
      //   iter 2: read_file bad2.js — ENOENT error (counter=3, threshold HIT — early stop)
      //   iter 3: 'shouldnt-reach' — must NOT be called
      const adapter = createAdapter([
        toolResponse({ name: 'read_file', arguments: { path: 'bad0.js' } }),
        toolResponse({ name: 'read_file', arguments: { path: 'bad1.js' } }),
        toolResponse({ name: 'read_file', arguments: { path: 'bad2.js' } }),
        textResponse('shouldnt-reach'),
      ]);
      const toolExecutor = createToolExecutor((_name, args) => ({
        result: `Error: ENOENT: no such file or directory, open '${args.path}'`,
        error: true,
      }));

      const result = await runAgenticLoop({
        adapter,
        systemPrompt: 'System prompt',
        taskPrompt: 'Read the specified files.',
        tools: TOOL_DEFINITIONS,
        toolExecutor,
        maxIterations: 10,
      });

      // Stopped by the consecutive error guard
      expect(result.stopReason).toBe('consecutive_tool_errors');
      // Output mentions the tool name and iteration count
      expect(result.output).toContain('consecutive errors from read_file');
      // The threshold is 3 iterations (not the old 2)
      expect(result.output).toContain('after 3 iterations');
      // Exactly 3 read_file error entries in the toolLog
      expect(result.toolLog).toHaveLength(3);
      expect(result.toolLog.every((entry) => entry.name === 'read_file' && entry.error)).toBe(true);
      // The 4th adapter response ('shouldnt-reach') must NOT have been used
      // — adapter should have been called exactly 3 times (one per iteration)
      expect(adapter.chatCompletion).toHaveBeenCalledTimes(3);
    });
  });
});
