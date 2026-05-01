# Fabro #83: Unified Streaming Kernel (Vercel AI SDK)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce one **streaming kernel** — `streamRun({ prompt, tools, provider, maxSteps })` that emits a typed event stream: `text_delta`, `tool_call`, `tool_result`, `step_started`, `step_completed`, `usage`, `done`. Replaces ad hoc per-provider streaming code with a single primitive that powers: dashboard live view, Plan 46 trace waterfall, Plan 57 Agent Protocol, MCP streaming. Inspired by Vercel AI SDK's `streamText`.

**Architecture:** A new `server/streaming/stream-run.js` wraps provider dispatch. It returns an async iterator of typed events. Tool calls are routed to registered handlers; results flow back as `tool_result` events. A bounded step loop (default `maxSteps: 20`) handles multi-step tool use. Each event carries `token_usage` and `duration_ms`. Adapters translate to SSE (REST), Agent Protocol step chunks, and Plan 46 trace entries.

**Tech Stack:** Node.js streams + async iterators, existing provider dispatch. Builds on plans 23 (typed signatures), 46 (trace), 57 (agent protocol), 59 (validators), 76 (code agent).

---

## File Structure

**New files:**
- `server/streaming/stream-run.js` — main kernel
- `server/streaming/event-types.js` — typed event catalog
- `server/streaming/sse-adapter.js` — converts stream → SSE
- `server/streaming/trace-adapter.js` — converts stream → Plan 46 entries
- `server/tests/stream-run.test.js`
- `server/tests/sse-adapter.test.js`

**Modified files:**
- `server/handlers/task/submit.js` — accept `stream: true`
- `server/api/routes/tasks.js` — expose `GET /api/tasks/:id/stream` as SSE

---

## Task 1: Event types + kernel

- [ ] **Step 1: Event types**

Create `server/streaming/event-types.js`:

```js
'use strict';

// All possible events emitted by stream-run. Each has a type tag + shared fields.
const EventType = {
  RUN_STARTED:    'run_started',
  STEP_STARTED:   'step_started',
  TEXT_DELTA:     'text_delta',        // { delta: 'partial text' }
  TOOL_CALL:      'tool_call',         // { tool_call_id, name, args }
  TOOL_RESULT:    'tool_result',       // { tool_call_id, result, error? }
  STEP_COMPLETED: 'step_completed',    // { step, finish_reason }
  USAGE:          'usage',             // { prompt_tokens, completion_tokens, total_tokens }
  ERROR:          'error',
  DONE:           'done',              // terminal
};

module.exports = { EventType };
```

- [ ] **Step 2: Tests**

Create `server/tests/stream-run.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { streamRun } = require('../streaming/stream-run');
const { EventType } = require('../streaming/event-types');

async function collect(iter) {
  const events = [];
  for await (const e of iter) events.push(e);
  return events;
}

describe('streamRun', () => {
  it('single-turn text response → text_delta + done', async () => {
    const callProvider = vi.fn(async function* () {
      yield { type: 'text_delta', delta: 'Hel' };
      yield { type: 'text_delta', delta: 'lo' };
      yield { type: 'step_completed', finish_reason: 'stop' };
      yield { type: 'usage', prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
    });
    const events = await collect(streamRun({ prompt: 'hi', tools: {}, callProvider }));
    const types = events.map(e => e.type);
    expect(types).toContain(EventType.TEXT_DELTA);
    expect(types[types.length - 1]).toBe(EventType.DONE);
  });

  it('tool call → tool_call event + invokes handler → tool_result event', async () => {
    const callProvider = vi.fn(async function* ({ messages }) {
      if (messages.length === 1) {
        yield { type: 'tool_call', tool_call_id: 'tc1', name: 'search', args: { q: 'x' } };
        yield { type: 'step_completed', finish_reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', delta: 'Got 3 results' };
        yield { type: 'step_completed', finish_reason: 'stop' };
      }
    });
    const tools = {
      search: { handler: vi.fn(async ({ q }) => ({ count: 3 })) },
    };
    const events = await collect(streamRun({ prompt: 'search x', tools, callProvider, maxSteps: 5 }));
    const types = events.map(e => e.type);
    expect(types).toContain(EventType.TOOL_CALL);
    expect(types).toContain(EventType.TOOL_RESULT);
    expect(tools.search.handler).toHaveBeenCalledWith({ q: 'x' });
  });

  it('stops at maxSteps even if model keeps calling tools', async () => {
    const callProvider = vi.fn(async function* () {
      yield { type: 'tool_call', tool_call_id: `tc${Math.random()}`, name: 'loop', args: {} };
      yield { type: 'step_completed', finish_reason: 'tool_calls' };
    });
    const tools = { loop: { handler: vi.fn(async () => ({ ok: true })) } };
    const events = await collect(streamRun({ prompt: 'x', tools, callProvider, maxSteps: 3 }));
    const stepStarts = events.filter(e => e.type === EventType.STEP_STARTED).length;
    expect(stepStarts).toBeLessThanOrEqual(3);
    expect(events[events.length - 1].type).toBe(EventType.DONE);
  });

  it('tool handler error → tool_result with error, loop continues', async () => {
    let step = 0;
    const callProvider = vi.fn(async function* () {
      step++;
      if (step === 1) {
        yield { type: 'tool_call', tool_call_id: 'tc1', name: 'bad', args: {} };
        yield { type: 'step_completed', finish_reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', delta: 'Recovered' };
        yield { type: 'step_completed', finish_reason: 'stop' };
      }
    });
    const tools = { bad: { handler: vi.fn(async () => { throw new Error('boom'); }) } };
    const events = await collect(streamRun({ prompt: 'x', tools, callProvider, maxSteps: 5 }));
    const toolResult = events.find(e => e.type === EventType.TOOL_RESULT);
    expect(toolResult.error).toMatch(/boom/);
    const text = events.find(e => e.type === EventType.TEXT_DELTA);
    expect(text.delta).toBe('Recovered');
  });
});
```

