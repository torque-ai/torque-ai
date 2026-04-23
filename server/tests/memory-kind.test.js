'use strict';
const { describe, it, expect } = require('vitest');
const { validateMemory, resolveNamespace, MEMORY_KINDS } = require('../memory/memory-kind');

describe('memory kinds', () => {
  it('MEMORY_KINDS exposes all three', () => {
    expect(MEMORY_KINDS).toEqual(['semantic', 'episodic', 'procedural']);
  });

  it('semantic memory requires content string', () => {
    expect(() => validateMemory({ kind: 'semantic', content: 'fact' })).not.toThrow();
    expect(() => validateMemory({ kind: 'semantic' })).toThrow(/content/);
  });

  it('episodic memory requires an episode object with input/output/rationale', () => {
    const ok = { kind: 'episodic', content: JSON.stringify({ input: 'q', output: 'a', rationale: 'why' }) };
    expect(() => validateMemory(ok)).not.toThrow();
    expect(() => validateMemory({ kind: 'episodic', content: JSON.stringify({ input: 'q' }) })).toThrow(/output/);
  });

  it('procedural memory requires role + prompt', () => {
    expect(() => validateMemory({ kind: 'procedural', role: 'planner', content: 'prompt body' })).not.toThrow();
    expect(() => validateMemory({ kind: 'procedural', content: 'prompt body' })).toThrow(/role/);
  });

  it('resolveNamespace interpolates template vars', () => {
    expect(resolveNamespace('{user_id}/{org_id}', { user_id: 'alice', org_id: 'acme' })).toBe('alice/acme');
  });

  it('resolveNamespace leaves literal slashes and unknown vars alone', () => {
    expect(resolveNamespace('shared/global', {})).toBe('shared/global');
    expect(resolveNamespace('{user_id}/mem', {})).toBe('{user_id}/mem');
  });
});
