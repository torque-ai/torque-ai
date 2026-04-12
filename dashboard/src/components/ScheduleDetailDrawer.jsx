import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { schedules as schedulesApi, study as studyApi } from '../api';
import { useToast } from './Toast';
import { format } from 'date-fns';

function formatTime(iso) {
  if (!iso) return '-';
  try { return format(new Date(iso), 'MMM d, yyyy HH:mm:ss'); }
  catch { return String(iso); }
}

function formatJson(value) {
  if (!value) return '';
  try {
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    return String(value);
  }
}

function formatCountdown(targetIso) {
  if (!targetIso) return null;
  const diff = new Date(targetIso).getTime() - Date.now();
  if (diff <= 0) return 'Firing soon...';
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h remaining`;
  }
  return `${hours}h ${minutes}m remaining`;
}

const PROVIDER_OPTIONS = ['', 'codex', 'claude-cli', 'ollama', 'ollama-cloud', 'anthropic', 'cerebras', 'groq', 'deepinfra', 'hyperbolic', 'google-ai', 'openrouter'];
const PROPOSAL_THRESHOLD_OPTIONS = ['none', 'baseline', 'low', 'moderate', 'high', 'critical'];
const DELTA_LEVEL_STYLES = {
  none: 'bg-slate-600/20 text-slate-300',
  baseline: 'bg-slate-600/20 text-slate-300',
  low: 'bg-emerald-600/20 text-emerald-300',
  moderate: 'bg-amber-600/20 text-amber-300',
  high: 'bg-orange-600/20 text-orange-300',
  critical: 'bg-red-600/20 text-red-300',
};
const READINESS_STYLES = {
  expert_ready: 'bg-green-600/20 text-green-300',
  operator_ready: 'bg-blue-600/20 text-blue-300',
  guided_ready: 'bg-amber-600/20 text-amber-300',
  map_only: 'bg-slate-600/20 text-slate-300',
};

function isStudySchedule(schedule) {
  return schedule?.task_config?.tool_name === 'run_codebase_study';
}

function formatDeltaLevel(level) {
  if (!level) return 'Unknown';
  return String(level)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function DeltaBadge({ level, score }) {
  const normalizedLevel = String(level || 'none').toLowerCase();
  const className = DELTA_LEVEL_STYLES[normalizedLevel] || DELTA_LEVEL_STYLES.none;

  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${className}`}>
      <span>{formatDeltaLevel(normalizedLevel)}</span>
      {typeof score === 'number' && <span className="opacity-80">({score})</span>}
    </span>
  );
}

function ReadinessBadge({ readiness, grade, score }) {
  const normalized = String(readiness || 'map_only').toLowerCase();
  const className = READINESS_STYLES[normalized] || READINESS_STYLES.map_only;
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${className}`}>
      <span>{formatDeltaLevel(normalized)}</span>
      {grade && <span className="opacity-80">{grade}</span>}
      {typeof score === 'number' && <span className="opacity-80">({score})</span>}
    </span>
  );
}

const RUN_STATUS_STYLES = {
  started: 'bg-blue-600/20 text-blue-300',
  running: 'bg-blue-600/20 text-blue-300',
  completed: 'bg-green-600/20 text-green-300',
  failed: 'bg-red-600/20 text-red-300',
  skipped: 'bg-amber-600/20 text-amber-300',
};

function RunStatusBadge({ status }) {
  const normalized = String(status || 'started').toLowerCase();
  const className = RUN_STATUS_STYLES[normalized] || 'bg-slate-600/20 text-slate-300';
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium ${className}`}>
      {normalized}
    </span>
  );
}

function formatRunTrigger(triggerSource) {
  if (!triggerSource) return 'scheduler';
  return String(triggerSource)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getScheduleExecutionMode(schedule) {
  if (schedule?.task_config?.workflow_source_id) return 'Clone Workflow Source';
  if (schedule?.task_config?.workflow_id) return 'Existing Workflow';
  if (schedule?.task_config?.tool_name) return 'Tool';
  return 'Task Prompt';
}

function EditableField({ value, onSave, type = 'text', options, placeholder, multiline, className = '' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const inputRef = useRef(null);

  useEffect(() => { setDraft(value ?? ''); }, [value]); // eslint-disable-line react-hooks/set-state-in-effect -- sync draft with prop
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);

  function save() {
    setEditing(false);
    const trimmed = typeof draft === 'string' ? draft.trim() : draft;
    if (trimmed !== (value ?? '')) onSave(trimmed);
  }

  function cancel() {
    setEditing(false);
    setDraft(value ?? '');
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    if (e.key === 'Enter' && !multiline) { e.preventDefault(); save(); }
  }

  if (!editing) {
    return (
      <span
        onClick={() => setEditing(true)}
        className={`cursor-text border-b border-dashed border-slate-600 hover:border-slate-400 transition-colors ${className}`}
        title="Click to edit"
      >
        {value || <span className="text-slate-600 italic">{placeholder || '\u2014'}</span>}
      </span>
    );
  }

  if (type === 'select') {
    return (
      <select
        ref={inputRef}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); }}
        onBlur={save}
        onKeyDown={handleKeyDown}
        className="bg-slate-800 border border-blue-500 rounded px-2 py-0.5 text-white text-sm focus:outline-none w-full"
      >
        {(options || []).map((opt) => (
          <option key={opt} value={opt}>{opt || 'Auto'}</option>
        ))}
      </select>
    );
  }

  if (type === 'datetime-local') {
    return (
      <input
        ref={inputRef}
        type="datetime-local"
        value={draft ? new Date(draft).toISOString().slice(0, 16) : ''}
        onChange={(e) => setDraft(e.target.value ? new Date(e.target.value).toISOString() : '')}
        onBlur={save}
        onKeyDown={handleKeyDown}
        min={new Date().toISOString().slice(0, 16)}
        className="bg-slate-800 border border-blue-500 rounded px-2 py-0.5 text-white text-sm focus:outline-none [color-scheme:dark] w-full"
      />
    );
  }

  if (multiline) {
    return (
      <textarea
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        rows={4}
        className="bg-slate-800 border border-blue-500 rounded px-2 py-1 text-white text-sm focus:outline-none resize-y w-full"
      />
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={handleKeyDown}
      className="bg-slate-800 border border-blue-500 rounded px-2 py-0.5 text-white text-sm focus:outline-none w-full"
    />
  );
}

