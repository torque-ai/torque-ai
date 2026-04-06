'use strict';

const { parseModelSizeB, getModelSizeCategory, isSmallModel, isThinkingModel } = require('../utils/model');
const { TEST_MODELS } = require('./test-helpers');

describe('utils/model', () => {
  describe('parseModelSizeB', () => {
    it('parses colon-delimited sizes', () => {
      expect(parseModelSizeB(TEST_MODELS.DEFAULT)).toBe(14);
      expect(parseModelSizeB('gemma3:4b')).toBe(4);
      expect(parseModelSizeB('model:1.5b')).toBe(1.5);
    });

    it('parses hyphen-delimited sizes', () => {
      expect(parseModelSizeB('model-7b-instruct')).toBe(7);
    });

    it('parses underscore-delimited sizes', () => {
      expect(parseModelSizeB('model_14b')).toBe(14);
    });

    it('returns 0 for unparseable models', () => {
      expect(parseModelSizeB('gpt-4')).toBe(0);
      expect(parseModelSizeB('claude-3')).toBe(0);
      expect(parseModelSizeB('')).toBe(0);
      expect(parseModelSizeB(null)).toBe(0);
      expect(parseModelSizeB(undefined)).toBe(0);
    });
  });

  describe('getModelSizeCategory', () => {
    it('returns unknown for unparseable', () => {
      expect(getModelSizeCategory('gpt-4')).toBe('unknown');
    });

    it('returns small for <=8B', () => {
      expect(getModelSizeCategory('model:4b')).toBe('small');
      expect(getModelSizeCategory('model:8b')).toBe('small');
    });

    it('returns medium for 9-20B', () => {
      expect(getModelSizeCategory('model:14b')).toBe('medium');
      expect(getModelSizeCategory('model:20b')).toBe('medium');
    });

    it('returns large for >20B', () => {
      expect(getModelSizeCategory('model:32b')).toBe('large');
      expect(getModelSizeCategory('model:70b')).toBe('large');
    });
  });

  describe('isSmallModel', () => {
    it('returns true for models with mini/tiny', () => {
      expect(isSmallModel('phi-mini')).toBe(true);
      expect(isSmallModel('TinyLlama')).toBe(true);
    });

    it('returns true for models <=8B', () => {
      expect(isSmallModel('model:7b')).toBe(true);
      expect(isSmallModel('model:8b')).toBe(true);
    });

    it('returns false for models >8B', () => {
      expect(isSmallModel('model:14b')).toBe(false);
      expect(isSmallModel('model:32b')).toBe(false);
    });

    it('returns false for null/empty', () => {
      expect(isSmallModel(null)).toBe(false);
      expect(isSmallModel('')).toBe(false);
    });
  });

  describe('isThinkingModel', () => {
    it('detects deepseek-r1', () => {
      expect(isThinkingModel('deepseek-r1')).toBe(true);
      expect(isThinkingModel('deepseek-r1:32b')).toBe(true);
    });

    it('detects qwq', () => {
      expect(isThinkingModel('qwq:32b')).toBe(true);
    });

    it('detects deepseek-r2', () => {
      expect(isThinkingModel('deepseek-r2:70b')).toBe(true);
    });

    it('detects /r1 path pattern', () => {
      expect(isThinkingModel('provider/r1-model')).toBe(true);
    });

    it('returns false for non-thinking models', () => {
      expect(isThinkingModel(TEST_MODELS.DEFAULT)).toBe(false);
      expect(isThinkingModel('llama3:70b')).toBe(false);
      expect(isThinkingModel(null)).toBe(false);
    });
  });
});
