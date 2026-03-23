'use strict';

/**
 * family-classifier — model name → family + parameter size parsing
 *
 * Extracts the model family and parameter size from Ollama-style names
 * (e.g. `qwen3-coder:30b`) and cloud-style names (e.g. `Qwen/Qwen3-235B-A22B`).
 *
 * Exported API:
 *   classifyModel(modelName, options?)  → { family, parameterSizeB, baseName }
 *   getSizeBucket(parameterSizeB)       → 'small' | 'medium' | 'large' | null
 *   suggestRole(parameterSizeB)         → 'fast' | 'balanced' | 'quality' | 'default'
 *   extractBaseName(modelName)          → string
 *   parseSizeFromName(name)             → number | null
 *   estimateSizeFromBytes(sizeBytes)    → number | null
 *   FAMILY_PATTERNS                     → Array<{ pattern: RegExp, family: string }>
 */

/**
 * Ordered list of family patterns — most specific first so that sub-families
 * (qwen3, qwen2.5) match before their parent (qwen).
 *
 * Each entry: { pattern: RegExp, family: string }
 * The regex is tested against the *base name* (org prefix and Ollama tag stripped).
 */
const FAMILY_PATTERNS = [
  { pattern: /^qwen3/i,      family: 'qwen3'     },
  { pattern: /^qwen2\.5/i,   family: 'qwen2.5'   },
  { pattern: /^qwen/i,       family: 'qwen'      },
  { pattern: /^devstral/i,   family: 'devstral'  },
  { pattern: /^codestral/i,  family: 'codestral' },
  { pattern: /^codellama/i,  family: 'codellama' },
  { pattern: /^deepseek/i,   family: 'deepseek'  },
  { pattern: /^llama/i,      family: 'llama'     },
  { pattern: /^gemma/i,      family: 'gemma'     },
  { pattern: /^mistral/i,    family: 'mistral'   },
  { pattern: /^phi/i,        family: 'phi'       },
  { pattern: /^command-r/i,  family: 'command-r' },
  { pattern: /^starcoder/i,  family: 'starcoder' },
];

// Q4 quantization heuristic: ~0.5625 bytes per parameter
const BYTES_PER_PARAM_Q4 = 0.5625;

/**
 * Strip org prefix (e.g. `Qwen/`) and Ollama tag (e.g. `:30b`).
 *
 * @param {string} modelName
 * @returns {string}
 */
function extractBaseName(modelName) {
  // Strip org prefix: everything up to and including the last `/`
  let name = modelName.includes('/') ? modelName.slice(modelName.lastIndexOf('/') + 1) : modelName;
  // Strip Ollama tag: everything from the first `:` onward
  name = name.includes(':') ? name.slice(0, name.indexOf(':')) : name;
  return name;
}

/**
 * Parse parameter size (in billions) from a model name string.
 * Handles:
 *   - Ollama colon tags:       `qwen3-coder:30b`   → 30
 *   - Decimal colon tags:      `phi3:3.8b`          → 3.8
 *   - Cloud-style embedded:    `Qwen3-235B-A22B`    → 235  (first occurrence)
 *
 * @param {string} name  Full model name (tag present) or base name.
 * @returns {number|null}
 */
function parseSizeFromName(name) {
  // 1. Ollama colon tag: `:Nb` or `:N.Mb`  (case-insensitive)
  const colonMatch = name.match(/:(\d+(?:\.\d+)?)b\b/i);
  if (colonMatch) {
    return parseFloat(colonMatch[1]);
  }

  // 2. Cloud-style: `-NB-` or `-N.MB-` where N looks like a param count
  //    We look for a `-<number>B` boundary that isn't a trailing part of a
  //    mixture-of-experts annotation like A22B (we already matched the larger
  //    number first by grabbing the earliest match).
  const cloudMatch = name.match(/-(\d+(?:\.\d+)?)B(?:-|$)/i);
  if (cloudMatch) {
    return parseFloat(cloudMatch[1]);
  }

  return null;
}

/**
 * Estimate parameter size (in billions) from raw model file size in bytes,
 * using the Q4 quantization heuristic (~0.5625 bytes / parameter).
 *
 * @param {number|null|undefined} sizeBytes
 * @returns {number|null}
 */
function estimateSizeFromBytes(sizeBytes) {
  if (!sizeBytes) return null;
  return sizeBytes / BYTES_PER_PARAM_Q4 / 1e9;
}

/**
 * Classify a model by name into a { family, parameterSizeB, baseName } record.
 *
 * @param {string} modelName
 * @param {{ sizeBytes?: number }} [options]
 * @returns {{ family: string, parameterSizeB: number|null, baseName: string }}
 */
function classifyModel(modelName, options = {}) {
  const baseName = extractBaseName(modelName);

  // Determine family by testing base name against ordered FAMILY_PATTERNS
  let family = 'unknown';
  for (const { pattern, family: f } of FAMILY_PATTERNS) {
    if (pattern.test(baseName)) {
      family = f;
      break;
    }
  }

  // Parse size — try name first, fall back to sizeBytes heuristic
  let parameterSizeB = parseSizeFromName(modelName);
  if (parameterSizeB === null && options.sizeBytes) {
    parameterSizeB = estimateSizeFromBytes(options.sizeBytes);
  }

  return { family, parameterSizeB, baseName };
}

/**
 * Bucket a parameter size into a coarse tier label.
 *
 * @param {number|null|undefined} parameterSizeB
 * @returns {'small'|'medium'|'large'|null}
 */
function getSizeBucket(parameterSizeB) {
  if (parameterSizeB == null) return null;
  if (parameterSizeB < 10) return 'small';
  if (parameterSizeB <= 30) return 'medium';
  return 'large';
}

/**
 * Suggest an execution role based on parameter size.
 *
 * @param {number|null|undefined} parameterSizeB
 * @returns {'fast'|'balanced'|'quality'|'default'}
 */
function suggestRole(parameterSizeB) {
  if (parameterSizeB == null) return 'default';
  if (parameterSizeB < 10) return 'fast';
  if (parameterSizeB <= 30) return 'balanced';
  return 'quality';
}

module.exports = {
  classifyModel,
  getSizeBucket,
  suggestRole,
  extractBaseName,
  parseSizeFromName,
  estimateSizeFromBytes,
  FAMILY_PATTERNS,
};