export default memo(function ScheduleDetailDrawer({ scheduleId, highlightedRunId = null, onClose, onUpdated }) {
  const [schedule, setSchedule] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [benchmarking, setBenchmarking] = useState(false);
  const [applyingRecommendation, setApplyingRecommendation] = useState(false);
  const [studyOverride, setStudyOverride] = useState(null);
  const [studyOverrideDraft, setStudyOverrideDraft] = useState('');
  const [loadingStudyOverride, setLoadingStudyOverride] = useState(false);
  const [savingStudyOverride, setSavingStudyOverride] = useState(false);
  const [highlightedRun, setHighlightedRun] = useState(null);
  const [, setTick] = useState(0);
  const toast = useToast();
  const drawerRef = useRef(null);
  const previouslyFocusedRef = useRef(null);

  const load = useCallback(async (isCancelled = () => false) => {
    if (!scheduleId) return;
    try {
      const data = await schedulesApi.get(scheduleId);
      const s = data?.data || data;
      if (isCancelled()) return;
      setSchedule(s);
    } catch (_err) {
      if (isCancelled()) return;
      toast.error('Failed to load schedule');
      onClose();
    } finally {
      if (!isCancelled()) {
        setLoading(false);
      }
    }
  }, [scheduleId, toast, onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const recentRuns = Array.isArray(schedule?.recent_runs) ? schedule.recent_runs : [];

    if (!scheduleId || !highlightedRunId) {
      setHighlightedRun(null);
      return () => {
        cancelled = true;
      };
    }

    const inRecentRuns = recentRuns.find((run) => String(run?.id) === String(highlightedRunId));
    if (inRecentRuns) {
      setHighlightedRun(inRecentRuns);
      return () => {
        cancelled = true;
      };
    }

    schedulesApi.getRun(scheduleId, highlightedRunId)
      .then((data) => {
        if (cancelled) return;
        setHighlightedRun(data?.data || data || null);
      })
      .catch(() => {
        if (cancelled) return;
        setHighlightedRun(null);
      });

    return () => {
      cancelled = true;
    };
  }, [scheduleId, highlightedRunId, schedule?.recent_runs]);

  useEffect(() => {
    const isStudy = isStudySchedule(schedule);
    const workingDirectory = schedule?.study_status?.working_directory
      || schedule?.task_config?.tool_args?.working_directory
      || schedule?.task_config?.working_directory
      || '';

    if (!scheduleId || !isStudy || !workingDirectory) {
      setStudyOverride(null);
      setStudyOverrideDraft('');
      setLoadingStudyOverride(false);
      return undefined;
    }

    let cancelled = false;
    setLoadingStudyOverride(true);
    studyApi.getProfileOverride({ working_directory: workingDirectory })
      .then((data) => {
        if (cancelled) return;
        const next = data?.data || data || null;
        setStudyOverride(next);
        setStudyOverrideDraft(next?.raw_override || formatJson(next?.template));
      })
      .catch((err) => {
        if (cancelled) return;
        setStudyOverride(null);
        setStudyOverrideDraft('');
        toast.error(`Failed to load study override: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingStudyOverride(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [scheduleId, schedule, toast]);

  // Countdown ticker for one-time schedules
  useEffect(() => {
    if (schedule?.schedule_type !== 'once') return undefined;
    const interval = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, [schedule?.schedule_type]);

  // Escape to close (when not editing)
  useEffect(() => {
    const drawer = drawerRef.current;
    if (!drawer) return undefined;

    previouslyFocusedRef.current = document.activeElement;
    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusable = drawer.querySelectorAll(focusableSelector);
    if (focusable.length) focusable[0].focus();

    function handleKey(e) {
      const isEditingField = e.target instanceof Element
        && e.target.closest('input, textarea, select, [contenteditable="true"]');

      if (
        e.key === 'Escape'
        && !isEditingField
      ) {
        onClose();
        return;
      }

      if (e.key !== 'Tab') return;
      const focusableElements = drawer.querySelectorAll(focusableSelector);
      if (!focusableElements.length) return;

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    drawer.addEventListener('keydown', handleKey);
    return () => {
      drawer.removeEventListener('keydown', handleKey);
      if (
        previouslyFocusedRef.current
        && document.contains(previouslyFocusedRef.current)
        && typeof previouslyFocusedRef.current.focus === 'function'
      ) {
        previouslyFocusedRef.current.focus();
      }
    };
  }, [onClose]);

  async function saveField(field, value) {
    // Block scheduling in the past
    if (field === 'run_at' && value) {
      if (new Date(value) <= new Date()) {
        toast.error('Cannot schedule in the past');
        return;
      }
    }
    const prev = {
      ...schedule,
      task_config: {
        ...(schedule?.task_config || {}),
        tool_args: {
          ...(schedule?.task_config?.tool_args || {}),
        },
      },
    };
    let payload = { [field]: value };
    // Optimistic update
    if (['provider', 'model', 'working_directory', 'task'].includes(field)) {
      setSchedule((s) => ({ ...s, task_config: { ...s.task_config, [field]: value } }));
    } else if (field === 'project') {
      setSchedule((s) => ({ ...s, task_config: { ...s.task_config, project: value } }));
    } else if (field === 'workflow_id') {
      payload = {
        workflow_id: value || null,
        workflow_source_id: null,
      };
      setSchedule((s) => ({
        ...s,
        task_config: {
          ...s.task_config,
          workflow_id: value || null,
          workflow_source_id: null,
        },
      }));
    } else if (field === 'workflow_source_id') {
      payload = {
        workflow_source_id: value || null,
        workflow_id: null,
      };
      setSchedule((s) => ({
        ...s,
        task_config: {
          ...s.task_config,
          workflow_source_id: value || null,
          workflow_id: null,
        },
      }));
    } else if (['submit_proposals', 'proposal_limit', 'proposal_significance_level', 'proposal_min_score'].includes(field)) {
      setSchedule((s) => ({
        ...s,
        task_config: {
          ...s.task_config,
          tool_args: {
            ...(s.task_config?.tool_args || {}),
            [field]: value,
          },
        },
      }));
    } else {
      setSchedule((s) => ({ ...s, [field]: value }));
    }
    try {
      await schedulesApi.update(scheduleId, payload);
      toast.success('Schedule updated');
      onUpdated?.();
    } catch (err) {
      if (err.message?.includes('not found') || err.status === 404) {
        toast.error('Schedule has already fired');
        onClose();
      } else {
        toast.error(`Update failed: ${err.message}`);
        // Re-fetch server state instead of reverting to potentially stale snapshot
        try {
          const fresh = await schedulesApi.get(scheduleId);
          setSchedule(fresh?.data || fresh);
        } catch {
          setSchedule(prev); // last resort fallback
        }
      }
    }
  }

  async function handleToggle() {
    try {
      await schedulesApi.toggle(scheduleId, !schedule.enabled);
      setSchedule((s) => ({ ...s, enabled: !s.enabled }));
      toast.success(schedule.enabled ? 'Schedule disabled' : 'Schedule enabled');
      onUpdated?.();
    } catch (err) {
      toast.error(`Toggle failed: ${err.message}`);
    }
  }

  async function handleRunNow() {
    setRunningNow(true);
    try {
      const result = await schedulesApi.run(scheduleId);
      const label = result?.execution_type === 'workflow'
        ? 'Workflow run started'
        : result?.execution_type === 'tool'
          ? 'Tool run started'
          : 'Task run started';
      toast.success(label);
      onUpdated?.();
      if (result?.schedule_consumed) {
        onClose();
        return;
      }
      await load();
    } catch (err) {
      if (err.message?.includes('not found')) {
        toast.error('Schedule has already fired');
        onUpdated?.();
        onClose();
      } else {
        toast.error(`Run failed: ${err.message}`);
      }
    } finally {
      setRunningNow(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await load();
      onUpdated?.();
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDelete() {
    try {
      await schedulesApi.delete(scheduleId);
      toast.success('Schedule deleted');
      onUpdated?.();
      onClose();
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    }
  }

  async function handleBenchmark() {
    const workingDirectory = studyStatus.working_directory || studyToolArgs.working_directory || schedule?.task_config?.working_directory || '';
    if (!workingDirectory) {
      toast.error('Study schedule is missing a working directory');
      return;
    }

    setBenchmarking(true);
    try {
      await studyApi.benchmark({ working_directory: workingDirectory });
      toast.success('Study benchmark refreshed');
      onUpdated?.();
      await load();
    } catch (err) {
      toast.error(`Benchmark failed: ${err.message}`);
    } finally {
      setBenchmarking(false);
    }
  }

  async function handleApplyStudyRecommendation() {
    const recommendation = studyImpact?.recommendation;
    if (!recommendation?.settings) {
      toast.error('No study recommendation is available yet');
      return;
    }

    setApplyingRecommendation(true);
    try {
      await schedulesApi.update(scheduleId, recommendation.settings);
      toast.success('Applied recommended study policy');
      onUpdated?.();
      await load();
    } catch (err) {
      toast.error(`Apply failed: ${err.message}`);
    } finally {
      setApplyingRecommendation(false);
    }
  }

  async function handleSaveStudyOverride() {
    const workingDirectory = studyStatus.working_directory || studyToolArgs.working_directory || schedule?.task_config?.working_directory || '';
    if (!workingDirectory) {
      toast.error('Study schedule is missing a working directory');
      return;
    }

    let parsedOverride;
    try {
      parsedOverride = JSON.parse(studyOverrideDraft || '{}');
    } catch (err) {
      toast.error(`Override must be valid JSON: ${err.message}`);
      return;
    }

    if (!parsedOverride || typeof parsedOverride !== 'object' || Array.isArray(parsedOverride)) {
      toast.error('Override must be a JSON object');
      return;
    }

    setSavingStudyOverride(true);
    try {
      const result = await studyApi.saveProfileOverride({
        working_directory: workingDirectory,
        override: parsedOverride,
      });
      const next = result?.data || result || null;
      setStudyOverride(next);
      setStudyOverrideDraft(next?.raw_override || formatJson(next?.template));
      toast.success(next?.active ? 'Study override saved' : 'Study override saved as an inert scaffold');
      onUpdated?.();
      await load();
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSavingStudyOverride(false);
    }
  }

  function handleResetStudyOverrideDraft() {
    const template = studyOverride?.template || null;
    if (!template) {
      toast.error('No study override template is available');
      return;
    }
    setStudyOverrideDraft(formatJson(template));
  }

  async function handleDeleteStudyOverride() {
    const workingDirectory = studyStatus.working_directory || studyToolArgs.working_directory || schedule?.task_config?.working_directory || '';
    if (!workingDirectory) {
      toast.error('Study schedule is missing a working directory');
      return;
    }

    setSavingStudyOverride(true);
    try {
      const result = await studyApi.deleteProfileOverride({
        working_directory: workingDirectory,
      });
      const next = result?.data || result || null;
      setStudyOverride(next);
      setStudyOverrideDraft(next?.raw_override || formatJson(next?.template));
      toast.success('Study override removed');
      onUpdated?.();
      await load();
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    } finally {
      setSavingStudyOverride(false);
    }
  }

  if (!scheduleId) return null;

  const isOnce = schedule?.schedule_type === 'once';
  const borderColor = isOnce ? 'border-purple-500' : 'border-blue-500';
  const isStudy = isStudySchedule(schedule);
  const studyToolArgs = schedule?.task_config?.tool_args || {};
  const studyStatus = schedule?.study_status || {};
  const studyDelta = schedule?.study_delta || studyStatus.delta || null;
  const studyEvaluation = schedule?.study_evaluation || studyStatus.evaluation || null;
  const studyBenchmark = schedule?.study_benchmark || studyStatus.benchmark || null;
  const studyImpact = schedule?.study_impact || studyStatus.impact || null;
  const studyImpactRecommendation = studyImpact?.recommendation || null;
  const studyDetection = studyOverride?.study_profile?.framework_detection || studyStatus?.study_profile?.framework_detection || null;
  const executionMode = getScheduleExecutionMode(schedule);
  const recentRuns = Array.isArray(schedule?.recent_runs) ? schedule.recent_runs : [];
  const combinedRuns = [
    ...(highlightedRun && !recentRuns.some((run) => String(run?.id) === String(highlightedRun.id)) ? [highlightedRun] : []),
    ...recentRuns,
  ];

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      {/* Drawer */}
      <div ref={drawerRef} className={`fixed top-0 right-0 h-full w-[400px] bg-slate-900 border-l-2 ${borderColor} z-50 overflow-y-auto shadow-2xl`} role="dialog" aria-modal="true" aria-label="Schedule details">
        {loading ? (
          <div className="p-6 text-slate-400">Loading...</div>
        ) : !schedule ? (
          <div className="p-6 text-slate-400">Schedule not found</div>
        ) : (
          <div className="p-5 space-y-4">
            {/* Header */}
            <div className="flex justify-between items-start">
              <div className="flex-1 min-w-0">
                <EditableField
                  value={schedule.name}
                  onSave={(v) => saveField('name', v)}
                  className="text-white text-lg font-semibold block"
                />
                <div className="flex gap-2 mt-2">
                  <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                    isOnce ? 'bg-purple-600/20 text-purple-300' : 'bg-blue-600/20 text-blue-300'
                  }`}>
                    {isOnce ? 'Once' : 'Cron'}
                  </span>
                  {isStudy && (
                    <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-cyan-600/20 text-cyan-300">
                      Study
                    </span>
                  )}
                  <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                    schedule.enabled ? 'bg-green-600/20 text-green-300' : 'bg-slate-600/20 text-slate-400'
                  }`}>
                    {schedule.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              </div>
              <button aria-label="Close schedule details" onClick={onClose} className="text-slate-500 hover:text-white text-xl p-1 transition-colors">&times;</button>
            </div>

            {/* Schedule Section */}
            <div className="bg-slate-800/60 rounded-lg p-3">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-2 font-medium">Schedule</div>
              <div className="grid grid-cols-[100px_1fr] gap-y-2 text-sm">
                {isOnce ? (
                  <>
                    <span className="text-slate-500">Fires At</span>
                    <EditableField
                      value={schedule.scheduled_time || schedule.next_run_at}
                      onSave={(v) => saveField('run_at', v)}
                      type="datetime-local"
                      className="text-purple-300"
                    />
                    <span className="text-slate-500">Countdown</span>
                    <span className="text-amber-400 font-medium">{formatCountdown(schedule.next_run_at)}</span>
                  </>
                ) : (
                  <>
                    <span className="text-slate-500">Cron</span>
                    <EditableField
                      value={schedule.cron_expression}
                      onSave={(v) => saveField('cron_expression', v)}
                      className="text-slate-200"
                    />
                    <span className="text-slate-500">Next Run</span>
                    <span className="text-blue-400">{formatTime(schedule.next_run_at)}</span>
                    <span className="text-slate-500">Last Run</span>
                    <span className="text-slate-400">{formatTime(schedule.last_run_at)}</span>
                    <span className="text-slate-500">Run Count</span>
                    <span className="text-slate-400">{schedule.run_count ?? 0}</span>
                  </>
                )}
                <span className="text-slate-500">Timezone</span>
                <EditableField
                  value={schedule.timezone}
                  onSave={(v) => saveField('timezone', v)}
                  placeholder="\u2014"
                  className="text-slate-200"
                />
              </div>
            </div>

            {/* Execution Section */}
	            <div className="bg-slate-800/60 rounded-lg p-3">
	              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-2 font-medium">Execution</div>
	              <div className="grid grid-cols-[100px_1fr] gap-y-2 text-sm">
	                <span className="text-slate-500">Mode</span>
	                <span className="text-slate-200">{executionMode}</span>
	                <span className="text-slate-500">Project</span>
	                <EditableField
	                  value={schedule.task_config?.project}
	                  onSave={(v) => saveField('project', v)}
	                  placeholder="\u2014"
	                  className="text-slate-200"
	                />
	                <span className="text-slate-500">Workflow</span>
	                <EditableField
	                  value={schedule.task_config?.workflow_id}
	                  onSave={(v) => saveField('workflow_id', v)}
	                  placeholder="\u2014"
	                  className="text-slate-200 text-xs"
	                />
	                <span className="text-slate-500">Workflow Source</span>
	                <EditableField
	                  value={schedule.task_config?.workflow_source_id}
	                  onSave={(v) => saveField('workflow_source_id', v)}
	                  placeholder="\u2014"
	                  className="text-slate-200 text-xs"
	                />
	                <span className="text-slate-500">Provider</span>
	                <EditableField
	                  value={schedule.task_config?.provider}
                  onSave={(v) => saveField('provider', v)}
                  type="select"
                  options={PROVIDER_OPTIONS}
                  className="text-slate-200"
                />
                <span className="text-slate-500">Model</span>
                <EditableField
                  value={schedule.task_config?.model}
                  onSave={(v) => saveField('model', v)}
                  placeholder="\u2014"
                  className="text-slate-200"
                />
                <span className="text-slate-500">Directory</span>
                <EditableField
                  value={schedule.task_config?.working_directory}
                  onSave={(v) => saveField('working_directory', v)}
                  placeholder="\u2014"
                  className="text-slate-200 text-xs"
                />
              </div>
            </div>

            {/* Task Description */}
            <div className="bg-slate-800/60 rounded-lg p-3">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-2 font-medium">Task Description</div>
              <EditableField
                value={schedule.task_config?.task || schedule.task_description}
                onSave={(v) => saveField('task_description', v)}
                multiline
                className="text-slate-200 text-sm leading-relaxed block"
              />
            </div>

            {/* Info Section */}
            <div className="bg-slate-800/60 rounded-lg p-3">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-2 font-medium">Info</div>
              <div className="grid grid-cols-[100px_1fr] gap-y-2 text-xs">
                <span className="text-slate-500">ID</span>
                <span className="text-slate-600 font-mono truncate" title={schedule.id}>{schedule.id}</span>
                <span className="text-slate-500">Created</span>
                <span className="text-slate-600">{formatTime(schedule.created_at)}</span>
              </div>
              {isOnce && (
                <p className="text-slate-600 text-xs italic mt-2">Auto-deletes after firing</p>
              )}
            </div>

            {isStudy && (
              <div className="bg-slate-800/60 rounded-lg p-3">
                <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-2 font-medium">Study Intelligence</div>
                <div className="grid grid-cols-[140px_1fr] gap-y-2 text-sm items-center">
                  <span className="text-slate-500">Delta</span>
                  <div>
                    <DeltaBadge
                      level={schedule.delta_significance_level || schedule.study_status?.delta_significance_level}
                      score={schedule.delta_significance_score ?? schedule.study_status?.delta_significance_score}
                    />
                  </div>
                  <span className="text-slate-500">Delta Updated</span>
                  <span className="text-slate-300">{formatTime(schedule.last_delta_updated_at || schedule.study_status?.last_delta_updated_at)}</span>
                  <span className="text-slate-500">Suggested</span>
                  <span className="text-slate-300">{schedule.proposal_count ?? schedule.study_status?.proposal_count ?? 0}</span>
                  <span className="text-slate-500">Submitted</span>
                  <span className="text-slate-300">{schedule.submitted_proposal_count ?? schedule.study_status?.submitted_proposal_count ?? 0}</span>
                  <span className="text-slate-500">Pending Files</span>
                  <span className="text-slate-300">{schedule.pending_count ?? schedule.study_status?.pending_count ?? 0}</span>
                  <span className="text-slate-500">Module Entries</span>
                  <span className="text-slate-300">{schedule.module_entry_count ?? schedule.study_status?.module_entry_count ?? 0}</span>
                  <span className="text-slate-500">Last Result</span>
                  <span className="text-slate-300">{schedule.last_result || schedule.study_status?.last_result || '\u2014'}</span>
                  <span className="text-slate-500">Pack Readiness</span>
                  <div>
                    <ReadinessBadge
                      readiness={schedule.evaluation_readiness || studyStatus.evaluation_readiness}
                      grade={schedule.evaluation_grade || studyStatus.evaluation_grade}
                      score={schedule.evaluation_score ?? studyStatus.evaluation_score}
                    />
                  </div>
                  <span className="text-slate-500">Eval Findings</span>
                  <span className="text-slate-300">{schedule.evaluation_findings_count ?? studyStatus.evaluation_findings_count ?? 0}</span>
                  <span className="text-slate-500">Benchmark</span>
                  <div>
                    <ReadinessBadge
                      readiness={schedule.benchmark_readiness || studyStatus.benchmark_readiness}
                      grade={schedule.benchmark_grade || studyStatus.benchmark_grade}
                      score={schedule.benchmark_score ?? studyStatus.benchmark_score}
                    />
                  </div>
                  <span className="text-slate-500">Benchmark Cases</span>
                  <span className="text-slate-300">{schedule.benchmark_case_count ?? studyStatus.benchmark_case_count ?? 0}</span>
                  <span className="text-slate-500">Auto-Submit</span>
                  <button
                    type="button"
                    onClick={() => saveField('submit_proposals', !Boolean(studyToolArgs.submit_proposals))}
                    className={`justify-self-start rounded px-3 py-1 text-xs font-medium transition-colors ${
                      studyToolArgs.submit_proposals
                        ? 'bg-green-600/20 text-green-300 hover:bg-green-600/40'
                        : 'bg-slate-700/60 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {studyToolArgs.submit_proposals ? 'On' : 'Off'}
                  </button>
                  <span className="text-slate-500">Proposal Limit</span>
                  <EditableField
                    value={studyToolArgs.proposal_limit ?? ''}
                    onSave={(v) => {
                      if (v === '') {
                        saveField('proposal_limit', null);
                        return;
                      }
                      const parsed = Number.parseInt(v, 10);
                      if (Number.isNaN(parsed) || parsed < 1) {
                        toast.error('Proposal limit must be a positive integer');
                        return;
                      }
                      saveField('proposal_limit', parsed);
                    }}
                    placeholder="Default"
                    className="text-slate-200"
                  />
                  <span className="text-slate-500">Min Delta Level</span>
                  <EditableField
                    value={studyToolArgs.proposal_significance_level || 'moderate'}
                    onSave={(v) => saveField('proposal_significance_level', v || 'moderate')}
                    type="select"
                    options={PROPOSAL_THRESHOLD_OPTIONS}
                    className="text-slate-200"
                  />
                  <span className="text-slate-500">Min Delta Score</span>
                  <EditableField
                    value={studyToolArgs.proposal_min_score ?? 0}
                    onSave={(v) => {
                      const parsed = Number.parseInt(v, 10);
                      if (Number.isNaN(parsed) || parsed < 0) {
                        toast.error('Minimum score must be a non-negative integer');
                        return;
                      }
                      saveField('proposal_min_score', parsed);
                    }}
                    placeholder="0"
                    className="text-slate-200"
                  />
                </div>
              </div>
            )}

            {isStudy && (
              <div className="bg-slate-800/60 rounded-lg p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-slate-500 text-[10px] uppercase tracking-wider font-medium">Pack Benchmark</div>
                  <button
                    type="button"
                    onClick={handleBenchmark}
                    disabled={benchmarking}
                    className="rounded px-3 py-1 text-xs font-medium bg-cyan-600/20 text-cyan-300 hover:bg-cyan-600/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {benchmarking ? 'Benchmarking...' : 'Run Benchmark'}
                  </button>
                </div>
                <div className="grid grid-cols-[140px_1fr] gap-y-2 text-sm items-center">
                  <span className="text-slate-500">Generated</span>
                  <span className="text-slate-300">{formatTime(studyBenchmark?.generated_at || schedule.benchmark_generated_at || studyStatus.benchmark_generated_at)}</span>
                  <span className="text-slate-500">Readiness</span>
                  <div>
                    <ReadinessBadge
                      readiness={studyBenchmark?.summary?.readiness || schedule.benchmark_readiness || studyStatus.benchmark_readiness}
                      grade={studyBenchmark?.summary?.grade || schedule.benchmark_grade || studyStatus.benchmark_grade}
                      score={studyBenchmark?.summary?.score ?? schedule.benchmark_score ?? studyStatus.benchmark_score}
                    />
                  </div>
                  <span className="text-slate-500">Cases</span>
                  <span className="text-slate-300">{studyBenchmark?.summary?.total_cases ?? schedule.benchmark_case_count ?? studyStatus.benchmark_case_count ?? 0}</span>
                  <span className="text-slate-500">Findings</span>
                  <span className="text-slate-300">{studyBenchmark?.findings?.length ?? schedule.benchmark_findings_count ?? studyStatus.benchmark_findings_count ?? 0}</span>
                </div>
                {Array.isArray(studyBenchmark?.findings) && studyBenchmark.findings.length > 0 && (
                  <div className="mt-3">
                    <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1 font-medium">Top Gaps</div>
                    <ul className="space-y-1 text-xs text-amber-200">
                      {studyBenchmark.findings.slice(0, 3).map((finding) => (
                        <li key={finding.probe_id || finding.message}>• {finding.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {isStudy && (
              <div className="bg-slate-800/60 rounded-lg p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-slate-500 text-[10px] uppercase tracking-wider font-medium">Study Profile Override</div>
                  <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                    studyOverride?.active
                      ? 'bg-emerald-600/20 text-emerald-300'
                      : studyOverride?.exists
                        ? 'bg-amber-600/20 text-amber-300'
                        : 'bg-slate-700/60 text-slate-300'
                  }`}
                  >
                    {studyOverride?.active ? 'Active' : studyOverride?.exists ? 'Scaffold Only' : 'Not Saved'}
                  </span>
                </div>
                <div className="grid grid-cols-[140px_1fr] gap-y-2 text-sm items-center">
                  <span className="text-slate-500">Archetype</span>
                  <span className="text-slate-300">{formatDeltaLevel(studyDetection?.archetype || 'generic_javascript_repo')}</span>
                  <span className="text-slate-500">Confidence</span>
                  <span className="text-slate-300">{formatDeltaLevel(studyDetection?.confidence || 'medium')}</span>
                  <span className="text-slate-500">Frameworks</span>
                  <span className="text-slate-300">
                    {Array.isArray(studyDetection?.frameworks) && studyDetection.frameworks.length > 0
                      ? studyDetection.frameworks.join(', ')
                      : 'Generic JavaScript'}
                  </span>
                  <span className="text-slate-500">Traits</span>
                  <span className="text-slate-300">
                    {Array.isArray(studyDetection?.traits) && studyDetection.traits.length > 0
                      ? studyDetection.traits.join(', ')
                      : '—'}
                  </span>
                  <span className="text-slate-500">Override File</span>
                  <span className="text-slate-400 font-mono text-xs break-all">{studyOverride?.repo_path || 'docs/architecture/study-profile.override.json'}</span>
                </div>
                {Array.isArray(studyDetection?.evidence) && studyDetection.evidence.length > 0 && (
                  <div className="mt-3">
                    <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1 font-medium">Detection Evidence</div>
                    <ul className="space-y-1 text-xs text-slate-300">
                      {studyDetection.evidence.slice(0, 4).map((item) => (
                        <li key={item}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="mt-3">
                  <label htmlFor="study-profile-override" className="block text-slate-500 text-[10px] uppercase tracking-wider mb-2 font-medium">
                    Override JSON
                  </label>
                  <textarea
                    id="study-profile-override"
                    value={studyOverrideDraft}
                    onChange={(event) => setStudyOverrideDraft(event.target.value)}
                    rows={14}
                    spellCheck={false}
                    disabled={loadingStudyOverride || savingStudyOverride}
                    className="w-full rounded border border-slate-700 bg-slate-950/80 px-3 py-2 font-mono text-xs text-slate-200 focus:border-cyan-500 focus:outline-none disabled:opacity-60"
                  />
                  <p className="mt-2 text-xs text-slate-500">
                    Keep this repo-local and minimal. Add only the missing subsystem, flow, or validation guidance that the generic profile cannot infer.
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleSaveStudyOverride}
                    disabled={loadingStudyOverride || savingStudyOverride}
                    className="rounded px-3 py-1 text-xs font-medium bg-cyan-600/20 text-cyan-300 hover:bg-cyan-600/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {savingStudyOverride ? 'Saving...' : 'Save Override'}
                  </button>
                  <button
                    type="button"
                    onClick={handleResetStudyOverrideDraft}
                    disabled={loadingStudyOverride || savingStudyOverride}
                    className="rounded px-3 py-1 text-xs font-medium bg-slate-700/60 text-slate-200 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Load Template
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteStudyOverride}
                    disabled={loadingStudyOverride || savingStudyOverride || !studyOverride?.exists}
                    className="rounded px-3 py-1 text-xs font-medium bg-rose-600/20 text-rose-300 hover:bg-rose-600/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Delete Override
                  </button>
                </div>
              </div>
            )}

            {isStudy && studyImpact && (
              <div className="bg-slate-800/60 rounded-lg p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-slate-500 text-[10px] uppercase tracking-wider font-medium">Study Impact</div>
                  {studyImpactRecommendation?.settings && (
                    <button
                      type="button"
                      onClick={handleApplyStudyRecommendation}
                      disabled={applyingRecommendation}
                      className="rounded px-3 py-1 text-xs font-medium bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {applyingRecommendation ? 'Applying...' : 'Apply Recommendation'}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-[140px_1fr] gap-y-2 text-sm items-center">
                  <span className="text-slate-500">Window</span>
                  <span className="text-slate-300">{studyImpact.window_days ?? 30} days</span>
                  <span className="text-slate-500">Task Samples</span>
                  <span className="text-slate-300">
                    {(studyImpact.task_outcomes?.with_context?.count ?? 0)} with context / {(studyImpact.task_outcomes?.without_context?.count ?? 0)} without
                  </span>
                  <span className="text-slate-500">Success Rate</span>
                  <span className="text-slate-300">
                    {(studyImpact.task_outcomes?.with_context?.success_rate ?? 0)}% with / {(studyImpact.task_outcomes?.without_context?.success_rate ?? 0)}% without
                  </span>
                  <span className="text-slate-500">Avg Retries</span>
                  <span className="text-slate-300">
                    {(studyImpact.task_outcomes?.with_context?.avg_retry_count ?? 0)} with / {(studyImpact.task_outcomes?.without_context?.avg_retry_count ?? 0)} without
                  </span>
                  <span className="text-slate-500">Avg Tokens</span>
                  <span className="text-slate-300">
                    {(studyImpact.task_outcomes?.with_context?.avg_total_tokens ?? 0)} with / {(studyImpact.task_outcomes?.without_context?.avg_total_tokens ?? 0)} without
                  </span>
                  <span className="text-slate-500">Avg Cost</span>
                  <span className="text-slate-300">
                    ${(studyImpact.task_outcomes?.with_context?.avg_cost_usd ?? 0).toFixed(4)} with / ${(studyImpact.task_outcomes?.without_context?.avg_cost_usd ?? 0).toFixed(4)} without
                  </span>
                  <span className="text-slate-500">Review Flag Rate</span>
                  <span className="text-slate-300">
                    {(studyImpact.review_outcomes?.with_context_source?.flag_rate ?? 0)}% with / {(studyImpact.review_outcomes?.without_context_source?.flag_rate ?? 0)}% without
                  </span>
                </div>
                {studyImpactRecommendation && (
                  <div className="mt-3 rounded bg-slate-900/60 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-slate-500 uppercase tracking-wider">Recommendation</span>
                      <span className="rounded bg-slate-700/70 px-2 py-0.5 text-slate-200">{formatDeltaLevel(studyImpactRecommendation.status || 'unknown')}</span>
                      <span className="text-slate-400">Confidence: {formatDeltaLevel(studyImpactRecommendation.confidence || 'low')}</span>
                    </div>
                    {studyImpactRecommendation.settings && (
                      <p className="mt-2 text-xs text-slate-300">
                        Suggested policy: auto-submit {studyImpactRecommendation.settings.submit_proposals ? 'on' : 'off'}, limit {studyImpactRecommendation.settings.proposal_limit}, threshold {studyImpactRecommendation.settings.proposal_significance_level}, min score {studyImpactRecommendation.settings.proposal_min_score}.
                      </p>
                    )}
                    {Array.isArray(studyImpactRecommendation.reasoning) && studyImpactRecommendation.reasoning.length > 0 && (
                      <ul className="mt-2 space-y-1 text-xs text-slate-300">
                        {studyImpactRecommendation.reasoning.slice(0, 3).map((reason) => (
                          <li key={reason}>• {reason}</li>
                        ))}
                      </ul>
                    )}
                    {studyImpactRecommendation.next_step && (
                      <p className="mt-2 text-xs text-slate-400">{studyImpactRecommendation.next_step}</p>
                    )}
                  </div>
                )}
                {studyImpact.task_outcomes?.delta?.comparison_available && (
                  <div className="mt-3 rounded bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
                    Success delta: {studyImpact.task_outcomes.delta.success_rate_points ?? 0} pts.
                    Retry delta: {studyImpact.task_outcomes.delta.retry_count_delta ?? 0}.
                    Token delta: {studyImpact.task_outcomes.delta.total_tokens_delta ?? 0}.
                  </div>
                )}
              </div>
            )}

            {isStudy && studyEvaluation && (
              <div className="bg-slate-800/60 rounded-lg p-3">
                <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-2 font-medium">Pack Evaluation</div>
                <div className="grid grid-cols-[140px_1fr] gap-y-2 text-sm items-center">
                  <span className="text-slate-500">Generated</span>
                  <span className="text-slate-300">{formatTime(studyEvaluation.generated_at || schedule.evaluation_generated_at || studyStatus.evaluation_generated_at)}</span>
                  <span className="text-slate-500">Score</span>
                  <span className="text-slate-300">{studyEvaluation.summary?.score ?? schedule.evaluation_score ?? 0}</span>
                  <span className="text-slate-500">Grade</span>
                  <span className="text-slate-300">{studyEvaluation.summary?.grade || schedule.evaluation_grade || '\u2014'}</span>
                </div>
                {Array.isArray(studyEvaluation.strengths) && studyEvaluation.strengths.length > 0 && (
                  <div className="mt-3">
                    <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1 font-medium">Strengths</div>
                    <ul className="space-y-1 text-xs text-emerald-200">
                      {studyEvaluation.strengths.slice(0, 3).map((item) => (
                        <li key={item}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {Array.isArray(studyEvaluation.findings) && studyEvaluation.findings.length > 0 && (
                  <div className="mt-3">
                    <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1 font-medium">Top Gaps</div>
                    <ul className="space-y-1 text-xs text-amber-200">
                      {studyEvaluation.findings.slice(0, 3).map((finding) => (
                        <li key={`${finding.code}-${finding.message}`}>• {finding.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {isStudy && studyDelta && (
              <div className="bg-slate-800/60 rounded-lg p-3">
                <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-2 font-medium">Latest Delta</div>
                {Array.isArray(studyDelta.significance?.reasons) && studyDelta.significance.reasons.length > 0 && (
                  <div className="mb-3">
                    <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1 font-medium">Why It Matters</div>
                    <ul className="space-y-1 text-xs text-slate-300">
                      {studyDelta.significance.reasons.slice(0, 4).map((reason) => (
                        <li key={reason}>• {reason}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {studyDelta.proposals?.policy && (
                  <div className="mb-3">
                    <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1 font-medium">Proposal Policy</div>
                    <p className="text-xs text-slate-300">
                      {studyDelta.proposals.policy.allowed
                        ? `Eligible to submit proposals at ${studyDelta.proposals.policy.threshold_level} / ${studyDelta.proposals.policy.threshold_score}.`
                        : `Proposal submission held: ${studyDelta.proposals.policy.reason || 'policy gate closed'}. Threshold ${studyDelta.proposals.policy.threshold_level} / ${studyDelta.proposals.policy.threshold_score}.`}
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-3 text-xs">
                  {Array.isArray(studyDelta.changed_subsystems) && studyDelta.changed_subsystems.length > 0 && (
                    <div>
                      <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1 font-medium">Changed Subsystems</div>
                      <div className="flex flex-wrap gap-1">
                        {studyDelta.changed_subsystems.slice(0, 6).map((item) => (
                          <span key={item.id || item.label} className="rounded bg-slate-700/60 px-2 py-0.5 text-slate-200">
                            {item.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {Array.isArray(studyDelta.affected_flows) && studyDelta.affected_flows.length > 0 && (
                    <div>
                      <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1 font-medium">Affected Flows</div>
                      <div className="flex flex-wrap gap-1">
                        {studyDelta.affected_flows.slice(0, 5).map((item) => (
                          <span key={item.id || item.label} className="rounded bg-blue-600/20 px-2 py-0.5 text-blue-200">
                            {item.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {Array.isArray(studyDelta.invariant_hits) && studyDelta.invariant_hits.length > 0 && (
                    <div>
                      <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1 font-medium">Invariant Hits</div>
                      <ul className="space-y-1 text-slate-300">
                        {studyDelta.invariant_hits.slice(0, 4).map((item) => (
                          <li key={item.id || item.statement}>• {item.statement}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {Array.isArray(studyDelta.failure_mode_hits) && studyDelta.failure_mode_hits.length > 0 && (
                    <div>
                      <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1 font-medium">Failure Mode Hits</div>
                      <ul className="space-y-1 text-slate-300">
                        {studyDelta.failure_mode_hits.slice(0, 4).map((item) => (
                          <li key={item.id || item.label}>• {item.label}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {Array.isArray(studyDelta.proposals?.suggested) && studyDelta.proposals.suggested.length > 0 && (
                    <div>
                      <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1 font-medium">Suggested Follow-Ups</div>
                      <ul className="space-y-1 text-slate-300">
                        {studyDelta.proposals.suggested.slice(0, 3).map((item) => (
                          <li key={item.key || item.title}>• {item.title}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}

            {combinedRuns.length > 0 && (
              <div className="bg-slate-800/60 rounded-lg p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-slate-500 text-[10px] uppercase tracking-wider font-medium">Recent Runs</div>
                  {highlightedRunId && (
                    <span className="text-[10px] font-medium uppercase tracking-wider text-amber-300">
                      Approval Trace Target
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {combinedRuns.map((run) => {
                    const isHighlighted = highlightedRunId && String(run?.id) === String(highlightedRunId);
                    return (
                      <div
                        key={run.id || `${run.started_at}-${run.summary || 'run'}`}
                        className={`rounded-lg border px-3 py-2 ${
                          isHighlighted
                            ? 'border-amber-500/70 bg-amber-500/10'
                            : 'border-slate-700/60 bg-slate-900/30'
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <RunStatusBadge status={run.status} />
                          <span className="text-xs font-mono text-slate-400">{run.id}</span>
                          <span className="text-xs text-slate-500">{formatRunTrigger(run.trigger_source)}</span>
                        </div>
                        <div className="mt-2 grid grid-cols-[96px_1fr] gap-y-1 text-xs">
                          <span className="text-slate-500">Started</span>
                          <span className="text-slate-300">{formatTime(run.started_at)}</span>
                          <span className="text-slate-500">Completed</span>
                          <span className="text-slate-300">{formatTime(run.completed_at)}</span>
                          {run.wrapper_task_id && (
                            <>
                              <span className="text-slate-500">Wrapper Task</span>
                              <span className="font-mono text-slate-300">{run.wrapper_task_id}</span>
                            </>
                          )}
                          {run.skip_reason && (
                            <>
                              <span className="text-slate-500">Skip Reason</span>
                              <span className="text-amber-300">{run.skip_reason}</span>
                            </>
                          )}
                        </div>
                        {run.summary && (
                          <p className="mt-2 text-xs text-slate-400">
                            {run.summary}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-700/50 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </button>
              <button
                onClick={handleRunNow}
                disabled={runningNow}
                className="flex-1 py-2 rounded-lg text-sm font-medium bg-blue-600/20 hover:bg-blue-600/40 text-blue-300 hover:text-blue-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {runningNow ? 'Running...' : 'Run Now'}
              </button>
              <button
                onClick={handleToggle}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                  schedule.enabled
                    ? 'bg-slate-700/50 hover:bg-slate-700 text-slate-300 hover:text-white'
                    : 'bg-green-600/20 hover:bg-green-600/40 text-green-300 hover:text-green-200'
                }`}
              >
                {schedule.enabled ? 'Disable' : 'Enable'}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600/20 hover:bg-red-600/40 text-red-300 hover:text-red-200 transition-colors"
              >
                Delete
              </button>
            </div>

            {/* Delete confirmation */}
            {showDeleteConfirm && (
              <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                <p className="text-slate-300 text-sm mb-3">Delete this schedule? This action is irreversible.</p>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDelete}
                    className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
});
