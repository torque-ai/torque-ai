import { useState, useEffect, useCallback } from 'react';
import { approvals as approvalsApi } from '../api';
import { useToast } from '../components/Toast';
import StatCard from '../components/StatCard';

function formatDate(dateStr) {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleString('en-US');
  } catch {
    return dateStr;
  }
}

function truncateId(id) {
  if (!id) return '-';
  return String(id).substring(0, 8);
}

export default function Approvals() {
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState(null);
  const [activeTab, setActiveTab] = useState('pending');
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
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, [loadData]);

  async function handleApprove(id) {
    setActionInProgress(id);
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
    setActionInProgress(id);
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

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-slate-400">Loading...</p>
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
        <div className="glass-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-700/50">
                <th className="text-left p-4 heading-sm">ID</th>
                <th className="text-left p-4 heading-sm">Description</th>
                <th className="text-left p-4 heading-sm">Rule</th>
                <th className="text-left p-4 heading-sm">Created At</th>
                <th className="text-left p-4 heading-sm">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pending.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-slate-500">
                    No pending approvals
                  </td>
                </tr>
              ) : (
                pending.map((item) => (
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
                          disabled={actionInProgress === item.id}
                          className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors"
                        >
                          {actionInProgress === item.id ? '...' : 'Approve'}
                        </button>
                        <button
                          onClick={() => handleReject(item.id)}
                          disabled={actionInProgress === item.id}
                          className="text-xs px-3 py-1.5 rounded bg-red-600/20 hover:bg-red-600/40 text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                        >
                          {actionInProgress === item.id ? '...' : 'Reject'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* History table */}
      {activeTab === 'history' && (
        <div className="glass-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-700/50">
                <th className="text-left p-4 heading-sm">ID</th>
                <th className="text-left p-4 heading-sm">Description</th>
                <th className="text-left p-4 heading-sm">Decision</th>
                <th className="text-left p-4 heading-sm">Decided By</th>
                <th className="text-left p-4 heading-sm">Decided At</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-slate-500">
                    No approval history
                  </td>
                </tr>
              ) : (
                history.map((item) => (
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
      )}
    </div>
  );
}
