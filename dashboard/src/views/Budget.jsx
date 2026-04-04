import { useState, useEffect, useCallback } from 'react';
import { budget as budgetApi } from '../api';
import { useToast } from '../components/Toast';
import StatCard from '../components/StatCard';
import LoadingSkeleton from '../components/LoadingSkeleton';
import { PROVIDER_HEX_COLORS } from '../constants';
import { SVGLineChart, SVGBarChart, SVGPieChart } from '../components/charts';

const SUBSCRIPTION_PROVIDERS = new Set(['codex', 'claude-cli', 'codex-spark']);

function ProgressRing({ percent, size = 80, strokeWidth = 8 }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (Math.min(percent, 100) / 100) * circumference;
  const color = percent >= 100 ? '#ef4444' : percent >= 80 ? '#f59e0b' : '#22c55e';
  const percentage = Math.round(percent);
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="transform -rotate-90" role="progressbar" aria-valuenow={percentage} aria-valuemin={0} aria-valuemax={100} aria-label={`Budget ${percentage}% used`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#334155" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={color} strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-sm font-bold text-white">{Math.round(percent)}%</span>
      </div>
    </div>
  );
}

const TREND_ICONS = {
  increasing: '\u2191',
  decreasing: '\u2193',
  stable: '\u2192',
};

const TREND_COLORS = {
  increasing: 'text-red-400',
  decreasing: 'text-green-400',
  stable: 'text-slate-400',
};

