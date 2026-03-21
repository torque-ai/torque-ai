'use strict';

const { generateBranchName } = require('../utils/git-worktree');

describe('generateBranchName', () => {
  it('generates kebab-case branch name', () => {
    expect(generateBranchName('Fix the type error in EventSystem')).toBe(
      'task-fix-type-error-eventsystem'
    );
  });

  it('removes stop words', () => {
    expect(generateBranchName('Add a new feature for the users')).toBe(
      'task-add-new-feature-users'
    );
  });

  it('truncates to 50 chars', () => {
    const result = generateBranchName(
      'Implement comprehensive validation pipeline for workflow orchestration monitoring dashboard alerts'
    );

    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.startsWith('task-')).toBe(true);
    expect(result.endsWith('-')).toBe(false);
  });

  it('handles empty input', () => {
    expect(generateBranchName('')).toBe('task-unnamed');
  });

  it('handles special characters', () => {
    expect(generateBranchName('Fix bug #123 (critical!)')).toBe(
      'task-fix-bug-123-critical'
    );
  });

  it('collapses multiple hyphens', () => {
    expect(generateBranchName('fix --- the --- bug')).toBe('task-fix-bug');
    expect(generateBranchName('fix --- the --- bug')).not.toContain('--');
  });
});
