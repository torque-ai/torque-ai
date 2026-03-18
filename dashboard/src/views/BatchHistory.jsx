import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { workflows as workflowsApi } from '../api';
import { useToast } from '../components/Toast';
import { useAbortableRequest } from '../hooks/useAbortableRequest';
import { getRelevantModel } from '../utils/providerModels';
import { formatDuration } from '../utils/formatters';
import { formatDistanceToNow } from 'date-fns';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

const STATUS_COLORS = {
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  running: 'bg-blue-500',
  pending: 'bg-slate-500',
  cancelled: 'bg-orange-500',
  paused: 'bg-yellow-500',
};

const TASK_STATUS_ICONS = {
  completed: { icon: '\u2713', color: 'text-green-400' },
  failed: { icon: '\u2717', color: 'text-red-400' },
  running: { icon: '\u25CB', color: 'text-blue-400 animate-pulse' },
  pending: { icon: '\u25CB', color: 'text-slate-500' },
  skipped: { icon: '\u25CB', color: 'text-slate-600' },
  cancelled: { icon: '\u25CB', color: 'text-orange-400' },
};

function StatusBadge({ status }) {
  return (
    <span className={`px-2 py-1 rounded-full text-[11px] font-medium text-white ${STATUS_COLORS[status] || 'bg-gray-500'}`}>
      {status}
    </span>
  );
}

