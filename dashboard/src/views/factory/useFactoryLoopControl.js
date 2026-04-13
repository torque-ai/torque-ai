import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { factory as factoryApi, tasks as tasksApi } from '../../api';
import { useToast } from '../../components/Toast';
import { getProjectsFromResponse, mergeLoopState } from './utils';

const LOOP_POLL_INTERVAL_MS = 5000;
const LOOP_JOB_POLL_INTERVAL_MS = 2000;

function getProjectActivityTimestamp(project) {
  const timestamp = new Date(project?.loop_last_action_at || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function chooseDefaultProjectId(projects, currentId) {
  if (!Array.isArray(projects) || projects.length === 0) {
    return null;
  }

  if (projects.some((project) => project.id === currentId)) {
    return currentId;
  }

  if (projects.length === 1) {
    return projects[0].id;
  }

  const [mostRecentlyActiveProject] = [...projects].sort((left, right) => (
    getProjectActivityTimestamp(right) - getProjectActivityTimestamp(left)
  ));

  return mostRecentlyActiveProject?.id || projects[0]?.id || null;
}

function getPendingApprovalTotal(response) {
  return Number(response?.total) || response?.tasks?.length || 0;
}

export function useFactoryLoopControl() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [projectsError, setProjectsError] = useState(null);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [loopStatus, setLoopStatus] = useState(null);
  const [loopStatusRefreshedAt, setLoopStatusRefreshedAt] = useState(null);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [loopAdvanceJob, setLoopAdvanceJob] = useState(null);
  const [loopActionBusy, setLoopActionBusy] = useState(null);
  const [activeProjectAction, setActiveProjectAction] = useState(null);
  const toast = useToast();
  const projectsRef = useRef(projects);
  const selectedProjectIdRef = useRef(selectedProjectId);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  const loadProjects = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
    }

    try {
      const response = await factoryApi.projects();
      const nextProjects = getProjectsFromResponse(response);
      setProjects(nextProjects);
      setProjectsError(null);
      setSelectedProjectId((current) => chooseDefaultProjectId(nextProjects, current));
      return nextProjects;
    } catch (error) {
      setProjectsError(error?.message || 'Failed to load factory projects.');
      return null;
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  const applyLoopStatus = useCallback((projectId, nextLoopStatus, nextProjects = null) => {
    if (!nextLoopStatus || typeof nextLoopStatus !== 'object') {
      return;
    }

    const refreshedAt = Date.now();
    setLoopStatus(nextLoopStatus);
    setLoopStatusRefreshedAt(refreshedAt);
    setProjects((current) => {
      const baseProjects = Array.isArray(nextProjects) ? nextProjects : current;
      return baseProjects.map((project) => (
        project.id === projectId ? mergeLoopState(project, nextLoopStatus) : project
      ));
    });
  }, []);

  const selectedProject = useMemo(() => {
    const project = projects.find((entry) => entry.id === selectedProjectId) || null;
    return project ? mergeLoopState(project, loopStatus || {}) : null;
  }, [loopStatus, projects, selectedProjectId]);
  const selectedProjectName = selectedProject?.name || '';

  const approvalsHref = selectedProjectName
    ? `/approvals?${new URLSearchParams({ project: selectedProjectName, source: 'factory' }).toString()}`
    : null;

  const loopRefreshAgeSeconds = loopStatusRefreshedAt === null
    ? null
    : Math.max(0, Math.floor((Date.now() - loopStatusRefreshedAt) / 1000));

  const refreshSelectedProject = useCallback(async ({ includeProjects = false } = {}) => {
    const projectId = selectedProjectIdRef.current;
    if (!projectId) {
      return null;
    }

    const loadedProjects = includeProjects
      ? await loadProjects({ silent: true })
      : projectsRef.current;
    const nextProjects = Array.isArray(loadedProjects) ? loadedProjects : projectsRef.current;

    const nextProject = nextProjects.find((project) => project.id === projectId);

    const [nextLoopStatus, pendingApprovalResponse] = await Promise.all([
      factoryApi.loopStatus(projectId).catch(() => null),
      nextProject?.name
        ? tasksApi.list({ status: 'pending_approval', project: nextProject.name, limit: 1 }).catch(() => null)
        : Promise.resolve(null),
    ]);

    if (nextLoopStatus) {
      applyLoopStatus(projectId, nextLoopStatus, includeProjects ? nextProjects : null);
    } else if (includeProjects && Array.isArray(loadedProjects)) {
      setProjects(nextProjects);
    }

    if (pendingApprovalResponse) {
      setPendingApprovalCount(getPendingApprovalTotal(pendingApprovalResponse));
    }

    return nextLoopStatus;
  }, [applyLoopStatus, loadProjects]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedProjectId) {
      setLoopStatus(null);
      setLoopStatusRefreshedAt(null);
      setPendingApprovalCount(0);
      return undefined;
    }

    let cancelled = false;
    let polling = false;

    const pollSelectedProject = async () => {
      if (polling) {
        return;
      }

      polling = true;
      try {
        const [nextLoopStatus, pendingApprovalResponse] = await Promise.all([
          factoryApi.loopStatus(selectedProjectId).catch(() => null),
          selectedProjectName
            ? tasksApi.list({ status: 'pending_approval', project: selectedProjectName, limit: 1 }).catch(() => null)
            : Promise.resolve({ total: 0, tasks: [] }),
        ]);

        if (cancelled) {
          return;
        }

        if (nextLoopStatus) {
          applyLoopStatus(selectedProjectId, nextLoopStatus);
        }

        if (pendingApprovalResponse) {
          setPendingApprovalCount(getPendingApprovalTotal(pendingApprovalResponse));
        }
      } finally {
        polling = false;
      }
    };

    pollSelectedProject();
    const intervalId = setInterval(pollSelectedProject, LOOP_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [applyLoopStatus, selectedProjectId, selectedProjectName]);

  useEffect(() => {
    const activeJobId = loopAdvanceJob?.job_id || null;
    const activeProjectId = loopAdvanceJob?.projectId || null;
    const isLoopAdvanceRunning = loopAdvanceJob?.status === 'running';

    if (!isLoopAdvanceRunning || !activeJobId || !activeProjectId) {
      return undefined;
    }

    let cancelled = false;
    let polling = false;

    const pollJob = async () => {
      if (polling) {
        return;
      }

      polling = true;
      try {
        const status = await factoryApi.loopJobStatus(activeProjectId, activeJobId);
        if (cancelled) {
          return;
        }

        setLoopAdvanceJob((current) => {
          if (!current || current.job_id !== activeJobId) {
            return current;
          }

          const nextJob = { ...current, ...status, projectId: current.projectId };
          if (
            current.status === nextJob.status
            && current.new_state === nextJob.new_state
            && current.paused_at_stage === nextJob.paused_at_stage
            && current.reason === nextJob.reason
            && current.completed_at === nextJob.completed_at
            && current.error === nextJob.error
            && JSON.stringify(current.stage_result ?? null) === JSON.stringify(nextJob.stage_result ?? null)
          ) {
            return current;
          }

          return nextJob;
        });

        if (status.status === 'running') {
          return;
        }

        setLoopActionBusy(null);
        await refreshSelectedProject({ includeProjects: true });

        if (cancelled) {
          return;
        }

        if (status.status === 'completed') {
          toast.success('Factory stage completed');
        } else {
          toast.error(status.error || 'Factory stage failed');
        }

        setLoopAdvanceJob(null);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setLoopActionBusy(null);
        setLoopAdvanceJob(null);
        await refreshSelectedProject({ includeProjects: true });
        toast.error(`Failed to track factory stage: ${error.message}`);
      } finally {
        polling = false;
      }
    };

    pollJob();
    const intervalId = setInterval(pollJob, LOOP_JOB_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [loopAdvanceJob, refreshSelectedProject, toast]);

  const handleToggleProject = useCallback(async (project) => {
    const shouldPause = project.status === 'running';
    const action = shouldPause ? 'pause' : 'resume';
    setActiveProjectAction(project.id);

    try {
      if (shouldPause) {
        await factoryApi.pause(project.id);
      } else {
        await factoryApi.resume(project.id);
      }

      toast.success(`Project ${action}d`);
      await loadProjects({ silent: true });
    } catch (error) {
      toast.error(`Failed to ${action} project: ${error.message}`);
    } finally {
      setActiveProjectAction(null);
    }
  }, [loadProjects, toast]);

  const runLoopAction = useCallback(async (action, runner) => {
    if (!selectedProjectIdRef.current) {
      return;
    }

    setLoopActionBusy(action);
    try {
      await runner();
      await refreshSelectedProject();
    } catch (error) {
      toast.error(error?.message || `Failed to ${action} loop`);
    } finally {
      setLoopActionBusy(null);
    }
  }, [refreshSelectedProject, toast]);

  const startLoop = useCallback(async () => {
    if (!selectedProjectIdRef.current) {
      return;
    }

    await runLoopAction('start', () => factoryApi.startLoop(selectedProjectIdRef.current));
  }, [runLoopAction]);

  const approveGate = useCallback(async () => {
    const project = projectsRef.current.find((entry) => entry.id === selectedProjectIdRef.current);
    if (!project) {
      return;
    }

    await runLoopAction('approve', () => factoryApi.approveGate(project.id, project.loop_paused_at_stage));
  }, [runLoopAction]);

  const advanceLoop = useCallback(async () => {
    if (!selectedProjectIdRef.current) {
      return;
    }

    setLoopActionBusy('advance');
    try {
      const descriptor = await factoryApi.advanceLoopAsync(selectedProjectIdRef.current);
      setLoopAdvanceJob({
        ...descriptor,
        projectId: selectedProjectIdRef.current,
      });
    } catch (error) {
      setLoopActionBusy(null);
      setLoopAdvanceJob(null);
      toast.error(error?.message || 'Failed to advance loop');
    }
  }, [toast]);

  return {
    activeProjectAction,
    approvalsHref,
    approveGate,
    advanceLoop,
    handleToggleProject,
    loadProjects,
    loading,
    loopActionBusy,
    loopAdvanceJob,
    loopRefreshAgeSeconds,
    loopStatus,
    pendingApprovalCount,
    projects,
    projectsError,
    refreshSelectedProject,
    selectedProject,
    selectedProjectId,
    setSelectedProjectId,
    startLoop,
  };
}
