import { useNavigate } from 'react-router-dom';

function getLoopStateBadge(loopState, pausedAtStage) {
  if (!loopState || loopState === 'IDLE') {
    return {
      className: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200',
      label: 'IDLE',
    };
  }

  if (loopState === 'PAUSED') {
    return {
      className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
      label: pausedAtStage ? `PAUSED · ${pausedAtStage}` : 'PAUSED',
    };
  }

  return {
    className: 'border-blue-500/30 bg-blue-500/10 text-blue-200',
    label: loopState,
  };
}

export default function LoopControlBar({
  activeProjectAction,
  approvalsHref,
  approveGate,
  advanceLoop,
  children,
  className = '',
  handleToggleProject,
  loopActionBusy,
  pendingApprovalCount,
  projects,
  selectedProject,
  selectedProjectId,
  setSelectedProjectId,
  startLoop,
}) {
  const navigate = useNavigate();

  if (!Array.isArray(projects) || projects.length === 0 || !selectedProject) {
    return null;
  }

  const loopState = selectedProject.loop_state || 'IDLE';
  const badge = getLoopStateBadge(loopState, selectedProject.loop_paused_at_stage);
  const projectToggleLabel = selectedProject.status === 'running' ? 'Pause' : 'Resume';
  const isProjectToggleBusy = activeProjectAction === selectedProject.id;

  return (
    <section className={`rounded-lg border border-slate-700 bg-slate-800/60 p-4 ${className}`.trim()}>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-slate-200">Factory Loop</span>
          <select
            aria-label="Factory project"
            value={selectedProjectId || ''}
            onChange={(event) => setSelectedProjectId(event.target.value || null)}
            className="min-w-[12rem] rounded-lg border border-slate-700/50 bg-slate-800/60 px-3 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name || project.id}
              </option>
            ))}
          </select>
          <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}>
            {badge.label}
          </span>
          {pendingApprovalCount > 0 && approvalsHref && (
            <button
              type="button"
              onClick={() => navigate(approvalsHref)}
              className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200 transition-colors hover:border-amber-400/40 hover:bg-amber-500/15"
            >
              {pendingApprovalCount} task{pendingApprovalCount === 1 ? '' : 's'} awaiting approval &rarr;
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          {loopState === 'IDLE' && (
            <button
              type="button"
              disabled={loopActionBusy === 'start'}
              className="rounded bg-cyan-600 px-3 py-1 text-xs text-white hover:bg-cyan-500 disabled:opacity-50"
              onClick={startLoop}
            >
              {loopActionBusy === 'start' ? 'Starting...' : 'Start Loop'}
            </button>
          )}
          {loopState === 'PAUSED' && (
            <button
              type="button"
              disabled={loopActionBusy === 'approve'}
              className="rounded bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
              onClick={approveGate}
            >
              {loopActionBusy === 'approve' ? 'Approving...' : 'Approve Gate'}
            </button>
          )}
          {loopState !== 'IDLE' && loopState !== 'PAUSED' && (
            <button
              type="button"
              disabled={loopActionBusy === 'advance'}
              className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
              onClick={advanceLoop}
            >
              {loopActionBusy === 'advance' ? 'Advancing...' : 'Advance'}
            </button>
          )}
          <button
            type="button"
            disabled={isProjectToggleBusy}
            onClick={() => handleToggleProject(selectedProject)}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
              selectedProject.status === 'running'
                ? 'bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                : 'bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
            }`}
          >
            {isProjectToggleBusy ? 'Working...' : projectToggleLabel}
          </button>
        </div>
      </div>

      {children ? <div className="mt-3">{children}</div> : null}
    </section>
  );
}
