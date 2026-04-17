import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSafeEnv, SAFE_ENV_KEYS as _SAFE_ENV_KEYS, BLOCKED_KEYS, PROVIDER_KEYS } from '../utils/safe-env.js';

describe('safe-env', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Set up test env vars
    process.env.PATH = '/usr/bin:/usr/local/bin';
    process.env.HOME = '/home/<user>
    process.env.OPENAI_API_KEY = 'sk-test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic-key';
    process.env.DEEPINFRA_API_KEY = 'sk-test-deepinfra-key';
    process.env.HYPERBOLIC_API_KEY = 'sk-test-hyperbolic-key';
    process.env.GROQ_API_KEY = 'gsk-test-groq-key';
    process.env.CEREBRAS_API_KEY = 'sk-test-cerebras-key';
    process.env.OPENROUTER_API_KEY = 'sk-test-openrouter-key';
    process.env.OLLAMA_CLOUD_API_KEY = 'sk-test-ollama-cloud-key';
    process.env.NODE_OPTIONS = '--require /tmp/backdoor.js';
    process.env.LD_PRELOAD = '/tmp/evil.so';
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/evil.dylib';
    process.env.SUPER_SECRET_INTERNAL = 'should-not-leak';
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('includes safe system keys', () => {
    const env = buildSafeEnv('codex');
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
  });

  it('includes provider-specific API key for codex', () => {
    const env = buildSafeEnv('codex');
    expect(env.OPENAI_API_KEY).toBe('sk-test-openai-key');
  });

  it('does NOT include other providers API keys for codex', () => {
    const env = buildSafeEnv('codex');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DEEPINFRA_API_KEY).toBeUndefined();
    expect(env.HYPERBOLIC_API_KEY).toBeUndefined();
    expect(env.GROQ_API_KEY).toBeUndefined();
  });

  it('includes ANTHROPIC_API_KEY only for claude-cli', () => {
    const env = buildSafeEnv('claude-cli');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test-anthropic-key');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DEEPINFRA_API_KEY).toBeUndefined();
  });

  it('includes ANTHROPIC_API_KEY only for claude-code-sdk', () => {
    const env = buildSafeEnv('claude-code-sdk');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test-anthropic-key');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DEEPINFRA_API_KEY).toBeUndefined();
  });

  it('includes CEREBRAS_API_KEY only for cerebras', () => {
    const env = buildSafeEnv('cerebras');
    expect(env.CEREBRAS_API_KEY).toBe('sk-test-cerebras-key');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.OLLAMA_CLOUD_API_KEY).toBeUndefined();
  });

  it('includes OPENROUTER_API_KEY only for openrouter', () => {
    const env = buildSafeEnv('openrouter');
    expect(env.OPENROUTER_API_KEY).toBe('sk-test-openrouter-key');
    expect(env.CEREBRAS_API_KEY).toBeUndefined();
    expect(env.OLLAMA_CLOUD_API_KEY).toBeUndefined();
  });

  it('includes OLLAMA_CLOUD_API_KEY only for ollama-cloud', () => {
    const env = buildSafeEnv('ollama-cloud');
    expect(env.OLLAMA_CLOUD_API_KEY).toBe('sk-test-ollama-cloud-key');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.CEREBRAS_API_KEY).toBeUndefined();
  });

  it('NEVER includes NODE_OPTIONS', () => {
    const env = buildSafeEnv('codex');
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('NEVER includes LD_PRELOAD', () => {
    const env = buildSafeEnv('codex');
    expect(env.LD_PRELOAD).toBeUndefined();
  });

  it('NEVER includes DYLD_INSERT_LIBRARIES', () => {
    const env = buildSafeEnv('codex');
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
  });

  it('blocks NODE_OPTIONS even when passed as extras', () => {
    const env = buildSafeEnv('codex', { NODE_OPTIONS: '--inspect' });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('blocks LD_PRELOAD even when passed as extras', () => {
    const env = buildSafeEnv('codex', { LD_PRELOAD: '/tmp/evil.so' });
    expect(env.LD_PRELOAD).toBeUndefined();
  });

  it('does NOT include arbitrary env vars', () => {
    const env = buildSafeEnv('codex');
    expect(env.SUPER_SECRET_INTERNAL).toBeUndefined();
  });

  it('merges extras correctly', () => {
    const env = buildSafeEnv('codex', { TORQUE_TASK_ID: 'task-123', CI: '1' });
    expect(env.TORQUE_TASK_ID).toBe('task-123');
    expect(env.CI).toBe('1');
  });

  it('handles unknown provider gracefully', () => {
    const env = buildSafeEnv('unknown-provider');
    expect(env.PATH).toBeDefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('handles null provider', () => {
    const env = buildSafeEnv(null);
    expect(env.PATH).toBeDefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('handles undefined provider', () => {
    const env = buildSafeEnv(undefined);
    expect(env.PATH).toBeDefined();
  });

  it('all BLOCKED_KEYS are excluded from every provider', () => {
    for (const provider of Object.keys(PROVIDER_KEYS)) {
      const env = buildSafeEnv(provider);
      for (const blocked of BLOCKED_KEYS) {
        expect(env[blocked]).toBeUndefined();
      }
    }
  });
});
