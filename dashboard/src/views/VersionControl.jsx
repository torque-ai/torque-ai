import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { versionControl as versionControlApi } from '../api';
import StatCard from '../components/StatCard';
import LoadingSkeleton from '../components/LoadingSkeleton';
import { useToast } from '../components/Toast';
import { formatDate } from '../utils/formatters';

const REFRESH_INTERVAL_MS = 60_000;
const STALE_DAYS = 7;
const COMMITS_DAYS = 7;

const STATUS_STYLES = {
  active: 'bg-blue-600/20 text-blue-300 border border-blue-500/30',
  stale: 'bg-amber-600/20 text-amber-300 border border-amber-500/30',
  merged: 'bg-green-600/20 text-green-300 border border-green-500/30',
  missing: 'bg-red-600/20 text-red-300 border border-red-500/30',
  unknown: 'bg-slate-700 text-slate-300 border border-slate-600',
};

const COMMIT_TYPE_STYLES = {
  feat: 'bg-green-600/20 text-green-300 border border-green-500/30',
  fix: 'bg-yellow-600/20 text-yellow-300 border border-yellow-500/30',
  test: 'bg-blue-600/20 text-blue-300 border border-blue-500/30',
  docs: 'bg-purple-600/20 text-purple-300 border border-purple-500/30',
  chore: 'bg-slate-700 text-slate-300 border border-slate-600',
  unknown: 'bg-slate-700 text-slate-300 border border-slate-600',
};

