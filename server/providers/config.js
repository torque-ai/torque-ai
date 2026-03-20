'use strict';

/**
 * providers/config.js — Centralized provider configuration resolution.
 *
 * Replaces scattered db.getConfig() calls for:
 * - Context enrichment flags (was duplicated 4× across 3 files)
 * - Ollama tuning parameter cascade (was duplicated 2× in execute-ollama/hashline)
 * - Provider enable/disable checks (was inconsistent: === '1' vs !== '0')
 */

const { PROVIDER_DEFAULTS } = require('../constants');
const logger = require('../logger').child({ component: 'provider-config' });

let db = null;

const HASHLINE_OLLAMA_DEFAULTS = Object.freeze({
  temperature: 0.15,
  numPredict: 4096,
});
const HASHLINE_GLOBAL_BASELINE = Object.freeze({
  temperature: '0.3',
  numPredict: '-1',
});

function init(deps) {
  if (deps.db) db = deps.db;
}

// ── Enrichment Config ──────────────────────────────────────────────────

/**
 * Read context enrichment settings. Was duplicated in:
 * - execute-hashline.js (×2)
 * - task-manager.js (×2)
 *
 * @returns {{ enabled: boolean, enableImports: boolean, enableTests: boolean, enableGit: boolean, enableFewShot: boolean }}
 */
function getEnrichmentConfig() {
  if (!db) throw new Error('providers/config: module not initialized — call init() first');
  const enabled = db.getConfig('context_enrichment_enabled') !== '0';
  if (!enabled) {
    return { enabled: false, enableImports: false, enableTests: false, enableGit: false, enableFewShot: false };
  }
  return {
    enabled: true,
    enableImports: true, // always true when enrichment is enabled
    enableTests: db.getConfig('enrichment_tests') !== '0',
    enableGit: db.getConfig('enrichment_git') !== '0',
    enableFewShot: db.getConfig('enrichment_fewshot') !== '0',
  };
}

// ── Ollama Tuning Resolution ───────────────────────────────────────────

/**
 * Resolve Ollama tuning parameters through the 4-layer cascade:
 *   Layer 1: Global DB config defaults
 *   Layer 1.5: Per-host settings (optional)
 *   Layer 2: Auto-tuning rules (optional, execute-ollama only)
 *   Layer 3: Model-specific settings (optional)
 *   Layer 4: Per-task metadata overrides (highest priority)
 *
 * Was duplicated in execute-ollama.js (~70 lines) and execute-hashline.js (~50 lines).
 *
 * @param {Object} opts
 * @param {number} [opts.hostId] — selected host ID for per-host overrides
 * @param {string} [opts.model] — model name for model-specific settings
 * @param {Object} [opts.task] — task object for per-task overrides
 * @param {Object} [opts.adaptiveCtx] — adaptive context estimate (from estimateRequiredContext)
 * @param {boolean} [opts.includeAutoTuning=false] — whether to apply auto-tuning rules (Layer 2)
 * @param {boolean} [opts.includeHardware=false] — whether to read hardware params (numGpu, numThread, keepAlive)
 * @param {string} [opts.profile] — optional provider profile for base defaults (e.g. 'hashline')
 * @returns {Object} Resolved tuning parameters
 */
