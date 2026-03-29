'use strict';

const { generateBranchName } = require('../utils/git-worktree');

describe('generateBranchName', () => {
  it('generates kebab-case branch name', () => {
    expect(generateBranchName('Add user authentication to the login page')).toBe(
      'task/add-user-authentication-login-page'
    );
  });

  it('removes stop words', () => {
    expect(generateBranchName('Fix the bug in payment processing module')).toBe(
      'task/fix-bug-payment-processing-module'
    );
  });

  it('truncates to 50 chars without breaking words', () => {
    expect(generateBranchName(
      'Implement comprehensive validation pipeline for workflow orchestration monitoring dashboard alerts'
    )).toBe('task/implement-comprehensive-validation-pipeline');
  });

  it('prefixes branch names with task/', () => {
    expect(generateBranchName('Improve caching layer')).toMatch(/^task\//);
  });

  it('handles empty description', () => {
    expect(generateBranchName('')).toBe('task/unnamed');
  });

  it('handles special characters', () => {
    expect(generateBranchName('Fix bug #123 (critical!)')).toBe(
      'task/fix-bug-123-critical'
    );
  });

  it('removes trailing hyphens', () => {
    expect(generateBranchName('fix --- the --- bug ---')).toBe('task/fix-bug');
    expect(generateBranchName('fix --- the --- bug ---').endsWith('-')).toBe(false);
  });
});
