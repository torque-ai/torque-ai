import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { approvals as approvalsApi, tasks as tasksApi } from '../api';
import { useToast } from '../components/Toast';
import StatCard from '../components/StatCard';
import { formatDate } from '../utils/formatters';
import LoadingSkeleton from '../components/LoadingSkeleton';

const PAGE_LIMIT = 25;
const FACTORY_POLL_MS = 5000;
const FACTORY_DESCRIPTION_LIMIT = 200;

function truncateId(id) {
  if (!id) return '-';
  return String(id).substring(0, 8);
}

function truncateText(value, limit = FACTORY_DESCRIPTION_LIMIT) {
  const text = String(value || '').trim();
  if (!text) return '-';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}...`;
}

function getTaskTagValue(task, prefix) {
  const tags = Array.isArray(task?.tags) ? task.tags : [];
  const matchingTag = tags.find((tag) => typeof tag === 'string' && tag.startsWith(`${prefix}=`));
  return matchingTag ? matchingTag.slice(prefix.length + 1) : null;
}

function getFactoryProject(task) {
  return task?.project || task?.project_name || null;
}

function getFactoryTaskDescription(task) {
  return truncateText(task?.task_description || task?.description || task?.prompt || '-');
}

function getFactoryTaskNumber(task) {
  const planTaskNumber = getTaskTagValue(task, 'factory:plan_task_number');
  if (planTaskNumber) return planTaskNumber;

  const workItemId = getTaskTagValue(task, 'factory:work_item_id');
  if (workItemId) return workItemId;

  if (task?.task_number != null) return String(task.task_number);
  if (task?.number != null) return String(task.number);

  return truncateId(task?.id);
}

function sortFactoryTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const aNumber = Number(getFactoryTaskNumber(a));
    const bNumber = Number(getFactoryTaskNumber(b));

    if (Number.isFinite(aNumber) && Number.isFinite(bNumber) && aNumber !== bNumber) {
      return aNumber - bNumber;
    }

    if (Number.isFinite(aNumber) !== Number.isFinite(bNumber)) {
      return Number.isFinite(aNumber) ? -1 : 1;
    }

    const aCreatedAt = new Date(a?.created_at || 0).getTime();
    const bCreatedAt = new Date(b?.created_at || 0).getTime();
    if (aCreatedAt !== bCreatedAt) {
      return aCreatedAt - bCreatedAt;
    }

    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

function buildFactoryBatches(tasks, projectFilter) {
  const grouped = new Map();

  for (const task of Array.isArray(tasks) ? tasks : []) {
    const batchId = getTaskTagValue(task, 'factory:batch_id');
    if (!batchId) continue;

    const project = getFactoryProject(task);
    if (projectFilter && project !== projectFilter) continue;

    if (!grouped.has(batchId)) {
      grouped.set(batchId, {
        batchId,
        project,
        tasks: [],
      });
    }

    const group = grouped.get(batchId);
    if (!group.project && project) {
      group.project = project;
    }
    group.tasks.push(task);
  }

  return Array.from(grouped.values())
    .map((group) => {
      const sortedTasks = sortFactoryTasks(group.tasks);
      const lastCreatedAt = sortedTasks.reduce((latest, task) => {
        const value = new Date(task?.created_at || 0).getTime();
        return Number.isFinite(value) ? Math.max(latest, value) : latest;
      }, 0);

      return {
        ...group,
        count: sortedTasks.length,
        lastCreatedAt,
        tasks: sortedTasks,
      };
    })
    .sort((a, b) => {
      if (b.lastCreatedAt !== a.lastCreatedAt) {
        return b.lastCreatedAt - a.lastCreatedAt;
      }
      return a.batchId.localeCompare(b.batchId, undefined, { numeric: true });
    });
}

function SortHeader({ column, label, sortCol, sortDir, onSort }) {
  const active = sortCol === column;
  return (
    <th
      scope="col"
      className="text-left p-4 heading-sm cursor-pointer select-none hover:text-white transition-colors group"
      onClick={() => onSort(column)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort(column);
        }
      }}
      tabIndex={0}
      role="columnheader"
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-[10px] ${active ? 'text-blue-400' : 'text-slate-600 opacity-0 group-hover:opacity-100'} transition-opacity`}>
          {active ? (sortDir === 'asc' ? '^' : 'v') : '^'}
        </span>
      </span>
    </th>
  );
}

