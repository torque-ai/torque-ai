'use strict';

const { randomUUID } = require('crypto');

function createTraceAdapter(options = {}) {
  const traceId = options.traceId || randomUUID();
  const clock = typeof options.clock === 'function'
    ? options.clock
    : () => new Date().toISOString();
  const entries = [];
  const runSpanId = `run:${traceId}`;
  const currentStepByNumber = new Map();
  const currentToolByCallId = new Map();

  function record(entry) {
    const completeEntry = {
      trace_id: traceId,
      occurred_at: clock(),
      ...entry,
    };
    entries.push(completeEntry);
    return completeEntry;
  }

  function handleEvent(event) {
    if (!event || typeof event !== 'object') {
      return null;
    }

    switch (event.type) {
      case 'run_started':
        return record({
          span_id: runSpanId,
          parent_span_id: null,
          kind: 'run',
          name: 'run',
          status: 'running',
          event_type: event.type,
          attributes: { prompt: event.prompt || null },
        });

      case 'step_started': {
        const stepSpanId = `step:${event.step}`;
        currentStepByNumber.set(event.step, stepSpanId);
        return record({
          span_id: stepSpanId,
          parent_span_id: runSpanId,
          kind: 'step',
          name: `step:${event.step}`,
          status: 'running',
          event_type: event.type,
          attributes: { step: event.step },
        });
      }

      case 'tool_call': {
        const toolSpanId = `tool:${event.tool_call_id}`;
        currentToolByCallId.set(event.tool_call_id, toolSpanId);
        return record({
          span_id: toolSpanId,
          parent_span_id: currentStepByNumber.get(event.step) || runSpanId,
          kind: 'tool',
          name: event.name || 'tool',
          status: 'running',
          event_type: event.type,
          attributes: {
            step: event.step,
            tool_call_id: event.tool_call_id,
            args: event.args || null,
          },
        });
      }

      case 'tool_result':
        return record({
          span_id: currentToolByCallId.get(event.tool_call_id) || `tool:${event.tool_call_id}`,
          parent_span_id: currentStepByNumber.get(event.step) || runSpanId,
          kind: 'tool',
          name: 'tool_result',
          status: event.error ? 'failed' : 'completed',
          event_type: event.type,
          attributes: {
            step: event.step,
            tool_call_id: event.tool_call_id,
            result: event.result ?? null,
            error: event.error || null,
          },
        });

      case 'step_completed':
        return record({
          span_id: currentStepByNumber.get(event.step) || `step:${event.step}`,
          parent_span_id: runSpanId,
          kind: 'step',
          name: `step:${event.step}`,
          status: event.finish_reason === 'tool_calls' ? 'tool_calls' : 'completed',
          event_type: event.type,
          attributes: {
            step: event.step,
            finish_reason: event.finish_reason || null,
          },
        });

      case 'text_delta':
      case 'usage':
      case 'error':
      case 'done':
        return record({
          span_id: event.type === 'done'
            ? runSpanId
            : (currentStepByNumber.get(event.step) || runSpanId),
          parent_span_id: event.type === 'done'
            ? null
            : (currentStepByNumber.get(event.step) || runSpanId),
          kind: event.type === 'usage' ? 'usage' : 'event',
          name: event.type,
          status: event.type === 'error'
            ? 'failed'
            : (event.type === 'done' ? (event.reason || 'completed') : 'observed'),
          event_type: event.type,
          attributes: { ...event },
        });

      default:
        return record({
          span_id: currentStepByNumber.get(event.step) || runSpanId,
          parent_span_id: runSpanId,
          kind: 'event',
          name: event.type || 'unknown',
          status: 'observed',
          event_type: event.type || 'unknown',
          attributes: { ...event },
        });
    }
  }

  async function consume(iter) {
    for await (const event of iter) {
      handleEvent(event);
    }
    return entries.slice();
  }

  return {
    traceId,
    handleEvent,
    consume,
    getEntries: () => entries.slice(),
  };
}

module.exports = {
  createTraceAdapter,
};
