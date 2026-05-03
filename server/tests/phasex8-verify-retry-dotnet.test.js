'use strict';

const {
  detectVerifyStack,
  getVerifyStackGuidance,
  buildVerifyFixPrompt,
} = require('../factory/loop-controller');

describe('Phase X8: verify-retry stack-aware prompt + escalation', () => {
  describe('detectVerifyStack', () => {
    it('detects dotnet from dotnet test in command', () => {
      expect(detectVerifyStack({
        verifyCommand: 'dotnet test simtests/Foo.csproj -c Release',
        verifyOutput: '',
      })).toBe('dotnet');
    });

    it('detects dotnet from NUnit assertion signature in output', () => {
      expect(detectVerifyStack({
        verifyCommand: 'make verify',
        verifyOutput: 'Assert.That failed: Expected: not equal to <X>\n  But was: <X>',
      })).toBe('dotnet');
    });

    it('detects dotnet from "Test Run Failed" line', () => {
      expect(detectVerifyStack({
        verifyCommand: 'do-stuff.sh',
        verifyOutput: 'Some output\nTest Run Failed.\nTotal: 5',
      })).toBe('dotnet');
    });

    it('detects pytest from command', () => {
      expect(detectVerifyStack({
        verifyCommand: 'python -m pytest tests/',
        verifyOutput: '',
      })).toBe('pytest');
    });

    it('detects pytest from AssertionError in output', () => {
      expect(detectVerifyStack({
        verifyCommand: 'make check',
        verifyOutput: 'tests/test_x.py::test_y FAILED\nE       AssertionError: ',
      })).toBe('pytest');
    });

    it('detects vitest', () => {
      expect(detectVerifyStack({
        verifyCommand: 'npx vitest run',
        verifyOutput: '',
      })).toBe('jstest');
    });

    it('detects npm test', () => {
      expect(detectVerifyStack({
        verifyCommand: 'npm test',
        verifyOutput: '',
      })).toBe('jstest');
    });

    it('returns null when stack is unknown', () => {
      expect(detectVerifyStack({
        verifyCommand: 'unknown-runner',
        verifyOutput: 'random failure text',
      })).toBe(null);
    });
  });

  describe('getVerifyStackGuidance', () => {
    it('returns dotnet guidance for dotnet stack', () => {
      const g = getVerifyStackGuidance('dotnet');
      expect(g).toContain('Dotnet test guidance');
      expect(g).toContain('Expected:');
      expect(g).toContain('NUnit/xUnit');
      expect(g).toContain('enum');
    });

    it('returns pytest guidance for pytest stack', () => {
      const g = getVerifyStackGuidance('pytest');
      expect(g).toContain('Pytest guidance');
    });

    it('returns jstest guidance for jstest stack', () => {
      const g = getVerifyStackGuidance('jstest');
      expect(g).toContain('JS test guidance');
    });

    it('returns empty string for unknown stack', () => {
      expect(getVerifyStackGuidance(null)).toBe('');
      expect(getVerifyStackGuidance('something-else')).toBe('');
    });
  });

  describe('buildVerifyFixPrompt with stack guidance', () => {
    const baseArgs = {
      planPath: '/tmp/plan.md',
      planTitle: 'Test plan',
      branch: 'feat/factory-100',
      verifyOutput: 'some failure',
      priorAttempts: [],
      verifyOutputPrev: null,
    };

    it('appends dotnet guidance when verifyCommand is dotnet test', () => {
      const prompt = buildVerifyFixPrompt({
        ...baseArgs,
        verifyCommand: 'dotnet test simtests/Foo.csproj -c Release',
      });
      expect(prompt).toContain('Dotnet test guidance');
      expect(prompt).toContain('NUnit');
      // Existing constraints still present
      expect(prompt).toContain('SCOPE ENVELOPE');
      expect(prompt).toContain('After making the edits, stop.');
    });

    it('appends pytest guidance when verifyCommand uses pytest', () => {
      const prompt = buildVerifyFixPrompt({
        ...baseArgs,
        verifyCommand: 'python -m pytest tests/',
      });
      expect(prompt).toContain('Pytest guidance');
      expect(prompt).not.toContain('Dotnet test guidance');
    });

    it('omits stack guidance when no stack detected', () => {
      const prompt = buildVerifyFixPrompt({
        ...baseArgs,
        verifyCommand: 'custom-runner',
      });
      expect(prompt).not.toContain('Dotnet test guidance');
      expect(prompt).not.toContain('Pytest guidance');
      expect(prompt).not.toContain('JS test guidance');
      // Generic constraints still present
      expect(prompt).toContain('SCOPE ENVELOPE');
    });

    it('detects dotnet via output when command is generic', () => {
      const prompt = buildVerifyFixPrompt({
        ...baseArgs,
        verifyCommand: 'make test',
        verifyOutput: 'Test Run Failed. Assert.That(...) Expected:\n  But was:',
      });
      expect(prompt).toContain('Dotnet test guidance');
    });
  });
});
