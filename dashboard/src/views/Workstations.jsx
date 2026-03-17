import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { concurrency, workstations as workstationsApi } from '../api';
import { useToast } from '../components/Toast';
import { useAbortableRequest } from '../hooks/useAbortableRequest';

const STATUS_STYLES = {
  healthy: { dot: 'bg-green-500', label: 'Healthy' },
  degraded: { dot: 'bg-yellow-500', label: 'Degraded' },
  down: { dot: 'bg-red-500', label: 'Down' },
  unknown: { dot: 'bg-slate-500', label: 'Unknown' },
};

function CapacityBar({ running, max }) {
  if (!max || max <= 0) return null;
  const percent = Math.min(100, Math.round(((running || 0) / max) * 100));
  const barColor = percent >= 90 ? 'bg-red-500' : percent >= 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-400">Capacity</span>
        <span className="text-slate-300">{running || 0}/{max} ({percent}%)</span>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} transition-all`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function VramBar({ used, total, label = 'VRAM Budget' }) {
  if (!total || total <= 0) return null;
  const percent = Math.min(100, Math.round(((used || 0) / total) * 100));
  const barColor = percent >= 90 ? 'bg-red-500' : percent >= 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-400">{label}</span>
        <span className="text-slate-300">{formatGb(used || 0)}/{formatGb(total)} ({percent}%)</span>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} transition-all`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function safeParseJson(value, fallback) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatGb(megabytes) {
  if (!megabytes) return '0.0 GB';
  return `${(megabytes / 1024).toFixed(megabytes >= 1024 ? 1 : 2)} GB`;
}

function formatCapabilityLabel(capability) {
  return capability.replace(/_/g, ' ');
}

