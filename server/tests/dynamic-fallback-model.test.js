import { describe, it, expect, vi } from 'vitest';
import { getDefaultFallbackModel, DEFAULT_FALLBACK_MODEL } from '../constants.js';
import { TEST_MODELS } from './test-helpers.js';

describe('getDefaultFallbackModel', () => {
  it('returns model_roles entry when db has ollama/default role', () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ model_name: TEST_MODELS.DEFAULT }),
      }),
    };

    const result = getDefaultFallbackModel(mockDb);
    expect(result).toBe(TEST_MODELS.DEFAULT);
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining('model_roles')
    );
  });

  it('returns static fallback when db is null', () => {
    const result = getDefaultFallbackModel(null);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe(DEFAULT_FALLBACK_MODEL);
  });

  it('returns static fallback when db has no model_roles entries', () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
      }),
    };

    const result = getDefaultFallbackModel(mockDb);
    expect(result).toBe(DEFAULT_FALLBACK_MODEL);
  });

  it('returns model_registry entry when model_roles is empty but approved model exists', () => {
    const prepareMock = vi.fn();
    // First call: model_roles query → no result
    // Second call: model_registry query → has a result
    prepareMock
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(undefined) })
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ model_name: 'llama3.1:8b' }) });

    const mockDb = { prepare: prepareMock };

    const result = getDefaultFallbackModel(mockDb);
    expect(result).toBe('llama3.1:8b');
    expect(prepareMock).toHaveBeenCalledTimes(2);
    expect(prepareMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('model_registry')
    );
  });
});