function deriveFeatureName(worktree) {
  if (typeof worktree?.feature_name === 'string' && worktree.feature_name.trim()) {
    return worktree.feature_name.trim();
  }

  const branch = String(worktree?.branch || '').replace(/^refs\/heads\//, '');
  if (!branch) {
    return 'Unknown';
  }

  const suffix = branch.includes('/') ? branch.split('/').pop() : branch;
  return suffix.replace(/[-_]+/g, ' ');
}

function getRepoName(repoPath) {
  if (typeof repoPath !== 'string' || !repoPath.trim()) {
    return 'Unknown';
  }

  const segments = repoPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || repoPath;
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isStaleWorktree(worktree, staleDays = STALE_DAYS) {
  const status = String(worktree?.status || '').toLowerCase();
  if (status === 'merged') {
    return false;
  }

  if (worktree?.is_stale === true || worktree?.isStale === true) {
    return true;
  }

  const timestamp = normalizeTimestamp(worktree?.last_activity_at || worktree?.created_at);
  if (!timestamp) {
    return false;
  }

  return Date.now() - timestamp >= staleDays * 24 * 60 * 60 * 1000;
}

function getDisplayStatus(worktree) {
  const status = String(worktree?.display_status || worktree?.status || 'unknown').toLowerCase();
  if (status === 'stale') {
    return 'stale';
  }

  if (status === 'active' && isStaleWorktree(worktree)) {
    return 'stale';
  }

  return STATUS_STYLES[status] ? status : 'unknown';
}

function formatRelativeTime(value) {
  if (!value) {
    return 'Never';
  }

  try {
    return formatDistanceToNow(new Date(value), { addSuffix: true });
  } catch {
    return String(value);
  }
}

function getCommitTypeStyle(type) {
  const normalized = String(type || '').toLowerCase();
  return COMMIT_TYPE_STYLES[normalized] || COMMIT_TYPE_STYLES.unknown;
}

function getCommitTimestamp(commit) {
  return commit?.created_at || commit?.generated_at || null;
}

function isSameDay(dateA, dateB) {
  return dateA.getFullYear() === dateB.getFullYear()
    && dateA.getMonth() === dateB.getMonth()
    && dateA.getDate() === dateB.getDate();
}

function ConfirmDialog({ action, pending, onCancel, onConfirm }) {
  if (!action?.worktree) {
    return null;
  }

  const isMerge = action.type === 'merge';
  const title = isMerge ? 'Merge Worktree' : 'Delete Worktree';
  const confirmLabel = isMerge ? 'Merge' : 'Delete';
  const branch = action.worktree.branch || action.worktree.id;
  const message = isMerge
    ? `Merge ${branch} back into ${action.worktree.base_branch || 'main'} and clean up the worktree afterwards?`
    : `Delete ${branch} and remove its tracked worktree? This also removes the git worktree on disk.`;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="glass-card p-6 max-w-md mx-4"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
        <p className="text-sm text-slate-300 mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={pending}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={pending}
            className={`px-4 py-2 text-white text-sm rounded-lg transition-colors disabled:opacity-50 ${
              isMerge ? 'bg-blue-600 hover:bg-blue-500' : 'bg-red-600 hover:bg-red-500'
            }`}
          >
            {pending ? (isMerge ? 'Merging...' : 'Deleting...') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function VersionControl() {
  const toast = useToast();
  const [worktrees, setWorktrees] = useState([]);
  const [commits, setCommits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [actionInProgress, setActionInProgress] = useState(null);

  const loadData = useCallback(async ({ background = false, notifyError = true } = {}) => {
    if (!background) {
      setLoading(true);
    }

    try {
      const [worktreeResponse, commitResponse] = await Promise.all([
        versionControlApi.getWorktrees(),
        versionControlApi.getCommits(COMMITS_DAYS),
      ]);

      const nextWorktrees = Array.isArray(worktreeResponse)
        ? worktreeResponse
        : worktreeResponse?.worktrees || worktreeResponse?.items || [];
      const nextCommits = Array.isArray(commitResponse)
        ? commitResponse
        : commitResponse?.commits || commitResponse?.items || [];

      setWorktrees(nextWorktrees);
      setCommits(nextCommits);
    } catch (err) {
      console.error('Failed to load version control dashboard:', err);
      if (notifyError) {
        toast.error(`Failed to load version control data: ${err.message}`);
      }
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  }, [toast]);

  useEffect(() => {
    loadData({ background: false, notifyError: true });
    const interval = setInterval(() => {
      if (document.hidden) {
        return;
      }
      loadData({ background: true, notifyError: false });
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadData]);

  const recentCommits = useMemo(() => {
    return [...commits]
      .sort((left, right) => {
        const leftTimestamp = normalizeTimestamp(getCommitTimestamp(left)) || 0;
        const rightTimestamp = normalizeTimestamp(getCommitTimestamp(right)) || 0;
        return rightTimestamp - leftTimestamp;
      })
      .slice(0, 10);
  }, [commits]);

  const stats = useMemo(() => {
    const today = new Date();
    const activeWorktrees = worktrees.filter((worktree) => {
      return String(worktree?.status || '').toLowerCase() === 'active' && !isStaleWorktree(worktree);
    }).length;
    const staleWorktrees = worktrees.filter((worktree) => isStaleWorktree(worktree)).length;
    const commitsToday = commits.filter((commit) => {
      const timestamp = getCommitTimestamp(commit);
      if (!timestamp) {
        return false;
      }

      const parsed = new Date(timestamp);
      return !Number.isNaN(parsed.getTime()) && isSameDay(parsed, today);
    }).length;
    const policyViolations = worktrees.reduce((total, worktree) => {
      const numericValue = Number(
        worktree?.policy_violations
        ?? worktree?.policyViolations
        ?? worktree?.violation_count
        ?? 0,
      );
      return total + (Number.isFinite(numericValue) ? numericValue : 0);
    }, 0);

    return {
      activeWorktrees,
      staleWorktrees,
      commitsToday,
      policyViolations,
    };
  }, [commits, worktrees]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData({ background: true, notifyError: true });
    setRefreshing(false);
  }, [loadData]);

  const handleConfirmAction = useCallback(async () => {
    if (!confirmAction?.worktree) {
      return;
    }

    const { worktree, type } = confirmAction;
    const nextAction = { id: worktree.id, type };
    setActionInProgress(nextAction);

    try {
      if (type === 'merge') {
        const result = await versionControlApi.mergeWorktree(worktree.id, { deleteAfter: true });
        if (result?.blocked) {
          const message = result?.policy?.violations?.[0]?.message || 'Merge blocked by policy';
          setConfirmAction(null);
          toast.error(message);
          return;
        }
        toast.success(`Merged ${worktree.branch || worktree.id}`);
      } else {
        await versionControlApi.deleteWorktree(worktree.id);
        toast.success(`Deleted ${worktree.branch || worktree.id}`);
      }

      setConfirmAction(null);
      await loadData({ background: true, notifyError: true });
    } catch (err) {
      console.error(`Version control ${type} failed:`, err);
      toast.error(`${type === 'merge' ? 'Merge' : 'Delete'} failed: ${err.message}`);
    } finally {
      setActionInProgress(null);
    }
  }, [confirmAction, loadData, toast]);

  if (loading) {
    return (
      <div className="p-6">
        <LoadingSkeleton lines={6} />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="heading-lg text-white">Version Control</h2>
          <p className="text-sm text-slate-400 mt-1">
            Tracked worktrees and recent generated commits across repositories
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm rounded-lg disabled:opacity-50 transition-colors"
        >
          <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        <StatCard label="Active Worktrees" value={stats.activeWorktrees} gradient="green" />
        <StatCard label="Stale Worktrees" value={stats.staleWorktrees} gradient="orange" />
        <StatCard label="Commits Today" value={stats.commitsToday} gradient="blue" />
        <StatCard label="Policy Violations" value={stats.policyViolations} gradient={stats.policyViolations > 0 ? 'red' : 'purple'} />
      </div>

      <div className="glass-card overflow-hidden mb-8">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/50">
          <div>
            <h3 className="text-lg font-semibold text-white">Worktrees</h3>
            <p className="text-sm text-slate-400 mt-1">{worktrees.length} tracked</p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px]">
            <thead>
              <tr className="border-b border-slate-700/50">
                <th className="text-left p-4 heading-sm">Branch</th>
                <th className="text-left p-4 heading-sm">Feature</th>
                <th className="text-left p-4 heading-sm">Repo</th>
                <th className="text-left p-4 heading-sm">Status</th>
                <th className="text-left p-4 heading-sm">Commits</th>
                <th className="text-left p-4 heading-sm">Last Activity</th>
                <th className="text-left p-4 heading-sm">Actions</th>
              </tr>
            </thead>
            <tbody>
              {worktrees.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-500">
                    No tracked worktrees yet
                  </td>
                </tr>
              ) : (
                worktrees.map((worktree) => {
                  const displayStatus = getDisplayStatus(worktree);
                  const pendingAction = actionInProgress?.id === worktree.id ? actionInProgress.type : null;

                  return (
                    <tr
                      key={worktree.id}
                      className="border-b border-slate-700/30 hover:bg-slate-700/20 transition-colors"
                    >
                      <td className="p-4 align-top">
                        <p className="text-sm font-medium text-white">{worktree.branch || '-'}</p>
                        <p className="text-xs text-slate-500 mt-1">{worktree.base_branch || 'main'} base</p>
                      </td>
                      <td className="p-4 align-top">
                        <p className="text-sm text-slate-200 capitalize">{deriveFeatureName(worktree)}</p>
                        <p className="text-xs text-slate-500 mt-1">{worktree.worktree_path || '-'}</p>
                      </td>
                      <td className="p-4 align-top">
                        <p className="text-sm text-white">{getRepoName(worktree.repo_path)}</p>
                        <p className="text-xs text-slate-500 mt-1">{worktree.repo_path || '-'}</p>
                      </td>
                      <td className="p-4 align-top">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium capitalize ${STATUS_STYLES[displayStatus] || STATUS_STYLES.unknown}`}>
                          {displayStatus}
                        </span>
                      </td>
                      <td className="p-4 align-top text-sm text-slate-200">
                        {Number(worktree.commit_count || 0).toLocaleString()}
                      </td>
                      <td className="p-4 align-top">
                        <p className="text-sm text-slate-200">
                          {formatRelativeTime(worktree.last_activity_at || worktree.created_at)}
                        </p>
                        <p className="text-xs text-slate-500 mt-1">
                          {formatDate(worktree.last_activity_at || worktree.created_at)}
                        </p>
                      </td>
                      <td className="p-4 align-top">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setConfirmAction({ type: 'merge', worktree })}
                            disabled={pendingAction !== null || displayStatus === 'merged' || displayStatus === 'missing'}
                            className="px-3 py-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600/35 border border-blue-500/30 text-blue-300 text-xs font-medium disabled:opacity-50 transition-colors"
                          >
                            {pendingAction === 'merge' ? 'Merging...' : 'Merge'}
                          </button>
                          <button
                            onClick={() => setConfirmAction({ type: 'delete', worktree })}
                            disabled={pendingAction !== null}
                            className="px-3 py-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/35 border border-red-500/30 text-red-300 text-xs font-medium disabled:opacity-50 transition-colors"
                          >
                            {pendingAction === 'delete' ? 'Deleting...' : 'Delete'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="glass-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Recent Commits</h3>
            <p className="text-sm text-slate-400 mt-1">Latest 10 generated commits from the last {COMMITS_DAYS} days</p>
          </div>
        </div>

        {recentCommits.length === 0 ? (
          <div className="py-10 text-center text-slate-500">
            No recent generated commits
          </div>
        ) : (
          <div className="space-y-3">
            {recentCommits.map((commit) => {
              const timestamp = getCommitTimestamp(commit);
              return (
                <div
                  key={commit.id || `${commit.commit_hash}-${timestamp}`}
                  className="rounded-xl border border-slate-700/50 bg-slate-800/30 px-4 py-3"
                >
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium lowercase ${getCommitTypeStyle(commit.commit_type)}`}>
                          {commit.commit_type || 'unknown'}
                        </span>
                        {commit.scope ? (
                          <span className="px-2 py-0.5 rounded-full text-xs bg-slate-700 text-slate-300 border border-slate-600">
                            {commit.scope}
                          </span>
                        ) : null}
                        <code className="text-xs text-slate-400 font-mono bg-slate-900/80 px-2 py-0.5 rounded">
                          {(commit.commit_hash || '').slice(0, 7) || 'pending'}
                        </code>
                      </div>
                      <p className="text-sm text-white break-words">{commit.message || 'No commit message recorded'}</p>
                      <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-slate-500">
                        <span>{getRepoName(commit.repo_path)}</span>
                        <span>{commit.branch || 'unknown branch'}</span>
                        <span>{formatDate(timestamp)}</span>
                      </div>
                    </div>
                    <div className="text-xs text-slate-400 shrink-0">
                      {formatRelativeTime(timestamp)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        action={confirmAction}
        pending={Boolean(confirmAction && actionInProgress?.id === confirmAction.worktree?.id && actionInProgress?.type === confirmAction.type)}
        onCancel={() => {
          if (!actionInProgress) {
            setConfirmAction(null);
          }
        }}
        onConfirm={handleConfirmAction}
      />
    </div>
  );
}
