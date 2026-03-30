import { describe, expect, it } from 'vitest';
import { getRelevantModel } from './providerModels.js';

describe('getRelevantModel', () => {
  it('returns null when model is null or undefined', () => {
    expect(getRelevantModel('codex', null)).toBeNull();
    expect(getRelevantModel('codex', undefined)).toBeNull();
  });

  it('returns null when model equals provider name', () => {
    expect(getRelevantModel('codex', 'codex')).toBeNull();
  });

  it('returns null when model belongs to a different provider family', () => {
    expect(getRelevantModel('ollama', 'gpt-5.3-codex-spark')).toBeNull();
  });

  it('returns the model when it matches the provider family', () => {
    expect(getRelevantModel('ollama', 'qwen2.5-coder:32b')).toBe('qwen2.5-coder:32b');
  });

  it('returns the model for matching codex provider/model', () => {
    expect(getRelevantModel('codex', 'gpt-5.3-codex-spark')).toBe('gpt-5.3-codex-spark');
  });

  it('returns null for mismatched codex provider/model', () => {
    expect(getRelevantModel('codex', 'qwen2.5-coder:32b')).toBeNull();
  });

  it('returns the model for unknown providers', () => {
    expect(getRelevantModel('custom-provider', 'whatever-model')).toBe('whatever-model');
  });

  it('returns null for openai-style models on ollama-based providers', () => {
    expect(getRelevantModel('ollama', 'gpt-4')).toBeNull();
  });
});
