/**
 * Unit Tests: utils/sanitize.js
 *
 * Tests LLM output sanitization: thinking tag removal, artifact marker stripping,
 * markdown fence cleanup, and the full sanitization pipeline.
 */

const { sanitizeLLMOutput, stripMarkdownFences, stripArtifactMarkers } = require('../utils/sanitize');

describe('Sanitize Utils', () => {
  describe('stripMarkdownFences', () => {
    it('removes opening fences with language tags', () => {
      expect(stripMarkdownFences('```javascript\nconst x = 1;\n```')).toBe('const x = 1;\n');
    });

    it('removes bare fences', () => {
      // ```\n is matched by /```[\w]*\n/ — the ``` and newline are removed, then trailing ``` is removed
      expect(stripMarkdownFences('```\nsome code\n```')).toBe('some code\n');
    });

    it('removes multiple fences', () => {
      const input = '```ts\nfoo();\n```\ntext\n```py\nbar()\n```';
      expect(stripMarkdownFences(input)).toBe('foo();\ntext\nbar()\n');
    });

    it('returns null/empty unchanged', () => {
      expect(stripMarkdownFences(null)).toBe(null);
      expect(stripMarkdownFences('')).toBe('');
      expect(stripMarkdownFences(undefined)).toBe(undefined);
    });

    it('preserves text without fences', () => {
      expect(stripMarkdownFences('just plain text')).toBe('just plain text');
    });
  });

  describe('stripArtifactMarkers', () => {
    it('removes <<<__newText__>>> markers', () => {
      expect(stripArtifactMarkers('before<<<__newText__>>>after')).toBe('beforeafter');
    });

    it('removes <<<__oldText__>>> markers', () => {
      expect(stripArtifactMarkers('foo<<<__oldText__>>>bar')).toBe('foobar');
    });

    it('removes <<<__endText__>>> markers', () => {
      expect(stripArtifactMarkers('start<<<__endText__>>>end')).toBe('startend');
    });

    it('removes multiple markers', () => {
      const input = '<<<__newText__>>>code<<<__oldText__>>>more<<<__endText__>>>';
      expect(stripArtifactMarkers(input)).toBe('codemore');
    });

    it('returns null/empty unchanged', () => {
      expect(stripArtifactMarkers(null)).toBe(null);
      expect(stripArtifactMarkers('')).toBe('');
    });

    it('preserves text without markers', () => {
      expect(stripArtifactMarkers('no markers here')).toBe('no markers here');
    });
  });

  describe('sanitizeLLMOutput', () => {
    it('strips <think>...</think> blocks', () => {
      const input = '<think>Internal reasoning here</think>\nActual output';
      expect(sanitizeLLMOutput(input)).toBe('Actual output');
    });

    it('strips multiline think blocks', () => {
      const input = '<think>\nStep 1: analyze\nStep 2: plan\n</think>\nResult';
      expect(sanitizeLLMOutput(input)).toBe('Result');
    });

    it('strips think blocks + artifacts + fences together', () => {
      const input = '<think>reasoning</think>\n```typescript\n<<<__newText__>>>const x = 1;\n```';
      const result = sanitizeLLMOutput(input);
      expect(result).not.toContain('<think>');
      expect(result).not.toContain('<<<__newText__>>>');
      expect(result).not.toContain('```');
      expect(result).toContain('const x = 1;');
    });

    it('returns null/empty unchanged', () => {
      expect(sanitizeLLMOutput(null)).toBe(null);
      expect(sanitizeLLMOutput('')).toBe('');
      expect(sanitizeLLMOutput(undefined)).toBe(undefined);
    });

    it('handles text with no special content', () => {
      expect(sanitizeLLMOutput('plain text output')).toBe('plain text output');
    });

    it('handles multiple think blocks', () => {
      const input = '<think>first</think>output1<think>second</think>output2';
      expect(sanitizeLLMOutput(input)).toBe('output1output2');
    });
  });
});
