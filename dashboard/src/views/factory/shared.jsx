import { memo } from 'react';
import RadarChart from '../../components/RadarChart';
import {
  LOOP_STAGE_COLORS,
  LOOP_STAGES,
  STATUS_DOT_STYLES,
  TRUST_BADGE_STYLES,
  BADGE_FALLBACK_STYLE,
  formatBalance,
  formatImpactValue,
  formatLabel,
  formatScopeBudget,
  getScoreBarClass,
  truncateText,
} from './utils';

const LOOP_STATE_PILL_STYLES = {
  IDLE: 'border-slate-600 bg-slate-800 text-slate-400',
  PAUSED: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  STARVED: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
};

function getLoopStatePillStyle(loopState) {
  const normalized = String(loopState || 'IDLE').toUpperCase();
  return LOOP_STATE_PILL_STYLES[normalized] || 'border-blue-500/30 bg-blue-500/10 text-blue-200';
}

// Bucket projects by attention level so the list pane foregrounds
// anything a human needs to look at. Within each bucket we sort by
// name so order is stable across refreshes.
export function groupProjectsForList(projects) {
  const buckets = { attention: [], active: [], idle: [], paused: [] };
  for (const project of projects || []) {
    const loopState = String(project.loop_state || 'IDLE').toUpperCase();
    const alertBadge = getFactoryAlertBadge(project.alert_badge);
    const recoveryExhausted = Number(project.auto_recovery_exhausted) === 1;
    const needsAttention = loopState === 'STARVED'
      || Boolean(alertBadge)
      || recoveryExhausted
      || (project.status === 'paused' && project.loop_paused_at_stage === 'VERIFY_FAIL');

    if (needsAttention) {
      buckets.attention.push(project);
    } else if (project.status === 'paused') {
      buckets.paused.push(project);
    } else if (project.status === 'running' && loopState !== 'IDLE') {
      buckets.active.push(project);
    } else {
      buckets.idle.push(project);
    }
  }
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
  return [
    { id: 'attention', label: 'Needs attention', items: buckets.attention.sort(byName) },
    { id: 'active', label: 'Active', items: buckets.active.sort(byName) },
    { id: 'paused', label: 'Paused', items: buckets.paused.sort(byName) },
    { id: 'idle', label: 'Idle', items: buckets.idle.sort(byName) },
  ].filter((group) => group.items.length > 0);
}

const FACTORY_ALERT_BADGE_LABELS = {
  VERIFY_FAIL_STREAK: 'Verify failures',
  FACTORY_STALLED: 'Factory stalled',
  FACTORY_IDLE: 'Factory idle',
};

const FACTORY_ALERT_BADGE_STYLES = {
  VERIFY_FAIL_STREAK: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
  FACTORY_STALLED: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  FACTORY_IDLE: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
};

function getFactoryAlertBadge(alertBadge) {
  if (!alertBadge || typeof alertBadge !== 'object' || alertBadge.active === false) {
    return null;
  }

  const alertKey = String(alertBadge.alert_key || '').trim();
  const alertType = String(alertBadge.alert_type || '').trim().toUpperCase();
  if (!alertKey || !alertType) {
    return null;
  }

  return {
    alertKey,
    alertType,
    label: FACTORY_ALERT_BADGE_LABELS[alertType] || alertBadge.label || formatLabel(alertType),
    style: FACTORY_ALERT_BADGE_STYLES[alertType] || BADGE_FALLBACK_STYLE,
  };
}

export function SelectProjectPrompt({ message = 'Select a factory project above to view its details.' }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/40 px-6 py-10 text-center text-sm text-slate-400">
      {message}
    </div>
  );
}

export function StatusDot({ status }) {
  return (
    <span
      className={`inline-flex h-2.5 w-2.5 rounded-full ${STATUS_DOT_STYLES[status] || STATUS_DOT_STYLES.idle}`}
      aria-hidden="true"
    />
  );
}

export function TrustBadge({ level }) {
  const normalized = String(level || 'supervised').toLowerCase();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${TRUST_BADGE_STYLES[normalized] || TRUST_BADGE_STYLES.dark}`}
    >
      {formatLabel(normalized)}
    </span>
  );
}

export function DimensionBar({ dimension, score }) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-slate-200">{formatLabel(dimension)}</span>
        <span className="font-mono text-slate-400">{Math.round(value)}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-all ${getScoreBarClass(value)}`}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