function Pagination({ page, totalPages, total, onPage }) {
  return (
    <div className="flex items-center justify-between mt-4">
      <p className="text-slate-500 text-sm">
        Page {page} of {totalPages} ({total} total)
      </p>
      <div className="flex gap-2">
        <button
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="px-4 py-2 bg-slate-800 text-white text-sm rounded-lg disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 transition-colors"
        >
          Previous
        </button>
        <button
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          className="px-4 py-2 bg-slate-800 text-white text-sm rounded-lg disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function sortItems(items, col, dir) {
  if (!col) return items;
  return [...items].sort((a, b) => {
    const av = String(a[col] ?? '');
    const bv = String(b[col] ?? '');
    const cmp = av.localeCompare(bv, undefined, { numeric: true });
    return dir === 'asc' ? cmp : -cmp;
  });
}

function formatCommandPreview(commands, limit = 2) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return '-';
  }

  const preview = commands.slice(0, limit).join('  |  ');
  if (commands.length <= limit) {
    return preview;
  }
  return `${preview}  |  +${commands.length - limit} more`;
}

const DELTA_LEVEL_STYLES = {
  none: 'bg-slate-600/20 text-slate-300',
  baseline: 'bg-slate-600/20 text-slate-300',
  low: 'bg-emerald-600/20 text-emerald-300',
  moderate: 'bg-amber-600/20 text-amber-300',
  high: 'bg-orange-600/20 text-orange-300',
  critical: 'bg-red-600/20 text-red-300',
};

