import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { factory as factoryApi } from '../../api';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import { SelectProjectPrompt, StatusDot, TrustBadge } from './shared';
import LoopControlBar from './LoopControlBar';
import {
  BADGE_FALLBACK_STYLE,
  DECISION_STAGE_BADGE_STYLES,
  formatBalance,
  formatLabel,
  formatRelativeTime,
  formatTimestamp,
  normalizeDecisionStage,
  truncateText,
} from './utils';

const CYCLE_STATUS_BADGE_STYLES = {
  active: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  completed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  failed: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
};

function formatCycleDuration(durationMs) {
  const numeric = Number(durationMs);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return '—';
  }

  const totalSeconds = Math.floor(numeric / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours}h ${totalMinutes % 60}m`;
  }

  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d ${totalHours % 24}h`;
}

function formatCycleStages(stageProgression = []) {
  if (!Array.isArray(stageProgression) || stageProgression.length === 0) {
    return '—';
  }

  return stageProgression
    .map((stage) => formatLabel(normalizeDecisionStage(stage)))
    .join(', ');
}

function formatCycleWorkItem(cycle = {}) {
  const title = typeof cycle.work_item_title === 'string' ? cycle.work_item_title.trim() : '';
  const workItemId = cycle.work_item_id ?? null;

  if (title && workItemId) {
    return `${title} (#${workItemId})`;
  }
  if (title) {
    return title;
  }
  if (workItemId) {
    return `#${workItemId}`;
  }
  return '—';
}

