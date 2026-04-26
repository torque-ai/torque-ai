'use strict';

const { safeJsonParse } = require('../utils/json');

const DEFAULT_CAPABILITIES = {
  codex: { capabilities: ['file_creation', 'file_edit', 'multi_file', 'reasoning'], band: 'A' },
  'claude-cli': { capabilities: ['file_creation', 'file_edit', 'multi_file', 'reasoning'], band: 'A' },
  'claude-code-sdk': { capabilities: ['file_creation', 'file_edit', 'multi_file', 'reasoning'], band: 'A' },
  deepinfra: { capabilities: ['reasoning', 'large_context', 'code_review'], band: 'B' },
  'ollama-cloud': { capabilities: ['file_creation', 'file_edit', 'multi_file', 'reasoning', 'large_context', 'code_review'], band: 'B' },
  hyperbolic: { capabilities: ['reasoning', 'large_context'], band: 'B' },
  anthropic: { capabilities: ['reasoning', 'code_review'], band: 'B' },
  ollama: { capabilities: ['reasoning', 'code_review'], band: 'C' },
  openrouter: { capabilities: ['reasoning', 'code_review'], band: 'C' },
  groq: { capabilities: [], band: 'D' },
  cerebras: { capabilities: [], band: 'D' },
  'google-ai': { capabilities: [], band: 'D' },
};

const BAND_ORDER = { A: 0, B: 1, C: 2, D: 3 };

const QUALITY_GATES = {
  complex: new Set(['A', 'B']),
  normal: new Set(['A', 'B', 'C']),
  simple: new Set(['A', 'B', 'C']),
};

let _db = null;
const _capabilitySetCache = new Map();
function setDb(db) { _db = db; _capabilitySetCache.clear(); }

function getProviderCapabilities(provider) {
  if (_db && typeof _db.getProvider === 'function') {
    try {
      const config = _db.getProvider(provider);
      if (config && config.capability_tags) {
        const tags = typeof config.capability_tags === 'string' ? safeJsonParse(config.capability_tags, null) : config.capability_tags;
        if (Array.isArray(tags)) return tags;
      }
    } catch { /* fall through to defaults */ }
  }
  const profile = DEFAULT_CAPABILITIES[provider];
  return profile ? [...profile.capabilities] : [];
}

function getQualityBand(provider) {
  if (_db && typeof _db.getProvider === 'function') {
    try {
      const config = _db.getProvider(provider);
      if (config && config.quality_band) return config.quality_band;
    } catch { /* fall through */ }
  }
  const profile = DEFAULT_CAPABILITIES[provider];
  return profile ? profile.band : 'D';
}

function meetsCapabilityRequirements(provider, requirements) {
  if (!requirements || requirements.length === 0) return true;
  const caps = new Set(getProviderCapabilities(provider));
  return requirements.every(req => caps.has(req));
}

function getProviderCapabilitySet(provider) {
  if (_capabilitySetCache.has(provider)) return _capabilitySetCache.get(provider);
  const s = new Set(getProviderCapabilities(provider));
  _capabilitySetCache.set(provider, s);
  return s;
}

function passesQualityGate(band, qualityTier) {
  const gate = QUALITY_GATES[qualityTier];
  if (!gate) return false;
  return gate.has(band);
}

const CAPABILITY_PATTERNS = [
  { pattern: /\b(create|write new|generate new|scaffold|new file)\b/i, capability: 'file_creation' },
  { pattern: /\b(modify|edit|fix|update|patch|change|refactor)\b/i, capability: 'file_edit' },
  { pattern: /\b(multi.?file|across .*(files|modules)|refactor across|rename across)\b/i, capability: 'multi_file' },
  { pattern: /\b(review|analyze|audit|inspect|examine|assess)\b/i, capability: 'code_review' },
  { pattern: /\b(review|analyze|architect|design|reason|debug|investigate)\b/i, capability: 'reasoning' },
  { pattern: /\b(large context|many files|entire codebase|full project)\b/i, capability: 'large_context' },
];

function inferCapabilityRequirements(taskDescription) {
  const requirements = new Set();
  for (const { pattern, capability } of CAPABILITY_PATTERNS) {
    if (pattern.test(taskDescription)) requirements.add(capability);
  }
  return [...requirements];
}

function generateEligibleProviders({ capabilityRequirements = [], qualityTier = 'normal', getEmpiricalRank = null }) {
  const allProviders = Object.keys(DEFAULT_CAPABILITIES);
  const eligible = [];
  for (const provider of allProviders) {
    const band = getQualityBand(provider);
    if (band === 'D') continue;
    if (!passesQualityGate(band, qualityTier)) continue;
    if (!meetsCapabilityRequirements(provider, capabilityRequirements)) continue;
    if (_db && typeof _db.getProvider === 'function') {
      try {
        const config = _db.getProvider(provider);
        if (config && !config.enabled) continue;
      } catch { /* include if we can't check */ }
    }
    eligible.push({
      provider, band,
      bandOrder: BAND_ORDER[band] ?? 99,
      empiricalRank: getEmpiricalRank ? getEmpiricalRank(provider) : 0,
    });
  }
  eligible.sort((a, b) => {
    if (a.bandOrder !== b.bandOrder) return a.bandOrder - b.bandOrder;
    return a.empiricalRank - b.empiricalRank;
  });
  return eligible.map(e => e.provider);
}

// ============================================================
// Factory function (dependency injection without singletons)
// ============================================================

function createProviderCapabilities({ db: dbInstance } = {}) {
  if (dbInstance) setDb(dbInstance);
  return module.exports;
}

module.exports = {
  DEFAULT_CAPABILITIES, BAND_ORDER, QUALITY_GATES,
  setDb, createProviderCapabilities, getProviderCapabilities, getQualityBand,
  getProviderCapabilitySet, meetsCapabilityRequirements, passesQualityGate,
  inferCapabilityRequirements, generateEligibleProviders,
};
