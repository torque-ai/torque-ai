import { useState, useEffect, useCallback, useRef } from 'react';
import { codexBreaker as codexBreakerApi, factory as factoryApi } from '../api';
import LoadingSkeleton from '../components/LoadingSkeleton';
import { useToast } from '../components/Toast';

const POLL_MS = 5000;

const STATE_STYLES = {
  CLOSED: 'bg-green-600/20 text-green-300 border-green-500/40',
  OPEN: 'bg-red-600/20 text-red-300 border-red-500/40',
  HALF_OPEN: 'bg-amber-600/20 text-amber-300 border-amber-500/40',
};

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function StateBadge({ state }) {
  const label = state || 'UNKNOWN';
  const className = STATE_STYLES[label] || 'bg-slate-600/20 text-slate-300 border-slate-500/40';
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border ${className}`}>
      {label}
    </span>
  );
}

function getErrorMessage(err, fallback) {
  return err?.message || fallback;
}

function DashboardErrorState({ title, message, onRetry, retryLabel = 'Retry' }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-600/40 bg-red-950/40 px-4 py-3 text-sm text-red-200"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-semibold text-red-100">{title}</p>
          <p className="mt-1 text-red-200/80">{message}</p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="self-start rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-100 transition-colors hover:bg-red-500/20"
        >
          {retryLabel}
        </button>
      </div>
    </div>
  );
}

export default function CodexBreaker() {
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState(null);
  const [parked, setParked] = useState([]);
  const [parkedLoading, setParkedLoading] = useState(true);
  const [parkedError, setParkedError] = useState(null);
  const [parkedPartialError, setParkedPartialError] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const loadStatus = useCallback(async () => {
    if (mountedRef.current) {
      setStatusLoading(true);
      setStatusError(null);
    }
    try {
      const data = await codexBreakerApi.getStatus();
      if (mountedRef.current) {
        setStatus(data || null);
      }
    } catch (err) {
      console.error('Failed to load Codex breaker status:', err);
      if (mountedRef.current) {
        setStatusError(getErrorMessage(err, 'Failed to load Codex breaker status.'));
      }
    } finally {
      if (mountedRef.current) setStatusLoading(false);
    }
  }, []);

  const loadParked = useCallback(async () => {
    if (mountedRef.current) {
      setParkedLoading(true);
      setParkedError(null);
      setParkedPartialError(null);
    }
    try {
      const projectsResp = await factoryApi.projects();
      const projects = projectsResp?.items || projectsResp || [];
      if (!Array.isArray(projects) || projects.length === 0) {
        if (mountedRef.current) {
          setParked([]);
        }
        return;
      }
      const all = [];
      let failures = 0;
      for (const proj of projects) {
        try {
          const resp = await factoryApi.intake(proj.id, { status: 'parked_codex_unavailable', limit: 50 });
          const items = resp?.items || [];
          for (const item of items) {
            all.push({ ...item, project_id: item.project_id || proj.id, project_name: proj.name || proj.id });
          }
        } catch (err) {
          // Per-project failure is non-fatal — continue with the rest, but
          // surface the global-failure soft-fail UI if every project fails.
          console.error(`Failed to load parked items for project ${proj.id}:`, err);
          failures += 1;
        }
      }
      if (mountedRef.current) {
        setParked(all);
        if (failures === projects.length) {
          setParkedError('Every project intake request failed.');
        } else if (failures > 0) {
          const projectLabel = failures === 1 ? 'project' : 'projects';
          setParkedPartialError(`Some parked items could not be loaded (${failures} ${projectLabel} failed).`);
        }
      }
    } catch (err) {
      console.error('Parked items unavailable:', err);
      if (mountedRef.current) {
        setParked([]);
        setParkedError(getErrorMessage(err, 'Factory projects request failed.'));
      }
    } finally {
      if (mountedRef.current) setParkedLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadParked();
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadStatus();
      loadParked();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [loadStatus, loadParked]);

  async function handleTrip() {
    setBusy(true);
    try {
      await codexBreakerApi.trip(reason || 'manual');
      toast.success('Codex breaker tripped');
      setReason('');
      await loadStatus();
    } catch (err) {
      toast.error(`Trip failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleUntrip() {
    setBusy(true);
    try {
      await codexBreakerApi.untrip(reason || 'manual');
      toast.success('Codex breaker untripped');
      setReason('');
      await loadStatus();
      await loadParked();
    } catch (err) {
      toast.error(`Untrip failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  const live = status?.state || {};
  const persisted = status?.persisted || {};
  const liveState = live.state || 'UNKNOWN';

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="heading-lg text-white">Codex Breaker</h2>
        <p className="text-sm text-slate-400 mt-1">
          Manual control over the Codex circuit breaker and visibility into work items parked under
          {' '}<code className="text-slate-300">parked_codex_unavailable</code>.
        </p>
      </div>

      <section className="glass-card p-6">
        {statusLoading && !status ? (
          <LoadingSkeleton lines={4} height={18} />
        ) : statusError && !status ? (
          <DashboardErrorState
            title="Codex breaker status unavailable"
            message={statusError}
            onRetry={loadStatus}
          />
        ) : (
          <>
            {statusError && (
              <div className="mb-4 rounded-lg border border-amber-600/40 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <span>Could not refresh Codex breaker status: {statusError}</span>
                  <button
                    type="button"
                    onClick={loadStatus}
                    className="self-start rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-500/20"
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="space-y-1">
                <div className="flex items-center gap-3">
                  <StateBadge state={liveState} />
                  <span className="text-sm text-slate-400">In-memory state machine</span>
                  {statusLoading && <span className="text-xs uppercase tracking-wide text-slate-500">Refreshing</span>}
                </div>
                <p className="text-xs text-slate-500">
                  Consecutive failures: <span className="text-slate-300">{live.consecutiveFailures ?? 0}</span>
                  {' · '}
                  Last failure category: <span className="text-slate-300">{live.lastFailureCategory || '—'}</span>
                </p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-3">
                  <StateBadge state={persisted.state || 'UNKNOWN'} />
                  <span className="text-sm text-slate-400">Persisted record</span>
                </div>
                <p className="text-xs text-slate-500">
                  Tripped at: <span className="text-slate-300">{formatDate(persisted.tripped_at)}</span>
                  {' · '}
                  Reason: <span className="text-slate-300">{persisted.trip_reason || '—'}</span>
                </p>
              </div>
            </div>

            <div className="mt-6 flex items-center gap-3 flex-wrap">
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (optional)"
                className="flex-1 min-w-[240px] bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={handleTrip}
                disabled={busy}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
              >
                Trip
              </button>
              <button
                type="button"
                onClick={handleUntrip}
                disabled={busy}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
              >
                Untrip
              </button>
            </div>
          </>
        )}
      </section>

      <section className="glass-card p-6">
        <div className="mb-3 flex items-center gap-3">
          <h3 className="heading-md text-white">Parked Work Items</h3>
          {parkedLoading && parked.length > 0 && (
            <span className="text-xs uppercase tracking-wide text-slate-500">Refreshing</span>
          )}
        </div>
        {parkedLoading && parked.length === 0 && !parkedError ? (
          <div>
            <p className="mb-3 text-sm text-slate-400">Loading parked work items...</p>
            <LoadingSkeleton lines={4} height={18} />
          </div>
        ) : parkedError ? (
          <DashboardErrorState
            title="Parked items unavailable"
            message={parkedError}
            onRetry={loadParked}
          />
        ) : (
          <>
            {parkedPartialError && (
              <div
                role="status"
                className="mb-4 rounded-lg border border-amber-600/40 bg-amber-950/40 px-4 py-3 text-sm text-amber-200"
              >
                {parkedPartialError}
              </div>
            )}
            {parked.length === 0 ? (
              <p className="text-sm text-slate-400">No work items currently parked under <code>parked_codex_unavailable</code>.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50 text-left">
                    <th className="p-2 heading-sm">ID</th>
                    <th className="p-2 heading-sm">Project</th>
                    <th className="p-2 heading-sm">Title</th>
                    <th className="p-2 heading-sm">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {parked.map((item) => (
                    <tr key={`${item.project_id}-${item.id}`} className="border-b border-slate-700/30">
                      <td className="p-2 text-slate-400">#{item.id}</td>
                      <td className="p-2 text-slate-300">{item.project_name || item.project_id}</td>
                      <td className="p-2 text-white">{item.title || '—'}</td>
                      <td className="p-2 text-slate-400">{formatDate(item.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </div>
  );
}
