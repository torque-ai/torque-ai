'use strict';

// Shadow-mode telemetry for cg_* tool invocations.
//
// Wraps each MCP handler in a measure-and-record envelope. Insertion is
// best-effort: any error in the recorder is swallowed so a failed write to
// cg_tool_usage never breaks the underlying tool call.

const TELEMETRY_TOOLS = new Set([
  'cg_index_status',
  'cg_reindex',
  'cg_find_references',
  'cg_call_graph',
  'cg_impact_set',
  'cg_dead_symbols',
  'cg_class_hierarchy',
  'cg_resolve_tool',
]);

// Pull the result_count out of the structured payload using each tool's
// shape. Returning null is fine — the column is nullable.
function resultCountFor(toolName, structured) {
  if (!structured || typeof structured !== 'object') return null;
  switch (toolName) {
    case 'cg_find_references':
      return Array.isArray(structured.references) ? structured.references.length : null;
    case 'cg_call_graph':
    case 'cg_class_hierarchy':
      return Array.isArray(structured.nodes) ? structured.nodes.length : null;
    case 'cg_impact_set':
      return Array.isArray(structured.symbols) ? structured.symbols.length : null;
    case 'cg_dead_symbols':
      return Array.isArray(structured.dead_symbols) ? structured.dead_symbols.length : null;
    case 'cg_resolve_tool':
      return Array.isArray(structured.handlers) ? structured.handlers.length : null;
    case 'cg_index_status':
    case 'cg_reindex':
      return null;
    default:
      return null;
  }
}

function classifyError(err) {
  const msg = String(err?.message || err || '');
  if (/missing required argument|must be|requires scope/i.test(msg)) return 'usage_error';
  return 'internal_error';
}

// Record one row. Always swallows errors — telemetry must never bubble up.
function record(db, entry) {
  try {
    db.prepare(`
      INSERT INTO cg_tool_usage (
        tool, repo_path, scope, direction, depth,
        duration_ms, result_count, truncated, staleness_stale,
        ok, error_kind, at
      ) VALUES (
        @tool, @repo_path, @scope, @direction, @depth,
        @duration_ms, @result_count, @truncated, @staleness_stale,
        @ok, @error_kind, @at
      )
    `).run({
      tool:            entry.tool,
      repo_path:       entry.repo_path ?? null,
      scope:           entry.scope ?? null,
      direction:       entry.direction ?? null,
      depth:           entry.depth ?? null,
      duration_ms:     entry.duration_ms,
      result_count:    entry.result_count ?? null,
      truncated:       entry.truncated ? 1 : 0,
      staleness_stale: entry.staleness_stale ? 1 : 0,
      ok:              entry.ok ? 1 : 0,
      error_kind:      entry.error_kind ?? null,
      at:              entry.at,
    });
  } catch {
    // best-effort: ignore (e.g. db locked, disk full, schema missing)
  }
}

// Wrap a handlers map (name -> async fn) so each call records a row.
// Returns a new map; original handlers map is untouched.
function instrument(handlers, db) {
  const out = {};
  for (const [name, handler] of Object.entries(handlers)) {
    if (!TELEMETRY_TOOLS.has(name)) {
      out[name] = handler;
      continue;
    }
    out[name] = async function instrumented(args) {
      const startedAt = Date.now();
      const at = new Date(startedAt).toISOString();
      try {
        const result = await handler(args);
        const structured = result?.structuredData;
        record(db, {
          tool:            name,
          repo_path:       typeof args?.repo_path === 'string' ? args.repo_path : null,
          scope:           typeof args?.scope === 'string' ? args.scope : null,
          direction:       typeof args?.direction === 'string' ? args.direction : null,
          depth:           Number.isInteger(args?.depth) ? args.depth : null,
          duration_ms:     Date.now() - startedAt,
          result_count:    resultCountFor(name, structured),
          truncated:       Boolean(structured?.truncated),
          staleness_stale: Boolean(structured?.staleness?.stale),
          ok:              true,
          at,
        });
        return result;
      } catch (err) {
        record(db, {
          tool:            name,
          repo_path:       typeof args?.repo_path === 'string' ? args.repo_path : null,
          scope:           typeof args?.scope === 'string' ? args.scope : null,
          direction:       typeof args?.direction === 'string' ? args.direction : null,
          depth:           Number.isInteger(args?.depth) ? args.depth : null,
          duration_ms:     Date.now() - startedAt,
          ok:              false,
          error_kind:      classifyError(err),
          at,
        });
        throw err;
      }
    };
  }
  return out;
}

// Aggregate the last `since_hours` window. Optional `tool` filter.
function summarize(db, { sinceHours = 24, tool = null } = {}) {
  const sinceIso = new Date(Date.now() - sinceHours * 3600_000).toISOString();
  const params = { since: sinceIso };
  let filter = 'WHERE at >= @since';
  if (tool) {
    filter += ' AND tool = @tool';
    params.tool = tool;
  }

  const rows = db.prepare(`
    SELECT
      tool,
      COUNT(*)                              AS calls,
      ROUND(AVG(duration_ms), 1)            AS avg_duration_ms,
      MAX(duration_ms)                      AS max_duration_ms,
      SUM(CASE WHEN scope = 'strict' THEN 1 ELSE 0 END) AS strict_calls,
      SUM(CASE WHEN scope = 'loose'  THEN 1 ELSE 0 END) AS loose_calls,
      SUM(CASE WHEN truncated       = 1 THEN 1 ELSE 0 END) AS truncated_calls,
      SUM(CASE WHEN staleness_stale = 1 THEN 1 ELSE 0 END) AS stale_calls,
      SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)              AS error_calls,
      ROUND(AVG(result_count), 1)           AS avg_result_count,
      MAX(at)                               AS last_call_at
    FROM cg_tool_usage
    ${filter}
    GROUP BY tool
    ORDER BY calls DESC
  `).all(params);

  return rows.map((r) => {
    const callsWithScope = (r.strict_calls || 0) + (r.loose_calls || 0);
    return {
      tool: r.tool,
      calls: r.calls,
      avg_duration_ms: r.avg_duration_ms,
      max_duration_ms: r.max_duration_ms,
      avg_result_count: r.avg_result_count,
      strict_pct:     callsWithScope > 0 ? Math.round(100 * r.strict_calls / callsWithScope) : null,
      truncation_pct: r.calls > 0 ? Math.round(100 * r.truncated_calls / r.calls) : 0,
      staleness_pct:  r.calls > 0 ? Math.round(100 * r.stale_calls / r.calls) : 0,
      error_pct:      r.calls > 0 ? Math.round(100 * r.error_calls / r.calls) : 0,
      last_call_at: r.last_call_at,
    };
  });
}

// Hard cap on history retained, for repos that cycle MCP calls heavily.
// Caller is responsible for invoking when convenient (e.g. once at install).
function pruneOlderThan(db, { keepDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();
  return db.prepare('DELETE FROM cg_tool_usage WHERE at < ?').run(cutoff).changes;
}

module.exports = { instrument, summarize, record, pruneOlderThan, TELEMETRY_TOOLS };