export default function Overview() {
  const [loopSummaries, setLoopSummaries] = useState({});
  const [cycleHistory, setCycleHistory] = useState([]);
  const [cycleHistoryLoading, setCycleHistoryLoading] = useState(false);
  const [cycleHistoryError, setCycleHistoryError] = useState('');
  const {
    activeProjectAction,
    approvalsHref,
    detail,
    detailLoading,
    handleToggleProject,
    pendingApprovalCount,
    projects,
    recentActivity,
    recentActivityHydrated,
    refreshSelectedProject,
    selectedProject,
    selectedProjectId,
    setSelectedProjectId,
  } = useOutletContext();

  useEffect(() => {
    if (!Array.isArray(projects) || projects.length === 0) {
      return undefined;
    }

    let cancelled = false;

    const loadLoopSummaries = async () => {
      const nextEntries = await Promise.all(projects.map(async (project) => {
        try {
          const instances = await factoryApi.listLoopInstances(project.id, { activeOnly: true });
          const stages = [...new Set((Array.isArray(instances) ? instances : [])
            .map((instance) => instance?.loop_state)
            .filter(Boolean))];

          return [
            project.id,
            {
              activeCount: Array.isArray(instances) ? instances.length : 0,
              stages,
              error: null,
            },
          ];
        } catch (error) {
          return [
            project.id,
            {
              activeCount: 0,
              stages: [],
              error: error?.message || 'Unable to load loop summary.',
            },
          ];
        }
      }));

      if (!cancelled) {
        setLoopSummaries(Object.fromEntries(nextEntries));
      }
    };

    void loadLoopSummaries();
    const intervalId = setInterval(() => {
      void loadLoopSummaries();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [projects]);

  useEffect(() => {
    if (!selectedProjectId) {
      setCycleHistory([]);
      setCycleHistoryError('');
      setCycleHistoryLoading(false);
      return undefined;
    }

    let cancelled = false;

    const loadCycleHistory = async () => {
      setCycleHistoryLoading(true);
      setCycleHistoryError('');

      try {
        const cycles = await factoryApi.cycleHistory(selectedProjectId);
        if (!cancelled) {
          setCycleHistory(Array.isArray(cycles) ? cycles : []);
        }
      } catch (error) {
        if (!cancelled) {
          setCycleHistory([]);
          setCycleHistoryError(error?.message || 'Unable to load cycle history.');
        }
      } finally {
        if (!cancelled) {
          setCycleHistoryLoading(false);
        }
      }
    };

    void loadCycleHistory();

    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  if (!selectedProject) {
    return <SelectProjectPrompt message="Select a project above to view its health, trust, and loop state." />;
  }

  if (!detail) {
    return null;
  }

  const weakest = detail.weakest_dimension;
  const visibleActivity = recentActivity.slice(0, 5);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Overview</p>
            <h2 className="mt-1 text-2xl font-semibold text-white">{selectedProject.name || 'Selected project'}</h2>
            <p className="mt-2 break-all font-mono text-xs text-slate-400">{selectedProject.path || 'No path configured'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <TrustBadge level={selectedProject.trust_level} />
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
              <StatusDot status={selectedProject.status} />
              {formatLabel(selectedProject.status)}
            </span>
            <button
              type="button"
              onClick={refreshSelectedProject}
              className="inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-900/70 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white"
            >
              Refresh
            </button>
          </div>
        </div>

        {detailLoading && !detail.scores ? (
          <div className="mt-6">
            <LoadingSkeleton lines={4} height={18} />
          </div>
        ) : (
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-slate-700/70 bg-slate-900/40 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Balance</p>
              <p className="mt-1 text-2xl font-semibold text-white">{formatBalance(detail.balance)}</p>
              <p className="mt-1 text-sm text-slate-400">Lower is more even across dimensions.</p>
            </div>
            <div className="rounded-xl border border-slate-700/70 bg-slate-900/40 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Weakest Dimension</p>
              {weakest ? (
                <>
                  <p className="mt-1 text-lg font-semibold text-white">{formatLabel(weakest.dimension)}</p>
                  <p className="text-sm text-slate-400">{Math.round(weakest.score)}</p>
                </>
              ) : (
                <p className="mt-1 text-sm text-slate-400">No scores yet</p>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">Active Loop Summary</h3>
            <p className="text-sm text-slate-400">Per-project instance counts and active stage mix.</p>
          </div>
          <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs text-slate-300">
            Refreshes every 5s
          </span>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => {
            const summary = loopSummaries[project.id] || { activeCount: 0, stages: [], error: null };
            const stagesLabel = summary.stages.length > 0 ? summary.stages.join(', ') : '—';

            return (
              <div
                key={project.id}
                className={`rounded-xl border p-4 ${
                  project.id === selectedProject.id
                    ? 'border-blue-500/40 bg-blue-500/5'
                    : 'border-slate-700/70 bg-slate-900/40'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-white">{project.name || project.id}</p>
                  <span className="rounded-full border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-xs text-slate-300">
                    {summary.activeCount} active
                  </span>
                </div>
                <p className="mt-2 text-sm text-slate-300">
                  {summary.activeCount} active loop{summary.activeCount === 1 ? '' : 's'} • stages: [{stagesLabel}]
                </p>
                {summary.error && (
                  <p className="mt-2 text-xs text-amber-300">{summary.error}</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <LoopControlBar
        activeProjectAction={activeProjectAction}
        approvalsHref={approvalsHref}
        handleToggleProject={handleToggleProject}
        pendingApprovalCount={pendingApprovalCount}
        project={selectedProject}
        projects={projects}
        selectedProjectId={selectedProjectId}
        setSelectedProjectId={setSelectedProjectId}
      />

      <section className="mt-4 rounded-lg border border-slate-700 bg-slate-800/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-200">Recent Activity</h3>
            <p className="mt-1 text-xs text-slate-500">Latest decision log entries for the selected project.</p>
          </div>
          <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs text-slate-300">
            {visibleActivity.length} shown
          </span>
        </div>

        {!recentActivityHydrated ? (
          <div className="mt-4">
            <LoadingSkeleton lines={3} height={16} />
          </div>
        ) : visibleActivity.length === 0 ? (
          <div className="mt-4 rounded-xl border border-slate-700/70 bg-slate-900/40 px-4 py-6 text-sm text-slate-400">
            No activity yet
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-700 text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Stage</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/70">
                {visibleActivity.map((entry, index) => {
                  const activityKey = entry.id || `${entry.created_at || 'unknown'}-${entry.action || index}`;
                  const activityStage = normalizeDecisionStage(entry.stage);
                  const reason = truncateText(entry.reasoning || entry.reason);

                  return (
                    <tr key={activityKey} className="align-top">
                      <td className="px-3 py-3 text-slate-300" title={formatTimestamp(entry.created_at)}>
                        {formatRelativeTime(entry.created_at)}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                          DECISION_STAGE_BADGE_STYLES[activityStage] || BADGE_FALLBACK_STYLE
                        }`}
                        >
                          {formatLabel(activityStage)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-slate-200">{entry.action || 'Unknown action'}</td>
                      <td className="px-3 py-3 text-slate-400" title={entry.reasoning || entry.reason || ''}>
                        {reason || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
        </section>

      <section className="mt-4 rounded-lg border border-slate-700 bg-slate-800/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-200">Cycle History</h3>
            <p className="mt-1 text-xs text-slate-500">Last 20 factory loop instances for the selected project.</p>
          </div>
          <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs text-slate-300">
            {cycleHistoryLoading ? 'Loading...' : `${cycleHistory.length} shown`}
          </span>
        </div>

        {cycleHistoryError && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            {cycleHistoryError}
          </div>
        )}

        {cycleHistoryLoading && cycleHistory.length === 0 ? (
          <div className="mt-4">
            <LoadingSkeleton lines={4} height={16} />
          </div>
        ) : cycleHistory.length === 0 ? (
          <div className="mt-4 rounded-xl border border-slate-700/70 bg-slate-900/40 px-4 py-6 text-sm text-slate-400">
            No recent factory cycles yet
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-700 text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Instance ID</th>
                  <th className="px-3 py-2 font-medium">Work Item</th>
                  <th className="px-3 py-2 font-medium">Started</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Stages Reached</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/70">
                {cycleHistory.map((cycle) => {
                  const status = String(cycle?.status || '').toLowerCase();
                  return (
                    <tr key={cycle.instance_id} className="align-top">
                      <td className="px-3 py-3 font-mono text-slate-300">
                        {cycle.instance_id ? String(cycle.instance_id).slice(0, 8) : '—'}
                      </td>
                      <td className="px-3 py-3 text-slate-200" title={formatCycleWorkItem(cycle)}>
                        {truncateText(formatCycleWorkItem(cycle), 72)}
                      </td>
                      <td className="px-3 py-3 text-slate-300" title={formatTimestamp(cycle.started_at)}>
                        {formatRelativeTime(cycle.started_at)}
                      </td>
                      <td className="px-3 py-3 text-slate-300">{formatCycleDuration(cycle.duration_ms)}</td>
                      <td className="px-3 py-3 text-slate-400" title={formatCycleStages(cycle.stage_progression)}>
                        {truncateText(formatCycleStages(cycle.stage_progression), 96) || '—'}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                          CYCLE_STATUS_BADGE_STYLES[status] || BADGE_FALLBACK_STYLE
                        }`}
                        >
                          {formatLabel(status)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
