# Fabro #78: OpenTelemetry-Native Observability (Phoenix)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Emit TORQUE's execution telemetry as **OpenTelemetry spans** using **OpenInference semantic conventions** — typed span kinds `LLM`, `RETRIEVER`, `TOOL`, `AGENT`, `CHAIN`, `EMBEDDING`, `RERANKER`, `EVALUATOR` with their standard attributes. Makes TORQUE data viewable in any OTLP-compatible backend (Phoenix, Jaeger, Tempo, Langfuse, cloud APMs) and enables **auto-instrumentation** for external frameworks (LangChain, LlamaIndex, DSPy) that already emit OpenInference spans. Inspired by Arize Phoenix.

**Architecture:** A new `telemetry-emitter.js` wraps Plan 29 journal writes with parallel OTEL span emission via `@opentelemetry/api`. A configurable OTLP exporter (`OTEL_EXPORTER_OTLP_ENDPOINT`) ships spans to any collector. Each journal event type maps to an OpenInference span kind. Task start opens a span; task completion closes it; provider calls are child spans with `llm.*` attributes; tool calls with `tool.*`; memory lookups with `retrieval.*`. No change to Plan 29's local model — this is an additional emission path.

**Tech Stack:** `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`, OpenInference semantic conventions. Builds on plans 29 (journal), 46 (trace), 68 (observability platform).

---

## File Structure

**New files:**
- `server/telemetry/otel-init.js` — SDK setup
- `server/telemetry/semantic-conventions.js` — OpenInference attribute names
- `server/telemetry/span-mapper.js` — TORQUE event → OTEL span
- `server/telemetry/telemetry-emitter.js` — main emit API
- `server/tests/span-mapper.test.js`
- `server/tests/telemetry-emitter.test.js`

**Modified files:**
- `server/index.js` — init OTEL SDK at startup
- `server/journal/journal-writer.js` — dual-emit to journal + telemetry
- `server/execution/task-startup.js` — open/close task span

---

## Task 1: Semantic conventions + span mapper

- [ ] **Step 1: Constants**

Create `server/telemetry/semantic-conventions.js`:

```js
'use strict';

// OpenInference semantic conventions for LLM telemetry.
// Mirrors https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
const SpanKind = {
  LLM: 'LLM',
  RETRIEVER: 'RETRIEVER',
  TOOL: 'TOOL',
  AGENT: 'AGENT',
  CHAIN: 'CHAIN',
  EMBEDDING: 'EMBEDDING',
  RERANKER: 'RERANKER',
  EVALUATOR: 'EVALUATOR',
  GUARDRAIL: 'GUARDRAIL',
};

const Attrs = {
  // Common
  SESSION_ID:     'session.id',
  USER_ID:        'user.id',
  INPUT_VALUE:    'input.value',
  OUTPUT_VALUE:   'output.value',

  // LLM
  LLM_MODEL:            'llm.model_name',
  LLM_PROVIDER:         'llm.provider',
  LLM_TEMPERATURE:      'llm.invocation_parameters',
  LLM_PROMPT_TEMPLATE:  'llm.prompt_template.template',
  LLM_PROMPT_TOKENS:    'llm.token_count.prompt',
  LLM_COMPLETION_TOKENS:'llm.token_count.completion',
  LLM_TOTAL_TOKENS:     'llm.token_count.total',

  // Tool
  TOOL_NAME:        'tool.name',
  TOOL_PARAMETERS:  'tool.parameters',

  // Retrieval
  RETRIEVAL_QUERY:     'retrieval.query',
  RETRIEVAL_DOCUMENTS: 'retrieval.documents',

  // Evaluator
  EVAL_LABEL:       'eval.label',
  EVAL_SCORE:       'eval.score',
  EVAL_EXPLANATION: 'eval.explanation',

  // OpenInference convention marker
  OPENINFERENCE_SPAN_KIND: 'openinference.span.kind',
};

module.exports = { SpanKind, Attrs };
```

