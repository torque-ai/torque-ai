import { Fragment, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import { ArchitectBacklogItemRow, SelectProjectPrompt } from './shared';
import {
  BADGE_FALLBACK_STYLE,
  INTAKE_SOURCE_BADGE_STYLES,
  INTAKE_STATUS_BADGE_STYLES,
  INTAKE_SUMMARY_ORDER,
  formatCycleLabel,
  formatLabel,
  formatTimestamp,
  getIntakeSummary,
} from './utils';

function ArchitectReasoningPanel({ reasoningSummary }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-6 rounded-2xl border border-slate-700/70 bg-slate-900/40 p-4">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex items-center gap-2 text-sm font-medium text-slate-300 transition-colors hover:text-white"
      >
        <span className="text-xs text-slate-500">{expanded ? '▼' : '▶'}</span>
        <span>Reasoning</span>
      </button>
      {expanded && (
        <p className="mt-3 whitespace-pre-wrap text-sm text-slate-300">
          {reasoningSummary}
        </p>
      )}
    </div>
  );
}

export default function Intake() {
  const {
    architectBacklog,
    architectLoading,
    backlogLoading,
    handleRejectWorkItem,
    handleRerunArchitect,
    intakeItems,
    intakeLoading,
    rejectingItemId,
    selectedProject,
  } = useOutletContext();

  if (!selectedProject) {
    return <SelectProjectPrompt message="Select a project above to view its intake queue." />;
  }

  const intakeSummary = getIntakeSummary(intakeItems);
  const backlogCycleLabel = formatCycleLabel(architectBacklog.cycleId);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold text-white">Intake Queue</h2>
            <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
              {intakeItems.length}
            </span>
          </div>
          {intakeLoading && <span className="text-xs uppercase tracking-wide text-slate-500">Refreshing</span>}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-300">
          {INTAKE_SUMMARY_ORDER.map((status, index) => (
            <Fragment key={status}>
              {index > 0 && <span className="text-slate-600">·</span>}
              <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2.5 py-1">
                {intakeSummary.counts[status]} {formatLabel(status)}
              </span>
            </Fragment>
          ))}
          {intakeSummary.other > 0 && (
            <>
              <span className="text-slate-600">·</span>
              <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2.5 py-1">
                {intakeSummary.other} Other
              </span>
            </>
          )}
        </div>

        {intakeLoading && intakeItems.length === 0 ? (
          <div className="mt-6">
            <LoadingSkeleton lines={4} height={18} />
          </div>
        ) : intakeItems.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-900/40 px-5 py-10 text-center text-sm text-slate-400">
            No work items in the intake queue
          </div>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-700 text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Title</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Priority</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Created At</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/70">
                {intakeItems.map((item) => {
                  const sourceStyle = INTAKE_SOURCE_BADGE_STYLES[item.displaySource] || BADGE_FALLBACK_STYLE;
                  const statusStyle = INTAKE_STATUS_BADGE_STYLES[item.displayStatus] || BADGE_FALLBACK_STYLE;
                  const isRejected = item.displayStatus === 'rejected';
                  const isRejecting = rejectingItemId === item.id;

                  return (
                    <tr id={`work-item-${item.id}`} key={item.id} className="align-top">
                      <td className="px-4 py-4">
                        <p className="font-medium text-white">{item.title || 'Untitled work item'}</p>
                        {item.description && (
                          <p className="mt-1 max-w-xl text-xs text-slate-400">{item.description}</p>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${sourceStyle}`}>
                          {formatLabel(item.displaySource)}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-slate-300">{formatLabel(item.priority || 'default')}</td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyle}`}>
                          {formatLabel(item.displayStatus)}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-slate-300">{formatTimestamp(item.created_at)}</td>
                      <td className="px-4 py-4 text-right">
                        <button
                          type="button"
                          disabled={isRejected || isRejecting}
                          onClick={() => handleRejectWorkItem(item.id)}
                          className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-sm font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isRejecting ? 'Rejecting...' : isRejected ? 'Rejected' : 'Reject'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-xl font-semibold text-white">Architect Backlog</h2>
              <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
                {backlogCycleLabel}
              </span>
            </div>
            <p className="mt-2 text-sm text-slate-400">
              Ranked work items from the latest architect cycle, refreshed with the active factory view.
            </p>
          </div>

          <button
            type="button"
            onClick={handleRerunArchitect}
            disabled={architectLoading}
            className="inline-flex items-center justify-center rounded-lg border border-purple-500/30 bg-purple-500/10 px-4 py-2 text-sm font-medium text-purple-100 transition-colors hover:bg-purple-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {architectLoading ? 'Re-running...' : 'Re-run architect'}
          </button>
        </div>

        {backlogLoading && architectBacklog.items.length === 0 ? (
          <div className="mt-6">
            <LoadingSkeleton lines={4} height={18} />
          </div>
        ) : architectBacklog.items.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-900/40 px-5 py-10 text-center text-sm text-slate-400">
            No architect cycle yet — click Re-run to generate one.
          </div>
        ) : (
          <>
            <ol className="mt-6 space-y-3">
              {architectBacklog.items.map((item, index) => (
                <ArchitectBacklogItemRow key={item.work_item_id || `${item.title}-${index}`} item={item} />
              ))}
            </ol>

            {architectBacklog.reasoningSummary && (
              <ArchitectReasoningPanel
                key={`${architectBacklog.cycleId || 'none'}:${architectBacklog.reasoningSummary}`}
                reasoningSummary={architectBacklog.reasoningSummary}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
