'use strict';

const { describe, it, expect } = require('vitest');

// buildAgenticSystemPrompt is module-private; we test through the export shim.
const execution = require('../providers/execution');
const { buildAgenticSystemPrompt } = execution;

describe('buildAgenticSystemPrompt', () => {
  it('exports buildAgenticSystemPrompt for testing', () => {
    expect(typeof buildAgenticSystemPrompt).toBe('function');
  });

  it('contains the existing CRITICAL rule about tool calls', () => {
    const out = buildAgenticSystemPrompt('BASE.', '/tmp/wd');
    expect(out).toContain('TOOL CALLS ARE THE ONLY WAY TO MAKE PROGRESS');
  });

  it('contains the few-shot example block', () => {
    const out = buildAgenticSystemPrompt('BASE.', '/tmp/wd');
    expect(out).toContain('EXAMPLE — correct first response shape');
    expect(out).toContain('"name": "read_file"');
    expect(out).toContain('"name": "edit_file"');
  });

  it('few-shot calls out the prose anti-pattern explicitly', () => {
    const out = buildAgenticSystemPrompt('BASE.', '/tmp/wd');
    expect(out).toContain('DO NOT respond with text saying');
  });

  it('working directory still appears at the end', () => {
    const out = buildAgenticSystemPrompt('BASE.', '/tmp/specific-wd-xyz');
    const idx = out.indexOf('Working directory: /tmp/specific-wd-xyz');
    expect(idx).toBeGreaterThan(-1);
    // It should be at the very end (last ~80 chars).
    expect(out.length - idx).toBeLessThan(80);
  });

  it('basePrompt is preserved at the start', () => {
    const out = buildAgenticSystemPrompt('CUSTOM_BASE_HEADER.', '/tmp/wd');
    expect(out.startsWith('CUSTOM_BASE_HEADER.')).toBe(true);
  });

  it('platform rule still appears (Windows or POSIX flavor)', () => {
    const out = buildAgenticSystemPrompt('BASE.', '/tmp/wd');
    expect(out).toMatch(/PLATFORM:/);
  });
});