- [ ] **Step 2: Span mapper tests**

Create `server/tests/span-mapper.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { mapEventToSpan } = require('../telemetry/span-mapper');

describe('mapEventToSpan', () => {
  it('task_started → AGENT span with input', () => {
    const span = mapEventToSpan({
      event_type: 'task_started',
      task_id: 't1', workflow_id: 'wf1',
      payload: { task_description: 'do the thing' },
    });
    expect(span.name).toBe('task.run');
    expect(span.attributes['openinference.span.kind']).toBe('AGENT');
    expect(span.attributes['input.value']).toBe('do the thing');
    expect(span.attributes['torque.task_id']).toBe('t1');
  });

  it('provider call → LLM span with model attributes', () => {
    const span = mapEventToSpan({
      event_type: 'activity_started',
      task_id: 't1',
      payload: { kind: 'provider', name: 'codex.runPrompt', input: { prompt: 'hi', model: 'gpt-5.3' } },
    });
    expect(span.attributes['openinference.span.kind']).toBe('LLM');
    expect(span.attributes['llm.model_name']).toBe('gpt-5.3');
    expect(span.attributes['input.value']).toBe('hi');
  });

  it('tool call → TOOL span with tool.name + parameters', () => {
    const span = mapEventToSpan({
      event_type: 'activity_started',
      payload: { kind: 'mcp_tool', name: 'search_memory', input: { query: 'postgres' } },
    });
    expect(span.attributes['openinference.span.kind']).toBe('TOOL');
    expect(span.attributes['tool.name']).toBe('search_memory');
    expect(span.attributes['tool.parameters']).toBeDefined();
  });

  it('retrieval → RETRIEVER span', () => {
    const span = mapEventToSpan({
      event_type: 'memory_retrieved',
      payload: { query: 'db preference', results: [{ content: 'Postgres' }] },
    });
    expect(span.attributes['openinference.span.kind']).toBe('RETRIEVER');
    expect(span.attributes['retrieval.query']).toBe('db preference');
  });

  it('score_recorded → EVALUATOR span', () => {
    const span = mapEventToSpan({
      event_type: 'score_recorded',
      payload: { name: 'faithfulness', value: 0.82, rationale: 'accurate' },
    });
    expect(span.attributes['openinference.span.kind']).toBe('EVALUATOR');
    expect(span.attributes['eval.label']).toBe('faithfulness');
    expect(span.attributes['eval.score']).toBe(0.82);
  });

  it('unknown event returns null', () => {
    expect(mapEventToSpan({ event_type: 'custom_internal_thing' })).toBeNull();
  });
});
```

- [ ] **Step 3: Implement mapper**

Create `server/telemetry/span-mapper.js`:

