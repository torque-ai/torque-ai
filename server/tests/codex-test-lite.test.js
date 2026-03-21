'use strict';

const { wrapWithInstructions, TASK_TYPE_INSTRUCTIONS } = require('../providers/prompts');

describe('test-verification-lite injection', () => {
  it('exists in TASK_TYPE_INSTRUCTIONS', () => {
    expect(TASK_TYPE_INSTRUCTIONS['test-verification-lite']).toBeTruthy();
    expect(TASK_TYPE_INSTRUCTIONS['test-verification-lite']).toContain('Do NOT run the full project test suite');
    expect(TASK_TYPE_INSTRUCTIONS['test-verification-lite']).toContain('SPECIFIC test file');
  });

  it('is injected into codex prompts', () => {
    const wrapped = wrapWithInstructions('Fix the login bug', 'codex', null, {});
    expect(wrapped).toContain('Do NOT run the full project test suite');
  });

  it('is injected into codex-spark prompts', () => {
    const wrapped = wrapWithInstructions('Fix the login bug', 'codex-spark', null, {});
    expect(wrapped).toContain('Do NOT run the full project test suite');
  });

  it('is NOT injected into ollama prompts', () => {
    const wrapped = wrapWithInstructions('Fix the login bug', 'ollama', null, {});
    expect(wrapped).not.toContain('Do NOT run the full project test suite');
  });

  it('is NOT injected into claude-cli prompts', () => {
    const wrapped = wrapWithInstructions('Fix the login bug', 'claude-cli', null, {});
    expect(wrapped).not.toContain('Do NOT run the full project test suite');
  });
});
