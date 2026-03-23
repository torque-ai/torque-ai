'use strict';

/**
 * server/providers/agentic-capability.js — Capability detection for agentic tool calling.
 *
 * Determines whether a given provider+model combination supports OpenAI-compatible
 * tool/function calling. Uses a three-layer resolution strategy:
 *
 *   Excluded providers (hardcoded) → Config override → Probe cache (DB) → Whitelist → Default
 *
 * Usage:
 *   const { init, isAgenticCapable } = require('./agentic-capability');
 *   init({ db, serverConfig });
 *   const { capable, reason, source } = isAgenticCapable('ollama', 'my-model:14b');
 */

// ── Excluded providers ────────────────────────────────────────────────────────
// These providers use their own execution paths and must never be routed through
// the agentic tool-calling loop.

const EXCLUDED_PROVIDERS = new Set(['hashline-ollama', 'codex', 'claude-cli']);

// ── Cloud providers known to support OpenAI-compatible tool calling ───────────

// Note: openrouter free models have intermittent tool support (rate-limited).
// nemotron-3-nano-30b-a3b:free confirmed working. Falls back to legacy if tools fail.
const CLOUD_TOOL_CAPABLE = new Set(['groq', 'cerebras', 'deepinfra', 'hyperbolic', 'google-ai', 'ollama-cloud', 'openrouter']);

// ── Model name prefixes (lowercased) known to support tool calling ────────────

const WHITELIST_PREFIXES = [
  'qwen2.5-coder',
  'qwen3',
  'qwen-3',
  'codestral',
  'devstral',
  'deepseek',
  'llama3.1',
  'llama3.2',
  'llama3.3',
  'llama-3.1',
  'llama-3.2',
  'llama-3.3',
  'mistral',
  'command-r',
  'gemma2',
  'gemma3',
  'gemini',
  'kimi',
];

// ── Models that need prompt-injected tools (no native Ollama .Tools template) ─
// These models understand tool calling but their Ollama Modelfile template
// doesn't handle the tools parameter. Tools are injected via [AVAILABLE_TOOLS]
// in the system prompt, and results come back as [TOOL_RESULTS] user messages.
const PROMPT_INJECTION_PREFIXES = [
  'codestral',
  // Note: mistral-large-3 supports native tools on ollama-cloud (tested 2026-03-18)
];

// ── Module-level state (dependency injection) ─────────────────────────────────

let _db = null;
let _serverConfig = null;

/**
 * Inject dependencies. Call once at startup.
 * @param {{ db?: object, serverConfig?: object }} deps
 */
function init({ db, serverConfig } = {}) {
  if (db !== undefined) _db = db;
  if (serverConfig !== undefined) _serverConfig = serverConfig;
}

/**
 * Lazily get the serverConfig — falls back to requiring '../config' if not injected.
 */
function getServerConfig() {
  if (_serverConfig) return _serverConfig;
  // Lazy-require so the module can be loaded without circular issues at startup
  _serverConfig = require('../config');
  return _serverConfig;
}

// ── Core resolution ───────────────────────────────────────────────────────────

/**
 * Determine whether a provider+model combination supports agentic tool calling.
 *
 * @param {string} provider
 * @param {string} [model]
 * @returns {{ capable: boolean, reason: string, source: 'config'|'probe'|'whitelist'|'default' }}
 */
function isAgenticCapable(provider, model) {
  // ── Step 0: Excluded providers ─────────────────────────────────────────────
  if (EXCLUDED_PROVIDERS.has(provider)) {
    if (provider === 'hashline-ollama') {
      return { capable: false, reason: 'hashline protocol preferred', source: 'config' };
    }
    return { capable: false, reason: `${provider} uses its own CLI execution path`, source: 'config' };
  }

  const cfg = getServerConfig();

  // ── Layer 1: Config overrides ──────────────────────────────────────────────

  // Global kill switch
  const globalEnabled = cfg.get('agentic_enabled');
  if (globalEnabled === '0') {
    return { capable: false, reason: 'agentic_enabled is disabled globally', source: 'config' };
  }

  // Per-provider override (e.g., agentic_provider_google_ai)
  const providerKey = `agentic_provider_${provider.replace(/-/g, '_')}`;
  const providerOverride = cfg.get(providerKey);
  if (providerOverride === '0') {
    return { capable: false, reason: `agentic disabled for provider ${provider}`, source: 'config' };
  }
  if (providerOverride === '1') {
    return { capable: true, reason: `agentic enabled for provider ${provider} via config`, source: 'config' };
  }

  // ── Layer 2: Probe cache ───────────────────────────────────────────────────

  if (_db && model) {
    try {
      // Raw _db.prepare() used here because the database abstraction layer does
      // not expose an agentic-probe query helper. The query is read-only and
      // fully parameterized — no user input reaches the SQL.
      const row = _db.prepare(
        'SELECT supports_tools FROM agentic_model_probes WHERE model_name = ? AND provider = ?'
      ).get(model, provider);

      if (row !== undefined && row !== null) {
        if (row.supports_tools) {
          return { capable: true, reason: 'probe cache confirmed tool support', source: 'probe' };
        }
        return { capable: false, reason: 'probe cache reported no tool support', source: 'probe' };
      }
      // Not found → fall through to whitelist
    } catch (_e) {
      // Table may not exist yet (first run before migration) — fall through silently
    }
  }

  // ── Layer 3: Whitelist ─────────────────────────────────────────────────────

  // Cloud providers are all assumed tool-capable
  if (CLOUD_TOOL_CAPABLE.has(provider)) {
    return { capable: true, reason: `${provider} is a known tool-capable cloud provider`, source: 'whitelist' };
  }

  if (model) {
    const modelLower = model.toLowerCase();

    // Custom whitelist from config (comma-separated prefixes)
    const customWhitelistRaw = cfg.get('agentic_whitelist');
    if (customWhitelistRaw) {
      const customPrefixes = customWhitelistRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      for (const prefix of customPrefixes) {
        if (modelLower.startsWith(prefix)) {
          return { capable: true, reason: `model matched custom whitelist prefix '${prefix}'`, source: 'whitelist' };
        }
      }
    }

    // Built-in whitelist
    for (const prefix of WHITELIST_PREFIXES) {
      if (modelLower.startsWith(prefix.toLowerCase())) {
        return { capable: true, reason: `model matched built-in whitelist prefix '${prefix}'`, source: 'whitelist' };
      }
    }
  }

  // ── Default: not capable ───────────────────────────────────────────────────

  return { capable: false, reason: 'model not recognized as tool-capable', source: 'default' };
}

/**
 * Check if a model needs prompt-injected tools (no native Ollama .Tools template support).
 * @param {string} model
 * @returns {boolean}
 */
function needsPromptInjection(model) {
  if (!model) return false;
  const modelLower = model.toLowerCase();
  return PROMPT_INJECTION_PREFIXES.some(prefix => modelLower.startsWith(prefix.toLowerCase()));
}

module.exports = { init, isAgenticCapable, needsPromptInjection, EXCLUDED_PROVIDERS, CLOUD_TOOL_CAPABLE, WHITELIST_PREFIXES, PROMPT_INJECTION_PREFIXES };
