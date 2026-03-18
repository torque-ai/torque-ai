'use strict';

/**
 * Tests for chain-aware resolveProvider and resolveChain in template-store.js.
 * Also covers updated validateTemplate rules (string | array | mixed).
 */

const { resolveProvider, resolveChain, validateTemplate } = require('../routing/template-store');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validRules(overrides = {}) {
  return {
    security: 'ollama',
    xaml_wpf: 'ollama',
    architectural: 'ollama',
    reasoning: 'ollama',
    large_code_gen: 'ollama',
    documentation: 'ollama',
    simple_generation: 'ollama',
    targeted_file_edit: 'hashline-ollama',
    default: 'ollama',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveChain
// ---------------------------------------------------------------------------

describe('resolveChain', () => {
  it('returns wrapped single-entry chain for string rule', () => {
    const tmpl = { rules: { default: 'ollama', security: 'codex' } };
    const chain = resolveChain(tmpl, 'security', 'normal');
    expect(chain).toEqual([{ provider: 'codex' }]);
  });

  it('returns chain array as-is for array rule', () => {
    const chainRule = [{ provider: 'cerebras', model: 'fast' }, { provider: 'ollama' }];
    const tmpl = { rules: { default: 'ollama', security: chainRule } };
    const result = resolveChain(tmpl, 'security', 'normal');
    expect(result).toBe(chainRule); // same reference
  });

  it('checks complexity_overrides first before category rule', () => {
    const tmpl = {
      rules: { default: 'ollama', security: 'ollama' },
      complexity_overrides: { security: { complex: 'codex' } },
    };
    const chain = resolveChain(tmpl, 'security', 'complex');
    expect(chain).toEqual([{ provider: 'codex' }]);
  });

  it('falls back to category rule when no complexity override matches', () => {
    const tmpl = {
      rules: { default: 'ollama', security: 'deepinfra' },
      complexity_overrides: { security: { complex: 'codex' } },
    };
    // 'simple' has no override → uses rules.security
    const chain = resolveChain(tmpl, 'security', 'simple');
    expect(chain).toEqual([{ provider: 'deepinfra' }]);
  });

  it('falls back to default when category not found in rules', () => {
    const tmpl = { rules: { default: 'ollama' } };
    const chain = resolveChain(tmpl, 'unknown_category', 'normal');
    expect(chain).toEqual([{ provider: 'ollama' }]);
  });

  it('returns null when nothing matches (no category, no default)', () => {
    const tmpl = { rules: { security: 'ollama' } };
    const result = resolveChain(tmpl, 'unknown_category', 'normal');
    expect(result).toBeNull();
  });

  it('returns null for null template', () => {
    expect(resolveChain(null, 'security', 'normal')).toBeNull();
  });

  it('returns null for template without rules', () => {
    expect(resolveChain({}, 'security', 'normal')).toBeNull();
  });

  it('handles complexity_overrides with array chain', () => {
    const chainOverride = [{ provider: 'cerebras' }, { provider: 'ollama' }];
    const tmpl = {
      rules: { default: 'ollama', security: 'ollama' },
      complexity_overrides: { security: { complex: chainOverride } },
    };
    const result = resolveChain(tmpl, 'security', 'complex');
    expect(result).toBe(chainOverride);
  });
});

// ---------------------------------------------------------------------------
// resolveProvider
// ---------------------------------------------------------------------------

describe('resolveProvider', () => {
  it('returns object with .provider for string rule', () => {
    const tmpl = { rules: { default: 'ollama', security: 'codex' } };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(result).not.toBeNull();
    expect(result.provider).toBe('codex');
  });

  it('returns object with .model for chain entry that has a model', () => {
    const tmpl = {
      rules: {
        default: 'ollama',
        security: [{ provider: 'deepinfra', model: 'Qwen/Qwen2.5-72B-Instruct' }],
      },
    };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(result.provider).toBe('deepinfra');
    expect(result.model).toBe('Qwen/Qwen2.5-72B-Instruct');
  });

  it('returns null .model when chain entry has no model', () => {
    const tmpl = { rules: { default: 'ollama', security: 'codex' } };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(result.model).toBeNull();
  });

  it('returns object with .chain containing the full chain', () => {
    const chainRule = [
      { provider: 'cerebras' },
      { provider: 'ollama' },
    ];
    const tmpl = { rules: { default: 'ollama', security: chainRule } };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(result.chain).toBe(chainRule);
    expect(result.chain).toHaveLength(2);
  });

  it('String(result) returns the provider name for backward compatibility', () => {
    const tmpl = { rules: { default: 'ollama', security: 'cerebras' } };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(String(result)).toBe('cerebras');
  });

  it('result == provider string via valueOf for backward compatibility', () => {
    const tmpl = { rules: { default: 'ollama', security: 'cerebras' } };
    const result = resolveProvider(tmpl, 'security', 'normal');
    // eslint-disable-next-line eqeqeq
    expect(result == 'cerebras').toBe(true);
  });

  it('returns null for null template', () => {
    expect(resolveProvider(null, 'security', 'normal')).toBeNull();
  });

  it('returns null for template without rules', () => {
    expect(resolveProvider({}, 'security', 'normal')).toBeNull();
  });

  it('handles legacy string format — selects first entry after wrapping', () => {
    const tmpl = { rules: { default: 'ollama', security: 'codex' } };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(result.chain).toEqual([{ provider: 'codex' }]);
    expect(result.provider).toBe('codex');
  });

  it('selects the first chain entry as provider', () => {
    const tmpl = {
      rules: {
        default: 'ollama',
        security: [
          { provider: 'cerebras', model: 'model-a' },
          { provider: 'ollama' },
        ],
      },
    };
    const result = resolveProvider(tmpl, 'security', 'normal');
    expect(result.provider).toBe('cerebras');
    expect(result.model).toBe('model-a');
  });

  it('falls back to default rule when category not found', () => {
    const tmpl = { rules: { default: 'ollama' } };
    const result = resolveProvider(tmpl, 'unknown_cat', 'normal');
    expect(result.provider).toBe('ollama');
  });
});

// ---------------------------------------------------------------------------
// validateTemplate — chain format support
// ---------------------------------------------------------------------------

describe('validateTemplate — chain format', () => {
  it('accepts legacy string format (no change in behavior)', () => {
    const result = validateTemplate({ name: 'String Format', rules: validRules() });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts chain array format with {provider, model} entries', () => {
    const result = validateTemplate({
      name: 'Chain Format',
      rules: validRules({
        security: [
          { provider: 'cerebras', model: 'fast' },
          { provider: 'ollama' },
        ],
      }),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts mixed format (some strings, some arrays)', () => {
    const result = validateTemplate({
      name: 'Mixed Format',
      rules: validRules({
        security: [{ provider: 'codex' }],
        reasoning: 'deepinfra',
      }),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects chain with > 7 entries', () => {
    const tooLong = Array.from({ length: 8 }, (_, i) => ({ provider: `p${i}` }));
    const result = validateTemplate({
      name: 'Too Long Chain',
      rules: validRules({ security: tooLong }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /chain exceeds maximum length of 7/i.test(e))).toBe(true);
  });

  it('rejects chain entry without a provider string', () => {
    const result = validateTemplate({
      name: 'Bad Entry',
      rules: validRules({
        security: [{ model: 'no-provider-here' }],
      }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /chain entry must have a provider string/i.test(e))).toBe(true);
  });

  it('rejects empty chain array', () => {
    const result = validateTemplate({
      name: 'Empty Chain',
      rules: validRules({ security: [] }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /chain must have at least one entry/i.test(e))).toBe(true);
  });

  it('rejects non-string, non-array values in rules', () => {
    const result = validateTemplate({
      name: 'Bad Type',
      rules: validRules({ security: 42 }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /must be a string or array/i.test(e))).toBe(true);
  });

  it('accepts chain in complexity_overrides', () => {
    const result = validateTemplate({
      name: 'Override Chain',
      rules: validRules(),
      complexity_overrides: {
        security: {
          complex: [{ provider: 'cerebras' }, { provider: 'codex' }],
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects chain entry without provider in complexity_overrides', () => {
    const result = validateTemplate({
      name: 'Bad Override Chain',
      rules: validRules(),
      complexity_overrides: {
        security: {
          complex: [{ model: 'no-provider' }],
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /chain entry must have a provider string/i.test(e))).toBe(true);
  });

  it('rejects empty chain in complexity_overrides', () => {
    const result = validateTemplate({
      name: 'Empty Override Chain',
      rules: validRules(),
      complexity_overrides: {
        security: { complex: [] },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /chain must have at least one entry/i.test(e))).toBe(true);
  });
});