```js
'use strict';
const { SpanKind, Attrs } = require('./semantic-conventions');

function mapEventToSpan(event) {
  const payload = event.payload || {};
  switch (event.event_type) {
    case 'task_started':
    case 'task_completed':
    case 'task_failed':
      return {
        name: 'task.run',
        attributes: {
          [Attrs.OPENINFERENCE_SPAN_KIND]: SpanKind.AGENT,
          [Attrs.INPUT_VALUE]: payload.task_description,
          [Attrs.OUTPUT_VALUE]: payload.output,
          'torque.task_id': event.task_id,
          'torque.workflow_id': event.workflow_id,
        },
      };
    case 'activity_started':
    case 'activity_completed': {
      const kind = payload.kind;
      if (kind === 'provider') {
        return {
          name: payload.name || 'llm.call',
          attributes: {
            [Attrs.OPENINFERENCE_SPAN_KIND]: SpanKind.LLM,
            [Attrs.LLM_MODEL]: payload.input?.model || payload.model,
            [Attrs.LLM_PROVIDER]: payload.provider,
            [Attrs.INPUT_VALUE]: payload.input?.prompt,
            [Attrs.OUTPUT_VALUE]: payload.output,
            [Attrs.LLM_PROMPT_TOKENS]: payload.tokens?.prompt,
            [Attrs.LLM_COMPLETION_TOKENS]: payload.tokens?.completion,
          },
        };
      }
      if (kind === 'mcp_tool') {
        return {
          name: payload.name || 'tool.call',
          attributes: {
            [Attrs.OPENINFERENCE_SPAN_KIND]: SpanKind.TOOL,
            [Attrs.TOOL_NAME]: payload.name,
            [Attrs.TOOL_PARAMETERS]: payload.input ? JSON.stringify(payload.input) : undefined,
            [Attrs.INPUT_VALUE]: payload.input ? JSON.stringify(payload.input) : undefined,
            [Attrs.OUTPUT_VALUE]: payload.output,
          },
        };
      }
      if (kind === 'verify') {
        return { name: 'verify', attributes: { [Attrs.OPENINFERENCE_SPAN_KIND]: SpanKind.CHAIN } };
      }
      return { name: payload.name || kind || 'activity', attributes: {} };
    }
    case 'memory_retrieved':
      return {
        name: 'memory.retrieve',
        attributes: {
          [Attrs.OPENINFERENCE_SPAN_KIND]: SpanKind.RETRIEVER,
          [Attrs.RETRIEVAL_QUERY]: payload.query,
          [Attrs.RETRIEVAL_DOCUMENTS]: payload.results ? JSON.stringify(payload.results.slice(0, 10)) : undefined,
        },
      };
    case 'score_recorded':
      return {
        name: `eval.${payload.name}`,
        attributes: {
          [Attrs.OPENINFERENCE_SPAN_KIND]: SpanKind.EVALUATOR,
          [Attrs.EVAL_LABEL]: payload.name,
          [Attrs.EVAL_SCORE]: payload.value,
          [Attrs.EVAL_EXPLANATION]: payload.rationale,
        },
      };
    default:
      return null;
  }
}

module.exports = { mapEventToSpan };
```

Run tests → PASS. Commit: `feat(otel): semantic conventions + event-to-span mapper`.

---

## Task 2: Emitter + SDK init

- [ ] **Step 1: Tests**

Create `server/tests/telemetry-emitter.test.js`:

```js
'use strict';
const { describe, it, expect, vi, beforeEach } = require('vitest');
const { createTelemetryEmitter } = require('../telemetry/telemetry-emitter');

describe('telemetryEmitter', () => {
  let tracerMock, emitter;
  beforeEach(() => {
    const spanMock = { setAttribute: vi.fn(), end: vi.fn(), setStatus: vi.fn() };
    tracerMock = {
      startSpan: vi.fn(() => spanMock),
    };
    emitter = createTelemetryEmitter({ tracer: tracerMock });
  });

  it('emit opens and closes a span for mappable events', () => {
    emitter.emit({ event_type: 'task_started', task_id: 't1', payload: { task_description: 'x' } });
    emitter.emit({ event_type: 'task_completed', task_id: 't1', payload: { output: 'y' } });
    expect(tracerMock.startSpan).toHaveBeenCalledTimes(1);
  });

  it('skips emission for unmappable events', () => {
    emitter.emit({ event_type: 'internal_noise' });
    expect(tracerMock.startSpan).not.toHaveBeenCalled();
  });

  it('failure sets span status to ERROR', () => {
    const events = [
      { event_type: 'task_started', task_id: 't1', payload: {} },
      { event_type: 'task_failed',  task_id: 't1', payload: { error: 'boom' } },
    ];
    const spanMock = { setAttribute: vi.fn(), end: vi.fn(), setStatus: vi.fn() };
    tracerMock.startSpan.mockReturnValue(spanMock);
    emitter.emit(events[0]);
    emitter.emit(events[1]);
    expect(spanMock.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: 2 /* ERROR */ }));
  });
});
```

