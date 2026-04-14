'use strict';

const { EventType } = require('./event-types');

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

async function* streamRun({
  prompt,
  tools = {},
  callProvider,
  maxSteps = 20,
  systemPrompt = null,
  logger: _logger = console,
}) {
  yield { type: EventType.RUN_STARTED, prompt };

  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
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
          yield {
            type: EventType.TOOL_CALL,
            tool_call_id: chunk.tool_call_id,
            name: chunk.name,
            args: chunk.args,
            step,
          };
        } else if (chunk.type === 'usage') {
          yield { type: EventType.USAGE, ...chunk, step };
        } else if (chunk.type === 'step_completed') {
          finishReason = chunk.finish_reason;
        }
      }
    } catch (err) {
      yield { type: EventType.ERROR, error: getErrorMessage(err), step };
      yield { type: EventType.DONE, reason: 'error' };
      return;
    }

    if (pendingToolCalls.length > 0) {
      messages.push({ role: 'assistant', content: assistantText, tool_calls: pendingToolCalls });
    } else if (assistantText) {
      messages.push({ role: 'assistant', content: assistantText });
    }

    for (const call of pendingToolCalls) {
      const tool = tools[call.name];
      if (!tool || !tool.handler) {
        const error = `unknown tool: ${call.name}`;
        yield { type: EventType.TOOL_RESULT, tool_call_id: call.tool_call_id, error, step };
        messages.push({
          role: 'tool',
          tool_call_id: call.tool_call_id,
          content: JSON.stringify({ error }),
        });
        continue;
      }

      try {
        const result = await tool.handler(call.args);
        yield { type: EventType.TOOL_RESULT, tool_call_id: call.tool_call_id, result, step };
        messages.push({
          role: 'tool',
          tool_call_id: call.tool_call_id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const error = getErrorMessage(err);
        yield { type: EventType.TOOL_RESULT, tool_call_id: call.tool_call_id, error, step };
        messages.push({
          role: 'tool',
          tool_call_id: call.tool_call_id,
          content: JSON.stringify({ error }),
        });
      }
    }

    yield { type: EventType.STEP_COMPLETED, step, finish_reason: finishReason };

    if (finishReason === 'stop' || pendingToolCalls.length === 0) {
      break;
    }
  }

  yield { type: EventType.DONE, reason: 'completed' };
}

module.exports = { streamRun };
