import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { useOutletContext } from 'react-router-dom';
import { factory as factoryApi, getDecisionLog } from '../../api';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import { SelectProjectPrompt } from './shared';
import {
  BADGE_FALLBACK_STYLE,
  DECISION_STAGE_BADGE_STYLES,
  INTAKE_SOURCE_BADGE_STYLES,
  formatLabel,
  formatTimestamp,
  normalizeDecisionStage,
  normalizeIntakeSource,
  truncateText,
} from './utils';

const TERMINAL_STATUSES = ['completed', 'shipped', 'rejected'];
const TERMINAL_STATUS_LABELS = {
  completed: 'Completed',
  shipped: 'Shipped',
  rejected: 'Rejected',
};
const TERMINAL_STATUS_BADGE_STYLES = {
  completed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  shipped: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  rejected: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
};
const HISTORY_FETCH_LIMIT = 100;
const DECISION_FETCH_LIMIT = 200;

function getEmptyCounts() {
  return Object.fromEntries(TERMINAL_STATUSES.map((status) => [status, 0]));
}

function normalizeHistoryStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();

  if (normalized === 'completed') return 'completed';
  if (normalized === 'shipped') return 'shipped';
  if (normalized === 'rejected') return 'rejected';

  return normalized;
}

function resolveHistorySource(item = {}) {
  if (item.source === 'plan_file' || item.requestor === 'plan-file-intake') {
    return 'plan_file';
  }

  if (item.requestor === 'architect') {
    return 'architect';
  }

  return normalizeIntakeSource(item.source);
}

function normalizeHistoryItem(item = {}) {
  const batchId = item.batch_id === null || item.batch_id === undefined
    ? null
    : String(item.batch_id).trim() || null;

  return {
    ...item,
    batch_id: batchId,
    displaySource: resolveHistorySource(item),
    displayStatus: normalizeHistoryStatus(item.status),
    reject_reason: typeof item.reject_reason === 'string' ? item.reject_reason.trim() : '',
    updated_at: item.updated_at || item.created_at || null,
  };
}

function sortByUpdatedAtDesc(left, right) {
  return new Date(right?.updated_at || 0).getTime() - new Date(left?.updated_at || 0).getTime();
}

