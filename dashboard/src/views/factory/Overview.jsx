import { useOutletContext } from 'react-router-dom';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import { BatchTimeline, StatusDot, TrustBadge } from './shared';
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

export default function Overview() {
  const {
    activeProjectAction,
    approvalsHref,
    advanceLoop,
    approveGate,
    detail,
    detailLoading,
    handleToggleProject,
    loopAdvanceJob,
    loopActionBusy,
    loopRefreshAgeSeconds,
    pendingApprovalCount,
    projects,
    recentActivity,
    recentActivityHydrated,
    refreshSelectedProject,
    selectedProject,
    selectedProjectId,
    setSelectedProjectId,
    startLoop,
  } = useOutletContext();

  if (!selectedProject || !detail) {
    return null;
  }

  const weakest = detail.weakest_dimension;
  const visibleActivity = recentActivity.slice(0, 5);
  const projectToggleLabel = selectedProject.status === 'running' ? 'Pause' : 'Resume';
  const isProjectToggleBusy = activeProjectAction === selectedProject.id;
  const isAdvanceJobRunning = loopAdvanceJob?.status === 'running' && loopAdvanceJob?.projectId === selectedProject.id;

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

      <LoopControlBar
        activeProjectAction={activeProjectAction}
        approvalsHref={approvalsHref}
        approveGate={approveGate}
        advanceLoop={advanceLoop}
        handleToggleProject={handleToggleProject}
        loopActionBusy={loopActionBusy}
        pendingApprovalCount={pendingApprovalCount}
        projects={projects}
        selectedProject={selectedProject}
        selectedProjectId={selectedProjectId}
        setSelectedProjectId={setSelectedProjectId}
        startLoop={startLoop}
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {loopRefreshAgeSeconds !== null ? (
              <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs text-slate-300">
                Refreshed {loopRefreshAgeSeconds}s ago
              </span>
            ) : (
              <span className="text-xs text-slate-500">Waiting for loop status...</span>
            )}
            {isProjectToggleBusy && (
              <span className="text-xs text-slate-400">{projectToggleLabel} request in progress...</span>
            )}
          </div>
          <BatchTimeline
            currentStage={selectedProject.loop_state}
            pausedAtStage={selectedProject.loop_paused_at_stage}
          />
          {isAdvanceJobRunning && (
            <p className="text-xs text-cyan-300">
              Stage running... Polling every 2s.
            </p>
          )}
          {selectedProject.loop_last_action_at && (
            <p className="text-xs text-slate-500">Last action: {new Date(selectedProject.loop_last_action_at).toLocaleString()}</p>
          )}
        </div>
      </LoopControlBar>

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
    </div>
  );
}
