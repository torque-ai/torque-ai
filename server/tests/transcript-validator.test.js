import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const { validateTranscript } = require('../transcripts/transcript-validator');

describe('validateTranscript', () => {
  it('valid sequence passes', () => {
    const r = validateTranscript([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);

    expect(r.ok).toBe(true);
  });

  it('requires role field', () => {
    const r = validateTranscript([{ content: 'hi' }]);

    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/role/);
  });

  it('rejects unknown role', () => {
    const r = validateTranscript([{ role: 'wizard', content: 'hi' }]);

    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/role/);
  });

  it('tool_result must reference a prior tool_call with matching id', () => {
    const r = validateTranscript([
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', name: 'read', args: {} }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'result' },
    ]);

    expect(r.ok).toBe(true);

    const bad = validateTranscript([
      { role: 'tool', tool_call_id: 'orphan', content: 'result' },
    ]);

    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatch(/orphan/);
  });

  it('aggregates multiple errors', () => {
    const r = validateTranscript([
      { role: 'user' },
      { role: 'bogus', content: 'x' },
    ]);

    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});
