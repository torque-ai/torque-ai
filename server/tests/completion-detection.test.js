'use strict';

const {
  detectSuccessFromOutput,
  detectOutputCompletion,
  buildCombinedProcessOutput,
  COMPLETION_OUTPUT_THRESHOLDS,
  SHARED_COMPLETION_PATTERNS,
  PROVIDER_COMPLETION_PATTERNS,
  FAILURE_REJECTION_PATTERNS,
} = require('../validation/completion-detection');

describe('completion-detection', () => {
  describe('constants', () => {
    it('exports COMPLETION_OUTPUT_THRESHOLDS with expected providers', () => {
      expect(COMPLETION_OUTPUT_THRESHOLDS).toHaveProperty('aider-ollama');
      expect(COMPLETION_OUTPUT_THRESHOLDS).toHaveProperty('codex');
      expect(COMPLETION_OUTPUT_THRESHOLDS).toHaveProperty('default');
      expect(typeof COMPLETION_OUTPUT_THRESHOLDS['default']).toBe('number');
    });

    it('exports SHARED_COMPLETION_PATTERNS as an array of regexps', () => {
      expect(Array.isArray(SHARED_COMPLETION_PATTERNS)).toBe(true);
      expect(SHARED_COMPLETION_PATTERNS.length).toBeGreaterThan(0);
      expect(SHARED_COMPLETION_PATTERNS[0]).toBeInstanceOf(RegExp);
    });

    it('exports PROVIDER_COMPLETION_PATTERNS with provider keys', () => {
      expect(PROVIDER_COMPLETION_PATTERNS).toHaveProperty('aider-ollama');
      expect(PROVIDER_COMPLETION_PATTERNS).toHaveProperty('codex');
      expect(PROVIDER_COMPLETION_PATTERNS).toHaveProperty('claude-cli');
    });

    it('exports FAILURE_REJECTION_PATTERNS as an array of regexps', () => {
      expect(Array.isArray(FAILURE_REJECTION_PATTERNS)).toBe(true);
      expect(FAILURE_REJECTION_PATTERNS.length).toBeGreaterThan(0);
      expect(FAILURE_REJECTION_PATTERNS[0]).toBeInstanceOf(RegExp);
    });
  });

  describe('buildCombinedProcessOutput', () => {
    it('combines stdout and stderr', () => {
      expect(buildCombinedProcessOutput('out', 'err')).toBe('out\nerr');
    });

    it('returns stdout when no stderr', () => {
      expect(buildCombinedProcessOutput('out', '')).toBe('out');
    });

    it('returns stderr when no stdout', () => {
      expect(buildCombinedProcessOutput('', 'err')).toBe('err');
    });

    it('returns empty string for null inputs', () => {
      expect(buildCombinedProcessOutput(null, null)).toBe('');
    });

    it('handles undefined inputs', () => {
      expect(buildCombinedProcessOutput(undefined, undefined)).toBe('');
    });
  });

  describe('detectOutputCompletion', () => {
    it('is an alias for detectSuccessFromOutput', () => {
      const output = 'x'.repeat(3000) + '\ntest passed';
      expect(detectOutputCompletion(output, 'codex')).toBe(
        detectSuccessFromOutput(output, 'codex')
      );
    });
  });

  describe('detectSuccessFromOutput', () => {
    it('returns false for empty or short output', () => {
      expect(detectSuccessFromOutput('', 'codex')).toBe(false);
      expect(detectSuccessFromOutput(null, 'codex')).toBe(false);
      expect(detectSuccessFromOutput('short', 'codex')).toBe(false);
    });

    // Explicit success signals (bypass threshold)
    it('detects "test passed" explicit signal', () => {
      expect(detectSuccessFromOutput('Some output\ntest passed\n', 'codex')).toBe(true);
    });

    it('detects "tests passed" explicit signal', () => {
      expect(detectSuccessFromOutput('Some output\ntests passed\n', 'codex')).toBe(true);
    });

    it('detects "Success. Updated the following files:" signal', () => {
      expect(detectSuccessFromOutput('Success. Updated the following files: a.js', 'codex')).toBe(true);
    });

    it('detects apply_patch signal', () => {
      expect(detectSuccessFromOutput('Running apply_patch to fix the issue', 'codex')).toBe(true);
    });

    // Failure rejection
    it('rejects output with API error', () => {
      const output = 'x'.repeat(3000) + '\nERROR: {"detail": "rate limited"}\ntest passed';
      expect(detectSuccessFromOutput(output, 'codex')).toBe(false);
    });

    it('rejects output with authentication failed', () => {
      expect(detectSuccessFromOutput('Authentication failed\ntest passed', 'codex')).toBe(false);
    });

    it('rejects output with model not found', () => {
      expect(detectSuccessFromOutput('The model was not found in the registry', 'codex')).toBe(false);
    });

    it('rejects output with insufficient_quota', () => {
      expect(detectSuccessFromOutput('insufficient_quota for this request', 'codex')).toBe(false);
    });

    it('rejects output with error status code', () => {
      expect(detectSuccessFromOutput('error: 401 unauthorized access', 'codex')).toBe(false);
    });

    // Provider-aware thresholds
    // Use "89 passed, 0 failed" which matches shared patterns but NOT explicit signals
    // (explicit signals like /\btests\s+passed\b/ bypass threshold checks)
    it('requires 8KB+ for aider-ollama before matching shared patterns', () => {
      const shortOutput = 'x'.repeat(4000) + '\n89 passed, 0 failed';
      expect(detectSuccessFromOutput(shortOutput, 'aider-ollama')).toBe(false);
    });

    it('matches shared patterns for aider-ollama when above threshold', () => {
      const longOutput = 'x'.repeat(9000) + '\n89 passed, 0 failed';
      expect(detectSuccessFromOutput(longOutput, 'aider-ollama')).toBe(true);
    });

    it('uses low threshold for codex', () => {
      const output = 'x'.repeat(600) + '\n89 passed, 0 failed';
      expect(detectSuccessFromOutput(output, 'codex')).toBe(true);
    });

    it('uses default threshold for unknown provider', () => {
      const shortOutput = 'x'.repeat(500) + '\n89 passed, 0 failed';
      expect(detectSuccessFromOutput(shortOutput, 'unknown-provider')).toBe(false);

      const longOutput = 'x'.repeat(2500) + '\n89 passed, 0 failed';
      expect(detectSuccessFromOutput(longOutput, 'unknown-provider')).toBe(true);
    });

    // Shared completion patterns
    it('detects "N tests, all pass"', () => {
      const output = 'x'.repeat(3000) + '\n12 tests, all pass';
      expect(detectSuccessFromOutput(output, 'ollama')).toBe(true);
    });

    it('detects "test run successful"', () => {
      const output = 'x'.repeat(3000) + '\ntest run successful';
      expect(detectSuccessFromOutput(output, 'ollama')).toBe(true);
    });

    it('detects "89 passed, 0 failed"', () => {
      const output = 'x'.repeat(3000) + '\n89 passed, 0 failed';
      expect(detectSuccessFromOutput(output, 'ollama')).toBe(true);
    });

    it('detects "no changes needed"', () => {
      const output = 'x'.repeat(3000) + '\nno changes needed';
      expect(detectSuccessFromOutput(output, 'ollama')).toBe(true);
    });

    // Provider-specific patterns
    it('detects codex "Changes made:" pattern', () => {
      const output = 'x'.repeat(600) + '\nChanges made:\n- Updated file.js';
      expect(detectSuccessFromOutput(output, 'codex')).toBe(true);
    });

    it('detects codex "Validation run: passed" pattern', () => {
      const output = 'x'.repeat(600) + '\nValidation run: passed';
      expect(detectSuccessFromOutput(output, 'codex')).toBe(true);
    });

    it('detects aider "Applied edit to file.cs" pattern', () => {
      const output = 'x'.repeat(9000) + '\nApplied edit to MyFile.cs';
      expect(detectSuccessFromOutput(output, 'aider-ollama')).toBe(true);
    });

    it('detects claude-cli "summary of changes" pattern', () => {
      const output = 'x'.repeat(5000) + '\nSummary of Changes\n- Fixed bug';
      expect(detectSuccessFromOutput(output, 'claude-cli')).toBe(true);
    });

    // Unknown provider falls back to all provider patterns
    it('tests all provider patterns for unknown providers', () => {
      const output = 'x'.repeat(3000) + '\nChanges made:\n- Updated file.js';
      expect(detectSuccessFromOutput(output, 'some-new-provider')).toBe(true);
    });
  });
});
