'use strict';

/**
 * agentic-adapters.test.js — Tests for the agentic chat adapter suite
 *
 * Task 2: Ollama chat adapter (ollama-chat.js)
 * Tasks 3 & 4 will append their describe blocks to this file.
 */

const http = require('http');
const { chatCompletion } = require('../providers/adapters/ollama-chat');

// ---------------------------------------------------------------------------
// Mock server helpers
// ---------------------------------------------------------------------------

/**
 * Write a sequence of NDJSON lines to a response, then end it.
 * @param {http.ServerResponse} res
 * @param {Array<Object>} lines - Objects that will each be JSON-stringified on their own line
 */
function writeNdjson(res, lines) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const obj of lines) {
    res.write(JSON.stringify(obj) + '\n');
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Ollama chat adapter — describe block
// ---------------------------------------------------------------------------

describe('ollama-chat adapter — chatCompletion', () => {
  let server;
  let host;
  /** Mutable handler — each test sets this to control the mock server's behaviour. */
  let requestHandler;

  beforeAll(() => new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        req._parsedBody = body ? JSON.parse(body) : null;
        if (requestHandler) {
          requestHandler(req, res);
        } else {
          res.writeHead(500);
          res.end('No handler set');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      host = `http://127.0.0.1:${port}`;
      resolve();
    });
  }));

  afterAll(() => new Promise((resolve) => {
    server.close(resolve);
  }));

  // Reset between tests
  afterEach(() => {
    requestHandler = null;
  });

  // -------------------------------------------------------------------------
  // Test 1: sends chat request with tools, parses NDJSON, returns message
  // -------------------------------------------------------------------------

  it('sends chat request with tools and parses NDJSON tool-call response', async () => {
    const toolCallChunk = {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'read_file',
              arguments: { path: 'src/index.js' },
            },
          },
        ],
      },
      done: false,
    };
    const doneChunk = {
      done: true,
      done_reason: 'tool_calls',
      prompt_eval_count: 42,
      eval_count: 18,
    };

    requestHandler = (req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/chat');
      const body = req._parsedBody;
      expect(body.model).toBe('qwen2.5-coder:7b');
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.stream).toBe(true);
      expect(body.think).toBe(false);
      writeNdjson(res, [toolCallChunk, doneChunk]);
    };

    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ];

    const result = await chatCompletion({
      host,
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'Read src/index.js' }],
      tools,
    });

    expect(result.message.role).toBe('assistant');
    expect(Array.isArray(result.message.tool_calls)).toBe(true);
    expect(result.message.tool_calls).toHaveLength(1);
    expect(result.message.tool_calls[0].function.name).toBe('read_file');
    expect(result.message.tool_calls[0].function.arguments).toEqual({ path: 'src/index.js' });
  });

  // -------------------------------------------------------------------------
  // Test 2: normalises prompt_eval_count / eval_count to prompt_tokens / completion_tokens
  // -------------------------------------------------------------------------

  it('normalises prompt_eval_count and eval_count to prompt_tokens and completion_tokens', async () => {
    requestHandler = (req, res) => {
      writeNdjson(res, [
        { message: { role: 'assistant', content: 'Hello' }, done: false },
        { done: true, done_reason: 'stop', prompt_eval_count: 123, eval_count: 77 },
      ]);
    };

    const result = await chatCompletion({
      host,
      model: 'llama3.2:3b',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.usage).toBeDefined();
    expect(result.usage.prompt_tokens).toBe(123);
    expect(result.usage.completion_tokens).toBe(77);
  });

  // -------------------------------------------------------------------------
  // Test 3: handles response with no tool calls (plain text completion)
  // -------------------------------------------------------------------------

  it('handles plain text completion with no tool calls', async () => {
    requestHandler = (req, res) => {
      writeNdjson(res, [
        { message: { role: 'assistant', content: 'The answer is ' }, done: false },
        { message: { role: 'assistant', content: '42.' }, done: false },
        { done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 },
      ]);
    };

    const result = await chatCompletion({
      host,
      model: 'llama3.2:3b',
      messages: [{ role: 'user', content: 'What is the meaning of life?' }],
    });

    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toBe('The answer is 42.');
    expect(result.message.tool_calls).toBeUndefined();
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Test 4: apiKey is ignored (does not cause errors)
  // -------------------------------------------------------------------------

  it('accepts apiKey parameter without error (Ollama does not use API keys)', async () => {
    requestHandler = (req, res) => {
      writeNdjson(res, [
        { message: { role: 'assistant', content: 'ok' }, done: false },
        { done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 },
      ]);
    };

    const result = await chatCompletion({
      host,
      apiKey: 'should-be-ignored',
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(result.message.content).toBe('ok');
  });

  // -------------------------------------------------------------------------
  // Test 5: onChunk callback receives streamed text
  // -------------------------------------------------------------------------

  it('calls onChunk for each streamed text chunk', async () => {
    requestHandler = (req, res) => {
      writeNdjson(res, [
        { message: { role: 'assistant', content: 'chunk1 ' }, done: false },
        { message: { role: 'assistant', content: 'chunk2' }, done: false },
        { done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 3 },
      ]);
    };

    const chunks = [];
    await chatCompletion({
      host,
      model: 'llama3.2:3b',
      messages: [{ role: 'user', content: 'stream test' }],
      onChunk: (text) => chunks.push(text),
    });

    expect(chunks).toEqual(['chunk1 ', 'chunk2']);
  });

  // -------------------------------------------------------------------------
  // Test 6: AbortSignal cancels in-flight request
  // -------------------------------------------------------------------------

  it('rejects when AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    // With an already-aborted signal the request will be destroyed immediately —
    // we just need to confirm the promise rejects (the error message varies by
    // Node version, so we don't assert on the exact text).
    await expect(
      chatCompletion({
        host,
        model: 'llama3.2:3b',
        messages: [{ role: 'user', content: 'never' }],
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });
});
