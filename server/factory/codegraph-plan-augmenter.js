'use strict';

// Plan-quality augmentation backed by the codegraph plugin.
//
// After plan-quality-gate.js's deterministic rules + LLM semantic check pass,
// we additionally walk every backtick-identified symbol in the plan, ask the
// codegraph for its impact set, and warn when a task touches a wide-impact
// symbol. The warnings are SOFT — they're appended to the existing warnings
// array and never flip `passed: false` — because false positives from
// identifier-only resolution would otherwise stall the factory loop.
//
// Skip-silently policy: if codegraph isn't loaded, the index isn't built for
// this repo, or any cg_* call throws, we return [] and let the plan proceed.
// The factory keeps moving; the next telemetry review surfaces missing
// coverage via cg_telemetry.staleness_pct / error_pct.

const IMPACT_WARN_THRESHOLD = 10;        // |callers + caller-callers| → warn at depth=3
const IMPACT_DEPTH = 3;                   // matches the planner-prompt advert ("depth=3, local refactor scope")
const PER_SYMBOL_TIMEOUT_MS = 1500;       // SQLite-local but bound it; 7+ symbols × 1.5s caps loop at ~10s
const MAX_SYMBOLS_PER_PLAN = 12;          // beyond this we're spending budget on noise candidates

// Backtick-quoted identifiers in the plan body. We only consider strings that
// look like valid JS/TS/Python/C# identifiers — punctuation-rich backticks
// (file paths, commands, JSON snippets) are filtered out by IDENT_RE.
const BACKTICK_RE = /`([^`]+)`/g;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{2,}$/;   // ≥3 chars to skip 'i', 'fn', etc.
const IGNORE_NAMES = new Set([
  'true', 'false', 'null', 'undefined', 'TODO', 'FIXME', 'NOTE',
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH',
]);

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}

// Pull the cg_* handlers from the loaded plugin singleton. Returns null when
// the plugin isn't installed (TORQUE_CODEGRAPH_ENABLED=0) or when the require
// fails for any reason — both are silent skip-the-augmentation conditions.
function defaultCodegraphHandlers() {
  try {
    const cg = require('../plugins/codegraph');
    const tools = typeof cg.mcpTools === 'function' ? cg.mcpTools() : [];
    if (!tools || !tools.length) return null;
    const map = {};
    for (const t of tools) map[t.name] = t.handler;
    if (!map.cg_index_status || !map.cg_search || !map.cg_impact_set) return null;
    return map;
  } catch {
    return null;
  }
}

function uniqueIdentifiers(text) {
  const seen = new Set();
  const out = [];
  for (const match of text.matchAll(BACKTICK_RE)) {
    const inner = match[1].trim();
    if (!IDENT_RE.test(inner)) continue;
    if (IGNORE_NAMES.has(inner)) continue;
    if (seen.has(inner)) continue;
    seen.add(inner);
    out.push(inner);
    if (out.length >= MAX_SYMBOLS_PER_PLAN) break;
  }
  return out;
}

function readStructured(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.structuredData) return result.structuredData;
  return null;
}

// Drives one cg_search → cg_impact_set roundtrip per symbol. Returns null on
// any miss (no symbol indexed, error, timeout) so the caller can skip without
// drama. The outer caller already handles null.
async function impactForSymbol(handlers, repoPath, symbol) {
  let searched;
  try {
    searched = readStructured(await withTimeout(
      handlers.cg_search({ repo_path: repoPath, pattern: symbol, limit: 1 }),
      PER_SYMBOL_TIMEOUT_MS,
    ));
  } catch { return null; }
  if (!searched || !Array.isArray(searched.results) || searched.results.length === 0) {
    return null;
  }
  let impact;
  try {
    impact = readStructured(await withTimeout(
      handlers.cg_impact_set({ repo_path: repoPath, symbol, depth: IMPACT_DEPTH, scope: 'loose' }),
      PER_SYMBOL_TIMEOUT_MS,
    ));
  } catch { return null; }
  if (!impact || !Array.isArray(impact.symbols)) return null;
  return {
    symbol,
    callerCount: impact.symbols.length,
    fileCount: Array.isArray(impact.files) ? impact.files.length : 0,
    truncated: Boolean(impact.truncated),
    sampleCallers: impact.symbols.slice(0, 3),
  };
}

// Public entrypoint. Returns Array<{level, message, code, symbol, ...}>.
// Always resolves; never throws. Empty array means "no signal" (or codegraph
// silently unavailable). Caller appends to plan-quality-gate warnings.
async function checkPlanImpact({ plan, repoPath, handlers = null, threshold = IMPACT_WARN_THRESHOLD } = {}) {
  if (typeof plan !== 'string' || plan.length === 0) return [];
  if (typeof repoPath !== 'string' || repoPath.length === 0) return [];

  const cg = handlers || defaultCodegraphHandlers();
  if (!cg) return [];

  // Cheap up-front check: if the index isn't built for this repo, skip.
  let status;
  try {
    status = readStructured(await withTimeout(
      cg.cg_index_status({ repo_path: repoPath }),
      PER_SYMBOL_TIMEOUT_MS,
    ));
  } catch { return []; }
  if (!status || status.indexed !== true) return [];

  const candidates = uniqueIdentifiers(plan);
  if (candidates.length === 0) return [];

  const warnings = [];
  for (const symbol of candidates) {
    const r = await impactForSymbol(cg, repoPath, symbol);
    if (!r) continue;
    if (r.callerCount < threshold) continue;
    const truncatedHint = r.truncated ? ' (impact-set hit the cap; actual blast radius is wider)' : '';
    const sampleHint = r.sampleCallers.length > 0
      ? ` Sample callers: ${r.sampleCallers.join(', ')}.`
      : '';
    warnings.push({
      level: 'info',
      code: 'codegraph_wide_impact',
      symbol,
      caller_count: r.callerCount,
      file_count: r.fileCount,
      truncated: r.truncated,
      message:
        `Plan references \`${symbol}\` which has ${r.callerCount} caller-side ` +
        `symbols across ${r.fileCount} files at depth=${IMPACT_DEPTH}${truncatedHint}.${sampleHint} ` +
        'Confirm the task body acknowledges the blast radius or scope down.',
    });
  }
  return warnings;
}

module.exports = {
  checkPlanImpact,
  IMPACT_WARN_THRESHOLD,
  IMPACT_DEPTH,
  defaultCodegraphHandlers,
  uniqueIdentifiers,   // exported for tests
};