function resolveOllamaTuning(opts = {}) {
  if (!db) throw new Error('providers/config: module not initialized — call init() first');
  const { hostId, model, task, adaptiveCtx, includeAutoTuning = false, includeHardware = false, profile = 'default' } = opts;
  const baseDefaults = profile === 'hashline'
    ? HASHLINE_OLLAMA_DEFAULTS
    : { temperature: 0.3, numPredict: -1 };
  const globalTemperatureRaw = db.getConfig('ollama_temperature');
  const globalNumPredictRaw = db.getConfig('ollama_num_predict');
  const shouldUseHashlineTemperatureDefault = profile === 'hashline'
    && (globalTemperatureRaw == null || globalTemperatureRaw === HASHLINE_GLOBAL_BASELINE.temperature);
  const shouldUseHashlineNumPredictDefault = profile === 'hashline'
    && (globalNumPredictRaw == null || globalNumPredictRaw === HASHLINE_GLOBAL_BASELINE.numPredict);

  // Layer 1: Global defaults from config
  let temperature = parseFloat(
    shouldUseHashlineTemperatureDefault
      ? String(baseDefaults.temperature)
      : (globalTemperatureRaw || String(baseDefaults.temperature))
  );
  let numCtx = adaptiveCtx ? adaptiveCtx.contextSize : parseInt(db.getConfig('ollama_num_ctx') || String(PROVIDER_DEFAULTS.OLLAMA_DEFAULT_CONTEXT), 10);
  let topP = parseFloat(db.getConfig('ollama_top_p') || '0.9');
  let repeatPenalty = parseFloat(db.getConfig('ollama_repeat_penalty') || '1.1');
  let numPredict = parseInt(
    shouldUseHashlineNumPredictDefault
      ? String(baseDefaults.numPredict)
      : (globalNumPredictRaw || String(baseDefaults.numPredict)),
    10
  );
  let topK = parseInt(db.getConfig('ollama_top_k') || '40', 10);
  let mirostat = parseInt(db.getConfig('ollama_mirostat') || '0', 10);
  const mirostatTau = parseFloat(db.getConfig('ollama_mirostat_tau') || '5.0');
  const mirostatEta = parseFloat(db.getConfig('ollama_mirostat_eta') || '0.1');
  const seed = db.getConfig('ollama_seed');

  // Hardware params (execute-ollama only)
  let numGpu = -1, numThread = 0, keepAlive = '5m';
  if (includeHardware) {
    numGpu = parseInt(db.getConfig('ollama_num_gpu') || '-1', 10);
    numThread = parseInt(db.getConfig('ollama_num_thread') || '0', 10);
    keepAlive = db.getConfig('ollama_keep_alive') || '5m';
  }

  // Layer 1.5: Per-host settings
  if (hostId && typeof db.getHostSettings === 'function') {
    const hostSettings = db.getHostSettings(hostId);
    if (hostSettings) {
      const shouldIgnoreHostTemperature = profile === 'hashline'
        && shouldUseHashlineTemperatureDefault
        && hostSettings.temperature === parseFloat(HASHLINE_GLOBAL_BASELINE.temperature);
      if (hostSettings.temperature !== undefined && !shouldIgnoreHostTemperature) {
        temperature = hostSettings.temperature;
      }
      if (hostSettings.num_ctx !== undefined) numCtx = hostSettings.num_ctx;
      if (hostSettings.top_p !== undefined) topP = hostSettings.top_p;
      if (hostSettings.top_k !== undefined) topK = hostSettings.top_k;
      if (hostSettings.mirostat !== undefined) mirostat = hostSettings.mirostat;
      if (includeHardware) {
        if (hostSettings.num_gpu !== undefined) numGpu = hostSettings.num_gpu;
        if (hostSettings.num_thread !== undefined) numThread = hostSettings.num_thread;
        if (hostSettings.keep_alive !== undefined) keepAlive = hostSettings.keep_alive;
      }
      logger.debug(`Applied per-host settings from '${hostSettings.hostName || hostId}'`);
    }
  }

  // Layer 2: Auto-tuning rules (execute-ollama only)
  if (includeAutoTuning && task) {
    const autoTuningEnabled = db.getConfig('ollama_auto_tuning_enabled') === '1';
    if (autoTuningEnabled) {
      const autoRulesJson = db.getConfig('ollama_auto_tuning_rules');
      if (autoRulesJson) {
        try {
          const autoRules = JSON.parse(autoRulesJson);
          const taskLower = task.task_description.toLowerCase();
          let matched = false;
          for (const [ruleName, rule] of Object.entries(autoRules)) {
            const ruleMatched = rule.patterns.some(pattern => taskLower.includes(pattern.toLowerCase()));
            if (ruleMatched && rule.tuning) {
              if (rule.tuning.temperature !== undefined) temperature = rule.tuning.temperature;
              if (rule.tuning.top_k !== undefined) topK = rule.tuning.top_k;
              if (rule.tuning.mirostat !== undefined) mirostat = rule.tuning.mirostat;
              logger.info(`Auto-tuning: matched "${ruleName}" → temp:${temperature}, top_k:${topK}`);
              matched = true;
              break;
            }
          }
          // Fallback: infer from file extensions in task description
          if (!matched) {
            if (taskLower.match(/\.(test|spec)\.(js|ts|py)/)) {
              temperature = 0.2; topK = 30;
              logger.info('Auto-tuning fallback: test file extension → code_generation tuning');
            } else if (taskLower.match(/\.(md|txt|rst)\b/) || taskLower.match(/readme|changelog/i)) {
              temperature = 0.5; topK = 50;
              logger.info('Auto-tuning fallback: doc file extension → documentation tuning');
            }
          }
        } catch (e) {
          logger.info('Failed to parse auto-tuning rules:', e.message);
        }
      }
    }
  }

  // Layer 3: Model-specific settings
  if (model) {
    const modelSettingsJson = db.getConfig('ollama_model_settings');
    if (modelSettingsJson) {
      try {
        const modelSettings = JSON.parse(modelSettingsJson);
        const modelConfig = modelSettings[model];
        if (modelConfig) {
          if (modelConfig.temperature !== undefined) temperature = modelConfig.temperature;
          if (modelConfig.num_ctx !== undefined) numCtx = modelConfig.num_ctx;
          if (modelConfig.top_p !== undefined) topP = modelConfig.top_p;
          if (modelConfig.top_k !== undefined) topK = modelConfig.top_k;
          if (modelConfig.repeat_penalty !== undefined) repeatPenalty = modelConfig.repeat_penalty;
          if (modelConfig.mirostat !== undefined) mirostat = modelConfig.mirostat;
        }
      } catch (e) {
        logger.info('Failed to parse model settings:', e.message);
      }
    }
  }

  // Layer 4: Per-task overrides (highest priority)
  if (task) {
    let taskMetadata = {};
    try {
      taskMetadata = typeof task.metadata === 'object' && task.metadata !== null
        ? task.metadata
        : task.metadata ? JSON.parse(task.metadata) : {};
    } catch { /* ignore */ }

    const tuningOverrides = taskMetadata.tuning_overrides;
    if (tuningOverrides) {
      if (tuningOverrides.temperature !== undefined) temperature = tuningOverrides.temperature;
      if (tuningOverrides.num_ctx !== undefined) numCtx = tuningOverrides.num_ctx;
      if (tuningOverrides.top_p !== undefined) topP = tuningOverrides.top_p;
      if (tuningOverrides.top_k !== undefined) topK = tuningOverrides.top_k;
      if (tuningOverrides.repeat_penalty !== undefined) repeatPenalty = tuningOverrides.repeat_penalty;
      if (tuningOverrides.num_predict !== undefined) numPredict = tuningOverrides.num_predict;
      if (tuningOverrides.mirostat !== undefined) mirostat = tuningOverrides.mirostat;
    }
  }

  // Ensure correct types (guard against NaN from JSON config)
  const parsed = parseFloat(temperature);
  temperature = Number.isFinite(parsed) ? parsed : 0.3;
  numCtx = parseInt(numCtx, 10) || PROVIDER_DEFAULTS.OLLAMA_DEFAULT_CONTEXT;
  const parsedNP = parseInt(numPredict, 10);
  numPredict = Number.isFinite(parsedNP) ? parsedNP : -1;
  topP = parseFloat(topP) || 0.9;
  topK = parseInt(topK, 10) || 40;
  repeatPenalty = parseFloat(repeatPenalty) || 1.1;

  return {
    temperature, numCtx, topP, topK, repeatPenalty, numPredict,
    mirostat, mirostatTau, mirostatEta, seed,
    numGpu, numThread, keepAlive,
  };
}

