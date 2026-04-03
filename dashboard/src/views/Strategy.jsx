import React, { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import { format } from 'date-fns';
import {
  strategic as strategicApi,
  providers as providersApi,
  budget as budgetApi,
  tasks as tasksApi,
  routingTemplates as routingTemplatesApi,
} from '../api';
import { SVGBarChart } from '../components/charts';
import StatCard from '../components/StatCard';
import { PROVIDER_COLORS } from '../constants';
import LoadingSkeleton from '../components/LoadingSkeleton';

const RoutingTemplates = React.lazy(() => import('./RoutingTemplates'));
const StrategicConfig = React.lazy(() => import('./StrategicConfig'));

// ─── Color Maps ─────────────────────────────────────────────

const PROVIDER_TEXT_COLORS = {
  ...PROVIDER_COLORS,
  codex: 'text-blue-400',
  'claude-cli': 'text-violet-400',
  ollama: 'text-green-400',
  groq: 'text-pink-400',
  hyperbolic: 'text-purple-400',
  cerebras: 'text-cyan-400',
  'google-ai': 'text-emerald-400',
  openrouter: 'text-amber-400',
  'ollama-cloud': 'text-teal-400',
};

const PROVIDER_STYLES = {
  codex: { bg: 'bg-blue-500/20', text: PROVIDER_TEXT_COLORS.codex, border: 'border-blue-500/30', dot: 'bg-blue-400' },
  'claude-cli': { bg: 'bg-violet-500/20', text: PROVIDER_TEXT_COLORS['claude-cli'], border: 'border-violet-500/30', dot: 'bg-violet-400' },
  ollama: { bg: 'bg-green-500/20', text: PROVIDER_TEXT_COLORS.ollama, border: 'border-green-500/30', dot: 'bg-green-400' },
  anthropic: { bg: 'bg-amber-500/20', text: PROVIDER_TEXT_COLORS.anthropic, border: 'border-amber-500/30', dot: 'bg-amber-400' },
  groq: { bg: 'bg-pink-500/20', text: PROVIDER_TEXT_COLORS.groq, border: 'border-pink-500/30', dot: 'bg-pink-400' },
  deepinfra: { bg: 'bg-orange-500/20', text: PROVIDER_TEXT_COLORS.deepinfra, border: 'border-orange-500/30', dot: 'bg-orange-400' },
  hyperbolic: { bg: 'bg-purple-500/20', text: PROVIDER_TEXT_COLORS.hyperbolic, border: 'border-purple-500/30', dot: 'bg-purple-400' },
  cerebras: { bg: 'bg-cyan-500/20', text: 'text-cyan-400', border: 'border-cyan-500/30', dot: 'bg-cyan-400' },
  'google-ai': { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/30', dot: 'bg-emerald-400' },
  openrouter: { bg: 'bg-amber-500/20', text: 'text-amber-400', border: 'border-amber-500/30', dot: 'bg-amber-400' },
  'ollama-cloud': { bg: 'bg-teal-500/20', text: 'text-teal-400', border: 'border-teal-500/30', dot: 'bg-teal-400' },
};

const FALLBACK_PROVIDER_STYLE = { bg: 'bg-slate-500/20', text: 'text-slate-400', border: 'border-slate-500/30', dot: 'bg-slate-400' };

function getProviderStyle(name) {
  return PROVIDER_STYLES[name] || FALLBACK_PROVIDER_STYLE;
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
  const candidates = [payload, payload?.data];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;

    for (const key of keys) {
      if (Array.isArray(candidate?.[key])) {
        return candidate[key];
      }
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
  const activeCount = chain.filter(
    (p) => {
      const h = providerHealthMap[p];
      return h && (h.health_status === 'healthy' || h.health_status === 'warning');
    }
  ).length;
  const totalCount = chain.length;

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Fallback Chain</h3>
        <span className="text-xs text-slate-400">
          {activeCount}/{totalCount} healthy in chain
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {chain.map((provider, i) => {
          const healthData = providerHealthMap[provider];
          const healthStatus = healthData?.health_status || (healthData?.enabled === false ? 'disabled' : 'healthy');
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
    : '—';

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
          <p className="text-slate-500 mb-0.5">Success (7d)</p>
          <p className="text-white font-medium">
            {data.success_rate_7d !== null && data.success_rate_7d !== undefined ? `${data.success_rate_7d}%` : '—'}
          </p>
        </div>
        <div>
          <p className="text-slate-500 mb-0.5">Avg Latency</p>
          <p className="text-white font-medium">{avgLatencyDisplay}</p>
        </div>
        <div>
          <p className="text-slate-500 mb-0.5">Completed (7d)</p>
          <p className="text-white font-medium">{data.completed_7d || 0}</p>
        </div>
        <div>
          <p className="text-slate-500 mb-0.5">Failed (7d)</p>
          <p className="text-white font-medium">{data.failed_7d || 0}</p>
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
            {sorted.map((d, index) => {
              const providerStyle = getProviderStyle(d.provider);
              const complexityStyle = COMPLEXITY_STYLES[d.complexity] || COMPLEXITY_STYLES.unknown;
              return (
                <tr key={d.task_id} data-testid={`decision-row-${index}`} className="hover:bg-slate-800/50">
                  <td className="py-2 pr-4 text-slate-500 text-xs whitespace-nowrap">
                    {d.created_at ? format(new Date(d.created_at), 'MMM d, yyyy HH:mm') : '-'}
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
                  {op.created_at ? format(new Date(op.created_at), 'MMM d, yyyy HH:mm') : '-'}
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
  const [providerStats, setProviderStats] = useState([]);
  const [budgetSummary, setBudgetSummary] = useState(null);
  const [queueDepth, setQueueDepth] = useState({ queued: 0, running: 0 });
  const [activeTemplate, setActiveTemplate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [topTab, setTopTab] = useState('overview');

  const loadData = useCallback(async () => {
    const optionalCall = (request, fallbackValue) =>
      Promise.resolve()
        .then(request)
        .catch(() => fallbackValue);

    try {
      const [statusData, opsData, decisionsData, healthData, provData, budgetData, queuedData, runningData, templateData] = await Promise.all([
        strategicApi.status(),
        strategicApi.operations(20),
        strategicApi.decisions(50),
        strategicApi.providerHealth(),
        optionalCall(() => providersApi.list(), []),
        optionalCall(() => budgetApi.summary(7), null),
        optionalCall(() => tasksApi.list({ status: 'queued', limit: 1 }), { total: 0 }),
        optionalCall(() => tasksApi.list({ status: 'running', limit: 1 }), { total: 0 }),
        optionalCall(() => routingTemplatesApi.getActive(), null),
      ]);
      setStatus(statusData);
      setOperations(unwrapArrayPayload(opsData, 'operations', 'items'));
      setDecisions(unwrapArrayPayload(decisionsData, 'decisions', 'items'));
      setProviderHealth(unwrapArrayPayload(healthData, 'providers', 'items'));
      setProviderStats(Array.isArray(provData) ? provData : []);
      setBudgetSummary(budgetData);
      setQueueDepth({ queued: queuedData?.total || 0, running: runningData?.total || 0 });
      setActiveTemplate(templateData?.template || null);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadData();
    }, 15000);
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
      <div className="p-6">
        <LoadingSkeleton lines={5} />
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

  const enabledProviders = providerHealth.filter((p) => p.enabled).length;
  const healthyProviders = providerHealth.filter((p) => p.health_status === 'healthy').length;
  const totalTasks7d = providerStats.reduce((s, p) => s + (p.stats?.total_tasks || 0), 0);
  const completedTasks7d = providerStats.reduce((s, p) => s + (p.stats?.completed_tasks || p.stats?.successful_tasks || 0), 0);
  const successRate7d = totalTasks7d > 0 ? Math.round((completedTasks7d / totalTasks7d) * 100) : null;
  const totalCost7d = budgetSummary?.total_cost || 0;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="heading-lg text-white">Strategy</h2>
          <p className="text-sm text-slate-400 mt-1">
            Task routing, provider health, and queue status
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
            <StatCard label="Tasks (7d)" value={totalTasks7d} gradient="blue" />
            <StatCard
              label="Success Rate"
              value={successRate7d !== null ? `${successRate7d}%` : 'N/A'}
              gradient={successRate7d === null ? 'slate' : successRate7d >= 80 ? 'green' : successRate7d >= 50 ? 'orange' : 'red'}
            />
            <StatCard label="Queue" value={queueDepth.queued + queueDepth.running} subtext={`${queueDepth.running} running`} gradient={queueDepth.queued > 10 ? 'orange' : 'cyan'} />
            <StatCard label="Cost (7d)" value={`$${totalCost7d.toFixed(2)}`} gradient="purple" />
            <StatCard
              label="Providers"
              value={`${healthyProviders}/${enabledProviders}`}
              subtext="healthy / enabled"
              gradient={healthyProviders < enabledProviders ? 'orange' : 'green'}
            />
          </div>

          {/* Active Routing + Tasks by Provider */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="glass-card p-5">
              <h3 className="text-sm font-medium text-slate-400 mb-3">Active Routing</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Template</span>
                  <span className="text-sm text-white font-medium">{activeTemplate?.name || 'System Default'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Default Provider</span>
                  <span className="text-sm text-white font-medium capitalize">{status?.provider || 'auto'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Total Decisions</span>
                  <span className="text-sm text-white">{decisions.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Tasks (7d)</span>
                  <span className="text-sm text-white">{totalTasks7d}</span>
                </div>
              </div>
            </div>

            <div className="glass-card p-5">
              <h3 className="text-sm font-medium text-slate-400 mb-3">Tasks by Provider (7d)</h3>
              {(() => {
                const chartData = providerStats
                  .filter((p) => (p.stats?.total_tasks || 0) > 0)
                  .sort((a, b) => (b.stats?.total_tasks || 0) - (a.stats?.total_tasks || 0))
                  .slice(0, 8)
                  .map((p) => ({
                    name: p.provider,
                    tasks: p.stats?.total_tasks || 0,
                  }));
                if (chartData.length === 0) {
                  return <p className="text-slate-500 text-sm">No task data yet</p>;
                }
                return (
                  <SVGBarChart
                    data={chartData}
                    xKey="name"
                    bars={[{
                      dataKey: 'tasks',
                      colorFn: (entry) => {
                        const colorMap = {
                          codex: '#3b82f6',
                          'claude-cli': '#8b5cf6',
                          ollama: '#22c55e',
                          groq: '#ec4899',
                          deepinfra: '#f97316',
                          hyperbolic: '#a855f7',
                          cerebras: '#06b6d4',
                          'google-ai': '#10b981',
                          openrouter: '#f59e0b',
                          'ollama-cloud': '#14b8a6',
                          anthropic: '#f59e0b',
                        };
                        return colorMap[entry.name] || '#64748b';
                      },
                    }]}
                    height={180}
                    formatTooltip={(v) => `${v} tasks`}
                  />
                );
              })()}
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

          {/* Recent Routing Decisions */}
          {decisions.length > 0 && (
            <div className="glass-card p-5 mb-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold text-white">Recent Decisions</h3>
                <button
                  onClick={() => setTopTab('decisions')}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  View all
                </button>
              </div>
              <div className="space-y-2">
                {decisions.slice(0, 5).map((d) => {
                  const style = getProviderStyle(d.provider);
                  const complexityStyle = COMPLEXITY_STYLES[d.complexity] || COMPLEXITY_STYLES.unknown;
                  return (
                    <div key={d.task_id} className="flex items-center gap-3 text-xs">
                      <span className="text-slate-500 w-16 shrink-0">
                        {d.created_at ? format(new Date(d.created_at), 'HH:mm') : '—'}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full font-medium ${complexityStyle} shrink-0`}>
                        {d.complexity}
                      </span>
                      <span className={`px-2 py-0.5 rounded-lg font-medium ${style.bg} ${style.text} capitalize shrink-0`}>
                        {d.provider}
                      </span>
                      <span className="text-slate-400 truncate">{d.reason || d.description || '—'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Provider Health Cards */}
          <div className="mb-6">
            <ProviderHealthGrid providers={providerHealth.map((p) => {
              const ps = providerStats.find((s) => s.provider === p.provider);
              return {
                ...p,
                total_tasks_7d: ps?.stats?.total_tasks || 0,
                completed_7d: ps?.stats?.completed_tasks || ps?.stats?.successful_tasks || 0,
                failed_7d: ps?.stats?.failed_tasks || 0,
                success_rate_7d: ps?.stats?.success_rate || null,
                avg_duration_seconds: ps?.stats?.avg_duration_seconds || p.avg_duration_seconds || null,
              };
            })} />
          </div>
        </>
      )}

      {/* Decisions Tab */}
      {topTab === 'decisions' && <DecisionHistoryTable decisions={decisions} />}

      {/* Operations Tab */}
      {topTab === 'operations' && <OperationsTable operations={operations} />}

      {/* Routing Templates Tab */}
      {/* Lazy-loaded and only mounted on active tab — data fetching deferred until visible */}
      {topTab === 'routing' && <Suspense fallback={<div className="text-slate-400 p-4">Loading...</div>}><RoutingTemplates /></Suspense>}

      {/* Configuration Tab */}
      {/* Lazy-loaded and only mounted on active tab — data fetching deferred until visible */}
      {topTab === 'config' && (
        <>
          <div className="glass-card p-5 mb-6">
            <h3 className="text-sm font-medium text-slate-400 mb-3">Strategic Intelligence</h3>
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
            </div>
          </div>
          <Suspense fallback={<div className="text-slate-400 p-4">Loading...</div>}>
            <StrategicConfig />
          </Suspense>
        </>
      )}
    </div>
  );
}
