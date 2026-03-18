'use strict';

/**
 * agentic-truncation.test.js — Unit tests for truncateOldestToolResults
 *
 * truncateOldestToolResults mutates the messages array in place.
 * It protects: index 0 (system prompt) and the last 2 messages.
 * It truncates tool-role messages that push the array over the context budget.
 */

const { truncateOldestToolResults } = require('../providers/ollama-agentic');

describe('truncateOldestToolResults', () => {
  it('preserves system prompt and last 2 messages', () => {
    const messages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'task 1' },
      { role: 'tool', content: 'A'.repeat(5000), tool_call_id: 't1' },
      { role: 'assistant', content: 'result 1' },
      { role: 'user', content: 'task 2' },
    ];
    truncateOldestToolResults(messages, 1000);
    // System prompt preserved at index 0
    expect(messages[0].content).toBe('You are helpful');
    // Last 2 messages preserved
    expect(messages[messages.length - 1].content).toBe('task 2');
    expect(messages[messages.length - 2].content).toBe('result 1');
  });

  it('truncates tool results that exceed budget', () => {
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'tool', content: 'X'.repeat(10000), tool_call_id: 't1' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ];
    truncateOldestToolResults(messages, 500);
    const toolMsg = messages.find(m => m.role === 'tool');
    expect(toolMsg.content).toContain('truncated');
    expect(toolMsg._truncated).toBe(true);
  });

  it('does not truncate when within budget', () => {
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'tool', content: 'short result', tool_call_id: 't1' },
      { role: 'user', content: 'next' },
    ];
    truncateOldestToolResults(messages, 50000);
    const toolMsg = messages.find(m => m.role === 'tool');
    expect(toolMsg.content).toBe('short result');
    expect(toolMsg._truncated).toBeUndefined();
  });

  it('handles empty messages array', () => {
    const messages = [];
    truncateOldestToolResults(messages, 1000);
    expect(messages).toEqual([]);
  });

  it('does not truncate tool result that is within the protected tail (last 2 messages)', () => {
    // The tool message is the last message — it sits inside the protected tail
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'assistant', content: 'calling tool' },
      { role: 'tool', content: 'Y'.repeat(10000), tool_call_id: 't1' },
    ];
    truncateOldestToolResults(messages, 100);
    // The tool message is at index 2 (last), so cutoffIndex = 3 - 2 = 1.
    // Loop runs from i=1 to i<1 — no iterations — nothing truncated.
    const toolMsg = messages.find(m => m.role === 'tool');
    expect(toolMsg._truncated).toBeUndefined();
  });

  it('skips already-truncated messages on subsequent calls', () => {
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'tool', content: '[result truncated — 10000 bytes, returned OK]', tool_call_id: 't1', _truncated: true },
      { role: 'tool', content: 'Z'.repeat(8000), tool_call_id: 't2' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ];
    // Already-truncated message should not be re-processed; second tool msg should be truncated
    truncateOldestToolResults(messages, 100);
    const first = messages.find(m => m.tool_call_id === 't1');
    const second = messages.find(m => m.tool_call_id === 't2');
    // First was already truncated — content unchanged
    expect(first.content).toContain('truncated');
    // Second should now be truncated too
    expect(second._truncated).toBe(true);
  });

  it('includes byte count and status in truncation message', () => {
    const content = 'B'.repeat(4000);
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'tool', content, tool_call_id: 't1' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ];
    truncateOldestToolResults(messages, 100);
    const toolMsg = messages.find(m => m.role === 'tool');
    // Should report byte count
    expect(toolMsg.content).toMatch(/\d+ bytes/);
    // Should report status (OK for non-error)
    expect(toolMsg.content).toContain('OK');
  });

  it('reports ERROR status for tool messages that were errors', () => {
    const content = 'C'.repeat(4000);
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'tool', content, tool_call_id: 't1', _wasError: true },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ];
    truncateOldestToolResults(messages, 100);
    const toolMsg = messages.find(m => m.role === 'tool');
    expect(toolMsg.content).toContain('ERROR');
    expect(toolMsg._truncated).toBe(true);
  });
});
