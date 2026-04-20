import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { providers as providersApi, stats as statsApi, hosts as hostsApi, concurrency, providerCrud, requestV2, quota as quotaApi } from '../api';
import { useToast } from '../components/Toast';
import StatCard from '../components/StatCard';
import LoadingSkeleton from '../components/LoadingSkeleton';
import { PROVIDER_HEX_COLORS } from '../constants';
import { formatDate } from '../utils/formatters';
import { SVGLineChart, SVGBarChart, SVGPieChart } from '../components/charts';

const CLOUD_API_PROVIDERS = new Set([
  'deepinfra', 'hyperbolic', 'groq', 'cerebras', 'google-ai',
  'openrouter', 'ollama-cloud', 'anthropic',
]);

const ENV_VAR_NAMES = {
  deepinfra: 'DEEPINFRA_API_KEY', hyperbolic: 'HYPERBOLIC_API_KEY',
  groq: 'GROQ_API_KEY', cerebras: 'CEREBRAS_API_KEY',
  'google-ai': 'GOOGLE_AI_API_KEY', openrouter: 'OPENROUTER_API_KEY',
  'ollama-cloud': 'OLLAMA_CLOUD_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
};

const PROVIDER_GROUPS = [
  { label: 'Local (Ollama)', providers: new Set(['ollama']) },
  { label: 'Cloud (Subscription CLI)', providers: new Set(['codex', 'claude-cli']) },
  { label: 'Cloud (API — Bring Your Own Key)', providers: null }, // everything else
];

function groupProviders(list) {
  const groups = PROVIDER_GROUPS.map(g => ({ ...g, items: [] }));
  for (const p of list) {
    const name = p.provider || '';
    let placed = false;
    for (const g of groups) {
      if (g.providers && g.providers.has(name)) {
        g.items.push(p);
        placed = true;
        break;
      }
    }
    if (!placed) groups[groups.length - 1].items.push(p);
  }
  return groups.filter(g => g.items.length > 0);
}

const COLORS = {
  ...PROVIDER_HEX_COLORS,
  completed: '#22c55e',
  failed: '#ef4444',
};

function getProviderColor(name) {
  return PROVIDER_HEX_COLORS[name] || '#6b7280';
}

function Sparkline({ data, color, width = 80, height = 24 }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1);
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - (v / max) * height;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg width={width} height={height} className="inline-block ml-2 opacity-70">
      <polyline fill="none" stroke={color} strokeWidth={1.5} points={points} />
    </svg>
  );
}

function formatQuotaDisplay(value, limit) {
  if (value == null || limit == null) return '?/?';
  if (limit >= 10000) {
    return `${Math.round(value / 1000)}K/${Math.round(limit / 1000)}K`;
  }
  return `${value}/${limit}`;
}

function getQuotaPercent(remaining, limit) {
  if (remaining == null || !limit) return 0;
  return Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));
}

function getQuotaColorClass(percent) {
  if (percent > 50) return 'bg-green-500';
  if (percent >= 10) return 'bg-yellow-500';
  return 'bg-red-500';
}