function getCapabilityMap(workstation) {
  if (workstation && workstation._capabilities && typeof workstation._capabilities === 'object') {
    return workstation._capabilities;
  }

  const parsed = safeParseJson(workstation?.capabilities, {});
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function getCapabilities(workstation) {
  return Object.entries(getCapabilityMap(workstation))
    .filter(([, value]) =>
      value === true ||
      (value && typeof value === 'object' && value.detected) ||
      (Array.isArray(value) && value.length > 0)
    )
    .map(([key]) => key)
    .sort();
}

function getModels(workstation) {
  if (Array.isArray(workstation?.models)) return workstation.models;
  return safeParseJson(workstation?.models_cache, []);
}

function normalizeWorkstation(workstation, concurrencyRecord) {
  return {
    ...workstation,
    ...concurrencyRecord,
    _capabilities: getCapabilityMap(workstation),
    models: getModels(workstation),
    running_tasks: concurrencyRecord?.running_tasks ?? workstation?.running_tasks ?? 0,
    max_concurrent: concurrencyRecord?.max_concurrent ?? workstation?.max_concurrent ?? 0,
    gpu_vram_mb: concurrencyRecord?.gpu_vram_mb ?? workstation?.gpu_vram_mb ?? null,
    effective_vram_budget_mb:
      concurrencyRecord?.effective_vram_budget_mb ??
      workstation?.effective_vram_budget_mb ??
      workstation?.gpu_vram_mb ??
      null,
  };
}

function mergeWorkstations(workstationList, concurrencyData) {
  const baseItems = Array.isArray(workstationList) ? workstationList : [];
  const concurrencyItems = Array.isArray(concurrencyData?.workstations) ? concurrencyData.workstations : [];
  const concurrencyMap = new Map(concurrencyItems.map((item) => [item.name, item]));
  const merged = baseItems.map((item) => normalizeWorkstation(item, concurrencyMap.get(item.name)));
  const seen = new Set(merged.map((item) => item.name));

  for (const extra of concurrencyItems) {
    if (!seen.has(extra.name)) {
      merged.push(normalizeWorkstation(extra, extra));
    }
  }

  return merged;
}

function WorkstationCard({ workstation, onProbe, onRemove, probing }) {
  const capabilities = getCapabilities(workstation);
  const models = Array.isArray(workstation.models) ? workstation.models : [];
  const status = STATUS_STYLES[workstation.status] || STATUS_STYLES.unknown;
  const hostLabel = `${workstation.host}:${workstation.agent_port || 3460}`;

  return (
    <div className="glass-card p-5 card-hover">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-white truncate">{workstation.name}</h3>
            {workstation.is_default ? (
              <span className="px-2 py-0.5 rounded-full bg-blue-600/20 border border-blue-500/30 text-[11px] font-medium text-blue-300">
                Default
              </span>
            ) : null}
          </div>
          <p className="text-xs text-slate-400 mt-0.5 font-mono break-all">{hostLabel}</p>
        </div>
        <span className="shrink-0 inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-800/80 text-slate-200 border border-slate-700">
          <span className={`inline-block w-2 h-2 rounded-full ${status.dot} ${workstation.status === 'healthy' ? 'pulse-dot' : ''}`} />
          {status.label}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-slate-800/50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">Running</p>
          <p className="text-base font-semibold text-white">{workstation.running_tasks || 0}</p>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">Models</p>
          <p className="text-base font-semibold text-white">{models.length}</p>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">GPU</p>
          <p className="text-sm font-semibold text-white truncate" title={workstation.gpu_name || 'Not detected'}>
            {workstation.gpu_name || 'None'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {capabilities.length > 0 ? capabilities.map((capability) => (
          <span
            key={capability}
            className="px-2 py-0.5 rounded-md bg-indigo-600/20 border border-indigo-500/30 text-[11px] font-medium text-indigo-200"
            title={capability}
          >
            {formatCapabilityLabel(capability)}
          </span>
        )) : (
          <span className="text-xs text-slate-500">No capabilities detected</span>
        )}
      </div>

      {workstation.gpu_name || workstation.gpu_vram_mb ? (
        <div className="mt-4 p-3 rounded-lg bg-slate-800/40 border border-slate-700/60">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-slate-300 truncate">{workstation.gpu_name || 'GPU detected'}</span>
            {workstation.gpu_vram_mb ? (
              <span className="text-slate-400">{formatGb(workstation.gpu_vram_mb)}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {workstation.gpu_vram_mb ? (
        <VramBar
          used={workstation.effective_vram_budget_mb || workstation.gpu_vram_mb}
          total={workstation.gpu_vram_mb}
        />
      ) : null}
      <CapacityBar running={workstation.running_tasks || 0} max={workstation.max_concurrent || 0} />

      {models.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs text-slate-400 mb-2">Models</p>
          <div className="flex flex-wrap gap-1.5">
            {models.slice(0, 6).map((model) => {
              const label = typeof model === 'string' ? model : model?.name;
              if (!label) return null;
              return (
                <span key={label} className="px-2 py-0.5 rounded bg-green-600/20 text-[11px] text-green-200 border border-green-500/25">
                  {label}
                </span>
              );
            })}
            {models.length > 6 ? (
              <span className="px-2 py-0.5 rounded bg-slate-700/40 text-[11px] text-slate-300 border border-slate-600/40">
                +{models.length - 6} more
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-slate-800">
        <div className="text-xs text-slate-500">
          {workstation.last_health_check ? (
            <span title={new Date(workstation.last_health_check).toLocaleString('en-US')}>
              Checked {formatDistanceToNow(new Date(workstation.last_health_check), { addSuffix: true })}
            </span>
          ) : (
            <span>Awaiting first probe</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onProbe(workstation.name)}
            disabled={probing}
            className="px-3 py-1.5 rounded-lg bg-indigo-600/20 border border-indigo-500/30 text-sm text-indigo-200 hover:bg-indigo-600/35 disabled:opacity-50 transition-colors"
          >
            {probing ? 'Probing...' : 'Probe'}
          </button>
          <button
            onClick={() => onRemove(workstation)}
            className="px-3 py-1.5 rounded-lg bg-red-600/10 border border-red-500/30 text-sm text-red-200 hover:bg-red-600/20 transition-colors"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Workstations() {
  const [workstationList, setWorkstationList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [probing, setProbing] = useState({});
  const [confirmRemove, setConfirmRemove] = useState(null);
  const toast = useToast();
  const { execute } = useAbortableRequest();

  const loadWorkstations = useCallback(() => {
    execute(async (isCurrent) => {
      try {
        const [listData, concurrencyData] = await Promise.all([
          workstationsApi.list(),
          concurrency.get().catch(() => null),
        ]);

        if (!isCurrent()) return;
        setWorkstationList(mergeWorkstations(listData, concurrencyData));
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Failed to load workstations:', err);
        toast.error(`Failed to load workstations: ${err.message}`);
      } finally {
        if (isCurrent()) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    });
  }, [execute, toast]);

  useEffect(() => {
    loadWorkstations();
    const interval = setInterval(loadWorkstations, 10000);
    return () => clearInterval(interval);
  }, [loadWorkstations]);

  const healthyCount = useMemo(
    () => workstationList.filter((workstation) => workstation.status === 'healthy').length,
    [workstationList]
  );

  async function handleRefresh() {
    setRefreshing(true);
    loadWorkstations();
  }

  async function handleProbe(name) {
    setProbing((current) => ({ ...current, [name]: true }));
    try {
      await workstationsApi.probe(name);
      toast.success(`Workstation "${name}" probed`);
      await loadWorkstations();
    } catch (err) {
      console.error('Probe failed:', err);
      toast.error(`Probe failed: ${err.message}`);
    } finally {
      setProbing((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
    }
  }

  async function handleRemoveConfirm() {
    if (!confirmRemove) return;

    try {
      await workstationsApi.remove(confirmRemove.name);
      toast.success(`Workstation "${confirmRemove.name}" removed`);
      setConfirmRemove(null);
      await loadWorkstations();
    } catch (err) {
      console.error('Remove failed:', err);
      toast.error(`Remove failed: ${err.message}`);
      setConfirmRemove(null);
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="heading-lg text-white">Workstations</h2>
          <p className="text-sm text-slate-400 mt-1">
            {healthyCount} healthy — {workstationList.length} total
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm rounded-lg disabled:opacity-50 transition-colors"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            onClick={() => toast.info('Dashboard workstation creation is coming soon. Use the existing workstation tools for registration in the meantime.')}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600/20 border border-indigo-500/30 hover:bg-indigo-600/35 text-indigo-200 text-sm rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Workstation
          </button>
        </div>
      </div>

      {workstationList.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <p className="text-slate-400 text-lg mb-2">No workstations registered</p>
          <p className="text-slate-500 text-sm">
            Add workstations with the existing API/tooling flow, then manage them here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {workstationList.map((workstation) => (
            <WorkstationCard
              key={workstation.id || workstation.name}
              workstation={workstation}
              probing={Boolean(probing[workstation.name])}
              onProbe={handleProbe}
              onRemove={setConfirmRemove}
            />
          ))}
        </div>
      )}

      {confirmRemove ? (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setConfirmRemove(null)}>
          <div
            className="glass-card p-6 max-w-sm mx-4"
            role="dialog"
            aria-label="Confirm remove workstation"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-2">Remove Workstation</h3>
            <p className="text-sm text-slate-300 mb-6">
              Are you sure you want to remove <strong>{confirmRemove.name}</strong>? This cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmRemove(null)}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRemoveConfirm}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm rounded-lg transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