- [ ] **Step 3: Implement**

Create `server/streaming/stream-run.js`:

```js
'use strict';
const { EventType } = require('./event-types');

async function* streamRun({ prompt, tools = {}, callProvider, maxSteps = 20, systemPrompt = null, logger = console }) {
  yield { type: EventType.RUN_STARTED, prompt };

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  for (let step = 1; step <= maxSteps; step++) {
    yield { type: EventType.STEP_STARTED, step };

    let finishReason = 'stop';
    const pendingToolCalls = [];
    let assistantText = '';

    try {
      for await (const chunk of callProvider({ messages, tools })) {
        if (chunk.type === 'text_delta') {
          assistantText += chunk.delta;
          yield { type: EventType.TEXT_DELTA, delta: chunk.delta, step };
        } else if (chunk.type === 'tool_call') {
          pendingToolCalls.push(chunk);
          yield { type: EventType.TOOL_CALL, tool_call_id: chunk.tool_call_id, name: chunk.name, args: chunk.args, step };
        } else if (chunk.type === 'usage') {
          yield { type: EventType.USAGE, ...chunk, step };
        } else if (chunk.type === 'step_completed') {
          finishReason = chunk.finish_reason;
        }
      }
    } catch (err) {
      yield { type: EventType.ERROR, error: err.message, step };
      yield { type: EventType.DONE, reason: 'error' };
      return;
    }

    if (assistantText) messages.push({ role: 'assistant', content: assistantText });

    if (pendingToolCalls.length > 0) {
      messages.push({ role: 'assistant', content: assistantText, tool_calls: pendingToolCalls });
      for (const call of pendingToolCalls) {
        const tool = tools[call.name];
        if (!tool || !tool.handler) {
          yield { type: EventType.TOOL_RESULT, tool_call_id: call.tool_call_id, error: `unknown tool: ${call.name}`, step };
          messages.push({ role: 'tool', tool_call_id: call.tool_call_id, content: JSON.stringify({ error: `unknown tool: ${call.name}` }) });
          continue;
        }
        try {
          const result = await tool.handler(call.args);
          yield { type: EventType.TOOL_RESULT, tool_call_id: call.tool_call_id, result, step };
          messages.push({ role: 'tool', tool_call_id: call.tool_call_id, content: JSON.stringify(result) });
        } catch (err) {
          yield { type: EventType.TOOL_RESULT, tool_call_id: call.tool_call_id, error: err.message, step };
          messages.push({ role: 'tool', tool_call_id: call.tool_call_id, content: JSON.stringify({ error: err.message }) });
        }
      }
    }

    yield { type: EventType.STEP_COMPLETED, step, finish_reason: finishReason };

    if (finishReason === 'stop' || pendingToolCalls.length === 0) break;
  }

  yield { type: EventType.DONE, reason: 'completed' };
}

module.exports = { streamRun };
```

Run tests → PASS. Commit: `feat(streaming): stream-run kernel with tool loop + max-steps guard`.

---

## Task 2: SSE + trace adapters + REST endpoint

- [ ] **Step 1: SSE adapter tests**

Create `server/tests/sse-adapter.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { streamToSse } = require('../streaming/sse-adapter');

describe('streamToSse', () => {
  it('emits one SSE frame per event', async () => {
    async function* gen() {
      yield { type: 'text_delta', delta: 'hi' };
      yield { type: 'done' };
    }
    const res = { write: vi.fn(), end: vi.fn() };
    await streamToSse(gen(), res);
    const writes = res.write.mock.calls.map(c => c[0]);
    expect(writes[0]).toMatch(/event: text_delta/);
    expect(writes[0]).toMatch(/data: {"type":"text_delta","delta":"hi"}/);
    expect(res.end).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

Create `server/streaming/sse-adapter.js`:

```js
'use strict';

async function streamToSse(iter, res) {
  res.setHeader?.('Content-Type', 'text/event-stream');
  res.setHeader?.('Cache-Control', 'no-cache');
  res.setHeader?.('Connection', 'keep-alive');
  for await (const ev of iter) {
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    if (ev.type === 'done' || ev.type === 'error') break;
  }
  res.end();
}

module.exports = { streamToSse };
```

Create `server/streaming/trace-adapter.js` — forwards stream events to Plan 46 trace with appropriate span mappings.

- [ ] **Step 3: REST endpoint**

In `server/api/routes/tasks.js`:

```js
router.get('/:id/stream', async (req, res) => {
  const task = defaultContainer.get('db').prepare('SELECT * FROM tasks WHERE task_id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const { streamRun } = require('../../streaming/stream-run');
  const { streamToSse } = require('../../streaming/sse-adapter');
  const provider = defaultContainer.get('providerRegistry').getProviderInstance(task.provider);
  await streamToSse(streamRun({
    prompt: task.task_description,
    tools: buildToolSurface(task),
    callProvider: provider.streamChunks.bind(provider),
  }), res);
});
```

Each provider adapter needs a `streamChunks({ messages, tools })` async generator yielding chunks in the event-types shape. Where providers only support blocking calls, a wrapper yields a single `text_delta` + `step_completed`.

`await_restart`. Smoke: `curl -N http://localhost:3457/api/tasks/<id>/stream`. Confirm SSE events stream in order: run_started → step_started → text_delta(s) → step_completed → done.

Commit: `feat(streaming): SSE + trace adapters + REST /stream endpoint`.
