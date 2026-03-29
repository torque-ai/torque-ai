'use strict';

const { polishTaskDescription, shouldPolish } = require('../utils/task-polish');

describe('polishTaskDescription', () => {
  it('extracts title from first sentence', () => {
    const input =
      'fix authentication bug in login handler. The login handler throws a 500 error when tokens expire.';

    const result = polishTaskDescription(input);

    expect(result.title).toBe('Fix authentication bug in login handler');
    expect(result.description).toBe('The login handler throws a 500 error when tokens expire.');
  });

  it('truncates long titles at 80 chars', () => {
    const input =
      'implement provider failover across multiple hosts with retry metrics and circuit breaker support for task execution';

    const result = polishTaskDescription(input);

    expect(result.title.length).toBeLessThanOrEqual(80);
    expect(result.title).toBe('Implement provider failover across multiple hosts with retry metrics and');
  });

  it('generates acceptance criteria from action verbs', () => {
    const input = 'fix auth bug and add regression tests. verify oauth callback handling.';

    const result = polishTaskDescription(input);

    expect(result.acceptance_criteria).toEqual([
      'Fix auth bug',
      'Add regression tests',
      'Verify oauth callback handling',
    ]);
  });

  it('handles single-word input', () => {
    const result = polishTaskDescription('login');

    expect(result.title).toBe('Login');
    expect(result.description).toBe('Login');
    expect(result.acceptance_criteria).toEqual(['Ensure login works correctly']);
  });

  it('returns original text in result', () => {
    const input = 'fix login bug';
    const result = polishTaskDescription(input);

    expect(result.original).toBe(input);
    expect(result.polished).toBe(true);
  });
});

describe('shouldPolish', () => {
  it('returns true for short rough text', () => {
    expect(shouldPolish('fix login bug')).toBe(true);
  });

  it('returns false for well-structured text', () => {
    expect(
      shouldPolish('Fix the login handler so Google OAuth sign-in works again. Add regression coverage.')
    ).toBe(false);
  });
});
