import { Fragment, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import { FactorySubviewLoadError, SelectProjectPrompt } from './shared';
import {
  BADGE_FALLBACK_STYLE,
  DECISION_ACTOR_BADGE_STYLES,
  DECISION_ACTOR_OPTIONS,
  DECISION_STAGE_BADGE_STYLES,
  DECISION_STAGE_OPTIONS,
  buildDecisionSummary,
  formatLabel,
  formatTimestamp,
  getDecisionSinceParam,
  getDigestEventCounts,
  normalizeDecisionStage,
  normalizeDecisionStats,
  toConfidencePercent,
  getScoreBarClass,
} from './utils';

const PAGE_SIZE = 20;

function buildDecisionRowKey(decision, index) {
  return decision.id || `${decision.created_at || 'unknown'}-${decision.action || index}`;
}

function DecisionAuditTable({ decisionLoading, decisionLog }) {
  const [expandedDecisionIds, setExpandedDecisionIds] = useState({});
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(decisionLog.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pagedDecisions = decisionLog.slice(pageStart, pageStart + PAGE_SIZE);

  if (decisionLoading && decisionLog.length === 0) {
    return (
      <div className="mt-6">
        <LoadingSkeleton lines={5} height={18} />
      </div>
    );
  }

  if (decisionLog.length === 0) {
    return (
      <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-900/40 px-5 py-10 text-center text-sm text-slate-400">
        No audit decisions match the current filters.
      </div>
    );
  }

  return (
    <>
      <div className="mt-6 overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-700 text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">Stage</th>
              <th className="px-4 py-3 font-medium">Actor</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/70">
            {pagedDecisions.map((decision, index) => {
              const decisionKey = buildDecisionRowKey(decision, index);
              const confidencePercent = toConfidencePercent(decision.confidence);
              const isExpanded = Boolean(expandedDecisionIds[decisionKey]);
              const normalizedStage = normalizeDecisionStage(decision.stage);

              return (
                <Fragment key={decisionKey}>
                  <tr className="align-top hover:bg-slate-900/30">
                    <td className="px-4 py-4 text-slate-300">{formatTimestamp(decision.created_at)}</td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
                        DECISION_STAGE_BADGE_STYLES[normalizedStage] || BADGE_FALLBACK_STYLE
                      }`}
                      >
                        {formatLabel(normalizedStage)}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
                        DECISION_ACTOR_BADGE_STYLES[decision.actor] || BADGE_FALLBACK_STYLE
                      }`}
                      >
                        {formatLabel(decision.actor)}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-white">{decision.action || 'Unknown action'}</p>
                          {decision.batch_id && (
                            <p className="mt-1 text-xs text-slate-500">Batch {decision.batch_id}</p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedDecisionIds((current) => ({
                              ...current,
                              [decisionKey]: !current[decisionKey],
                            }));
                          }}
                          className="shrink-0 rounded-lg border border-slate-700 bg-slate-900/70 px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:border-slate-600 hover:text-white"
                        >
                          {isExpanded ? 'Hide' : 'Reasoning'}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      {confidencePercent === null ? (
                        <span className="text-slate-500">—</span>
                      ) : (
                        <div className="min-w-[150px]">
                          <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                            <span>Confidence</span>
                            <span className="font-mono text-slate-300">{confidencePercent}%</span>
                          </div>
                          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-900">
                            <div
                              className={`h-full rounded-full ${getScoreBarClass(confidencePercent)}`}
                              style={{ width: `${confidencePercent}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={5} className="px-4 pb-4 pt-0">
                        <div className="rounded-xl border border-slate-700/70 bg-slate-900/60 p-4">
                          <p className="text-xs uppercase tracking-wide text-slate-500">Reasoning</p>
                          <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">
                            {decision.reasoning || 'No reasoning recorded for this decision.'}
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-slate-400">
            Showing {pageStart + 1}-{Math.min(pageStart + PAGE_SIZE, decisionLog.length)} of {decisionLog.length}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-slate-600 hover:text-white disabled:opacity-50"
            >
              Previous
            </button>
            <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
              Page {safePage} of {pageCount}
            </span>
            <button
              type="button"
              disabled={safePage >= pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-slate-600 hover:text-white disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default function Activity() {
  const {
    decisionFilters,
    decisionLogError,
    decisionLoading,
    decisionLog,
    decisionStats,
    digest,
    refreshSelectedProject,
    selectedProject,
    setDecisionFilters,
  } = useOutletContext();

  if (!selectedProject) {
    return <SelectProjectPrompt message="Select a project above to view its decision audit trail." />;
  }

  const digestEventCounts = getDigestEventCounts(digest?.events || []);
  const digestEventTotal = Array.isArray(digest?.events) ? digest.events.length : 0;
  const decisionSinceParam = getDecisionSinceParam(decisionFilters.since);
  const hasDecisionFilters = Boolean(
    decisionFilters.stage || decisionFilters.actor || decisionFilters.batchId || decisionSinceParam
  );
  const auditSummary = hasDecisionFilters
    ? buildDecisionSummary(decisionLog)
    : normalizeDecisionStats(decisionStats);
  const decisionScopeKey = [
    decisionFilters.stage || '',
    decisionFilters.actor || '',
    decisionFilters.batchId || '',
    decisionSinceParam || '',
    decisionLog.map(buildDecisionRowKey).join('|'),
  ].join('::');

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold text-white">Audit Trail</h2>
            <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
              {auditSummary.total} total
            </span>
            <span className={`rounded-full border px-3 py-1 text-xs font-medium ${
              digestEventTotal > 0
                ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-200'
                : 'border-slate-700 bg-slate-900/60 text-slate-400'
            }`}
            >
              {digestEventTotal > 0 ? `${digestEventTotal} new notifications` : 'No new notifications'}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-400">
            Review factory decisions by stage, actor, batch, and confidence. Expand a row to inspect recorded reasoning.
          </p>
        </div>

        {digestEventCounts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {digestEventCounts.map(({ eventType, count }) => (
              <span
                key={eventType}
                className="inline-flex items-center rounded-full border border-indigo-500/20 bg-indigo-500/5 px-2.5 py-1 text-xs font-medium text-indigo-200"
              >
                {formatLabel(eventType)} {count}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6 rounded-2xl border border-slate-700/70 bg-slate-900/40 p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="block text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Stage</span>
            <select
              value={decisionFilters.stage}
              onChange={(event) => setDecisionFilters((current) => ({ ...current, stage: event.target.value }))}
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-200"
            >
              <option value="">All stages</option>
              {DECISION_STAGE_OPTIONS.map((stage) => (
                <option key={stage} value={stage}>{formatLabel(stage)}</option>
              ))}
            </select>
          </label>

          <label className="block text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Actor</span>
            <select
              value={decisionFilters.actor}
              onChange={(event) => setDecisionFilters((current) => ({ ...current, actor: event.target.value }))}
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-200"
            >
              <option value="">All actors</option>
              {DECISION_ACTOR_OPTIONS.map((actor) => (
                <option key={actor} value={actor}>{formatLabel(actor)}</option>
              ))}
            </select>
          </label>

          <label className="block text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Batch</span>
            <input
              type="text"
              value={decisionFilters.batchId}
              onChange={(event) => setDecisionFilters((current) => ({ ...current, batchId: event.target.value }))}
              placeholder="All batches"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-200"
            />
          </label>

          <label className="block text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Since</span>
            <input
              type="date"
              value={decisionFilters.since}
              onChange={(event) => setDecisionFilters((current) => ({ ...current, since: event.target.value }))}
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-200"
            />
          </label>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[180px,220px,minmax(0,1fr)]">
        <div className="rounded-2xl border border-slate-700/70 bg-slate-900/40 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Total Decisions</p>
          <p className="mt-2 text-2xl font-semibold text-white">{auditSummary.total}</p>
          <p className="mt-1 text-xs text-slate-400">
            {hasDecisionFilters ? 'Matching current filters' : 'Across this project'}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-700/70 bg-slate-900/40 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Average Confidence</p>
          <p className="mt-2 text-2xl font-semibold text-white">
            {toConfidencePercent(auditSummary.avg_confidence) === null
              ? '—'
              : `${toConfidencePercent(auditSummary.avg_confidence)}%`}
          </p>
          <p className="mt-1 text-xs text-slate-400">Based on recorded confidence scores</p>
        </div>

        <div className="rounded-2xl border border-slate-700/70 bg-slate-900/40 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Stage Breakdown</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {DECISION_STAGE_OPTIONS.map((stage) => (
              <div key={stage} className="rounded-xl border border-slate-700/60 bg-slate-950/40 px-3 py-2">
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  DECISION_STAGE_BADGE_STYLES[stage] || BADGE_FALLBACK_STYLE
                }`}
                >
                  {formatLabel(stage)}
                </span>
                <p className="mt-2 text-lg font-semibold text-white">{auditSummary.by_stage[stage] || 0}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {decisionLogError && (
        <div className="mt-4">
          <FactorySubviewLoadError
            title="Audit trail failed to refresh"
            message={decisionLogError}
            onRetry={refreshSelectedProject}
            retryLabel="Retry audit trail"
          />
        </div>
      )}

      <DecisionAuditTable
        key={decisionScopeKey}
        decisionLoading={decisionLoading}
        decisionLog={decisionLog}
      />
    </section>
  );
}
