'use strict';

/**
 * heuristic-capabilities — model family → capability flags
 *
 * This is the "initial guess" layer. When a model is discovered, we look up
 * its family and set capability flags based on empirical knowledge of what
 * each model family can do.
 *
 * Exported API:
 *   getHeuristicCapabilities(family)                  → { hashline, agentic, file_creation, multi_file, reasoning }
 *   applyHeuristicCapabilities(db, modelName, family) → void (upserts model_capabilities row)
 *   FAMILY_CAPABILITIES                               → { [family]: capabilities }
 */

/**
 * Empirical capability map keyed by model family name.
 *
 * Flags:
 *   hashline     — supports hashline edit format (precise line-addressed edits)
 *   agentic      — can use agentic tool-calling reliably
 *   file_creation — can create new files (not just edit existing ones)
 *   multi_file   — can coordinate edits across multiple files in one pass
 *   reasoning    — produces structured chain-of-thought / reasoning traces
 */
const FAMILY_CAPABILITIES = {
  'qwen3':     { hashline: true,  agentic: true,  file_creation: true,  multi_file: false, reasoning: true  },
  'qwen2.5':   { hashline: true,  agentic: true,  file_creation: true,  multi_file: false, reasoning: true  },
  'codestral': { hashline: true,  agentic: false, file_creation: false, multi_file: false, reasoning: false },
  'devstral':  { hashline: true,  agentic: true,  file_creation: true,  multi_file: false, reasoning: true  },
  'deepseek':  { hashline: true,  agentic: true,  file_creation: false, multi_file: false, reasoning: true  },
  'llama':     { hashline: false, agentic: true,  file_creation: false, multi_file: false, reasoning: true  },
  'gemma':     { hashline: true,  agentic: true,  file_creation: false, multi_file: false, reasoning: false },
  'mistral':   { hashline: false, agentic: true,  file_creation: false, multi_file: false, reasoning: false },
  'phi':       { hashline: false, agentic: false, file_creation: false, multi_file: false, reasoning: false },
  'command-r': { hashline: false, agentic: true,  file_creation: false, multi_file: false, reasoning: true  },
  'codellama': { hashline: true,  agentic: false, file_creation: false, multi_file: false, reasoning: false },
};

const DEFAULT_CAPABILITIES = {
  hashline: false,
  agentic: false,
  file_creation: false,
  multi_file: false,
  reasoning: false,
};

/**
 * Return capability flags for a model family.
 * Returns DEFAULT_CAPABILITIES (all false) for unknown or missing families.
 *
 * @param {string} family
 * @returns {{ hashline: boolean, agentic: boolean, file_creation: boolean, multi_file: boolean, reasoning: boolean }}
 */
function getHeuristicCapabilities(family) {
  const caps = FAMILY_CAPABILITIES[family];
  if (!caps) {
    return { ...DEFAULT_CAPABILITIES };
  }
  return { ...caps };
}

/**
 * Upsert model_capabilities row for `modelName` using heuristic flags.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE so existing rows are only overwritten
 * when their `capability_source` is 'heuristic'. Rows sourced from 'probed' or
 * 'user' are left untouched (preserving higher-confidence data).
 *
 * @param {{ prepare(sql: string): { run(...args: any[]): void } }} db  — better-sqlite3 handle
 * @param {string} modelName  — e.g. 'qwen3-coder:30b'
 * @param {string} family     — e.g. 'qwen3'
 */
function applyHeuristicCapabilities(db, modelName, family) {
  const caps = getHeuristicCapabilities(family);

  const stmt = db.prepare(`
    INSERT INTO model_capabilities
      (model_name, cap_hashline, cap_agentic, cap_file_creation, cap_multi_file, capability_source)
    VALUES (?, ?, ?, ?, ?, 'heuristic')
    ON CONFLICT(model_name) DO UPDATE SET
      cap_hashline     = excluded.cap_hashline,
      cap_agentic      = excluded.cap_agentic,
      cap_file_creation = excluded.cap_file_creation,
      cap_multi_file   = excluded.cap_multi_file,
      capability_source = 'heuristic'
    WHERE capability_source = 'heuristic'
  `);

  stmt.run(
    modelName,
    caps.hashline      ? 1 : 0,
    caps.agentic       ? 1 : 0,
    caps.file_creation ? 1 : 0,
    caps.multi_file    ? 1 : 0,
  );
}

module.exports = {
  getHeuristicCapabilities,
  applyHeuristicCapabilities,
  FAMILY_CAPABILITIES,
};