export default function Budget() {
  const [summary, setSummary] = useState(null);
  const [budgetStatus, setBudgetStatus] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState(null);
  const [chartType, setChartType] = useState('bar');
  const [showBudgetForm, setShowBudgetForm] = useState(false);
  const [budgetForm, setBudgetForm] = useState({ budget_usd: '', period: 'monthly', alert_threshold: '80' });
  const [savingBudget, setSavingBudget] = useState(false);
  const toast = useToast();

  const loadData = useCallback(async () => {
    try {
      const [s, b, f] = await Promise.all([
        budgetApi.summary(days),
        budgetApi.status().catch(() => null),
        budgetApi.forecast(days).catch(() => null),
      ]);
      setSummary(s);
      setBudgetStatus(b);
      setForecast(f);
      setApiError(null);
    } catch (err) {
      console.error('Failed to load budget data:', err);
      setApiError(err?.message || 'Failed to load budget data');
      toast.error('Failed to load budget data');
    } finally {
      setLoading(false);
    }
  }, [days, toast]);

  useEffect(() => {
    loadData();
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadData();
    }, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  async function handleSaveBudget(e) {
    e.preventDefault();
    const usd = Number(budgetForm.budget_usd);
    if (!Number.isFinite(usd) || usd <= 0) {
      toast.error('Invalid budget amount');
      return;
    }
    setSavingBudget(true);
    try {
      await budgetApi.set({
        budget_usd: usd,
        period: budgetForm.period,
        alert_threshold: parseInt(budgetForm.alert_threshold) || 80,
      });
      toast.success('Budget updated');
      setShowBudgetForm(false);
      loadData();
    } catch (err) {
      toast.error(`Failed to set budget: ${err.message}`);
    } finally {
      setSavingBudget(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <LoadingSkeleton lines={5} />
      </div>
    );
  }

  // Extract data for charts from summary
  const totalCost = summary?.total_cost ?? summary?.totalCost ?? 0;
  const providerBreakdown = summary?.by_provider || summary?.byProvider || summary?.providers || {};
  const dailyCosts = summary?.daily || summary?.dailyCosts || [];
  const taskCount = summary?.task_count || summary?.taskCount || summary?.total_tasks || 0;

  // Separate subscription providers (flat-rate) from API providers (per-call cost)
  const apiProviderCosts = {};
  const subscriptionProviderTasks = {};
  let apiTaskCount = 0;

  for (const [name, v] of Object.entries(providerBreakdown)) {
    if (SUBSCRIPTION_PROVIDERS.has(name)) {
      subscriptionProviderTasks[name] = typeof v === 'object' ? (v.tasks || v.total_tasks || 0) : 0;
      continue;
    }

    const providerCost = typeof v === 'object' ? (v.cost || v.total_cost || 0) : v;
    apiProviderCosts[name] = providerCost;
    apiTaskCount += typeof v === 'object' ? (Number(v.tasks || v.total_tasks || 0) || 0) : 0;
  }

  // API-only cost (exclude subscription providers from totals)
  const apiCost = Object.values(apiProviderCosts).reduce((s, v) => s + (Number(v) || 0), 0);
  const subscriptionTaskCount = Object.values(subscriptionProviderTasks).reduce((sum, count) => sum + (Number(count) || 0), 0);
  const effectiveApiTaskCount = apiTaskCount > 0 ? apiTaskCount : Math.max(0, taskCount - subscriptionTaskCount);

  const pieData = Object.entries(apiProviderCosts)
    .filter(([_, cost]) => cost > 0)
    .map(([name, cost]) => ({ name, value: cost }));

  const budgetLimit = budgetStatus?.limit || budgetStatus?.budget_limit || 0;
  const budgetUsed = budgetStatus?.used ?? budgetStatus?.budget_used ?? (totalCost || apiCost);
  const budgetPct = budgetLimit > 0 ? Math.round((budgetUsed / budgetLimit) * 100) : 0;

  // Use server-side linear regression forecast when available, fall back to client-side naive avg
  const dailyAvg = forecast?.daily_avg != null
    ? forecast.daily_avg
    : (dailyCosts.length > 0
      ? dailyCosts.reduce((sum, d) => sum + (d.cost || 0), 0) / dailyCosts.length
      : 0);
  const projectedMonthly = forecast?.projected_monthly != null
    ? forecast.projected_monthly
    : dailyAvg * 30;
  const trendDirection = forecast?.trend_direction || 'stable';
  const costPerTask = effectiveApiTaskCount > 0 ? apiCost / effectiveApiTaskCount : 0;

  return (
    <div className="p-6">
      {/* API error indicator */}
      {apiError && (
        <div className="mb-4 flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-950/50 border border-red-600/40 text-red-300 text-sm">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>Budget data unavailable: {apiError}</span>
          <button
            onClick={loadData}
            className="ml-auto text-xs underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}
      {/* Budget alert bar */}
      {budgetLimit > 0 && budgetPct >= 80 && (
        <div className={`mb-4 flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm ${
          budgetPct >= 100
            ? 'bg-red-950/50 border border-red-600/40 text-red-300'
            : 'bg-amber-950/50 border border-amber-600/40 text-amber-300'
        }`}>
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          {budgetPct >= 100
            ? `Budget exceeded! $${Number(budgetUsed).toFixed(2)} of $${Number(budgetLimit).toFixed(2)} used (${budgetPct}%)`
            : `Budget warning: ${budgetPct}% used ($${Number(budgetUsed).toFixed(2)} of $${Number(budgetLimit).toFixed(2)})`
          }
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <h2 className="heading-lg text-white">Budget & Usage</h2>
        <select
          aria-label="Filter budget stats by time range"
          value={days}
          onChange={(e) => { setDays(parseInt(e.target.value)); setLoading(true); }}
          className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
        >
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Total Cost"
          value={`$${Number(apiCost).toFixed(2)}`}
          subtext="API providers only"
          gradient="blue"
          icon="\uD83D\uDCB0"
        />
        <button
          type="button"
          onClick={() => setShowBudgetForm(!showBudgetForm)}
          className="cursor-pointer text-left w-full"
        >
          <StatCard
            label="Budget Used"
            value={budgetLimit > 0 ? `${budgetPct}%` : 'No limit'}
            subtext={budgetLimit > 0 ? `$${Number(budgetUsed).toFixed(2)} / $${Number(budgetLimit).toFixed(2)}` : 'Click to set a budget'}
            gradient={budgetPct > 80 ? 'red' : budgetPct > 50 ? 'orange' : 'green'}
            icon="\uD83D\uDCCA"
          />
        </button>
        <StatCard
          label="Projected Monthly"
          value={`$${projectedMonthly.toFixed(2)}`}
          subtext={`$${dailyAvg.toFixed(2)}/day avg ${TREND_ICONS[trendDirection] || ''} ${trendDirection}`}
          gradient={budgetLimit > 0 && projectedMonthly > budgetLimit ? 'red' : 'cyan'}
          icon="\uD83D\uDCC8"
        />
        <StatCard
          label="Cost per Task"
          value={`$${costPerTask.toFixed(3)}`}
          subtext={`${effectiveApiTaskCount} API tasks`}
          gradient="purple"
          icon="\u2601\uFE0F"
        />
      </div>

      {/* Set Budget form */}
      {showBudgetForm && (
        <form onSubmit={handleSaveBudget} className="glass-card p-6 mb-8 space-y-4">
          <h3 className="text-lg font-semibold text-white">Set Budget</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">{budgetForm.period === 'weekly' ? 'Weekly' : budgetForm.period === 'daily' ? 'Daily' : 'Monthly'} Limit ($)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={budgetForm.budget_usd}
                onChange={(e) => setBudgetForm({ ...budgetForm, budget_usd: e.target.value })}
                placeholder="e.g. 50.00"
                className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Alert Threshold (%)</label>
              <input
                type="number"
                min="1"
                max="100"
                value={budgetForm.alert_threshold}
                onChange={(e) => setBudgetForm({ ...budgetForm, alert_threshold: e.target.value })}
                className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Period</label>
              <select
                value={budgetForm.period}
                onChange={(e) => setBudgetForm({ ...budgetForm, period: e.target.value })}
                className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="monthly">Monthly</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
          </div>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={savingBudget}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg disabled:opacity-50 transition-colors"
            >
              {savingBudget ? 'Saving...' : 'Save Budget'}
            </button>
            <button
              type="button"
              onClick={() => setShowBudgetForm(false)}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Daily cost chart */}
        <div className="glass-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Cost Over Time</h3>
            <div className="flex bg-slate-800 rounded-lg p-0.5">
              <button
                onClick={() => setChartType('bar')}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${chartType === 'bar' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                Bar
              </button>
              <button
                onClick={() => setChartType('line')}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${chartType === 'line' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                Line
              </button>
            </div>
          </div>
          {dailyCosts.length > 0 ? (
            <div role="img" aria-label={`Cost over time chart (${chartType})`}>
              {chartType === 'bar' ? (
                <SVGBarChart
                  data={dailyCosts} xKey="date" height={300}
                  bars={[{ dataKey: 'cost', color: '#3b82f6', name: 'Daily Cost' }]}
                  formatX={(d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  formatY={(v) => `$${Math.round(v)}`}
                  formatTooltip={(v) => `$${Number(v).toFixed(2)}`}
                />
              ) : (
                <SVGLineChart
                  data={dailyCosts} xKey="date" height={300}
                  lines={[{ dataKey: 'cost', color: '#3b82f6', name: 'Daily Cost' }]}
                  formatX={(d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  formatY={(v) => `$${Math.round(v)}`}
                  formatTooltip={(v) => `$${Number(v).toFixed(2)}`}
                />
              )}
            </div>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-slate-500">
              No daily cost data available
            </div>
          )}
        </div>

        {/* Provider breakdown pie */}
        <div className="glass-card p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Provider Breakdown</h3>
          {pieData.length > 0 ? (
            <div role="img" aria-label={`Provider cost breakdown: ${pieData.map(d => `${d.name} $${Number(d.value).toFixed(2)}`).join(', ')}`}>
              <SVGPieChart
                data={pieData} height={300} innerRadius={60} outerRadius={100}
                showLabels showLegend
                colorFn={(entry) => PROVIDER_HEX_COLORS[entry.name] || '#6b7280'}
                formatTooltip={(v) => `$${Number(v).toFixed(2)}`}
              />
            </div>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-slate-500">
              No provider cost data
            </div>
          )}
        </div>
      </div>

      {/* Subscription Providers */}
      {Object.keys(subscriptionProviderTasks).length > 0 && (
        <div className="glass-card p-6 mt-6">
          <h3 className="text-lg font-semibold text-white mb-4">Subscription Providers</h3>
          <p className="text-xs text-slate-500 mb-4">Flat-rate subscriptions - cost not tracked per task</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {Object.entries(subscriptionProviderTasks).map(([name, tasks]) => (
              <div key={name} className="flex items-center justify-between p-3 bg-slate-700/30 rounded-lg border border-slate-700/50">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: PROVIDER_HEX_COLORS[name] || '#6b7280' }} />
                  <span className="text-sm font-medium text-white capitalize">{name}</span>
                </div>
                <div className="text-right">
                  <span className="text-sm text-white font-medium">{tasks} tasks</span>
                  <span className="text-xs text-slate-500 ml-2">subscription</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Budget progress */}
      {budgetLimit > 0 && (
        <div className="glass-card p-6 mt-6">
          <h3 className="text-lg font-semibold text-white mb-4">Budget Progress</h3>
          <div className="flex items-center gap-8">
            <ProgressRing percent={budgetPct} size={100} strokeWidth={10} />
            <div className="flex-1 grid grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-slate-400">Spent</p>
                <p className="text-xl font-bold text-white">${Number(budgetUsed).toFixed(2)}</p>
              </div>
              <div>
                <p className="text-sm text-slate-400">Budget</p>
                <p className="text-xl font-bold text-white">${Number(budgetLimit).toFixed(2)}</p>
              </div>
              <div>
                <p className="text-sm text-slate-400">Remaining</p>
                <p className={`text-xl font-bold ${budgetPct >= 100 ? 'text-red-400' : 'text-green-400'}`}>
                  ${Math.max(0, budgetLimit - budgetUsed).toFixed(2)}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
