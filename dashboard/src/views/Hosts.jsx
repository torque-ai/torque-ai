import { useState, useEffect, useCallback, useMemo } from 'react';
import { concurrency, hosts as hostsApi, peekHosts as peekHostsApi, workstations as workstationsApi, models } from '../api';
import { useToast } from '../components/Toast';
import { useAbortableRequest } from '../hooks/useAbortableRequest';
import LoadingSkeleton from '../components/LoadingSkeleton';
import { formatDistanceToNow, format } from 'date-fns';

const STATUS_STYLES = {
  healthy: { dot: 'bg-green-500', label: 'Healthy', badge: 'bg-green-600' },
  degraded: { dot: 'bg-yellow-500', label: 'Degraded', badge: 'bg-yellow-600' },
  down: { dot: 'bg-red-500', label: 'Down', badge: 'bg-red-600' },
  unknown: { dot: 'bg-slate-500', label: 'Unknown', badge: 'bg-slate-600' },
  disabled: { dot: 'bg-slate-500', label: 'Disabled', badge: 'bg-slate-700' },
};

function CapacityBar({ running, max }) {
  if (!max || max <= 0) return null;
  const runningCount = running || 0;
  const percent = Math.min(100, Math.round(((running || 0) / (max || 1)) * 100));
  const barColor = percent >= 90 ? 'bg-red-500' : percent >= 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-400">Capacity</span>
        <span className="text-slate-300">{runningCount}/{max} ({percent}%)</span>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} transition-all`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function VramBar({ used, total, label = 'VRAM Usage' }) {
  if (!total || total <= 0) return null;
  const usedAmount = used || 0;
  const percent = Math.min(100, Math.round((usedAmount / total) * 100));
  const barColor = percent >= 90 ? 'bg-red-500' : percent >= 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-400">{label}</span>
        <span className="text-slate-300">{(usedAmount / 1024).toFixed(1)}/{(total / 1024).toFixed(1)} GB ({percent}%)</span>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} transition-all`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function ResourceBar({ label, percent, threshold = 85 }) {
  if (percent == null) return null;
  const barColor = percent >= threshold ? 'bg-red-500' : percent >= 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-400">{label}</span>
        <span className={`${percent >= threshold ? 'text-red-400 font-semibold' : 'text-slate-300'}`}>
          {percent}%
        </span>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} transition-all`} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
    </div>
  );
}

function formatModelSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
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

function getWorkstationModels(workstation) {
  if (Array.isArray(workstation?.models)) return workstation.models;
  return safeParseJson(workstation?.models_cache, []);
}

function normalizeWorkstation(workstation, concurrencyRecord) {
  return {
    ...workstation,
    ...concurrencyRecord,
    _capabilities: getCapabilityMap(workstation),
    models: getWorkstationModels(workstation),
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

function _getApiErrorMessage(payload, response) {
  if (payload && typeof payload === 'object') {
    if (payload.error?.message) return payload.error.message;
    if (payload.message) return payload.message;
  }

  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }

  return `HTTP ${response.status}`;
}

function DefaultModelDropdown({ host, onUpdate }) {
  const models = safeParseJson(host.models_cache || host.models, []);
  const modelNames = models.map(m => typeof m === 'string' ? m : m.name).filter(Boolean);
  const [value, setValue] = useState(host.default_model || '');
  const addToast = useToast();

  const handleChange = async (e) => {
    const newModel = e.target.value || null;
    setValue(e.target.value);
    try {
      await hostsApi.update(host.id, { default_model: newModel });
      addToast.success('Default model updated');
      onUpdate?.();
    } catch (_err) {
      addToast.error('Failed to update default model');
    }
  };

  if (modelNames.length === 0) return null;

  return (
    <div className="mt-2">
      <label className="text-xs text-slate-400 block mb-1">Default Model</label>
      <select
        value={value}
        onChange={handleChange}
        className="w-full bg-slate-700 text-slate-200 text-xs rounded px-2 py-1 border border-slate-600 focus:border-blue-500 focus:outline-none"
      >
        <option value="">None (use global default)</option>
        {modelNames.map(name => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
    </div>
  );
}

function HostCard({ host, activity, onToggle, onRemove, onRefreshHosts, concurrencyData }) {
  const addToast = useToast();
  const [localVramFactor, setLocalVramFactor] = useState(
    host.vram_factor ? Math.round(host.vram_factor * 100) : Math.round((concurrencyData?.vram_overhead_factor || 0.95) * 100)
  );

  // Show "Disabled" badge when host is disabled, regardless of stale health status
  const effectiveStatus = !host.enabled ? 'disabled' : host.status;
  const status = STATUS_STYLES[effectiveStatus] || STATUS_STYLES.unknown;
  const models = [];
  try {
    const parsed = typeof host.models === 'string' ? JSON.parse(host.models) : host.models;
    if (Array.isArray(parsed)) models.push(...parsed);
  } catch { /* ignore */ }

  // Check if model is warm (loaded within last 5 min)
  // Memoized so it doesn't recompute on every render unrelated to host.model_loaded_at
  const isModelWarm = useMemo(
    () => host.model_loaded_at &&
      // eslint-disable-next-line react-hooks/purity -- intentional: freshness check needs wall-clock time
      (Date.now() - new Date(host.model_loaded_at).getTime()) < 5 * 60 * 1000,
    [host.model_loaded_at],
  );

  return (
    <div className={`glass-card p-5 card-hover${!host.enabled ? ' opacity-60' : ''}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-white">{host.name || host.id}</h3>
          <p className="text-xs text-slate-400 mt-0.5 font-mono">{host.url}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onRemove?.(host.id, host.name || host.id); }}
            className="p-1 text-slate-500 hover:text-red-400 transition-colors"
            title="Remove host"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onToggle?.(host.id, !host.enabled); }}
            className={`relative w-9 h-5 rounded-full transition-colors ${host.enabled ? 'bg-green-600' : 'bg-slate-600'}`}
            title={host.enabled ? 'Disable host' : 'Enable host'}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${host.enabled ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
          <span className={`px-2.5 py-1 rounded-full text-xs font-medium text-white ${status.badge}`}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${status.dot} mr-1.5 ${effectiveStatus === 'healthy' ? 'pulse-dot' : ''}`} />
            {status.label}
          </span>
          {activity?.gpuMetrics && (
            activity.gpuMetrics.cpuPercent >= 85 || activity.gpuMetrics.ramPercent >= 85
          ) && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium text-white bg-red-700">
              Resource Pressure
            </span>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-slate-800/50 rounded-lg p-3 text-center">
          <p className="text-xs text-slate-500">Models</p>
          <p className="text-lg font-bold text-white">{models.length}</p>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-3 text-center">
          <p className="text-xs text-slate-500">Running</p>
          <p className="text-lg font-bold text-white">{host.running_tasks || 0}</p>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-3 text-center">
          <p className="text-xs text-slate-500">Latency</p>
          <p className="text-lg font-bold text-white">
            {host.response_time_ms ? `${host.response_time_ms}ms` : '-'}
          </p>
        </div>
      </div>

      {/* Capacity bar */}
      {host.max_concurrent > 0 && (
        <CapacityBar running={host.running_tasks || 0} max={host.max_concurrent} />
      )}
      <div className="flex items-center gap-2 mt-2">
        <span className="text-xs text-slate-400">Max:</span>
        <input type="number" min={0} max={100}
          defaultValue={host.max_concurrent || 1}
          onBlur={(e) => {
            const val = parseInt(e.target.value, 10);
            if (Number.isFinite(val) && val >= 0 && val <= 100) {
              concurrency.set({ scope: 'host', target: host.id, max_concurrent: val }).then(() => {
                addToast.success('Host max concurrent set to ' + val);
                onRefreshHosts?.();
              });
            }
          }}
          className="w-16 px-2 py-1 text-sm bg-slate-800 border border-slate-600 rounded text-white" />
      </div>

      {/* Per-host VRAM factor */}
      {host.memory_limit_mb > 0 && (
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-slate-400">VRAM Budget:</span>
          <input type="range" min={50} max={100}
            value={localVramFactor}
            onChange={(e) => setLocalVramFactor(parseInt(e.target.value, 10))}
            onMouseUp={() => {
              const val = localVramFactor / 100;
              concurrency.set({ scope: 'host', target: host.id, vram_factor: val }).then(() => {
                addToast.success(`VRAM factor set to ${localVramFactor}%`);
              });
            }}
            className="flex-1 h-1.5" />
          <span className="text-xs text-white font-mono w-10">
            {localVramFactor}%
          </span>
        </div>
      )}

      {/* GPU metrics — full (nvidia-smi / gpu-metrics-server) or synthetic (Ollama /api/ps) */}
      {activity?.gpuMetrics && (
        <div className="mt-3 space-y-3">
          {activity.gpuMetrics.synthetic ? (
            /* Synthetic metrics from Ollama /api/ps — VRAM only, no GPU%/Temp */
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                <p className="text-xs text-slate-500">VRAM</p>
                <p className="text-lg font-bold text-white">
                  {(activity.gpuMetrics.vramUsedMb / 1024).toFixed(1)}
                  <span className="text-xs text-slate-400">/{(activity.gpuMetrics.vramTotalMb / 1024).toFixed(1)}GB</span>
                </p>
              </div>
              <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                <p className="text-xs text-slate-500">Loaded</p>
                <p className="text-lg font-bold text-white">{activity?.loadedModels?.length || 0} <span className="text-xs text-slate-400">models</span></p>
              </div>
            </div>
          ) : (
            /* Full metrics from nvidia-smi or gpu-metrics-server */
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                <p className="text-xs text-slate-500">GPU</p>
                <p className="text-lg font-bold text-white">{activity.gpuMetrics.gpuUtilizationPercent}%</p>
              </div>
              <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                <p className="text-xs text-slate-500">VRAM</p>
                <p className="text-lg font-bold text-white">
                  {(activity.gpuMetrics.vramUsedMb / 1024).toFixed(1)}
                  <span className="text-xs text-slate-400">/{(activity.gpuMetrics.vramTotalMb / 1024).toFixed(1)}GB</span>
                </p>
              </div>
              <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                <p className="text-xs text-slate-500">Temp</p>
                <p className={`text-lg font-bold ${
                  activity.gpuMetrics.temperatureC >= 80 ? 'text-red-400' :
                  activity.gpuMetrics.temperatureC >= 70 ? 'text-yellow-400' : 'text-white'
                }`}>
                  {activity.gpuMetrics.temperatureC}°C
                </p>
              </div>
            </div>
          )}
          {/* VRAM usage bar */}
          {activity.gpuMetrics.vramTotalMb > 0 && (
            <VramBar used={activity.gpuMetrics.vramUsedMb} total={activity.gpuMetrics.vramTotalMb} />
          )}
        </div>
      )}
      {/* CPU/RAM system metrics */}
      {activity?.gpuMetrics?.cpuPercent != null && (
        <div className="mt-2">
          <ResourceBar label="CPU" percent={activity.gpuMetrics.cpuPercent} />
        </div>
      )}
      {activity?.gpuMetrics?.ramPercent != null && (
        <div className="mt-2">
          <ResourceBar label="RAM" percent={activity.gpuMetrics.ramPercent} />
        </div>
      )}

      {/* Models loaded in VRAM from /api/ps */}
      {activity?.loadedModels?.length > 0 && (
        <div className="mt-3">
          <p className="heading-sm mb-2">Loaded in VRAM</p>
          <div className="flex flex-wrap gap-1.5">
            {activity.loadedModels.map((m) => (
              <span key={m.name} className="px-2 py-0.5 bg-green-600/30 text-green-300 rounded text-xs">
                {m.name}
                <span className="text-green-400/60 ml-1">{(m.sizeVram / 1024 / 1024 / 1024).toFixed(1)}GB</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Active model (warm) */}
      {host.last_model_used && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-slate-400">Active:</span>
          <span className={`px-2 py-0.5 rounded text-xs ${
            isModelWarm ? 'bg-green-600/30 text-green-300' : 'bg-slate-600/30 text-slate-300'
          }`}>
            {host.last_model_used}
            {isModelWarm && <span className="ml-1 text-green-400">●</span>}
          </span>
        </div>
      )}

      {/* Models */}
      {models.length > 0 && (
        <div className="mt-3">
          <p className="heading-sm mb-2">Available Models</p>
          <div className="flex flex-wrap gap-1.5">
            {models.slice(0, 8).map((m) => (
              <span key={typeof m === 'string' ? m : m.name} className="px-2 py-0.5 bg-indigo-600/30 text-indigo-300 rounded text-xs">
                {typeof m === 'string' ? m : m.name}
                {typeof m === 'object' && m.size > 0 && (
                  <span className="text-indigo-400/60 ml-1">{formatModelSize(m.size)}</span>
                )}
              </span>
            ))}
            {models.length > 8 && (
              <span className="px-2 py-0.5 bg-slate-600/30 text-slate-400 rounded text-xs">
                +{models.length - 8} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* Default model dropdown */}
      <DefaultModelDropdown host={host} onUpdate={onRefreshHosts} />

      {/* Last check & uptime */}
      <div className="flex items-center justify-between mt-3 text-xs text-slate-500">
        {host.last_health_check && (
          <span title={format(new Date(host.last_health_check), 'MMM d, yyyy HH:mm:ss')}>
            Checked {formatDistanceToNow(new Date(host.last_health_check), { addSuffix: true })}
          </span>
        )}
        {host.created_at && (
          <span title={format(new Date(host.created_at), 'MMM d, yyyy HH:mm:ss')}>
            Added {formatDistanceToNow(new Date(host.created_at), { addSuffix: true })}
          </span>
        )}
      </div>
    </div>
  );
}

function WorkstationCard({ workstation, onProbe, onRemove, onToggle, peekStatus, onConnectPeek, probing }) {
  const capabilities = getCapabilities(workstation);
  const models = Array.isArray(workstation.models) ? workstation.models : [];
  const isEnabled = workstation.enabled !== 0 && workstation.enabled !== false;
  const effectiveStatus = !isEnabled ? 'disabled' : workstation.status;
  const status = STATUS_STYLES[effectiveStatus] || STATUS_STYLES.unknown;
  const hostLabel = `${workstation.host}:${workstation.agent_port || 3460}`;
  const peekUrl = `http://${workstation.host}:9876`;

  return (
    <div className={`glass-card p-5 card-hover${!isEnabled ? ' opacity-60' : ''}`}>
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
        <div className="flex items-center gap-2 shrink-0">
          <span className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium text-white ${status.badge}`}>
            <span className={`inline-block w-2 h-2 rounded-full ${status.dot} ${effectiveStatus === 'healthy' ? 'pulse-dot' : ''}`} />
            {status.label}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onToggle?.(workstation.name, !isEnabled); }}
            className={`relative w-9 h-5 rounded-full transition-colors ${isEnabled ? 'bg-green-600' : 'bg-slate-600'}`}
            title={isEnabled ? 'Disable workstation' : 'Enable workstation'}
            aria-label={isEnabled ? `Disable ${workstation.name}` : `Enable ${workstation.name}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${isEnabled ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
        </div>
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
        <div className="mt-4">
          <VramBar
            used={workstation.effective_vram_budget_mb || workstation.gpu_vram_mb}
            total={workstation.gpu_vram_mb}
            label="VRAM Budget"
          />
        </div>
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

      {/* Peek Server sub-section */}
      <div className="mt-4 p-3 rounded-lg bg-slate-800/30 border border-slate-700/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-400">Peek Server</span>
            {peekStatus ? (
              <span className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded-full ${peekStatus === 'online' ? 'bg-green-500 pulse-dot' : 'bg-red-500'}`} />
                <span className={`text-[11px] ${peekStatus === 'online' ? 'text-green-400' : 'text-red-400'}`}>
                  {peekStatus === 'online' ? 'Online' : 'Offline'}
                </span>
              </span>
            ) : (
              <span className="text-[11px] text-slate-500">Not connected</span>
            )}
          </div>
          {!peekStatus ? (
            <button
              onClick={() => onConnectPeek?.(workstation.name, peekUrl)}
              className="px-2 py-1 text-[11px] bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 rounded hover:bg-indigo-600/40 transition-colors"
            >
              Connect Peek
            </button>
          ) : null}
        </div>
        {peekStatus && (
          <p className="text-[11px] text-slate-500 mt-1 font-mono">{peekUrl}</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-slate-800">
        <div className="text-xs text-slate-500">
          {workstation.last_health_check ? (
            <span title={format(new Date(workstation.last_health_check), 'MMM d, yyyy HH:mm:ss')}>
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

function AddWorkstationForm({ onAdd, onCancel, submitting }) {
  const [tab, setTab] = useState('bootstrap');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('3460');
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [installService, setInstallService] = useState(false);

  const torqueHost = window.location.hostname + ':3457';
  const bootstrapCmd = `curl -s http://${torqueHost}/api/bootstrap/workstation${installService ? ' | bash -s -- --install' : ' | bash'}`;

  function handleCopy() {
    navigator.clipboard?.writeText(bootstrapCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSubmit(event) {
    event.preventDefault();
    const parsedPort = parseInt(port, 10);
    if (!name.trim() || !host.trim() || !secret.trim() || !Number.isFinite(parsedPort) || parsedPort <= 0) {
      return;
    }

    onAdd({
      name: name.trim(),
      host: host.trim(),
      port: String(parsedPort),
      secret: secret.trim(),
    });
  }

  const canSubmit = name.trim() && host.trim() && secret.trim() && Number.isFinite(parseInt(port, 10)) && parseInt(port, 10) > 0;

  return (
    <div className="glass-card p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-white">Add Workstation</h3>
        <div className="flex gap-1 mt-2">
          <button
            type="button"
            onClick={() => setTab('bootstrap')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${tab === 'bootstrap' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white bg-slate-700'}`}
          >
            Bootstrap
          </button>
          <button
            type="button"
            onClick={() => setTab('manual')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${tab === 'manual' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white bg-slate-700'}`}
          >
            Manual
          </button>
        </div>
      </div>

      {tab === 'bootstrap' ? (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">Run this on the remote machine:</p>
          <div className="relative">
            <pre className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-sm text-green-400 font-mono overflow-x-auto whitespace-pre-wrap break-all">
              {bootstrapCmd}
            </pre>
            <button
              type="button"
              onClick={handleCopy}
              className="absolute top-2 right-2 px-2 py-1 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
            <input type="checkbox" checked={installService} onChange={(e) => setInstallService(e.target.checked)} className="rounded bg-slate-700 border-slate-600" />
            Install as system service (survives reboots)
          </label>
          <div className="text-xs text-slate-500 space-y-1">
            <p>The script will automatically:</p>
            <ul className="list-disc list-inside ml-2 space-y-0.5">
              <li>Check Node.js is installed (v18+)</li>
              <li>Create the agent in <code className="bg-slate-800 px-1 rounded text-[10px]">~/.torque-agent/</code></li>
              <li>Generate a shared secret</li>
              <li>Register with this TORQUE server</li>
              <li>Start the agent</li>
            </ul>
          </div>
          <p className="text-[11px] text-slate-500 italic">The workstation card will appear automatically once the agent connects.</p>
          <div className="flex justify-end">
            <button type="button" onClick={onCancel} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors">
              Close
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label htmlFor="workstation-name" className="text-xs text-slate-400 block mb-1">Name *</label>
          <input
            id="workstation-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="builder-01"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="workstation-host" className="text-xs text-slate-400 block mb-1">Host *</label>
          <input
            id="workstation-host"
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="10.0.0.12"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="workstation-port" className="text-xs text-slate-400 block mb-1">Port *</label>
          <input
            id="workstation-port"
            type="number"
            min={1}
            value={port}
            onChange={(event) => setPort(event.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="workstation-secret" className="text-xs text-slate-400 block mb-1">Secret *</label>
          <div className="flex gap-2">
            <input
              id="workstation-secret"
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="Shared secret"
              className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                const generated = crypto.randomUUID();
                setSecret(generated);
                navigator.clipboard?.writeText(generated);
              }}
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded-lg transition-colors whitespace-nowrap"
              title="Generate a random secret and copy to clipboard"
            >
              Generate
            </button>
          </div>
          <p className="text-[11px] text-slate-500 mt-1.5">
            Set this same secret on the remote machine: <code className="bg-slate-800 px-1 py-0.5 rounded text-[10px]">TORQUE_AGENT_SECRET=&lt;secret&gt;</code> then start the agent with <code className="bg-slate-800 px-1 py-0.5 rounded text-[10px]">node server/remote/agent-server.js</code>
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit || submitting}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Adding...' : 'Add Workstation'}
        </button>
      </div>
        </form>
      )}
    </div>
  );
}

const CRED_LABELS = { ssh: 'SSH', http_auth: 'HTTP Auth', windows: 'Windows' };
const CRED_TYPES = ['ssh', 'http_auth', 'windows'];

const CRED_FIELDS = {
  ssh: [
    { key: 'username', label: 'Username', placeholder: 'user' },
    { key: 'host', label: 'Host', placeholder: '192.168.1.100' },
    { key: 'port', label: 'Port', placeholder: '22' },
    { key: 'privateKey', label: 'Private Key (paste)', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----', multiline: true },
    { key: 'password', label: 'Password (if no key)', placeholder: '', secret: true },
  ],
  http_auth: [
    { key: 'username', label: 'Username', placeholder: 'admin' },
    { key: 'password', label: 'Password', placeholder: '', secret: true },
    { key: 'token', label: 'Token (if no user/pass)', placeholder: 'Bearer ...' },
  ],
  windows: [
    { key: 'username', label: 'Username', placeholder: 'DOMAIN\\user' },
    { key: 'password', label: 'Password', placeholder: '', secret: true },
    { key: 'domain', label: 'Domain', placeholder: 'WORKGROUP' },
  ],
};

function CredentialModal({ hostName, existingTypes, onSave, onDelete, onClose }) {
  const [credType, setCredType] = useState(() => {
    const available = CRED_TYPES.filter((t) => !existingTypes.includes(t));
    return available[0] || 'ssh';
  });
  const [values, setValues] = useState({});
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function handleEsc(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const fields = CRED_FIELDS[credType] || [];
  const isExisting = existingTypes.includes(credType);

  function handleFieldChange(key, val) {
    setValues((prev) => ({ ...prev, [key]: val }));
  }

  async function handleSave(e) {
    e.preventDefault();
    const cleaned = {};
    for (const [k, v] of Object.entries(values)) {
      if (v && String(v).trim()) cleaned[k] = String(v).trim();
    }
    if (Object.keys(cleaned).length === 0) return;
    setSaving(true);
    try {
      await onSave(hostName, credType, cleaned, label.trim() || undefined);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(type) {
    await onDelete(hostName, type);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="glass-card p-6 max-w-md w-full mx-4" role="dialog" aria-modal="true" aria-label="Manage credentials" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-1">Credentials for {hostName}</h3>
        <p className="text-xs text-slate-400 mb-4">Stored encrypted at rest (AES-256-GCM)</p>

        {/* Existing credentials */}
        {existingTypes.length > 0 && (
          <div className="mb-4">
            <p className="text-xs text-slate-400 mb-2">Stored credentials:</p>
            <div className="space-y-1.5">
              {existingTypes.map((t) => (
                <div key={t} className="flex items-center justify-between bg-slate-800/50 rounded-lg px-3 py-2">
                  <span className="text-sm text-indigo-300">{CRED_LABELS[t]}</span>
                  <button onClick={() => handleDelete(t)} className="text-xs text-red-400 hover:text-red-300 transition-colors">Remove</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add / replace form */}
        <form onSubmit={handleSave}>
          <div className="mb-3">
            <label className="text-xs text-slate-400 block mb-1">Credential Type</label>
            <select value={credType} onChange={(e) => { setCredType(e.target.value); setValues({}); }}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none">
              {CRED_TYPES.map((t) => (
                <option key={t} value={t}>{CRED_LABELS[t]}{existingTypes.includes(t) ? ' (replace)' : ''}</option>
              ))}
            </select>
          </div>

          <div className="mb-3">
            <label className="text-xs text-slate-400 block mb-1">Label (optional)</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. production key"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
          </div>

          <div className="space-y-2 mb-4">
            {fields.map((f) => (
              <div key={f.key}>
                <label className="text-xs text-slate-400 block mb-1">{f.label}</label>
                {f.multiline ? (
                  <textarea value={values[f.key] || ''} onChange={(e) => handleFieldChange(f.key, e.target.value)}
                    placeholder={f.placeholder} rows={3}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none font-mono" />
                ) : (
                  <input type={f.secret ? 'password' : 'text'} value={values[f.key] || ''}
                    onChange={(e) => handleFieldChange(f.key, e.target.value)} placeholder={f.placeholder}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg disabled:opacity-50 transition-colors">
              {saving ? 'Saving...' : isExisting ? 'Replace Credential' : 'Save Credential'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PeekHostCard({ host, onToggle, onRemove, onTest, onSaveCred, onDeleteCred, onRefresh }) {
  const isEnabled = host.enabled !== 0;
  const hasCreds = host.credentials?.length > 0;
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [showCredModal, setShowCredModal] = useState(false);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await onTest(host.name);
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className={`glass-card p-5 card-hover${!isEnabled ? ' opacity-60' : ''}`}>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-white">{host.name}</h3>
          <p className="text-xs text-slate-400 mt-0.5 font-mono">{host.url}</p>
          {host.platform && (
            <span className="text-xs text-slate-500">{host.platform}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onRemove(host.name)}
            className="p-1 text-slate-500 hover:text-red-400 transition-colors"
            title="Remove host"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
          <button
            onClick={() => onToggle(host.name, !isEnabled)}
            className={`relative w-9 h-5 rounded-full transition-colors ${isEnabled ? 'bg-green-600' : 'bg-slate-600'}`}
            title={isEnabled ? 'Disable host' : 'Enable host'}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${isEnabled ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
          <span className={`px-2.5 py-1 rounded-full text-xs font-medium text-white ${isEnabled ? 'bg-green-600' : 'bg-slate-700'}`}>
            {isEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
      </div>

      {/* Credentials */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <p className="heading-sm">Credentials</p>
          <button onClick={() => setShowCredModal(true)}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
            {hasCreds ? 'Manage' : '+ Add'}
          </button>
        </div>
        {hasCreds ? (
          <div className="flex flex-wrap gap-1.5">
            {host.credentials.map((c) => (
              <span key={c.credential_type} className="px-2 py-0.5 bg-indigo-600/30 text-indigo-300 rounded text-xs">
                {CRED_LABELS[c.credential_type] || c.credential_type}
                {c.label && <span className="text-indigo-400/60 ml-1">({c.label})</span>}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500">No credentials stored</p>
        )}
      </div>

      {host.is_default === 1 && (
        <span className="inline-block px-2 py-0.5 bg-amber-600/30 text-amber-300 rounded text-xs mb-3">Default</span>
      )}

      {/* Test connection */}
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={handleTest}
          disabled={testing}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs rounded-lg disabled:opacity-50 transition-colors"
        >
          {testing ? (
            <>
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Testing...
            </>
          ) : 'Test Connection'}
        </button>
        {testResult && (
          <span className={`text-xs ${testResult.reachable ? 'text-green-400' : 'text-red-400'}`}>
            {testResult.reachable
              ? `Reachable (${testResult.latency_ms}ms)${testResult.server_version ? ` v${testResult.server_version}` : ''}`
              : testResult.error || 'Unreachable'}
          </span>
        )}
      </div>

      {/* SSH info */}
      {host.ssh && (
        <p className="text-xs text-slate-500 mt-2 font-mono">SSH: {host.ssh}</p>
      )}

      {host.created_at && (
        <div className="text-xs text-slate-500 mt-3">
          Added {formatDistanceToNow(new Date(host.created_at), { addSuffix: true })}
        </div>
      )}

      {showCredModal && (
        <CredentialModal
          hostName={host.name}
          existingTypes={(host.credentials || []).map((c) => c.credential_type)}
          onSave={async (name, type, value, label) => { await onSaveCred(name, type, value, label); onRefresh(); }}
          onDelete={async (name, type) => { await onDeleteCred(name, type); onRefresh(); }}
          onClose={() => setShowCredModal(false)}
        />
      )}
    </div>
  );
}

function AddPeekHostForm({ onAdd, onCancel }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [ssh, setSsh] = useState('');
  const [platform, setPlatform] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;
    onAdd({ name: name.trim(), url: url.trim(), ssh: ssh.trim() || undefined, platform: platform.trim() || undefined });
  }

  return (
    <form onSubmit={handleSubmit} className="glass-card p-5 space-y-3">
      <h3 className="text-sm font-semibold text-white">Add Remote Testing Host</h3>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-400 block mb-1">Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="remote-gpu-host"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">URL *</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.100:9876"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">SSH</label>
          <input value={ssh} onChange={(e) => setSsh(e.target.value)} placeholder="user@192.168.1.100"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">Platform</label>
          <input value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="windows"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors">Cancel</button>
        <button type="submit" disabled={!name.trim() || !url.trim()} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg disabled:opacity-50 transition-colors">Add Host</button>
      </div>
    </form>
  );
}

export default function Hosts({ hostActivity }) {
  const [hostList, setHostList] = useState([]);
  const [workstationList, setWorkstationList] = useState([]);
  const [peekHostList, setPeekHostList] = useState([]);
  const [concurrencyData, setConcurrencyData] = useState(null);
  const [pendingModels, setPendingModels] = useState([]);
  const [loadingHosts, setLoadingHosts] = useState(true);
  const [loadingWorkstations, setLoadingWorkstations] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [probingWorkstations, setProbingWorkstations] = useState({});
  const [addingWorkstation, setAddingWorkstation] = useState(false);
  const [showAddWorkstation, setShowAddWorkstation] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null); // { id, name }
  const [confirmRemoveWorkstation, setConfirmRemoveWorkstation] = useState(null); // { name }
  const [confirmRemovePeek, setConfirmRemovePeek] = useState(null); // { name }
  const [_showAddPeek, setShowAddPeek] = useState(false);  const toast = useToast();
  const { execute: executeHostLoad } = useAbortableRequest();
  const { execute: executeWorkstationLoad } = useAbortableRequest();
  const { execute: executePeekHostLoad } = useAbortableRequest();

  const loadHosts = useCallback(() => {
    return executeHostLoad(async (isCurrent) => {
      try {
        const data = await hostsApi.list();
        if (!isCurrent()) return;
        setHostList(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Failed to load hosts:', err);
        toast.error('Failed to load hosts');
      } finally {
        if (isCurrent()) {
          setLoadingHosts(false);
        }
      }
    });
  }, [executeHostLoad, toast]);

  const loadWorkstations = useCallback(() => {
    return executeWorkstationLoad(async (isCurrent) => {
      try {
        const [listData, nextConcurrencyData, pendingModelData] = await Promise.all([
          workstationsApi.list(),
          concurrency.get().catch(() => null),
          models.pending().catch(() => null),
        ]);
        if (!isCurrent()) return;
        setConcurrencyData(nextConcurrencyData);
        setWorkstationList(mergeWorkstations(listData, nextConcurrencyData));
        setPendingModels(pendingModelData?.models || pendingModelData?.items || pendingModelData || []);
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Failed to load workstations:', err);
        toast.error(`Failed to load workstations: ${err.message}`);
      } finally {
        if (isCurrent()) {
          setLoadingWorkstations(false);
        }
      }
    });
  }, [executeWorkstationLoad, toast]);

  const loadPeekHosts = useCallback(() => {
    return executePeekHostLoad(async (isCurrent) => {
      try {
        const data = await peekHostsApi.list();
        if (!isCurrent()) return;
        setPeekHostList(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Failed to load peek hosts:', err);
      }
    });
  }, [executePeekHostLoad]);

  const refreshInfrastructure = useCallback(async () => {
    await Promise.allSettled([
      loadHosts(),
      loadWorkstations(),
      loadPeekHosts(),
    ]);
  }, [loadHosts, loadPeekHosts, loadWorkstations]);

  useEffect(() => {
    loadHosts();
    loadWorkstations();
    loadPeekHosts();
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadHosts();
      loadWorkstations();
      loadPeekHosts();
    }, 30000); // 30s — WebSocket provides real-time updates; polling is a fallback
    return () => clearInterval(interval);
  }, [loadHosts, loadPeekHosts, loadWorkstations]);

  async function handleRefresh() {
    setRefreshing(true);
    await refreshInfrastructure();
    setRefreshing(false);
  }

  async function handleScan() {
    setScanning(true);
    try {
      const result = await hostsApi.scan();
      const found = result?.hosts_found || result?.found || 0;
      toast.success(`Scan complete: ${found} host${found !== 1 ? 's' : ''} found`);
      await loadHosts();
    } catch (err) {
      console.error('Network scan failed:', err);
      toast.error(`Scan failed: ${err.message}`);
    } finally {
      setScanning(false);
    }
  }

  async function handleToggle(hostId, enabled) {
    try {
      await hostsApi.toggle(hostId, enabled);
      toast.success(`Host ${enabled ? 'enabled' : 'disabled'}`);
      await loadHosts();
    } catch (err) {
      console.error('Toggle failed:', err);
      toast.error(`Toggle failed: ${err.message}`);
    }
  }

  useEffect(() => {
    if (!confirmRemove && !confirmRemoveWorkstation && !confirmRemovePeek) return;
    function handleEsc(e) {
      if (e.key === 'Escape') {
        setConfirmRemove(null);
        setConfirmRemoveWorkstation(null);
        setConfirmRemovePeek(null);
      }
    }
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [confirmRemove, confirmRemoveWorkstation, confirmRemovePeek]);

  function handleRemoveClick(hostId, hostName) {
    setConfirmRemove({ id: hostId, name: hostName });
  }

  async function handleRemoveConfirm() {
    if (!confirmRemove) return;
    try {
      await hostsApi.remove(confirmRemove.id);
      toast.success(`Host "${confirmRemove.name}" removed`);
      setConfirmRemove(null);
      await loadHosts();
    } catch (err) {
      console.error('Remove failed:', err);
      toast.error(`Remove failed: ${err.message}`);
      setConfirmRemove(null);
    }
  }

  async function createWorkstation(data) {
    return workstationsApi.add({
      name: data.name,
      host: data.host,
      agent_port: parseInt(data.port, 10),
      secret: data.secret,
    });
  }

  async function handleAddWorkstation(data) {
    setAddingWorkstation(true);
    try {
      const existing = await workstationsApi.list();
      if (Array.isArray(existing) && existing.some((item) => item?.name === data.name)) {
        toast.error(`Workstation "${data.name}" already exists`);
        return;
      }

      await createWorkstation(data);
      setShowAddWorkstation(false);

      try {
        await workstationsApi.probe(data.name);
        toast.success(`Workstation "${data.name}" added and probed`);
      } catch (probeErr) {
        console.error('Workstation probe failed after add:', probeErr);
        toast.error(`Workstation "${data.name}" added, but probe failed: ${probeErr.message}`);
      }

      await loadWorkstations();
    } catch (err) {
      console.error('Add workstation failed:', err);
      toast.error(`Add failed: ${err.message}`);
    } finally {
      setAddingWorkstation(false);
    }
  }

  async function handleToggleWorkstation(name, enabled) {
    try {
      await workstationsApi.toggle(name, enabled);
      toast.success(`Workstation "${name}" ${enabled ? 'enabled' : 'disabled'}`);
      await loadWorkstations();
    } catch (err) {
      toast.error(`Toggle failed: ${err.message}`);
    }
  }

  async function handleConnectPeek(workstationName, peekUrl) {
    try {
      await peekHostsApi.create({ name: workstationName, url: peekUrl });
      toast.success(`Peek server connected for "${workstationName}"`);
      await loadPeekHosts();
    } catch (err) {
      toast.error(`Peek connect failed: ${err.message}`);
    }
  }

  async function handleProbeWorkstation(name) {
    setProbingWorkstations((current) => ({ ...current, [name]: true }));
    try {
      await workstationsApi.probe(name);
      toast.success(`Workstation "${name}" probed`);
      await loadWorkstations();
    } catch (err) {
      console.error('Probe failed:', err);
      toast.error(`Probe failed: ${err.message}`);
    } finally {
      setProbingWorkstations((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
    }
  }

  async function handleRemoveWorkstationConfirm() {
    if (!confirmRemoveWorkstation) return;
    try {
      await workstationsApi.remove(confirmRemoveWorkstation.name);
      toast.success(`Workstation "${confirmRemoveWorkstation.name}" removed`);
      setConfirmRemoveWorkstation(null);
      await loadWorkstations();
    } catch (err) {
      console.error('Remove failed:', err);
      toast.error(`Remove failed: ${err.message}`);
      setConfirmRemoveWorkstation(null);
    }
  }

  // --- Peek host handlers ---

  async function _handlePeekToggle(name, enabled) {    try {
      await peekHostsApi.toggle(name, enabled);
      toast.success(`Peek host ${enabled ? 'enabled' : 'disabled'}`);
      await loadPeekHosts();
    } catch (err) {
      toast.error(`Toggle failed: ${err.message}`);
    }
  }

  async function _handleAddPeekHost(data) {    try {
      await peekHostsApi.create(data);
      toast.success(`Peek host "${data.name}" added`);
      setShowAddPeek(false);
      await loadPeekHosts();
    } catch (err) {
      toast.error(`Add failed: ${err.message}`);
    }
  }

  async function handleRemovePeekConfirm() {
    if (!confirmRemovePeek) return;
    try {
      await peekHostsApi.remove(confirmRemovePeek.name);
      toast.success(`Peek host "${confirmRemovePeek.name}" removed`);
      setConfirmRemovePeek(null);
      await loadPeekHosts();
    } catch (err) {
      toast.error(`Remove failed: ${err.message}`);
      setConfirmRemovePeek(null);
    }
  }

  async function _handleTestPeekHost(name) {    try {
      return await peekHostsApi.test(name);
    } catch {
      return { reachable: false, latency_ms: null };
    }
  }

  async function _handleSaveCredential(hostName, credType, value, label) {    try {
      await peekHostsApi.saveCredential(hostName, credType, value, label);
      toast.success(`${CRED_LABELS[credType] || credType} credential saved`);
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
      throw err;
    }
  }

  async function _handleDeleteCredential(hostName, credType) {    try {
      await peekHostsApi.deleteCredential(hostName, credType);
      toast.success(`${CRED_LABELS[credType] || credType} credential removed`);
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    }
  }

  const loading = loadingHosts || loadingWorkstations;
  const enabled = hostList.filter((h) => h.enabled).length;
  const healthy = hostList.filter((h) => h.enabled && h.status === 'healthy').length;
  const total = hostList.length;
  const healthyWorkstations = workstationList.filter((workstation) => workstation.status === 'healthy').length;

  if (loading) {
    return (
      <div className="p-6">
        <LoadingSkeleton lines={5} />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="heading-lg text-white">Hosts</h2>
          <p className="text-sm text-slate-400 mt-1">
            {healthy} healthy ollama hosts, {healthyWorkstations} healthy workstations
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleScan}
            disabled={scanning}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600/20 border border-indigo-500/30 hover:bg-indigo-600/40 text-indigo-300 text-sm rounded-lg disabled:opacity-50 transition-colors"
          >
            <svg className={`w-4 h-4 ${scanning ? 'animate-pulse' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {scanning ? 'Scanning...' : 'Scan Network'}
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm rounded-lg disabled:opacity-50 transition-colors"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Global VRAM slider removed — VRAM budget is now per-host/workstation */}

      {/* Pending Models Approval Panel */}
      {pendingModels.length > 0 && (
        <div className="glass-card p-5 mb-6 border border-amber-500/30">
          <h3 className="text-lg font-semibold text-amber-300 mb-3">
            {pendingModels.length} Model{pendingModels.length !== 1 ? 's' : ''} Pending Approval
          </h3>
          <div className="space-y-2">
            {pendingModels.map((m, i) => (
              <div key={`${m.provider}-${m.model_name}-${i}`} className="flex items-center justify-between bg-slate-800/50 rounded-lg px-4 py-2">
                <div>
                  <span className="text-white font-medium">{m.model_name}</span>
                  <span className="text-slate-400 text-sm ml-2">on {m.provider}</span>
                  {m.host_id && <span className="text-slate-500 text-xs ml-2">({m.host_id})</span>}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => models.approve(m.provider, m.model_name).then(() => {
                      toast.success(`Model ${m.model_name} approved`);
                      models.pending().then(d => setPendingModels(d.models || d.items || d || [])).catch(() => {});
                    }).catch(err => toast.error(err.message))}
                    className="px-3 py-1 text-xs bg-green-600/20 border border-green-500/30 text-green-300 rounded hover:bg-green-600/40"
                  >Approve</button>
                  <button
                    onClick={() => models.deny(m.provider, m.model_name).then(() => {
                      toast.success(`Model ${m.model_name} denied`);
                      models.pending().then(d => setPendingModels(d.models || d.items || d || [])).catch(() => {});
                    }).catch(err => toast.error(err.message))}
                    className="px-3 py-1 text-xs bg-red-600/20 border border-red-500/30 text-red-300 rounded hover:bg-red-600/40"
                  >Deny</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="heading-lg text-white">Workstations</h2>
            <p className="text-sm text-slate-400 mt-1">
              {healthyWorkstations} healthy — {workstationList.length} total
            </p>
          </div>
          <button
            onClick={() => setShowAddWorkstation((current) => !current)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600/20 border border-indigo-500/30 hover:bg-indigo-600/35 text-indigo-200 text-sm rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {showAddWorkstation ? 'Cancel' : 'Add Workstation'}
          </button>
        </div>

        {showAddWorkstation ? (
          <div className="mb-5">
            <AddWorkstationForm
              onAdd={handleAddWorkstation}
              onCancel={() => setShowAddWorkstation(false)}
              submitting={addingWorkstation}
            />
          </div>
        ) : null}

        {workstationList.length === 0 ? (
          <div className="glass-card p-8 text-center">
            <p className="text-slate-400 text-lg mb-2">No workstations registered</p>
            <p className="text-slate-500 text-sm">Register a workstation agent to manage it here.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {workstationList.map((workstation) => (
              <WorkstationCard
                key={workstation.id || workstation.name}
                workstation={workstation}
                probing={Boolean(probingWorkstations[workstation.name])}
                onProbe={handleProbeWorkstation}
                onRemove={setConfirmRemoveWorkstation}
                onToggle={handleToggleWorkstation}
                peekStatus={peekHostList.find(p => p.name === workstation.name)?.status === 'online' ? 'online' : peekHostList.find(p => p.name === workstation.name) ? 'offline' : null}
                onConnectPeek={handleConnectPeek}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mt-10">
        <div className="mb-4">
          <h2 className="heading-lg text-white">Ollama Hosts</h2>
          <p className="text-sm text-slate-400 mt-1">
            {enabled} enabled, {healthy} healthy — {total} total
          </p>
        </div>

        {hostList.length === 0 ? (
          <div className="glass-card p-12 text-center">
            <p className="text-slate-400 text-lg mb-2">No hosts configured</p>
            <p className="text-slate-500 text-sm">
              Use <code className="bg-slate-800 px-1.5 py-0.5 rounded text-xs">add_ollama_host</code> to register a host
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {hostList.map((host) => (
              <HostCard
                key={host.id}
                host={host}
                activity={hostActivity?.hosts?.[host.id]}
                onToggle={handleToggle}
                onRemove={handleRemoveClick}
                onRefreshHosts={loadHosts}
                concurrencyData={concurrencyData}
              />
            ))}
          </div>
        )}
      </div>

      {/* Remote Testing Hosts section removed — peek server is now
          an optional sub-section within each Workstation card */}

      {confirmRemoveWorkstation ? (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setConfirmRemoveWorkstation(null)}>
          <div
            className="glass-card p-6 max-w-sm mx-4"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm remove workstation"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-2">Remove Workstation</h3>
            <p className="text-sm text-slate-300 mb-6">
              Are you sure you want to remove <strong>{confirmRemoveWorkstation.name}</strong>? This cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmRemoveWorkstation(null)}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRemoveWorkstationConfirm}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm rounded-lg transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Peek host remove confirmation dialog */}
      {confirmRemovePeek && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirmRemovePeek(null)}>
          <div className="glass-card p-6 max-w-sm mx-4" role="dialog" aria-modal="true" aria-label="Confirm remove peek host" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Remove Peek Host</h3>
            <p className="text-sm text-slate-300 mb-4">
              Remove <strong>{confirmRemovePeek.name}</strong> and all stored credentials? This cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirmRemovePeek(null)} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors">Cancel</button>
              <button onClick={handleRemovePeekConfirm} className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm rounded-lg transition-colors">Remove</button>
            </div>
          </div>
        </div>
      )}

      {/* Remove confirmation dialog */}
      {confirmRemove && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirmRemove(null)}>
          <div className="glass-card p-6 max-w-sm mx-4" role="dialog" aria-modal="true" aria-label="Confirm remove host" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Remove Host</h3>
            <p className="text-sm text-slate-300 mb-4">
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
      )}
    </div>
  );
}
