import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createVerifyHandlers } = require('../plugins/snapscope/handlers/verify.js');

describe('server/plugins/snapscope/handlers/verify', () => {
  it('handlePeekVerify sends POST to /verify with correct args', async () => {
    const peekClient = {
      request: vi.fn().mockResolvedValue({ data: { passed: true } }),
    };
    const { handlePeekVerify } = createVerifyHandlers(peekClient);

    const result = await handlePeekVerify({
      window: 'MyApp',
      checks: ['layout'],
      name: 'test',
    });

    expect(peekClient.request).toHaveBeenCalledWith(
      'POST',
      '/verify',
      expect.objectContaining({
        window: 'MyApp',
        checks: ['layout'],
        capture: true,
        name: 'test',
        branch: 'main',
      }),
    );
    expect(result.content[0].text.replace(/\s+/g, '')).toContain('"passed":true');
  });

  it('handlePeekVerifyRun sends POST to /verify/run', async () => {
    const peekClient = {
      request: vi.fn().mockResolvedValue({ data: { results: [] } }),
    };
    const { handlePeekVerifyRun } = createVerifyHandlers(peekClient);

    await handlePeekVerifyRun({ spec_name: 'my-spec', window: 'App' });

    expect(peekClient.request).toHaveBeenCalledWith(
      'POST',
      '/verify/run',
      expect.objectContaining({
        spec_name: 'my-spec',
        window: 'App',
        branch: 'main',
      }),
    );
  });

  it('handlePeekVerifySpecs forwards args to /verify/specs', async () => {
    const peekClient = {
      request: vi.fn().mockResolvedValue({ data: { specs: ['a'] } }),
    };
    const { handlePeekVerifySpecs } = createVerifyHandlers(peekClient);

    await handlePeekVerifySpecs({ filter: 'all' });

    expect(peekClient.request).toHaveBeenCalledWith(
      'POST',
      '/verify/specs',
      { filter: 'all' },
    );
  });

  it('handlePeekBaselines sends POST to /baselines', async () => {
    const peekClient = {
      request: vi.fn().mockResolvedValue({ data: { count: 5 } }),
    };
    const { handlePeekBaselines } = createVerifyHandlers(peekClient);

    await handlePeekBaselines({ window: 'App' });

    expect(peekClient.request).toHaveBeenCalledWith(
      'POST',
      '/baselines',
      { window: 'App' },
    );
  });

  it('handlePeekHistory sends POST to /history', async () => {
    const peekClient = {
      request: vi.fn().mockResolvedValue({ data: { entries: [] } }),
    };
    const { handlePeekHistory } = createVerifyHandlers(peekClient);

    await handlePeekHistory({ window: 'App' });

    expect(peekClient.request).toHaveBeenCalledWith(
      'POST',
      '/history',
      { window: 'App' },
    );
  });
});
