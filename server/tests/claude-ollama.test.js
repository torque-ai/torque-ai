'use strict';

const ClaudeOllamaProvider = require('../providers/claude-ollama');

describe('ClaudeOllamaProvider — construction', () => {
  it('has provider name "claude-ollama"', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.name).toBe('claude-ollama');
  });

  it('defaults to enabled=false (opt-in provider)', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.enabled).toBe(false);
  });

  it('respects config.enabled=true', () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    expect(p.enabled).toBe(true);
  });

  it('exposes supportsStreaming=true', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.supportsStreaming).toBe(true);
  });

  it('derives providerId for config lookups', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.providerId).toBe('claude-ollama');
  });
});