function formatDeltaLevel(level) {
  if (!level) return 'Unknown';
  return String(level)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function DeltaBadge({ level, score }) {
  const normalizedLevel = String(level || 'none').toLowerCase();
  const className = DELTA_LEVEL_STYLES[normalizedLevel] || DELTA_LEVEL_STYLES.none;

  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium ${className}`}>
      <span>Delta: {formatDeltaLevel(normalizedLevel)}</span>
      {typeof score === 'number' && <span className="opacity-80">({score})</span>}
    </span>
  );
}

function buildStudyTraceHref(trace) {
  if (!trace?.schedule_id) {
    return null;
  }
  const params = new URLSearchParams();
  params.set('scheduleId', trace.schedule_id);
  if (trace.schedule_run_id) {
    params.set('runId', trace.schedule_run_id);
  }
  const query = params.toString();
  return `/operations${query ? `?${query}` : ''}#schedules`;
}

function StudyTraceDetails({ item }) {
  const trace = item.study_trace || item.study_proposal?.trace;
  if (!trace || typeof trace !== 'object') {
    return null;
  }

  const href = buildStudyTraceHref(trace);
  const reasons = Array.isArray(trace.significance_reasons) ? trace.significance_reasons : [];
  const subsystems = Array.isArray(trace.changed_subsystems) ? trace.changed_subsystems : [];
  const flows = Array.isArray(trace.affected_flows) ? trace.affected_flows : [];

  return (
    <div className="mt-2 rounded-lg border border-slate-700/60 bg-slate-900/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Why this proposal happened
        </span>
        <DeltaBadge level={trace.delta_significance_level} score={trace.delta_significance_score} />
      </div>
      {reasons.length > 0 && (
        <p className="mt-2 text-xs text-slate-400">
          {reasons.join(' ')}
        </p>
      )}
      {(subsystems.length > 0 || flows.length > 0) && (
        <div className="mt-2 space-y-1 text-xs">
          {subsystems.length > 0 && (
            <p className="text-slate-500">
              Subsystems: <span className="text-slate-300">{subsystems.slice(0, 3).join(', ')}</span>
              {subsystems.length > 3 ? ` +${subsystems.length - 3} more` : ''}
            </p>
          )}
          {flows.length > 0 && (
            <p className="text-slate-500">
              Flows: <span className="text-slate-300">{flows.slice(0, 3).join(', ')}</span>
              {flows.length > 3 ? ` +${flows.length - 3} more` : ''}
            </p>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        {trace.schedule_name && (
          <span className="text-slate-500">
            Schedule: <span className="text-slate-300">{trace.schedule_name}</span>
          </span>
        )}
        {trace.run_mode && (
          <span className="text-slate-500">
            Run Mode: <span className="text-slate-300">{trace.run_mode}</span>
          </span>
        )}
        {trace.schedule_run_id && (
          <span className="text-slate-500">
            Run: <span className="font-mono text-slate-300">{truncateId(trace.schedule_run_id)}</span>
          </span>
        )}
        {href && (
          <a href={href} className="text-blue-400 hover:text-blue-300 transition-colors">
            Open generating run
          </a>
        )}
      </div>
    </div>
  );
}

function FactoryBatchCard({
  batch,
  expanded,
  highlighted,
  onToggle,
  onApproveBatch,
  onRejectBatch,
  onApproveTask,
  onRejectTask,
  busyTaskIds,
  busyBatchId,
}) {
  const batchBusy = busyBatchId === batch.batchId;

  return (
    <div
      className={`rounded-xl border ${
        highlighted ? 'border-blue-500/40 bg-slate-900/70' : 'border-slate-700/60 bg-slate-900/50'
      }`}
    >
      <div className="flex flex-col gap-3 border-b border-slate-800/80 px-4 py-4 md:flex-row md:items-center md:justify-between">
        <button
          type="button"
          onClick={() => onToggle(batch.batchId)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} batch ${batch.batchId}`}
          className="flex items-start gap-3 text-left text-white"
        >
          <span className="mt-0.5 text-slate-400">{expanded ? 'v' : '>'}</span>
          <div>
            <p className="text-sm font-semibold">Batch {batch.batchId}</p>
            <p className="text-xs text-slate-400">
              {batch.count} task{batch.count === 1 ? '' : 's'}
              {batch.project ? ` · ${batch.project}` : ''}
            </p>
          </div>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={batchBusy}
            onClick={() => onApproveBatch(batch)}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {batchBusy ? 'Working...' : 'Approve all'}
          </button>
          <button
            type="button"
            disabled={batchBusy}
            onClick={() => onRejectBatch(batch)}
            className="rounded-lg bg-red-600/20 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-600/35 disabled:opacity-50"
          >
            {batchBusy ? 'Working...' : 'Reject all'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="divide-y divide-slate-800/80">
          {batch.tasks.map((task) => {
            const taskBusy = busyTaskIds.has(task.id);

            return (
              <div key={task.id} className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-300">
                      Task {getFactoryTaskNumber(task)}
                    </span>
                    {task.id && (
                      <code className="text-[11px] text-slate-500">{truncateId(task.id)}</code>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-slate-100" title={task?.task_description || task?.description || ''}>
                    {getFactoryTaskDescription(task)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                    {task.created_at && <span>Created {formatDate(task.created_at)}</span>}
                    {getTaskTagValue(task, 'factory:work_item_id') && (
                      <span>Work item {getTaskTagValue(task, 'factory:work_item_id')}</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={taskBusy || batchBusy}
                    onClick={() => onApproveTask(task)}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                  >
                    {taskBusy ? 'Working...' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    disabled={taskBusy || batchBusy}
                    onClick={() => onRejectTask(task)}
                    className="rounded-lg bg-red-600/20 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-600/35 disabled:opacity-50"
                  >
                    {taskBusy ? 'Working...' : 'Reject'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Approvals() {
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [factoryLoading, setFactoryLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState(null);
  const [factoryActionInProgress, setFactoryActionInProgress] = useState(null);
  const [activeTab, setActiveTab] = useState('pending');
  const [factoryTasks, setFactoryTasks] = useState([]);
  const [expandedFactoryBatches, setExpandedFactoryBatches] = useState({});

  const [pendingSort, setPendingSort] = useState({ col: 'created_at', dir: 'desc' });
  const [historySort, setHistorySort] = useState({ col: 'decided_at', dir: 'desc' });

  const [pendingPage, setPendingPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);

  const toast = useToast();
  const location = useLocation();
  const mountedRef = useRef(true);
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const highlightedSource = searchParams.get('source') === 'factory';
  const projectFilter = searchParams.get('project') || '';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [pendingData, historyData] = await Promise.all([
        approvalsApi.listPending(),
        approvalsApi.getHistory(50),
      ]);
      if (!mountedRef.current) return;
      setPending(pendingData);
      setHistory(historyData);
    } catch (err) {
      console.error('Failed to load approvals:', err);
      if (mountedRef.current) {
        toast.error('Failed to load approvals');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [toast]);

  const loadFactoryTasks = useCallback(async ({ background = false } = {}) => {
    try {
      const data = await tasksApi.list({ status: 'pending_approval', limit: 100 });
      if (!mountedRef.current) return;
      setFactoryTasks(Array.isArray(data?.tasks) ? data.tasks : []);
    } catch (err) {
      if (!background && mountedRef.current) {
        console.error('Failed to load factory task approvals:', err);
        toast.error('Failed to load factory task approvals');
      }
    } finally {
      if (mountedRef.current) {
        setFactoryLoading(false);
      }
    }
  }, [toast]);

  useEffect(() => {
    loadData();
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadData();
    }, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  useEffect(() => {
    loadFactoryTasks();
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadFactoryTasks({ background: true });
    }, FACTORY_POLL_MS);
    return () => clearInterval(interval);
  }, [loadFactoryTasks]);

  const factoryBatches = useMemo(
    () => buildFactoryBatches(factoryTasks, projectFilter),
    [factoryTasks, projectFilter]
  );

  useEffect(() => {
    setExpandedFactoryBatches((prev) => {
      const next = { ...prev };
      const activeBatchIds = new Set(factoryBatches.map((batch) => batch.batchId));
      let changed = false;

      for (const batchId of activeBatchIds) {
        if (!(batchId in next)) {
          next[batchId] = true;
          changed = true;
        }
      }

      for (const batchId of Object.keys(next)) {
        if (!activeBatchIds.has(batchId)) {
          delete next[batchId];
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [factoryBatches]);

  function makeSort(setter) {
    return (col) => setter(prev => ({
      col,
      dir: prev.col === col ? (prev.dir === 'asc' ? 'desc' : 'asc') : 'asc',
    }));
  }

  async function handleApprove(id) {
    setActionInProgress({ id, action: 'approve' });
    try {
      await approvalsApi.approve(id);
      toast.success('Approval granted');
      loadData();
    } catch (err) {
      toast.error(`Approve failed: ${err.message}`);
    } finally {
      if (mountedRef.current) {
        setActionInProgress(null);
      }
    }
  }

  async function handleReject(id) {
    setActionInProgress({ id, action: 'reject' });
    try {
      await approvalsApi.reject(id);
      toast.success('Approval rejected');
      loadData();
    } catch (err) {
      toast.error(`Reject failed: ${err.message}`);
    } finally {
      if (mountedRef.current) {
        setActionInProgress(null);
      }
    }
  }

  const handleFactoryTaskAction = useCallback(async (task, decision) => {
    const snapshot = factoryTasks;
    const taskId = task.id;
    const batchId = getTaskTagValue(task, 'factory:batch_id');

    setFactoryActionInProgress({
      type: decision,
      batchId,
      taskIds: [taskId],
    });
    setFactoryTasks((prev) => prev.filter((item) => item.id !== taskId));

    try {
      if (decision === 'approve') {
        await tasksApi.approve(taskId);
        toast.success(`Task ${getFactoryTaskNumber(task)} approved`);
      } else {
        await tasksApi.reject(taskId);
        toast.success(`Task ${getFactoryTaskNumber(task)} rejected`);
      }
    } catch (err) {
      if (mountedRef.current) {
        setFactoryTasks(snapshot);
      }
      toast.error(`${decision === 'approve' ? 'Approve' : 'Reject'} failed: ${err.message}`);
    } finally {
      if (mountedRef.current) {
        setFactoryActionInProgress(null);
      }
    }
  }, [factoryTasks, toast]);

  const handleFactoryBatchAction = useCallback(async (batch, decision) => {
    const snapshot = factoryTasks;
    const taskIds = batch.tasks.map((task) => task.id);

    setFactoryActionInProgress({
      type: `${decision}-batch`,
      batchId: batch.batchId,
      taskIds,
    });
    setFactoryTasks((prev) => prev.filter((task) => !taskIds.includes(task.id)));

    try {
      if (decision === 'approve') {
        await tasksApi.approveBatch({ batch_id: batch.batchId, task_ids: taskIds });
        toast.success(`Approved ${taskIds.length} task${taskIds.length === 1 ? '' : 's'} in ${batch.batchId}`);
      } else {
        const results = await Promise.allSettled(taskIds.map((taskId) => tasksApi.reject(taskId)));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') {
          throw failure.reason instanceof Error ? failure.reason : new Error('Failed to reject batch');
        }
        toast.success(`Rejected ${taskIds.length} task${taskIds.length === 1 ? '' : 's'} in ${batch.batchId}`);
      }
    } catch (err) {
      if (mountedRef.current) {
        setFactoryTasks(snapshot);
      }
      toast.error(`${decision === 'approve' ? 'Approve all' : 'Reject all'} failed: ${err.message}`);
    } finally {
      if (mountedRef.current) {
        setFactoryActionInProgress(null);
      }
    }
  }, [factoryTasks, toast]);

  const approvedToday = history.filter((h) => {
    if (h.decision !== 'approved') return false;
    if (!h.decided_at) return false;
    const d = new Date(h.decided_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;

  const rejectedToday = history.filter((h) => {
    if (h.decision !== 'rejected') return false;
    if (!h.decided_at) return false;
    const d = new Date(h.decided_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;

  const sortedPending = useMemo(() => sortItems(pending, pendingSort.col, pendingSort.dir), [pending, pendingSort]);
  const sortedHistory = useMemo(() => sortItems(history, historySort.col, historySort.dir), [history, historySort]);

  const pendingTotalPages = Math.max(1, Math.ceil(pending.length / PAGE_LIMIT));
  const historyTotalPages = Math.max(1, Math.ceil(history.length / PAGE_LIMIT));

  const pagedPending = useMemo(() => {
    const start = (pendingPage - 1) * PAGE_LIMIT;
    return sortedPending.slice(start, start + PAGE_LIMIT);
  }, [sortedPending, pendingPage]);

  const pagedHistory = useMemo(() => {
    const start = (historyPage - 1) * PAGE_LIMIT;
    return sortedHistory.slice(start, start + PAGE_LIMIT);
  }, [sortedHistory, historyPage]);

  const busyTaskIds = useMemo(
    () => new Set(factoryActionInProgress?.taskIds || []),
    [factoryActionInProgress]
  );

  if (loading || factoryLoading) {
    return (
      <div className="p-6">
        <LoadingSkeleton lines={5} />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="heading-lg text-white">Approvals</h2>
        <p className="text-slate-400 text-sm mt-1">Review and act on pending approval requests</p>
      </div>

      <section
        aria-labelledby="factory-task-approvals-heading"
        className={`mb-6 rounded-2xl border p-4 md:p-5 ${
          highlightedSource
            ? 'border-blue-500/40 bg-blue-500/5 shadow-[0_0_0_1px_rgba(59,130,246,0.1)]'
            : 'border-slate-700/60 bg-slate-800/30'
        }`}
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 id="factory-task-approvals-heading" className="text-base font-semibold text-white">
                Factory Task Approvals
              </h3>
              <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-300">
                {factoryBatches.reduce((sum, batch) => sum + batch.count, 0)} pending
              </span>
              {highlightedSource && (
                <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] font-medium text-blue-300">
                  Source: Factory
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-400">
              Grouped by factory batch. Approve or reject held execution tasks without leaving the dashboard.
            </p>
            {projectFilter && (
              <p className="mt-2 text-xs text-blue-300">
                Project filter: {projectFilter}
              </p>
            )}
          </div>
        </div>

        {factoryBatches.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-slate-700/70 bg-slate-900/40 px-4 py-6 text-sm text-slate-400">
            No tasks awaiting approval.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {factoryBatches.map((batch) => (
              <FactoryBatchCard
                key={batch.batchId}
                batch={batch}
                expanded={expandedFactoryBatches[batch.batchId] !== false}
                highlighted={highlightedSource}
                onToggle={(batchId) =>
                  setExpandedFactoryBatches((prev) => ({
                    ...prev,
                    [batchId]: prev[batchId] === false,
                  }))
                }
                onApproveBatch={(currentBatch) => handleFactoryBatchAction(currentBatch, 'approve')}
                onRejectBatch={(currentBatch) => handleFactoryBatchAction(currentBatch, 'reject')}
                onApproveTask={(task) => handleFactoryTaskAction(task, 'approve')}
                onRejectTask={(task) => handleFactoryTaskAction(task, 'reject')}
                busyTaskIds={busyTaskIds}
                busyBatchId={factoryActionInProgress?.batchId || null}
              />
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <StatCard label="Pending" value={pending.length} gradient="orange" />
        <StatCard label="Approved Today" value={approvedToday} gradient="green" />
        <StatCard label="Rejected Today" value={rejectedToday} gradient="red" />
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-4 border-b border-slate-700/50">
        <button
          onClick={() => setActiveTab('pending')}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
            activeTab === 'pending'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          Pending
          {pending.length > 0 && (
            <span className="ml-2 px-1.5 py-0.5 bg-orange-500/20 text-orange-400 text-xs rounded-full">
              {pending.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
            activeTab === 'history'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          History
        </button>
      </div>

      {/* Pending table */}
      {activeTab === 'pending' && (
        <>
          <div className="glass-card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-700/50">
                  <th scope="col" className="text-left p-4 heading-sm">ID</th>
                  <th scope="col" className="text-left p-4 heading-sm">Description</th>
                  <th scope="col" className="text-left p-4 heading-sm">Rule</th>
                  <SortHeader column="created_at" label="Created At" sortCol={pendingSort.col} sortDir={pendingSort.dir} onSort={makeSort(setPendingSort)} />
                  <th scope="col" className="text-left p-4 heading-sm">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedPending.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-slate-500">
                      No pending approvals
                    </td>
                  </tr>
                ) : (
                  pagedPending.map((item) => (
                    <tr
                      key={item.id}
                      className="border-b border-slate-700/30 hover:bg-slate-700/30 transition-colors"
                    >
                      <td className="p-4">
                        <code className="text-xs text-slate-400 font-mono bg-slate-800 px-2 py-0.5 rounded">
                          {truncateId(item.id)}
                        </code>
                      </td>
                      <td className="p-4">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          {item.approval_type === 'study_proposal' && (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[11px] font-medium">
                              Study Proposal
                            </span>
                          )}
                          {item.kind && (
                            <span className="px-2 py-0.5 rounded-full bg-slate-700 text-slate-300 text-[11px] font-medium">
                              {item.kind}
                            </span>
                          )}
                        </div>
                        <p className="text-white text-sm">
                          {item.description || item.task_description || '-'}
                        </p>
                        {item.rationale && (
                          <p className="text-slate-400 text-xs mt-1">
                            {item.rationale}
                          </p>
                        )}
                        <StudyTraceDetails item={item} />
                        {item.task_id && (
                          <p className="text-slate-500 text-xs mt-0.5">
                            Task: {truncateId(item.task_id)}
                          </p>
                        )}
                        {Array.isArray(item.files) && item.files.length > 0 && (
                          <p className="text-slate-500 text-xs mt-1">
                            Files: {item.files.slice(0, 3).join(', ')}
                            {item.files.length > 3 ? ` +${item.files.length - 3} more` : ''}
                          </p>
                        )}
                        {Array.isArray(item.related_tests) && item.related_tests.length > 0 && (
                          <p className="text-slate-500 text-xs mt-1">
                            Tests: {item.related_tests.slice(0, 2).join(', ')}
                            {item.related_tests.length > 2 ? ` +${item.related_tests.length - 2} more` : ''}
                          </p>
                        )}
                        {Array.isArray(item.validation_commands) && item.validation_commands.length > 0 && (
                          <p className="text-slate-500 text-xs mt-1 break-all">
                            Validate: {formatCommandPreview(item.validation_commands)}
                          </p>
                        )}
                      </td>
                      <td className="p-4">
                        <span className="text-slate-300 text-sm">
                          {item.rule || item.approval_rule || '-'}
                        </span>
                      </td>
                      <td className="p-4 text-slate-300 text-sm">
                        {formatDate(item.created_at)}
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleApprove(item.id)}
                            disabled={actionInProgress?.id === item.id}
                            className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors"
                          >
                            {actionInProgress?.id === item.id && actionInProgress.action === 'approve' ? 'Approving...' : 'Approve'}
                          </button>
                          <button
                            onClick={() => handleReject(item.id)}
                            disabled={actionInProgress?.id === item.id}
                            className="text-xs px-3 py-1.5 rounded bg-red-600/20 hover:bg-red-600/40 text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                          >
                            {actionInProgress?.id === item.id && actionInProgress.action === 'reject' ? 'Rejecting...' : 'Reject'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {pending.length > PAGE_LIMIT && (
            <Pagination page={pendingPage} totalPages={pendingTotalPages} total={pending.length} onPage={setPendingPage} />
          )}
        </>
      )}

      {/* History table */}
      {activeTab === 'history' && (
        <>
          <div className="glass-card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-700/50">
                  <th scope="col" className="text-left p-4 heading-sm">ID</th>
                  <th scope="col" className="text-left p-4 heading-sm">Description</th>
                  <SortHeader column="decision" label="Decision" sortCol={historySort.col} sortDir={historySort.dir} onSort={makeSort(setHistorySort)} />
                  <th scope="col" className="text-left p-4 heading-sm">Decided By</th>
                  <SortHeader column="decided_at" label="Decided At" sortCol={historySort.col} sortDir={historySort.dir} onSort={makeSort(setHistorySort)} />
                </tr>
              </thead>
              <tbody>
                {pagedHistory.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-slate-500">
                      No approval history
                    </td>
                  </tr>
                ) : (
                  pagedHistory.map((item) => (
                    <tr
                      key={item.id}
                      className="border-b border-slate-700/30 hover:bg-slate-700/30 transition-colors"
                    >
                      <td className="p-4">
                        <code className="text-xs text-slate-400 font-mono bg-slate-800 px-2 py-0.5 rounded">
                          {truncateId(item.id)}
                        </code>
                      </td>
                      <td className="p-4">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          {item.approval_type === 'study_proposal' && (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[11px] font-medium">
                              Study Proposal
                            </span>
                          )}
                          {item.kind && (
                            <span className="px-2 py-0.5 rounded-full bg-slate-700 text-slate-300 text-[11px] font-medium">
                              {item.kind}
                            </span>
                          )}
                        </div>
                        <p className="text-white text-sm">
                          {item.description || item.task_description || '-'}
                        </p>
                        {item.rationale && (
                          <p className="text-slate-400 text-xs mt-1">
                            {item.rationale}
                          </p>
                        )}
                        <StudyTraceDetails item={item} />
                      </td>
                      <td className="p-4">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            item.decision === 'approved'
                              ? 'bg-green-500/20 text-green-400'
                              : item.decision === 'rejected'
                              ? 'bg-red-500/20 text-red-400'
                              : 'bg-slate-500/20 text-slate-400'
                          }`}
                        >
                          {item.decision || '-'}
                        </span>
                      </td>
                      <td className="p-4 text-slate-300 text-sm">
                        {item.decided_by || '-'}
                      </td>
                      <td className="p-4 text-slate-300 text-sm">
                        {formatDate(item.decided_at)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {history.length > PAGE_LIMIT && (
            <Pagination page={historyPage} totalPages={historyTotalPages} total={history.length} onPage={setHistoryPage} />
          )}
        </>
      )}
    </div>
  );
}
