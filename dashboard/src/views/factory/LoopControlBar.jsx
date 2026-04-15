import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { factory as factoryApi } from '../../api';
import { useToast } from '../../components/Toast';
import { formatRelativeTime } from './utils';

const INSTANCE_POLL_INTERVAL_MS = 5000;
const JOB_POLL_INTERVAL_MS = 2000;

function shortId(value, head = 8, tail = 4) {
  if (!value) {
    return '—';
  }

  const text = String(value);
  if (text.length <= head + tail + 1) {
    return text;
  }

  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function isReadyForStage(stage) {
  return typeof stage === 'string' && stage.startsWith('READY_FOR_');
}

function isGateStage(stage) {
  return Boolean(stage) && !isReadyForStage(stage) && stage !== 'VERIFY_FAIL';
}

function hasLegacyLoop(project) {
  return Boolean(project && String(project.loop_state || 'IDLE').toUpperCase() !== 'IDLE');
}

function buildLegacyLoopInstance(project) {
  if (!project) {
    return null;
  }

  return {
    id: `legacy:${project.id}`,
    project_id: project.id,
    work_item_id: null,
    batch_id: project.loop_batch_id || null,
    loop_state: project.loop_state || 'IDLE',
    paused_at_stage: project.loop_paused_at_stage || null,
    last_action_at: project.loop_last_action_at || null,
    created_at: null,
    terminated_at: null,
    legacy: true,
  };
}

function pickLegacyActionInstance(instances, project) {
  const rows = Array.isArray(instances) ? instances : [];
  if (rows.length === 0) {
    return null;
  }

  const activeRows = rows.filter((instance) => !instance?.terminated_at);
  const candidates = activeRows.length > 0 ? activeRows : rows;
  const batchId = project?.loop_batch_id || null;

  if (batchId) {
    const matchedBatch = candidates.find((instance) => instance?.batch_id === batchId);
    if (matchedBatch) {
      return matchedBatch;
    }
  }

  return candidates[0] || null;
}

function getDisplayInstanceKey(instance) {
  return instance?.id || `legacy:${instance?.project_id || 'unknown'}`;
}

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

function LoopInstanceCard({
  instance,
  jobSnapshot,
  onAdvance,
  onApproveGate,
  onRetryVerify,
  advanceBusy,
  approveBusy,
  retryBusy,
}) {
  const badge = getLoopStateBadge(instance.loop_state, instance.paused_at_stage);
  const pausedAtStage = instance.paused_at_stage || null;
  const canApproveGate = isGateStage(pausedAtStage);
  const canRetryVerify = pausedAtStage === 'VERIFY_FAIL';
  const advanceDisabled = advanceBusy || Boolean(pausedAtStage && !isReadyForStage(pausedAtStage));
  const intakeHref = instance.work_item_id ? `/factory/intake#work-item-${instance.work_item_id}` : null;

  return (
    <article
      data-testid="loop-instance-card"
      className="min-w-[18rem] flex-1 rounded-xl border border-slate-700/70 bg-slate-900/50 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${badge.className}`}>
            {badge.label}
          </span>
          {instance.legacy && (
            <p className="mt-2 text-[11px] uppercase tracking-wide text-amber-300">Legacy fallback</p>
          )}
        </div>
        <span
          className="rounded-full border border-slate-700 bg-slate-800/80 px-2.5 py-1 font-mono text-[11px] text-slate-300"
          title={instance.id}
        >
          {shortId(instance.id)}
        </span>
      </div>

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex items-start justify-between gap-3">
          <dt className="text-slate-500">Paused At</dt>
          <dd className="text-right text-slate-200">{pausedAtStage || '—'}</dd>
        </div>
        <div className="flex items-start justify-between gap-3">
          <dt className="text-slate-500">Work Item</dt>
          <dd className="text-right">
            {intakeHref ? (
              <Link className="text-cyan-300 transition-colors hover:text-cyan-200" to={intakeHref}>
                #{instance.work_item_id}
              </Link>
            ) : (
              <span className="text-slate-300">—</span>
            )}
          </dd>
        </div>
        <div className="flex items-start justify-between gap-3">
          <dt className="text-slate-500">Batch</dt>
          <dd className="font-mono text-right text-slate-200" title={instance.batch_id || undefined}>
            {shortId(instance.batch_id, 10, 4)}
          </dd>
        </div>
        <div className="flex items-start justify-between gap-3">
          <dt className="text-slate-500">Last Action</dt>
          <dd className="text-right text-slate-200" title={instance.last_action_at || undefined}>
            {instance.last_action_at ? formatRelativeTime(instance.last_action_at) : 'Unknown'}
          </dd>
        </div>
      </dl>

      {jobSnapshot?.status === 'running' && (
        <p className="mt-3 text-xs text-cyan-300">Stage running... polling job status.</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={advanceDisabled}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => onAdvance(instance)}
        >
          {advanceBusy ? 'Advancing...' : 'Advance'}
        </button>
        <button
          type="button"
          disabled={!canApproveGate || approveBusy}
          className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => onApproveGate(instance)}
        >
          {approveBusy ? 'Approving...' : 'Approve Gate'}
        </button>
        {canRetryVerify && (
          <button
            type="button"
            disabled={retryBusy}
            className="rounded bg-amber-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => onRetryVerify(instance)}
          >
            {retryBusy ? 'Retrying...' : 'Retry Verify'}
          </button>
        )}
      </div>
    </article>
  );
}

export default function LoopControlBar({
  activeProjectAction,
  approvalsHref,
  children,
  className = '',
  handleToggleProject,
  pendingApprovalCount,
  project,
  projects,
  selectedProject,
  selectedProjectId,
  setSelectedProjectId,
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const currentProject = project || selectedProject || null;
  const projectId = currentProject?.id || null;
  const requestVersionRef = useRef(0);
  const [instances, setInstances] = useState([]);
  const [instancesLoading, setInstancesLoading] = useState(true);
  const [instancesError, setInstancesError] = useState(null);
  const [busyActions, setBusyActions] = useState({});
  const [jobSnapshots, setJobSnapshots] = useState({});

  const setActionBusy = useCallback((key, value) => {
    setBusyActions((current) => {
      const next = { ...current };
      if (value) {
        next[key] = true;
      } else {
        delete next[key];
      }
      return next;
    });
  }, []);

  const loadInstances = useCallback(async ({ silent = false, activeOnly = true } = {}) => {
    if (!projectId) {
      setInstances([]);
      setInstancesError(null);
      setInstancesLoading(false);
      return [];
    }

    const requestVersion = ++requestVersionRef.current;
    if (!silent) {
      setInstancesLoading(true);
    }

    try {
      const nextInstances = await factoryApi.listLoopInstances(projectId, { activeOnly });
      if (requestVersion !== requestVersionRef.current) {
        return nextInstances;
      }

      const normalizedInstances = Array.isArray(nextInstances) ? nextInstances : [];
      if (activeOnly) {
        setInstances(normalizedInstances);
        setInstancesError(null);
      }
      return normalizedInstances;
    } catch (error) {
      if (requestVersion === requestVersionRef.current) {
        setInstancesError(error?.message || 'Failed to load factory loop instances.');
        if (activeOnly) {
          setInstances([]);
        }
      }
      return [];
    } finally {
      if (!silent && requestVersion === requestVersionRef.current) {
        setInstancesLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    setJobSnapshots({});
    setBusyActions({});
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      return undefined;
    }

    void loadInstances();
    const intervalId = setInterval(() => {
      void loadInstances({ silent: true });
    }, INSTANCE_POLL_INTERVAL_MS);

    return () => {
      requestVersionRef.current += 1;
      clearInterval(intervalId);
    };
  }, [loadInstances, projectId]);

  useEffect(() => {
    const runningJobs = Object.values(jobSnapshots).filter((job) => job?.status === 'running');
    if (runningJobs.length === 0) {
      return undefined;
    }

    let cancelled = false;

    const pollJobs = async () => {
      const results = await Promise.all(runningJobs.map(async (job) => {
        try {
          const status = await factoryApi.loopInstanceJobStatus(job.instanceId, job.job_id);
          return { job, status };
        } catch (error) {
          return { job, error };
        }
      }));

      if (cancelled) {
        return;
      }

      let refreshRequested = false;
      setJobSnapshots((current) => {
        const next = { ...current };

        for (const result of results) {
          if (result.error) {
            delete next[result.job.instanceId];
            refreshRequested = true;
            continue;
          }

          if (result.status?.status === 'running') {
            next[result.job.instanceId] = {
              ...current[result.job.instanceId],
              ...result.status,
              instanceId: result.job.instanceId,
            };
            continue;
          }

          delete next[result.job.instanceId];
          refreshRequested = true;
        }

        return next;
      });

      for (const result of results) {
        if (result.error) {
          toast.error(`Failed to track factory stage: ${result.error.message}`);
          continue;
        }

        if (result.status?.status === 'completed') {
          toast.success('Factory stage completed');
        } else if (result.status?.status === 'failed') {
          toast.error(result.status.error || 'Factory stage failed');
        }
      }

      if (refreshRequested) {
        await loadInstances({ silent: true });
      }
    };

    void pollJobs();
    const intervalId = setInterval(() => {
      void pollJobs();
    }, JOB_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [jobSnapshots, loadInstances, toast]);

  const resolveInstanceId = useCallback(async (instance) => {
    if (!instance?.legacy) {
      return instance?.id || null;
    }

    const knownInstances = await loadInstances({ silent: true, activeOnly: false });
    const resolved = pickLegacyActionInstance(knownInstances, currentProject);
    return resolved?.id || null;
  }, [currentProject, loadInstances]);

  const handleStartInstance = useCallback(async () => {
    if (!projectId) {
      return;
    }

    setActionBusy('start', true);
    try {
      await factoryApi.startLoopInstance(projectId);
      toast.success('Factory loop instance started');
      await loadInstances({ silent: true });
    } catch (error) {
      toast.error(error?.message || 'Failed to start factory loop instance');
    } finally {
      setActionBusy('start', false);
    }
  }, [loadInstances, projectId, setActionBusy, toast]);

  const handleAdvanceInstance = useCallback(async (instance) => {
    const actionKey = `advance:${getDisplayInstanceKey(instance)}`;
    setActionBusy(actionKey, true);

    try {
      const instanceId = await resolveInstanceId(instance);
      if (!instanceId) {
        throw new Error('No factory loop instance is available for this project.');
      }

      const descriptor = await factoryApi.advanceLoopInstance(instanceId);
      if (descriptor?.job_id && descriptor?.status === 'running') {
        setJobSnapshots((current) => ({
          ...current,
          [instanceId]: {
            ...descriptor,
            instanceId,
          },
        }));
      } else {
        await loadInstances({ silent: true });
      }
    } catch (error) {
      toast.error(error?.message || 'Failed to advance factory loop instance');
    } finally {
      setActionBusy(actionKey, false);
    }
  }, [loadInstances, resolveInstanceId, setActionBusy, toast]);

  const handleApproveGate = useCallback(async (instance) => {
    const stage = instance?.paused_at_stage || null;
    if (!isGateStage(stage)) {
      return;
    }

    const actionKey = `approve:${getDisplayInstanceKey(instance)}`;
    setActionBusy(actionKey, true);

    try {
      const instanceId = await resolveInstanceId(instance);
      if (!instanceId) {
        throw new Error('No factory loop instance is available for this project.');
      }

      await factoryApi.approveGateInstance(instanceId, stage);
      toast.success(`Approved ${stage} gate`);
      await loadInstances({ silent: true });
    } catch (error) {
      toast.error(error?.message || 'Failed to approve factory gate');
    } finally {
      setActionBusy(actionKey, false);
    }
  }, [loadInstances, resolveInstanceId, setActionBusy, toast]);

  const handleRetryVerify = useCallback(async (instance) => {
    const actionKey = `retry:${getDisplayInstanceKey(instance)}`;
    setActionBusy(actionKey, true);

    try {
      const instanceId = await resolveInstanceId(instance);
      if (!instanceId) {
        throw new Error('No factory loop instance is available for this project.');
      }

      await factoryApi.retryVerifyInstance(instanceId);
      toast.success('VERIFY retry requested');
      await loadInstances({ silent: true });
    } catch (error) {
      toast.error(error?.message || 'Failed to retry VERIFY');
    } finally {
      setActionBusy(actionKey, false);
    }
  }, [loadInstances, resolveInstanceId, setActionBusy, toast]);

  const displayInstances = useMemo(() => {
    if (instances.length > 0) {
      return instances;
    }

    if (hasLegacyLoop(currentProject)) {
      return [buildLegacyLoopInstance(currentProject)];
    }

    return [];
  }, [currentProject, instances]);

  const activeLoopCount = instances.length;
  const projectToggleLabel = currentProject?.status === 'running' ? 'Pause' : 'Resume';
  const isProjectToggleBusy = currentProject && activeProjectAction === currentProject.id;

  if ((!Array.isArray(projects) || projects.length === 0) && !currentProject) {
    return null;
  }

  return (
    <section className={`rounded-lg border border-slate-700 bg-slate-800/60 p-4 ${className}`.trim()}>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-slate-200">Factory Loop</span>
          {Array.isArray(projects) && projects.length > 0 && typeof setSelectedProjectId === 'function' ? (
            <select
              aria-label="Factory project"
              value={selectedProjectId || currentProject?.id || ''}
              onChange={(event) => setSelectedProjectId(event.target.value || null)}
              className="min-w-[12rem] rounded-lg border border-slate-700/50 bg-slate-800/60 px-3 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
            >
              {projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name || entry.id}
                </option>
              ))}
            </select>
          ) : (
            <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs text-slate-300">
              {currentProject?.name || 'Selected project'}
            </span>
          )}
          <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs text-slate-300">
            {activeLoopCount} active
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
          <button
            type="button"
            disabled={Boolean(busyActions.start) || !projectId}
            className="rounded bg-cyan-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleStartInstance}
          >
            {busyActions.start ? 'Starting...' : '+ Start New Instance'}
          </button>
          {currentProject && typeof handleToggleProject === 'function' && (
            <button
              type="button"
              disabled={isProjectToggleBusy}
              onClick={() => handleToggleProject(currentProject)}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                currentProject.status === 'running'
                  ? 'bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                  : 'bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
              }`}
            >
              {isProjectToggleBusy ? 'Working...' : projectToggleLabel}
            </button>
          )}
        </div>
      </div>

      {instancesError && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {instancesError}
        </div>
      )}

      {instancesLoading && displayInstances.length === 0 ? (
        <div className="mt-4 rounded-xl border border-slate-700/70 bg-slate-900/40 px-4 py-6 text-sm text-slate-400">
          Loading loop instances...
        </div>
      ) : displayInstances.length === 0 ? (
        <div
          data-testid="loop-control-empty-state"
          className="mt-4 rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-4 py-6 text-sm text-slate-400"
        >
          No active loop instances for this project.
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-3 overflow-x-auto pb-1">
          {displayInstances.map((instance) => {
            const instanceKey = getDisplayInstanceKey(instance);
            const resolvedJobKey = instance.legacy
              ? null
              : instance.id;

            return (
              <LoopInstanceCard
                key={instanceKey}
                instance={instance}
                jobSnapshot={resolvedJobKey ? jobSnapshots[resolvedJobKey] : null}
                advanceBusy={Boolean(busyActions[`advance:${instanceKey}`]) || jobSnapshots[instance.id]?.status === 'running'}
                approveBusy={Boolean(busyActions[`approve:${instanceKey}`])}
                retryBusy={Boolean(busyActions[`retry:${instanceKey}`])}
                onAdvance={handleAdvanceInstance}
                onApproveGate={handleApproveGate}
                onRetryVerify={handleRetryVerify}
              />
            );
          })}
        </div>
      )}

      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}
