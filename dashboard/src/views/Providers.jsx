import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { providers as providersApi, stats as statsApi, hosts as hostsApi, concurrency, providerCrud, requestV2 } from '../api';
import { useToast } from '../components/Toast';
import StatCard from '../components/StatCard';
import { PROVIDER_HEX_COLORS } from '../constants';
import { formatDate } from '../utils/formatters';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';

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
  { label: 'Local (Ollama)', providers: new Set(['ollama', 'hashline-ollama', 'aider-ollama']) },
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

function ProviderCard({ provider, sparkData, onToggle, onUpdateConcurrency, onSetApiKey, onClearApiKey }) {
  const color = getProviderColor(provider.provider);
  const dailyCounts = sparkData?.map((d) => d[provider.provider] || 0) || [];
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyValue, setKeyValue] = useState('');
  const [keyLoading, setKeyLoading] = useState(false);
  const isCloudProvider = CLOUD_API_PROVIDERS.has(provider.provider) ||
    provider.provider_type === 'cloud-api' || provider.provider_type === 'custom';
  const envVarName = ENV_VAR_NAMES[provider.provider] || '';

  return (
    <div className="glass-card p-5 card-hover">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
          <h3 className="text-lg font-semibold text-white">{provider.provider}</h3>
          <Sparkline data={dailyCounts} color={color} />
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onToggle?.(provider.provider, !provider.enabled); }}
          className={`relative w-9 h-5 rounded-full transition-colors ${provider.enabled ? 'bg-green-600' : 'bg-slate-600'}`}
          title={provider.enabled ? 'Disable provider' : 'Enable provider'}
          aria-label={provider.enabled ? `Disable ${provider.provider}` : `Enable ${provider.provider}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${provider.enabled ? 'left-[18px]' : 'left-0.5'}`} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800/40 rounded-lg p-3">
          <p className="text-slate-500 text-xs mb-1">Total Tasks</p>
          <p className="text-xl font-bold text-white">{provider.stats?.total_tasks || 0}</p>
          <div className="flex items-center gap-2 mt-1 text-[10px]">
            <span className="text-green-400">{provider.stats?.completed_tasks || 0} passed</span>
            <span className="text-red-400">{provider.stats?.failed_tasks || 0} failed</span>
          </div>
        </div>
        <div className="bg-slate-800/40 rounded-lg p-3">
          <p className="text-slate-500 text-xs mb-1">Success Rate</p>
          <p className="text-xl font-bold text-white">{provider.stats?.success_rate || 0}%</p>
          <div className="h-1 bg-slate-700 rounded-full mt-2 overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all"
              style={{ width: `${provider.stats?.success_rate || 0}%` }}
            />
          </div>
        </div>
        <div className="bg-slate-800/40 rounded-lg p-3">
          <p className="text-slate-500 text-xs mb-1">Avg Duration</p>
          <p className="text-xl font-bold text-white">
            {provider.stats?.avg_duration_seconds
              ? `${Math.round(provider.stats.avg_duration_seconds)}s`
              : 'N/A'}
          </p>
        </div>
        <div className="bg-slate-800/40 rounded-lg p-3">
          <p className="text-slate-500 text-xs mb-1">Est. Cost</p>
          <p className="text-xl font-bold text-white">
            {provider.stats?.total_cost != null
              ? `$${Number(provider.stats.total_cost).toFixed(2)}`
              : 'N/A'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <span className="text-xs text-slate-400">Max Concurrent:</span>
        <input
          type="number"
          min={1}
          max={100}
          defaultValue={provider.max_concurrent || 1}
          onBlur={(e) => {
            const val = parseInt(e.target.value);
            if (val >= 1 && val <= 100 && val !== provider.max_concurrent) {
              onUpdateConcurrency(provider.provider, val);
            }
          }}
          className="w-16 px-2 py-1 text-sm bg-slate-800 border border-slate-600 rounded text-white"
        />
      </div>
      {/* API Key Management */}
      {isCloudProvider && (
        <div className="mt-3 pt-3 border-t border-slate-700/50">
          {provider.api_key_status === 'env' && (
            <div className="flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              <span className="text-xs text-green-400">Set via environment</span>
              <code className="text-[10px] text-slate-500 ml-1">{envVarName}</code>
            </div>
          )}
          {provider.api_key_status === 'stored' && !showKeyInput && (
            <div className="flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              <span className="text-xs text-slate-400 font-mono">{provider.api_key_masked || '\u2022\u2022\u2022\u2022\u2022\u2022'}</span>
              <button onClick={() => setShowKeyInput(true)} className="text-xs text-blue-400 hover:text-blue-300 ml-auto">Change</button>
              <button onClick={async () => { await onClearApiKey?.(provider.provider); }} className="text-xs text-red-400 hover:text-red-300">Remove</button>
            </div>
          )}
          {provider.api_key_status === 'validating' && (
            <div className="flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-amber-400 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span className="text-xs text-amber-400">Validating key...</span>
            </div>
          )}
          {(provider.api_key_status === 'not_set' && !showKeyInput) && (
            <div className="flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              <span className="text-xs text-slate-500">No API key</span>
              <button onClick={() => setShowKeyInput(true)} className="text-xs text-blue-400 hover:text-blue-300 ml-auto">Add Key</button>
            </div>
          )}
          {showKeyInput && (
            <div className="flex items-center gap-2">
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
  );
}

const tooltipStyle = {
  contentStyle: { backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' },
  labelStyle: { color: '#f1f5f9' },
};

export default function Providers({ statsVersion, tasksTick }) {
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [providersList, setProvidersList] = useState([]);
  const [timeSeries, setTimeSeries] = useState([]);
  const [trends, setTrends] = useState(null);
  const [hostCount, setHostCount] = useState(0);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('overview'); // 'overview' | 'compare'
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');
  const [codexExhausted, setCodexExhausted] = useState(false);
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

  const handleRemoveProvider = async (name) => {
    if (!window.confirm(`Remove provider '${name}'? This cannot be undone.`)) return;
    try {
      await providerCrud.remove(name, true);
      addToast.success(`Provider '${name}' removed`);
      loadData();
    } catch (err) {
      addToast.error(`Failed: ${err.message}`);
    }
  };

  const loadData = useCallback(async () => {
    try {
      const [providersData, timeSeriesData, hostsData, trendsData, codexCfg] = await Promise.all([
        providersApi.list(),
        statsApi.timeseries({ days }),
        hostsApi.list().catch(() => []),
        providersApi.trends(days).catch(() => null),
        requestV2('/config/codex_exhausted').catch(() => null),
      ]);
      setProvidersList(providersData);
      setTimeSeries(timeSeriesData);
      setHostCount(Array.isArray(hostsData) ? hostsData.length : 0);
      setTrends(trendsData);
      setCodexExhausted(codexCfg?.value === '1' || codexCfg === '1');
    } catch (err) {
      console.error('Failed to load provider data:', err);
      addToast.error('Failed to load provider data');
    } finally {
      setLoading(false);
    }
  }, [days, addToast]);

  // Refetch when statsVersion or tasksTick changes (WebSocket push) or days filter changes
  useEffect(() => {
    loadData();
  }, [days, statsVersion, tasksTick, loadData]);

  // Fallback polling at 120s in case WebSocket is disconnected
  useEffect(() => {
    const pollInterval = setInterval(loadData, 120000);
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
      await providersApi.setApiKey(providerName, apiKey);
      addToast.success('API key saved — validating...');
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
      await providersApi.clearApiKey(providerName);
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
  const avgSuccessRate = providersList.length > 0
    ? Math.round(providersList.reduce((s, p) => s + (p.stats?.success_rate || 0), 0) / providersList.length)
    : 0;

  // Filter providers with actual data for trend charts
  const activeProviders = trends?.providers?.filter(p =>
    trends.series.some(d => (d[`${p}_total`] || 0) > 0)
  ) || [];

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
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-slate-400">Loading...</p>
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
              <label className="text-xs text-slate-400 block mb-1">Name</label>
              <input value={newProvider.name} onChange={e => setNewProvider({...newProvider, name: e.target.value})} className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm" placeholder="my-provider" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Type</label>
              <select value={newProvider.provider_type} onChange={e => setNewProvider({...newProvider, provider_type: e.target.value})} className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm">
                <option value="ollama">Ollama</option>
                <option value="cloud-api">Cloud API</option>
                <option value="cloud-cli">Cloud CLI</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">API Base URL</label>
              <input value={newProvider.api_base_url} onChange={e => setNewProvider({...newProvider, api_base_url: e.target.value})} placeholder="https://api.example.com/v1" className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Max Concurrent</label>
              <input type="number" value={newProvider.max_concurrent} onChange={e => setNewProvider({...newProvider, max_concurrent: parseInt(e.target.value) || 3})} className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm" />
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
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={comparisonData.metrics} layout="vertical" barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 12 }} />
                <YAxis type="category" dataKey="metric" tick={{ fill: '#94a3b8', fontSize: 12 }} width={120} />
                <Tooltip {...tooltipStyle} />
                <Legend />
                <Bar dataKey={compareA} fill={comparisonData.colorA} radius={[0, 4, 4, 0]} barSize={16} />
                <Bar dataKey={compareB} fill={comparisonData.colorB} radius={[0, 4, 4, 0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[320px] flex items-center justify-center text-slate-500">
              Select two providers to compare
            </div>
          )}
        </div>
      )}

      {/* Provider cards — grouped */}
      {providersList.length === 0 ? (
        <div className="glass-card p-12 text-center mb-8">
          <svg className="w-12 h-12 text-slate-600 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <p className="text-slate-400 text-lg mb-1">No providers configured</p>
          <p className="text-slate-500 text-sm">Submit a task to activate a provider</p>
        </div>
      ) : (
        <div className="mb-8 space-y-6">
          {groupProviders(providersList).map((group) => (
            <div key={group.label}>
              <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3 pb-2 border-b border-slate-700/50">
                {group.label}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {group.items.map((provider) => (
                  <ProviderCard
                    key={provider.provider}
                    provider={provider}
                    sparkData={timeSeries}
                    onToggle={handleToggle}
                    onUpdateConcurrency={handleUpdateConcurrency}
                    onSetApiKey={handleSetApiKey}
                    onClearApiKey={handleClearApiKey}
                  />
                ))}
              </div>
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
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={timeSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 12 }} tickFormatter={formatDate} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} />
              <Tooltip {...tooltipStyle} />
              <Line type="monotone" dataKey="total" stroke="#3b82f6" strokeWidth={2} dot={false} name="Total" />
              <Line type="monotone" dataKey="completed" stroke="#22c55e" strokeWidth={2} dot={false} name="Completed" />
              <Line type="monotone" dataKey="failed" stroke="#ef4444" strokeWidth={2} dot={false} name="Failed" />
            </LineChart>
          </ResponsiveContainer>
          </div>
        </div>

        {/* Provider breakdown */}
        <div className="glass-card p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Provider Breakdown</h3>
          {pieData.length > 0 ? (
            <div role="img" aria-label={`Provider task distribution: ${pieData.map(d => `${d.name} ${d.value}`).join(', ')}`}>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={5}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                >
                  {pieData.map((entry, index) => (
                    <Cell key={index} fill={getProviderColor(entry.name)} />
                  ))}
                </Pie>
                <Tooltip {...tooltipStyle} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
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
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={trends.series}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 12 }} tickFormatter={formatDate} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                <Tooltip
                  {...tooltipStyle}
                  formatter={(value, name) => {
                    const provider = name.replace('_success_rate', '');
                    return value != null ? [`${value}%`, provider] : ['-', provider];
                  }}
                  labelFormatter={formatDate}
                />
                <Legend formatter={(value) => value.replace('_success_rate', '')} />
                {activeProviders.map((p) => (
                  <Line
                    key={p}
                    type="monotone"
                    dataKey={`${p}_success_rate`}
                    stroke={getProviderColor(p)}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                    name={`${p}_success_rate`}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Per-provider throughput (stacked area) */}
        {activeProviders.length > 0 && trends?.series && (
          <div className="glass-card p-6 lg:col-span-2">
            <h3 className="text-lg font-semibold text-white mb-4">Tasks per Day by Provider</h3>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={trends.series}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 12 }} tickFormatter={formatDate} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} />
                <Tooltip
                  {...tooltipStyle}
                  formatter={(value, name) => [value, name.replace('_total', '')]}
                  labelFormatter={formatDate}
                />
                <Legend formatter={(value) => value.replace('_total', '')} />
                {activeProviders.map((p) => (
                  <Area
                    key={p}
                    type="monotone"
                    dataKey={`${p}_total`}
                    stackId="throughput"
                    stroke={getProviderColor(p)}
                    fill={getProviderColor(p)}
                    fillOpacity={0.3}
                    name={`${p}_total`}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Duration comparison */}
        {durationData.length > 0 && (
          <div className="glass-card p-6 lg:col-span-2">
            <h3 className="text-lg font-semibold text-white mb-4">Average Duration by Provider</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={durationData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 12 }} tickFormatter={(v) => `${v}s`} />
                <YAxis type="category" dataKey="name" tick={{ fill: '#94a3b8', fontSize: 12 }} width={100} />
                <Tooltip {...tooltipStyle} formatter={(v) => [`${v}s`, 'Avg Duration']} />
                <Bar dataKey="duration" radius={[0, 4, 4, 0]}>
                  {durationData.map((entry, i) => (
                    <Cell key={i} fill={getProviderColor(entry.name)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Aggregate success rate trend */}
        <div className="glass-card p-6 lg:col-span-2">
          <h3 className="text-lg font-semibold text-white mb-4">Overall Success Rate Trend</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={timeSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 12 }} tickFormatter={formatDate} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} domain={[0, 100]} />
              <Tooltip {...tooltipStyle} formatter={(value) => [`${value}%`, 'Success Rate']} />
              <Line type="monotone" dataKey="success_rate" stroke="#22c55e" strokeWidth={2} dot={false} name="Success Rate" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
