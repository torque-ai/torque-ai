'use strict';

/**
 * Unit Tests: family-classifier — model name → family + size parsing
 */

const {
  classifyModel,
  getSizeBucket,
  suggestRole,
  extractBaseName,
  parseSizeFromName,
  estimateSizeFromBytes,
  FAMILY_PATTERNS,
} = require('../discovery/family-classifier');

describe('FAMILY_PATTERNS', () => {
  it('exports an array of {pattern, family} objects', () => {
    expect(Array.isArray(FAMILY_PATTERNS)).toBe(true);
    expect(FAMILY_PATTERNS.length).toBeGreaterThan(0);
    for (const entry of FAMILY_PATTERNS) {
      expect(entry).toHaveProperty('pattern');
      expect(entry).toHaveProperty('family');
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.family).toBe('string');
    }
  });
});

describe('extractBaseName', () => {
  it('strips Ollama tag', () => {
    expect(extractBaseName('qwen3-coder:30b')).toBe('qwen3-coder');
  });

  it('strips org prefix from cloud-style names', () => {
    expect(extractBaseName('Qwen/Qwen3-235B-A22B')).toBe('Qwen3-235B-A22B');
    expect(extractBaseName('meta-llama/Llama-3.1-70B-Instruct')).toBe('Llama-3.1-70B-Instruct');
  });

  it('returns name unchanged when no tag or prefix', () => {
    expect(extractBaseName('codellama')).toBe('codellama');
    expect(extractBaseName('mistral')).toBe('mistral');
  });
});

describe('parseSizeFromName', () => {
  it('parses Ollama colon tag like :30b', () => {
    expect(parseSizeFromName('qwen3-coder:30b')).toBeCloseTo(30, 0);
  });

  it('parses cloud-style embedded size like -235B-', () => {
    expect(parseSizeFromName('Qwen3-235B-A22B')).toBeCloseTo(235, 0);
  });

  it('parses decimal sizes like :3.8b', () => {
    expect(parseSizeFromName('phi3:3.8b')).toBeCloseTo(3.8, 1);
  });

  it('returns null when no size present', () => {
    expect(parseSizeFromName('codellama')).toBeNull();
    expect(parseSizeFromName('some-custom-model:latest')).toBeNull();
  });
});

describe('estimateSizeFromBytes', () => {
  it('estimates size using Q4 heuristic (~0.5625 bytes/param)', () => {
    // 18556700761 bytes / 0.5625 / 1e9 ≈ 32.98B → rounds to ~33B
    const result = estimateSizeFromBytes(18556700761);
    expect(result).toBeGreaterThan(25);
    expect(result).toBeLessThan(40);
  });

  it('returns null for falsy input', () => {
    expect(estimateSizeFromBytes(null)).toBeNull();
    expect(estimateSizeFromBytes(0)).toBeNull();
    expect(estimateSizeFromBytes(undefined)).toBeNull();
  });
});

