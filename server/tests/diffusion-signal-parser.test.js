import { describe, it, expect } from 'vitest';
const { parseDiffusionSignal } = require('../diffusion/signal-parser');

describe('diffusion signal parser', () => {
  it('extracts a valid diffusion request from output', () => {
    const output = `Some task output here...
Modified 3 files successfully.

__DIFFUSION_REQUEST__
{
  "summary": "Found 45 similar files",
  "patterns": [{"id": "a", "description": "d", "transformation": "t", "exemplar_files": ["f"], "exemplar_diff": "x", "file_count": 45}],
  "manifest": [{"file": "a.js", "pattern": "a"}],
  "shared_dependencies": [],
  "estimated_subtasks": 45,
  "isolation_confidence": 0.9
}
__DIFFUSION_REQUEST_END__`;
    const result = parseDiffusionSignal(output);
    expect(result).not.toBeNull();
    expect(result.summary).toBe('Found 45 similar files');
    expect(result.manifest).toHaveLength(1);
  });

  it('returns null when no markers present', () => {
    expect(parseDiffusionSignal('Normal task output, no diffusion')).toBeNull();
  });

  it('returns null for malformed JSON between markers', () => {
    const output = '__DIFFUSION_REQUEST__\n{not valid json\n__DIFFUSION_REQUEST_END__';
    expect(parseDiffusionSignal(output)).toBeNull();
  });

  it('returns null for JSON that fails schema validation', () => {
    const output = '__DIFFUSION_REQUEST__\n{"foo": "bar"}\n__DIFFUSION_REQUEST_END__';
    expect(parseDiffusionSignal(output)).toBeNull();
  });

  it('only scans last 8KB of output', () => {
    const padding = 'x'.repeat(16 * 1024);
    const signal = '__DIFFUSION_REQUEST__\n{"summary":"old"}\n__DIFFUSION_REQUEST_END__';
    const output = signal + '\n' + padding;
    expect(parseDiffusionSignal(output)).toBeNull();
  });

  it('finds signal in last 8KB even with preceding content', () => {
    const padding = 'y'.repeat(16 * 1024);
    const validPlan = JSON.stringify({
      summary: 'test', patterns: [{ id: 'a', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1 }],
      manifest: [{ file: 'f.js', pattern: 'a' }], shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.8,
    });
    const signal = `__DIFFUSION_REQUEST__\n${validPlan}\n__DIFFUSION_REQUEST_END__`;
    const output = padding + '\n' + signal;
    const result = parseDiffusionSignal(output);
    expect(result).not.toBeNull();
    expect(result.summary).toBe('test');
  });
});