function truncateBatchId(batchId) {
  if (!batchId) {
    return '-';
  }

  const value = String(batchId);
  if (value.length <= 18) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function formatResolvedAt(value) {
  if (!value) {
    return '-';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '-';
  }

  return formatDistanceToNow(parsed, { addSuffix: true });
}

function HistorySkeletonRows() {
  return (
    <div className="mt-6 overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-700 text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Title</th>
            <th className="px-4 py-3 font-medium">Priority</th>
            <th className="px-4 py-3 font-medium">Source</th>
            <th className="px-4 py-3 font-medium">Batch ID</th>
            <th className="px-4 py-3 font-medium">Reject Reason</th>
            <th className="px-4 py-3 font-medium">Resolved At</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700/70">
          {Array.from({ length: 4 }).map((_, index) => (
            <tr key={`history-skeleton-${index}`} className="animate-pulse">
              <td className="px-4 py-4"><div className="h-6 w-24 rounded-full bg-slate-700/70" /></td>
              <td className="px-4 py-4">
                <div className="h-4 w-40 rounded bg-slate-700/70" />
                <div className="mt-2 h-3 w-64 rounded bg-slate-800" />
              </td>
              <td className="px-4 py-4"><div className="h-4 w-12 rounded bg-slate-700/70" /></td>
              <td className="px-4 py-4"><div className="h-6 w-24 rounded-full bg-slate-700/70" /></td>
              <td className="px-4 py-4"><div className="h-4 w-32 rounded bg-slate-700/70" /></td>
              <td className="px-4 py-4"><div className="h-4 w-36 rounded bg-slate-700/70" /></td>
              <td className="px-4 py-4"><div className="h-4 w-24 rounded bg-slate-700/70" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function History() {
  const { selectedProject } = useOutletContext();
  const selectedProjectId = selectedProject?.id;
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState(() => getEmptyCounts());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [expandedItemId, setExpandedItemId] = useState(null);
  const [batchDecisionState, setBatchDecisionState] = useState({});
  const expandedItemIdRef = useRef(expandedItemId);
  const batchDecisionStateRef = useRef(batchDecisionState);

  const updateBatchState = useCallback((batchId, updater) => {
    setBatchDecisionState((current) => {
      const previous = current[batchId] || {
        decisions: [],
        error: '',
        loaded: false,
        loading: false,
      };
      const nextState = typeof updater === 'function'
        ? updater(previous)
        : { ...previous, ...updater };

      const nextBatchState = { ...current, [batchId]: nextState };
      batchDecisionStateRef.current = nextBatchState;
      return nextBatchState;
    });
  }, []);

  const loadBatchDecisions = useCallback(async (batchId, { force = false, isCancelled = () => false } = {}) => {
    if (!selectedProjectId || !batchId) {
      return;
    }

    const existing = batchDecisionStateRef.current[batchId];
    if (!force && (existing?.loading || existing?.loaded)) {
      return;
    }

    updateBatchState(batchId, { error: '', loading: true });

    try {
      const response = await getDecisionLog(selectedProjectId, { limit: DECISION_FETCH_LIMIT });
      if (isCancelled()) {
        return;
      }

      const decisions = (Array.isArray(response?.decisions) ? response.decisions : [])
        .filter((decision) => decision?.batch_id === batchId)
        .sort((left, right) => new Date(right?.created_at || 0).getTime() - new Date(left?.created_at || 0).getTime())
        .slice(0, 10);

      updateBatchState(batchId, {
        decisions,
        error: '',
        loaded: true,
        loading: false,
      });
    } catch (requestError) {
      if (isCancelled()) {
        return;
      }

      updateBatchState(batchId, {
        decisions: [],
        error: requestError.message || 'Failed to load batch decisions.',
        loaded: true,
        loading: false,
      });
    }
  }, [selectedProjectId, updateBatchState]);

  const loadHistory = useCallback(async ({ isCancelled = () => false } = {}) => {
    if (!selectedProjectId) {
      if (!isCancelled()) {
        setItems([]);
        setCounts(getEmptyCounts());
        setError('');
        setLoading(false);
      }
      return;
    }

    if (!isCancelled()) {
      setLoading(true);
      setError('');
    }

    try {
      const responses = await Promise.all(
        TERMINAL_STATUSES.map((status) => factoryApi.intake(selectedProjectId, { status, limit: HISTORY_FETCH_LIMIT }))
      );

      if (isCancelled()) {
        return;
      }

      const mergedItems = responses
        .flatMap((response) => (Array.isArray(response?.items) ? response.items : []))
        .map(normalizeHistoryItem)
        .sort(sortByUpdatedAtDesc);
      const stats = responses.find((response) => response?.stats)?.stats || {};
      const nextCounts = {
        completed: Number(stats.completed) || 0,
        shipped: Number(stats.shipped) || 0,
        rejected: Number(stats.rejected) || 0,
      };
      const expandedItem = mergedItems.find((item) => item.id === expandedItemIdRef.current) || null;

      setItems(mergedItems);
      setCounts(nextCounts);

      if (expandedItem?.batch_id) {
        void loadBatchDecisions(expandedItem.batch_id, { force: true, isCancelled });
      }
    } catch (requestError) {
      if (!isCancelled()) {
        setItems([]);
        setCounts(getEmptyCounts());
        setError(requestError.message || 'Failed to load work item history.');
      }
    } finally {
      if (!isCancelled()) {
        setLoading(false);
      }
    }
  }, [loadBatchDecisions, selectedProjectId]);

  useEffect(() => {
    expandedItemIdRef.current = expandedItemId;
  }, [expandedItemId]);

  useEffect(() => {
    batchDecisionStateRef.current = batchDecisionState;
  }, [batchDecisionState]);

  useEffect(() => {
    expandedItemIdRef.current = null;
    batchDecisionStateRef.current = {};
    setItems([]);
    setCounts(getEmptyCounts());
    setError('');
    setSelectedStatus('');
    setExpandedItemId(null);
    setBatchDecisionState({});
  }, [selectedProjectId]);

  useEffect(() => {
    let cancelled = false;
    loadHistory({ isCancelled: () => cancelled });

    const intervalId = setInterval(() => {
      loadHistory({ isCancelled: () => cancelled });
    }, 30000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [loadHistory]);

  useEffect(() => {
    if (expandedItemId && !items.some((item) => item.id === expandedItemId)) {
      setExpandedItemId(null);
    }
  }, [expandedItemId, items]);

  const visibleItems = useMemo(() => (
    selectedStatus ? items.filter((item) => item.displayStatus === selectedStatus) : items
  ), [items, selectedStatus]);
  const expandedItem = useMemo(() => (
    items.find((item) => item.id === expandedItemId) || null
  ), [expandedItemId, items]);
  const expandedBatchState = expandedItem?.batch_id
    ? batchDecisionState[expandedItem.batch_id] || { decisions: [], error: '', loaded: false, loading: false }
    : null;

  if (!selectedProject) {
    return <SelectProjectPrompt message="Select a project above to view its completed work item history." />;
  }

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold text-white">Work Item History</h2>
            <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
              {items.length} total
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-400">{selectedProject.name}</p>
          <p className="mt-2 text-sm text-slate-400">
            Completed, shipped, and rejected work items with the latest batch outcomes.
          </p>
        </div>

        <button
          type="button"
          onClick={() => loadHistory()}
          disabled={loading}
          className="inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-900/70 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {TERMINAL_STATUSES.map((status) => {
          const isActive = selectedStatus === status;
          const badgeStyle = TERMINAL_STATUS_BADGE_STYLES[status] || BADGE_FALLBACK_STYLE;

          return (
            <button
              key={status}
              type="button"
              onClick={() => setSelectedStatus((current) => (current === status ? '' : status))}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive
                  ? badgeStyle
                  : 'border-slate-700 bg-slate-900/60 text-slate-300 hover:border-slate-600 hover:text-white'
              }`}
            >
              <span>{TERMINAL_STATUS_LABELS[status]}</span>
              <span className="rounded-full bg-slate-950/60 px-2 py-0.5 text-xs text-slate-200">
                {counts[status] || 0}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mt-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-5 py-4 text-sm text-rose-100">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => loadHistory()}
              disabled={loading}
              className="inline-flex items-center justify-center rounded-lg border border-rose-400/40 bg-slate-900/40 px-3 py-1.5 text-sm font-medium text-rose-100 transition-colors hover:bg-slate-900/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {loading && items.length === 0 ? (
        <HistorySkeletonRows />
      ) : !error && visibleItems.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-900/40 px-5 py-10 text-center text-sm text-slate-400">
          {selectedStatus ? `No ${TERMINAL_STATUS_LABELS[selectedStatus].toLowerCase()} work items match this filter.` : 'No completed work items yet.'}
        </div>
      ) : visibleItems.length > 0 ? (
        <div className="mt-6 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-700 text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Priority</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Batch ID</th>
                <th className="px-4 py-3 font-medium">Reject Reason</th>
                <th className="px-4 py-3 font-medium">Resolved At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/70">
              {visibleItems.map((item) => {
                const statusStyle = TERMINAL_STATUS_BADGE_STYLES[item.displayStatus] || BADGE_FALLBACK_STYLE;
                const sourceStyle = INTAKE_SOURCE_BADGE_STYLES[item.displaySource] || BADGE_FALLBACK_STYLE;
                const isExpanded = expandedItemId === item.id;
                const isExpandable = Boolean(item.batch_id);

                return (
                  <Fragment key={item.id}>
                    <tr
                      tabIndex={isExpandable ? 0 : undefined}
                      aria-expanded={isExpandable ? isExpanded : undefined}
                      className={`align-top transition-colors ${
                        isExpandable ? 'cursor-pointer hover:bg-slate-900/30' : ''
                      }`}
                      onClick={() => {
                        if (!isExpandable) {
                          return;
                        }

                        const nextExpanded = !isExpanded;
                        setExpandedItemId(nextExpanded ? item.id : null);

                        if (nextExpanded) {
                          void loadBatchDecisions(item.batch_id);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (!isExpandable) {
                          return;
                        }

                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          const nextExpanded = !isExpanded;
                          setExpandedItemId(nextExpanded ? item.id : null);

                          if (nextExpanded) {
                            void loadBatchDecisions(item.batch_id);
                          }
                        }
                      }}
                    >
                      <td className="px-4 py-4">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyle}`}>
                          {formatLabel(item.displayStatus)}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <p className="font-medium text-white">{item.title || 'Untitled work item'}</p>
                        {item.description && (
                          <p className="mt-1 max-w-xl text-xs text-slate-400" title={item.description}>
                            {truncateText(item.description, 120)}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-4 text-slate-300">{item.priority ?? '-'}</td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${sourceStyle}`}>
                          {formatLabel(item.displaySource)}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <span className="font-mono text-xs text-slate-300" title={item.batch_id || ''}>
                          {truncateBatchId(item.batch_id)}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-slate-300" title={item.reject_reason || ''}>
                        {item.displayStatus === 'rejected'
                          ? truncateText(item.reject_reason || '-', 72)
                          : <span className="text-slate-600">-</span>}
                      </td>
                      <td className="px-4 py-4 text-slate-300" title={formatTimestamp(item.updated_at)}>
                        {formatResolvedAt(item.updated_at)}
                      </td>
                    </tr>

                    {isExpanded && isExpandable && (
                      <tr>
                        <td colSpan={7} className="px-4 pb-4 pt-0">
                          <div className="rounded-xl border border-slate-700/70 bg-slate-900/60 p-4">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <p className="text-xs uppercase tracking-wide text-slate-500">Batch Decisions</p>
                                <p className="mt-1 font-mono text-xs text-slate-400">{item.batch_id}</p>
                              </div>
                            </div>

                            {expandedBatchState?.loading ? (
                              <div className="mt-4">
                                <LoadingSkeleton lines={3} height={16} />
                              </div>
                            ) : expandedBatchState?.error ? (
                              <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/5 px-4 py-3 text-sm text-rose-100">
                                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                                  <p>{expandedBatchState.error}</p>
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void loadBatchDecisions(item.batch_id, { force: true });
                                    }}
                                    className="inline-flex items-center justify-center rounded-lg border border-rose-400/40 bg-slate-900/40 px-3 py-1.5 text-sm font-medium text-rose-100 transition-colors hover:bg-slate-900/60"
                                  >
                                    Retry
                                  </button>
                                </div>
                              </div>
                            ) : expandedBatchState?.decisions?.length ? (
                              <ul className="mt-4 space-y-3">
                                {expandedBatchState.decisions.map((decision, index) => {
                                  const decisionKey = decision.id || `${decision.created_at || 'unknown'}-${decision.action || index}`;
                                  const decisionStage = normalizeDecisionStage(decision.stage);
                                  const decisionStyle = DECISION_STAGE_BADGE_STYLES[decisionStage] || BADGE_FALLBACK_STYLE;

                                  return (
                                    <li key={decisionKey} className="rounded-xl border border-slate-700/70 bg-slate-950/40 p-3">
                                      <div className="flex flex-wrap items-center gap-3">
                                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${decisionStyle}`}>
                                          {formatLabel(decisionStage || 'unknown')}
                                        </span>
                                        <span className="text-xs text-slate-500">{formatTimestamp(decision.created_at)}</span>
                                      </div>
                                      <p className="mt-2 text-sm text-slate-300">
                                        {`${formatLabel(decisionStage || 'unknown')} [${decision.action || 'unknown'}]: ${decision.reasoning || 'No reasoning recorded.'}`}
                                      </p>
                                    </li>
                                  );
                                })}
                              </ul>
                            ) : (
                              <div className="mt-4 rounded-xl border border-slate-700/70 bg-slate-950/40 px-4 py-6 text-sm text-slate-400">
                                No batch decisions recorded yet.
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
