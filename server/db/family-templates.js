'use strict';

/**
 * server/db/family-templates.js — Per-family prompt templates and tuning overrides.
 *
 * Stores system prompts and tuning parameters per model family (qwen3, llama, etc.).
 * Provides resolution helpers that merge tuning from multiple layers:
 *   role defaults < family template + size overrides < model override < task override
 *
 * Table: model_family_templates
 *   family TEXT PRIMARY KEY
 *   system_prompt TEXT NOT NULL
 *   tuning_json TEXT NOT NULL
 *   size_overrides TEXT
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Generic code-focused fallback used when no family template exists.
 * Must contain the word "code-focused" — tests assert on this.
 */
const UNIVERSAL_FALLBACK_PROMPT =
  'You are a highly capable, code-focused AI assistant. Write clean, correct, ' +
  'idiomatic code. Make only the changes requested. Follow the existing code ' +
  'conventions, style, and architecture. Keep implementations minimal and direct.';

/**
 * Per-role tuning defaults. Lower temperature = more deterministic output.
 * num_ctx controls context window size per role tier.
 */
// repeat_penalty disabled (1.0) by default — research shows even moderate values
// (1.1+) degrade code correctness (ACL 2025, arXiv:2504.12608). Per-family
// templates can override to 1.05 where the vendor explicitly recommends it (Qwen).
const ROLE_TUNING_DEFAULTS = {
  fast:     { temperature: 0.3,  num_ctx: 4096,  top_k: 40, repeat_penalty: 1.0 },
  balanced: { temperature: 0.2,  num_ctx: 8192,  top_k: 30, repeat_penalty: 1.0 },
  quality:  { temperature: 0.15, num_ctx: 16384, top_k: 25, repeat_penalty: 1.0 },
  default:  { temperature: 0.2,  num_ctx: 8192,  top_k: 30, repeat_penalty: 1.0 },
  fallback: { temperature: 0.3,  num_ctx: 8192,  top_k: 40, repeat_penalty: 1.0 },
};

// ── Factory (DI container) ───────────────────────────────────────────────────

/**
 * Create a family-templates module bound to the given DB instance.
 *
 * @param {{ db: import('better-sqlite3').Database }} deps
 * @returns {{ upsert, get, list, resolvePrompt, resolveTuning }}
 */
function createFamilyTemplates(deps) {
  const db = deps.db;

  // ── Prepared statements ────────────────────────────────────────────────────

  const stmtUpsert = db.prepare(`
    INSERT OR REPLACE INTO model_family_templates
      (family, system_prompt, tuning_json, size_overrides)
    VALUES (?, ?, ?, ?)
  `);

  const stmtGet = db.prepare(`
    SELECT family, system_prompt, tuning_json, size_overrides
    FROM model_family_templates
    WHERE family = ?
  `);

  const stmtList = db.prepare(`
    SELECT family, system_prompt, tuning_json, size_overrides
    FROM model_family_templates
    ORDER BY family
  `);

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Parse a stored row, deserializing JSON columns.
   * @param {object|null} row
   * @returns {object|null}
   */
  function _parseRow(row) {
    if (!row) return null;
    return {
      family: row.family,
      system_prompt: row.system_prompt,
      tuning: _tryParse(row.tuning_json, {}),
      size_overrides: row.size_overrides ? _tryParse(row.size_overrides, null) : null,
    };
  }

  function _tryParse(json, fallback) {
    try {
      return JSON.parse(json);
    } catch {
      return fallback;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Insert or replace a family template.
   *
   * @param {string} family - Model family identifier (e.g. 'qwen3', 'llama')
   * @param {{ systemPrompt: string, tuning: object, sizeOverrides?: object }} opts
   */
  function upsert(family, { systemPrompt, tuning = {}, sizeOverrides } = {}) {
    stmtUpsert.run(
      family,
      systemPrompt,
      JSON.stringify(tuning),
      sizeOverrides != null ? JSON.stringify(sizeOverrides) : null
    );
  }

  /**
   * Get a single family template by family name.
   *
   * @param {string} family
   * @returns {{ family, system_prompt, tuning, size_overrides }|null}
   */
  function get(family) {
    return _parseRow(stmtGet.get(family));
  }

  /**
   * List all stored family templates ordered by family name.
   *
   * @returns {Array<{ family, system_prompt, tuning, size_overrides }>}
   */
  function list() {
    return stmtList.all().map(_parseRow);
  }

  /**
   * Resolve the system prompt to use for a request.
   *
   * Priority: modelOverride > family template > UNIVERSAL_FALLBACK_PROMPT
   *
   * @param {string} family
   * @param {string|null} modelOverride - Per-model system prompt override
   * @returns {string}
   */
  function resolvePrompt(family, modelOverride) {
    if (modelOverride && modelOverride.trim().length > 0) {
      return modelOverride;
    }
    const template = get(family);
    if (template && template.system_prompt) {
      return template.system_prompt;
    }
    return UNIVERSAL_FALLBACK_PROMPT;
  }

  /**
   * Resolve merged tuning parameters for a request.
   *
   * Merge order (later layers win):
   *   1. Role defaults
   *   2. Family template tuning
   *   3. Size-bucket overrides (from family template's sizeOverrides)
   *   4. Model-level tuning override
   *   5. Task-level tuning override
   *
   * @param {{ family?: string, sizeBucket?: string, role?: string, modelTuning?: object, taskTuning?: object }} opts
   * @returns {object} Merged tuning parameters
   */
  function resolveTuning({ family, sizeBucket, role, modelTuning, taskTuning } = {}) {
    const effectiveRole = role || 'default';
    const roleDefaults = ROLE_TUNING_DEFAULTS[effectiveRole] || ROLE_TUNING_DEFAULTS.default;

    // Layer 1: role defaults
    let merged = { ...roleDefaults };

    // Layer 2: family template tuning
    if (family) {
      const template = get(family);
      if (template && template.tuning && Object.keys(template.tuning).length > 0) {
        merged = { ...merged, ...template.tuning };

        // Layer 3: size overrides from within the family template
        if (sizeBucket && template.size_overrides && template.size_overrides[sizeBucket]) {
          merged = { ...merged, ...template.size_overrides[sizeBucket] };
        }
      }
    }

    // Layer 4: model-level tuning override
    if (modelTuning && typeof modelTuning === 'object') {
      merged = { ...merged, ...modelTuning };
    }

    // Layer 5: task-level tuning override (highest priority)
    if (taskTuning && typeof taskTuning === 'object') {
      merged = { ...merged, ...taskTuning };
    }

    return merged;
  }

  return {
    upsert,
    get,
    list,
    resolvePrompt,
    resolveTuning,
    UNIVERSAL_FALLBACK_PROMPT,
    ROLE_TUNING_DEFAULTS,
  };
}

module.exports = {
  createFamilyTemplates,
  UNIVERSAL_FALLBACK_PROMPT,
  ROLE_TUNING_DEFAULTS,
};
