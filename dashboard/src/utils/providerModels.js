// Models that belong to each provider family — used to hide stale model labels after failover
const PROVIDER_MODELS = {
  codex: /^(gpt-|codex|o[1-9])/i,
  'claude-cli': /^claude/i,
  anthropic: /^claude/i,
  groq: /^(llama|mixtral|gemma)/i,
  ollama: /^(qwen|codestral|llama|mistral|deepseek|phi|gemma|starcoder)/i,
  deepinfra: /^(qwen|llama|deepseek|meta-llama)/i,
  hyperbolic: /^(qwen|llama|deepseek|meta-llama)/i,
};

/**
 * Returns the model name only if it's relevant to the current provider.
 * Filters out stale models left over from provider failovers and
 * echo values where model === provider name.
 */
export function getRelevantModel(provider, model) {
  if (!model) return null;
  if (model === provider) return null;
  const pattern = PROVIDER_MODELS[provider];
  if (pattern && !pattern.test(model)) return null;
  return model;
}
