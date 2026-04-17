'use strict';

import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { translateToAction } = require('../dispatch/translator');

describe('translateToAction', () => {
  const schema = {
    oneOf: [
      {
        type: 'object',
        required: ['actionName', 'workflow_id'],
        properties: {
          actionName: { const: 'cancel' },
          workflow_id: { type: 'string' },
        },
      },
      {
        type: 'object',
        required: ['actionName', 'workflow_id'],
        properties: {
          actionName: { const: 'resume' },
          workflow_id: { type: 'string' },
        },
      },
    ],
  };

  it('parses LLM JSON and validates against schema', async () => {
    const callModel = vi.fn(async () => JSON.stringify({ actionName: 'cancel', workflow_id: 'wf-1' }));

    const result = await translateToAction({
      utterance: 'cancel wf-1',
      schema,
      callModel,
    });

    expect(result.ok).toBe(true);
    expect(result.action).toEqual({ actionName: 'cancel', workflow_id: 'wf-1' });
  });

  it('retries once on schema failure', async () => {
    let callCount = 0;
    const callModel = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return '{"actionName":"bogus"}';
      }
      return '{"actionName":"resume","workflow_id":"wf-9"}';
    });

    const result = await translateToAction({
      utterance: 'resume wf-9',
      schema,
      callModel,
    });

    expect(result.ok).toBe(true);
    expect(result.action.actionName).toBe('resume');
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it('returns error when model never emits valid action', async () => {
    const callModel = vi.fn(async () => '{"nope":true}');

    const result = await translateToAction({
      utterance: 'x',
      schema,
      callModel,
      maxRetries: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('strips markdown fences from LLM output', async () => {
    const callModel = vi.fn(async () => '```json\n{"actionName":"cancel","workflow_id":"abc"}\n```');

    const result = await translateToAction({
      utterance: 'cancel abc',
      schema,
      callModel,
    });

    expect(result.ok).toBe(true);
    expect(result.action).toEqual({ actionName: 'cancel', workflow_id: 'abc' });
  });
});
