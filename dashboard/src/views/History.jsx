import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { tasks as tasksApi, providers as providersApi } from '../api';
import { useToast } from '../components/Toast';
import { useAbortableRequest } from '../hooks/useAbortableRequest';
import { STATUS_BG_COLORS } from '../constants';
import { getRelevantModel } from '../utils/providerModels';
import { formatDuration } from '../utils/formatters';
import { format, formatDistanceToNow } from 'date-fns';

const safeFormat = (dateStr, fmt) => {
  try { return dateStr ? format(new Date(dateStr), fmt) : 'N/A'; }
  catch { return 'Invalid date'; }
};

const STATUS_BADGES = {
  queued: STATUS_BG_COLORS.queued,
  running: STATUS_BG_COLORS.running,
  completed: STATUS_BG_COLORS.completed,
  failed: STATUS_BG_COLORS.failed,
  pending_provider_switch: STATUS_BG_COLORS.pending_provider_switch,
};

const COMMON_PROVIDER_OPTIONS = [
  'codex',
  'claude-cli',
  'ollama',
  'aider-ollama',
  'hashline-ollama',
  'anthropic',
  'groq',
  'deepinfra',
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

  const options = [...COMMON_PROVIDER_OPTIONS];
  if (currentProvider && !options.includes(currentProvider)) {
    options.push(currentProvider);
  }

  return options.map((provider) => liveProviders.get(provider) || {
    value: provider,
    label: provider,
    enabled: true,
  });
}

function StatusBadge({ status }) {
  return (
    <span className={`px-2 py-1 rounded-full text-[11px] font-medium text-white ${STATUS_BADGES[status] || 'bg-gray-500'}`}>
      {status?.replace(/_/g, ' ')}
    </span>
  );
}

const DATE_PRESETS = [
  { label: 'All', value: '' },
  { label: 'Today', value: 'today' },
  { label: 'Last 7 Days', value: 'week' },
  { label: 'Last 30 Days', value: 'month' },
];

function getDateRangeParams(range) {
  const now = new Date();
  switch (range) {
    case 'today': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { from: start.toISOString() };
    }
    case 'week': {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return { from: start.toISOString() };
    }
    case 'month': {
      const start = new Date(now);
      start.setMonth(start.getMonth() - 1);
      return { from: start.toISOString() };
    }
    default:
      return {};
  }
}

const SORTABLE_COLUMNS = {
  status: { label: 'Status' },
  task_description: { label: 'Description' },
  provider: { label: 'Provider' },
  model: { label: 'Model' },
  host: { label: 'Host' },
  duration: { label: 'Duration' },
  created_at: { label: 'Created' },
};

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
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '▲'}
        </span>
      </span>
    </th>
  );
}

