import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { providers as providersApi, request } from '../api';

const STATUS_DOT = {
  healthy: 'bg-green-500',
  degraded: 'bg-yellow-500',
  unavailable: 'bg-red-500',
  disabled: 'bg-slate-600',
};

const STATUS_TEXT = {
  healthy: 'text-slate-200',
  degraded: 'text-slate-200',
  unavailable: 'text-slate-200',
  disabled: 'text-slate-500',
};

function getRunningTaskCount(raw) {
  if (Array.isArray(raw?.tasks)) return raw.tasks.length;
  const total = Number(raw?.pagination?.total);
  return Number.isFinite(total) ? total : 0;
}

export default function HealthBar() {
  const [providerList, setProviderList] = useState([]);
  const [runningCount, setRunningCount] = useState(0);
  const [providerError, setProviderError] = useState(null);
  const [tasksError, setTasksError] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef(null);

  const refresh = useCallback(async (active = { current: true }) => {
    const [provResult, runResult] = await Promise.allSettled([
      providersApi.list(),
      request('/tasks?status=running'),
    ]);

    if (!active.current) return;

    if (provResult.status === 'fulfilled') {
      const raw = provResult.value;
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.providers) ? raw.providers : [];
      setProviderList(list);
      setProviderError(null);
    } else {
      setProviderError(provResult.reason?.message || 'Failed to load providers');
    }

    if (runResult.status === 'fulfilled') {
      setRunningCount(getRunningTaskCount(runResult.value));
      setTasksError(null);
    } else {
      setTasksError(runResult.reason?.message || 'Failed to load tasks');
    }
  }, []);

  useEffect(() => {
    const active = { current: true };
    refresh(active);
    const id = window.setInterval(() => refresh(active), 30000);
    return () => { active.current = false; window.clearInterval(id); };
  }, [refresh]);

  // Click outside to close
  useEffect(() => {
    if (!expanded) return;
    function handleMouseDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setExpanded(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [expanded]);

  const healthyCount = useMemo(
    () => providerList.filter((p) => p.status === 'healthy').length,
    [providerList],
  );

  const providerSummary = providerList.length === 0
    ? 'none'
    : `${healthyCount}/${providerList.length}`;

  return (
    <div ref={containerRef} className="glass-card mb-4 relative">
      {/* Compact bar */}
      <div className="flex flex-wrap items-center gap-6 p-3 text-xs text-slate-400">
        <button
          onClick={() => !providerError && setExpanded((s) => !s)}
          className="flex items-center gap-2 hover:text-slate-200 transition-colors"
        >
          <span>Providers:</span>
          {providerError ? (
            <span className="font-medium tabular-nums text-red-400" title={providerError}>err</span>
          ) : (
            <>
              <span className="font-medium tabular-nums text-slate-200">{providerSummary}</span>
              {providerList.length > 0 && <span className="text-[10px]">healthy</span>}
              <span className="text-[10px] text-slate-500">{expanded ? '▴' : '▾'}</span>
            </>
          )}
        </button>
        <div className="flex items-center gap-2">
          <span>Queue:</span>
          {tasksError ? (
            <span className="font-medium tabular-nums text-red-400" title={tasksError}>err</span>
          ) : (
            <span className="font-medium tabular-nums text-slate-200">{runningCount}</span>
          )}
        </div>
      </div>

      {/* Expanded popover */}
      {expanded && providerList.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-slate-800/95 border border-slate-700 rounded-lg p-3 shadow-lg z-50 max-h-64 overflow-y-auto">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
            {providerList.map((p) => (
              <div key={p.id} className="flex items-center gap-2 py-0.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[p.status] || STATUS_DOT.disabled}`} />
                <span className={STATUS_TEXT[p.status] || STATUS_TEXT.disabled}>{p.id}</span>
                {p.status !== 'healthy' && (
                  <span className={`text-[10px] ${
                    p.status === 'degraded' ? 'text-yellow-500' :
                    p.status === 'unavailable' ? 'text-red-500' :
                    'text-slate-500'
                  }`}>
                    {p.status}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
