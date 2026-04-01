import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { tasks as tasksApi, stats as statsApi, providers as providersApi } from '../api';
import { useToast } from '../components/Toast';
import { useAbortableRequest } from '../hooks/useAbortableRequest';
import { getRelevantModel } from '../utils/providerModels';
import { STATUS_ICONS } from '../constants';
import { format as dateFnsFormat } from 'date-fns';
import StatCard from '../components/StatCard';
import TaskSubmitForm from '../components/TaskSubmitForm';
import HealthBar from '../components/HealthBar';
import ActivityPanel from '../components/ActivityPanel';
import {
  LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

const COLUMN_SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'provider', label: 'By provider' },
];

const COMMON_PROVIDER_OPTIONS = [
  'codex',
  'claude-cli',
  'ollama',
  'ollama-cloud',
  'anthropic',
  'cerebras',
  'groq',
  'deepinfra',
  'hyperbolic',
  'google-ai',
  'openrouter',
];

function buildProviderOptions(providerList, currentProvider) {
  const liveProviders = new Map(
    (Array.isArray(providerList) ? providerList : [])
      .map((entry) => {
        const provider = typeof entry === 'string' ? entry : entry?.provider;
        if (!provider) return null;
        return [
          provider,
          {
            value: provider,
            label: provider,
            enabled: typeof entry === 'object' ? entry.enabled !== false : true,
          },
        ];
      })
      .filter(Boolean)
  );

  const orderedProviders = [...COMMON_PROVIDER_OPTIONS];
  if (currentProvider && !orderedProviders.includes(currentProvider)) {
    orderedProviders.push(currentProvider);
  }

  return orderedProviders.map((provider) => liveProviders.get(provider) || {
    value: provider,
    label: provider,
    enabled: true,
  });
}

function sortTasks(tasks, sortKey) {
  const sorted = [...tasks];
  const timeKey = (t) => t.completed_at || t.created_at || 0;
  switch (sortKey) {
    case 'oldest':
      sorted.sort((a, b) => new Date(timeKey(a)) - new Date(timeKey(b)));
      break;
    case 'provider':
      sorted.sort((a, b) => (a.provider || '').localeCompare(b.provider || ''));
      break;
    case 'newest':
    default:
      sorted.sort((a, b) => new Date(timeKey(b)) - new Date(timeKey(a)));
      break;
  }
  return sorted;
}

function getTaskAge(createdAt, now = Date.now()) {
  if (!createdAt) return null;
  const hours = (now - new Date(createdAt).getTime()) / 3600000;
  if (hours < 1) return null;
  if (hours < 24) return { label: `${Math.floor(hours)}h`, color: 'text-slate-500' };
  const days = Math.floor(hours / 24);
  if (days < 3) return { label: `${days}d`, color: 'text-yellow-400' };
  return { label: `${days}d`, color: 'text-red-400' };
}

function LastRefreshed({ timestamp }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);
  if (!timestamp) return null;
  const secs = Math.floor((Date.now() - timestamp) / 1000);
  if (secs < 5) return <span className="text-xs text-slate-600">just now</span>;
  if (secs < 60) return <span className="text-xs text-slate-600">{secs}s ago</span>;
  return <span className="text-xs text-slate-600">{Math.floor(secs / 60)}m ago</span>;
}

const STATUS_COLUMNS = [
  { id: 'queued', label: 'Queued', color: 'bg-slate-500', dotColor: 'bg-slate-400' },
  { id: 'running', label: 'Running', color: 'bg-blue-500', dotColor: 'bg-blue-400' },
  { id: 'completed', label: 'Completed', color: 'bg-green-500', dotColor: 'bg-green-400' },
  { id: 'failed', label: 'Failed', color: 'bg-red-500', dotColor: 'bg-red-400' },
  { id: 'cancelled', label: 'Cancelled', color: 'bg-amber-500', dotColor: 'bg-amber-400' },
  { id: 'pending_provider_switch', label: 'Pending Switch', color: 'bg-orange-500', dotColor: 'bg-orange-400' },
];