function exportCSV(tasks) {
  const headers = ['ID', 'Status', 'Description', 'Provider', 'Model', 'Host', 'Duration (s)', 'Created'];
  const rows = tasks.map((t) => {
    const dur = t.completed_at && t.started_at
      ? ((new Date(t.completed_at) - new Date(t.started_at)) / 1000).toFixed(1)
      : '';
    return [
      t.id,
      t.status,
      `"${(t.task_description || '').replace(/"/g, '""')}"`,
      t.provider || '',
      t.model || '',
      t.ollama_host_name || t.ollama_host_id || '',
      dur,
      t.created_at || '',
    ].join(',');
  });
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `torque-tasks-${format(new Date(), 'yyyy-MM-dd')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function getDurationColor(seconds) {
  if (!seconds || seconds <= 0) return 'text-slate-300';
  if (seconds < 60) return 'text-green-400';
  if (seconds < 300) return 'text-yellow-400';
  return 'text-red-400';
}

export default function History({ onOpenDrawer, relativeTimeTick = 0 }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState([]);
  const [providerList, setProviderList] = useState([]);
  const [queuedProviderSelections, setQueuedProviderSelections] = useState({});
  const [reassigningIds, setReassigningIds] = useState(new Set());
  const [pagination, setPagination] = useState({ page: parseInt(searchParams.get('page')) || 1, totalPages: 1 });
  const [loading, setLoading] = useState(true);

  // Initialize filters from URL params
  const [filters, setFilters] = useState({
    status: searchParams.get('status') || '',
    provider: searchParams.get('provider') || '',
    tag: searchParams.get('tag') || '',
    search: searchParams.get('q') || '',
  });
  const [searchInput, setSearchInput] = useState(searchParams.get('q') || '');
  const [dateRange, setDateRange] = useState(searchParams.get('range') || '');
  const [sortCol, setSortCol] = useState(searchParams.get('sort') || 'created_at');
  const [sortDir, setSortDir] = useState(searchParams.get('dir') || 'desc');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const searchTimerRef = useRef(null);
  const tableRef = useRef(null);
  const toast = useToast();
  const { execute } = useAbortableRequest();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [relativeTimeTick]);

  // Extract unique tags from loaded tasks
  const uniqueTags = useMemo(() => {
    const tagSet = new Set();
    tasks.forEach((t) => {
      if (Array.isArray(t.tags)) t.tags.forEach((tag) => tagSet.add(tag));
    });
    return [...tagSet].sort();
  }, [tasks]);

  // Sync filters/sort to URL params
  useEffect(() => {
    const params = {};
    if (filters.status) params.status = filters.status;
    if (filters.provider) params.provider = filters.provider;
    if (filters.tag) params.tag = filters.tag;
    if (filters.search) params.q = filters.search;
    if (dateRange) params.range = dateRange;
    if (sortCol !== 'created_at') params.sort = sortCol;
    if (sortDir !== 'desc') params.dir = sortDir;
    if (pagination.page > 1) params.page = String(pagination.page);
    setSearchParams(params, { replace: true });
  }, [filters, dateRange, sortCol, sortDir, pagination.page, setSearchParams]);

  // Reset page to 1 when filters or date range change
  const prevFiltersRef = useRef(filters);
  const prevDateRangeRef = useRef(dateRange);
  useEffect(() => {
    if (prevFiltersRef.current !== filters || prevDateRangeRef.current !== dateRange) {
      prevFiltersRef.current = filters;
      prevDateRangeRef.current = dateRange;
      setPagination(prev => prev.page !== 1 ? { ...prev, page: 1 } : prev);
    }
  }, [filters, dateRange]);

  // Debounce search input by 300ms
  const handleSearchChange = useCallback((value) => {
    setSearchInput(value);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setFilters((prev) => ({ ...prev, search: value }));
    }, 300);
  }, []);

  function handleSort(col) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  useEffect(() => {
    return () => clearTimeout(searchTimerRef.current);
  }, []);

  const loadTasks = useCallback(() => {
    setLoading(true);
    execute(async (isCurrent) => {
      try {
        const apiFilters = { ...filters };
        // Map 'tag' to 'tags' for the backend API
        if (apiFilters.tag) {
          apiFilters.tags = apiFilters.tag;
          delete apiFilters.tag;
        }
        const params = {
          page: pagination.page,
          limit: 25,
          ...Object.fromEntries(
            Object.entries(apiFilters).filter(([_, v]) => v)
          ),
          ...getDateRangeParams(dateRange),
          orderBy: sortCol,
          orderDir: sortDir,
        };
        const [data, providerData] = await Promise.all([
          tasksApi.list(params),
          providersApi.list().catch(() => []),
        ]);
        if (!isCurrent()) return;
        setTasks(data.tasks);
        setPagination((prev) => ({
          ...prev,
          ...(data.pagination || {}),
          totalPages: Math.ceil((data.pagination?.total || 0) / (data.pagination?.limit || 20)),
        }));
        setProviderList(Array.isArray(providerData) ? providerData : []);
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Failed to load tasks:', err);
        toast.error('Failed to load task history');
      } finally {
        if (isCurrent()) setLoading(false);
      }
    });
  }, [pagination.page, filters, dateRange, sortCol, sortDir, execute, toast]);

  useEffect(() => {
    loadTasks();
    const pollInterval = setInterval(loadTasks, 30000); // 30s fallback — WebSocket events provide real-time updates
    return () => clearInterval(pollInterval);
  }, [loadTasks]);

  useEffect(() => {
    setQueuedProviderSelections((prev) => {
      const next = { ...prev };
      const queuedIds = new Set();
      let changed = false;

      tasks.forEach((task) => {
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
  }, [tasks]);

  async function handleRetry(taskId) {
    try {
      await tasksApi.retry(taskId);
      toast.success('Task queued for retry');
      loadTasks();
    } catch (err) {
      console.error('Retry failed:', err);
      toast.error(`Retry failed: ${err.message}`);
    }
  }

  async function handleReassign(taskId) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    const provider = queuedProviderSelections[taskId] || task?.provider || '';
    if (!task || !provider || provider === task.provider) return;

    setReassigningIds((prev) => new Set([...prev, taskId]));
    try {
      await tasksApi.reassignProvider(taskId, provider);
      toast.success(`Provider reassigned to ${provider}`);
      loadTasks();
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

  function toggleSelect(taskId, e) {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === sortedTasks.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedTasks.map((t) => t.id)));
    }
  }

  async function handleBulkRetry() {
    const ids = [...selectedIds];
    const results = await Promise.allSettled(ids.map((id) => tasksApi.retry(id)));
    const ok = results.filter((result) => result.status === 'fulfilled').length;
    const errs = results.length - ok;
    if (ok > 0) toast.success(`${ok} task${ok > 1 ? 's' : ''} queued for retry`);
    if (errs > 0) toast.error(`${errs} failed to retry`);
    setSelectedIds(new Set());
    loadTasks();
  }

  async function handleBulkCancel() {
    const ids = [...selectedIds];
    const results = await Promise.allSettled(ids.map((id) => tasksApi.cancel(id)));
    const ok = results.filter((result) => result.status === 'fulfilled').length;
    const errs = results.length - ok;
    if (ok > 0) toast.success(`${ok} task${ok > 1 ? 's' : ''} cancelled`);
    if (errs > 0) toast.error(`${errs} failed to cancel`);
    setSelectedIds(new Set());
    loadTasks();
  }

  // Client-side sort
  // Note: Client-side sort applies to the current page only.
  // Server-side sort (orderBy/orderDir) handles cross-page ordering.
  // This local sort provides responsive UI while the server-sorted page loads.
  const sortedTasks = useMemo(() => {
    if (!tasks.length) return tasks;
    const sorted = [...tasks];
    sorted.sort((a, b) => {
      let av, bv;
      switch (sortCol) {
        case 'status':
          av = a.status || ''; bv = b.status || '';
          break;
        case 'task_description':
          av = a.task_description || ''; bv = b.task_description || '';
          break;
        case 'provider':
          av = a.provider || ''; bv = b.provider || '';
          break;
        case 'model':
          av = a.model || ''; bv = b.model || '';
          break;
        case 'host':
          av = a.ollama_host_name || a.ollama_host_id || '';
          bv = b.ollama_host_name || b.ollama_host_id || '';
          break;
        case 'duration': {
          const durA = a.completed_at && a.started_at ? new Date(a.completed_at) - new Date(a.started_at) : 0;
          const durB = b.completed_at && b.started_at ? new Date(b.completed_at) - new Date(b.started_at) : 0;
          return sortDir === 'asc' ? durA - durB : durB - durA;
        }
        case 'created_at':
        default: {
          const da = new Date(a.created_at || 0).getTime();
          const db = new Date(b.created_at || 0).getTime();
          return sortDir === 'asc' ? da - db : db - da;
        }
      }
      const cmp = av.localeCompare(bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [tasks, sortCol, sortDir]);

  // Keyboard navigation: j/k to move, x to select, Enter to open
  useEffect(() => {
    function handleKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.key === 'j' && sortedTasks.length > 0) {
        setFocusedIdx((i) => Math.min(i + 1, sortedTasks.length - 1));
      } else if (e.key === 'k' && sortedTasks.length > 0) {
        setFocusedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'x' && focusedIdx >= 0 && focusedIdx < sortedTasks.length) {
        const task = sortedTasks[focusedIdx];
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(task.id)) next.delete(task.id); else next.add(task.id);
          return next;
        });
      } else if (e.key === 'Enter' && focusedIdx >= 0 && focusedIdx < sortedTasks.length) {
        onOpenDrawer?.(sortedTasks[focusedIdx].id);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [sortedTasks, focusedIdx, onOpenDrawer]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="heading-lg text-white">Task History</h2>
        <button
          onClick={() => exportCSV(tasks)}
          disabled={tasks.length === 0}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6">
        <input
          type="text"
          placeholder="Search tasks..."
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="flex-1 bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
        />
        <select
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="">All Statuses</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="pending_provider_switch">Pending Switch</option>
        </select>
        <select
          value={filters.provider}
          onChange={(e) => setFilters({ ...filters, provider: e.target.value })}
          className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="">All Providers</option>
          <option value="codex">Codex</option>
          <option value="claude-cli">Claude CLI</option>
          <option value="ollama">Ollama</option>
        </select>
        <select
          value={filters.tag}
          onChange={(e) => setFilters({ ...filters, tag: e.target.value })}
          className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="">All Tags</option>
          {uniqueTags.map((tag) => (
            <option key={tag} value={tag}>{tag}</option>
          ))}
        </select>
        <div className="flex bg-slate-800/60 border border-slate-700/50 rounded-lg p-0.5">
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset.value}
              onClick={() => setDateRange(preset.value)}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                dateRange === preset.value
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-4 py-2.5 rounded-lg bg-blue-950/50 border border-blue-600/30">
          <span className="text-sm text-blue-300">{selectedIds.size} selected</span>
          <button
            onClick={handleBulkRetry}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors"
          >
            Retry Selected
          </button>
          <button
            onClick={handleBulkCancel}
            className="px-3 py-1 bg-red-600/30 hover:bg-red-600 text-red-300 hover:text-white text-xs rounded transition-colors"
          >
            Cancel Selected
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-slate-400 hover:text-white text-xs transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className="glass-card overflow-hidden" ref={tableRef}>
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-700/50">
              <th className="p-4 w-8">
                <input
                  type="checkbox"
                  checked={sortedTasks.length > 0 && selectedIds.size === sortedTasks.length}
                  onChange={toggleSelectAll}
                  className="rounded border-slate-600 bg-slate-800 accent-blue-500"
                  aria-label="Select all tasks"
                />
              </th>
              {Object.entries(SORTABLE_COLUMNS).map(([key, { label }]) => (
                <SortHeader key={key} column={key} label={label} sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              ))}
              <th className="text-left p-4 heading-sm">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && tasks.length === 0 ? (
              <>
                {[...Array(5)].map((_, i) => (
                  <tr key={i} className="border-b border-slate-700/30 animate-pulse">
                    <td className="p-4 w-8"><div className="w-4 h-4 bg-slate-700 rounded" /></td>
                    <td className="p-4"><div className="w-16 h-5 bg-slate-700 rounded-full" /></td>
                    <td className="p-4"><div className="h-4 w-48 bg-slate-700 rounded" /></td>
                    <td className="p-4"><div className="w-16 h-5 bg-slate-700 rounded" /></td>
                    <td className="p-4"><div className="w-14 h-5 bg-slate-700 rounded" /></td>
                    <td className="p-4"><div className="w-14 h-5 bg-slate-700 rounded" /></td>
                    <td className="p-4"><div className="w-12 h-4 bg-slate-700 rounded" /></td>
                    <td className="p-4"><div className="w-16 h-4 bg-slate-700 rounded" /></td>
                    <td className="p-4" />
                  </tr>
                ))}
              </>
            ) : sortedTasks.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-8 text-center text-slate-500">
                  No tasks found
                </td>
              </tr>
            ) : (
              sortedTasks.map((task, idx) => (
                <tr
                  key={task.id}
                  onClick={() => onOpenDrawer?.(task.id)}
                  className={`border-b border-slate-700/30 hover:bg-slate-700/30 cursor-pointer transition-colors ${
                    focusedIdx === idx ? 'bg-blue-900/20 ring-1 ring-blue-500/30' : ''
                  } ${selectedIds.has(task.id) ? 'bg-blue-950/30' : ''}`}
                >
                  <td className="p-4 w-8" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(task.id)}
                      onChange={(e) => toggleSelect(task.id, e)}
                      className="rounded border-slate-600 bg-slate-800 accent-blue-500"
                    />
                  </td>
                  <td className="p-4">
                    <StatusBadge status={task.status} />
                  </td>
                  <td className="p-4 max-w-md" title={task.task_description || ''}>
                    <p className="text-white text-sm truncate">{task.task_description?.substring(0, 60)}{task.task_description?.length > 60 ? '...' : ''}</p>
                    {task.tags?.length > 0 && (
                      <div className="flex gap-1 mt-0.5">
                        {task.tags.slice(0, 2).map((tag) => (
                          <span key={tag} className="px-1 py-0 bg-indigo-600/20 text-indigo-300 rounded text-[9px]">{tag}</span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded text-[11px] ${
                      task.provider === 'claude-cli' ? 'bg-purple-600/30 text-purple-300' : 'bg-blue-600/30 text-blue-300'
                    }`}>
                      {task.provider || 'codex'}
                    </span>
                  </td>
                  <td className="p-4 text-slate-300 text-sm">
                    {getRelevantModel(task.provider, task.model) ? (
                      <span className="px-2 py-1 rounded text-[11px] bg-indigo-600/30 text-indigo-300">
                        {getRelevantModel(task.provider, task.model)}
                      </span>
                    ) : '-'}
                  </td>
                  <td className="p-4 text-slate-300 text-sm">
                    {(task.ollama_host_name || task.ollama_host_id) ? (
                      <span className="px-2 py-1 rounded text-[11px] bg-teal-600/30 text-teal-300">
                        {task.ollama_host_name || task.ollama_host_id}
                      </span>
                    ) : '-'}
                  </td>
                  <td className={`p-4 text-sm font-mono ${
                    task.completed_at && task.started_at
                      ? getDurationColor((new Date(task.completed_at) - new Date(task.started_at)) / 1000)
                      : 'text-slate-300'
                  }`}>
                    {task.completed_at && task.started_at
                      ? formatDuration(
                          (new Date(task.completed_at) - new Date(task.started_at)) / 1000
                        )
                      : task.status === 'running' && task.started_at
                        ? formatDuration((now - new Date(task.started_at).getTime()) / 1000)
                        : '-'}
                  </td>
                  <td className="p-4 text-slate-400 text-sm" title={task.created_at ? safeFormat(task.created_at, 'MMM d, yyyy HH:mm:ss') : ''}>
                    {task.created_at
                      ? formatDistanceToNow(new Date(task.created_at), { addSuffix: true })
                      : '-'}
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-2 flex-wrap">
                    {task.status === 'failed' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRetry(task.id); }}
                        className="text-blue-400 hover:text-blue-300 text-sm font-medium"
                      >
                        Retry
                      </button>
                    )}
                    {task.status === 'queued' && (
                      <>
                        <select
                          aria-label={`Reassign provider for task ${task.id}`}
                          value={queuedProviderSelections[task.id] || task.provider || COMMON_PROVIDER_OPTIONS[0]}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            e.stopPropagation();
                            setQueuedProviderSelections((prev) => ({
                              ...prev,
                              [task.id]: e.target.value,
                            }));
                          }}
                          className="bg-slate-800/60 border border-slate-700/50 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-blue-500"
                        >
                          {buildProviderOptions(providerList, task.provider).map((option) => (
                            <option key={option.value} value={option.value} disabled={!option.enabled}>
                              {option.label}{!option.enabled ? ' (disabled)' : ''}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleReassign(task.id); }}
                          disabled={reassigningIds.has(task.id) || (queuedProviderSelections[task.id] || task.provider || '') === task.provider}
                          className="text-blue-400 hover:text-blue-300 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {reassigningIds.has(task.id) ? 'Reassigning...' : 'Reassign'}
                        </button>
                      </>
                    )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4">
        <p className="text-slate-500 text-sm">
          Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
        </p>
        <div className="flex gap-2">
          <button
            disabled={pagination.page <= 1}
            onClick={() => setPagination({ ...pagination, page: pagination.page - 1 })}
            className="px-4 py-2 bg-slate-800 text-white text-sm rounded-lg disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 transition-colors"
          >
            Previous
          </button>
          <button
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => setPagination({ ...pagination, page: pagination.page + 1 })}
            className="px-4 py-2 bg-slate-800 text-white text-sm rounded-lg disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 transition-colors"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
