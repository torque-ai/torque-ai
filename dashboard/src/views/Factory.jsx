import { useCallback, useMemo, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { factory as factoryApi } from '../api';
import LoadingSkeleton from '../components/LoadingSkeleton';
import { StarvationBanner } from '../components/StarvationBanner';
import { useToast } from '../components/Toast';
import { ProjectCard, ProjectListRow, SelectProjectPrompt } from './factory/shared';
import { groupProjectsForList } from './factory/utils';
import { useFactoryShell } from './factory/useFactoryShell';

const FACTORY_TABS = [
  { to: '/factory', label: 'Overview', end: true },
  { to: '/factory/intake', label: 'Intake' },
  { to: '/factory/health', label: 'Health' },
  { to: '/factory/activity', label: 'Activity' },
  { to: '/factory/history', label: 'History' },
  { to: '/factory/policy', label: 'Policy' },
];

const IDLE_REASON_TITLES = {
  all_projects_paused: 'All projects paused',
  manual_gate_pending: 'Manual gate pending',
  no_running_projects: 'No running projects',
  factory_project_work_disabled: 'Project work disabled',
  work_waiting_for_loop: 'Work waiting for a loop',
  queue_empty_no_open_work: 'Queue empty',
};

function FactoryIdleDiagnosisBanner({ diagnosis, loading, onRefresh }) {
  if (!diagnosis?.idle || diagnosis.reason_code === 'no_projects_registered') {
    return null;
  }

  const counts = diagnosis.counts || {};
  const queue = counts.task_queue || {};
  const title = IDLE_REASON_TITLES[diagnosis.reason_code] || 'Factory idle';
  const metrics = [
    `${counts.running_projects || 0} running`,
    `${counts.paused_projects || 0} paused`,
    `${counts.open_work_items || 0} open items`,
    `${queue.total_non_terminal || 0} queued`,
  ];

  return (
    <div
      role="status"
      aria-label="Factory idle diagnosis"
      className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-100"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-300">Factory idle</p>
          <h2 className="mt-1 text-base font-semibold text-white">{title}</h2>
          <p className="mt-1 text-amber-100/90">{diagnosis.message}</p>
          <p className="mt-2 text-xs text-amber-200/80">{metrics.join(' · ')}</p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => onRefresh({ silent: true })}
          className="inline-flex items-center justify-center rounded-lg border border-amber-400/40 bg-slate-900/40 px-3 py-1.5 text-sm font-medium text-amber-100 transition-colors hover:bg-slate-900/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

function FactoryAutomationReadinessBanner({
  readiness,
  projects,
  loading,
  onRefresh,
  onApplyPlan,
  applyMode,
}) {
  if (!readiness || readiness.total_projects === 0) {
    return null;
  }

  const blockedProjects = new Set(readiness.project_ids?.blocked || []);
  const blockedNames = (projects || [])
    .filter((project) => blockedProjects.has(project.id))
    .map((project) => project.name || project.id)
    .slice(0, 3);
  const blockerEntries = Object.entries(readiness.blockers || {})
    .filter(([, count]) => Number(count) > 0)
    .slice(0, 4);
  const projectLabelsById = new Map((projects || []).map((project) => [
    project.id,
    project.name || project.id,
  ]));
  const summaryPlan = Array.isArray(readiness.control_plane_plan)
    ? readiness.control_plane_plan
    : [];
  const projectActionFallback = (projects || [])
    .filter((project) => blockedProjects.has(project.id))
    .flatMap((project) => {
      const actions = project.automation_readiness?.control_plane_actions;
      const fallback = project.automation_readiness?.next_control_plane_action;
      return (Array.isArray(actions) && actions.length > 0 ? actions : [fallback])
        .filter(Boolean)
        .map((action) => ({
          label: project.name || project.id,
          action,
          description: null,
          tool: null,
        }));
    });
  const nextActions = (summaryPlan.length > 0
    ? summaryPlan.map((step) => {
      const projectRef = step?.args?.project;
      return {
        label: projectLabelsById.get(projectRef) || projectRef || step?.tool || 'Factory',
        action: step?.action,
        description: step?.description || null,
        tool: step?.tool || null,
      };
    })
    : projectActionFallback)
    .filter((entry) => entry.action || entry.description)
    .slice(0, 3);
  const manualIntervention = readiness.manual_intervention || {};
  const manualCounts = manualIntervention.counts || {};
  const manualRequired = manualIntervention.required === true;
  const summarizedNeedsReview = Number(manualCounts.needs_review_work_items);
  const needsReviewCount = Number.isFinite(summarizedNeedsReview)
    ? summarizedNeedsReview
    : (projects || []).reduce((sum, project) => (
      sum + (Number(project?.work_item_status_counts?.needs_review) || 0)
    ), 0);
  const pendingApprovalCount = Number(manualCounts.pending_approval_tasks) || 0;
  const exhaustedCount = Number(manualCounts.escalation_exhausted_work_items) || 0;
  const schedulerUnarmedCount = Number(manualCounts.scheduler_unarmed_projects) || 0;
  const projectWorkDisabled = readiness.project_work_enabled === false
    || (manualIntervention.reason_codes || []).includes('factory_project_work_disabled');
  const needsReplanCount = (projects || []).reduce((sum, project) => (
    sum + (Number(project?.work_item_status_counts?.needs_replan) || 0)
  ), 0);
  const isControlReady = readiness.ready === true;
  const isReady = readiness.hands_off_ready === true || (readiness.hands_off_ready == null && isControlReady && !manualRequired);
  const canApplyControlPlan = summaryPlan.length > 0;
  const title = isReady
    ? 'All projects ready for hands-off cycling'
    : (isControlReady && projectWorkDisabled
      ? 'Automation controls ready; project work disabled'
      : isControlReady
      ? 'Automation controls ready; manual intervention queued'
      : `${readiness.blocked_projects || 0} project${readiness.blocked_projects === 1 ? '' : 's'} blocked`);

  return (
    <div
      role="status"
      aria-label="Factory automation readiness"
      className={`rounded-lg border px-5 py-4 text-sm ${
        isReady
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
          : 'border-sky-500/30 bg-sky-500/10 text-sky-100'
      }`}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${isReady ? 'text-emerald-300' : 'text-sky-300'}`}>
            Automation readiness
          </p>
          <h2 className="mt-1 text-base font-semibold text-white">
            {title}
          </h2>
          <p className={`mt-1 ${isReady ? 'text-emerald-100/90' : 'text-sky-100/90'}`}>
            {readiness.ready_projects || 0} control-ready · {readiness.auto_continue_enabled_projects || 0} auto-continue · {readiness.dark_trust_projects || 0} dark trust · project work {projectWorkDisabled ? 'disabled' : 'enabled'}
          </p>
          {(schedulerUnarmedCount > 0 || pendingApprovalCount > 0 || needsReviewCount > 0 || needsReplanCount > 0 || exhaustedCount > 0) && (
            <p className={`mt-2 text-xs ${isReady ? 'text-emerald-200/80' : 'text-sky-200/80'}`}>
              {schedulerUnarmedCount} tick unarmed · {pendingApprovalCount} approvals · {needsReviewCount} needs review · {needsReplanCount} needs replan · {exhaustedCount} exhausted
            </p>
          )}
          {!isControlReady && blockedNames.length > 0 && (
            <p className="mt-2 text-xs text-sky-200/80">Blocked: {blockedNames.join(', ')}</p>
          )}
          {!isControlReady && blockerEntries.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {blockerEntries.map(([code, count]) => (
                <span
                  key={code}
                  className="rounded-full border border-sky-400/30 bg-slate-950/30 px-2.5 py-1 text-xs font-medium text-sky-100"
                >
                  {code.replace(/_/g, ' ')}: {count}
                </span>
              ))}
            </div>
          )}
          {!isControlReady && nextActions.length > 0 && (
            <div className="mt-3 space-y-1 text-xs text-sky-100/90">
              {nextActions.map(({ label, action, description, tool }) => (
                <p key={`${label}:${action || description}`} className="break-words">
                  <span className="font-medium text-sky-200">{label}:</span>{' '}
                  {description || action}
                  {tool && action && (
                    <span className="ml-1 text-sky-200/70">({tool}: {action})</span>
                  )}
                </p>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canApplyControlPlan && (
            <>
              <button
                type="button"
                disabled={loading || Boolean(applyMode)}
                onClick={() => onApplyPlan({ dryRun: true })}
                className="inline-flex items-center justify-center rounded-lg border border-sky-400/40 bg-slate-900/40 px-3 py-1.5 text-sm font-medium text-sky-100 transition-colors hover:bg-slate-900/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {applyMode === 'dry_run' ? 'Checking...' : 'Dry Run'}
              </button>
              <button
                type="button"
                disabled={loading || Boolean(applyMode)}
                onClick={() => onApplyPlan({ dryRun: false })}
                className="inline-flex items-center justify-center rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-100 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {applyMode === 'apply' ? 'Applying...' : 'Apply Controls'}
              </button>
            </>
          )}
          <button
            type="button"
            disabled={loading}
            onClick={() => onRefresh({ silent: true })}
            className="inline-flex items-center justify-center rounded-lg border border-sky-400/40 bg-slate-900/40 px-3 py-1.5 text-sm font-medium text-sky-100 transition-colors hover:bg-slate-900/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}

function getAutomationPlanProjectIds(readiness) {
  const plan = Array.isArray(readiness?.control_plane_plan)
    ? readiness.control_plane_plan
    : [];
  if (plan.length === 0) {
    return [];
  }
  const projectIds = new Set();
  for (const step of plan) {
    const projectId = step?.args?.project;
    if (!projectId) {
      return [];
    }
    projectIds.add(projectId);
  }
  return Array.from(projectIds);
}

function getAutomationPlanProjectScope(readiness) {
  const projectIds = getAutomationPlanProjectIds(readiness);
  if (projectIds.length !== 1) {
    return null;
  }
  return projectIds[0];
}

function confirmMultiProjectAutomationApply(readiness) {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
    return false;
  }
  const projectCount = getAutomationPlanProjectIds(readiness).length
    || Number(readiness?.blocked_projects)
    || Number(readiness?.total_projects)
    || 0;
  const scopeLabel = projectCount > 0
    ? `${projectCount} project${projectCount === 1 ? '' : 's'}`
    : 'multiple projects';
  return window.confirm(
    `Apply automation control-plane changes to ${scopeLabel}? This will not process project work, but it can resume projects, change trust, and arm future ticks.`
  );
}

export default function Factory() {
  const [automationApplyMode, setAutomationApplyMode] = useState(null);
  const [clearRecoveryProjectId, setClearRecoveryProjectId] = useState(null);
  const toast = useToast();
  const {
    activeProjectAction,
    automationReadiness,
    handlePauseAll,
    handleSetProjectWorkEnabled,
    handleToggleProject,
    idleDiagnosis,
    loadProjects,
    loading,
    outletContext,
    pauseAllBusy,
    pausedProjects,
    projectActivity,
    projectWorkBusy,
    projects,
    projectsError,
    runningProjects,
    setSelectedProjectId,
    totalProjects,
  } = useFactoryShell();
  const { refreshSelectedProject, selectedProjectId } = outletContext;
  const projectGroups = useMemo(() => groupProjectsForList(projects), [projects]);
  const projectWorkEnabled = automationReadiness?.project_work_enabled !== false;

  const handleClearAutoRecovery = useCallback(async (project) => {
    if (!project?.id || clearRecoveryProjectId) {
      return;
    }

    setClearRecoveryProjectId(project.id);
    try {
      await factoryApi.clearAutoRecovery(project.id);
      await loadProjects({ silent: true });
      if (project.id === selectedProjectId) {
        await refreshSelectedProject();
      }
      toast.success('Auto-recovery state cleared');
    } catch (error) {
      toast.error(`Failed to clear auto-recovery: ${error.message}`);
    } finally {
      setClearRecoveryProjectId(null);
    }
  }, [clearRecoveryProjectId, loadProjects, refreshSelectedProject, selectedProjectId, toast]);

  const handleApplyAutomationPlan = useCallback(async ({ dryRun }) => {
    if (automationApplyMode) {
      return;
    }

    const mode = dryRun ? 'dry_run' : 'apply';
    const scopedProjectId = getAutomationPlanProjectScope(automationReadiness);
    if (!dryRun && !scopedProjectId && !confirmMultiProjectAutomationApply(automationReadiness)) {
      return;
    }

    setAutomationApplyMode(mode);
    try {
      const result = scopedProjectId
        ? await factoryApi.applyProjectAutomationPlan(scopedProjectId, {
          dry_run: dryRun,
        })
        : await factoryApi.applyAutomationPlan({
          all_projects: true,
          dry_run: dryRun,
          ...(dryRun ? {} : { confirm_all_projects: true }),
        });
      const planned = Number(result?.planned_steps) || 0;
      const applied = Array.isArray(result?.applied_steps) ? result.applied_steps.length : 0;
      if (dryRun) {
        toast.success(`Automation dry run found ${planned} control-plane step${planned === 1 ? '' : 's'}`);
      } else {
        toast.success(`Applied ${applied} automation control step${applied === 1 ? '' : 's'}`);
      }
      await loadProjects({ silent: true });
      if (selectedProjectId) {
        await refreshSelectedProject();
      }
    } catch (error) {
      toast.error(`Failed to apply automation plan: ${error.message}`);
    } finally {
      setAutomationApplyMode(null);
    }
  }, [automationApplyMode, automationReadiness, loadProjects, refreshSelectedProject, selectedProjectId, toast]);

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-white">Software Factory</h1>
        {totalProjects > 0 && (
          <span className="text-sm text-slate-400">
            {totalProjects} project{totalProjects === 1 ? '' : 's'}
            <span className="text-slate-600"> · </span>
            <span className="text-emerald-300">{runningProjects} running</span>
            <span className="text-slate-600"> · </span>
            <span className="text-amber-300">{pausedProjects} paused</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={() => loadProjects({ silent: totalProjects > 0 })}
            className="inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-900/70 px-3 py-1.5 text-sm font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
          {totalProjects > 0 && (
            <button
              type="button"
              disabled={projectWorkBusy}
              onClick={() => handleSetProjectWorkEnabled(!projectWorkEnabled)}
              className={`inline-flex items-center justify-center rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                projectWorkEnabled
                  ? 'border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/20'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
              }`}
            >
              {projectWorkBusy
                ? 'Updating...'
                : projectWorkEnabled
                ? 'Disable Project Work'
                : 'Enable Project Work'}
            </button>
          )}
          {totalProjects > 0 && (
            <button
              type="button"
              disabled={pauseAllBusy}
              onClick={handlePauseAll}
              className="inline-flex items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pauseAllBusy ? 'Pausing...' : 'Pause All'}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="rounded-lg border border-slate-700 bg-slate-800 p-4">
          <LoadingSkeleton lines={6} height={18} />
        </div>
      ) : totalProjects === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-700 bg-slate-800/70 px-8 py-12 text-center">
          <h2 className="text-xl font-semibold text-white">{projectsError ? 'Unable to load factory projects' : 'No factory projects yet'}</h2>
          <p className="mx-auto mt-2 max-w-2xl text-sm text-slate-400">
            {projectsError || 'No registered projects are available for the factory dashboard yet.'}
          </p>
          <button
            type="button"
            onClick={() => loadProjects()}
            className="mt-6 inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-900/70 px-3 py-1.5 text-sm font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white"
          >
            Refresh
          </button>
        </div>
      ) : (
        <>
          {projectsError && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-100">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <p>Factory data may be stale: {projectsError}</p>
                <button
                  type="button"
                  onClick={() => loadProjects({ silent: true })}
                  className="inline-flex items-center justify-center rounded-lg border border-amber-400/40 bg-slate-900/40 px-3 py-1.5 text-sm font-medium text-amber-100 transition-colors hover:bg-slate-900/60"
                >
                  Refresh
                </button>
              </div>
            </div>
          )}

          <FactoryIdleDiagnosisBanner
            diagnosis={idleDiagnosis}
            loading={loading}
            onRefresh={loadProjects}
          />

          <FactoryAutomationReadinessBanner
            readiness={automationReadiness}
            projects={projects}
            loading={loading}
            onRefresh={loadProjects}
            onApplyPlan={handleApplyAutomationPlan}
            applyMode={automationApplyMode}
          />

          <div className="grid gap-4 md:grid-cols-[minmax(220px,260px)_minmax(0,1fr)]">
            <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-800/40 p-2">
              {projectGroups.map((group) => (
                <div key={group.id} className="space-y-1">
                  <p className="px-2 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    {group.label} <span className="text-slate-600">· {group.items.length}</span>
                  </p>
                  {group.items.map((project) => (
                    <ProjectListRow
                      key={project.id}
                      project={project}
                      activity={projectActivity[project.id]}
                      selected={outletContext.selectedProjectId === project.id}
                      onSelect={setSelectedProjectId}
                    />
                  ))}
                </div>
              ))}
            </div>
            <div className="space-y-3 min-w-0">
              {outletContext.selectedProject ? (
                <>
                  <StarvationBanner project={outletContext.selectedProject} />
                  <ProjectCard
                    project={outletContext.selectedProject}
                    activity={projectActivity[outletContext.selectedProject.id]}
                    selected
                    busy={activeProjectAction === outletContext.selectedProject.id}
                    onSelect={setSelectedProjectId}
                    onToggle={handleToggleProject}
                    onClearAutoRecovery={handleClearAutoRecovery}
                    clearAutoRecoveryBusy={clearRecoveryProjectId === outletContext.selectedProject.id}
                  />
                </>
              ) : (
                <SelectProjectPrompt message="Select a project from the list to view its radar, badges, and details." />
              )}
            </div>
          </div>

          <div className="rounded-lg border border-slate-700 bg-slate-800/70 p-2">
            <nav className="flex flex-wrap gap-2" aria-label="Factory sections">
              {FACTORY_TABS.map((tab) => (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  end={tab.end}
                  className={({ isActive }) => (
                    `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-blue-500/15 text-blue-100'
                        : 'text-slate-400 hover:bg-slate-900/60 hover:text-white'
                    }`
                  )}
                >
                  {tab.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <Outlet context={outletContext} />
        </>
      )}
    </div>
  );
}