function formatCost(usd) {
  if (!usd || usd === 0) return '-';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function SummaryCard({ label, value, subtext, color }) {
  return (
    <div className="glass-card p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color || 'text-white'}`}>{value}</p>
      {subtext && <p className="text-xs text-slate-400 mt-1">{subtext}</p>}
    </div>
  );
}

function SortHeader({ column, label, sortCol, sortDir, onSort }) {
  const active = sortCol === column;
  return (
    <th
      className="text-left p-4 heading-sm cursor-pointer select-none hover:text-white transition-colors group"
      onClick={() => onSort(column)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-[10px] ${active ? 'text-blue-400' : 'text-slate-600 opacity-0 group-hover:opacity-100'} transition-opacity`}>
          {active ? (sortDir === 'asc' ? '\u25B2' : '\u25BC') : '\u25B2'}
        </span>
      </span>
    </th>
  );
}

function TaskBreakdownRow({ task, onOpenDrawer, now }) {
  const statusInfo = TASK_STATUS_ICONS[task.status] || TASK_STATUS_ICONS.pending;
  const duration = task.completed_at && task.started_at
    ? (new Date(task.completed_at) - new Date(task.started_at)) / 1000
    : task.status === 'running' && task.started_at
      ? (now - new Date(task.started_at).getTime()) / 1000
      : null;

  return (
    <tr
      className="border-b border-slate-700/20 hover:bg-slate-700/20 cursor-pointer transition-colors"
      onClick={() => onOpenDrawer?.(task.id)}
    >
      <td className="px-6 py-2">
        <span className={`font-mono text-sm ${statusInfo.color}`}>{statusInfo.icon}</span>
      </td>
      <td className="px-4 py-2 text-sm text-slate-300">
        {task.node_id || task.description?.substring(0, 40) || task.task_description?.substring(0, 40) || task.id}
      </td>
      <td className="px-4 py-2">
        <StatusBadge status={task.status} />
      </td>
      <td className="px-4 py-2">
        {task.provider ? (
          <span className={`px-2 py-1 rounded text-[11px] ${
            task.provider === 'claude-cli' ? 'bg-purple-600/30 text-purple-300'
              : task.provider === 'codex' ? 'bg-blue-600/30 text-blue-300'
                : 'bg-teal-600/30 text-teal-300'
          }`}>
            {task.provider}
          </span>
        ) : <span className="text-slate-600">-</span>}
      </td>
      <td className="px-4 py-2">
        {getRelevantModel(task.provider, task.model) ? (
          <span className="px-2 py-1 rounded text-[11px] bg-indigo-600/30 text-indigo-300">
            {getRelevantModel(task.provider, task.model)}
          </span>
        ) : <span className="text-slate-600">-</span>}
      </td>
      <td className="px-4 py-2 text-sm font-mono text-slate-300">
        {duration != null ? formatDuration(duration) : '-'}
      </td>
    </tr>
  );
}

function ExpandedWorkflow({ workflowId, onOpenDrawer, now }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    workflowsApi.get(workflowId).then((data) => {
      if (!cancelled) setDetail(data);
    }).catch(() => {}).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [workflowId]);

  if (loading) {
    return (
      <tr>
        <td colSpan={7} className="p-4">
          <div className="flex items-center gap-2 text-slate-400 text-sm">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            Loading workflow details...
          </div>
        </td>
      </tr>
    );
  }

  if (!detail) return null;

  // Extract tasks from the workflow status response
  const tasks = detail.tasks
    ? (Array.isArray(detail.tasks) ? detail.tasks : Object.values(detail.tasks))
    : [];

  return (
    <tr>
      <td colSpan={7} className="p-0">
        <div className="bg-slate-800/40 border-t border-b border-slate-700/30 px-4 py-3">
          <div className="flex items-center gap-3 mb-3">
            <h4 className="text-sm font-medium text-white">Task Breakdown</h4>
            {detail.cost && detail.cost.total_cost_usd > 0 && (
              <span className="text-xs text-slate-400">
                Total cost: {formatCost(detail.cost.total_cost_usd)}
              </span>
            )}
          </div>
          {tasks.length > 0 ? (
            <table className="w-full">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="px-6 py-1 text-left w-8"></th>
                  <th className="px-4 py-1 text-left">Node</th>
                  <th className="px-4 py-1 text-left">Status</th>
                  <th className="px-4 py-1 text-left">Provider</th>
                  <th className="px-4 py-1 text-left">Model</th>
                  <th className="px-4 py-1 text-left">Duration</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <TaskBreakdownRow key={task.id || task.node_id} task={task} onOpenDrawer={onOpenDrawer} now={now} />
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-slate-500">No tasks found</p>
          )}
        </div>
      </td>
    </tr>
  );
}

const chartTooltipStyle = {
  contentStyle: { backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' },
  labelStyle: { color: '#f1f5f9' },
};

function formatChartDate(d) {
  return new Date(typeof d === 'string' && d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const DURATION_BUCKETS = [
  { label: '<1m', min: 0, max: 60 },
  { label: '1-5m', min: 60, max: 300 },
  { label: '5-15m', min: 300, max: 900 },
  { label: '15-30m', min: 900, max: 1800 },
  { label: '30m-1h', min: 1800, max: 3600 },
  { label: '>1h', min: 3600, max: Infinity },
];

function Charts({ workflows, getWorkflowMeta }) {
  // Chart 1: Completion Rate Trend — daily success rate %
  const completionRateData = useMemo(() => {
    if (!workflows.length) return [];
    const byDate = {};
    for (const wf of workflows) {
      if (!wf.created_at) continue;
      const date = new Date(wf.created_at).toISOString().split('T')[0];
      if (!byDate[date]) byDate[date] = { total: 0, completed: 0 };
      byDate[date].total++;
      if (wf.status === 'completed') byDate[date].completed++;
    }
    return Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { total, completed }]) => ({
        date,
        successRate: total > 0 ? Math.round((completed / total) * 100) : 0,
      }));
  }, [workflows]);

  // Chart 2: Duration Distribution — bucket workflow durations
  const durationDistData = useMemo(() => {
    if (!workflows.length) return [];
    const counts = DURATION_BUCKETS.map(b => ({ range: b.label, count: 0 }));
    for (const wf of workflows) {
      const { durationSecs } = getWorkflowMeta(wf);
      if (durationSecs == null || durationSecs <= 0) continue;
      for (let i = 0; i < DURATION_BUCKETS.length; i++) {
        if (durationSecs >= DURATION_BUCKETS[i].min && durationSecs < DURATION_BUCKETS[i].max) {
          counts[i].count++;
          break;
        }
      }
    }
    return counts;
  }, [workflows, getWorkflowMeta]);

  // Chart 3: Throughput Over Time — workflows started per day
  const throughputData = useMemo(() => {
    if (!workflows.length) return [];
    const byDate = {};
    for (const wf of workflows) {
      if (!wf.created_at) continue;
      const date = new Date(wf.created_at).toISOString().split('T')[0];
      byDate[date] = (byDate[date] || 0) + 1;
    }
    return Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
  }, [workflows]);

  if (!workflows.length) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
      {/* Completion Rate Trend */}
      <div className="glass-card p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Completion Rate Trend</h3>
        {completionRateData.length > 1 ? (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={completionRateData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }} tickFormatter={formatChartDate} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
              <Tooltip {...chartTooltipStyle} formatter={(value) => [`${value}%`, 'Success Rate']} labelFormatter={formatChartDate} />
              <Line type="monotone" dataKey="successRate" stroke="#22c55e" strokeWidth={2} dot={false} name="Success Rate" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[220px] flex items-center justify-center text-slate-500 text-sm">
            Need 2+ days of data
          </div>
        )}
      </div>

      {/* Duration Distribution */}
      <div className="glass-card p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Duration Distribution</h3>
        {durationDistData.some(d => d.count > 0) ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={durationDistData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="range" tick={{ fill: '#94a3b8', fontSize: 11 }} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} allowDecimals={false} />
              <Tooltip {...chartTooltipStyle} formatter={(value) => [value, 'Workflows']} />
              <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[220px] flex items-center justify-center text-slate-500 text-sm">
            No duration data
          </div>
        )}
      </div>

      {/* Throughput Over Time */}
      <div className="glass-card p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Throughput Over Time</h3>
        {throughputData.length > 1 ? (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={throughputData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }} tickFormatter={formatChartDate} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} allowDecimals={false} />
              <Tooltip {...chartTooltipStyle} formatter={(value) => [value, 'Workflows']} labelFormatter={formatChartDate} />
              <Area type="monotone" dataKey="count" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.3} name="Workflows" />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[220px] flex items-center justify-center text-slate-500 text-sm">
            Need 2+ days of data
          </div>
        )}
      </div>
    </div>
  );
}

export default function BatchHistory({ onOpenDrawer, workflowTick, tasksTick, relativeTimeTick = 0 }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '');
  const [sortCol, setSortCol] = useState('created_at');
  const [sortDir, setSortDir] = useState('desc');
  const toast = useToast();
  const { execute } = useAbortableRequest();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [relativeTimeTick]);

  // Sync filter to URL
  useEffect(() => {
    const params = {};
    if (statusFilter) params.status = statusFilter;
    setSearchParams(params, { replace: true });
  }, [statusFilter, setSearchParams]);

  const loadWorkflows = useCallback(() => {
    setLoading(true);
    execute(async (isCurrent) => {
      try {
        const params = { limit: 50 };
        if (statusFilter) params.status = statusFilter;
        const data = await workflowsApi.list(params);
        if (!isCurrent()) return;
        setWorkflows(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Failed to load workflows:', err);
        toast.error('Failed to load batch history');
      } finally {
        if (isCurrent()) setLoading(false);
      }
    });
  }, [statusFilter, execute, toast]);

  // Refetch when workflowTick or tasksTick changes (WebSocket push) or on initial mount
  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows, workflowTick, tasksTick]);

  // Fallback polling at 120s in case WebSocket is disconnected
  useEffect(() => {
    const id = setInterval(loadWorkflows, 120000);
    return () => clearInterval(id);
  }, [loadWorkflows]);

  function handleSort(col) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  // Parse workflow context for task counts
  const getWorkflowMeta = useCallback((wf) => {
    const ctx = typeof wf.context === 'string' ? (() => { try { return JSON.parse(wf.context); } catch { return {}; } })() : (wf.context || {});
    const totalTasks = ctx.total_tasks || wf.total_tasks || 0;
    const completedTasks = ctx.completed_tasks || wf.completed_tasks || 0;
    const failedTasks = ctx.failed_tasks || wf.failed_tasks || 0;

    // Duration from first task start to last task end (or now if running)
    let durationSecs = null;
    if (wf.started_at || ctx.started_at) {
      const start = new Date(wf.started_at || ctx.started_at);
      const end = wf.status === 'running'
        ? new Date(now)
        : wf.completed_at || ctx.completed_at
          ? new Date(wf.completed_at || ctx.completed_at)
          : new Date(now);
      durationSecs = (end - start) / 1000;
    }

    return { totalTasks, completedTasks, failedTasks, durationSecs, ctx };
  }, [now]);

  // Client-side sort
  const sortedWorkflows = useMemo(() => {
    if (!workflows.length) return workflows;
    const sorted = [...workflows];
    sorted.sort((a, b) => {
      const metaA = getWorkflowMeta(a);
      const metaB = getWorkflowMeta(b);
      let av, bv;
      switch (sortCol) {
        case 'name':
          av = a.name || ''; bv = b.name || '';
          return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
        case 'status':
          av = a.status || ''; bv = b.status || '';
          return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
        case 'tasks':
          av = metaA.completedTasks; bv = metaB.completedTasks;
          return sortDir === 'asc' ? av - bv : bv - av;
        case 'duration':
          av = metaA.durationSecs || 0; bv = metaB.durationSecs || 0;
          return sortDir === 'asc' ? av - bv : bv - av;
        case 'created_at':
        default: {
          const da = new Date(a.created_at || 0).getTime();
          const db = new Date(b.created_at || 0).getTime();
          return sortDir === 'asc' ? da - db : db - da;
        }
      }
    });
    return sorted;
  }, [workflows, sortCol, sortDir, getWorkflowMeta]);

  // Summary stats
  const summaryStats = useMemo(() => {
    const total = workflows.length;
    const completed = workflows.filter(w => w.status === 'completed').length;
    const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    let totalDuration = 0;
    let durationCount = 0;
    for (const wf of workflows) {
      const { durationSecs } = getWorkflowMeta(wf);
      if (durationSecs && durationSecs > 0) {
        totalDuration += durationSecs;
        durationCount++;
      }
    }
    const avgDuration = durationCount > 0 ? totalDuration / durationCount : 0;

    return { total, successRate, avgDuration };
  }, [workflows, getWorkflowMeta]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="heading-lg text-white">Batches</h2>
        <div className="flex items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="">All Statuses</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="running">Running</option>
            <option value="pending">Pending</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button
            onClick={loadWorkflows}
            className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm rounded-lg transition-colors"
            title="Refresh"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <SummaryCard
          label="Total Workflows"
          value={summaryStats.total}
        />
        <SummaryCard
          label="Success Rate"
          value={`${summaryStats.successRate}%`}
          color={summaryStats.successRate >= 80 ? 'text-green-400' : summaryStats.successRate >= 50 ? 'text-yellow-400' : 'text-red-400'}
        />
        <SummaryCard
          label="Avg Duration"
          value={formatDuration(summaryStats.avgDuration)}
        />
      </div>

      {/* Charts */}
      <Charts workflows={workflows} getWorkflowMeta={getWorkflowMeta} />

      {/* Workflow table */}
      <div className="glass-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-700/50">
              <th className="p-4 w-8"></th>
              <SortHeader column="name" label="Name" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <SortHeader column="status" label="Status" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <SortHeader column="tasks" label="Tasks" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <SortHeader column="duration" label="Duration" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <SortHeader column="created_at" label="Created" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {loading && workflows.length === 0 ? (
              <>
                {[...Array(5)].map((_, i) => (
                  <tr key={i} className="border-b border-slate-700/30 animate-pulse">
                    <td className="p-4 w-8"><div className="w-4 h-4 bg-slate-700 rounded" /></td>
                    <td className="p-4"><div className="h-4 w-48 bg-slate-700 rounded" /></td>
                    <td className="p-4"><div className="w-16 h-5 bg-slate-700 rounded-full" /></td>
                    <td className="p-4"><div className="w-12 h-4 bg-slate-700 rounded" /></td>
                    <td className="p-4"><div className="w-14 h-4 bg-slate-700 rounded" /></td>
                    <td className="p-4"><div className="w-16 h-4 bg-slate-700 rounded" /></td>
                  </tr>
                ))}
              </>
            ) : sortedWorkflows.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-slate-500">
                  {statusFilter ? `No ${statusFilter} workflows found` : 'No workflows found'}
                </td>
              </tr>
            ) : (
              sortedWorkflows.map((wf) => {
                const meta = getWorkflowMeta(wf);
                const isExpanded = expandedId === wf.id;
                return (
                  <React.Fragment key={wf.id}>
                    <tr
                      onClick={() => setExpandedId(isExpanded ? null : wf.id)}
                      className={`border-b border-slate-700/30 hover:bg-slate-700/30 cursor-pointer transition-colors ${
                        isExpanded ? 'bg-slate-800/50' : ''
                      }`}
                    >
                      <td className="p-4 w-8">
                        <svg
                          className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </td>
                      <td className="p-4">
                        <p className="text-white text-sm font-medium">{wf.name || wf.id}</p>
                        {wf.description && (
                          <p className="text-xs text-slate-500 mt-0.5 truncate max-w-xs">{wf.description}</p>
                        )}
                      </td>
                      <td className="p-4">
                        <StatusBadge status={wf.status} />
                      </td>
                      <td className="p-4 text-sm text-slate-300">
                        {meta.totalTasks > 0 ? (
                          <span>
                            <span className={meta.completedTasks === meta.totalTasks ? 'text-green-400' : 'text-white'}>
                              {meta.completedTasks}
                            </span>
                            <span className="text-slate-500">/{meta.totalTasks}</span>
                            {meta.failedTasks > 0 && (
                              <span className="text-red-400 ml-1">({meta.failedTasks} failed)</span>
                            )}
                          </span>
                        ) : '-'}
                      </td>
                      <td className="p-4 text-sm font-mono text-slate-300">
                        {meta.durationSecs != null ? formatDuration(meta.durationSecs) : '-'}
                      </td>
                      <td className="p-4 text-slate-400 text-sm" title={wf.created_at}>
                        {wf.created_at
                          ? formatDistanceToNow(new Date(wf.created_at), { addSuffix: true })
                          : '-'}
                      </td>
                    </tr>
                    {isExpanded && (
                      <ExpandedWorkflow
                        key={`${wf.id}-detail`}
                        workflowId={wf.id}
                        onOpenDrawer={onOpenDrawer}
                        now={now}
                      />
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