describe('classifyModel', () => {
  it('classifies qwen3-coder:30b correctly', () => {
    const result = classifyModel('qwen3-coder:30b');
    expect(result.family).toBe('qwen3');
    expect(result.parameterSizeB).toBeCloseTo(30, 0);
  });

  it('classifies qwen2.5-coder:32b correctly', () => {
    const result = classifyModel('qwen2.5-coder:32b');
    expect(result.family).toBe('qwen2.5');
    expect(result.parameterSizeB).toBeCloseTo(32, 0);
  });

  it('classifies llama3.1:70b correctly', () => {
    const result = classifyModel('llama3.1:70b');
    expect(result.family).toBe('llama');
    expect(result.parameterSizeB).toBeCloseTo(70, 0);
  });

  it('classifies gemma3:4b correctly', () => {
    const result = classifyModel('gemma3:4b');
    expect(result.family).toBe('gemma');
    expect(result.parameterSizeB).toBeCloseTo(4, 0);
  });

  it('classifies codestral:22b correctly', () => {
    const result = classifyModel('codestral:22b');
    expect(result.family).toBe('codestral');
    expect(result.parameterSizeB).toBeCloseTo(22, 0);
  });

  it('classifies deepseek-r1:14b correctly', () => {
    const result = classifyModel('deepseek-r1:14b');
    expect(result.family).toBe('deepseek');
    expect(result.parameterSizeB).toBeCloseTo(14, 0);
  });

  it('classifies cloud-style Qwen/Qwen3-235B-A22B correctly', () => {
    const result = classifyModel('Qwen/Qwen3-235B-A22B');
    expect(result.family).toBe('qwen3');
    expect(result.parameterSizeB).toBeCloseTo(235, 0);
  });

  it('classifies cloud-style meta-llama/Llama-3.1-70B-Instruct correctly', () => {
    const result = classifyModel('meta-llama/Llama-3.1-70B-Instruct');
    expect(result.family).toBe('llama');
    expect(result.parameterSizeB).toBeCloseTo(70, 0);
  });

  it('classifies codellama (no size tag) correctly', () => {
    const result = classifyModel('codellama');
    expect(result.family).toBe('codellama');
    expect(result.parameterSizeB).toBeNull();
  });

  it('returns unknown family for unrecognized model', () => {
    const result = classifyModel('some-custom-model:latest');
    expect(result.family).toBe('unknown');
  });

  it('estimates parameterSizeB from sizeBytes when tag is :latest', () => {
    const result = classifyModel('qwen3-coder:latest', { sizeBytes: 18556700761 });
    expect(result.family).toBe('qwen3');
    expect(result.parameterSizeB).toBeGreaterThan(25);
    expect(result.parameterSizeB).toBeLessThan(40);
  });

  it('classifies phi3:3.8b correctly', () => {
    const result = classifyModel('phi3:3.8b');
    expect(result.family).toBe('phi');
    expect(result.parameterSizeB).toBeCloseTo(3.8, 1);
  });

  it('classifies mistral:7b correctly', () => {
    const result = classifyModel('mistral:7b');
    expect(result.family).toBe('mistral');
    expect(result.parameterSizeB).toBeCloseTo(7, 0);
  });

  it('classifies devstral:24b correctly', () => {
    const result = classifyModel('devstral:24b');
    expect(result.family).toBe('devstral');
    expect(result.parameterSizeB).toBeCloseTo(24, 0);
  });

  it('includes baseName in the returned object', () => {
    const result = classifyModel('qwen3-coder:30b');
    expect(result).toHaveProperty('baseName');
    expect(typeof result.baseName).toBe('string');
  });
});

describe('getSizeBucket', () => {
  it('returns small for sizes < 10B', () => {
    expect(getSizeBucket(7)).toBe('small');
    expect(getSizeBucket(3.8)).toBe('small');
    expect(getSizeBucket(9.9)).toBe('small');
  });

  it('returns medium for sizes 10-30B inclusive', () => {
    expect(getSizeBucket(14)).toBe('medium');
    expect(getSizeBucket(10)).toBe('medium');
    expect(getSizeBucket(30)).toBe('medium');
  });

  it('returns large for sizes > 30B', () => {
    expect(getSizeBucket(32)).toBe('large');
    expect(getSizeBucket(70)).toBe('large');
    expect(getSizeBucket(235)).toBe('large');
  });

  it('returns null for null input', () => {
    expect(getSizeBucket(null)).toBeNull();
    expect(getSizeBucket(undefined)).toBeNull();
  });
});

describe('suggestRole', () => {
  it('returns fast for sizes < 10B', () => {
    expect(suggestRole(4)).toBe('fast');
    expect(suggestRole(7)).toBe('fast');
  });

  it('returns balanced for sizes 10-30B', () => {
    expect(suggestRole(14)).toBe('balanced');
    expect(suggestRole(22)).toBe('balanced');
  });

  it('returns quality for sizes > 30B', () => {
    expect(suggestRole(32)).toBe('quality');
    expect(suggestRole(70)).toBe('quality');
  });

  it('returns default for null', () => {
    expect(suggestRole(null)).toBe('default');
    expect(suggestRole(undefined)).toBe('default');
  });
});