export function ProjectListRow({ project, selected, onSelect, activity }) {
  const alertBadge = getFactoryAlertBadge(project.alert_badge);
  const recoveryExhausted = Number(project.auto_recovery_exhausted) === 1;
  const loopState = String(project.loop_state || 'IDLE').toUpperCase();
  const pillLabel = loopState === 'PAUSED' && project.loop_paused_at_stage
    ? `PAUSED · ${project.loop_paused_at_stage}`
    : loopState;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(project.id)}
      className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
        selected
          ? 'border-blue-500/50 bg-blue-500/10 text-white'
          : 'border-transparent bg-slate-900/30 text-slate-200 hover:border-slate-700 hover:bg-slate-900/60'
      }`}
    >
      <StatusDot status={project.status} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.name || project.id}</span>
      {(alertBadge || recoveryExhausted) && (
        <span
          className={`inline-flex h-2 w-2 shrink-0 rounded-full ${recoveryExhausted ? 'bg-rose-400' : 'bg-amber-400'}`}
          aria-label={recoveryExhausted ? 'Recovery exhausted' : (alertBadge?.label || 'Alert')}
          title={recoveryExhausted ? 'Auto-recovery exhausted' : alertBadge?.label}
        />
      )}
      {activity?.recentCount > 0 && !alertBadge && !recoveryExhausted && (
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-indigo-300/80">
          {activity.recentCount}
        </span>
      )}
      <span
        className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${getLoopStatePillStyle(loopState)}`}
      >
        {pillLabel}
      </span>
    </button>
  );
}

export function ProjectCard({
  project,
  selected,
  busy,
  onSelect,
  onToggle,
  activity,
  onClearAutoRecovery,
  clearAutoRecoveryBusy = false,
}) {
  const actionLabel = project.status === 'running' ? 'Pause' : 'Resume';
  const weakest = project.weakest_dimension;
  const alertBadge = getFactoryAlertBadge(project.alert_badge);
  const recoveryAttempts = Number(project.auto_recovery_attempts) || 0;
  const recoveryExhausted = Number(project.auto_recovery_exhausted) === 1;
  const isAutoRecovering = recoveryAttempts > 0 && !recoveryExhausted;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(project.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(project.id);
        }
      }}
      className={`rounded-2xl border p-5 transition-all ${
        selected
          ? 'border-blue-500/50 bg-slate-800 shadow-lg shadow-blue-950/30'
          : 'border-slate-700 bg-slate-800/80 hover:border-slate-600 hover:bg-slate-800'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot status={project.status} />
            <h2 className="truncate text-lg font-semibold text-white">{project.name || 'Unnamed project'}</h2>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <TrustBadge level={project.trust_level} />
            {alertBadge && (
              <span
                className={`inline-flex max-w-full items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${alertBadge.style}`}
                title={alertBadge.alertKey}
                aria-label={`Factory alert: ${alertBadge.label}`}
              >
                {alertBadge.label}
              </span>
            )}
            {isAutoRecovering && (
              <span
                className="inline-flex max-w-full items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-200"
                title={`Last strategy: ${project.auto_recovery_last_strategy || '—'}`}
              >
                Auto-recovering: attempt {recoveryAttempts}/5
              </span>
            )}
            {activity?.recentCount > 0 && (
              <span className="inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-200">
                {activity.recentCount} recent
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(project);
          }}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            project.status === 'running'
              ? 'bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
              : 'bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
          }`}
        >
          {busy ? 'Working...' : actionLabel}
        </button>
      </div>

      {recoveryExhausted && (
        <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-rose-200">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium">Auto-recovery exhausted — operator action required</p>
            <button
              type="button"
              disabled={clearAutoRecoveryBusy || !onClearAutoRecovery}
              onClick={(event) => {
                event.stopPropagation();
                if (onClearAutoRecovery) {
                  void onClearAutoRecovery(project);
                }
              }}
              className="inline-flex items-center justify-center rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-1.5 text-sm font-medium text-rose-100 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {clearAutoRecoveryBusy ? 'Clearing...' : 'Clear & retry'}
            </button>
          </div>
        </div>
      )}

      <p className="mt-4 break-all font-mono text-xs text-slate-400">{project.path || 'No path configured'}</p>

      <div className="mt-5 flex justify-center rounded-xl border border-slate-700/70 bg-slate-900/40 p-3">
        <RadarChart scores={project.scores} size={180} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-700/70 bg-slate-900/40 p-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Balance</p>
          <p className="mt-1 text-lg font-semibold text-white">{formatBalance(project.balance)}</p>
        </div>
        <div className="rounded-xl border border-slate-700/70 bg-slate-900/40 p-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Weakest</p>
          {weakest ? (
            <>
              <p className="mt-1 text-sm font-semibold text-white">{formatLabel(weakest.dimension)}</p>
              <p className="text-xs text-slate-400">{Math.round(weakest.score)}</p>
            </>
          ) : (
            <p className="mt-1 text-sm text-slate-400">No scores yet</p>
          )}
        </div>
      </div>

      {activity?.lastAction && (
        <div className="mt-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3">
          <p className="text-xs uppercase tracking-wide text-indigo-200/80">Last Action</p>
          <p className="mt-1 truncate text-sm text-slate-200" title={activity.lastAction}>{activity.lastAction}</p>
        </div>
      )}
    </div>
  );
}

