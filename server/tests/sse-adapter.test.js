'use strict';

const { streamToSse } = require('../streaming/sse-adapter');

describe('streamToSse', () => {
  it('emits one SSE frame per event', async () => {
    async function* gen() {
      yield { type: 'text_delta', delta: 'hi' };
      yield { type: 'done' };
    }

    const res = {
      write: vi.fn(),
      end: vi.fn(),
    };

    await streamToSse(gen(), res);

    const writes = res.write.mock.calls.map((call) => call[0]);
    expect(writes[0]).toMatch(/event: text_delta/);
    expect(writes[0]).toMatch(/data: {"type":"text_delta","delta":"hi"}/);
    expect(res.end).toHaveBeenCalled();
  });
});
