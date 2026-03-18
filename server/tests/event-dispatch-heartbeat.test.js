import { describe, test, expect } from 'vitest';

describe('event classification exports', () => {
  test('TERMINAL_EVENTS and NOTABLE_EVENTS are exported', async () => {
    const mod = await import('../hooks/event-dispatch.js');
    expect(mod.TERMINAL_EVENTS).toBeDefined();
    expect(mod.NOTABLE_EVENTS).toBeDefined();
  });

  test('retry is classified as non-terminal (notable)', async () => {
    const mod = await import('../hooks/event-dispatch.js');
    expect(mod.TERMINAL_EVENTS).not.toContain('retry');
    expect(mod.NOTABLE_EVENTS).toContain('retry');
  });

  test('TERMINAL_EVENTS contains completed, failed, cancelled, skipped', async () => {
    const mod = await import('../hooks/event-dispatch.js');
    expect(mod.TERMINAL_EVENTS).toEqual(
      expect.arrayContaining(['completed', 'failed', 'cancelled', 'skipped'])
    );
  });

  test('NOTABLE_EVENTS contains started, stall_warning, retry, fallback', async () => {
    const mod = await import('../hooks/event-dispatch.js');
    expect(mod.NOTABLE_EVENTS).toEqual(
      expect.arrayContaining(['started', 'stall_warning', 'retry', 'fallback'])
    );
  });
});
