import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';
import { workflows as workflowsApi } from '../api';
import { useToast } from '../components/Toast';
import { useAbortableRequest } from '../hooks/useAbortableRequest';
import { getRelevantModel } from '../utils/providerModels';
import StatCard from '../components/StatCard';
import WorkflowDAG from '../components/WorkflowDAG';
import { STATUS_BG_COLORS } from '../constants';
import { formatDuration } from '../utils/formatters';
import { formatDistanceToNow } from 'date-fns';

const STATUS_COLORS = {
  completed: STATUS_BG_COLORS.completed,
  failed: STATUS_BG_COLORS.failed,
  running: STATUS_BG_COLORS.running,
  pending: STATUS_BG_COLORS.pending,
  blocked: 'bg-amber-500',
  waiting: 'bg-amber-600',
  cancelled: 'bg-orange-500',
  paused: 'bg-yellow-500',
};

const TASK_STATUS_ICONS = {
  completed: { icon: '\u2713', color: 'text-green-400' },
  failed: { icon: '\u2717', color: 'text-red-400' },
  running: { icon: '\u25CB', color: 'text-blue-400 animate-pulse' },
  pending: { icon: '\u25CB', color: 'text-slate-500' },
  blocked: { icon: '\u26A0', color: 'text-amber-300' },
  waiting: { icon: '\u23F3', color: 'text-amber-200' },
  skipped: { icon: '\u25CB', color: 'text-slate-600' },
  cancelled: { icon: '\u25CB', color: 'text-orange-400' },
};

const STATUS_FILTERS = ['all', 'running', 'completed', 'failed', 'pending', 'cancelled'];
const PAGE_LIMIT = 25;

function StatusBadge({ status }) {
  return (
    <span className={`px-2 py-1 rounded-full text-[11px] font-medium text-white ${STATUS_COLORS[status] || 'bg-gray-500'}`}>
      {status}
    </span>
  );
}

/** Parse workflow context for task counts and duration */
function getWorkflowMeta(wf, now = Date.now()) {
  const ctx = typeof wf.context === 'string'
    ? (() => { try { return JSON.parse(wf.context); } catch { return {}; } })()
    : (wf.context || {});
  const totalTasks = ctx.total_tasks || wf.total_tasks || 0;
  const completedTasks = ctx.completed_tasks || wf.completed_tasks || 0;
  const failedTasks = ctx.failed_tasks || wf.failed_tasks || 0;

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
}

function getTaskBlockerSnapshot(task) {
  if (task?.blocker_snapshot && typeof task.blocker_snapshot === 'object') {
    return task.blocker_snapshot;
  }
  const blocker = task?.context
    && typeof task.context === 'object'
    && !Array.isArray(task.context)
    ? task.context.workflow_blocker
    : null;
  return blocker && typeof blocker === 'object' ? blocker : null;
}

function getTaskDisplayLabel(task) {
  return task.node_id
    || task.description?.substring(0, 50)
    || task.task_description?.substring(0, 50)
    || task.id
    || task.task_id;
}

function formatTaskBlockerDependencyDetails(task, limit = 3) {
  const blocker = getTaskBlockerSnapshot(task);
  if (!blocker) return '';

  const unmetDependencies = Array.isArray(blocker.unmet_dependencies)
    ? blocker.unmet_dependencies
    : [];
  if (unmetDependencies.length === 0) return '';

  const detail = unmetDependencies.slice(0, limit).map((dependency) => {
    const nodeLabel = dependency?.node_id || dependency?.task_id || 'unknown';
    const status = dependency?.status || 'unknown';
    const unmetReason = dependency?.unmet_reason === 'dependency_not_terminal'
      ? 'waiting for terminal state'
      : dependency?.unmet_reason === 'condition_failed'
        ? 'condition failed'
        : dependency?.unmet_reason === 'dependency_failed'
          ? 'dependency failed'
          : dependency?.unmet_reason === 'missing_dependency'
            ? 'dependency missing'
            : 'blocked';
    const alternate = dependency?.alternate_task_id ? `, alternate=${dependency.alternate_task_id}` : '';
    return `${nodeLabel} (${status}, ${unmetReason}, on_fail=${dependency?.on_fail || 'skip'}${alternate})`;
  }).join(', ');

  return unmetDependencies.length > limit
    ? `${detail}, +${unmetDependencies.length - limit} more`
    : detail;
}

