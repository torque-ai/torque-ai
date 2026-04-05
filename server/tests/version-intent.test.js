import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isValidIntent,
  validateVersionIntent,
  inferIntentFromCommitMessage,
  highestIntent,
  intentToBump,
} = require('../versioning/version-intent.js');

describe('server/versioning/version-intent', () => {
  it('isValidIntent returns true for supported intents and false otherwise', () => {
    expect(isValidIntent('feature')).toBe(true);
    expect(isValidIntent('fix')).toBe(true);
    expect(isValidIntent('breaking')).toBe(true);
    expect(isValidIntent('internal')).toBe(true);

    expect(isValidIntent('feat')).toBe(false);
    expect(isValidIntent('FEATURE')).toBe(false);
    expect(isValidIntent('')).toBe(false);
    expect(isValidIntent(null)).toBe(false);
  });

  it('validateVersionIntent returns a normalized intent or an error', () => {
    expect(validateVersionIntent('  FeAtUrE  ')).toEqual({ valid: true, intent: 'feature' });
    expect(validateVersionIntent('unknown')).toEqual({
      valid: false,
      error: 'Invalid version_intent "unknown". Use: feature, fix, breaking, or internal',
    });
    expect(validateVersionIntent()).toEqual({
      valid: false,
      error: 'version_intent is required. Use: feature, fix, breaking, or internal',
    });
  });

  it('inferIntentFromCommitMessage parses conventional commits and defaults unknown prefixes to internal', () => {
    expect(inferIntentFromCommitMessage('feat: add workflow planner')).toBe('feature');
    expect(inferIntentFromCommitMessage('fix(parser): handle empty output')).toBe('fix');
    expect(
      inferIntentFromCommitMessage('chore: update protocol\n\nBREAKING CHANGE: request shape changed')
    ).toBe('breaking');
    expect(inferIntentFromCommitMessage('refactor(core): simplify priority lookup')).toBe('internal');
    expect(inferIntentFromCommitMessage('unknown: add unsupported prefix')).toBe('internal');
  });

  it('highestIntent returns the highest priority intent from an array', () => {
    expect(highestIntent(['internal', 'fix'])).toBe('fix');
    expect(highestIntent(['fix', 'feature', 'internal'])).toBe('feature');
    expect(highestIntent(['internal', 'feature', 'breaking', 'fix'])).toBe('breaking');
  });

  it('intentToBump maps intents to the expected semantic version bump', () => {
    expect(intentToBump('breaking')).toBe('major');
    expect(intentToBump('feature')).toBe('minor');
    expect(intentToBump('fix')).toBe('patch');
    expect(intentToBump('internal')).toBeNull();
    expect(intentToBump('unknown')).toBeNull();
  });
});