export function LoopStatusBadge({ loopState, pausedAtStage }) {
  if (!loopState || loopState === 'IDLE') {
    return <span className="rounded border border-slate-600 bg-slate-800 px-2 py-0.5 text-xs text-slate-400">Idle</span>;
  }
  if (loopState === 'PAUSED') {
    return (
      <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
        Paused at {pausedAtStage || '?'}
      </span>
    );
  }
  const color = LOOP_STAGE_COLORS[loopState] || 'bg-slate-600';
  return (
    <span className={`rounded px-2 py-0.5 text-xs text-white ${color}`}>
      {loopState}
    </span>
  );
}

export function BatchTimeline({ currentStage, pausedAtStage }) {
  return (
    <div className="my-3 flex items-center gap-1">
      {LOOP_STAGES.map((stage, index) => {
        const isCurrent = currentStage === stage;
        const isPaused = pausedAtStage === stage;
        const isPast = currentStage && LOOP_STAGES.indexOf(currentStage) > index;
        let bg = 'bg-slate-700';
        if (isCurrent) bg = LOOP_STAGE_COLORS[stage];
        else if (isPaused) bg = 'bg-amber-400';
        else if (isPast) bg = 'bg-slate-500';
        return (
          <div key={stage} className="flex items-center gap-1">
            <div className="flex flex-col items-center">
              <div className={`flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-bold text-white ${bg}`}>
                {index + 1}
              </div>
              <span className="mt-0.5 text-[9px] text-slate-400">{stage}</span>
            </div>
            {index < LOOP_STAGES.length - 1 && (
              <div className={`h-0.5 w-6 ${isPast ? 'bg-slate-500' : 'bg-slate-700'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export const ArchitectBacklogItemRow = memo(function ArchitectBacklogItemRow({ item }) {
  const impactEntries = Object.entries(item.expected_impact || {});
  const whyText = item.why || 'No rationale provided yet.';

  return (
    <li className="rounded-2xl border border-slate-700/70 bg-slate-900/40 p-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full border border-purple-500/30 bg-purple-500/10 px-2 text-xs font-semibold text-purple-200">
              {item.priority_rank}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-white">{item.title}</p>
              <p className="mt-2 text-sm text-slate-400">
                <span className="block truncate" title={whyText}>
                  {truncateText(whyText, 140)}
                </span>
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 xl:max-w-[45%] xl:justify-end">
          <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs text-slate-300">
            {formatScopeBudget(item.scope_budget)}
          </span>
          {impactEntries.length === 0 ? (
            <span className="text-xs text-slate-500">No impact estimate</span>
          ) : (
            impactEntries.map(([dimension, delta]) => (
              <span
                key={dimension}
                className="inline-flex items-center rounded-full border border-cyan-500/20 bg-cyan-500/5 px-2.5 py-1 text-xs font-medium text-cyan-200"
              >
                {formatLabel(dimension)} {formatImpactValue(delta)}
              </span>
            ))
          )}
        </div>
      </div>
    </li>
  );
});
