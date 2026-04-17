'use strict';

const { runPattern } = require('../patterns/pattern-runner');

describe('runPattern', () => {
  it('calls model with system + rendered user template', async () => {
    const callModel = vi.fn(async () => 'result');
    const pattern = {
      name: 'summarize',
      system: 'You summarize.',
      user_template: 'Summarize: {{input}}',
    };

    const out = await runPattern({ pattern, input: 'long text', callModel });

    expect(out).toBe('result');
    expect(callModel).toHaveBeenCalledWith(expect.objectContaining({
      system: 'You summarize.',
      user: 'Summarize: long text',
    }));
  });

  it('uses raw input as user when no template provided', async () => {
    const callModel = vi.fn(async () => 'x');

    await runPattern({
      pattern: { name: 'p', system: 'x', user_template: null },
      input: 'plain input',
      callModel,
    });

    expect(callModel).toHaveBeenCalledWith(expect.objectContaining({ user: 'plain input' }));
  });

  it('substitutes named vars in template', async () => {
    const callModel = vi.fn(async () => 'x');

    await runPattern({
      pattern: { name: 'p', system: 's', user_template: 'Hello {{name}}, topic={{topic}}' },
      input: 'ignored',
      vars: { name: 'Alice', topic: 'db' },
      callModel,
    });

    const call = callModel.mock.calls[0][0];
    expect(call.user).toBe('Hello Alice, topic=db');
  });

  it('{{input}} takes precedence over vars.input', async () => {
    const callModel = vi.fn(async () => 'x');

    await runPattern({
      pattern: { name: 'p', system: 's', user_template: '{{input}}' },
      input: 'from positional',
      vars: { input: 'from vars' },
      callModel,
    });

    const call = callModel.mock.calls[0][0];
    expect(call.user).toBe('from positional');
  });

  it('missing variable leaves literal placeholder', async () => {
    const callModel = vi.fn(async () => 'x');

    await runPattern({
      pattern: { name: 'p', system: 's', user_template: 'Hello {{missing}}' },
      input: '',
      callModel,
    });

    const call = callModel.mock.calls[0][0];
    expect(call.user).toBe('Hello {{missing}}');
  });
});
