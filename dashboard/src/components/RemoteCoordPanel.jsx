import { useEffect, useState } from 'react';

const POLL_INTERVAL_MS = 5000;

function shortSha(sha) {
  if (!sha) return '';
  return String(sha).slice(0, 8);
}

function elapsedSeconds(isoStart) {
  if (!isoStart) return null;
  const startMs = Date.parse(isoStart);
  if (Number.isNaN(startMs)) return null;
  return Math.max(0, Math.round((Date.now() - startMs) / 1000));
}

function formatElapsed(secs) {
  if (secs == null) return '—';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

export function RemoteCoordPanel() {
  const [payload, setPayload] = useState(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch('/api/coord/active', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) {
          setPayload(body);
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err && err.message ? err.message : 'fetch failed');
      }
    };

    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (loadError) {
    return (
      <div
        role="status"
        aria-label="Remote coordinator panel error"
        className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-amber-100 text-sm"
      >
        Workstation coord panel: {loadError}
      </div>
    );
  }

  if (!payload) {
    return (
      <div
        role="status"
        aria-label="Loading workstation coord state"
        className="rounded-lg border border-slate-700/40 bg-slate-800/40 px-4 py-2 text-slate-400 text-sm"
      >
        Loading workstation coord…
      </div>
    );
  }

  if (!payload.reachable) {
    return (
      <div
        role="status"
        aria-label="Workstation coord daemon not reachable"
        className="rounded-lg border border-slate-700/40 bg-slate-800/40 px-4 py-2 text-slate-400 text-sm"
      >
        Workstation coord daemon: not reachable
        {payload.error ? <span className="ml-2 font-mono text-xs text-slate-500">({payload.error})</span> : null}
      </div>
    );
  }

  if (!payload.active || payload.active.length === 0) {
    return (
      <div
        role="status"
        aria-label="Workstation idle"
        className="rounded-lg border border-slate-700/40 bg-slate-800/40 px-4 py-2 text-slate-400 text-sm"
      >
        Workstation idle — no active runs.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-700/40 bg-slate-800/40 overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-700/40 text-sm text-slate-300">
        Workstation: {payload.active.length} active run{payload.active.length === 1 ? '' : 's'}
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-900/40 text-xs text-slate-400">
          <tr>
            <th className="text-left p-2 font-medium">Project</th>
            <th className="text-left p-2 font-medium">SHA</th>
            <th className="text-left p-2 font-medium">Suite</th>
            <th className="text-left p-2 font-medium">Host</th>
            <th className="text-left p-2 font-medium">Started</th>
            <th className="text-left p-2 font-medium">Elapsed</th>
          </tr>
        </thead>
        <tbody>
          {payload.active.map((lock) => (
            <tr key={lock.lock_id} className="border-t border-slate-700/30 text-slate-200">
              <td className="p-2">{lock.project}</td>
              <td className="p-2 font-mono text-xs">{shortSha(lock.sha)}</td>
              <td className="p-2">{lock.suite}</td>
              <td className="p-2 text-xs text-slate-400">
                {lock.holder?.host || '?'}:{lock.holder?.pid ?? '?'}
              </td>
              <td className="p-2 text-xs text-slate-400">
                {lock.created_at ? new Date(lock.created_at).toLocaleTimeString() : '—'}
              </td>
              <td className="p-2 text-xs text-slate-400">
                {formatElapsed(elapsedSeconds(lock.created_at))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default RemoteCoordPanel;
