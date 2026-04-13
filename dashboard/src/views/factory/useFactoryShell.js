import { useCallback, useEffect, useRef, useState } from 'react';
import { factory as factoryApi, getDecisionLog, getFactoryDigest, tasks as tasksApi } from '../../api';
import { useToast } from '../../components/Toast';
import {
  buildDetailFallback,
  getDecisionSinceParam,
  getIntakeItemsFromResponse,
  getProjectsFromResponse,
  mergeLoopState,
  normalizeBacklogResponse,
  normalizeCostMetrics,
  normalizeDecisionStage,
  normalizeDecisionStats,
  normalizeHealth,
  normalizeIntakeItem,
} from './utils';

const EMPTY_BACKLOG = { items: [], cycleId: null, reasoningSummary: null };
const EMPTY_DECISION_FILTERS = { stage: '', actor: '', batchId: '', since: '' };

export function useFactoryShell() {
  const [projects, setProjects] = useState([]);
  const [projectActivity, setProjectActivity] = useState({});
  const [loading, setLoading] = useState(true);
  const [projectsError, setProjectsError] = useState(null);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [selectedHealth, setSelectedHealth] = useState(null);
  const [loopStatus, setLoopStatus] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [intakeItems, setIntakeItems] = useState([]);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [architectBacklog, setArchitectBacklog] = useState(EMPTY_BACKLOG);
  const [backlogLoading, setBacklogLoading] = useState(false);
  const [architectLoading, setArchitectLoading] = useState(false);
  const [decisionFilters, setDecisionFilters] = useState(EMPTY_DECISION_FILTERS);
  const [decisionLog, setDecisionLog] = useState([]);
  const [decisionStats, setDecisionStats] = useState(() => normalizeDecisionStats());
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [digest, setDigest] = useState(null);
  const [costMetrics, setCostMetrics] = useState(null);
  const [costMetricsLoading, setCostMetricsLoading] = useState(false);
  const [activeProjectAction, setActiveProjectAction] = useState(null);
  const [loopActionBusy, setLoopActionBusy] = useState(null);
  const [rejectingItemId, setRejectingItemId] = useState(null);
  const [pauseAllBusy, setPauseAllBusy] = useState(false);
  const [recentActivity, setRecentActivity] = useState([]);
  const [recentActivityHydrated, setRecentActivityHydrated] = useState(false);
  const [loopStatusRefreshedAt, setLoopStatusRefreshedAt] = useState(null);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [loopAdvanceJob, setLoopAdvanceJob] = useState(null);
  const selectedProjectIdRef = useRef(null);
  const toast = useToast();

  const selectedProjectName = selectedHealth?.project?.id === selectedProjectId
    ? selectedHealth.project?.name || ''
    : projects.find((project) => project.id === selectedProjectId)?.name || '';
  const activeLoopAdvanceJobId = loopAdvanceJob?.job_id || null;
  const activeLoopAdvanceProjectId = loopAdvanceJob?.projectId || null;
  const isLoopAdvanceRunning = loopAdvanceJob?.status === 'running';

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  const applyBacklogResponse = useCallback((response) => {
    const normalized = normalizeBacklogResponse(response);
    setArchitectBacklog({
      items: normalized.items,
      cycleId: normalized.cycle_id,
      reasoningSummary: normalized.reasoning_summary,
    });
  }, []);

  const loadProjects = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
    }

    try {
      const response = await factoryApi.projects();
      const nextProjects = getProjectsFromResponse(response);
      setProjects(nextProjects);
      setProjectsError(null);
      setSelectedProjectId((current) => (
        nextProjects.some((project) => project.id === current) ? current : nextProjects[0]?.id || null
      ));
      return nextProjects;
    } catch (error) {
      setProjectsError(error?.message || 'Failed to load factory projects.');
      return [];
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  const loadProject = useCallback(async (projectId, { fallbackProject = null, isCancelled = () => false } = {}) => {
    if (!projectId) {
      if (!isCancelled()) {
        setSelectedHealth(null);
        setLoopStatus(null);
      }
      return;
    }

    if (!isCancelled()) {
      setSelectedHealth(buildDetailFallback(fallbackProject));
      setDetailLoading(true);
    }

    try {
      const [response, nextLoopStatus] = await Promise.all([
        factoryApi.health(projectId),
        factoryApi.loopStatus(projectId).catch(() => null),
      ]);
      if (!isCancelled()) {
        setSelectedHealth(normalizeHealth({
          ...response,
          project: mergeLoopState(response?.project || {}, nextLoopStatus),
        }));
        setLoopStatus(nextLoopStatus);
        setLoopStatusRefreshedAt(Date.now());
      }
    } catch (error) {
      if (!isCancelled()) {
        toast.error(`Failed to load project health: ${error.message}`);
      }
    } finally {
      if (!isCancelled()) {
        setDetailLoading(false);
      }
    }
  }, [toast]);

  const loadIntake = useCallback(async (projectId, { isCancelled = () => false } = {}) => {
    if (!projectId) {
      if (!isCancelled()) {
        setIntakeItems([]);
        setIntakeLoading(false);
      }
      return;
    }

    setIntakeLoading(true);
    try {
      const response = await factoryApi.intake(projectId);
      if (!isCancelled()) {
        setIntakeItems(getIntakeItemsFromResponse(response));
      }
    } catch (error) {
      if (!isCancelled()) {
        setIntakeItems([]);
        toast.error(`Failed to load intake queue: ${error.message}`);
      }
    } finally {
      if (!isCancelled()) {
        setIntakeLoading(false);
      }
    }
  }, [toast]);

  const loadBacklog = useCallback(async (projectId, { isCancelled = () => false } = {}) => {
    if (!projectId) {
      if (!isCancelled()) {
        setArchitectBacklog(EMPTY_BACKLOG);
        setBacklogLoading(false);
      }
      return;
    }

    setArchitectBacklog(EMPTY_BACKLOG);
    setBacklogLoading(true);
    try {
      const response = await factoryApi.backlog(projectId);
      if (!isCancelled()) {
        applyBacklogResponse(response);
      }
    } catch (error) {
      if (!isCancelled()) {
        setArchitectBacklog(EMPTY_BACKLOG);
        toast.error(`Failed to load architect backlog: ${error.message}`);
      }
    } finally {
      if (!isCancelled()) {
        setBacklogLoading(false);
      }
    }
  }, [applyBacklogResponse, toast]);

  const loadDecisionLog = useCallback(async (projectId, filters, { isCancelled = () => false } = {}) => {
    if (!projectId) {
      if (!isCancelled()) {
        setDecisionLog([]);
        setDecisionStats(normalizeDecisionStats());
        setDecisionLoading(false);
      }
      return;
    }

    const batchId = String(filters?.batchId || '').trim();
    const since = getDecisionSinceParam(filters?.since);

    setDecisionLog([]);
    setDecisionStats(normalizeDecisionStats());
    setDecisionLoading(true);

    try {
      const response = batchId
        ? await getDecisionLog(projectId, { batch_id: batchId })
        : await getDecisionLog(projectId, {
          limit: 100,
          ...(filters?.stage ? { stage: filters.stage } : {}),
          ...(filters?.actor ? { actor: filters.actor } : {}),
          ...(since ? { since } : {}),
        });

      if (isCancelled()) {
        return;
      }

      let decisions = Array.isArray(response?.decisions) ? response.decisions : [];
      if (batchId) {
        decisions = decisions
          .filter((decision) => (
            (!filters?.stage || normalizeDecisionStage(decision.stage) === filters.stage)
            && (!filters?.actor || decision.actor === filters.actor)
            && (!since || (decision.created_at && new Date(decision.created_at).getTime() >= new Date(since).getTime()))
          ))
          .sort((left, right) => new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime());
      }

      setDecisionLog(decisions);
      setDecisionStats(normalizeDecisionStats(response?.stats));
    } catch (error) {
      if (!isCancelled()) {
        setDecisionLog([]);
        setDecisionStats(normalizeDecisionStats());
        toast.error(`Failed to load audit trail: ${error.message}`);
      }
    } finally {
      if (!isCancelled()) {
        setDecisionLoading(false);
      }
    }
  }, [toast]);

  const loadDigest = useCallback(async (projectId, { isCancelled = () => false } = {}) => {
    if (!projectId) {
      if (!isCancelled()) {
        setDigest(null);
      }
      return;
    }

    try {
      const response = await getFactoryDigest(projectId);
      if (!isCancelled()) {
        setDigest(response || { events: [] });
      }
    } catch {
      if (!isCancelled()) {
        setDigest(null);
      }
    }
  }, []);

  const loadCostMetrics = useCallback(async (projectId, { isCancelled = () => false } = {}) => {
    if (!projectId) {
      if (!isCancelled()) {
        setCostMetrics(null);
        setCostMetricsLoading(false);
      }
      return;
    }

    setCostMetrics(null);
    setCostMetricsLoading(true);
    try {
      const response = await factoryApi.factoryCosts(projectId);
      if (!isCancelled()) {
        setCostMetrics(normalizeCostMetrics(response));
      }
    } catch (error) {
      if (!isCancelled()) {
        setCostMetrics(null);
        toast.error(`Failed to load cost metrics: ${error.message}`);
      }
    } finally {
      if (!isCancelled()) {
        setCostMetricsLoading(false);
      }
    }
  }, [toast]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (projects.length === 0) {
      setProjectActivity({});
      return undefined;
    }

    let cancelled = false;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    Promise.all(projects.map(async (project) => {
      const [recentResponse, latestResponse] = await Promise.all([
        getDecisionLog(project.id, { since: oneHourAgo, limit: 100 }).catch(() => ({ decisions: [] })),
        getDecisionLog(project.id, { limit: 1 }).catch(() => ({ decisions: [] })),
      ]);

      return [
        project.id,
        {
          recentCount: Array.isArray(recentResponse?.decisions) ? recentResponse.decisions.length : 0,
          lastAction: latestResponse?.decisions?.[0]?.action || null,
        },
      ];
    }))
      .then((entries) => {
        if (!cancelled) {
          setProjectActivity(Object.fromEntries(entries));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectActivity({});
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projects]);

  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedHealth(null);
      setLoopStatus(null);
      setRecentActivity([]);
      setRecentActivityHydrated(false);
      setLoopStatusRefreshedAt(null);
      setPendingApprovalCount(0);
      return undefined;
    }

    let cancelled = false;
    const fallbackProject = projects.find((project) => project.id === selectedProjectId) || null;
    loadProject(selectedProjectId, { fallbackProject, isCancelled: () => cancelled });

    return () => {
      cancelled = true;
    };
  }, [loadProject, projects, selectedProjectId]);

  useEffect(() => {
    let cancelled = false;
    loadIntake(selectedProjectId, { isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [loadIntake, selectedProjectId]);

  useEffect(() => {
    let cancelled = false;
    loadBacklog(selectedProjectId, { isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [loadBacklog, selectedProjectId]);

  useEffect(() => {
    let cancelled = false;
    loadDecisionLog(selectedProjectId, decisionFilters, { isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [decisionFilters, loadDecisionLog, selectedProjectId]);

  useEffect(() => {
    let cancelled = false;
    loadDigest(selectedProjectId, { isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [loadDigest, selectedProjectId]);

  useEffect(() => {
    let cancelled = false;
    loadCostMetrics(selectedProjectId, { isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [loadCostMetrics, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setRecentActivity([]);
      setRecentActivityHydrated(false);
      return undefined;
    }

    let cancelled = false;
    let polling = false;
    setRecentActivity([]);
    setRecentActivityHydrated(false);

    const pollSelectedProject = async ({ includeBacklog = true } = {}) => {
      if (polling) {
        return;
      }

      polling = true;
      try {
        const [nextLoopStatus, recentResponse, backlogResponse, pendingApprovalResponse] = await Promise.all([
          factoryApi.loopStatus(selectedProjectId).catch(() => null),
          getDecisionLog(selectedProjectId, { limit: 20 }).catch(() => null),
          includeBacklog ? factoryApi.backlog(selectedProjectId).catch(() => null) : Promise.resolve(null),
          selectedProjectName
            ? tasksApi.list({ status: 'pending_approval', project: selectedProjectName, limit: 1 }).catch(() => null)
            : Promise.resolve({ total: 0, tasks: [] }),
        ]);

        if (cancelled) {
          return;
        }

        if (nextLoopStatus && typeof nextLoopStatus === 'object') {
          const refreshedAt = Date.now();
          setLoopStatus(nextLoopStatus);
          setProjects((current) => current.map((project) => (
            project.id === selectedProjectId ? mergeLoopState(project, nextLoopStatus) : project
          )));
          setSelectedHealth((current) => (
            current && current.project?.id === selectedProjectId
              ? { ...current, project: mergeLoopState(current.project, nextLoopStatus) }
              : current
          ));
          setLoopStatusRefreshedAt(refreshedAt);
        }

        setRecentActivity(Array.isArray(recentResponse?.decisions) ? recentResponse.decisions : []);
        if (backlogResponse) {
          applyBacklogResponse(backlogResponse);
        }
        if (pendingApprovalResponse) {
          setPendingApprovalCount(Number(pendingApprovalResponse.total) || pendingApprovalResponse.tasks?.length || 0);
        }
      } finally {
        if (!cancelled) {
          setRecentActivityHydrated(true);
        }
        polling = false;
      }
    };

    pollSelectedProject({ includeBacklog: false });
    const pollIntervalId = setInterval(pollSelectedProject, 5000);

    return () => {
      cancelled = true;
      clearInterval(pollIntervalId);
    };
  }, [applyBacklogResponse, selectedProjectId, selectedProjectName]);

  const refreshSelectedProject = useCallback(async () => {
    if (!selectedProjectId) {
      return;
    }

    const fallbackProject = projects.find((project) => project.id === selectedProjectId) || null;
    await Promise.all([
      loadProject(selectedProjectId, { fallbackProject }),
      loadIntake(selectedProjectId),
      loadBacklog(selectedProjectId),
      loadDecisionLog(selectedProjectId, decisionFilters),
      loadDigest(selectedProjectId),
      loadCostMetrics(selectedProjectId),
    ]);
  }, [
    decisionFilters,
    loadBacklog,
    loadCostMetrics,
    loadDecisionLog,
    loadDigest,
    loadIntake,
    loadProject,
    projects,
    selectedProjectId,
  ]);

  useEffect(() => {
    if (!isLoopAdvanceRunning || !activeLoopAdvanceJobId || !activeLoopAdvanceProjectId) {
      return undefined;
    }

    const projectId = activeLoopAdvanceProjectId;
    const jobId = activeLoopAdvanceJobId;
    let cancelled = false;
    let polling = false;

    const pollJob = async () => {
      if (polling) {
        return;
      }

      polling = true;
      try {
        const status = await factoryApi.loopJobStatus(projectId, jobId);
        if (cancelled) {
          return;
        }

        setLoopAdvanceJob((current) => {
          if (!current || current.job_id !== jobId) {
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
        const nextProjects = await loadProjects({ silent: true });
        if (!cancelled && selectedProjectIdRef.current === projectId) {
          const fallbackProject = nextProjects.find((project) => project.id === projectId) || null;
          await Promise.all([
            loadProject(projectId, { fallbackProject }),
            loadIntake(projectId),
            loadBacklog(projectId),
            loadDecisionLog(projectId, decisionFilters),
            loadDigest(projectId),
            loadCostMetrics(projectId),
          ]);
        }

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
        const nextProjects = await loadProjects({ silent: true });
        if (selectedProjectIdRef.current === projectId) {
          const fallbackProject = nextProjects.find((project) => project.id === projectId) || null;
          await Promise.all([
            loadProject(projectId, { fallbackProject }),
            loadIntake(projectId),
            loadBacklog(projectId),
            loadDecisionLog(projectId, decisionFilters),
            loadDigest(projectId),
            loadCostMetrics(projectId),
          ]);
        }
        toast.error(`Failed to track factory stage: ${error.message}`);
      } finally {
        polling = false;
      }
    };

    pollJob();
    const intervalId = setInterval(pollJob, 2000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [
    decisionFilters,
    loadBacklog,
    loadCostMetrics,
    loadDecisionLog,
    loadDigest,
    loadIntake,
    loadProject,
    loadProjects,
    activeLoopAdvanceJobId,
    activeLoopAdvanceProjectId,
    isLoopAdvanceRunning,
    toast,
  ]);

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

  const handlePauseAll = useCallback(async () => {
    setPauseAllBusy(true);

    try {
      await factoryApi.pauseAll();
      toast.success('All factory projects paused');
      await loadProjects({ silent: true });
    } catch (error) {
      toast.error(`Failed to pause all projects: ${error.message}`);
    } finally {
      setPauseAllBusy(false);
    }
  }, [loadProjects, toast]);

  const handleRejectWorkItem = useCallback(async (itemId) => {
    setRejectingItemId(itemId);

    try {
      const response = await factoryApi.rejectWorkItem(itemId, 'Rejected from dashboard');
      const rejectedItem = normalizeIntakeItem(response?.item || { id: itemId, status: 'rejected' });
      setIntakeItems((current) => current.map((item) => (
        item.id === itemId ? { ...item, ...rejectedItem } : item
      )));
      toast.success('Work item rejected');
    } catch (error) {
      toast.error(`Failed to reject work item: ${error.message}`);
    } finally {
      setRejectingItemId(null);
    }
  }, [toast]);

  const handleRerunArchitect = useCallback(async () => {
    if (!selectedProjectId) {
      return;
    }

    setArchitectLoading(true);
    try {
      await factoryApi.triggerArchitect(selectedProjectId);
      const response = await factoryApi.backlog(selectedProjectId);
      applyBacklogResponse(response);
      toast.success('Architect cycle completed');
    } catch (error) {
      toast.error(`Architect failed: ${error.message}`);
    } finally {
      setArchitectLoading(false);
    }
  }, [applyBacklogResponse, selectedProjectId, toast]);

  const runLoopAction = useCallback(async (action, runner) => {
    if (!selectedProjectId) {
      return;
    }

    setLoopActionBusy(action);
    try {
      await runner();
      const fallbackProject = projects.find((project) => project.id === selectedProjectId) || null;
      await loadProject(selectedProjectId, { fallbackProject });
    } catch (error) {
      toast.error(error?.message || `Failed to ${action} loop`);
    } finally {
      setLoopActionBusy(null);
    }
  }, [loadProject, projects, selectedProjectId, toast]);

  const handleAdvanceLoop = useCallback(async () => {
    if (!selectedProjectId) {
      return;
    }

    setLoopActionBusy('advance');
    try {
      const descriptor = await factoryApi.advanceLoopAsync(selectedProjectId);
      setLoopAdvanceJob({
        ...descriptor,
        projectId: selectedProjectId,
      });
    } catch (error) {
      setLoopActionBusy(null);
      setLoopAdvanceJob(null);
      toast.error(error?.message || 'Failed to advance loop');
    }
  }, [selectedProjectId, toast]);

  const totalProjects = projects.length;
  const runningProjects = projects.filter((project) => project.status === 'running').length;
  const pausedProjects = projects.filter((project) => project.status === 'paused').length;
  const baseDetail = selectedHealth || buildDetailFallback(projects.find((project) => project.id === selectedProjectId));
  const detail = baseDetail
    ? { ...baseDetail, project: mergeLoopState(baseDetail.project || {}, loopStatus || {}) }
    : null;
  const selectedProject = detail?.project || null;
  const approvalsHref = selectedProject?.name
    ? `/approvals?${new URLSearchParams({ project: selectedProject.name, source: 'factory' }).toString()}`
    : null;
  const loopRefreshAgeSeconds = loopStatusRefreshedAt === null
    ? null
    : Math.max(0, Math.floor((Date.now() - loopStatusRefreshedAt) / 1000));

  return {
    activeProjectAction,
    handlePauseAll,
    handleToggleProject,
    loadProjects,
    loading,
    outletContext: {
      activeProjectAction,
      approvalsHref,
      architectBacklog,
      architectLoading,
      backlogLoading,
      costMetrics,
      costMetricsLoading,
      decisionFilters,
      decisionLoading,
      decisionLog,
      decisionStats,
      detail,
      detailLoading,
      digest,
      handleRejectWorkItem,
      handleRerunArchitect,
      handleToggleProject,
      intakeItems,
      intakeLoading,
      loopAdvanceJob,
      loopActionBusy,
      loopRefreshAgeSeconds,
      loopStatus,
      pendingApprovalCount,
      recentActivity,
      recentActivityHydrated,
      refreshSelectedProject,
      rejectingItemId,
      selectedHealth,
      selectedProject,
      selectedProjectId,
      setDecisionFilters,
      startLoop: () => runLoopAction('start', () => factoryApi.startLoop(selectedProject.id)),
      approveGate: () => runLoopAction('approve', () => factoryApi.approveGate(selectedProject.id, selectedProject.loop_paused_at_stage)),
      advanceLoop: handleAdvanceLoop,
    },
    pauseAllBusy,
    pausedProjects,
    projectActivity,
    projects,
    projectsError,
    runningProjects,
    setSelectedProjectId,
    totalProjects,
  };
}
