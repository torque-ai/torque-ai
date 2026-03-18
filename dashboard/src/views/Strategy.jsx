import React, { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import { strategic as strategicApi } from '../api';
import StatCard from '../components/StatCard';

const RoutingTemplates = React.lazy(() => import('./RoutingTemplates'));
const StrategicConfig = React.lazy(() => import('./StrategicConfig'));

// ─── Color Maps ─────────────────────────────────────────────

const PROVIDER_COLORS = {
  codex: { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500/30', dot: 'bg-blue-400' },
  'claude-cli': { bg: 'bg-violet-500/20', text: 'text-violet-400', border: 'border-violet-500/30', dot: 'bg-violet-400' },
  ollama: { bg: 'bg-green-500/20', text: 'text-green-400', border: 'border-green-500/30', dot: 'bg-green-400' },
  'aider-ollama': { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/30', dot: 'bg-emerald-400' },
  'hashline-ollama': { bg: 'bg-teal-500/20', text: 'text-teal-400', border: 'border-teal-500/30', dot: 'bg-teal-400' },
  'hashline-openai': { bg: 'bg-cyan-500/20', text: 'text-cyan-400', border: 'border-cyan-500/30', dot: 'bg-cyan-400' },
  anthropic: { bg: 'bg-amber-500/20', text: 'text-amber-400', border: 'border-amber-500/30', dot: 'bg-amber-400' },
  groq: { bg: 'bg-pink-500/20', text: 'text-pink-400', border: 'border-pink-500/30', dot: 'bg-pink-400' },
  deepinfra: { bg: 'bg-orange-500/20', text: 'text-orange-400', border: 'border-orange-500/30', dot: 'bg-orange-400' },
  hyperbolic: { bg: 'bg-purple-500/20', text: 'text-purple-400', border: 'border-purple-500/30', dot: 'bg-purple-400' },
};

const FALLBACK_PROVIDER_STYLE = { bg: 'bg-slate-500/20', text: 'text-slate-400', border: 'border-slate-500/30', dot: 'bg-slate-400' };

function getProviderStyle(name) {
  return PROVIDER_COLORS[name] || FALLBACK_PROVIDER_STYLE;
}

const HEALTH_STATUS_STYLES = {
  healthy: { dot: 'bg-green-400', label: 'text-green-400', ring: 'ring-green-500/40' },
  warning: { dot: 'bg-yellow-400', label: 'text-yellow-400', ring: 'ring-yellow-500/40' },
  degraded: { dot: 'bg-red-400', label: 'text-red-400', ring: 'ring-red-500/40' },
  disabled: { dot: 'bg-slate-500', label: 'text-slate-500', ring: 'ring-slate-500/40' },
};

const COMPLEXITY_STYLES = {
  simple: 'bg-green-500/20 text-green-400',
  normal: 'bg-blue-500/20 text-blue-400',
  complex: 'bg-orange-500/20 text-orange-400',
  unknown: 'bg-slate-500/20 text-slate-400',
};

function unwrapArrayPayload(payload, ...keys) {
  if (Array.isArray(payload)) return payload;

  for (const key of keys) {
    if (Array.isArray(payload?.[key])) {
      return payload[key];
    }
  }

  return [];
}

// ─── Fallback Chain Visualization ───────────────────────────

function FallbackChainNode({ name, healthStatus }) {
  const style = getProviderStyle(name);
  const healthStyle = HEALTH_STATUS_STYLES[healthStatus] || HEALTH_STATUS_STYLES.healthy;

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${style.bg} ${style.text} ${style.border} ${healthStyle.ring} ring-1`}>
      <span className={`w-2.5 h-2.5 rounded-full ${healthStyle.dot} ${healthStatus === 'healthy' ? 'animate-pulse' : ''}`} aria-hidden="true" />
      <span className="sr-only">{healthStatus}</span>
      <span className="text-sm font-medium capitalize">{name}</span>
      <span className={`text-[10px] uppercase tracking-wider ${healthStyle.label}`} aria-hidden="true">
        {healthStatus}
      </span>
    </div>
  );
}

function ChainArrow() {
  return (
    <svg className="w-5 h-5 text-slate-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function FallbackChain({ chain, providerHealthMap, activeProvider }) {
  const activeCount = Object.values(providerHealthMap).filter(
    (h) => h.health_status === 'healthy' || h.health_status === 'warning'
  ).length;
  const totalCount = chain.length;

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Fallback Chain</h3>
        <span className="text-xs text-slate-400">
          {activeCount}/{totalCount} providers available
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {chain.map((provider, i) => {
          const healthData = providerHealthMap[provider];
          const healthStatus = healthData?.health_status || 'healthy';
          return (
            <div key={provider} className="flex items-center gap-2">
              <FallbackChainNode
                name={provider}
                healthStatus={healthStatus}
              />
              {i < chain.length - 1 && <ChainArrow />}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-500 mt-3">
        Active provider: <span className="text-white font-medium capitalize">{activeProvider || 'none'}</span>.
        Chain walks left-to-right until a healthy provider with credentials is found.
      </p>
    </div>
  );
}

// ─── Provider Health Cards ──────────────────────────────────

function ProviderHealthCard({ data }) {
  const style = getProviderStyle(data.provider);
  const healthStyle = HEALTH_STATUS_STYLES[data.health_status] || HEALTH_STATUS_STYLES.healthy;

  const avgLatencyDisplay = data.avg_duration_seconds
    ? data.avg_duration_seconds < 60
      ? `${Math.round(data.avg_duration_seconds)}s`
      : `${(data.avg_duration_seconds / 60).toFixed(1)}m`
    : '-';

  return (
    <div className={`rounded-xl border p-4 ${style.bg} ${style.border}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${healthStyle.dot}`} />
          <span className={`text-sm font-semibold ${style.text} capitalize`}>{data.provider}</span>
        </div>
        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
          data.health_status === 'healthy' ? 'bg-green-500/20 text-green-400' :
          data.health_status === 'warning' ? 'bg-yellow-500/20 text-yellow-400' :
          data.health_status === 'degraded' ? 'bg-red-500/20 text-red-400' :
          'bg-slate-500/20 text-slate-400'
        }`}>
          {data.health_status}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="text-slate-500 mb-0.5">Success Rate (1h)</p>
          <p className="text-white font-medium">
            {data.success_rate_1h !== null ? `${data.success_rate_1h}%` : 'No data'}
          </p>
        </div>
        <div>
          <p className="text-slate-500 mb-0.5">Avg Latency</p>
          <p className="text-white font-medium">{avgLatencyDisplay}</p>
        </div>
        <div>
          <p className="text-slate-500 mb-0.5">Completed Today</p>
          <p className="text-white font-medium">{data.completed_today}</p>
        </div>
        <div>
          <p className="text-slate-500 mb-0.5">Failed Today</p>
          <p className="text-white font-medium">{data.failed_today}</p>
        </div>
      </div>
    </div>
  );
}

function ProviderHealthGrid({ providers }) {
  if (!providers || providers.length === 0) {
    return (
      <div className="glass-card p-6 text-center">
        <p className="text-slate-400">No provider health data available.</p>
      </div>
    );
  }

  return (
    <div className="glass-card p-5">
      <h3 className="text-lg font-semibold text-white mb-4">Provider Health</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {providers.map((p) => (
          <ProviderHealthCard key={p.provider} data={p} />
        ))}
      </div>
    </div>
  );
}

// ─── Decision History Table ─────────────────────────────────

function DecisionSortHeader({ field, label, sortField, sortDir, onSort }) {
  const isActive = sortField === field;
  return (
    <th
      className="pb-2 pr-4 cursor-pointer select-none hover:text-slate-200 transition-colors"
      onClick={() => onSort(field)}
    >
      <span className="flex items-center gap-1">
        {label}
        {isActive && (
          <span className="text-[10px]">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
        )}
      </span>
    </th>
  );
}

function DecisionHistoryTable({ decisions }) {
  const [sortField, setSortField] = useState('created_at');
  const [sortDir, setSortDir] = useState('desc');

  const sorted = useMemo(() => {
    if (!decisions || decisions.length === 0) return [];
    return [...decisions].sort((a, b) => {
      let aVal = a[sortField];
      let bVal = b[sortField];

      if (sortField === 'created_at') {
        aVal = aVal ? new Date(aVal).getTime() : 0;
        bVal = bVal ? new Date(bVal).getTime() : 0;
      } else if (typeof aVal === 'string') {
        aVal = aVal.toLowerCase();
        bVal = (bVal || '').toLowerCase();
      }

      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [decisions, sortField, sortDir]);

  function handleSort(field) {
    if (sortField === field) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }

  if (!decisions || decisions.length === 0) {
    return (
      <div className="glass-card p-6 text-center">
        <p className="text-slate-400">No routing decisions recorded yet.</p>
        <p className="text-slate-500 text-sm mt-1">
          Submit tasks via smart routing to see decision history here.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-card p-5">
      <h3 className="text-lg font-semibold text-white mb-4">
        Decision History
        <span className="text-sm font-normal text-slate-400 ml-2">({decisions.length} decisions)</span>
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-700/50">
              <DecisionSortHeader field="created_at" label="Time" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <th className="pb-2 pr-4">Task ID</th>
              <DecisionSortHeader field="complexity" label="Complexity" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <DecisionSortHeader field="provider" label="Provider" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <th className="pb-2 pr-4">Model</th>
              <DecisionSortHeader field="status" label="Status" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <th className="pb-2 pr-4">Flags</th>
              <th className="pb-2">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {sorted.map((d) => {
              const providerStyle = getProviderStyle(d.provider);
              const complexityStyle = COMPLEXITY_STYLES[d.complexity] || COMPLEXITY_STYLES.unknown;
              return (
                <tr key={d.task_id} className="hover:bg-slate-800/50">
                  <td className="py-2 pr-4 text-slate-500 text-xs whitespace-nowrap">
                    {d.created_at ? new Date(d.created_at).toLocaleString('en-US') : '-'}
                  </td>
                  <td className="py-2 pr-4">
                    <span className="text-slate-300 font-mono text-xs" title={d.task_id}>
                      {(d.task_id || '').slice(0, 8)}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${complexityStyle}`}>
                      {d.complexity}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`px-2 py-0.5 rounded-lg text-xs font-medium ${providerStyle.bg} ${providerStyle.text} capitalize`}>
                      {d.provider}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-slate-400 text-xs font-mono truncate max-w-[120px]" title={d.model || ''}>
                    {d.model ? d.model.split('/').pop() : '-'}
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      d.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                      d.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                      d.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
                      d.status === 'queued' ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-slate-500/20 text-slate-400'
                    }`}>
                      {d.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-1">
                      {d.fallback_used && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-500/20 text-orange-400" title="Fallback provider used">
                          fallback
                        </span>
                      )}
                      {d.needs_review && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-500/20 text-yellow-400" title="Needs manual review">
                          review
                        </span>
                      )}
                      {d.split_advisory && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-500/20 text-purple-400" title="Split advisory">
                          split
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2">
                    <span className="text-slate-300 truncate block max-w-xs" title={d.description}>
                      {d.description}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Operations Table ───────────────────────────────────────

function OperationsTable({ operations }) {
  if (!operations || operations.length === 0) {
    return (
      <div className="glass-card p-6 text-center">
        <p className="text-slate-400">No strategic operations recorded yet.</p>
        <p className="text-slate-500 text-sm mt-1">
          Use decompose, diagnose, or review to see operations here.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-card p-5">
      <h3 className="text-lg font-semibold text-white mb-4">Recent Strategic Operations</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-700/50">
              <th className="pb-2 pr-4">Task</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4">Provider</th>
              <th className="pb-2 pr-4">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {operations.map((op) => (
              <tr key={op.id} className="hover:bg-slate-800/50">
                <td className="py-2 pr-4">
                  <span className="text-slate-300 truncate block max-w-xs" title={op.description}>
                    {(op.description || '').slice(0, 80)}{(op.description || '').length > 80 ? '...' : ''}
                  </span>
                </td>
                <td className="py-2 pr-4">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    op.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                    op.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                    op.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
                    'bg-slate-500/20 text-slate-400'
                  }`}>
                    {op.status}
                  </span>
                </td>
                <td className="py-2 pr-4 text-slate-400 capitalize">{op.provider || '-'}</td>
                <td className="py-2 text-slate-500 text-xs">
                  {op.created_at ? new Date(op.created_at).toLocaleString('en-US') : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Top-Level Tabs ─────────────────────────────────────────

const TOP_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'operations', label: 'Operations' },
  { id: 'routing', label: 'Routing Templates' },
  { id: 'config', label: 'Configuration' },
];

// ─── Main Strategy View ─────────────────────────────────────

export default function Strategic() {
  const [status, setStatus] = useState(null);
  const [operations, setOperations] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [providerHealth, setProviderHealth] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [topTab, setTopTab] = useState('overview');

  const loadData = useCallback(async () => {
    try {
      const [statusData, opsData, decisionsData, healthData] = await Promise.all([
        strategicApi.status(),
        strategicApi.operations(20),
        strategicApi.decisions(50),
        strategicApi.providerHealth(),
      ]);
      setStatus(statusData);
      setOperations(opsData.operations || []);
      setDecisions(unwrapArrayPayload(decisionsData, 'decisions', 'items'));
      setProviderHealth(unwrapArrayPayload(healthData, 'providers', 'items'));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Build a lookup map for provider health by name
  const providerHealthMap = useMemo(() => {
    const map = {};
    for (const p of providerHealth) {
      map[p.provider] = p;
    }
    return map;
  }, [providerHealth]);

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="glass-card p-6 text-center">
          <p className="text-red-400 mb-2">Failed to load strategic brain status</p>
          <p className="text-slate-500 text-sm">{error}</p>
          <button
            onClick={loadData}
            className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const usage = status?.usage || {};
  const totalRuns = (usage.total_calls || 0) + (usage.fallback_calls || 0);
  const fallbackRate = totalRuns > 0 ? ((usage.fallback_calls / totalRuns) * 100).toFixed(1) : '0';

  const enabledProviders = providerHealth.filter((p) => p.enabled).length;
  const healthyProviders = providerHealth.filter((p) => p.health_status === 'healthy').length;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="heading-lg text-white">Strategy</h2>
          <p className="text-sm text-slate-400 mt-1">
            Routing decisions, provider health, and LLM-powered orchestration
          </p>
        </div>
        <button
          onClick={loadData}
          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Top-Level Tab Bar */}
      <div className="mb-6">
        <div className="flex items-center gap-1 border-b border-slate-700/50">
          {TOP_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setTopTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                topTab === tab.id
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Overview Tab */}
      {topTab === 'overview' && (
        <>
          {/* Stat Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <StatCard label="Active Provider" value={status?.provider || 'none'} gradient="blue" />
            <StatCard label="LLM Calls" value={usage.total_calls || 0} gradient="cyan" />
            <StatCard label="Fallback Rate" value={`${fallbackRate}%`} gradient={parseFloat(fallbackRate) > 30 ? 'red' : 'green'} />
            <StatCard label="Tokens Used" value={(usage.total_tokens || 0).toLocaleString()} gradient="purple" />
            <StatCard label="Providers Enabled" value={`${enabledProviders}`} gradient="blue" />
            <StatCard label="Providers Healthy" value={`${healthyProviders}`} gradient={healthyProviders < enabledProviders ? 'orange' : 'green'} />
          </div>

          {/* Config + Confidence */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="glass-card p-5">
              <h3 className="text-sm font-medium text-slate-400 mb-3">Active Configuration</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Provider</span>
                  <span className="text-sm text-white font-medium capitalize">{status?.provider || 'none'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Model</span>
                  <span className="text-sm text-white font-mono text-xs">{status?.model || 'none'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Confidence Threshold</span>
                  <span className="text-sm text-white">{((status?.confidence_threshold || 0) * 100).toFixed(0)}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Total Routing Decisions</span>
                  <span className="text-sm text-white">{decisions.length}</span>
                </div>
              </div>
            </div>

            <div className="glass-card p-5">
              <h3 className="text-sm font-medium text-slate-400 mb-3">Routing Summary</h3>
              <div className="space-y-2">
                {(() => {
                  const byProvider = {};
                  for (const d of decisions) {
                    byProvider[d.provider] = (byProvider[d.provider] || 0) + 1;
                  }
                  const entries = Object.entries(byProvider).sort((a, b) => b[1] - a[1]);
                  if (entries.length === 0) {
                    return <p className="text-slate-500 text-sm">No routing data yet</p>;
                  }
                  return entries.slice(0, 5).map(([prov, count]) => {
                    const style = getProviderStyle(prov);
                    const pct = decisions.length > 0 ? Math.round((count / decisions.length) * 100) : 0;
                    return (
                      <div key={prov} className="flex items-center gap-3">
                        <span className={`text-xs font-medium capitalize w-24 ${style.text}`}>{prov}</span>
                        <div className="flex-1 h-2 bg-slate-700/50 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${style.dot} rounded-full transition-all`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs text-slate-400 w-12 text-right">{count} ({pct}%)</span>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          </div>

          {/* Fallback Chain */}
          <div className="mb-6">
            <FallbackChain
              chain={status?.fallback_chain || ['deepinfra', 'hyperbolic', 'ollama']}
              providerHealthMap={providerHealthMap}
              activeProvider={status?.provider}
            />
          </div>

          {/* Provider Health Cards */}
          <div className="mb-6">
            <ProviderHealthGrid providers={providerHealth} />
          </div>
        </>
      )}

      {/* Decisions Tab */}
      {topTab === 'decisions' && <DecisionHistoryTable decisions={decisions} />}

      {/* Operations Tab */}
      {topTab === 'operations' && <OperationsTable operations={operations} />}

      {/* Routing Templates Tab */}
      {topTab === 'routing' && <Suspense fallback={<div className="text-slate-400 p-4">Loading...</div>}><RoutingTemplates /></Suspense>}

      {/* Configuration Tab */}
      {topTab === 'config' && <Suspense fallback={<div className="text-slate-400 p-4">Loading...</div>}><StrategicConfig /></Suspense>}
    </div>
  );
}
