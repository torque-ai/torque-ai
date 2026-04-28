import { useCallback, useEffect, useState } from 'react';
import { codegraph } from '../api';

// localStorage key for the last repo_path the operator queried — saves
// re-typing every visit. We don't auto-discover it from the URL because
// codegraph indexes can span multiple unrelated repos.
const REPO_PATH_KEY = 'torque-codegraph-repo-path';

function readStoredRepoPath() {
  try { return localStorage.getItem(REPO_PATH_KEY) || ''; }
  catch { return ''; }
}

function writeStoredRepoPath(value) {
  try { localStorage.setItem(REPO_PATH_KEY, value); }
  catch { /* private mode / quota — ignore */ }
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function StatusBadge({ stale, indexed }) {
  if (!indexed) {
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-700/40 text-slate-300">not indexed</span>;
  }
  if (stale) {
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-300">stale</span>;
  }
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-300">fresh</span>;
}

function IndexStatusCard({ repoPath, status, loading, error, onReindex, reindexing }) {
  return (
    <section className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4">
      <header className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-200">Index Status</h2>
        <button
          type="button"
          onClick={onReindex}
          disabled={!repoPath || reindexing}
          className="px-3 py-1 rounded-md text-xs font-medium bg-blue-600/20 text-blue-300 border border-blue-500/30 hover:bg-blue-600/30 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {reindexing ? 'Reindexing…' : 'Reindex'}
        </button>
      </header>
      {loading && <div className="text-sm text-slate-400">Loading…</div>}
      {error && <div className="text-sm text-rose-300">Error: {error}</div>}
      {!loading && !error && status && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-slate-400">State</dt>
          <dd><StatusBadge indexed={status.indexed} stale={status.staleness?.stale} /></dd>
          <dt className="text-slate-400">Indexed SHA</dt>
          <dd className="font-mono text-xs text-slate-200">
            {status.commit_sha ? status.commit_sha.slice(0, 12) : '—'}
          </dd>
          <dt className="text-slate-400">Current SHA</dt>
          <dd className="font-mono text-xs text-slate-200">
            {status.staleness?.current_sha ? status.staleness.current_sha.slice(0, 12) : '—'}
          </dd>
          <dt className="text-slate-400">Indexed at</dt>
          <dd className="text-slate-200">{fmtDate(status.indexed_at)}</dd>
          <dt className="text-slate-400">Files</dt>
          <dd className="font-mono text-slate-200">{status.files ?? '—'}</dd>
          <dt className="text-slate-400">Symbols</dt>
          <dd className="font-mono text-slate-200">{status.symbols ?? '—'}</dd>
          <dt className="text-slate-400">References</dt>
          <dd className="font-mono text-slate-200">{status.references ?? '—'}</dd>
        </dl>
      )}
    </section>
  );
}

