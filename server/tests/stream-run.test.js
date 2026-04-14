'use strict';

const { streamRun } = require('../streaming/stream-run');
const { EventType } = require('../streaming/event-types');

async function collect(iter) {
  const events = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

describe('streamRun', () => {
  it('single-turn text response -> text_delta + done', async () => {
    const callProvider = vi.fn(async function* () {
      yield { type: 'text_delta', delta: 'Hel' };
      yield { type: 'text_delta', delta: 'lo' };
      yield { type: 'step_completed', finish_reason: 'stop' };
      yield { type: 'usage', prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
    });

    const events = await collect(streamRun({ prompt: 'hi', tools: {}, callProvider }));
    const types = events.map(event => event.type);

    expect(types).toContain(EventType.TEXT_DELTA);
    expect(types[types.length - 1]).toBe(EventType.DONE);
  });

  it('tool call -> tool_call event + invokes handler -> tool_result event', async () => {
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
    const types = events.map(event => event.type);

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
    const stepStarts = events.filter(event => event.type === EventType.STEP_STARTED).length;

    expect(stepStarts).toBeLessThanOrEqual(3);
    expect(events[events.length - 1].type).toBe(EventType.DONE);
  });

  it('tool handler error -> tool_result with error, loop continues', async () => {
    let step = 0;
    const callProvider = vi.fn(async function* () {
      step += 1;
      if (step === 1) {
        yield { type: 'tool_call', tool_call_id: 'tc1', name: 'bad', args: {} };
        yield { type: 'step_completed', finish_reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', delta: 'Recovered' };
        yield { type: 'step_completed', finish_reason: 'stop' };
      }
    });

    const tools = {
      bad: {
        handler: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
    };

    const events = await collect(streamRun({ prompt: 'x', tools, callProvider, maxSteps: 5 }));
    const toolResult = events.find(event => event.type === EventType.TOOL_RESULT);
    const text = events.find(event => event.type === EventType.TEXT_DELTA);

    expect(toolResult.error).toMatch(/boom/);
    expect(text.delta).toBe('Recovered');
  });
});
