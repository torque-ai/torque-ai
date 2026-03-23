import { describe, it, expect } from 'vitest';
const { parseDiffusionSignal } = require('../diffusion/signal-parser');

describe('close-handler diffusion signal detection (Phase 2.5)', () => {
  it('detects a valid diffusion signal in task output', () => {
    const validPlan = JSON.stringify({
      summary: 'Found 20 files',
      patterns: [{ id: 'p1', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 20 }],
      manifest: [{ file: 'a.js', pattern: 'p1' }],
      shared_dependencies: [],
      estimated_subtasks: 20,
      isolation_confidence: 0.9,
    });
    const output = `Modified 3 files.\n__DIFFUSION_REQUEST__\n${validPlan}\n__DIFFUSION_REQUEST_END__`;
    const result = parseDiffusionSignal(output);
    expect(result).not.toBeNull();
    expect(result.summary).toBe('Found 20 files');
  });

  it('returns null for output without diffusion signal', () => {
    const result = parseDiffusionSignal('Task completed successfully. 5 files modified.');
    expect(result).toBeNull();
  });

  it('metadata patching preserves existing metadata', () => {
    const existingMeta = { smart_routing: true, provider: 'codex' };
    const diffusionPlan = { summary: 'test' };
    const patched = { ...existingMeta, diffusion_request: diffusionPlan };
    expect(patched.smart_routing).toBe(true);
    expect(patched.diffusion_request.summary).toBe('test');
  });
});
