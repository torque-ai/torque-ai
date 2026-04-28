'use strict';

const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { createHandlers } = require('../handlers');
const telemetry = require('../telemetry');
const toolDefs = require('../tool-defs');
const { setupTinyRepo, destroyTinyRepo } = require('../test-helpers');

const data = (r) => r.structuredData;

describe('codegraph shadow-mode telemetry', () => {
  let db, repo, rawHandlers, instrumented;

  beforeEach(async () => {
    db = new Database(':memory:'); ensureSchema(db);
    repo = setupTinyRepo();
    rawHandlers = createHandlers({ db });
    instrumented = telemetry.instrument(rawHandlers, db);
    // Index synchronously so subsequent queries see data.
    await rawHandlers.cg_reindex({ repo_path: repo, async: false });
  });

  afterEach(() => { db.close(); destroyTinyRepo(repo); });

  function usageRows() {
    return db.prepare('SELECT * FROM cg_tool_usage ORDER BY id').all();
  }

  it('records one cg_tool_usage row per instrumented call', async () => {
    await instrumented.cg_find_references({ repo_path: repo, symbol: 'beta' });
    const rows = usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('cg_find_references');
    expect(rows[0].repo_path).toBe(repo);
    expect(rows[0].ok).toBe(1);
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof rows[0].at).toBe('string');
    expect(rows[0].result_count).toBeGreaterThanOrEqual(1); // beta has at least one ref
    expect(rows[0].truncated).toBe(0);
    expect(rows[0].staleness_stale).toBe(0);
  });

  it('captures scope/direction/depth from query args', async () => {
    await instrumented.cg_call_graph({
      repo_path: repo, symbol: 'alpha', direction: 'callees', depth: 2, scope: 'strict',
    });
    const row = usageRows()[0];
    expect(row.tool).toBe('cg_call_graph');
    expect(row.scope).toBe('strict');
    expect(row.direction).toBe('callees');
    expect(row.depth).toBe(2);
  });

  it('records ok=0 + error_kind=usage_error when args fail validation', async () => {
    await expect(instrumented.cg_find_references({})).rejects.toThrow(/repo_path/);
    const row = usageRows()[0];
    expect(row.tool).toBe('cg_find_references');
    expect(row.ok).toBe(0);
    expect(row.error_kind).toBe('usage_error');
    expect(row.repo_path).toBeNull();   // missing arg, so column is NULL
  });

  it('records ok=0 + error_kind=internal_error when handler throws an unexpected error', async () => {
    // Build a handler map where cg_find_references throws something not matching
    // the usage_error regex. The wrapper should classify it as internal_error.
    const broken = telemetry.instrument({
      cg_find_references: async () => { throw new Error('database is on fire'); },
    }, db);
    await expect(broken.cg_find_references({ repo_path: repo, symbol: 'x' })).rejects.toThrow();
    const row = usageRows()[0];
    expect(row.ok).toBe(0);
    expect(row.error_kind).toBe('internal_error');
  });

  it('TELEMETRY_TOOLS covers every declared cg_* tool except cg_telemetry', () => {
    // Regression guard: a new cg_* tool added to tool-defs without being
    // added to TELEMETRY_TOOLS silently bypasses the recorder. cg_telemetry
    // is the only allowed exemption (it surfaces telemetry; recording it
    // would be recursive).
    const declared = toolDefs.map((t) => t.name);
    const missing = declared.filter(
      (name) => name !== 'cg_telemetry' && !telemetry.TELEMETRY_TOOLS.has(name),
    );
    expect(missing).toEqual([]);
  });

  it('cg_search / cg_diff / cg_resolution_diagnostics each record one row', async () => {
    // Tightens the regression guard above: every new tool that just shipped
    // must produce at least one cg_tool_usage row when invoked through the
    // wrapper. If any of these slip out of TELEMETRY_TOOLS in the future,
    // this test fails before review.
    await instrumented.cg_search({ repo_path: repo, pattern: '*', limit: 5 });
    await instrumented.cg_resolution_diagnostics({ repo_path: repo, symbol: 'beta' });
    // cg_diff needs two reachable shas — repo has only one commit, but
    // gitShaReachable checks `<sha>^{commit}` so HEAD-vs-HEAD is reachable.
    const { execFileSync } = require('child_process');
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    await instrumented.cg_diff({ repo_path: repo, from_sha: sha, to_sha: sha });

    const tools = usageRows().map((r) => r.tool).sort();
    expect(tools).toContain('cg_search');
    expect(tools).toContain('cg_diff');
    expect(tools).toContain('cg_resolution_diagnostics');
  });

  it('cg_telemetry is NOT itself instrumented (no recursion / measurement bias)', async () => {
    // Call cg_find_references twice, then cg_telemetry. cg_telemetry must not
    // create a cg_tool_usage row — it surfaces telemetry, doesn't generate it.
    await instrumented.cg_find_references({ repo_path: repo, symbol: 'beta' });
    await instrumented.cg_find_references({ repo_path: repo, symbol: 'alpha' });
    const before = usageRows().length;
    expect(before).toBe(2);
    await rawHandlers.cg_telemetry({ since_hours: 24 });
    expect(usageRows().length).toBe(2);
  });

  it('cg_telemetry summarizes the recent window', async () => {
    await instrumented.cg_find_references({ repo_path: repo, symbol: 'beta', scope: 'loose' });
    await instrumented.cg_find_references({ repo_path: repo, symbol: 'beta', scope: 'strict' });
    await instrumented.cg_call_graph({ repo_path: repo, symbol: 'alpha', direction: 'callees', depth: 1 });

    const r = data(await rawHandlers.cg_telemetry({ since_hours: 24 }));
    expect(r.since_hours).toBe(24);
    expect(r.total_calls).toBe(3);

    const refs = r.tools.find((x) => x.tool === 'cg_find_references');
    expect(refs).toBeTruthy();
    expect(refs.calls).toBe(2);
    expect(refs.strict_pct).toBe(50);   // 1 of 2 scope-tagged calls
    expect(refs.error_pct).toBe(0);

    const cg = r.tools.find((x) => x.tool === 'cg_call_graph');
    expect(cg).toBeTruthy();
    expect(cg.calls).toBe(1);
  });

  it('cg_telemetry tool=<name> filters to one tool', async () => {
    await instrumented.cg_find_references({ repo_path: repo, symbol: 'beta' });
    await instrumented.cg_call_graph({ repo_path: repo, symbol: 'alpha', direction: 'callees', depth: 1 });
    const r = data(await rawHandlers.cg_telemetry({ since_hours: 24, tool: 'cg_find_references' }));
    expect(r.tool_filter).toBe('cg_find_references');
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0].tool).toBe('cg_find_references');
    expect(r.total_calls).toBe(1);
  });

  it('summarize() respects the sinceHours window — old rows are excluded', async () => {
    // Insert a row dated 48 hours ago. since_hours=24 must NOT include it.
    const oldIso = new Date(Date.now() - 48 * 3600_000).toISOString();
    db.prepare(
      `INSERT INTO cg_tool_usage (tool, duration_ms, ok, at) VALUES ('cg_find_references', 5, 1, ?)`,
    ).run(oldIso);
    // And one fresh row.
    await instrumented.cg_find_references({ repo_path: repo, symbol: 'beta' });

    const r = data(await rawHandlers.cg_telemetry({ since_hours: 24 }));
    const refs = r.tools.find((x) => x.tool === 'cg_find_references');
    expect(refs.calls).toBe(1); // only the fresh one
  });

  it('telemetry insert errors do not break the underlying handler call', async () => {
    // Drop the telemetry table after install so the recorder's INSERT fails.
    db.prepare('DROP TABLE cg_tool_usage').run();
    // Handler still returns successfully.
    const r = await instrumented.cg_find_references({ repo_path: repo, symbol: 'beta' });
    expect(r.structuredData.references.length).toBeGreaterThanOrEqual(1);
    // No table = nothing to verify, but the absence of a thrown exception
    // is the assertion. Recreate so afterEach close doesn't trip.
    ensureSchema(db);
  });

  it('pruneOlderThan deletes rows older than keepDays', () => {
    const oldIso = new Date(Date.now() - 60 * 86400_000).toISOString();
    const newIso = new Date().toISOString();
    db.prepare(`INSERT INTO cg_tool_usage (tool, duration_ms, ok, at) VALUES ('cg_find_references', 1, 1, ?)`).run(oldIso);
    db.prepare(`INSERT INTO cg_tool_usage (tool, duration_ms, ok, at) VALUES ('cg_find_references', 1, 1, ?)`).run(newIso);
    const removed = telemetry.pruneOlderThan(db, { keepDays: 30 });
    expect(removed).toBe(1);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM cg_tool_usage').get().n;
    expect(remaining).toBe(1);
  });
});
