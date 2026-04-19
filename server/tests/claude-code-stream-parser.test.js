'use strict';

const parser = require('../providers/claude-code/stream-parser');

describe('stream-parser.normalizeUsage', () => {
  it('returns null when record has no usage field', () => {
    expect(parser.normalizeUsage({})).toBeNull();
    expect(parser.normalizeUsage(null)).toBeNull();
    expect(parser.normalizeUsage({ usage: null })).toBeNull();
  });

  it('extracts input/output/total token counts', () => {
    const result = parser.normalizeUsage({
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    expect(result).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('computes total_tokens when absent', () => {
    const result = parser.normalizeUsage({
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    expect(result.total_tokens).toBe(10);
  });
});

describe('stream-parser.normalizeToolCall', () => {
  it('accepts type=tool_call records', () => {
    const result = parser.normalizeToolCall({
      type: 'tool_call',
      tool_call_id: 'abc',
      name: 'Read',
      args: { file_path: '/tmp/x' },
    });
    expect(result).toEqual({
      tool_call_id: 'abc',
      name: 'Read',
      args: { file_path: '/tmp/x' },
    });
  });

  it('accepts type=tool_use records and maps input→args', () => {
    const result = parser.normalizeToolCall({
      type: 'tool_use',
      id: 'xyz',
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(result.name).toBe('Bash');
    expect(result.args).toEqual({ command: 'ls' });
  });

  it('accepts content_block envelopes', () => {
    const result = parser.normalizeToolCall({
      content_block: { type: 'tool_use', id: 'cb1', name: 'Edit', input: { path: 'f' } },
    });
    expect(result.name).toBe('Edit');
  });

  it('returns null for non-tool records', () => {
    expect(parser.normalizeToolCall({ type: 'text_delta', delta: 'hi' })).toBeNull();
    expect(parser.normalizeToolCall(null)).toBeNull();
  });
});

describe('stream-parser.normalizeToolResult', () => {
  it('accepts tool_result records with content field', () => {
    const result = parser.normalizeToolResult({
      type: 'tool_result',
      tool_call_id: 'abc',
      result: 'file contents',
    });
    expect(result.tool_call_id).toBe('abc');
    expect(result.content).toBe('file contents');
    expect(result.error).toBeNull();
  });

  it('serializes non-string content to JSON', () => {
    const result = parser.normalizeToolResult({
      type: 'tool_result',
      tool_call_id: 'abc',
      output: { lines: 42 },
    });
    expect(result.content).toBe('{"lines":42}');
  });

  it('captures error field', () => {
    const result = parser.normalizeToolResult({
      type: 'tool_result',
      tool_call_id: 'abc',
      error: 'permission denied',
    });
    expect(result.error).toBe('permission denied');
  });
});

describe('stream-parser.extractTextDelta', () => {
  it('pulls text from text_delta records', () => {
    expect(parser.extractTextDelta({ type: 'text_delta', delta: 'hello' })).toBe('hello');
  });

  it('pulls text from content_block_delta.delta.text', () => {
    expect(parser.extractTextDelta({
      type: 'content_block_delta',
      delta: { text: ' world' },
    })).toBe(' world');
  });

  it('returns empty string for unrelated records', () => {
    expect(parser.extractTextDelta({ type: 'tool_call' })).toBe('');
    expect(parser.extractTextDelta(null)).toBe('');
  });
});

describe('stream-parser.extractFallbackText', () => {
  it('reads .text field', () => {
    expect(parser.extractFallbackText({ text: 'foo' })).toBe('foo');
  });

  it('reads .message.content string', () => {
    expect(parser.extractFallbackText({ message: { content: 'bar' } })).toBe('bar');
  });

  it('reads .content array with text blocks', () => {
    expect(parser.extractFallbackText({
      content: [{ type: 'text', text: 'baz' }, { type: 'text', text: 'qux' }],
    })).toBe('bazqux');
  });
});