function formatResetCountdown(resetsAt) {
  if (!resetsAt) return 'unknown';
  const resetMs = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(resetMs)) return 'unknown';
  if (resetMs <= 0) return '0s';
  const totalSeconds = Math.ceil(resetMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function formatUpdatedAgo(lastUpdated) {
  if (!lastUpdated) return 'never';
  const diffSeconds = Math.max(0, Math.round((Date.now() - new Date(lastUpdated).getTime()) / 1000));
  if (!Number.isFinite(diffSeconds)) return 'never';
  return `${diffSeconds}s`;
}

function formatCooldownRemaining(cooldownUntil) {
  if (!cooldownUntil) return null;
  const remainingMs = new Date(cooldownUntil).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  return `${Math.ceil(remainingMs / 1000)}s remaining`;
}

function QuotaBar({ label, remaining, limit }) {
  if (remaining == null || !limit) return null;
  const percent = getQuotaPercent(remaining, limit);
  const colorClass = getQuotaColorClass(percent);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-8 text-slate-500">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-700">
        <div
          className={`h-full rounded-full transition-all ${colorClass}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="w-20 text-right tabular-nums text-slate-400">
        {formatQuotaDisplay(remaining, limit)}
      </span>
    </div>
  );
}

function QuotaStatusBadge({ quota }) {
  if (!quota) {
    return (
      <span
        className="h-2.5 w-2.5 rounded-full bg-slate-500"
        title="No quota data"
        aria-label="No quota data"
      />
    );
  }

  const status = quota?.status || 'gray';
  const bgColor = {
    green: 'bg-green-500',
    yellow: 'bg-yellow-500',
    red: 'bg-red-500',
    gray: 'bg-slate-500',
  }[status] || 'bg-slate-500';

  const tooltipLines = [];
  const cooldownRemaining = formatCooldownRemaining(quota?.cooldownUntil);
  if (cooldownRemaining) {
    tooltipLines.push(`Cooldown: ${cooldownRemaining}`);
  }
  if (quota?.limits?.rpm) {
    tooltipLines.push(`RPM: ${formatQuotaDisplay(quota.limits.rpm.remaining, quota.limits.rpm.limit)}`);
  }
  if (quota?.limits?.tpm) {
    tooltipLines.push(`TPM: ${formatQuotaDisplay(quota.limits.tpm.remaining, quota.limits.tpm.limit)}`);
  }
  if (quota?.limits?.daily) {
    tooltipLines.push(`Day: ${formatQuotaDisplay(quota.limits.daily.remaining, quota.limits.daily.limit)}`);
  }
  const resetAt = quota?.limits?.rpm?.resetsAt || quota?.limits?.tpm?.resetsAt || quota?.limits?.daily?.resetsAt;
  tooltipLines.push(`Reset: ${formatResetCountdown(resetAt)}`);
  const tooltip = tooltipLines.length > 0 ? tooltipLines.join('\n') : 'No quota data';

  return (
    <span
      className={`h-2.5 w-2.5 rounded-full ${bgColor}`}
      title={tooltip}
      aria-label={tooltip}
    />
  );
}

function ProviderRow({ provider, quota, sparkData, onToggle, onUpdateConcurrency, onSetApiKey, onClearApiKey }) {
  const color = getProviderColor(provider.provider);
  const dailyCounts = sparkData?.map((d) => d[provider.provider] || 0) || [];
  const [expanded, setExpanded] = useState(false);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyValue, setKeyValue] = useState('');
  const [keyLoading, setKeyLoading] = useState(false);
  const isCloudProvider = CLOUD_API_PROVIDERS.has(provider.provider) ||
    provider.provider_type === 'cloud-api' || provider.provider_type === 'custom';
  const envVarName = ENV_VAR_NAMES[provider.provider] || '';
  const hasQuotaData = Boolean(
    quota && (quota.limits?.rpm?.limit || quota.limits?.tpm?.limit || quota.limits?.daily?.limit)
  );

  const rate = provider.stats?.success_rate || 0;
  const total = provider.stats?.total_tasks || 0;
  const avgDur = provider.stats?.avg_duration_seconds;
  const cost = provider.stats?.total_cost;
  const rateColor = total === 0 ? 'bg-slate-600' : rate >= 80 ? 'bg-green-500' : rate >= 50 ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div className="border-b border-slate-700/50 last:border-b-0">
      {/* Main row */}
      <div
        className="flex items-center gap-4 px-4 py-2.5 hover:bg-slate-800/30 cursor-pointer transition-colors"
        tabIndex={0}
        role="button"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
      >
        <span
          aria-hidden="true"
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="text-sm font-semibold text-white w-36 truncate">{provider.provider}</span>
        <QuotaStatusBadge quota={quota} />
        <div className="flex items-center gap-1 w-20">
          <div className="h-1.5 flex-1 bg-slate-700 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${rateColor}`} style={{ width: `${total > 0 ? rate : 0}%` }} />
          </div>
          <span className="text-xs tabular-nums text-slate-400 w-8 text-right">{total > 0 ? `${rate}%` : '-'}</span>
        </div>
        <span className="text-xs tabular-nums text-slate-400 w-16 text-right">{total} tasks</span>
        <span className="text-xs tabular-nums text-slate-400 w-12 text-right">{avgDur ? `${Math.round(avgDur)}s` : '-'}</span>
        <span className="text-xs tabular-nums text-slate-400 w-14 text-right">{cost != null && cost > 0 ? `$${Number(cost).toFixed(2)}` : '-'}</span>
        <Sparkline data={dailyCounts} color={color} width={60} height={18} />
        <button
          onClick={(e) => { e.stopPropagation(); onToggle?.(provider.provider, !provider.enabled); }}
          className={`relative w-8 h-4 rounded-full transition-colors flex-shrink-0 ${provider.enabled ? 'bg-green-600' : 'bg-slate-600'}`}
          title={provider.enabled ? 'Disable provider' : 'Enable provider'}
          aria-label={provider.enabled ? `Disable ${provider.provider}` : `Enable ${provider.provider}`}
        >
          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${provider.enabled ? 'left-[17px]' : 'left-0.5'}`} />
        </button>
        <svg className={`w-3.5 h-3.5 text-slate-500 transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-3 pt-1 ml-7 space-y-2">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-green-400">{provider.stats?.successful_tasks || 0} passed</span>
              <span className="text-red-400">{provider.stats?.failed_tasks || 0} failed</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">Max Concurrent:</span>
              <input
                type="number"
                min={1}
                max={100}
                defaultValue={provider.max_concurrent || 1}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const val = parseInt(e.target.value);
                  if (val >= 1 && val <= 100 && val !== provider.max_concurrent) {
                    onUpdateConcurrency(provider.provider, val);
                  }
                }}
                className="w-14 px-1.5 py-0.5 text-xs bg-slate-800 border border-slate-600 rounded text-white"
              />
            </div>
          </div>
          {hasQuotaData && (
            <div className="space-y-1">
              <QuotaBar label="RPM" remaining={quota.limits?.rpm?.remaining} limit={quota.limits?.rpm?.limit} />
              <QuotaBar label="TPM" remaining={quota.limits?.tpm?.remaining} limit={quota.limits?.tpm?.limit} />
              <QuotaBar label="Day" remaining={quota.limits?.daily?.remaining} limit={quota.limits?.daily?.limit} />
              <p className="text-[10px] text-slate-600">
                Updated {formatUpdatedAgo(quota.lastUpdated)}{quota.lastUpdated ? ' ago' : ''} ({quota.source || 'unknown'})
              </p>
            </div>
          )}
          {isCloudProvider && (
            <div className="mt-3 pt-3 border-t border-slate-700/50">
              {provider.api_key_status === 'env' && (
                <div className="flex items-center gap-2">
                  <svg className="w-3 h-3 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                  </svg>
                  <span className="text-xs text-green-400">Set via environment</span>
                  <code className="text-[10px] text-slate-500 ml-1">{envVarName}</code>
                </div>
              )}
              {provider.api_key_status === 'stored' && !showKeyInput && (
                <div className="flex items-center gap-2">
                  <svg className="w-3 h-3 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                  </svg>
                  <span className="text-xs text-slate-400 font-mono">{provider.api_key_masked || '<redacted>'}</span>
                  <button onClick={(e) => { e.stopPropagation(); setShowKeyInput(true); }} className="text-xs text-blue-400 hover:text-blue-300 ml-auto">Change</button>
                  <button onClick={async (e) => { e.stopPropagation(); await onClearApiKey?.(provider.provider); }} className="text-xs text-red-400 hover:text-red-300">Remove</button>
                </div>
              )}
              {provider.api_key_status === 'validating' && (
                <div className="flex items-center gap-2">
                  <svg className="w-3 h-3 text-amber-400 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span className="text-xs text-amber-400">Validating key...</span>
                </div>
              )}
              {(provider.api_key_status === 'not_set' && !showKeyInput) && (
                <div className="flex items-center gap-2">
                  <svg className="w-3 h-3 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                  </svg>
                  <span className="text-xs text-slate-500">No API key</span>
                  <button onClick={(e) => { e.stopPropagation(); setShowKeyInput(true); }} className="text-xs text-blue-400 hover:text-blue-300 ml-auto">Add Key</button>
                </div>
              )}
              {showKeyInput && (
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="password"
                    value={keyValue}
                    onChange={(e) => setKeyValue(e.target.value)}
                    placeholder="Paste API key"
                    maxLength={256}
                    className="flex-1 px-2 py-1 bg-slate-800 border border-slate-600 rounded text-xs text-white focus:outline-none focus:border-blue-500"
                    autoFocus
                  />
                  <button
                    disabled={!keyValue.trim() || keyLoading}
                    onClick={async () => {
                      setKeyLoading(true);
                      try { await onSetApiKey?.(provider.provider, keyValue.trim()); }
                      finally { setKeyLoading(false); setKeyValue(''); setShowKeyInput(false); }
                    }}
                    className="text-xs text-green-400 hover:text-green-300 disabled:opacity-40"
                  >
                    {keyLoading ? '...' : 'Save'}
                  </button>
                  <button
                    onClick={() => { setKeyValue(''); setShowKeyInput(false); }}
                    className="text-xs text-slate-400 hover:text-slate-300"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


const CHART_METRICS = {
  requests: { field: 'total_requests', label: 'Requests' },
  tokens: { field: 'total_tokens', label: 'Tokens' },
};

function buildChartData(history, metric = 'requests') {
  if (!history || history.length === 0) return { chartData: [], providerKeys: [] };

  const fieldName = CHART_METRICS[metric]?.field || 'total_requests';
  const byDate = {};
  const providerSet = new Set();

  for (const row of history) {
    if (!row?.provider || !row?.date) continue;
    providerSet.add(row.provider);
    if (!byDate[row.date]) byDate[row.date] = { date: row.date };
    byDate[row.date][row.provider] = row[fieldName] || 0;
  }

  const providerKeys = [...providerSet].sort();
  const chartData = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

  for (const entry of chartData) {
    for (const provider of providerKeys) {
      if (entry[provider] === undefined) entry[provider] = 0;
    }
  }

  return { chartData, providerKeys };
}

export default function Providers({ statsVersion, tasksTick }) {
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [providersList, setProvidersList] = useState([]);
  const [timeSeries, setTimeSeries] = useState([]);
  const [usageHistory, setUsageHistory] = useState([]);
  const [trends, setTrends] = useState(null);
  const [hostCount, setHostCount] = useState(0);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('overview'); // 'overview' | 'compare'
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');
  const [usageMetric, setUsageMetric] = useState('requests');
  const [codexExhausted, setCodexExhausted] = useState(false);
  const [quotas, setQuotas] = useState({});
  const addToast = useToast();
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProvider, setNewProvider] = useState({ name: '', provider_type: 'cloud-api', api_base_url: '', max_concurrent: 3 });

  const handleAddProvider = async () => {
    try {
      await providerCrud.add(newProvider);
      addToast.success(`Provider '${newProvider.name}' added`);
      setShowAddProvider(false);
      setNewProvider({ name: '', provider_type: 'cloud-api', api_base_url: '', max_concurrent: 3 });
      loadData();
    } catch (err) {
      addToast.error(`Failed: ${err.message}`);
    }
  };

  const loadData = useCallback(async () => {
    if (!mountedRef.current) return;
    try {
      const [providersData, timeSeriesData, hostsData, trendsData, codexCfg, quotaData, historyResult] = await Promise.all([
        providersApi.list(),
        statsApi.timeseries({ days }),
        hostsApi.list().catch(() => []),
        providersApi.trends(days).catch(() => null),
        requestV2('/config/codex_exhausted', { timeout: 5000 }).catch(() => null),
        quotaApi.status().then((data) => data?.providers || data).catch(() => ({})),
        quotaApi.history(7).catch(() => ({ history: [] })),
      ]);
      if (!mountedRef.current) return;

      // Use server-enriched stats when available (the list endpoint already includes stats).
      // Only fetch per-provider stats if the list response is missing them.
      // Normalize field names: server returns completed_tasks, frontend uses successful_tasks.
      const needsEnrichment = Array.isArray(providersData) && providersData.length > 0 && !providersData[0].stats;
      if (!needsEnrichment && Array.isArray(providersData)) {
        for (const p of providersData) {
          if (p.stats && p.stats.completed_tasks != null && p.stats.successful_tasks == null) {
            p.stats.successful_tasks = p.stats.completed_tasks;
          }
        }
      }
      const enriched = needsEnrichment ? await Promise.all(
        providersData.map(async (p) => {
          try {
            const statsData = await providersApi.stats(p.id || p.provider, days);
            const rows = Array.isArray(statsData) ? statsData : Object.values(statsData || {}).filter(v => v && typeof v === 'object' && v.provider);
            const totalTasks = rows.reduce((s, r) => s + (r.total_tasks || 0), 0);
            const successfulTasks = rows.reduce((s, r) => s + (r.successful_tasks || 0), 0);
            const failedTasks = rows.reduce((s, r) => s + (r.failed_tasks || 0), 0);
            const avgDuration = totalTasks > 0
              ? rows.reduce((s, r) => s + (r.avg_duration_seconds || 0) * (r.total_tasks || 0), 0) / totalTasks
              : 0;
            return {
              ...p,
              stats: {
                total_tasks: totalTasks,
                successful_tasks: successfulTasks,
                failed_tasks: failedTasks,
                success_rate: totalTasks > 0 ? Math.round((successfulTasks / totalTasks) * 100) : 0,
                avg_duration_seconds: avgDuration,
              },
            };
          } catch {
            return { ...p, stats: { total_tasks: 0, successful_tasks: 0, failed_tasks: 0, success_rate: 0, avg_duration_seconds: 0 } };
          }
        })
      ) : (Array.isArray(providersData) ? providersData : []);

      setProvidersList(enriched);
      setTimeSeries(timeSeriesData);
      setUsageHistory(Array.isArray(historyResult?.history) ? historyResult.history : []);
      setHostCount(Array.isArray(hostsData) ? hostsData.length : 0);
      setTrends(trendsData);
      setCodexExhausted(codexCfg?.value === '1' || codexCfg === '1');
      setQuotas(quotaData && typeof quotaData === 'object' ? quotaData : {});
    } catch (err) {
      if (!mountedRef.current) return;
      console.error('Failed to load provider data:', err);
      addToast.error('Failed to load provider data');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [days, addToast]);

  // Refetch when statsVersion or tasksTick changes (WebSocket push) or days filter changes
  useEffect(() => {
    loadData();
  }, [days, statsVersion, tasksTick, loadData]);

  // Fallback polling at 120s in case WebSocket is disconnected
  useEffect(() => {
    const pollInterval = setInterval(() => {
      if (document.hidden) return;
      loadData();
    }, 120000);
    return () => clearInterval(pollInterval);
  }, [loadData]);

  async function handleToggle(providerId, enabled) {
    try {
      await providersApi.toggle(providerId, enabled);
      addToast.success(`Provider ${enabled ? 'enabled' : 'disabled'}`);
      loadData();
    } catch (err) {
      console.error('Toggle failed:', err);
      addToast.error(`Toggle failed: ${err.message}`);
    }
  }

  const handleUpdateConcurrency = async (providerName, value) => {
    try {
      await concurrency.set({ scope: 'provider', target: providerName, max_concurrent: value });
      addToast.success(`${providerName} max concurrent set to ${value}`);
      loadData();
    } catch (err) {
      addToast.error(`Failed: ${err.message}`);
    }
  };

  const handleSetApiKey = async (providerName, apiKey) => {
    try {
      await providerCrud.setApiKey(providerName, apiKey);
      addToast.success('API key saved');
      loadData();
      // Re-fetch after health check has time to complete
      setTimeout(() => { if (mountedRef.current) loadData(); }, 5000);
      setTimeout(() => { if (mountedRef.current) loadData(); }, 15000);
    } catch (err) {
      addToast.error(`Failed to save key: ${err.message}`);
    }
  };

  const handleClearApiKey = async (providerName) => {
    try {
      await providerCrud.clearApiKey(providerName);
      addToast.success('API key cleared');
      loadData();
    } catch (err) {
      addToast.error(`Failed to clear key: ${err.message}`);
    }
  };

  const totals = providersList.reduce(
    (acc, p) => {
      acc[p.provider] = p.stats?.total_tasks || 0;
      return acc;
    },
    {}
  );

  const pieData = Object.entries(totals)
    .filter(([_, v]) => v > 0)
    .map(([name, value]) => ({ name, value }));

  const durationData = providersList
    .filter((p) => p.stats?.avg_duration_seconds > 0)
    .map((p) => ({
      name: p.provider,
      duration: Math.round(p.stats.avg_duration_seconds),
    }));

  const totalTasks = providersList.reduce((s, p) => s + (p.stats?.total_tasks || 0), 0);
  const activeProvidersList = providersList.filter(p => (p.stats?.total_tasks || 0) > 0);
  const avgSuccessRate = activeProvidersList.length > 0
    ? Math.round(activeProvidersList.reduce((s, p) => s + (p.stats?.success_rate || 0), 0) / activeProvidersList.length)
    : 0;

  // Filter providers with actual data for trend charts
  const activeProviders = trends?.providers?.filter(p =>
    trends.series.some(d => (d[`${p}_total`] || 0) > 0)
  ) || [];

  const { chartData: usageChartData, providerKeys: usageProviderKeys } = useMemo(
    () => buildChartData(usageHistory, usageMetric),
    [usageHistory, usageMetric],
  );

  // Comparison data for head-to-head mode
  const comparisonData = useMemo(() => {
    if (viewMode !== 'compare' || !compareA || !compareB) return null;
    const provA = providersList.find(p => p.provider === compareA);
    const provB = providersList.find(p => p.provider === compareB);
    if (!provA || !provB) return null;

    const metrics = [
      {
        metric: 'Total Tasks',
        [compareA]: provA.stats?.total_tasks || 0,
        [compareB]: provB.stats?.total_tasks || 0,
      },
      {
        metric: 'Success Rate',
        [compareA]: provA.stats?.success_rate || 0,
        [compareB]: provB.stats?.success_rate || 0,
      },
      {
        metric: 'Avg Duration (s)',
        [compareA]: Math.round(provA.stats?.avg_duration_seconds || 0),
        [compareB]: Math.round(provB.stats?.avg_duration_seconds || 0),
      },
    ];

    // Cost efficiency: tasks per dollar (only if cost > 0)
    const costA = Number(provA.stats?.total_cost || 0);
    const costB = Number(provB.stats?.total_cost || 0);
    if (costA > 0 || costB > 0) {
      metrics.push({
        metric: 'Tasks / $',
        [compareA]: costA > 0 ? Math.round((provA.stats?.total_tasks || 0) / costA) : 0,
        [compareB]: costB > 0 ? Math.round((provB.stats?.total_tasks || 0) / costB) : 0,
      });
    }

    return { metrics, colorA: getProviderColor(compareA), colorB: getProviderColor(compareB) };
  }, [viewMode, compareA, compareB, providersList]);

  if (loading) {
    return (
      <div className="p-6">
        <LoadingSkeleton lines={5} />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Codex exhaustion banner */}
      {codexExhausted && (
        <div className="mb-4 p-3 bg-red-900/50 border border-red-500 rounded-lg text-red-200">
          <span className="font-semibold">Codex Quota Exhausted</span> — All tasks routing to local LLM. Recovery probe runs every 15 minutes.
        </div>
      )}

      {/* Add Provider Form */}
      {showAddProvider && (
        <div className="glass-card p-5 mb-6">
          <h3 className="text-lg font-semibold text-white mb-3">Add Provider</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="provider-name" className="text-xs text-slate-400 block mb-1">Name</label>
              <input id="provider-name" value={newProvider.name} onChange={e => setNewProvider({...newProvider, name: e.target.value})} className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm" placeholder="my-provider" />
            </div>
            <div>
              <label htmlFor="provider-type" className="text-xs text-slate-400 block mb-1">Type</label>
              <select id="provider-type" value={newProvider.provider_type} onChange={e => setNewProvider({...newProvider, provider_type: e.target.value})} className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm">
                <option value="ollama">Ollama</option>
                <option value="cloud-api">Cloud API</option>
                <option value="cloud-cli">Cloud CLI</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div>
              <label htmlFor="provider-api-base-url" className="text-xs text-slate-400 block mb-1">API Base URL</label>
              <input id="provider-api-base-url" value={newProvider.api_base_url} onChange={e => setNewProvider({...newProvider, api_base_url: e.target.value})} placeholder="https://api.example.com/v1" className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm" />
            </div>
            <div>
              <label htmlFor="provider-max-concurrent" className="text-xs text-slate-400 block mb-1">Max Concurrent</label>
              <input id="provider-max-concurrent" type="number" value={newProvider.max_concurrent} onChange={e => setNewProvider({...newProvider, max_concurrent: parseInt(e.target.value) || 3})} className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm" />
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={handleAddProvider} className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 text-sm">Create</button>
            <button onClick={() => setShowAddProvider(false)} className="px-4 py-2 bg-slate-700 text-slate-300 rounded hover:bg-slate-600 text-sm">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <h2 className="heading-lg text-white">Provider Statistics</h2>
          <div className="flex bg-slate-800 rounded-lg p-0.5 border border-slate-700">
            <button
              onClick={() => setViewMode('overview')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                viewMode === 'overview' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setViewMode('compare')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                viewMode === 'compare' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Compare
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowAddProvider(!showAddProvider)}
            className="px-4 py-2 bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 text-sm rounded-lg hover:bg-indigo-600/40"
          >{showAddProvider ? 'Cancel' : 'Add Provider'}</button>
          <select
            aria-label="Filter provider stats by time range"
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          >
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          </select>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total Tasks" value={totalTasks} subtext={`Last ${days} days`} gradient="blue" />
        <StatCard label="Providers" value={providersList.length} />
        <StatCard label="Hosts" value={hostCount} subtext="Ollama hosts" />
        <StatCard label="Avg Success" value={`${avgSuccessRate}%`} gradient={avgSuccessRate >= 90 ? 'green' : undefined} />
      </div>

      {/* Comparison mode */}
      {viewMode === 'compare' && (
        <div className="glass-card p-6 mb-8">
          <div className="flex items-center gap-4 mb-6">
            <select
              aria-label="Compare provider A"
              value={compareA}
              onChange={(e) => setCompareA(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500 flex-1"
            >
              <option value="">Select Provider A</option>
              {providersList.map(p => (
                <option key={p.provider} value={p.provider} disabled={p.provider === compareB}>
                  {p.provider}
                </option>
              ))}
            </select>
            <span className="text-slate-500 font-bold text-lg">vs</span>
            <select
              aria-label="Compare provider B"
              value={compareB}
              onChange={(e) => setCompareB(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500 flex-1"
            >
              <option value="">Select Provider B</option>
              {providersList.map(p => (
                <option key={p.provider} value={p.provider} disabled={p.provider === compareA}>
                  {p.provider}
                </option>
              ))}
            </select>
          </div>
          {comparisonData ? (
            <SVGBarChart
              data={comparisonData.metrics} xKey="metric" height={320} horizontal yWidth={120} showLegend
              bars={[
                { dataKey: compareA, color: comparisonData.colorA, name: compareA },
                { dataKey: compareB, color: comparisonData.colorB, name: compareB },
              ]}
            />
          ) : (
            <div className="h-[320px] flex items-center justify-center text-slate-500">
              Select two providers to compare
            </div>
          )}
        </div>
      )}

      {/* Provider list — grouped */}
      {providersList.length === 0 ? (
        <div className="glass-card p-12 text-center mb-8">
          <p className="text-slate-400 text-lg mb-1">No providers configured</p>
          <p className="text-slate-500 text-sm">Submit a task to activate a provider</p>
        </div>
      ) : (
        <div className="glass-card mb-8 overflow-hidden">
          {/* Column headers */}
          <div className="flex items-center gap-4 px-4 py-2 border-b border-slate-700 text-[11px] text-slate-500 uppercase tracking-wider">
            <span className="w-2.5" />
            <span className="w-36">Provider</span>
            <span className="w-2.5" />
            <span className="w-20">Rate</span>
            <span className="w-16 text-right">Tasks</span>
            <span className="w-12 text-right">Avg</span>
            <span className="w-14 text-right">Cost</span>
            <span className="w-[60px]">Trend</span>
            <span className="w-8" />
            <span className="w-3.5" />
          </div>
          {groupProviders(providersList).map((group) => (
            <div key={group.label}>
              <div className="px-4 py-1.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider bg-slate-800/30">
                {group.label}
              </div>
              {group.items.map((provider) => (
                <ProviderRow
                  key={provider.provider}
                  provider={provider}
                  quota={quotas[provider.provider]}
                  sparkData={timeSeries}
                  onToggle={handleToggle}
                  onUpdateConcurrency={handleUpdateConcurrency}
                  onSetApiKey={handleSetApiKey}
                  onClearApiKey={handleClearApiKey}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Usage over time */}
        <div className="glass-card p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Usage Over Time</h3>
          <div role="img" aria-label="Usage over time: total, completed, and failed tasks">
            <SVGLineChart
              data={timeSeries} xKey="date" height={300} formatX={formatDate}
              lines={[
                { dataKey: 'total', color: '#3b82f6', name: 'Total' },
                { dataKey: 'completed', color: '#22c55e', name: 'Completed' },
                { dataKey: 'failed', color: '#ef4444', name: 'Failed' },
              ]}
            />
          </div>
        </div>

        {/* Provider breakdown */}
        <div className="glass-card p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Provider Breakdown</h3>
          {pieData.length > 0 ? (
            <div role="img" aria-label={`Provider task distribution: ${pieData.map(d => `${d.name} ${d.value}`).join(', ')}`}>
              <SVGPieChart
                data={pieData} height={300} innerRadius={60} outerRadius={100}
                showLabels showLegend
                colorFn={(entry) => getProviderColor(entry.name)}
              />
            </div>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-slate-500">
              No data available
            </div>
          )}
        </div>

        {/* Per-provider success rate trend */}
        {activeProviders.length > 0 && trends?.series && (
          <div className="glass-card p-6 lg:col-span-2">
            <h3 className="text-lg font-semibold text-white mb-4">Success Rate by Provider</h3>
            <SVGLineChart
              data={trends.series} xKey="date" height={280}
              yDomain={[0, 100]} formatX={formatDate} formatY={(v) => `${Math.round(v)}%`}
              formatTooltip={(v) => v != null ? `${v}%` : '-'}
              showLegend legendFormatter={(n) => n.replace('_success_rate', '')}
              lines={activeProviders.map((p) => ({
                dataKey: `${p}_success_rate`, color: getProviderColor(p),
                name: `${p}_success_rate`, connectNulls: true,
              }))}
            />
          </div>
        )}

        {/* Per-provider throughput (stacked area) */}
        {activeProviders.length > 0 && trends?.series && (
          <div className="glass-card p-6 lg:col-span-2">
            <h3 className="text-lg font-semibold text-white mb-4">Tasks per Day by Provider</h3>
            <SVGLineChart
              data={trends.series} xKey="date" height={280}
              formatX={formatDate} showLegend
              legendFormatter={(n) => n.replace('_total', '')}
              formatTooltip={(v) => `${v}`}
              lines={activeProviders.map((p) => ({
                dataKey: `${p}_total`, color: getProviderColor(p),
                name: `${p}_total`, fill: true, fillOpacity: 0.3, stackId: 'throughput',
              }))}
            />
          </div>
        )}

        {/* Duration comparison */}
        {durationData.length > 0 && (
          <div className="glass-card p-6 lg:col-span-2">
            <h3 className="text-lg font-semibold text-white mb-4">Average Duration by Provider</h3>
            <SVGBarChart
              data={durationData} xKey="name" height={200} horizontal
              bars={[{
                dataKey: 'duration', name: 'Avg Duration',
                colorFn: (entry) => getProviderColor(entry.name),
              }]}
              formatY={(v) => `${Math.round(v)}s`}
              formatTooltip={(v) => `${v}s`}
            />
          </div>
        )}

        {/* Aggregate success rate trend */}
        <div className="glass-card p-6 lg:col-span-2">
          <h3 className="text-lg font-semibold text-white mb-4">Overall Success Rate Trend</h3>
          <SVGLineChart
            data={timeSeries} xKey="date" height={200}
            yDomain={[0, 100]} formatX={formatDate} formatY={(v) => Math.round(v)}
            formatTooltip={(v) => `${v}%`}
            lines={[{ dataKey: 'success_rate', color: '#22c55e', name: 'Success Rate' }]}
          />
        </div>

        {usageHistory.length > 0 && (
          <div className="glass-card p-6 lg:col-span-2">
            <div className="flex items-center justify-between gap-4 mb-4">
              <h3 className="text-lg font-semibold text-white">7-Day Provider Usage</h3>
              <div className="inline-flex rounded-lg bg-slate-800 p-0.5 border border-slate-700">
                <button
                  type="button"
                  onClick={() => setUsageMetric('requests')}
                  aria-pressed={usageMetric === 'requests'}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    usageMetric === 'requests' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Requests
                </button>
                <button
                  type="button"
                  onClick={() => setUsageMetric('tokens')}
                  aria-pressed={usageMetric === 'tokens'}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    usageMetric === 'tokens' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Tokens
                </button>
              </div>
            </div>
            <SVGLineChart
              data={usageChartData} xKey="date" height={250}
              formatX={formatDate} formatY={(v) => Math.round(v).toLocaleString()}
              formatTooltip={(v) => Number(v || 0).toLocaleString()}
              showLegend
              lines={usageProviderKeys.map((provider) => ({
                dataKey: provider, color: getProviderColor(provider),
                name: provider, fill: true, fillOpacity: 0.3, stackId: 'usage',
              }))}
            />
          </div>
        )}
      </div>
    </div>
  );
}