// ── System Prompt Resolution ───────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are an expert software engineer. Provide clear, concise, and accurate responses. When writing code:
- Follow best practices and conventions for the language
- Include brief comments only where logic is non-obvious
- Handle edge cases appropriately
- Be precise and avoid unnecessary verbosity`;

/**
 * Resolve system prompt: model-specific > global config > default.
 * @param {string} [model] — model name for model-specific prompt
 * @returns {string}
 */
function resolveSystemPrompt(model) {
  if (!db) return '';
  let systemPrompt = db.getConfig('ollama_system_prompt') || DEFAULT_SYSTEM_PROMPT;
  if (model) {
    const modelPromptsJson = db.getConfig('ollama_model_prompts');
    if (modelPromptsJson) {
      try {
        const modelPrompts = JSON.parse(modelPromptsJson);
        if (modelPrompts[model]) systemPrompt = modelPrompts[model];
      } catch (e) {
        logger.info('Failed to parse model prompts:', e.message);
      }
    }
  }
  return systemPrompt;
}

// ── Provider Enable/Disable ────────────────────────────────────────────

/**
 * Check if a provider is enabled. Standardizes the inconsistent
 * semantics (some used === '1', others !== '0').
 *
 * Convention: providers that require explicit API keys/setup default to DISABLED
 * (opt-in), while built-in features default to ENABLED (opt-out).
 *
 * @param {string} provider — provider name
 * @returns {boolean}
 */
function isProviderEnabled(provider) {
  const key = `${provider.replace(/-/g, '_')}_enabled`;
  const val = db.getConfig(key);
  // Opt-in providers (require setup): codex, codex_spark, deepinfra, hyperbolic
  const optInProviders = ['codex', 'codex_spark', 'deepinfra', 'hyperbolic'];
  if (optInProviders.includes(provider.replace(/-/g, '_'))) {
    return val === '1';
  }
  // All others default to enabled (opt-out)
  return val !== '0';
}

module.exports = {
  init,
  getEnrichmentConfig,
  resolveOllamaTuning,
  resolveSystemPrompt,
  isProviderEnabled,
  DEFAULT_SYSTEM_PROMPT,
  HASHLINE_OLLAMA_DEFAULTS,
};
