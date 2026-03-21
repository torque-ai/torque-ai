'use strict';

const { polishTaskDescription, isRoughDescription } = require('../utils/task-polish');

describe('polishTaskDescription', () => {
  it('extracts title from first sentence', () => {
    const input = 'fix the login bug where users cant sign in with google oauth';
    const result = polishTaskDescription(input);
    expect(result.title).toBe('Fix The Login Bug Where Users Cant Sign In With Google OAuth');
  });

  it('extracts acceptance criteria from bullet lists', () => {
    const input = 'Add pagination to the user list\n- Should support page size of 10, 25, 50\n- Show total count\n- Keyboard navigation';
    const result = polishTaskDescription(input);
    expect(result.acceptanceCriteria).toEqual([
      'Should support page size of 10, 25, 50',
      'Show total count',
      'Keyboard navigation'
    ]);
  });

  it('generates default criteria when none provided', () => {
    const input = 'fix the login bug';
    const result = polishTaskDescription(input);
    expect(result.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(result.acceptanceCriteria[0]).toContain('Fix The Login Bug works correctly');
  });

  it('handles multi-line input', () => {
    const input = 'Update dashboard\nImprove loading performance\n\n1. Optimize initial load\n2. Lazy load widgets';
    const result = polishTaskDescription(input);
    expect(result.title).toBe('Update Dashboard');
    expect(result.description).toBe('Improve loading performance');
    expect(result.acceptanceCriteria).toEqual([
      'Optimize initial load',
      'Lazy load widgets'
    ]);
  });
});

describe('isRoughDescription', () => {
  it('returns true for short text', () => {
    const input = 'fix login';
    expect(isRoughDescription(input)).toBe(true);
  });

  it('returns false for detailed text', () => {
    const input = 'Add user profile page\n- Include avatar upload\n- Show basic info';
    expect(isRoughDescription(input)).toBe(false);
  });
});