function formatTaskBlockerFailureActions(task, limit = 3) {
  const blocker = getTaskBlockerSnapshot(task);
  if (!blocker) return '';

  const failureActions = (Array.isArray(blocker.failure_actions) ? blocker.failure_actions : [])
    .filter((action) => action && action.blocking !== false);
  if (failureActions.length === 0) return '';

  const detail = failureActions.slice(0, limit).map((action) => {
    const nodeLabel = action?.node_id || action?.task_id || 'unknown';
    const alternate = action?.alternate_task_id ? ` (alternate ${action.alternate_task_id})` : '';
    return `${nodeLabel}=>${action?.on_fail || 'skip'}${alternate}`;
  }).join(', ');

  return failureActions.length > limit
    ? `${detail}, +${failureActions.length - limit} more`
    : detail;
}

function formatTaskBlockerSummary(task) {
  const blocker = getTaskBlockerSnapshot(task);
  if (!blocker) return '';

  const unmetDependencies = Array.isArray(blocker.unmet_dependencies)
    ? blocker.unmet_dependencies
    : [];
  const dependencyLabels = unmetDependencies
    .map((dependency) => dependency?.node_id || dependency?.task_id)
    .filter(Boolean);
  const dependencyHint = dependencyLabels.length > 0
    ? ` Holding on: ${dependencyLabels.slice(0, 3).join(', ')}${dependencyLabels.length > 3 ? ` +${dependencyLabels.length - 3}` : ''}.`
    : '';

  return `${blocker.reason || 'Blocked.'}${dependencyHint}`;
}