function formatElapsed(startedAt, now = Date.now()) {
  if (!startedAt) return null;
  const secs = Math.floor((now - new Date(startedAt).getTime()) / 1000);
  const mins = Math.floor(secs / 60);
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function formatStuckDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

function normalizeStuckTasks(stuckData) {
  if (!stuckData) return null;
  return {
    total_needs_attention: stuckData.total_needs_attention ?? 0,
    long_running: stuckData.long_running ?? { tasks: [] },
    pending_approval: stuckData.pending_approval ?? { tasks: [] },
    pending_switch: stuckData.pending_switch ?? { tasks: [] },
  };
}

function getTaskActivityTarget(task) {
  if (task.ollama_host_name) return task.ollama_host_name;
  if (task.ollama_host_id) return task.ollama_host_id;
  return task.provider || 'scheduler';
}

function buildTaskActivityEvent(task, previousTask) {
  const shortId = task.id?.substring(0, 8) || 'unknown';
  const target = getTaskActivityTarget(task);
  const timestamp = new Date().toISOString();

  if (previousTask?.provider && previousTask.provider !== task.provider) {
    return {
      type: 'task_update',
      message: `Task ${shortId} reassigned from ${previousTask.provider} to ${task.provider || 'scheduler'}`,
      timestamp,
      severity: 'info',
    };
  }

  switch (task.status) {
    case 'completed':
      return {
        type: 'task_complete',
        message: `Task ${shortId} completed on ${target}`,
        timestamp,
        severity: 'success',
      };
    case 'failed':
      return {
        type: 'task_fail',
        message: `Task ${shortId} failed on ${target}`,
        timestamp,
        severity: 'error',
      };
    case 'running':
      return {
        type: 'task_update',
        message: `Task ${shortId} started on ${target}`,
        timestamp,
        severity: 'info',
      };
    case 'cancelled':
      return {
        type: 'task_update',
        message: `Task ${shortId} was cancelled on ${target}`,
        timestamp,
        severity: 'warning',
      };
    case 'pending_provider_switch':
      return {
        type: 'task_update',
        message: `Task ${shortId} is pending provider switch on ${target}`,
        timestamp,
        severity: 'warning',
      };
    case 'queued':
    default:
      return {
        type: 'task_update',
        message: `Task ${shortId} queued on ${target}`,
        timestamp,
        severity: 'info',
      };
  }
}

// Self-ticking queue wait time with color coding — owns its own timer
function QueueAge({ createdAt }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
  const mins = Math.floor(secs / 60);
  const color = mins >= 5 ? 'text-red-400' : mins >= 1 ? 'text-yellow-400' : 'text-slate-400';
  const label = mins > 0 ? `${mins}m` : `${secs}s`;
  return <span className={`font-mono ${color}`} title="Queue wait time">{label}</span>;
}

// Self-ticking elapsed timer — owns its own timer, parent card does not re-render
function LiveElapsed({ startedAt }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="text-blue-400 font-mono">{formatElapsed(startedAt)}</span>;
}

const TaskCard = memo(function TaskCard({
  task,
  onAction,
  onOpenDrawer,
  compact,
  flash,
  isPinned,
  onPin,
  hostActivity,
  providerList,
  selectedProvider,
  isReassigning,
  onProviderSelectionChange,
  onReassignProvider,
}) {
  const providerColor = task.provider === 'claude-cli' ? 'bg-purple-600' : task.provider === 'ollama' ? 'bg-emerald-600' : 'bg-blue-600';

  const shortId = task.id?.substring(0, 8) || 'unknown';
  const hostLabel = task.ollama_host_name || task.ollama_host_id;
  const gpuActive = task.status === 'running' ? task.gpu_active : undefined;
  const age = getTaskAge(task.created_at);
  const hostAct = task.status === 'running' && task.ollama_host_id
    ? hostActivity?.hosts?.[task.ollama_host_id] : null;
  const gpu = hostAct?.gpuMetrics || null;
  const providerOptions = useMemo(
    () => buildProviderOptions(providerList, task.provider),
    [providerList, task.provider]
  );
  const canReassign = task.status === 'queued'
    && !!selectedProvider
    && selectedProvider !== task.provider
    && !isReassigning;

  return (
    <div
      onClick={() => onOpenDrawer?.(task.id)}
      role="listitem"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          onOpenDrawer?.(task.id);
        }
      }}
      className={`bg-slate-700/60 border ${isPinned ? 'border-amber-500/40' : 'border-slate-600/30'} rounded-lg ${compact ? 'p-2 mb-1' : 'p-3 mb-2'} cursor-pointer hover:bg-slate-600/60 hover:border-slate-500/50 transition-all ${flash ? 'animate-flash-update' : ''}`}
    >
      <div className={`flex items-start gap-2 ${compact ? 'mb-1' : 'mb-2'}`}>
        <button
          onClick={(e) => { e.stopPropagation(); onPin?.(task.id); }}
          className={`shrink-0 pt-0.5 transition-colors ${isPinned ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'}`}
          title={isPinned ? 'Unpin' : 'Pin to top'}
        >
          <svg className="w-3 h-3" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        </button>
        <code className="text-[10px] text-slate-500 font-mono select-all shrink-0 pt-0.5">{shortId}</code>
        <p className={`text-white flex-1 leading-snug ${compact ? 'text-xs line-clamp-1' : 'text-sm line-clamp-2'}`}>
          {task.task_description}
        </p>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Provider + model combined */}
          <span className={`px-1.5 py-0.5 rounded text-[10px] text-white ${providerColor}`}>
            {task.provider || 'codex'}{(() => { const m = getRelevantModel(task.provider, task.model); return m ? ` · ${m}` : ''; })()}
          </span>
          {task.quality_score != null && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] ${
              task.quality_score >= 80 ? 'text-green-300 bg-green-600/30' :
              task.quality_score >= 60 ? 'text-yellow-300 bg-yellow-600/30' :
              'text-red-300 bg-red-600/30'
            }`}>
              Q:{task.quality_score}
            </span>
          )}
          {/* Host + GPU status combined */}
          {hostLabel && (
            <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${
              gpuActive === true ? 'text-green-300 bg-green-600/30' :
              gpuActive === false ? 'text-slate-400 bg-slate-600/30' :
              'text-teal-300 bg-teal-600/30'
            }`}>
              {gpuActive === true && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
              {gpuActive === false && <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />}
              {hostLabel}
            </span>
          )}
          {/* GPU badge for running tasks without a host label (shouldn't happen, but fallback) */}
          {!hostLabel && gpuActive === true && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-green-300 bg-green-600/30">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              GPU
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-slate-400">
          {STATUS_ICONS[task.status] && (
            <span aria-hidden="true" className="text-[11px] font-mono text-slate-500" title={task.status}>
              {STATUS_ICONS[task.status]}
            </span>
          )}
          {task.status === 'running' && task.started_at && (
            <LiveElapsed startedAt={task.started_at} />
          )}
          {task.status === 'completed' && task.completed_at && (
            <span className="text-green-400">
              {dateFnsFormat(new Date(task.completed_at), 'hh:mm aa')}
            </span>
          )}
          {task.status === 'failed' && (
            <>
              {task.completed_at && (
                <span className="text-red-400">
                  {dateFnsFormat(new Date(task.completed_at), 'hh:mm aa')}
                </span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onAction(task.id, 'retry'); }}
                className="text-blue-400 hover:text-blue-300 font-medium"
              >
                Retry
              </button>
            </>
          )}
          {task.status === 'cancelled' && (
            <>
              {task.completed_at && (
                <span className="text-amber-400">
                  {dateFnsFormat(new Date(task.completed_at), 'hh:mm aa')}
                </span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onAction(task.id, 'retry'); }}
                className="text-blue-400 hover:text-blue-300 font-medium"
              >
                Retry
              </button>
            </>
          )}
          {task.status === 'pending_provider_switch' && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onAction(task.id, 'approve-switch'); }}
                className="text-orange-400 hover:text-orange-300 font-medium"
              >
                Approve
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onAction(task.id, 'reject-switch'); }}
                className="text-red-400 hover:text-red-300 font-medium"
              >
                Reject
              </button>
            </>
          )}
          {task.status === 'queued' && task.created_at && (
            <QueueAge createdAt={task.created_at} />
          )}
          {age && (
            <span className={`text-[10px] font-mono ${age.color}`} title="Task age">{age.label}</span>
          )}
        </div>
      </div>
      {/* Error preview for failed tasks */}
      {task.status === 'failed' && task.error_output && (
        <p className="text-[10px] text-red-400/80 mt-1.5 line-clamp-1 leading-snug">
          {task.error_output.substring(0, 100)}
        </p>
      )}
      {task.status === 'queued' && (
        <div className="mt-2 flex items-center gap-2">
          <select
            aria-label={`Reassign provider for task ${shortId}`}
            value={selectedProvider || task.provider || COMMON_PROVIDER_OPTIONS[0]}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              e.stopPropagation();
              onProviderSelectionChange?.(task.id, e.target.value);
            }}
            className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-[11px] text-slate-200"
          >
            {providerOptions.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.enabled === false}
              >
                {option.label}
                {option.enabled === false ? ' (disabled)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label={`Apply provider reassignment for task ${shortId}`}
            disabled={!canReassign}
            onClick={(e) => {
              e.stopPropagation();
              onReassignProvider?.(task);
            }}
            className="shrink-0 rounded border border-slate-600 px-2 py-1 text-[11px] font-medium text-blue-300 transition-colors enabled:hover:border-blue-400 enabled:hover:text-blue-200 disabled:cursor-not-allowed disabled:text-slate-500"
          >
            {isReassigning ? 'Assigning...' : 'Reassign'}
          </button>
        </div>
      )}
      {/* VRAM utilization bar for running tasks */}
      {gpu && gpu.vramTotalMb > 0 && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-slate-600/50 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all bg-gradient-to-r from-blue-500 to-purple-500"
              style={{ width: `${Math.min(100, (gpu.vramUsedMb / gpu.vramTotalMb) * 100)}%` }}
            />
          </div>
          <span className="text-[9px] text-slate-500 shrink-0">
            {(gpu.vramUsedMb / 1024).toFixed(1)}/{(gpu.vramTotalMb / 1024).toFixed(1)}G
          </span>
        </div>
      )}
      {/* VRAM bar for remote hosts (from /api/ps, no nvidia-smi) */}
      {!gpu && hostAct?.totalVramUsed > 0 && hostAct?.memoryLimitMb > 0 && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-slate-600/50 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all bg-gradient-to-r from-blue-500 to-purple-500"
              style={{ width: `${Math.min(100, (hostAct.totalVramUsed / (1024 * 1024)) / hostAct.memoryLimitMb * 100)}%` }}
            />
          </div>
          <span className="text-[9px] text-slate-500 shrink-0">
            {(hostAct.totalVramUsed / (1024 * 1024 * 1024)).toFixed(1)}/{(hostAct.memoryLimitMb / 1024).toFixed(0)}G
          </span>
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  const p = prev.task, n = next.task;
  return p.id === n.id && p.status === n.status && p.quality_score === n.quality_score
    && p.started_at === n.started_at && p.completed_at === n.completed_at
    && p.provider === n.provider && p.model === n.model
    && p.ollama_host_id === n.ollama_host_id && p.ollama_host_name === n.ollama_host_name
    && p.gpu_active === n.gpu_active && p.error_output === n.error_output
    && prev.isPinned === next.isPinned && prev.hostActivity === next.hostActivity
    && prev.selectedProvider === next.selectedProvider
    && prev.isReassigning === next.isReassigning
    && prev.providerList === next.providerList;
});

