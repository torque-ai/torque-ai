import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { workflows as workflowsApi } from '../api';
import { useToast } from '../components/Toast';

function formatCheckpointLabel(checkpoint) {
  return checkpoint?.step_id || checkpoint?.task_id || '(no step)';
}

function formatCheckpointTimestamp(takenAt) {
  if (!takenAt) {
    return 'Unknown time';
  }

  const parsed = new Date(takenAt);
  if (Number.isNaN(parsed.getTime())) {
    return takenAt;
  }

  return parsed.toLocaleString();
}

export default function WorkflowTimeline() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [checkpoints, setCheckpoints] = useState([]);
  const [selected, setSelected] = useState(null);
  const [overrides, setOverrides] = useState('');
  const [forkResult, setForkResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [forking, setForking] = useState(false);

  const loadCheckpoints = useCallback(() => {
    if (!id) {
      setCheckpoints([]);
      setSelected(null);
      setForkResult(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setForkResult(null);

    workflowsApi.checkpoints(id)
      .then((data) => {
        if (cancelled) return;
        const items = Array.isArray(data?.checkpoints) ? data.checkpoints : [];
        setCheckpoints(items);
        setSelected((current) => (
          current
            ? items.find((checkpoint) => checkpoint.checkpoint_id === current.checkpoint_id) || null
            : null
        ));
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load workflow checkpoints:', err);
        // Don't wipe the prior checkpoint list on a transient fetch error —
        // the toast surfaces the failure and the user keeps seeing useful
        // data while they retry. The no-id branch above still clears the
        // list when navigating away from a workflow.
        toast.error(err?.message || 'Failed to load workflow checkpoints');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id, toast]);

  useEffect(() => {
    const cleanup = loadCheckpoints();
    return typeof cleanup === 'function' ? cleanup : undefined;
  }, [loadCheckpoints]);

  async function handleFork() {
    if (!selected?.checkpoint_id) {
      toast.error('Select a checkpoint first');
      return;
    }

    let stateOverrides = null;
    if (overrides.trim()) {
      try {
        stateOverrides = JSON.parse(overrides);
      } catch {
        toast.error('State overrides must be valid JSON');
        return;
      }

      if (!stateOverrides || typeof stateOverrides !== 'object' || Array.isArray(stateOverrides)) {
        toast.error('State overrides must be a JSON object');
        return;
      }
    }

    setForking(true);
    setForkResult(null);

    try {
      const result = await workflowsApi.fork(id, {
        checkpoint_id: selected.checkpoint_id,
        state_overrides: stateOverrides,
      });
      setForkResult(result);
      toast.success(`Fork created: ${result?.new_workflow_id || 'workflow'}`);
    } catch (err) {
      console.error('Failed to fork workflow:', err);
      toast.error(err?.message || 'Failed to create fork');
    } finally {
      setForking(false);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <button
            type="button"
            onClick={() => navigate('/workflows')}
            className="mb-3 inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 transition-colors hover:bg-slate-700"
          >
            <span aria-hidden="true">←</span>
            Back to Workflows
          </button>
          <h1 className="text-2xl font-bold text-white">Workflow Timeline</h1>
          <p className="mt-1 text-sm text-slate-400">
            Review workflow checkpoints and fork execution from any saved state.
          </p>
          <p className="mt-2 font-mono text-xs text-slate-500">{id}</p>
        </div>
        <button
          type="button"
          onClick={loadCheckpoints}
          className="inline-flex items-center justify-center rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700"
        >
          Refresh checkpoints
        </button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)]">
        <section className="rounded-xl border border-slate-800 bg-slate-900/70 shadow-sm">
          <div className="border-b border-slate-800 px-5 py-4">
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-300">Checkpoints</h2>
            <p className="mt-1 text-sm text-slate-500">
              {loading
                ? 'Loading checkpoint history...'
                : `${checkpoints.length} checkpoint${checkpoints.length === 1 ? '' : 's'} available`}
            </p>
          </div>

          <div className="max-h-[32rem] overflow-auto p-3">
            {loading ? (
              <div className="space-y-3">
                {[...Array(4)].map((_, index) => (
                  <div key={index} className="animate-pulse rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3">
                    <div className="h-4 w-32 rounded bg-slate-800" />
                    <div className="mt-2 h-3 w-48 rounded bg-slate-800" />
                  </div>
                ))}
              </div>
            ) : checkpoints.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/50 px-4 py-10 text-center text-sm text-slate-500">
                No checkpoints found for this workflow.
              </div>
            ) : (
              <ul className="space-y-2">
                {checkpoints.map((checkpoint, index) => {
                  const isSelected = selected?.checkpoint_id === checkpoint.checkpoint_id;
                  return (
                    <li key={checkpoint.checkpoint_id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(checkpoint);
                          setForkResult(null);
                        }}
                        className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                          isSelected
                            ? 'border-blue-500/50 bg-blue-500/10 text-white'
                            : 'border-slate-800 bg-slate-950/50 text-slate-200 hover:border-slate-700 hover:bg-slate-900'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-mono text-sm">{formatCheckpointLabel(checkpoint)}</p>
                            <p className="mt-1 text-xs text-slate-500" title={checkpoint.taken_at}>
                              {formatCheckpointTimestamp(checkpoint.taken_at)}
                            </p>
                          </div>
                          <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${
                            isSelected
                              ? 'bg-blue-500/20 text-blue-100'
                              : 'bg-slate-800 text-slate-300'
                          }`}>
                            v{checkpoint.state_version}
                          </span>
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-slate-500">
                          <span>#{index + 1}</span>
                          <span className="truncate font-mono">{checkpoint.checkpoint_id}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/70 shadow-sm">
          <div className="border-b border-slate-800 px-5 py-4">
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-300">Fork From Checkpoint</h2>
            <p className="mt-1 text-sm text-slate-500">
              {selected
                ? 'Adjust workflow state before creating a fork.'
                : 'Choose a checkpoint from the timeline to enable forking.'}
            </p>
          </div>

          <div className="space-y-4 p-5">
            {!selected ? (
              <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/50 px-4 py-10 text-center text-sm text-slate-500">
                Pick a checkpoint to fork from.
              </div>
            ) : (
              <>
                <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-4 sm:grid-cols-2">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Step</p>
                    <p className="mt-1 font-mono text-sm text-white">{formatCheckpointLabel(selected)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Taken</p>
                    <p className="mt-1 text-sm text-slate-200" title={selected.taken_at}>
                      {formatCheckpointTimestamp(selected.taken_at)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Version</p>
                    <p className="mt-1 text-sm text-slate-200">v{selected.state_version}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Checkpoint ID</p>
                    <p className="mt-1 truncate font-mono text-sm text-slate-200">{selected.checkpoint_id}</p>
                  </div>
                </div>

                <div>
                  <label htmlFor="workflow-state-overrides" className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                    Optional state overrides (JSON object)
                  </label>
                  <textarea
                    id="workflow-state-overrides"
                    value={overrides}
                    onChange={(event) => setOverrides(event.target.value)}
                    placeholder={'{\n  "resume_mode": "debug"\n}'}
                    spellCheck={false}
                    className="h-48 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-blue-500"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleFork}
                    disabled={forking}
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {forking ? 'Creating fork...' : 'Create fork'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOverrides('');
                      setForkResult(null);
                    }}
                    className="rounded-md border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700"
                  >
                    Clear
                  </button>
                </div>

                {forkResult && (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-emerald-100">Fork created</p>
                        <p className="mt-1 text-xs text-emerald-200/80">
                          New workflow: <span className="font-mono">{forkResult.new_workflow_id || 'unknown'}</span>
                        </p>
                      </div>
                      {forkResult.new_workflow_id && (
                        <button
                          type="button"
                          onClick={() => navigate(`/workflows/${forkResult.new_workflow_id}/timeline`)}
                          className="rounded-md border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100 transition-colors hover:bg-emerald-500/20"
                        >
                          Open fork timeline
                        </button>
                      )}
                    </div>
                    <pre className="mt-4 overflow-auto rounded-lg bg-slate-950/80 p-3 text-xs text-slate-200">
                      {JSON.stringify(forkResult, null, 2)}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