- [ ] **Step 2: Implement**

Create `server/telemetry/telemetry-emitter.js`:

```js
'use strict';
const { mapEventToSpan } = require('./span-mapper');

function createTelemetryEmitter({ tracer, logger = console }) {
  const openSpans = new Map(); // key: task_id or activity_id

  function keyFor(event) {
    return event.payload?.activity_id || event.task_id || null;
  }

  function emit(event) {
    try {
      const k = keyFor(event);
      if (event.event_type.endsWith('_started') || event.event_type === 'memory_retrieved' || event.event_type === 'score_recorded') {
        const spec = mapEventToSpan(event);
        if (!spec) return;
        const span = tracer.startSpan(spec.name, { attributes: filterUndefined(spec.attributes) });
        if (k) openSpans.set(k, span);
        // For one-shot events (retrieval, score) end immediately
        if (event.event_type === 'memory_retrieved' || event.event_type === 'score_recorded') {
          span.end();
          if (k) openSpans.delete(k);
        }
      } else if (event.event_type.endsWith('_completed') || event.event_type.endsWith('_failed') || event.event_type.endsWith('_cancelled')) {
        if (k && openSpans.has(k)) {
          const span = openSpans.get(k);
          const spec = mapEventToSpan(event);
          if (spec) {
            for (const [attr, val] of Object.entries(filterUndefined(spec.attributes))) {
              span.setAttribute(attr, val);
            }
          }
          if (event.event_type.endsWith('_failed')) {
            span.setStatus({ code: 2, message: event.payload?.error || 'failed' });
          }
          span.end();
          openSpans.delete(k);
        }
      }
    } catch (err) {
      logger.warn?.('telemetry emit failed', err);
    }
  }

  return { emit };
}

function filterUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

module.exports = { createTelemetryEmitter };
```

- [ ] **Step 3: SDK init**

Create `server/telemetry/otel-init.js`:

```js
'use strict';

function initOtel() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;

  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { Resource } = require('@opentelemetry/resources');
  const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
  const { trace } = require('@opentelemetry/api');

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'torque',
      [SemanticResourceAttributes.SERVICE_VERSION]: require('../../package.json').version,
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint + '/v1/traces' }),
  });
  sdk.start();
  return { tracer: trace.getTracer('torque'), sdk };
}

module.exports = { initOtel };
```

Run tests → PASS. Commit: `feat(otel): SDK init + emitter with task/activity span lifecycle`.

---

## Task 3: Wire into journal + MCP tool

- [ ] **Step 1: Dual-emit from journal**

In `server/journal/journal-writer.js`, after writing to the journal table:

```js
const emitter = this.telemetryEmitter || null;
if (emitter) emitter.emit({ event_id: eventId, event_type: type, task_id: taskId, workflow_id: workflowId, payload });
```

Pass the emitter via container factory. In `server/index.js`:

```js
const { initOtel } = require('./telemetry/otel-init');
const otel = initOtel();
if (otel) {
  const { createTelemetryEmitter } = require('./telemetry/telemetry-emitter');
  defaultContainer.set('telemetryEmitter', createTelemetryEmitter({ tracer: otel.tracer, logger }));
}
```

- [ ] **Step 2: MCP tool**

```js
otel_status: {
  description: 'Check OpenTelemetry configuration + emission state.',
  inputSchema: { type: 'object', properties: {} },
},
```

Handler returns `{ enabled, endpoint, spans_emitted_last_minute }`.

`await_restart`. Smoke: set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006` (Phoenix's default). Run Phoenix locally (`docker run -p 6006:6006 arizephoenix/phoenix`). Submit a task, open Phoenix UI, confirm spans appear with `openinference.span.kind` attribute and correct LLM/TOOL/AGENT types.

Commit: `feat(otel): dual-emit journal + spans to OTLP endpoint`.
