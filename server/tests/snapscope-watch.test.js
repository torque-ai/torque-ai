import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createWatchHandlers } = require('../plugins/snapscope/handlers/watch.js');

describe('server/plugins/snapscope/handlers/watch', () => {
  it('handlePeekWatchAdd sends POST to /watch/add', async () => {
    const peekClient = {
      request: vi.fn().mockResolvedValue({ data: { added: true } }),
    };
    const { handlePeekWatchAdd } = createWatchHandlers(peekClient);
    const args = { window: 'MyApp', interval: 5000 };

    const result = await handlePeekWatchAdd(args);

    expect(peekClient.request).toHaveBeenCalledWith('POST', '/watch/add', args);
    expect(result.content[0].text.replace(/\s+/g, '')).toContain('"added":true');
  });

  it('handlePeekWatchRemove sends POST to /watch/remove', async () => {
    const peekClient = {
      request: vi.fn().mockResolvedValue({ data: { removed: true } }),
    };
    const { handlePeekWatchRemove } = createWatchHandlers(peekClient);
    const args = { window: 'MyApp' };

    await handlePeekWatchRemove(args);

    expect(peekClient.request).toHaveBeenCalledWith('POST', '/watch/remove', args);
  });

  it('handlePeekWatchStatus sends POST to /watch/status', async () => {
    const peekClient = {
      request: vi.fn().mockResolvedValue({ data: { watches: [] } }),
    };
    const { handlePeekWatchStatus } = createWatchHandlers(peekClient);

    await handlePeekWatchStatus();

    expect(peekClient.request).toHaveBeenCalledWith('POST', '/watch/status', {});
  });

  it('handlePeekWatchControl sends POST to /watch/control', async () => {
    const peekClient = {
      request: vi.fn().mockResolvedValue({ data: { ok: true } }),
    };
    const { handlePeekWatchControl } = createWatchHandlers(peekClient);
    const args = { action: 'pause' };

    await handlePeekWatchControl(args);

    expect(peekClient.request).toHaveBeenCalledWith('POST', '/watch/control', args);
  });

  it('handlePeekRecoveryExecute sends POST to /recovery/execute', async () => {
    const peekClient = {
      request: vi.fn().mockResolvedValue({ data: { executed: true } }),
    };
    const { handlePeekRecoveryExecute } = createWatchHandlers(peekClient);
    const args = { window: 'MyApp', action: 'restart' };

    await handlePeekRecoveryExecute(args);

    expect(peekClient.request).toHaveBeenCalledWith('POST', '/recovery/execute', args);
  });

  it('handlePeekRecoveryLog sends POST to /recovery/log', async () => {
    const peekClient = {
      request: vi.fn().mockResolvedValue({ data: { logs: [] } }),
    };
    const { handlePeekRecoveryLog } = createWatchHandlers(peekClient);

    const result = await handlePeekRecoveryLog();

    expect(peekClient.request).toHaveBeenCalledWith('POST', '/recovery/log', {});
    expect(JSON.parse(result.content[0].text)).toEqual({ logs: [] });
  });
});
