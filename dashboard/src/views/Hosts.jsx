import { useState, useEffect, useCallback } from 'react';
import { hosts as hostsApi, peekHosts as peekHostsApi } from '../api';
import { useToast } from '../components/Toast';
import { useAbortableRequest } from '../hooks/useAbortableRequest';
import { formatDistanceToNow } from 'date-fns';

const STATUS_STYLES = {
  healthy: { dot: 'bg-green-500', label: 'Healthy', badge: 'bg-green-600' },
  degraded: { dot: 'bg-yellow-500', label: 'Degraded', badge: 'bg-yellow-600' },
  down: { dot: 'bg-red-500', label: 'Down', badge: 'bg-red-600' },
  unknown: { dot: 'bg-slate-500', label: 'Unknown', badge: 'bg-slate-600' },
  disabled: { dot: 'bg-slate-500', label: 'Disabled', badge: 'bg-slate-700' },
};

function CapacityBar({ running, max }) {
  if (!max || max <= 0) return null;
  const percent = Math.min(100, Math.round((running / max) * 100));
  const barColor = percent >= 90 ? 'bg-red-500' : percent >= 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-400">Capacity</span>
        <span className="text-slate-300">{running}/{max} ({percent}%)</span>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} transition-all`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function VramBar({ used, total }) {
  const percent = Math.min(100, Math.round((used / total) * 100));
  const barColor = percent >= 90 ? 'bg-red-500' : percent >= 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-400">VRAM Usage</span>
        <span className="text-slate-300">{(used / 1024).toFixed(1)}/{(total / 1024).toFixed(1)} GB ({percent}%)</span>
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

function HostCard({ host, activity, onToggle, onRemove }) {
  // Show "Disabled" badge when host is disabled, regardless of stale health status
  const effectiveStatus = !host.enabled ? 'disabled' : host.status;
  const status = STATUS_STYLES[effectiveStatus] || STATUS_STYLES.unknown;
  const models = [];
  try {
    const parsed = typeof host.models === 'string' ? JSON.parse(host.models) : host.models;
    if (Array.isArray(parsed)) models.push(...parsed);
  } catch { /* ignore */ }

  // Check if model is warm (loaded within last 5 min)
  /* eslint-disable react-hooks/purity */
  const isModelWarm = host.model_loaded_at &&
    (Date.now() - new Date(host.model_loaded_at).getTime()) < 5 * 60 * 1000;
  /* eslint-enable react-hooks/purity */

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

      {/* Last check & uptime */}
      <div className="flex items-center justify-between mt-3 text-xs text-slate-500">
        {host.last_health_check && (
          <span title={new Date(host.last_health_check).toLocaleString('en-US')}>
            Checked {formatDistanceToNow(new Date(host.last_health_check), { addSuffix: true })}
          </span>
        )}
        {host.created_at && (
          <span title={new Date(host.created_at).toLocaleString('en-US')}>
            Added {formatDistanceToNow(new Date(host.created_at), { addSuffix: true })}
          </span>
        )}
      </div>
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
      <div className="glass-card p-6 max-w-md w-full mx-4" role="dialog" aria-label="Manage credentials" onClick={(e) => e.stopPropagation()}>
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
  const [peekHostList, setPeekHostList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null); // { id, name }
  const [confirmRemovePeek, setConfirmRemovePeek] = useState(null); // { name }
  const [showAddPeek, setShowAddPeek] = useState(false);
  const toast = useToast();
  const { execute } = useAbortableRequest();

  const loadHosts = useCallback(() => {
    execute(async (isCurrent) => {
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
          setLoading(false);
          setRefreshing(false);
        }
      }
    });
  }, [execute, toast]);

  useEffect(() => {
    loadHosts();
    loadPeekHosts();
    const interval = setInterval(() => { loadHosts(); loadPeekHosts(); }, 10000);
    return () => clearInterval(interval);
  }, [loadHosts]);

  async function handleRefresh() {
    setRefreshing(true);
    await loadHosts();
  }

  async function handleScan() {
    setScanning(true);
    try {
      const result = await hostsApi.scan();
      const found = result?.hosts_found || result?.found || 0;
      toast.success(`Scan complete: ${found} host${found !== 1 ? 's' : ''} found`);
      loadHosts();
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
      loadHosts();
    } catch (err) {
      console.error('Toggle failed:', err);
      toast.error(`Toggle failed: ${err.message}`);
    }
  }

  function handleRemoveClick(hostId, hostName) {
    setConfirmRemove({ id: hostId, name: hostName });
  }

  async function handleRemoveConfirm() {
    if (!confirmRemove) return;
    try {
      await hostsApi.remove(confirmRemove.id);
      toast.success(`Host "${confirmRemove.name}" removed`);
      setConfirmRemove(null);
      loadHosts();
    } catch (err) {
      console.error('Remove failed:', err);
      toast.error(`Remove failed: ${err.message}`);
      setConfirmRemove(null);
    }
  }

  // --- Peek host handlers ---
  async function loadPeekHosts() {
    try {
      const data = await peekHostsApi.list();
      setPeekHostList(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load peek hosts:', err);
    }
  }

  async function handlePeekToggle(name, enabled) {
    try {
      await peekHostsApi.toggle(name, enabled);
      toast.success(`Peek host ${enabled ? 'enabled' : 'disabled'}`);
      loadPeekHosts();
    } catch (err) {
      toast.error(`Toggle failed: ${err.message}`);
    }
  }

  async function handleAddPeekHost(data) {
    try {
      await peekHostsApi.create(data);
      toast.success(`Peek host "${data.name}" added`);
      setShowAddPeek(false);
      loadPeekHosts();
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
      loadPeekHosts();
    } catch (err) {
      toast.error(`Remove failed: ${err.message}`);
      setConfirmRemovePeek(null);
    }
  }

  async function handleTestPeekHost(name) {
    try {
      return await peekHostsApi.test(name);
    } catch {
      return { reachable: false, latency_ms: null };
    }
  }

  async function handleSaveCredential(hostName, credType, value, label) {
    try {
      await peekHostsApi.saveCredential(hostName, credType, value, label);
      toast.success(`${CRED_LABELS[credType] || credType} credential saved`);
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
      throw err;
    }
  }

  async function handleDeleteCredential(hostName, credType) {
    try {
      await peekHostsApi.deleteCredential(hostName, credType);
      toast.success(`${CRED_LABELS[credType] || credType} credential removed`);
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    }
  }

  const enabled = hostList.filter((h) => h.enabled).length;
  const healthy = hostList.filter((h) => h.enabled && h.status === 'healthy').length;
  const total = hostList.length;

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="heading-lg text-white">Hosts</h2>
          <p className="text-sm text-slate-400 mt-1">
            {enabled} enabled, {healthy} healthy — {total} total
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
            <HostCard key={host.id} host={host} activity={hostActivity?.hosts?.[host.id]} onToggle={handleToggle} onRemove={handleRemoveClick} />
          ))}
        </div>
      )}

      {/* --- Remote Testing Hosts --- */}
      <div className="mt-10">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="heading-lg text-white">Remote Testing Hosts</h2>
            <p className="text-sm text-slate-400 mt-1">
              Peek/SnapScope stations for visual verification
              {peekHostList.length > 0 && ` — ${peekHostList.filter(h => h.enabled !== 0).length} enabled, ${peekHostList.length} total`}
            </p>
          </div>
          <button
            onClick={() => setShowAddPeek(true)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600/20 border border-indigo-500/30 hover:bg-indigo-600/40 text-indigo-300 text-sm rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Host
          </button>
        </div>

        {showAddPeek && (
          <div className="mb-5">
            <AddPeekHostForm onAdd={handleAddPeekHost} onCancel={() => setShowAddPeek(false)} />
          </div>
        )}

        {peekHostList.length === 0 ? (
          <div className="glass-card p-8 text-center">
            <p className="text-slate-400 mb-1">No remote testing hosts configured</p>
            <p className="text-slate-500 text-sm">Add a peek_server host to enable visual verification from the dashboard</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {peekHostList.map((host) => (
              <PeekHostCard
                key={host.name}
                host={host}
                onToggle={handlePeekToggle}
                onRemove={(name) => setConfirmRemovePeek({ name })}
                onTest={handleTestPeekHost}
                onSaveCred={handleSaveCredential}
                onDeleteCred={handleDeleteCredential}
                onRefresh={loadPeekHosts}
              />
            ))}
          </div>
        )}
      </div>

      {/* Peek host remove confirmation dialog */}
      {confirmRemovePeek && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirmRemovePeek(null)}>
          <div className="glass-card p-6 max-w-sm mx-4" role="dialog" aria-label="Confirm remove peek host" onClick={(e) => e.stopPropagation()}>
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
          <div className="glass-card p-6 max-w-sm mx-4" role="dialog" aria-label="Confirm remove host" onClick={(e) => e.stopPropagation()}>
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