function TelemetryCard({ telemetry, loading, error }) {
  return (
    <section className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4">
      <header className="mb-3">
        <h2 className="text-sm font-semibold text-slate-200">
          Tool Usage <span className="text-xs font-normal text-slate-400">last {telemetry?.since_hours ?? 24}h</span>
        </h2>
      </header>
      {loading && <div className="text-sm text-slate-400">Loading…</div>}
      {error && <div className="text-sm text-rose-300">Error: {error}</div>}
      {!loading && !error && telemetry && (
        telemetry.tools.length === 0
          ? <div className="text-sm text-slate-400">No cg_* tool calls recorded in the window.</div>
          : (
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left pb-2">Tool</th>
                  <th className="text-right pb-2">Calls</th>
                  <th className="text-right pb-2">Avg ms</th>
                  <th className="text-right pb-2">Strict %</th>
                  <th className="text-right pb-2">Truncated %</th>
                  <th className="text-right pb-2">Stale %</th>
                  <th className="text-right pb-2">Errors %</th>
                </tr>
              </thead>
              <tbody className="text-slate-200">
                {telemetry.tools.map((row) => (
                  <tr key={row.tool} className="border-t border-slate-800/50">
                    <td className="py-1 font-mono">{row.tool}</td>
                    <td className="py-1 text-right font-mono">{row.calls}</td>
                    <td className="py-1 text-right font-mono">{row.avg_duration_ms ?? '—'}</td>
                    <td className="py-1 text-right font-mono">{row.strict_pct ?? '—'}</td>
                    <td className="py-1 text-right font-mono">{row.truncation_pct}</td>
                    <td className="py-1 text-right font-mono">{row.staleness_pct}</td>
                    <td className={`py-1 text-right font-mono ${row.error_pct > 0 ? 'text-rose-300' : ''}`}>{row.error_pct}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="text-slate-400">
                <tr className="border-t border-slate-800">
                  <td className="pt-2">Total</td>
                  <td className="pt-2 text-right font-mono">{telemetry.total_calls}</td>
                  <td colSpan={5}></td>
                </tr>
              </tfoot>
            </table>
          )
      )}
    </section>
  );
}

function SearchCard({ repoPath }) {
  const [pattern, setPattern] = useState('');
  const [kind, setKind] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const onSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!repoPath || !pattern) return;
    setLoading(true);
    setError(null);
    try {
      const r = await codegraph.search({
        repoPath,
        pattern,
        kind: kind || null,
        limit: 50,
      });
      setResults(r);
    } catch (err) {
      setError(err?.message || String(err));
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, [repoPath, pattern, kind]);

  return (
    <section className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4">
      <header className="mb-3">
        <h2 className="text-sm font-semibold text-slate-200">Symbol Search</h2>
      </header>
      <form onSubmit={onSubmit} className="flex flex-wrap gap-2 mb-3">
        <input
          type="text"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder='Pattern (e.g. create*, *Handler)'
          className="flex-1 min-w-[200px] px-3 py-1.5 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/50"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="px-3 py-1.5 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200"
        >
          <option value="">any kind</option>
          <option value="function">function</option>
          <option value="class">class</option>
          <option value="method">method</option>
          <option value="constructor">constructor</option>
          <option value="interface">interface</option>
        </select>
        <button
          type="submit"
          disabled={!repoPath || !pattern || loading}
          className="px-4 py-1.5 rounded-md text-sm font-medium bg-blue-600/20 text-blue-300 border border-blue-500/30 hover:bg-blue-600/30 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error && <div className="text-sm text-rose-300 mb-2">Error: {error}</div>}
      {results && (
        <div>
          <div className="text-xs text-slate-400 mb-2">
            {results.results.length} result{results.results.length === 1 ? '' : 's'}
            {results.truncated ? ` (truncated at ${results.limit})` : ''}
          </div>
          {results.results.length > 0 && (
            <ul className="text-xs space-y-1 max-h-64 overflow-y-auto pr-2">
              {results.results.map((s, i) => (
                <li key={i} className="font-mono text-slate-200 flex items-baseline gap-2">
                  <span className="text-blue-300">{s.name}</span>
                  <span className="text-slate-500">[{s.kind}]</span>
                  {s.container && <span className="text-amber-300">in {s.container}</span>}
                  <span className="text-slate-400 truncate">{s.file}:{s.line}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export default function Codegraph() {
  const [repoPath, setRepoPath] = useState(readStoredRepoPath);
  const [submittedRepoPath, setSubmittedRepoPath] = useState(readStoredRepoPath);
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState(null);
  const [reindexing, setReindexing] = useState(false);
  const [telemetry, setTelemetry] = useState(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState(null);

  const fetchStatus = useCallback(async (path) => {
    if (!path) return;
    setStatusLoading(true);
    setStatusError(null);
    try {
      const r = await codegraph.indexStatus(path);
      setStatus(r);
    } catch (err) {
      setStatusError(err?.message || String(err));
      setStatus(null);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const fetchTelemetry = useCallback(async () => {
    setTelemetryLoading(true);
    setTelemetryError(null);
    try {
      const r = await codegraph.telemetry(24);
      setTelemetry(r);
    } catch (err) {
      setTelemetryError(err?.message || String(err));
      setTelemetry(null);
    } finally {
      setTelemetryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (submittedRepoPath) fetchStatus(submittedRepoPath);
  }, [submittedRepoPath, fetchStatus]);

  useEffect(() => {
    fetchTelemetry();
  }, [fetchTelemetry]);

  const onSubmitPath = useCallback((e) => {
    e.preventDefault();
    writeStoredRepoPath(repoPath);
    setSubmittedRepoPath(repoPath);
  }, [repoPath]);

  const onReindex = useCallback(async () => {
    if (!submittedRepoPath) return;
    setReindexing(true);
    try {
      await codegraph.reindex({ repo_path: submittedRepoPath, async: true });
      setTimeout(() => fetchStatus(submittedRepoPath), 1500);
    } catch (err) {
      setStatusError(err?.message || String(err));
    } finally {
      setReindexing(false);
    }
  }, [submittedRepoPath, fetchStatus]);

  const onRefreshTelemetry = useCallback(() => fetchTelemetry(), [fetchTelemetry]);

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Code Graph</h1>
          <p className="text-sm text-slate-400 mt-1">
            Symbol/reference index for any repo TORQUE has indexed. Set <code className="px-1 py-0.5 rounded bg-slate-800 text-slate-300">TORQUE_CODEGRAPH_ENABLED=1</code> to enable.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefreshTelemetry}
          className="px-3 py-1 rounded-md text-xs font-medium border border-slate-700 text-slate-300 hover:bg-slate-800/40"
        >
          Refresh telemetry
        </button>
      </header>

      <form onSubmit={onSubmitPath} className="flex gap-2">
        <input
          type="text"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder='Repo root path (absolute)'
          className="flex-1 px-3 py-1.5 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/50 font-mono"
        />
        <button
          type="submit"
          disabled={!repoPath}
          className="px-4 py-1.5 rounded-md text-sm font-medium bg-blue-600/20 text-blue-300 border border-blue-500/30 hover:bg-blue-600/30 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Load
        </button>
      </form>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <IndexStatusCard
          repoPath={submittedRepoPath}
          status={status}
          loading={statusLoading}
          error={statusError}
          onReindex={onReindex}
          reindexing={reindexing}
        />
        <TelemetryCard
          telemetry={telemetry}
          loading={telemetryLoading}
          error={telemetryError}
        />
      </div>
      <SearchCard repoPath={submittedRepoPath} />
    </div>
  );
}
