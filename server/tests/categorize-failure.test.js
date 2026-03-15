'use strict';

const finalizer = require('../execution/task-finalizer');

describe('categorize-failure', () => {
  it('returns api_error for Codex JSON API errors', () => {
    const ctx = {
      output: '',
      errorOutput: 'ERROR: {"detail":"The \'codex\' model is not supported when using Codex with a ChatGPT account."}',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('api_error');
  });

  it('returns api_error for model-not-supported errors', () => {
    const ctx = {
      output: '',
      errorOutput: 'The model gpt-99-turbo is not supported for this endpoint',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('api_error');
  });

  it('returns api_error for model-not-found errors', () => {
    const ctx = {
      output: '',
      errorOutput: 'Error: model "qwen3-coder:72b" not found on this server',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('api_error');
  });

  it('returns api_error for invalid API key', () => {
    const ctx = {
      output: '',
      errorOutput: 'Error: Invalid API key provided for deepinfra',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('api_error');
  });

  it('returns api_error for authentication failures', () => {
    const ctx = {
      output: '',
      errorOutput: 'Authentication failed: bearer token expired',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('api_error');
  });

  it('returns api_error for insufficient quota', () => {
    const ctx = {
      output: '',
      errorOutput: 'insufficient_quota: billing limit exceeded',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('api_error');
  });

  it('returns parse_error for parse failures', () => {
    const ctx = {
      output: 'partial output',
      errorOutput: 'parse error while applying patch',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('parse_error');
  });

  it('returns syntax_error for syntax failures', () => {
    const ctx = {
      output: 'partial output',
      errorOutput: 'SyntaxError: unexpected token',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('syntax_error');
  });

  it('returns type_error for type failures', () => {
    const ctx = {
      output: 'partial output',
      errorOutput: 'src/app.ts(1,1): error TS2345',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('type_error');
  });

  it('returns test_failure for test failures', () => {
    const ctx = {
      output: 'partial output',
      errorOutput: 'FAIL test suite with vitest',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('test_failure');
  });

  it('returns timeout for timeout failures', () => {
    const ctx = {
      output: 'partial output',
      errorOutput: 'Process timed out with SIGTERM',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('timeout');
  });

  it('returns empty_output when output and error output are empty', () => {
    const ctx = {
      output: '',
      errorOutput: '',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('empty_output');
  });

  it('returns verify_failure for auto-verify failures', () => {
    const ctx = {
      output: 'partial output',
      errorOutput: '[auto-verify] build failed',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('verify_failure');
  });

  it('returns format_mismatch for search replace format failures', () => {
    const ctx = {
      output: 'partial output',
      errorOutput: 'SEARCH/REPLACE failed because of format mismatch',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('format_mismatch');
  });

  it('returns unknown for uncategorized failures', () => {
    const ctx = {
      output: 'partial output',
      errorOutput: 'unexpected failure',
      validationStages: {},
    };

    expect(finalizer._testing.categorizeFailure(ctx)).toBe('unknown');
  });
});
