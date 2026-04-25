'use strict';

function buildErrorMessage(service, status, errorBody, retryAfterSeconds) {
  const isAuthError = status === 401 || status === 403;
  let message = `${service} API error (${status}): ${isAuthError ? 'authentication failed or unauthorized: ' : ''}${errorBody}`;

  if (retryAfterSeconds !== null) {
    message += ` retry_after_seconds=${retryAfterSeconds}`;
  }

  return message;
}

/**
 * True when the caller signaled they want strict JSON output. Accepts both
 * the bare-string convention used by TORQUE callers ('json_object' /
 * 'json') and the OpenAI-shaped object form ({ type: 'json_object' }).
 */
function isJsonModeRequested(options = {}) {
  const rf = options.responseFormat;
  if (rf === 'json_object' || rf === 'json') return true;
  if (rf && typeof rf === 'object' && rf.type === 'json_object') return true;
  return false;
}

/**
 * Build the request body for an OpenAI-compatible Chat Completions API.
 * Centralizes JSON-mode handling, system-prompt separation, top_p, and
 * temperature defaults so each provider adapter (groq/deepinfra/cerebras/
 * hyperbolic/openrouter/ollama-cloud) doesn't reimplement the same logic.
 *
 * Provider-specific concerns (selecting a smarter model when JSON mode is
 * on, custom max_tokens defaults, base URL) stay in the provider class.
 *
 * Inputs:
 *   - task: the user prompt string
 *   - options: { responseFormat?, systemPrompt?, maxTokens?, tuning? }
 *   - opts: { stream?, model, buildPrompt: (task, options) => string }
 *
 * Returns the body object ready to JSON.stringify and POST.
 */
function buildOpenAIChatBody(task, options = {}, { stream = false, model, buildPrompt } = {}) {
  if (typeof buildPrompt !== 'function') {
    throw new TypeError('buildOpenAIChatBody requires opts.buildPrompt');
  }
  if (!model) {
    throw new TypeError('buildOpenAIChatBody requires opts.model');
  }

  const messages = [];
  if (typeof options.systemPrompt === 'string' && options.systemPrompt.trim() !== '') {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push({ role: 'user', content: buildPrompt(task, options) });

  const body = {
    model,
    messages,
    max_tokens: options.maxTokens || 4096,
  };
  if (stream) body.stream = true;

  const jsonMode = isJsonModeRequested(options);
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  if (options.tuning?.temperature !== undefined) {
    body.temperature = options.tuning.temperature;
  } else if (jsonMode) {
    // JSON-mode default: deterministic. Markdown wrap-around and key
    // ordering drift come from temperature; for structured output they
    // are noise, never signal.
    body.temperature = 0;
  }
  if (options.tuning?.top_p !== undefined) {
    body.top_p = options.tuning.top_p;
  }

  return body;
}

module.exports = { buildErrorMessage, buildOpenAIChatBody, isJsonModeRequested };
