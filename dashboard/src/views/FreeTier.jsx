import { useState, useEffect, useCallback, useMemo } from 'react';
import { freeTier as freeTierApi } from '../api';
import StatCard from '../components/StatCard';
import { PROVIDER_HEX_COLORS } from '../constants';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

const SERIES_COLORS = [
  PROVIDER_HEX_COLORS.codex,
  PROVIDER_HEX_COLORS.ollama,
  PROVIDER_HEX_COLORS.anthropic,
  PROVIDER_HEX_COLORS['claude-cli'],
  PROVIDER_HEX_COLORS.groq,
  PROVIDER_HEX_COLORS.cerebras,
  '#ef4444',
  '#84cc16',
];

function getProviderColor(index) {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

function UsageBar({ used, limit, label, color = 'blue' }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const colorMap = {
    blue: { bar: 'bg-blue-500', text: 'text-blue-400' },
    green: { bar: 'bg-green-500', text: 'text-green-400' },
    amber: { bar: 'bg-amber-500', text: 'text-amber-400' },
    red: { bar: 'bg-red-500', text: 'text-red-400' },
  };
  const c = colorMap[pct > 80 ? 'red' : pct > 50 ? 'amber' : color] || colorMap.blue;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-slate-400">{label}</span>
        <span className={`text-xs font-mono ${c.text}`}>
          {used.toLocaleString()} / {limit.toLocaleString()}
        </span>
      </div>
      <div className="h-2 bg-slate-700/50 rounded-full overflow-hidden">
        <div
          className={`h-full ${c.bar} rounded-full transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function CooldownBadge({ seconds }) {
  if (!seconds || seconds <= 0) return null;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-red-500/20 text-red-400 text-xs font-medium">
      <svg className="w-3 h-3 animate-pulse" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
      </svg>
      Cooldown {mins > 0 ? `${mins}m ` : ''}{secs}s
    </span>
  );
}

function ProviderCard({ name, data }) {
  const onCooldown = data.cooldown_remaining_seconds > 0;

  return (
    <div className={`glass-card p-5 ${onCooldown ? 'border-red-500/30' : ''}`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-white font-semibold capitalize">{name}</h3>
        <CooldownBadge seconds={data.cooldown_remaining_seconds} />
        {!onCooldown && (
          <span className="px-2 py-1 rounded-full bg-green-500/20 text-green-400 text-xs font-medium">
            Available
          </span>
        )}
      </div>

      <div className="space-y-3">
        <UsageBar
          used={data.minute_requests || 0}
          limit={data.rpm_limit || 0}
          label="Requests / Minute"
          color="blue"
        />
        <UsageBar
          used={data.daily_requests || 0}
          limit={data.rpd_limit || 0}
          label="Requests / Day"
          color="green"
        />
        <UsageBar
          used={data.minute_tokens || 0}
          limit={data.tpm_limit || 0}
          label="Tokens / Minute"
          color="blue"
        />
        <UsageBar
          used={data.daily_tokens || 0}
          limit={data.tpd_limit || 0}
          label="Tokens / Day"
          color="green"
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-slate-400">
        <div>
          <span className="block text-slate-500">Minute resets in</span>
          <span className="text-slate-300">{data.minute_resets_in_seconds || 0}s</span>
        </div>
        <div>
          <span className="block text-slate-500">Daily resets in</span>
          <span className="text-slate-300">{formatDuration(data.daily_resets_in_seconds || 0)}</span>
        </div>
      </div>
    </div>
  );
}

function formatDuration(totalSeconds) {
  if (totalSeconds <= 0) return '0s';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

const CHART_METRICS = {
  requests: { field: 'total_requests', label: 'Requests', yAxisLabel: 'Requests' },
  tokens: { field: 'total_tokens', label: 'Tokens', yAxisLabel: 'Tokens' },
};

/**
 * Transform flat history rows into chart-friendly data:
 * [{ date: '2026-03-01', groq: 12, cerebras: 5, ... }, ...]
 *
 * @param {Array} history - raw history rows from API
 * @param {'requests'|'tokens'} metric - which field to aggregate
 */
function buildChartData(history, metric = 'requests') {
  if (!history || history.length === 0) return { chartData: [], providerKeys: [] };

  const fieldName = CHART_METRICS[metric]?.field || 'total_requests';
  const byDate = {};
  const providerSet = new Set();

  for (const row of history) {
    providerSet.add(row.provider);
    if (!byDate[row.date]) {
      byDate[row.date] = { date: row.date };
    }
    byDate[row.date][row.provider] = row[fieldName] || 0;
  }

  const providerKeys = [...providerSet].sort();
  const chartData = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

  // Ensure all providers have values for every date (default 0)
  for (const entry of chartData) {
    for (const p of providerKeys) {
      if (entry[p] === undefined) entry[p] = 0;
    }
  }

  return { chartData, providerKeys };
}

function ChartMetricToggle({ metric, onChange }) {
  return (
    <div className="inline-flex rounded-lg bg-slate-700 p-0.5" role="tablist" aria-label="Chart metric">
      <button
        role="tab"
        aria-selected={metric === 'requests'}
        className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
          metric === 'requests'
            ? 'bg-blue-500 text-white'
            : 'text-slate-400 hover:text-slate-200'
        }`}
        onClick={() => onChange('requests')}
      >
        Requests
      </button>
      <button
        role="tab"
        aria-selected={metric === 'tokens'}
        className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
          metric === 'tokens'
            ? 'bg-blue-500 text-white'
            : 'text-slate-400 hover:text-slate-200'
        }`}
        onClick={() => onChange('tokens')}
      >
        Tokens
      </button>
    </div>
  );
}

export default function FreeTier() {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chartMetric, setChartMetric] = useState('requests');

  const loadData = useCallback(async () => {
    try {
      const [statusResult, historyResult] = await Promise.all([
        freeTierApi.status(),
        freeTierApi.history(7).catch(() => ({ history: [] })),
      ]);
      setData(statusResult);
      setHistory(historyResult.history || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, [loadData]);

  const { chartData, providerKeys } = useMemo(
    () => buildChartData(history, chartMetric),
    [history, chartMetric],
  );

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
          <p className="text-red-400 mb-2">Failed to load free-tier status</p>
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

  const providers = data?.providers || {};
  const providerNames = Object.keys(providers);
  const activeCount = providerNames.filter((n) => providers[n].cooldown_remaining_seconds <= 0).length;
  const onCooldownCount = providerNames.length - activeCount;
  const totalDailyRequests = providerNames.reduce((sum, n) => sum + (providers[n].daily_requests || 0), 0);

  const metricConfig = CHART_METRICS[chartMetric];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="heading-lg text-white">Free Tier Quotas</h2>
          <p className="text-sm text-slate-400 mt-1">
            Overflow providers for when Codex slots are full
          </p>
        </div>
        <button
          onClick={loadData}
          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Providers" value={providerNames.length} gradient="blue" />
        <StatCard label="Available" value={activeCount} gradient="green" />
        <StatCard label="On Cooldown" value={onCooldownCount} gradient={onCooldownCount > 0 ? 'red' : 'slate'} />
        <StatCard label="Daily Requests" value={totalDailyRequests} gradient="purple" />
      </div>

      {/* Provider cards */}
      {providerNames.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <p className="text-slate-400">No free-tier providers configured.</p>
          <p className="text-slate-500 text-sm mt-1">
            Free-tier providers (Groq, Cerebras, Google AI, OpenRouter) are used as overflow when Codex slots are full.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {providerNames.map((name) => (
            <ProviderCard key={name} name={name} data={providers[name]} />
          ))}
        </div>
      )}

      {/* 7-day usage history chart */}
      <div className="glass-card p-6 mt-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">7-Day Usage History</h3>
          <ChartMetricToggle metric={chartMetric} onChange={setChartMetric} />
        </div>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis
                dataKey="date"
                tick={{ fill: '#94a3b8', fontSize: 12 }}
                tickFormatter={(d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              />
              <YAxis
                tick={{ fill: '#94a3b8', fontSize: 12 }}
                allowDecimals={false}
                label={{
                  value: metricConfig.yAxisLabel,
                  angle: -90,
                  position: 'insideLeft',
                  style: { fill: '#94a3b8', fontSize: 12 },
                }}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                labelStyle={{ color: '#f1f5f9' }}
                labelFormatter={(d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                formatter={(value, name) => [value.toLocaleString(), name]}
              />
              <Legend
                wrapperStyle={{ color: '#94a3b8', fontSize: 12 }}
              />
              {providerKeys.map((provider, idx) => (
                <Area
                  key={provider}
                  type="monotone"
                  dataKey={provider}
                  stackId={chartMetric}
                  stroke={getProviderColor(idx)}
                  fill={getProviderColor(idx)}
                  fillOpacity={0.3}
                  strokeWidth={2}
                  name={provider}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[300px] flex items-center justify-center text-slate-500">
            No usage history data yet. Snapshots are recorded when daily quotas reset.
          </div>
        )}
      </div>
    </div>
  );
}
