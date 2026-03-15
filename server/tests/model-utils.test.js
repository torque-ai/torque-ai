/**
 * Unit Tests: utils/model.js
 *
 * Tests model classification utilities: size parsing, categorization,
 * small model detection, and thinking model detection.
 */

const { parseModelSizeB, getModelSizeCategory, isSmallModel, isThinkingModel } = require('../utils/model');

describe('Model Utils', () => {
  describe('parseModelSizeB', () => {
    it('parses colon-prefixed sizes', () => {
      expect(parseModelSizeB('qwen2.5-coder:32b')).toBe(32);
      expect(parseModelSizeB('gemma3:4b')).toBe(4);
      expect(parseModelSizeB('qwen3:8b')).toBe(8);
      expect(parseModelSizeB('llama3:70b')).toBe(70);
    });

    it('parses dash-prefixed sizes', () => {
      expect(parseModelSizeB('deepseek-r1-14b')).toBe(14);
      expect(parseModelSizeB('model-7b')).toBe(7);
    });

    it('parses underscore-prefixed sizes', () => {
      expect(parseModelSizeB('model_3b')).toBe(3);
    });

    it('parses decimal sizes', () => {
      expect(parseModelSizeB('model:1.5b')).toBe(1.5);
      expect(parseModelSizeB('gemma:2.5b')).toBe(2.5);
    });

    it('returns 0 for unparseable models', () => {
      expect(parseModelSizeB('mistral')).toBe(0);
      expect(parseModelSizeB('gpt-4')).toBe(0);
      expect(parseModelSizeB('')).toBe(0);
      expect(parseModelSizeB(null)).toBe(0);
      expect(parseModelSizeB(undefined)).toBe(0);
    });

    it('is case insensitive', () => {
      expect(parseModelSizeB('Model:32B')).toBe(32);
      expect(parseModelSizeB('MODEL:7B')).toBe(7);
    });
  });

  describe('getModelSizeCategory', () => {
    it('returns small for <=8B', () => {
      expect(getModelSizeCategory('gemma3:4b')).toBe('small');
      expect(getModelSizeCategory('qwen3:8b')).toBe('small');
      expect(getModelSizeCategory('llama3.2:3b')).toBe('small');
    });

    it('returns medium for 9-20B', () => {
      expect(getModelSizeCategory('qwen2.5:14b')).toBe('medium');
      expect(getModelSizeCategory('deepseek-coder-v2:16b')).toBe('medium');
    });

    it('returns large for >20B', () => {
      expect(getModelSizeCategory('qwen2.5-coder:32b')).toBe('large');
      expect(getModelSizeCategory('codellama:34b')).toBe('large');
      expect(getModelSizeCategory('llama3:70b')).toBe('large');
    });

    it('returns unknown when size cannot be parsed', () => {
      expect(getModelSizeCategory('mistral')).toBe('unknown');
      expect(getModelSizeCategory('gpt-4')).toBe('unknown');
    });
  });

  describe('isSmallModel', () => {
    it('returns true for models <=8B', () => {
      expect(isSmallModel('gemma3:4b')).toBe(true);
      expect(isSmallModel('qwen3:8b')).toBe(true);
      expect(isSmallModel('llama3.2:3b')).toBe(true);
    });

    it('returns false for models >8B', () => {
      expect(isSmallModel('qwen2.5:14b')).toBe(false);
      expect(isSmallModel('qwen2.5-coder:32b')).toBe(false);
    });

    it('returns true for models with mini/tiny in name', () => {
      expect(isSmallModel('phi-mini')).toBe(true);
      expect(isSmallModel('gpt-4-mini')).toBe(true);
      expect(isSmallModel('tiny-llama')).toBe(true);
    });

    it('returns false for null/empty', () => {
      expect(isSmallModel(null)).toBe(false);
      expect(isSmallModel('')).toBe(false);
      expect(isSmallModel(undefined)).toBe(false);
    });

    it('returns false for unknown size models without mini/tiny', () => {
      expect(isSmallModel('mistral')).toBe(false);
      expect(isSmallModel('gpt-4')).toBe(false);
    });
  });

  describe('isThinkingModel', () => {
    it('identifies deepseek-r1 variants', () => {
      expect(isThinkingModel('deepseek-r1:14b')).toBe(true);
      expect(isThinkingModel('deepseek-r1')).toBe(true);
    });

    it('identifies deepseek-r2 variants', () => {
      expect(isThinkingModel('deepseek-r2:32b')).toBe(true);
    });

    it('identifies qwq models', () => {
      expect(isThinkingModel('qwq:32b')).toBe(true);
      expect(isThinkingModel('qwq-preview')).toBe(true);
    });

    it('identifies /r1 path models', () => {
      expect(isThinkingModel('deepseek-ai/r1-distill')).toBe(true);
    });

    it('returns false for non-thinking models', () => {
      expect(isThinkingModel('qwen3:8b')).toBe(false);
      expect(isThinkingModel('gemma3:4b')).toBe(false);
      expect(isThinkingModel('codellama:34b')).toBe(false);
      expect(isThinkingModel('gpt-4')).toBe(false);
    });

    it('returns false for null/empty', () => {
      expect(isThinkingModel(null)).toBe(false);
      expect(isThinkingModel('')).toBe(false);
      expect(isThinkingModel(undefined)).toBe(false);
    });
  });
});
