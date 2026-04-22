import { useCallback, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { factory as factoryApi } from '../api';
import LoadingSkeleton from '../components/LoadingSkeleton';
import { StarvationBanner } from '../components/StarvationBanner';
import StatCard from '../components/StatCard';
import { useToast } from '../components/Toast';
import { ProjectCard } from './factory/shared';
import { useFactoryShell } from './factory/useFactoryShell';

const FACTORY_TABS = [
  { to: '/factory', label: 'Overview', end: true },
  { to: '/factory/intake', label: 'Intake' },
  { to: '/factory/health', label: 'Health' },
  { to: '/factory/decisions', label: 'Activity' },
  { to: '/factory/history', label: 'History' },
  { to: '/factory/policy', label: 'Policy' },
];

export default function Factory() {
  const [clearRecoveryProjectId, setClearRecoveryProjectId] = useState(null);
  const toast = useToast();
  const {
    activeProjectAction,
    handlePauseAll,
    handleToggleProject,
    loadProjects,
    loading,
    outletContext,
    pauseAllBusy,
    pausedProjects,
    projectActivity,
    projects,
    projectsError,
    runningProjects,
    setSelectedProjectId,
    totalProjects,
  } = useFactoryShell();
  const { refreshSelectedProject, selectedProjectId } = outletContext;

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

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Software Factory</h1>
          <p className="mt-1 text-sm text-slate-400">Health, trust, and runtime state across registered factory projects.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={() => loadProjects({ silent: totalProjects > 0 })}
            className="inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-900/70 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
          {totalProjects > 0 && (
            <button
              type="button"
              disabled={pauseAllBusy}
              onClick={handlePauseAll}
              className="inline-flex items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pauseAllBusy ? 'Pausing...' : 'Pause All'}
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Total Projects" value={totalProjects} gradient="blue" />
        <StatCard label="Running" value={runningProjects} gradient="green" />
        <StatCard label="Paused" value={pausedProjects} gradient="orange" />
      </div>

      {loading ? (
        <div className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
          <LoadingSkeleton lines={6} height={18} />
        </div>
      ) : totalProjects === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/70 px-8 py-12 text-center">
          <h2 className="text-xl font-semibold text-white">{projectsError ? 'Unable to load factory projects' : 'No factory projects yet'}</h2>
          <p className="mx-auto mt-2 max-w-2xl text-sm text-slate-400">
            {projectsError || 'No registered projects are available for the factory dashboard yet.'}
          </p>
          <button
            type="button"
            onClick={() => loadProjects()}
            className="mt-6 inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-900/70 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white"
          >
            Refresh
          </button>
        </div>
      ) : (
        <>
          {projectsError && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-100">
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

          <div className="grid gap-6 xl:grid-cols-3">
            {projects.map((project) => (
              <div key={project.id} className="space-y-3">
                <StarvationBanner project={project} />
                <ProjectCard
                  project={project}
                  activity={projectActivity[project.id]}
                  selected={outletContext.selectedProjectId === project.id}
                  busy={activeProjectAction === project.id}
                  onSelect={setSelectedProjectId}
                  onToggle={handleToggleProject}
                  onClearAutoRecovery={handleClearAutoRecovery}
                  clearAutoRecoveryBusy={clearRecoveryProjectId === project.id}
                />
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-slate-700 bg-slate-800/70 p-2">
            <nav className="flex flex-wrap gap-2" aria-label="Factory sections">
              {FACTORY_TABS.map((tab) => (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  end={tab.end}
                  className={({ isActive }) => (
                    `rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
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

          {outletContext.selectedProject && (
            <Outlet context={outletContext} />
          )}
        </>
      )}
    </div>
  );
}
