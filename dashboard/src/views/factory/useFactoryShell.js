import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { factory as factoryApi, getDecisionLog, getFactoryDigest } from '../../api';
import { useToast } from '../../components/Toast';
import {
  buildDetailFallback,
  getDecisionSinceParam,
  getIntakeItemsFromResponse,
  normalizeBacklogResponse,
  normalizeCostMetrics,
  normalizeDecisionStage,
  normalizeDecisionStats,
  normalizeHealth,
  normalizeIntakeItem,
} from './utils';
import { useFactoryLoopControl } from './useFactoryLoopControl';

const EMPTY_BACKLOG = { items: [], cycleId: null, reasoningSummary: null };
const EMPTY_DECISION_FILTERS = { stage: '', actor: '', batchId: '', since: '' };

export function useFactoryShell() {
  const [projectActivity, setProjectActivity] = useState({});
  const [selectedHealth, setSelectedHealth] = useState(null);
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
  const [rejectingItemId, setRejectingItemId] = useState(null);
  const [pauseAllBusy, setPauseAllBusy] = useState(false);
  const [recentActivity, setRecentActivity] = useState([]);
  const [recentActivityHydrated, setRecentActivityHydrated] = useState(false);
  const toast = useToast();
  const {
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
    refreshSelectedProject: refreshLoopControl,
    selectedProject,
    selectedProjectId,
    setSelectedProjectId,
    startLoop,
  } = useFactoryLoopControl();

  const applyBacklogResponse = useCallback((response) => {
    const normalized = normalizeBacklogResponse(response);
    setArchitectBacklog({
      items: normalized.items,
      cycleId: normalized.cycle_id,
      reasoningSummary: normalized.reasoning_summary,
    });
  }, []);

  const loadProject = useCallback(async (projectId, { fallbackProject = null, isCancelled = () => false } = {}) => {
    if (!projectId) {
      if (!isCancelled()) {
        setSelectedHealth(null);
      }
      return;
    }

    if (!isCancelled()) {
      setSelectedHealth(buildDetailFallback(fallbackProject));
      setDetailLoading(true);
    }

    try {
      const response = await factoryApi.health(projectId);
      if (!isCancelled()) {
        setSelectedHealth(normalizeHealth(response));
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

  const projectIdsKey = useMemo(
    () => projects.map((p) => p.id).sort().join(','),
    [projects]
  );
  const projectsRef = useRef(projects);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    if (projectsRef.current.length === 0) {
      setProjectActivity({});
      return undefined;
    }

    let cancelled = false;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    Promise.all(projectsRef.current.map(async (project) => {
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
  }, [projectIdsKey]);

  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedHealth(null);
      setRecentActivity([]);
      setRecentActivityHydrated(false);
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
        const [recentResponse, backlogResponse] = await Promise.all([
          getDecisionLog(selectedProjectId, { limit: 20 }).catch(() => null),
          includeBacklog ? factoryApi.backlog(selectedProjectId).catch(() => null) : Promise.resolve(null),
        ]);

        if (cancelled) {
          return;
        }

        setRecentActivity(Array.isArray(recentResponse?.decisions) ? recentResponse.decisions : []);
        if (backlogResponse) {
          applyBacklogResponse(backlogResponse);
        }
      } finally {
        if (!cancelled) {
          setRecentActivityHydrated(true);
        }
        polling = false;
      }
    };

    pollSelectedProject({ includeBacklog: false });

    let timeoutId = null;

    const getInterval = () => {
      const current = projectsRef.current.find((project) => project.id === selectedProjectId);
      const loopState = current?.loop_state || 'IDLE';
      const isActive = loopState !== 'IDLE' && loopState !== 'PAUSED';
      return isActive ? 5000 : 15000;
    };

    const scheduleNext = () => {
      if (cancelled) {
        return;
      }

      timeoutId = setTimeout(async () => {
        if (cancelled) {
          return;
        }

        if (typeof document !== 'undefined' && document.hidden) {
          scheduleNext();
          return;
        }

        await pollSelectedProject();
        scheduleNext();
      }, getInterval());
    };

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden && !cancelled) {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        pollSelectedProject().finally(() => scheduleNext());
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    scheduleNext();

    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [applyBacklogResponse, selectedProjectId]);

  const refreshSelectedProject = useCallback(async () => {
    if (!selectedProjectId) {
      return;
    }

    const fallbackProject = selectedProject || projects.find((project) => project.id === selectedProjectId) || null;
    await Promise.all([
      refreshLoopControl({ includeProjects: true }),
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
    refreshLoopControl,
    selectedProject,
    selectedProjectId,
  ]);

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

  const totalProjects = projects.length;
  const runningProjects = projects.filter((project) => project.status === 'running').length;
  const pausedProjects = projects.filter((project) => project.status === 'paused').length;
  const baseDetail = selectedHealth || buildDetailFallback(selectedProject || projects.find((project) => project.id === selectedProjectId));
  const detail = baseDetail
    ? { ...baseDetail, project: selectedProject || baseDetail.project || null }
    : null;

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
      setSelectedProjectId,
      setDecisionFilters,
      startLoop,
      approveGate,
      advanceLoop,
      projects,
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
