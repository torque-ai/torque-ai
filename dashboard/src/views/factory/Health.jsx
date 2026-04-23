import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { factory as factoryApi } from '../../api';
import RadarChart from '../../components/RadarChart';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import { useToast } from '../../components/Toast';
import { DimensionBar, SelectProjectPrompt, StatusDot, TrustBadge } from './shared';
import { formatBalance, formatLabel, getScoreEntries } from './utils';

function FeedbackPanel({ project }) {
  const [drift, setDrift] = useState(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [driftRes] = await Promise.all([
          factoryApi.driftStatus(project.id).catch(() => null),
        ]);
        if (!cancelled) {
          setDrift(driftRes);
        }
      } catch {
        if (!cancelled) {
          toast.error('Failed to load feedback data');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [project.id, toast]);

  if (loading) {
    return <LoadingSkeleton lines={3} />;
  }

  return (
    <section className="mt-6 rounded-lg border border-slate-700 bg-slate-800/50 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">Feedback & Drift</h3>

      {drift && drift.drift_detected && (
        <div className="mb-3 rounded border border-amber-600/30 bg-amber-900/30 p-3">
          <p className="mb-1 text-xs font-medium text-amber-300">Drift Detected</p>
          {(Array.isArray(drift.patterns) ? drift.patterns : []).map((pattern, index) => {
            const patternType = String(pattern?.type || 'unknown');
            const dimensions = Array.isArray(pattern?.dimensions) ? pattern.dimensions : [];
            return (
              <div key={pattern?.id || `${patternType}-${index}`} className="mb-1 text-xs text-slate-300">
                <span
                  className={`mr-1 inline-block h-2 w-2 rounded-full ${
                    pattern?.severity === 'critical'
                      ? 'bg-red-400'
                      : pattern?.severity === 'warning'
                        ? 'bg-amber-400'
                        : 'bg-blue-400'
                  }`}
                />
                <span className="font-medium">{patternType.replace(/_/g, ' ')}:</span> {pattern?.details || '—'}
                {dimensions.length > 0 && (
                  <span className="ml-1 text-slate-500">({dimensions.join(', ')})</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {drift && !drift.drift_detected && (
        <p className="mb-3 text-xs text-slate-400">{drift.message || 'No drift patterns detected.'}</p>
      )}

      {!drift && (
        <p className="text-xs text-slate-500">No feedback data available yet.</p>
      )}
    </section>
  );
}

export default function Health() {
  const { detail, detailLoading, selectedProject } = useOutletContext();

  if (!selectedProject) {
    return <SelectProjectPrompt message="Select a project above to view its health scores and drift feedback." />;
  }

  if (!detail) {
    return null;
  }

  const detailEntries = getScoreEntries(detail.scores || {});

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Project Detail</p>
            <h2 className="mt-1 text-2xl font-semibold text-white">{selectedProject.name || 'Selected project'}</h2>
            <p className="mt-2 break-all font-mono text-xs text-slate-400">{selectedProject.path || 'No path configured'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <TrustBadge level={selectedProject.trust_level} />
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
              <StatusDot status={selectedProject.status} />
              {formatLabel(selectedProject.status)}
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
              Balance {formatBalance(detail.balance)}
            </span>
          </div>
        </div>

        {detailLoading && !detail.scores ? (
          <div className="mt-6">
            <LoadingSkeleton lines={5} height={18} />
          </div>
        ) : (
          <div className="mt-6 grid gap-8 xl:grid-cols-[360px,1fr]">
            <div className="rounded-2xl border border-slate-700 bg-slate-900/40 p-5">
              <div className="flex justify-center">
                <RadarChart scores={detail.scores} size={320} showValues />
              </div>
              <div className="mt-4 rounded-xl border border-slate-700/70 bg-slate-900/60 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Balance Score</p>
                <p className="mt-1 text-2xl font-semibold text-white">{formatBalance(detail.balance)}</p>
                <p className="mt-1 text-sm text-slate-400">Lower is more even across dimensions.</p>
                {detail.weakest_dimension && (
                  <p className="mt-3 text-sm text-slate-300">
                    Weakest: <span className="font-medium text-white">{formatLabel(detail.weakest_dimension.dimension)}</span>{' '}
                    <span className="text-slate-400">({Math.round(detail.weakest_dimension.score)})</span>
                  </p>
                )}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-white">Dimension Scores</h3>
                {detailLoading && <span className="text-xs uppercase tracking-wide text-slate-500">Refreshing</span>}
              </div>

              {detailEntries.length === 0 ? (
                <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-900/40 px-5 py-10 text-center text-sm text-slate-400">
                  No health scores have been captured for this project yet.
                </div>
              ) : (
                <div className="mt-4 space-y-3">
                  {detailEntries.map(([dimension, score]) => (
                    <DimensionBar key={dimension} dimension={dimension} score={score} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      <FeedbackPanel project={selectedProject} />
    </div>
  );
}