const KanbanColumn = memo(function KanbanColumn({
  label,
  // eslint-disable-next-line no-unused-vars
  color,
  dotColor,
  tasks,
  count,
  onAction,
  onOpenDrawer,
  collapsed,
  onToggle,
  compact,
  sortKey,
  onSortChange,
  flashIds,
  pinnedIds,
  onPin,
  hostActivity,
  providerList,
  queuedProviderSelections,
  reassigningIds,
  onProviderSelectionChange,
  onReassignProvider,
}) {
  const displayTasks = useMemo(() => {
    const sorted = sortTasks(tasks, sortKey);
    if (pinnedIds?.size > 0) {
      const pinned = sorted.filter((t) => pinnedIds.has(t.id));
      const unpinned = sorted.filter((t) => !pinnedIds.has(t.id));
      return [...pinned, ...unpinned];
    }
    return sorted;
  }, [tasks, sortKey, pinnedIds]);

  return (
    <div className={collapsed ? 'w-12 shrink-0' : 'flex-1 min-w-0 md:min-w-[240px] md:max-w-[300px]'}>
      <div
        className={`flex items-center gap-2 mb-3 px-1 ${collapsed ? 'flex-col cursor-pointer select-none' : ''}`}
        onClick={collapsed ? onToggle : undefined}
        title={collapsed ? `Expand ${label}` : undefined}
        role={collapsed ? 'button' : undefined}
        tabIndex={collapsed ? 0 : undefined}
        aria-expanded={collapsed ? false : undefined}
        aria-label={collapsed ? `Expand ${label}` : undefined}
        onKeyDown={collapsed ? (e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            onToggle();
          }
        } : undefined}
      >
        <button
          type="button"
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColor} ${!collapsed ? 'cursor-pointer' : ''}`}
          onClick={!collapsed ? onToggle : undefined}
          aria-label={`Collapse ${label}`}
          aria-expanded={!collapsed}
          title={`Collapse ${label}`}
        />
        {collapsed ? (
          <span className="text-slate-400 text-[10px] font-medium writing-vertical" style={{ writingMode: 'vertical-rl' }}>{label}</span>
        ) : (
          <>
            <h3 className="font-medium text-white text-sm">{label}</h3>
            <span className="bg-slate-700/60 text-slate-400 text-xs px-2 py-0.5 rounded-full font-medium">
              {count != null ? count : tasks.length}
            </span>
            <select
              aria-label="Sort tasks"
              value={sortKey}
              onChange={(e) => onSortChange(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="ml-auto bg-transparent text-slate-500 text-[10px] border-none outline-none cursor-pointer hover:text-slate-300"
            >
              {COLUMN_SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} className="bg-slate-800">{o.label}</option>
              ))}
            </select>
          </>
        )}
      </div>
      {!collapsed && (
        <div role="list" aria-label={label} className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-2 min-h-[400px] max-h-[calc(100vh-320px)] overflow-y-auto">
          {displayTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onAction={onAction}
              onOpenDrawer={onOpenDrawer}
              compact={compact}
              flash={flashIds?.has(task.id)}
              isPinned={pinnedIds?.has(task.id)}
              onPin={onPin}
              hostActivity={hostActivity}
              providerList={providerList}
              selectedProvider={queuedProviderSelections?.[task.id] || task.provider || COMMON_PROVIDER_OPTIONS[0]}
              isReassigning={reassigningIds?.has(task.id)}
              onProviderSelectionChange={onProviderSelectionChange}
              onReassignProvider={onReassignProvider}
            />
          ))}
          {tasks.length === 0 && (
            <p className="text-slate-600 text-sm text-center py-8">No tasks</p>
          )}
        </div>
      )}
    </div>
  );
});

const NeedsAttentionCard = memo(function NeedsAttentionCard({ task, reason, onOpenDrawer }) {
  const shortId = task.id?.substring(0, 8) || 'unknown';
  return (
    <div
      onClick={() => onOpenDrawer?.(task.id)}
      className="bg-amber-900/30 border border-amber-600/40 rounded-lg p-2 cursor-pointer hover:bg-amber-800/40 transition-all"
    >
      <div className="flex items-center justify-between gap-2">
        <code className="text-[10px] text-amber-400 font-mono">{shortId}</code>
        <span className="text-[10px] text-amber-300">{reason}</span>
      </div>
      <p className="text-xs text-white/80 line-clamp-1 mt-1">
        {task.task_description?.substring(0, 60)}...
      </p>
    </div>
  );
});

export default function Kanban({ tasks: liveTasks, onOpenDrawer, hostActivity, statsVersion, tasksTick, wsStats }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [allTasks, setAllTasks] = useState([]);
  const [providerList, setProviderList] = useState([]);
  const [overview, setOverview] = useState(null);
  const [stuckTasks, setStuckTasks] = useState(null);
  const [qualityStats, setQualityStats] = useState(null);
  const [activityData, setActivityData] = useState([]);
  const [activityLog, setActivityLog] = useState([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [staleData, setStaleData] = useState(false);
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem('torque-density') === 'compact'; } catch { return false; }
  });
  const [columnSorts, setColumnSorts] = useState(() => {
    try { return JSON.parse(localStorage.getItem('torque-col-sorts')) || {}; } catch { return {}; }
  });
  const [collapsedCols, setCollapsedCols] = useState(() => {
    try { return JSON.parse(localStorage.getItem('torque-collapsed-cols')) || {}; } catch { return {}; }
  });
  const [flashIds, setFlashIds] = useState(new Set());
  const flashTimeoutRef = useRef(null);
  const [pinnedIds, setPinnedIds] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('torque-pinned') || '[]')); } catch { return new Set(); }
  });
  const [hiddenCols, setHiddenCols] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('torque-hidden-cols') || '[]')); } catch { return new Set(); }
  });
  const [showColMenu, setShowColMenu] = useState(false);
  const colMenuRef = useRef(null);
  const [searchInput, setSearchInput] = useState(() => searchParams.get('q') || '');
  const [searchQuery, setSearchQuery] = useState(() => (searchParams.get('q') || '').trim().toLowerCase());
  const searchTimerRef = useRef(null);
  const prevTaskMapRef = useRef(new Map());
  const prevLiveIdsRef = useRef(new Set()); // Track WS-pushed task IDs for deletion detection (RB-056)
  const hasInitializedLiveTasksRef = useRef(false);
  const failCountRef = useRef(0);
  const debounceRefetchRef = useRef(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [showSubmitForm, setShowSubmitForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // now state removed — clock components (LiveElapsed, QueueAge, LastRefreshed)
  // each own their own timer to avoid re-rendering the entire Kanban every second
  const [queuedProviderSelections, setQueuedProviderSelections] = useState({});
  const [reassigningIds, setReassigningIds] = useState(new Set());
  const toast = useToast();
  const { execute } = useAbortableRequest();
  const appendActivityEvents = useCallback((events) => {
    if (!Array.isArray(events) || events.length === 0) return;
    setActivityLog((prev) => [...events, ...prev].slice(0, 100));
  }, []);
  const toggleActivityPanel = useCallback(() => {
    setActivityOpen((value) => !value);
  }, []);


  useEffect(() => {
    if (!showColMenu) return;
    const handler = (e) => { if (!colMenuRef.current?.contains(e.target)) setShowColMenu(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showColMenu]);

  function toggleColumn(colId) {
    setCollapsedCols((prev) => {
      const next = { ...prev, [colId]: !prev[colId] };
      try { localStorage.setItem('torque-collapsed-cols', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function toggleColumnVisibility(colId) {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId); else next.add(colId);
      try { localStorage.setItem('torque-hidden-cols', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }

  function toggleDensity() {
    setCompact((prev) => {
      const next = !prev;
      try { localStorage.setItem('torque-density', next ? 'compact' : 'comfortable'); } catch { /* ignore */ }
      return next;
    });
  }

  const setColumnSort = useCallback((colId, sortKey) => {
    setColumnSorts((prev) => {
      const next = { ...prev, [colId]: sortKey };
      try { localStorage.setItem('torque-col-sorts', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const togglePin = useCallback((taskId) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
      try { localStorage.setItem('torque-pinned', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const handleSearchChange = useCallback((value) => {
    setSearchInput(value);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setSearchQuery(value.trim().toLowerCase());
    }, 200);
  }, []);

  useEffect(() => {
    return () => clearTimeout(searchTimerRef.current);
  }, []);

  // Sync search query to URL params
  useEffect(() => {
    const params = {};
    if (searchQuery) params.q = searchQuery;
    setSearchParams(params, { replace: true });
  }, [searchQuery, setSearchParams]);

  const mergeTasks = useCallback((freshTasks) => {
    setAllTasks((prev) => {
      const restMap = new Map(freshTasks.map(t => [t.id, t]));
      const merged = new Map();
      for (const t of freshTasks) merged.set(t.id, t);
      for (const t of prev) {
        if (!merged.has(t.id)) merged.set(t.id, t); // keep tasks from other columns
        const rest = restMap.get(t.id);
        if (rest && t.updated_at && rest.updated_at && t.updated_at > rest.updated_at) {
          merged.set(t.id, t);
        }
      }
      return Array.from(merged.values());
    });
  }, []);

  // Full load — all columns + supplementary stats
  const loadData = useCallback(() => {
    return execute(async (isCurrent) => {
      try {
        // Phase 1: critical data first — gets the board visible fast
        const [queuedData, runningData, pendingData, overviewData] = await Promise.all([
          tasksApi.list({ status: 'queued', limit: 50 }),
          tasksApi.list({ status: 'running', limit: 50 }),
          tasksApi.list({ status: 'pending_provider_switch', limit: 20 }),
          statsApi.overview(),
        ]);
        if (!isCurrent()) return;
        mergeTasks([...queuedData.tasks, ...runningData.tasks, ...pendingData.tasks]);
        setOverview(overviewData);
        setLoading(false);

        // Phase 2: supplementary data — fills in completed/failed/cancelled + charts
        const [completedData, failedData, cancelledData, stuckData, qualityData, timeseriesData, providerData] = await Promise.all([
          tasksApi.list({ status: 'completed', limit: 30, orderBy: 'completed_at', orderDir: 'desc' }),
          tasksApi.list({ status: 'failed', limit: 30, orderBy: 'completed_at', orderDir: 'desc' }),
          tasksApi.list({ status: 'cancelled', limit: 30, orderBy: 'completed_at', orderDir: 'desc' }),
          statsApi.stuck().catch(() => null),
          statsApi.quality().catch(() => null),
          statsApi.timeseries({ days: 7 }).catch(() => []),
          providersApi.list().catch(() => []),
        ]);
        if (!isCurrent()) return;
        mergeTasks([...completedData.tasks, ...failedData.tasks, ...cancelledData.tasks]);
        setStuckTasks(normalizeStuckTasks(stuckData));
        setQualityStats(qualityData);
        setActivityData(Array.isArray(timeseriesData) ? timeseriesData : []);
        setProviderList(Array.isArray(providerData) ? providerData : []);
        failCountRef.current = 0;
        setStaleData(false);
        setLastRefreshed(Date.now());
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Failed to load kanban data:', err);
        failCountRef.current++;
        if (failCountRef.current >= 3) {
          setStaleData(true);
        }
        if (failCountRef.current === 1) {
          toast.error('Failed to load dashboard data');
        }
      } finally {
        if (isCurrent()) setLoading(false);
      }
    });
  }, [execute, toast, mergeTasks]);

  useEffect(() => {
    loadData();
    // Fallback polling at 120s — WebSocket events drive most updates via tasksTick/statsVersion
    let pollInterval = setInterval(loadData, 120000);

    function handleVisibility() {
      clearInterval(pollInterval);
      pollInterval = null;
      if (!document.hidden) {
        loadData();
        pollInterval = setInterval(loadData, 120000);
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    };
  }, [loadData]);

  // Debounced refetch on stats changes — coalesce rapid WebSocket events into one API round-trip.
  // Task mutations are already applied inline via WebSocket (App.jsx setTasks), so only stats
  // changes (overview, quality, timeseries) need a full refetch. Debounce at 5s to avoid hammering.
  useEffect(() => {
    if (statsVersion === 0) return;
    clearTimeout(debounceRefetchRef.current);
    debounceRefetchRef.current = setTimeout(() => loadData(), 5000);
    return () => clearTimeout(debounceRefetchRef.current);
  }, [statsVersion, loadData]);

  useEffect(() => {
    const currentLiveIds = new Set((liveTasks || []).map(t => t.id));
    const isInitialLiveSnapshot = !hasInitializedLiveTasksRef.current;

    // Detect tasks removed from the WS-managed prop (deleted) — RB-056
    const deletedIds = new Set();
    for (const id of prevLiveIdsRef.current) {
      if (!currentLiveIds.has(id)) deletedIds.add(id);
    }
    prevLiveIdsRef.current = currentLiveIds;

    // Clean up prevTaskMap for deleted tasks
    for (const id of deletedIds) prevTaskMapRef.current.delete(id);

    if (!liveTasks || liveTasks.length === 0) {
      // Only handle deletions when liveTasks is empty
      if (deletedIds.size > 0) {
        setAllTasks((prev) => prev.filter(t => !deletedIds.has(t.id)));
      }
      hasInitializedLiveTasksRef.current = true;
      return;
    }

    // Detect changed tasks for flash animation
    const changedIds = new Set();
    const activityEvents = [];
    for (const t of liveTasks) {
      const prev = prevTaskMapRef.current.get(t.id);
      const statusChanged = prev?.status !== t.status;
      const qualityChanged = prev?.quality_score !== t.quality_score;
      const providerChanged = prev?.provider !== t.provider;

      if (!prev || statusChanged || qualityChanged) {
        changedIds.add(t.id);
      }

      if (!isInitialLiveSnapshot && (!prev || statusChanged || providerChanged)) {
        activityEvents.unshift(buildTaskActivityEvent(t, prev));
      }
    }
    if (changedIds.size > 0) {
      setFlashIds(changedIds);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setFlashIds(new Set()), 900);
    }

    setAllTasks((prev) => {
      if (prev.length === 0) return liveTasks;
      const updates = new Map(liveTasks.map((t) => [t.id, t]));
      // Filter out deleted tasks, then merge updates with preserved API-fetched tasks
      const merged = prev
        .filter(t => !deletedIds.has(t.id))
        .map((t) => updates.get(t.id) || t);
      const existingIds = new Set(merged.map((t) => t.id));
      for (const task of liveTasks) {
        if (!existingIds.has(task.id)) merged.push(task);
      }
      // Update prev map
      for (const t of merged) prevTaskMapRef.current.set(t.id, t);
      return merged;
    });

    appendActivityEvents(activityEvents);
    hasInitializedLiveTasksRef.current = true;
  }, [appendActivityEvents, liveTasks]);

  useEffect(() => {
    setQueuedProviderSelections((prev) => {
      const next = { ...prev };
      const queuedIds = new Set();
      let changed = false;

      allTasks.forEach((task) => {
        if (task.status !== 'queued') return;
        queuedIds.add(task.id);
        const defaultProvider = task.provider || COMMON_PROVIDER_OPTIONS[0];
        if (!next[task.id]) {
          next[task.id] = defaultProvider;
          changed = true;
        }
      });

      Object.keys(next).forEach((taskId) => {
        if (!queuedIds.has(taskId)) {
          delete next[taskId];
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [allTasks]);

  async function handleManualRefresh() {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }

  async function handleAction(taskId, action) {
    try {
      let successMessage = 'Action completed';
      if (action === 'retry') {
        await tasksApi.retry(taskId);
        successMessage = 'Task queued for retry';
      } else if (action === 'approve-switch') {
        await tasksApi.approveSwitch(taskId);
        successMessage = 'Switch approved';
      } else if (action === 'reject-switch') {
        await tasksApi.rejectSwitch(taskId);
        successMessage = 'Switch rejected';
      }
      toast.success(successMessage);
      loadData();
    } catch (err) {
      console.error(`Action ${action} failed:`, err);
      toast.error(`${action} failed: ${err.message}`);
    }
  }

  const handleQueuedProviderSelectionChange = useCallback((taskId, provider) => {
    setQueuedProviderSelections((prev) => {
      if (prev[taskId] === provider) return prev;
      return { ...prev, [taskId]: provider };
    });
  }, []);

  async function handleReassignProvider(task) {
    const taskId = task?.id;
    const provider = queuedProviderSelections[taskId] || task?.provider || '';
    if (!taskId || !provider || provider === task?.provider) return;

    setReassigningIds((prev) => new Set([...prev, taskId]));
    try {
      await tasksApi.reassignProvider(taskId, provider);
      toast.success(`Provider reassigned to ${provider}`);
      await loadData();
    } catch (err) {
      console.error('Reassign failed:', err);
      toast.error(`Reassign failed: ${err.message}`);
    } finally {
      setReassigningIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }

  async function doRetryAllFailed() {
    const failed = allTasks.filter((t) => t.status === 'failed');
    if (failed.length === 0) return;
    let ok = 0;
    let errs = 0;
    for (const t of failed) {
      try {
        await tasksApi.retry(t.id);
        ok++;
      } catch {
        errs++;
      }
    }
    if (ok > 0) toast.success(`${ok} task${ok > 1 ? 's' : ''} queued for retry`);
    if (errs > 0) toast.error(`${errs} task${errs > 1 ? 's' : ''} failed to retry`);
    loadData();
  }

  function handleRetryAllFailed() {
    const failed = allTasks.filter((t) => t.status === 'failed');
    if (failed.length === 0) return;
    setShowConfirm({ action: 'retryAllFailed', count: failed.length });
  }

  async function confirmAction() {
    if (showConfirm?.action === 'retryAllFailed') {
      await doRetryAllFailed();
    }
    setShowConfirm(null);
  }

  const filteredTasks = useMemo(() => {
    if (!searchQuery) return allTasks;
    return allTasks.filter((t) =>
      (t.task_description || '').toLowerCase().includes(searchQuery) ||
      (t.id || '').toLowerCase().includes(searchQuery) ||
      (t.provider || '').toLowerCase().includes(searchQuery) ||
      (t.model || '').toLowerCase().includes(searchQuery)
    );
  }, [allTasks, searchQuery]);

  const tasksByStatus = useMemo(() => STATUS_COLUMNS.reduce((acc, col) => {
    acc[col.id] = filteredTasks.filter((t) => t.status === col.id);
    return acc;
  }, {}), [filteredTasks]);

  // Detect stuck tasks: running for more than 30 minutes (1800 seconds)
  const stuckRunningTasks = useMemo(() => {
    const STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
    const current = Date.now();
    return allTasks
      .filter((t) => t.status === 'running' && t.started_at && (current - new Date(t.started_at).getTime()) > STUCK_THRESHOLD_MS)
      .map((t) => ({
        ...t,
        runningSeconds: Math.floor((current - new Date(t.started_at).getTime()) / 1000),
      }))
      .sort((a, b) => b.runningSeconds - a.runningSeconds);
  }, [allTasks]);

  // Merge wsStats (flat: { running, queued, completed, failed }) into REST overview shape
  const effectiveOverview = useMemo(() => {
    if (!overview) return null;
    if (!wsStats) return overview;
    return {
      ...overview,
      active: {
        ...overview.active,
        running: wsStats.running ?? overview.active?.running ?? 0,
        queued: wsStats.queued ?? overview.active?.queued ?? 0,
      },
    };
  }, [overview, wsStats]);

  // True DB counts per status — wsStats (live) > overview.totals (REST fallback) > tasks.length
  const countByStatus = useMemo(() => {
    const totals = overview?.totals || {};
    return {
      running: wsStats?.running ?? totals.running,
      queued: wsStats?.queued ?? totals.queued,
      completed: wsStats?.completed ?? totals.completed,
      failed: wsStats?.failed ?? totals.failed,
      cancelled: totals.cancelled,
      pending_provider_switch: totals.pending_provider_switch,
    };
  }, [overview, wsStats]);

  const [cancellingIds, setCancellingIds] = useState(new Set());
  const [showConfirm, setShowConfirm] = useState(null);
  const mainContentClassName = activityOpen ? 'flex-1 overflow-auto pr-[300px]' : 'flex-1 overflow-auto';

  async function handleCancelStuck(taskId) {
    setCancellingIds((prev) => new Set([...prev, taskId]));
    try {
      await tasksApi.cancel(taskId);
      toast.success('Task cancelled');
      loadData();
    } catch (err) {
      console.error('Cancel failed:', err);
      toast.error(`Cancel failed: ${err.message}`);
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }

  if (loading) {
    return (
      <div className="flex">
        <div className={mainContentClassName}>
          <div className="p-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="glass-card p-4 animate-pulse">
                  <div className="h-3 w-20 bg-slate-700 rounded mb-2" />
                  <div className="h-6 w-12 bg-slate-700 rounded" />
                </div>
              ))}
            </div>
            <div className="flex gap-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="flex-1 min-w-[240px]">
                  <div className="h-4 w-16 bg-slate-700 rounded mb-3 animate-pulse" />
                  <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-2 min-h-[400px]">
                    {[...Array(3)].map((_, j) => (
                      <div key={j} className="bg-slate-700/40 rounded-lg p-3 mb-2 animate-pulse">
                        <div className="h-3 w-full bg-slate-600 rounded mb-2" />
                        <div className="h-2 w-2/3 bg-slate-600 rounded" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <ActivityPanel events={activityLog} isOpen={activityOpen} onToggle={toggleActivityPanel} />
      </div>
    );
  }

  const todayTotal = effectiveOverview?.today?.total || 0;
  const yesterdayTotal = effectiveOverview?.yesterday?.total || 0;
  const todayTrend = yesterdayTotal > 0
    ? Math.round(((todayTotal - yesterdayTotal) / yesterdayTotal) * 100)
    : null;

  return (
    <div className="flex">
      <div className={mainContentClassName}>
        <div className="p-6">
      {/* Stale data warning */}
      {staleData && (
        <div className="mb-4 flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-950/50 border border-amber-600/40 text-amber-300 text-sm">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          Data may be stale — server unreachable
        </div>
      )}

      {/* Stuck tasks alert banner */}
      {stuckRunningTasks.length > 0 && (
        <div className="mb-4 bg-amber-900/30 border border-amber-600/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-5 h-5 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <h3 className="text-amber-400 font-medium text-sm">
              {stuckRunningTasks.length} task{stuckRunningTasks.length !== 1 ? 's' : ''} may be stuck
            </h3>
          </div>
          <div className="space-y-2">
            {stuckRunningTasks.map((task) => (
              <div key={task.id} className="flex items-center justify-between gap-3 bg-amber-950/30 rounded-md px-3 py-2">
                <div className="flex items-center gap-3 min-w-0">
                  <code className="text-xs text-amber-200 font-mono shrink-0">{task.id?.substring(0, 8)}</code>
                  <span className="text-sm text-amber-200 truncate">{task.task_description?.substring(0, 60)}{task.task_description?.length > 60 ? '...' : ''}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-amber-200 font-mono">Running {formatStuckDuration(task.runningSeconds)}</span>
                  <button
                    onClick={() => handleCancelStuck(task.id)}
                    disabled={cancellingIds.has(task.id)}
                    className="px-3 py-1 bg-red-600/30 hover:bg-red-600/60 text-red-300 hover:text-white text-xs rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {cancellingIds.has(task.id) ? 'Cancelling...' : 'Cancel'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toolbar: density toggle + bulk actions */}
      <div className="flex flex-wrap items-center justify-between gap-y-2 mb-3">
        <div className="flex items-center gap-2">
          {/* Task count summary */}
          <span className="text-xs text-slate-500">
            {searchQuery ? `${filteredTasks.length} of ${allTasks.length}` : `${allTasks.length} total`}{' '}&middot;{' '}<LastRefreshed timestamp={lastRefreshed} />
            {(tasksByStatus.running?.length || 0) > 0 && <> &middot; <span className="text-blue-400">{tasksByStatus.running.length} running</span></>}
            {(tasksByStatus.failed?.length || 0) > 0 && <> &middot; <span className="text-red-400">{tasksByStatus.failed.length} failed</span></>}
          </span>
          {/* Bulk retry all failed */}
          {(tasksByStatus.failed?.length || 0) > 0 && (
            <button
              onClick={handleRetryAllFailed}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-600/20 border border-red-600/30 text-red-300 hover:bg-red-600/40 text-xs transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Retry all failed ({tasksByStatus.failed.length})
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSubmitForm((s) => !s)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              showSubmitForm
                ? 'bg-blue-600 text-white'
                : 'bg-blue-600/20 border border-blue-500/30 text-blue-400 hover:bg-blue-600/40'
            }`}
            aria-label="Toggle task submit form"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Submit Task
          </button>
          <button
            onClick={handleManualRefresh}
            disabled={refreshing}
            className="p-1.5 rounded-lg bg-slate-800/60 border border-slate-700/50 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
            title="Refresh data"
            aria-label="Refresh dashboard data"
          >
            <svg className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <div className="relative">
            <svg className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search tasks..."
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-48 bg-slate-800/60 border border-slate-700/50 rounded-lg pl-8 pr-8 py-1.5 text-white text-xs placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
            />
            {searchInput && (
              <button
                onClick={() => { setSearchInput(''); setSearchQuery(''); clearTimeout(searchTimerRef.current); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <button
            onClick={toggleDensity}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/50 text-slate-400 hover:text-white text-xs transition-colors"
            title={compact ? 'Switch to comfortable view' : 'Switch to compact view'}
          >
            {compact ? (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
            )}
            {compact ? 'Compact' : 'Comfortable'}
          </button>
          <div className="relative" ref={colMenuRef}>
            <button
              onClick={() => setShowColMenu((s) => !s)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/50 text-slate-400 hover:text-white text-xs transition-colors"
              title="Toggle column visibility"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              Columns
            </button>
            {showColMenu && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-slate-800 border border-slate-700 rounded-lg shadow-lg z-50 py-1">
                {STATUS_COLUMNS.map((col) => (
                  <label
                    key={col.id}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-700/50 cursor-pointer text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={!hiddenCols.has(col.id)}
                      onChange={() => toggleColumnVisibility(col.id)}
                      className="rounded border-slate-600 bg-slate-700 accent-blue-500"
                    />
                    <span className={`w-2 h-2 rounded-full ${col.dotColor}`} />
                    <span className="text-slate-300">{col.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Task submit form */}
      {showSubmitForm && (
        <TaskSubmitForm
          onClose={() => setShowSubmitForm(false)}
          onSubmitted={() => { setShowSubmitForm(false); handleManualRefresh(); }}
        />
      )}

      <HealthBar />

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {/* Today summary: count + success rate + quality merged */}
        <div className="stat-gradient-blue rounded-xl p-4 shadow-md card-hover">
          <p className="text-sm font-medium text-white/80">Today</p>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-bold text-white">{todayTotal}</p>
            {todayTrend !== undefined && todayTrend !== null && (
              <span className="text-sm font-medium text-white/90">
                {todayTrend > 0 ? '\u2191' : todayTrend < 0 ? '\u2193' : '\u2192'}{' '}
                {Math.abs(todayTrend)}%
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-white/60">
            <span>{effectiveOverview?.today?.successRate || 0}% success</span>
            {qualityStats?.overall?.avgScore != null && (
              <span>Q:{qualityStats.overall.avgScore}</span>
            )}
          </div>
        </div>
        <StatCard
          label="Running"
          value={effectiveOverview?.active?.running || 0}
          gradient={effectiveOverview?.active?.running > 0 ? 'cyan' : undefined}
        />
        <StatCard
          label="Queued"
          value={effectiveOverview?.active?.queued || 0}
        />
        <StatCard
          label="Completed (24h)"
          value={effectiveOverview?.today?.completed || 0}
          subtext={`${effectiveOverview?.today?.failed || 0} failed`}
        />
      </div>

      {/* Task Activity chart */}
      {activityData.length > 0 && (
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-4 mb-6">
          <h3 className="text-white font-medium mb-4">Task Activity</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={activityData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis
                dataKey="date"
                tickFormatter={(d) => {
                  const dt = new Date(typeof d === 'string' && d.length === 10 ? d + 'T12:00:00' : d);
                  return `${dt.getMonth() + 1}/${dt.getDate()}`;
                }}
                tick={{ fill: '#94a3b8', fontSize: 12 }}
              />
              <YAxis
                tick={{ fill: '#94a3b8', fontSize: 12 }}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                labelStyle={{ color: '#94a3b8' }}
                labelFormatter={(d) => {
                  const dt = new Date(typeof d === 'string' && d.length === 10 ? d + 'T12:00:00' : d);
                  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="completed"
                name="Completed"
                stroke="#10b981"
                strokeWidth={2}
                dot={{ r: 3, fill: '#10b981' }}
                activeDot={{ r: 5 }}
              />
              <Line
                type="monotone"
                dataKey="failed"
                name="Failed"
                stroke="#ef4444"
                strokeWidth={2}
                dot={{ r: 3, fill: '#ef4444' }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Needs Attention section */}
      {stuckTasks && stuckTasks.total_needs_attention > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
            <h3 className="font-medium text-amber-400 text-sm">Needs Attention</h3>
            <span className="bg-amber-600/40 text-amber-300 text-xs px-2 py-0.5 rounded-full font-medium">
              {stuckTasks.total_needs_attention}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
            {stuckTasks.long_running?.tasks?.slice(0, 3).map((t) => (
              <NeedsAttentionCard key={t.id} task={t} reason="Running >30m" onOpenDrawer={onOpenDrawer} />
            ))}
            {stuckTasks.pending_approval?.tasks?.slice(0, 3).map((t) => (
              <NeedsAttentionCard key={t.id} task={t} reason="Pending approval" onOpenDrawer={onOpenDrawer} />
            ))}
            {stuckTasks.pending_switch?.tasks?.slice(0, 2).map((t) => (
              <NeedsAttentionCard key={t.id} task={t} reason="Pending switch" onOpenDrawer={onOpenDrawer} />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {allTasks.length === 0 && !staleData && (
        <div className="glass-card p-12 text-center mb-6">
          <svg className="w-16 h-16 text-slate-700 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
          </svg>
          <p className="text-slate-400 text-lg mb-1">No tasks yet</p>
          <p className="text-slate-500 text-sm">
            Click <button onClick={() => setShowSubmitForm(true)} className="text-blue-400 hover:text-blue-300 underline">Submit Task</button> above or use <code className="bg-slate-800 px-1.5 py-0.5 rounded text-xs">/torque-submit</code> to get started
          </p>
        </div>
      )}

      {/* Kanban columns */}
      <div className="flex flex-col md:flex-row gap-4 overflow-x-auto pb-4">
        {STATUS_COLUMNS.filter((col) => !hiddenCols.has(col.id)).map((col) => (
          <KanbanColumn
            key={col.id}
            label={col.label}
            color={col.color}
            dotColor={col.dotColor}
            tasks={tasksByStatus[col.id] || []}
            count={countByStatus[col.id]}
            onAction={handleAction}
            onOpenDrawer={onOpenDrawer}
            collapsed={!!collapsedCols[col.id]}
            onToggle={() => toggleColumn(col.id)}
            compact={compact}
            sortKey={columnSorts[col.id] || 'newest'}
            onSortChange={(key) => setColumnSort(col.id, key)}
            flashIds={flashIds}
            pinnedIds={pinnedIds}
            onPin={togglePin}
            hostActivity={hostActivity}
            providerList={providerList}
            queuedProviderSelections={queuedProviderSelections}
            reassigningIds={reassigningIds}
            onProviderSelectionChange={handleQueuedProviderSelectionChange}
            onReassignProvider={handleReassignProvider}
          />
        ))}
        </div>
      </div>
      </div>
      <ActivityPanel events={activityLog} isOpen={activityOpen} onToggle={toggleActivityPanel} />
      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" role="dialog" aria-modal="true">
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-white font-semibold text-lg mb-2">Confirm Retry</h3>
            <p className="text-slate-300 text-sm mb-4">
              Retry {showConfirm.count} failed task{showConfirm.count !== 1 ? 's' : ''}?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowConfirm(null)}
                className="px-4 py-2 text-sm text-slate-400 hover:text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmAction}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
              >
                Retry All
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
