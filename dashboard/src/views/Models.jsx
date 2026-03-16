import { useState, useEffect } from 'react';
import { stats as statsApi } from '../api';
import StatCard from '../components/StatCard';
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

// Distinct colors for up to 12 models
const MODEL_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899',
  '#14b8a6', '#f97316', '#06b6d4', '#a855f7', '#84cc16', '#6366f1',
];

function getModelColor(idx) {
  return MODEL_COLORS[idx % MODEL_COLORS.length];
}

function formatDuration(seconds) {
  if (seconds == null) return '-';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(typeof dateStr === 'string' && dateStr.length === 10 ? dateStr + 'T12:00:00' : dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const tooltipStyle = {
  contentStyle: { backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' },
  labelStyle: { color: '#94a3b8' },
};

export default function Models() {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    statsApi.models(days).then(d => {
      if (!cancelled) { setData(d); setLoading(false); }
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  if (loading) return <div className="p-6 text-slate-400">Loading model stats...</div>;
  if (!data || !data.models?.length) return <div className="p-6 text-slate-400">No model data for the last {days} days.</div>;

  const { models, dailySeries } = data;

  // Summary stats
  const totalTasks = models.reduce((s, m) => s + m.total, 0);
  const totalCompleted = models.reduce((s, m) => s + m.completed, 0);
  const overallSuccessRate = totalTasks > 0 ? Math.round(totalCompleted / totalTasks * 100) : 0;
  const totalCost = models.reduce((s, m) => s + (m.total_cost || 0), 0);
  // const topModel = models[0]; // unused, available for future use

  // Build chart data: success rate comparison (bar chart)
  const successData = models
    .filter(m => m.total >= 2)
    .sort((a, b) => b.success_rate - a.success_rate)
    .map(m => ({
      name: m.model.length > 20 ? m.model.slice(0, 18) + '..' : m.model,
      fullName: m.model,
      'Success %': m.success_rate,
      'Tasks': m.total,
    }));

  // Build chart data: daily tasks per model (line chart)
  const modelNames = [...new Set(dailySeries.map(d => d.model))].slice(0, 8);
  const dateMap = {};
  for (const row of dailySeries) {
    if (!dateMap[row.date]) dateMap[row.date] = { date: row.date };
    dateMap[row.date][row.model] = row.total;
  }
  const dailyData = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Models</h1>
        <div className="flex items-center gap-2">
          {[7, 14, 30].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-3 py-1 rounded text-sm ${days === d ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Tasks" value={totalTasks} />
        <StatCard label="Success Rate" value={`${overallSuccessRate}%`} />
        <StatCard label="Models Used" value={models.length} />
        <StatCard label="Est. Cost" value={`$${totalCost.toFixed(3)}`} />
      </div>

      {/* Model Performance Table */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">Per-Model Breakdown</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-400 text-left border-b border-slate-700">
                <th className="px-4 py-2">Model</th>
                <th className="px-4 py-2 text-right">Tasks</th>
                <th className="px-4 py-2 text-right">Success</th>
                <th className="px-4 py-2 text-right">Failed</th>
                <th className="px-4 py-2 text-right">Rate</th>
                <th className="px-4 py-2 text-right">Avg Duration</th>
                <th className="px-4 py-2 text-right">Cost</th>
                <th className="px-4 py-2">Providers</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m, i) => (
                <tr key={m.model} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                  <td className="px-4 py-2 font-medium text-white flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: getModelColor(i) }} />
                    {m.model}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-300">{m.total}</td>
                  <td className="px-4 py-2 text-right text-green-400">{m.completed}</td>
                  <td className="px-4 py-2 text-right text-red-400">{m.failed}</td>
                  <td className="px-4 py-2 text-right">
                    <span className={m.success_rate >= 80 ? 'text-green-400' : m.success_rate >= 50 ? 'text-yellow-400' : 'text-red-400'}>
                      {m.success_rate}%
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right text-slate-300">{formatDuration(m.avg_duration_seconds)}</td>
                  <td className="px-4 py-2 text-right text-slate-300">${(m.total_cost || 0).toFixed(3)}</td>
                  <td className="px-4 py-2 text-slate-400 text-xs">{m.providers.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Success Rate Comparison */}
        {successData.length > 0 && (
          <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
            <h3 className="text-white font-medium mb-4">Success Rate by Model</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={successData} layout="vertical" margin={{ left: 10, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis type="number" domain={[0, 100]} tick={{ fill: '#94a3b8', fontSize: 12 }} />
                <YAxis type="category" dataKey="name" width={140} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                <Tooltip {...tooltipStyle}
                  formatter={(value, name, props) => [`${value}% (${props.payload.Tasks} tasks)`, name]} />
                <Bar dataKey="Success %" fill="#3b82f6" radius={[0, 4, 4, 0]}>
                  {successData.map((_, i) => {
                    const rate = successData[i]['Success %'];
                    return <rect key={i} fill={rate >= 80 ? '#22c55e' : rate >= 50 ? '#f59e0b' : '#ef4444'} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Daily Tasks per Model */}
        {dailyData.length > 0 && (
          <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
            <h3 className="text-white font-medium mb-4">Tasks per Day by Model</h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="date" tickFormatter={formatDate} tick={{ fill: '#94a3b8', fontSize: 12 }} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} />
                <Tooltip {...tooltipStyle} labelFormatter={formatDate} />
                <Legend />
                {modelNames.map((name, i) => (
                  <Line key={name} type="monotone" dataKey={name}
                    stroke={getModelColor(i)} strokeWidth={2} dot={false}
                    connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
