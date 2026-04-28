'use strict';

// Smart-diagnosis fix-task enrichment via codegraph.
//
// When auto-verify-retry creates a fix task after verify_command fails, we
// want the fix-task LLM to see "if you change foo(), these N callers may
// break" — so its fix is bounded to the actual call sites instead of being
// a global guess. We extract candidate symbol names from the error output,
// confirm each via cg_search, then call cg_call_graph(direction=callers,
// depth=2) and format a small markdown table to inject into the fix prompt.
//
// Soft signal only: returns '' (empty string) on every failure path. The
// caller appends to the prompt if non-empty and otherwise proceeds without
// codegraph context.

const MAX_CANDIDATES = 5;
const MAX_CALLERS_PER_SYMBOL = 8;
const PER_CALL_TIMEOUT_MS = 1500;
const CALLERS_DEPTH = 2;

// Capture words that look like JS/TS/Python/C#/Go identifiers AND are
// long enough to be meaningful (≥4 chars filters loop vars and keywords
// like 'fn', 'err', 'msg'). The boundary is chosen empirically from
// vitest/jest/pytest/dotnet error outputs which mention symbol names in
// many shapes (handleFoo, do_thing, Test_FooBar, MyClass.FooMethod).
const IDENT_WORD_RE = /\b([A-Za-z_][A-Za-z0-9_]{2,}[A-Za-z0-9_])\b/g;

const STOPWORDS = new Set([
  // Generic test-framework / runtime / pytest / vitest noise
  'AssertionError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError',
  'Error', 'Exception', 'Warning', 'Test', 'tests', 'expect', 'expected',
  'received', 'should', 'must', 'this', 'self', 'class', 'function',
  'undefined', 'null', 'true', 'false', 'await', 'async',
  'console', 'process', 'module', 'require', 'import', 'export',
  'before', 'after', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
  'describe', 'context', 'when', 'returns', 'throws',
  // Common path / file noise
  'node_modules', 'src', 'tests', 'test', 'spec', 'specs', 'lib',
  'index', 'main', 'app', 'server', 'client',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Map', 'Set',
  // vitest output noise
  'FAIL', 'PASS', 'failed', 'passed', 'pending', 'skipped', 'duration',
]);

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}

function defaultCodegraphHandlers() {
  try {
    const cg = require('../plugins/codegraph');
    const tools = typeof cg.mcpTools === 'function' ? cg.mcpTools() : [];
    if (!tools || !tools.length) return null;
    const map = {};
    for (const t of tools) map[t.name] = t.handler;
    if (!map.cg_search || !map.cg_call_graph || !map.cg_index_status) return null;
    return map;
  } catch {
    return null;
  }
}

function readStructured(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.structuredData) return result.structuredData;
  return null;
}

// Return candidate symbol names from error text, ordered by frequency
// (most-mentioned first). The frequency heuristic biases toward names the
// test runner repeats (in stack frames, in failure descriptions) which
// tend to be the actual failing symbol.
function extractCandidateSymbols(errorText, max = MAX_CANDIDATES) {
  if (typeof errorText !== 'string' || !errorText) return [];
  const counts = new Map();
  for (const match of errorText.matchAll(IDENT_WORD_RE)) {
    const name = match[1];
    if (STOPWORDS.has(name)) continue;
    // Skip ALL_CAPS constants — they're rarely the failing symbol.
    if (/^[A-Z_]+$/.test(name)) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const ranked = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  return ranked.slice(0, max).map(([n]) => n);
}

async function symbolExistsInIndex(handlers, repoPath, symbol) {
  try {
    const r = readStructured(await withTimeout(
      handlers.cg_search({ repo_path: repoPath, pattern: symbol, limit: 1 }),
      PER_CALL_TIMEOUT_MS,
    ));
    return Boolean(r && Array.isArray(r.results) && r.results.length > 0);
  } catch { return false; }
}

async function callersForSymbol(handlers, repoPath, symbol) {
  try {
    const g = readStructured(await withTimeout(
      handlers.cg_call_graph({
        repo_path: repoPath, symbol, direction: 'callers', depth: CALLERS_DEPTH,
      }),
      PER_CALL_TIMEOUT_MS,
    ));
    if (!g || !Array.isArray(g.nodes) || g.nodes.length === 0) return null;
    // Drop the seed node (the symbol itself). cg_call_graph includes it.
    const callers = g.nodes
      .map((n) => (n && typeof n.name === 'string' ? n.name : ''))
      .filter((n) => n && n !== symbol);
    return {
      symbol,
      callers,
      truncated: Boolean(g.truncated),
    };
  } catch { return null; }
}

function formatMarkdown(blocks) {
  if (!blocks.length) return '';
  const lines = [
    '── codegraph callers (smart-diagnosis enrichment) ──',
    '',
    'The verify error references the symbols below. cg_call_graph found these',
    'caller-side dependencies (depth=2). Confirm your fix does not break them.',
    '',
  ];
  for (const b of blocks) {
    const trunc = b.truncated ? ' (truncated — caller set is wider)' : '';
    if (b.callers.length === 0) {
      lines.push(`- \`${b.symbol}\`: 0 callers found${trunc}`);
      continue;
    }
    const sample = b.callers.slice(0, MAX_CALLERS_PER_SYMBOL).map((n) => `\`${n}\``).join(', ');
    const more = b.callers.length > MAX_CALLERS_PER_SYMBOL
      ? ` (+${b.callers.length - MAX_CALLERS_PER_SYMBOL} more)`
      : '';
    lines.push(`- \`${b.symbol}\` callers (${b.callers.length}${trunc}): ${sample}${more}`);
  }
  return lines.join('\n');
}

// Public entrypoint. Always resolves; returns '' (empty string) when there's
// nothing useful to inject — callers append unconditionally.
async function enrichFixPromptWithCodegraph({
  repoPath,
  errorText,
  handlers = null,
} = {}) {
  if (typeof repoPath !== 'string' || !repoPath) return '';
  if (typeof errorText !== 'string' || !errorText) return '';

  const cg = handlers || defaultCodegraphHandlers();
  if (!cg) return '';

  // Skip if the index isn't built — cg_search would return false negatives
  // for real symbols and we'd contribute zero signal.
  try {
    const status = readStructured(await withTimeout(
      cg.cg_index_status({ repo_path: repoPath }),
      PER_CALL_TIMEOUT_MS,
    ));
    if (!status || status.indexed !== true) return '';
  } catch { return ''; }

  const candidates = extractCandidateSymbols(errorText);
  if (candidates.length === 0) return '';

  const blocks = [];
  for (const symbol of candidates) {
    if (!(await symbolExistsInIndex(cg, repoPath, symbol))) continue;
    const callers = await callersForSymbol(cg, repoPath, symbol);
    if (callers) blocks.push(callers);
    if (blocks.length >= 3) break;   // cap output: 3 symbols × MAX_CALLERS rows is plenty
  }
  return formatMarkdown(blocks);
}

module.exports = {
  enrichFixPromptWithCodegraph,
  extractCandidateSymbols,
  formatMarkdown,
  defaultCodegraphHandlers,
  MAX_CANDIDATES,
  MAX_CALLERS_PER_SYMBOL,
};
