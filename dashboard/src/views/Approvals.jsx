import { useState, useEffect, useCallback, useMemo } from 'react';
import { approvals as approvalsApi } from '../api';
import { useToast } from '../components/Toast';
import StatCard from '../components/StatCard';
import { formatDate } from '../utils/formatters';
import LoadingSkeleton from '../components/LoadingSkeleton';

const PAGE_LIMIT = 25;

function truncateId(id) {
  if (!id) return '-';
  return String(id).substring(0, 8);
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
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '▲'}
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

export default function Approvals() {
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState(null); // { id, action } | null
  const [activeTab, setActiveTab] = useState('pending');

  // Sort state
  const [pendingSort, setPendingSort] = useState({ col: 'created_at', dir: 'desc' });
  const [historySort, setHistorySort] = useState({ col: 'decided_at', dir: 'desc' });

  // Pagination state
  const [pendingPage, setPendingPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);

  const toast = useToast();

  const loadData = useCallback(async () => {
    try {
      const [pendingData, historyData] = await Promise.all([
        approvalsApi.listPending(),
        approvalsApi.getHistory(50),
      ]);
      setPending(pendingData);
      setHistory(historyData);
    } catch (err) {
      console.error('Failed to load approvals:', err);
      toast.error('Failed to load approvals');
    } finally {
      setLoading(false);
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
      setActionInProgress(null);
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
      setActionInProgress(null);
    }
  }

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

  if (loading) {
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

      {/* Stat cards */}
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
                        <p className="text-white text-sm">
                          {item.description || item.task_description || '-'}
                        </p>
                        {item.task_id && (
                          <p className="text-slate-500 text-xs mt-0.5">
                            Task: {truncateId(item.task_id)}
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
                        <p className="text-white text-sm">
                          {item.description || item.task_description || '-'}
                        </p>
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
