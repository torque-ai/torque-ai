import { describe, it, expect, beforeEach } from 'vitest';
const { StreamSignalParser } = require('../diffusion/stream-signal-parser');

describe('StreamSignalParser', () => {
  let parser;
  let signals;

  beforeEach(() => {
    signals = [];
    parser = new StreamSignalParser((type, data) => signals.push({ type, data }));
  });

  it('detects a complete __PATTERNS_READY__ signal in one chunk', () => {
    const payload = JSON.stringify({
      patterns: [{ id: 'a', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', exemplar_before: 'before', exemplar_after: 'after', file_count: 5 }],
      shared_dependencies: [],
      total_candidates: 50,
      scanned_so_far: 10,
    });
    parser.feed(`some output\n__PATTERNS_READY__\n${payload}\n__PATTERNS_READY_END__\nmore output`);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('patterns_ready');
    expect(signals[0].data.patterns).toHaveLength(1);
  });

  it('detects __SCOUT_DISCOVERY__ signals', () => {
    const payload = JSON.stringify({
      manifest_chunk: [{ file: 'a.cs', pattern: 'p1' }],
      scanned_so_far: 30,
      total_candidates: 100,
    });
    parser.feed(`__SCOUT_DISCOVERY__\n${payload}\n__SCOUT_DISCOVERY_END__`);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('scout_discovery');
    expect(signals[0].data.manifest_chunk).toHaveLength(1);
  });

  it('detects __SCOUT_COMPLETE__ signals', () => {
    const payload = JSON.stringify({
      total_classified: 26, total_skipped: 89, scanned_so_far: 115, total_candidates: 115,
    });
    parser.feed(`__SCOUT_COMPLETE__\n${payload}\n__SCOUT_COMPLETE_END__`);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('scout_complete');
  });

  it('handles JSON split across multiple chunks', () => {
    const payload = JSON.stringify({
      manifest_chunk: [{ file: 'a.cs', pattern: 'p1' }],
      scanned_so_far: 30, total_candidates: 100,
    });
    const full = `__SCOUT_DISCOVERY__\n${payload}\n__SCOUT_DISCOVERY_END__`;
    const mid = Math.floor(full.length / 2);
    parser.feed(full.slice(0, mid));
    expect(signals).toHaveLength(0);
    parser.feed(full.slice(mid));
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('scout_discovery');
  });

  it('handles multiple signals in one chunk', () => {
    const d1 = JSON.stringify({ manifest_chunk: [{ file: 'a.cs', pattern: 'p1' }], scanned_so_far: 30, total_candidates: 100 });
    const d2 = JSON.stringify({ manifest_chunk: [{ file: 'b.cs', pattern: 'p1' }], scanned_so_far: 40, total_candidates: 100 });
    parser.feed(`__SCOUT_DISCOVERY__\n${d1}\n__SCOUT_DISCOVERY_END__\nstuff\n__SCOUT_DISCOVERY__\n${d2}\n__SCOUT_DISCOVERY_END__`);
    expect(signals).toHaveLength(2);
  });

  it('ignores malformed JSON in signals', () => {
    parser.feed('__SCOUT_DISCOVERY__\n{not valid json\n__SCOUT_DISCOVERY_END__');
    expect(signals).toHaveLength(0);
  });

  it('ignores non-signal output', () => {
    parser.feed('just regular task output here\nno markers at all');
    expect(signals).toHaveLength(0);
  });

  it('clears buffer on destroy', () => {
    parser.feed('__SCOUT_DISCOVERY__\n{"partial":');
    parser.destroy();
    parser.feed('"data"}\n__SCOUT_DISCOVERY_END__');
    expect(signals).toHaveLength(0);
  });
});
