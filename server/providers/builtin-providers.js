'use strict';

/**
 * providers/builtin-providers.js — register the 11 built-in provider classes.
 *
 * Each entry pairs a logical provider name (used in routing config and task
 * metadata) with the constructor that implements its execution. The registry
 * itself stays generic; this module is the canonical list.
 *
 * Extracted from task-manager.js's initEarlyDeps() so adding/removing a
 * provider doesn't require touching the task-manager composition root.
 */

function registerBuiltinProviders(providerRegistry) {
  providerRegistry.registerProviderClass('codex', require('./v2-cli-providers').CodexCliProvider);
  providerRegistry.registerProviderClass('claude-code-sdk', require('./claude-code-sdk'));
  providerRegistry.registerProviderClass('claude-ollama', require('./claude-ollama'));
  providerRegistry.registerProviderClass('anthropic', require('./anthropic'));
  providerRegistry.registerProviderClass('groq', require('./groq'));
  providerRegistry.registerProviderClass('hyperbolic', require('./hyperbolic'));
  providerRegistry.registerProviderClass('deepinfra', require('./deepinfra'));
  providerRegistry.registerProviderClass('ollama-cloud', require('./ollama-cloud'));
  providerRegistry.registerProviderClass('cerebras', require('./cerebras'));
  providerRegistry.registerProviderClass('google-ai', require('./google-ai'));
  providerRegistry.registerProviderClass('openrouter', require('./openrouter'));
}

module.exports = { registerBuiltinProviders };