/** Indented DAG task row inside expanded workflow */
function DAGTaskRow({ task, depth = 0, onOpenDrawer, now }) {
  const statusInfo = TASK_STATUS_ICONS[task.status] || TASK_STATUS_ICONS.pending;
  const blockerSummary = formatTaskBlockerSummary(task);
  const duration = task.completed_at && task.started_at
    ? (new Date(task.completed_at) - new Date(task.started_at)) / 1000
    : task.status === 'running' && task.started_at
      ? (now - new Date(task.started_at).getTime()) / 1000
      : null;

  const deps = task.depends_on || task.dependencies || [];

  return (
    <tr
      className="border-b border-slate-700/20 hover:bg-slate-700/20 cursor-pointer transition-colors"
      tabIndex={0}
      role="button"
      onClick={() => onOpenDrawer?.(task.id || task.task_id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenDrawer?.(task.id || task.task_id);
        }
      }}
    >
      <td className="px-4 py-2" style={{ paddingLeft: `${16 + depth * 24}px` }}>
        <div className="flex items-center gap-2">
          {depth > 0 && (
            <span className="text-slate-600 text-xs font-mono">{'|--'}</span>
          )}
          <span className={`font-mono text-sm ${statusInfo.color}`}>{statusInfo.icon}</span>
          <span className="text-sm text-slate-300">
            {getTaskDisplayLabel(task)}
          </span>
        </div>
        {deps.length > 0 && (
          <div className="text-[10px] text-slate-600 mt-0.5" style={{ paddingLeft: depth > 0 ? '32px' : '24px' }}>
            depends on: {deps.join(', ')}
          </div>
        )}
        {blockerSummary && (
          <div className="text-[10px] text-amber-300 mt-0.5" style={{ paddingLeft: depth > 0 ? '32px' : '24px' }}>
            {blockerSummary}
          </div>
        )}
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

/** Expanded workflow detail: loads tasks and renders as DAG graph + table */
function ExpandedWorkflowDAG({ workflowId, onOpenDrawer, now }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('graph'); // 'graph' or 'table'

  useEffect(() => {
    let cancelled = false;
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
            Loading workflow tasks...
          </div>
        </td>
      </tr>
    );
  }

  if (!detail) return null;

  // Extract tasks — handle both object map and array formats
  const tasksRaw = detail.tasks
    ? (Array.isArray(detail.tasks) ? detail.tasks : Object.values(detail.tasks))
    : [];

  // Build dependency graph for indentation
  const taskMap = new Map();
  for (const t of tasksRaw) {
    const key = t.node_id || t.id || t.task_id;
    taskMap.set(key, t);
  }

  // Compute depth: tasks with no dependencies are depth 0, others are depth based on longest dep chain
  function computeDepth(task, visited = new Set()) {
    const key = task.node_id || task.id || task.task_id;
    if (visited.has(key)) return 0;
    visited.add(key);
    const deps = task.depends_on || task.dependencies || [];
    if (deps.length === 0) return 0;
    let maxDepth = 0;
    for (const dep of deps) {
      const depTask = taskMap.get(dep);
      if (depTask) {
        maxDepth = Math.max(maxDepth, computeDepth(depTask, visited) + 1);
      }
    }
    return maxDepth;
  }

  const tasksWithDepth = tasksRaw.map(t => ({
    ...t,
    _depth: computeDepth(t),
  }));
  const blockedTasks = tasksWithDepth.filter((task) => ['blocked', 'waiting'].includes(task.status));
  const blockedTaskCount = blockedTasks.length;

  // Sort by depth (roots first), then by node_id/name
  tasksWithDepth.sort((a, b) => {
    if (a._depth !== b._depth) return a._depth - b._depth;
    const aName = a.node_id || a.id || '';
    const bName = b.node_id || b.id || '';
    return aName.localeCompare(bName);
  });

  return (
    <tr>
      <td colSpan={7} className="p-0">
        <div className="bg-slate-800/40 border-t border-b border-slate-700/30 px-4 py-3">
          <div className="flex items-center gap-3 mb-3">
            <h4 className="text-sm font-medium text-white">Task DAG</h4>
            <span className="text-xs text-slate-500">
              {tasksWithDepth.length} task{tasksWithDepth.length !== 1 ? 's' : ''}
            </span>
            {blockedTaskCount > 0 && (
              <span className="text-xs text-amber-300">
                {blockedTaskCount} blocked/waiting
              </span>
            )}
            {detail.cost && detail.cost.total_cost_usd > 0 && (
              <span className="text-xs text-slate-400">
                Cost: ${detail.cost.total_cost_usd.toFixed(4)}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => setViewMode('graph')}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  viewMode === 'graph' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:text-white'
                }`}
              >
                Graph
              </button>
              <button
                onClick={() => setViewMode('table')}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  viewMode === 'table' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:text-white'
                }`}
              >
                Table
              </button>
            </div>
          </div>
          {blockedTaskCount > 0 && (
            <div className="mb-3 rounded-lg border border-amber-400/20 bg-amber-500/10 p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200">Blocked Diagnostics</p>
                  <p className="text-xs text-amber-100/80">Persisted blocker snapshots from the workflow runtime.</p>
                </div>
                <span className="text-xs text-amber-300">
                  {blockedTaskCount} task{blockedTaskCount !== 1 ? 's' : ''} not runnable
                </span>
              </div>
              <div className="space-y-2">
                {blockedTasks.slice(0, 4).map((task) => {
                  const blocker = getTaskBlockerSnapshot(task);
                  const dependencyDetails = formatTaskBlockerDependencyDetails(task);
                  const failureActions = formatTaskBlockerFailureActions(task);
                  return (
                    <div
                      key={`blocked-${task.id || task.task_id || task.node_id}`}
                      className="rounded-md border border-amber-400/15 bg-slate-950/40 px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-amber-100">{getTaskDisplayLabel(task)}</span>
                        <StatusBadge status={task.status} />
                      </div>
                      <p className="mt-1 text-xs text-amber-50">
                        {blocker?.reason || 'Blocked with no persisted blocker snapshot.'}
                      </p>
                      {dependencyDetails && (
                        <p className="mt-1 text-[11px] text-amber-100/75">
                          Waiting on: {dependencyDetails}
                        </p>
                      )}
                      {failureActions && (
                        <p className="mt-1 text-[11px] text-amber-100/65">
                          Failure actions: {failureActions}
                        </p>
                      )}
                    </div>
                  );
                })}
                {blockedTaskCount > 4 && (
                  <p className="text-[11px] text-amber-200/70">
                    +{blockedTaskCount - 4} more blocked task{blockedTaskCount - 4 !== 1 ? 's' : ''} in the DAG
                  </p>
                )}
              </div>
            </div>
          )}
          {tasksWithDepth.length > 0 ? (
            viewMode === 'graph' ? (
              <WorkflowDAG tasks={tasksWithDepth} onOpenDrawer={onOpenDrawer} />
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="text-xs text-slate-500">
                    <th scope="col" className="px-4 py-1 text-left">Node</th>
                    <th scope="col" className="px-4 py-1 text-left">Status</th>
                    <th scope="col" className="px-4 py-1 text-left">Provider</th>
                    <th scope="col" className="px-4 py-1 text-left">Model</th>
                    <th scope="col" className="px-4 py-1 text-left">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {tasksWithDepth.map((task) => (
                    <DAGTaskRow
                      key={task.id || task.task_id || task.node_id}
                      task={task}
                      depth={task._depth}
                      onOpenDrawer={onOpenDrawer}
                      now={now}
                    />
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <p className="text-sm text-slate-500">No tasks found</p>
          )}
        </div>
      </td>
    </tr>
  );
}

export default function Workflows({ onOpenDrawer, relativeTimeTick = 0 }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || 'all');
  const [page, setPage] = useState(parseInt(searchParams.get('page')) || 1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const toast = useToast();
  const { execute } = useAbortableRequest();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [relativeTimeTick]);

  // Sync filter + page to URL
  useEffect(() => {
    const params = {};
    if (statusFilter && statusFilter !== 'all') params.status = statusFilter;
    if (page > 1) params.page = String(page);
    setSearchParams(params, { replace: true });
  }, [statusFilter, page, setSearchParams]);

  // Reset to page 1 when filter changes
  const prevFilterRef = useRef(statusFilter);
  useEffect(() => {
    if (prevFilterRef.current !== statusFilter) {
      prevFilterRef.current = statusFilter;
      setPage(1);
    }
  }, [statusFilter, prevFilterRef]);

  const loadWorkflows = useCallback(() => {
    setLoading(true);
    execute(async (isCurrent) => {
      try {
        const params = {
          limit: PAGE_LIMIT,
          offset: (page - 1) * PAGE_LIMIT,
        };
        if (statusFilter && statusFilter !== 'all') params.status = statusFilter;
        const data = await workflowsApi.list(params);
        if (!isCurrent()) return;
        const items = Array.isArray(data) ? data : (data?.workflows || data?.items || data || []);
        const paginationTotal = data?.pagination?.total ?? (Array.isArray(data) ? data.length : items.length);
        setWorkflows(items);
        setTotal(paginationTotal);
        setTotalPages(Math.max(1, Math.ceil(paginationTotal / PAGE_LIMIT)));
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Failed to load workflows:', err);
        toast.error('Failed to load workflows');
      } finally {
        if (isCurrent()) setLoading(false);
      }
    });
  }, [statusFilter, page, execute, toast]);

  useEffect(() => {
    loadWorkflows();
    // Auto-refresh every 30s for running workflows
    const id = setInterval(() => {
      if (document.hidden) return;
      loadWorkflows();
    }, 30000);
    return () => clearInterval(id);
  }, [loadWorkflows]);

  // Summary statistics
  const summaryStats = useMemo(() => {
    const total = workflows.length;
    const completed = workflows.filter(w => w.status === 'completed').length;
    const failed = workflows.filter(w => w.status === 'failed').length;
    const active = workflows.filter(w => w.status === 'running').length;
    const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    let totalDuration = 0;
    let durationCount = 0;
    for (const wf of workflows) {
      const { durationSecs } = getWorkflowMeta(wf, now);
      if (durationSecs && durationSecs > 0) {
        totalDuration += durationSecs;
        durationCount++;
      }
    }
    const avgDuration = durationCount > 0 ? totalDuration / durationCount : 0;

    return { total, completed, failed, active, successRate, avgDuration };
  }, [workflows, now]);

  // Client-side sort: newest first
  const sortedWorkflows = useMemo(() => {
    if (!workflows.length) return workflows;
    return [...workflows].sort((a, b) => {
      const da = new Date(a.created_at || 0).getTime();
      const db = new Date(b.created_at || 0).getTime();
      return db - da;
    });
  }, [workflows]);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Workflows</h1>
        <button
          onClick={loadWorkflows}
          className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm rounded-lg transition-colors"
          title="Refresh"
          aria-label="Refresh"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Workflows" value={total} />
        <StatCard
          label="Success Rate"
          value={`${summaryStats.successRate}%`}
          subtext={`${summaryStats.completed} completed, ${summaryStats.failed} failed`}
        />
        <StatCard label="Avg Duration" value={formatDuration(summaryStats.avgDuration)} />
        <StatCard
          label="Active"
          value={summaryStats.active}
          subtext={summaryStats.active > 0 ? 'currently running' : 'none running'}
        />
      </div>

      {/* Status Filter Buttons */}
      <div className="flex items-center gap-2">
        {STATUS_FILTERS.map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === s
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white border border-slate-700/50'
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Workflow Table */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-400 text-left border-b border-slate-700">
              <th scope="col" className="px-4 py-3 w-8"></th>
              <th scope="col" className="px-4 py-3">Name</th>
              <th scope="col" className="px-4 py-3">Status</th>
              <th scope="col" className="px-4 py-3">Progress</th>
              <th scope="col" className="px-4 py-3">Duration</th>
              <th scope="col" className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {loading && workflows.length === 0 ? (
              <>
                {[...Array(5)].map((_, i) => (
                  <tr key={i} className="border-b border-slate-700/30 animate-pulse">
                    <td className="px-4 py-3 w-8"><div className="w-4 h-4 bg-slate-700 rounded" /></td>
                    <td className="px-4 py-3"><div className="h-4 w-48 bg-slate-700 rounded" /></td>
                    <td className="px-4 py-3"><div className="w-16 h-5 bg-slate-700 rounded-full" /></td>
                    <td className="px-4 py-3"><div className="w-12 h-4 bg-slate-700 rounded" /></td>
                    <td className="px-4 py-3"><div className="w-14 h-4 bg-slate-700 rounded" /></td>
                    <td className="px-4 py-3"><div className="w-20 h-4 bg-slate-700 rounded" /></td>
                  </tr>
                ))}
              </>
            ) : sortedWorkflows.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-12 text-center">
                  {statusFilter !== 'all' ? (
                    <span className="text-slate-500">{`No ${statusFilter} workflows found`}</span>
                  ) : (
                    <div>
                      <svg
                        className="mx-auto mb-3 h-12 w-12 text-slate-600"
                        viewBox="0 0 48 48"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="2" />
                        <circle cx="36" cy="12" r="5" stroke="currentColor" strokeWidth="2" />
                        <circle cx="24" cy="34" r="5" stroke="currentColor" strokeWidth="2" />
                        <path d="M17 12H31" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        <path d="M16 15L21 29" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        <path d="M32 15L27 29" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      <div className="text-lg font-medium text-white">No Workflows Yet</div>
                      <div className="mt-1 text-sm text-slate-500">
                        Workflows chain dependent tasks into DAG pipelines with automatic output
                        injection.
                      </div>
                      <div className="mt-4 text-sm text-slate-400">
                        Create one with{' '}
                        <code className="rounded bg-slate-900 px-2 py-1 font-mono text-xs text-blue-300">
                          create_workflow
                        </code>{' '}
                        or use{' '}
                        <code className="rounded bg-slate-900 px-2 py-1 font-mono text-xs text-blue-300">
                          /torque-workflow
                        </code>
                      </div>
                    </div>
                  )}
                </td>
              </tr>
            ) : (
              sortedWorkflows.map((wf) => {
                const meta = getWorkflowMeta(wf, now);
                const isExpanded = expandedId === wf.id;
                const progressPct = meta.totalTasks > 0
                  ? Math.round((meta.completedTasks / meta.totalTasks) * 100)
                  : 0;

                return (
                  <Fragment key={wf.id}>
                    <tr
                      onClick={() => setExpandedId(isExpanded ? null : wf.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setExpandedId(isExpanded ? null : wf.id);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-expanded={isExpanded}
                      className={`border-b border-slate-700/50 hover:bg-slate-700/30 cursor-pointer transition-colors ${
                        isExpanded ? 'bg-slate-700/20' : ''
                      }`}
                    >
                      <td className="px-4 py-3 w-8">
                        <svg
                          className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-white font-medium">{wf.name || wf.id}</p>
                        {wf.description && (
                          <p className="text-xs text-slate-500 mt-0.5 truncate max-w-xs">{wf.description}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={wf.status} />
                      </td>
                      <td className="px-4 py-3">
                        {meta.totalTasks > 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="flex-1 max-w-[80px] h-1.5 bg-slate-700 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  meta.failedTasks > 0 ? 'bg-red-500' : 'bg-green-500'
                                }`}
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                            <span className="text-slate-300 text-sm">
                              <span className={meta.completedTasks === meta.totalTasks ? 'text-green-400' : 'text-white'}>
                                {meta.completedTasks}
                              </span>
                              <span className="text-slate-500">/{meta.totalTasks}</span>
                            </span>
                            {meta.failedTasks > 0 && (
                              <span className="text-red-400 text-xs">({meta.failedTasks} failed)</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-600">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-300">
                        {meta.durationSecs != null ? formatDuration(meta.durationSecs) : '-'}
                      </td>
                      <td className="px-4 py-3 text-slate-400" title={wf.created_at}>
                        {wf.created_at
                          ? formatDistanceToNow(new Date(wf.created_at), { addSuffix: true })
                          : '-'}
                      </td>
                    </tr>
                    {isExpanded && (
                      <ExpandedWorkflowDAG
                        workflowId={wf.id}
                        onOpenDrawer={onOpenDrawer}
                        now={now}
                      />
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4">
        <p className="text-slate-500 text-sm">
          Page {page} of {totalPages} ({total} total)
        </p>
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            className="px-4 py-2 bg-slate-800 text-white text-sm rounded-lg disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 transition-colors"
          >
            Previous
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className="px-4 py-2 bg-slate-800 text-white text-sm rounded-lg disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 transition-colors"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
