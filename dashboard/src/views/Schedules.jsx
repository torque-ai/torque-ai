import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { schedules as schedulesApi, study as studyApi } from '../api';
import { useToast } from '../components/Toast';
import StatCard from '../components/StatCard';
import { formatDate } from '../utils/formatters';
import LoadingSkeleton from '../components/LoadingSkeleton';
import ScheduleDetailDrawer from '../components/ScheduleDetailDrawer';

const DELTA_LEVEL_STYLES = {
  none: 'bg-slate-600/20 text-slate-300',
  baseline: 'bg-slate-600/20 text-slate-300',
  low: 'bg-emerald-600/20 text-emerald-300',
  moderate: 'bg-amber-600/20 text-amber-300',
  high: 'bg-orange-600/20 text-orange-300',
  critical: 'bg-red-600/20 text-red-300',
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
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium ${className}`}>
      <span>Delta: {formatDeltaLevel(normalizedLevel)}</span>
      {typeof score === 'number' && <span className="opacity-80">({score})</span>}
    </span>
  );
}

function SortHeader({ column, label, sortCol, sortDir, onSort }) {
  const active = sortCol === column;
  return (
    <th
      scope="col"
      className="text-left p-4 heading-sm cursor-pointer select-none hover:text-white transition-colors group"
      onClick={() => onSort(column)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort(column);
        }
      }}
      tabIndex={0}
      role="columnheader"
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-[10px] ${active ? 'text-blue-400' : 'text-slate-600 opacity-0 group-hover:opacity-100'} transition-opacity`}>
          {active ? (sortDir === 'asc' ? '\u25b2' : '\u25bc') : '\u25b2'}
        </span>
      </span>
    </th>
  );
}

function StatusBadge({ enabled }) {
  return (
    <span className={`px-2 py-1 rounded-full text-[11px] font-medium text-white ${enabled ? 'bg-green-500' : 'bg-slate-500'}`}>
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

function normalizeSchedulesResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.schedules)) return data.schedules;
  return [];
}

function getDefaultTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

export default function Schedules() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [showForm, setShowForm] = useState(false);
  const [showConfirm, setShowConfirm] = useState(null);
  const confirmRef = useRef(null);
  const [form, setForm] = useState({
    name: '',
    schedule_type: 'cron',
    execution_target: 'task',
    cron_expression: '',
    run_at: '',
    task_description: '',
    workflow_id: '',
    workflow_source_id: '',
    provider: '',
    model: '',
    working_directory: '',
    project: '',
  });
  const [showBootstrapForm, setShowBootstrapForm] = useState(false);
  const [bootstrapAdvanced, setBootstrapAdvanced] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [previewingBootstrap, setPreviewingBootstrap] = useState(false);
  const [lastBootstrapPreview, setLastBootstrapPreview] = useState(null);
  const [lastBootstrapResult, setLastBootstrapResult] = useState(null);
  const [bootstrapForm, setBootstrapForm] = useState({
    working_directory: '',
    project: '',
    name: '',
    cron_expression: '*/15 * * * *',
    timezone: getDefaultTimezone(),
    initial_max_batches: 5,
    create_schedule: true,
    run_initial_study: true,
    run_benchmark: true,
    submit_proposals: false,
    proposal_limit: 2,
    proposal_significance_level: 'moderate',
    write_profile_scaffold: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [runningScheduleId, setRunningScheduleId] = useState(null);
  const [selectedScheduleId, setSelectedScheduleId] = useState(null);
  const highlightedRunId = searchParams.get('runId');
  const toast = useToast();

  useEffect(() => {
    const modal = confirmRef.current;
    if (!showConfirm || !modal) return;
    const focusable = modal.querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
    if (focusable.length) focusable[0].focus();
    function trap(e) {
      if (e.key === 'Escape') { setShowConfirm(null); return; }
      if (e.key !== 'Tab' || !focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    modal.addEventListener('keydown', trap);
    return () => modal.removeEventListener('keydown', trap);
  }, [showConfirm]);

  const loadSchedules = useCallback(async () => {
    try {
      const data = await schedulesApi.list();
      setItems(normalizeSchedulesResponse(data));
    } catch (err) {
      console.error('Failed to load schedules:', err);
      toast.error('Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadSchedules();
    const interval = setInterval(() => {
      if (document.hidden || selectedScheduleId) return; // pause polling while drawer is open
      loadSchedules();
    }, 60000);
    return () => clearInterval(interval);
  }, [loadSchedules, selectedScheduleId]);

  const updateDrawerParams = useCallback((nextScheduleId, nextRunId = null) => {
    const nextParams = new URLSearchParams(searchParams);
    if (nextScheduleId) {
      nextParams.set('scheduleId', nextScheduleId);
    } else {
      nextParams.delete('scheduleId');
    }
    if (nextRunId) {
      nextParams.set('runId', nextRunId);
    } else {
      nextParams.delete('runId');
    }
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const openDrawer = useCallback((scheduleId, runId = null) => {
    setSelectedScheduleId(scheduleId);
    updateDrawerParams(scheduleId, runId);
  }, [updateDrawerParams]);

  const closeDrawer = useCallback(() => {
    setSelectedScheduleId(null);
    updateDrawerParams(null, null);
  }, [updateDrawerParams]);
  const refreshAfterDrawer = useCallback(() => loadSchedules(), [loadSchedules]);

  useEffect(() => {
    const paramScheduleId = searchParams.get('scheduleId');
    if (!paramScheduleId) {
      return;
    }
    setSelectedScheduleId((current) => (current === paramScheduleId ? current : paramScheduleId));
  }, [searchParams]);

  function handleSort(col) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  const sortedItems = useMemo(() => {
    if (!items.length) return items;
    return [...items].sort((a, b) => {
      let av = '', bv = '';
      if (sortCol === 'status') {
        av = String(a.enabled !== false && a.enabled !== 0 ? 1 : 0);
        bv = String(b.enabled !== false && b.enabled !== 0 ? 1 : 0);
      } else {
        av = String(a[sortCol] ?? '');
        bv = String(b[sortCol] ?? '');
      }
      const cmp = av.localeCompare(bv, undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [items, sortCol, sortDir]);

  async function handleToggle(id, currentEnabled) {
    try {
      await schedulesApi.toggle(id, !currentEnabled);
      toast.success(`Schedule ${currentEnabled ? 'disabled' : 'enabled'}`);
      await loadSchedules();
    } catch (err) {
      toast.error(`Toggle failed: ${err.message}`);
    }
  }

  async function handleRunNow(id) {
    setRunningScheduleId(id);
    try {
      const result = await schedulesApi.run(id);
      const label = result?.execution_type === 'workflow'
        ? 'Workflow run started'
        : result?.execution_type === 'tool'
          ? 'Tool run started'
          : 'Task run started';
      toast.success(label);
      await loadSchedules();
    } catch (err) {
      toast.error(`Run failed: ${err.message}`);
    } finally {
      setRunningScheduleId(null);
    }
  }

  function handleDelete(id) {
    setShowConfirm({ action: 'deleteSchedule', id });
  }

  async function confirmAction() {
    if (showConfirm?.action === 'deleteSchedule') {
      try {
        await schedulesApi.delete(showConfirm.id);
        toast.success('Schedule deleted');
        loadSchedules();
      } catch (err) {
        toast.error(`Delete failed: ${err.message}`);
      }
    }
    setShowConfirm(null);
  }

  const isValidCron = (expr) => /^[\d*,/-]+(\s+[\d*,/-]+){4}$/.test(expr.trim());

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.name) {
      toast.error('Name is required');
      return;
    }
    if (form.schedule_type === 'cron') {
      if (!form.cron_expression) {
        toast.error('Cron expression is required');
        return;
      }
      if (!isValidCron(form.cron_expression)) {
        toast.error('Invalid cron expression \u2014 expected 5 fields');
        return;
      }
    } else {
      if (!form.run_at) {
        toast.error('Date and time are required for one-time schedules');
        return;
      }
      if (new Date(form.run_at) <= new Date()) {
        toast.error('Scheduled time must be in the future');
        return;
      }
    }
    if (form.execution_target === 'task' && !form.task_description.trim()) {
      toast.error('Task description is required');
      return;
    }
    if (form.execution_target === 'workflow' && !form.workflow_id.trim()) {
      toast.error('Workflow ID is required');
      return;
    }
    if (form.execution_target === 'workflow_source' && !form.workflow_source_id.trim()) {
      toast.error('Workflow source ID is required');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        name: form.name,
        schedule_type: form.schedule_type,
        working_directory: form.working_directory || undefined,
        project: form.project || undefined,
      };
      if (form.execution_target === 'task') {
        payload.task_description = form.task_description;
        payload.provider = form.provider || undefined;
        payload.model = form.model || undefined;
      } else {
        if (form.task_description.trim()) {
          payload.task_description = form.task_description;
        }
        if (form.execution_target === 'workflow') {
          payload.workflow_id = form.workflow_id.trim();
        }
        if (form.execution_target === 'workflow_source') {
          payload.workflow_source_id = form.workflow_source_id.trim();
        }
      }
      if (form.schedule_type === 'cron') {
        payload.cron_expression = form.cron_expression;
      } else {
        payload.run_at = new Date(form.run_at).toISOString();
      }
      Object.keys(payload).forEach((k) => { if (payload[k] === undefined) delete payload[k]; });
      await schedulesApi.create(payload);
      toast.success('Schedule created');
      setForm({
        name: '',
        schedule_type: 'cron',
        execution_target: 'task',
        cron_expression: '',
        run_at: '',
        task_description: '',
        workflow_id: '',
        workflow_source_id: '',
        provider: '',
        model: '',
        working_directory: '',
        project: '',
      });
      setShowForm(false);
      loadSchedules();
    } catch (err) {
      toast.error(`Create failed: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBootstrap(e) {
    e.preventDefault();
    if (!bootstrapForm.working_directory.trim()) {
      toast.error('Working directory is required');
      return;
    }

    setBootstrapping(true);
    try {
      const payload = {
        working_directory: bootstrapForm.working_directory.trim(),
        project: bootstrapForm.project.trim() || undefined,
        name: bootstrapForm.name.trim() || undefined,
        cron_expression: bootstrapForm.cron_expression.trim() || undefined,
        timezone: bootstrapForm.timezone.trim() || undefined,
        initial_max_batches: Number.parseInt(bootstrapForm.initial_max_batches, 10) || undefined,
        create_schedule: bootstrapForm.create_schedule,
        run_initial_study: bootstrapForm.run_initial_study,
        run_benchmark: bootstrapForm.run_benchmark,
        submit_proposals: bootstrapForm.submit_proposals,
        proposal_limit: Number.parseInt(bootstrapForm.proposal_limit, 10) || undefined,
        proposal_significance_level: bootstrapForm.proposal_significance_level || undefined,
        write_profile_scaffold: bootstrapForm.write_profile_scaffold,
      };
      Object.keys(payload).forEach((key) => {
        if (payload[key] === undefined) delete payload[key];
      });

      const result = await studyApi.bootstrap(payload);
      setLastBootstrapResult(result);
      setShowBootstrapForm(false);
      setBootstrapAdvanced(false);
      toast.success(result?.schedule?.schedule_id ? 'Study bootstrapped and schedule created' : 'Study bootstrapped');
      await loadSchedules();
      if (result?.schedule?.schedule_id) {
        openDrawer(result.schedule.schedule_id);
      }
    } catch (err) {
      toast.error(`Bootstrap failed: ${err.message}`);
    } finally {
      setBootstrapping(false);
    }
  }

  async function handleBootstrapPreview(e) {
    e.preventDefault();
    if (!bootstrapForm.working_directory.trim()) {
      toast.error('Working directory is required');
      return;
    }

    setPreviewingBootstrap(true);
    try {
      const payload = {
        working_directory: bootstrapForm.working_directory.trim(),
        project: bootstrapForm.project.trim() || undefined,
        name: bootstrapForm.name.trim() || undefined,
        cron_expression: bootstrapForm.cron_expression.trim() || undefined,
        timezone: bootstrapForm.timezone.trim() || undefined,
        initial_max_batches: Number.parseInt(bootstrapForm.initial_max_batches, 10) || undefined,
        submit_proposals: bootstrapForm.submit_proposals,
        proposal_limit: Number.parseInt(bootstrapForm.proposal_limit, 10) || undefined,
        proposal_significance_level: bootstrapForm.proposal_significance_level || undefined,
      };
      Object.keys(payload).forEach((key) => {
        if (payload[key] === undefined) delete payload[key];
      });

      const result = await studyApi.preview(payload);
      setLastBootstrapPreview(result);
      toast.success('Study bootstrap preview refreshed');
    } catch (err) {
      toast.error(`Preview failed: ${err.message}`);
    } finally {
      setPreviewingBootstrap(false);
    }
  }

  const enabledCount = items.filter((s) => s.enabled !== false && s.enabled !== 0).length;
  const totalCount = items.length;

  if (loading) {
    return (
      <div className="p-6">
        <LoadingSkeleton lines={5} />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="heading-lg text-white">Schedules</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowBootstrapForm(!showBootstrapForm)}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white text-sm rounded-lg transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
            </svg>
            Bootstrap Study
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Schedule
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <StatCard label="Total Schedules" value={totalCount} gradient="blue" />
        <StatCard label="Active" value={enabledCount} gradient="green" />
        <StatCard label="Disabled" value={totalCount - enabledCount} gradient="blue" />
      </div>

      {showBootstrapForm && (
        <form onSubmit={handleBootstrap} className="glass-card p-6 mb-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-white mb-1">Bootstrap Study</h3>
              <p className="text-sm text-slate-400">Create a study knowledge pack for a repo and optionally register the recurring schedule in one step.</p>
            </div>
            <button
              type="button"
              onClick={() => setBootstrapAdvanced((value) => !value)}
              className="text-xs px-3 py-1 rounded bg-slate-800/60 text-slate-300 hover:text-white transition-colors"
            >
              {bootstrapAdvanced ? 'Hide Advanced' : 'Show Advanced'}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="bootstrap-working-directory" className="block text-sm text-slate-400 mb-1">Working Directory</label>
              <input id="bootstrap-working-directory" type="text" value={bootstrapForm.working_directory} onChange={(e) => setBootstrapForm({ ...bootstrapForm, working_directory: e.target.value })} placeholder="e.g. C:/Projects/MyRepo" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500" />
            </div>
            <div>
              <label htmlFor="bootstrap-project" className="block text-sm text-slate-400 mb-1">Project (optional)</label>
              <input id="bootstrap-project" type="text" value={bootstrapForm.project} onChange={(e) => setBootstrapForm({ ...bootstrapForm, project: e.target.value })} placeholder="e.g. torque-public" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={bootstrapForm.create_schedule} onChange={(e) => setBootstrapForm({ ...bootstrapForm, create_schedule: e.target.checked })} />
              Create or refresh the recurring study schedule
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={bootstrapForm.run_benchmark} onChange={(e) => setBootstrapForm({ ...bootstrapForm, run_benchmark: e.target.checked })} />
              Run the pack benchmark after bootstrapping
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={bootstrapForm.run_initial_study} onChange={(e) => setBootstrapForm({ ...bootstrapForm, run_initial_study: e.target.checked })} />
              Run the initial study immediately
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={bootstrapForm.submit_proposals} onChange={(e) => setBootstrapForm({ ...bootstrapForm, submit_proposals: e.target.checked })} />
              Enable study proposal submission policy
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={bootstrapForm.write_profile_scaffold} onChange={(e) => setBootstrapForm({ ...bootstrapForm, write_profile_scaffold: e.target.checked })} />
              Scaffold a repo-local study profile override file
            </label>
          </div>

          {bootstrapAdvanced && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="bootstrap-name" className="block text-sm text-slate-400 mb-1">Schedule Name (optional)</label>
                <input id="bootstrap-name" type="text" value={bootstrapForm.name} onChange={(e) => setBootstrapForm({ ...bootstrapForm, name: e.target.value })} placeholder="e.g. codebase-study:my-repo" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500" />
              </div>
              <div>
                <label htmlFor="bootstrap-cron" className="block text-sm text-slate-400 mb-1">Cron Expression</label>
                <input id="bootstrap-cron" type="text" value={bootstrapForm.cron_expression} onChange={(e) => setBootstrapForm({ ...bootstrapForm, cron_expression: e.target.value })} placeholder="*/15 * * * *" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500" />
              </div>
              <div>
                <label htmlFor="bootstrap-timezone" className="block text-sm text-slate-400 mb-1">Timezone</label>
                <input id="bootstrap-timezone" type="text" value={bootstrapForm.timezone} onChange={(e) => setBootstrapForm({ ...bootstrapForm, timezone: e.target.value })} placeholder="e.g. America/Denver" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500" />
              </div>
              <div>
                <label htmlFor="bootstrap-batches" className="block text-sm text-slate-400 mb-1">Initial Max Batches</label>
                <input id="bootstrap-batches" type="number" min="1" value={bootstrapForm.initial_max_batches} onChange={(e) => setBootstrapForm({ ...bootstrapForm, initial_max_batches: e.target.value })} className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-cyan-500" />
              </div>
              <div>
                <label htmlFor="bootstrap-threshold" className="block text-sm text-slate-400 mb-1">Proposal Threshold</label>
                <select id="bootstrap-threshold" value={bootstrapForm.proposal_significance_level} onChange={(e) => setBootstrapForm({ ...bootstrapForm, proposal_significance_level: e.target.value })} className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-cyan-500">
                  {Object.keys(DELTA_LEVEL_STYLES).map((level) => (
                    <option key={level} value={level}>{formatDeltaLevel(level)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="bootstrap-proposal-limit" className="block text-sm text-slate-400 mb-1">Proposal Limit</label>
                <input id="bootstrap-proposal-limit" type="number" min="1" value={bootstrapForm.proposal_limit} onChange={(e) => setBootstrapForm({ ...bootstrapForm, proposal_limit: e.target.value })} className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-cyan-500" />
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button type="button" disabled={previewingBootstrap} onClick={handleBootstrapPreview} className="px-4 py-2 bg-slate-700/80 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors">
              {previewingBootstrap ? 'Previewing...' : 'Preview Plan'}
            </button>
            <button type="submit" disabled={bootstrapping} className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors">
              {bootstrapping ? 'Bootstrapping...' : 'Bootstrap Study'}
            </button>
            <button type="button" onClick={() => setShowBootstrapForm(false)} className="px-4 py-2 text-slate-400 hover:text-white text-sm transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {lastBootstrapPreview && (
        <div className="glass-card p-4 mb-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium mb-1">Bootstrap Preview</div>
              <h3 className="text-white font-semibold">{lastBootstrapPreview.bootstrap_plan?.repo?.name || lastBootstrapPreview.study_profile?.label || 'Study Preview'}</h3>
              <p className="text-sm text-slate-400 mt-1">Profile: {lastBootstrapPreview.study_profile?.label || lastBootstrapPreview.study_profile?.id || 'Unknown'}</p>
            </div>
            <div className="text-xs text-slate-400 max-w-sm">
              {lastBootstrapPreview.profile_override?.exists
                ? `Override file detected at ${lastBootstrapPreview.profile_override.repo_path || lastBootstrapPreview.profile_override.path}`
                : `No repo-local override found. Suggested scaffold: ${lastBootstrapPreview.profile_override?.repo_path || 'docs/architecture/study-profile.override.json'}`}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
            <div className="rounded bg-slate-800/60 px-3 py-2">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">Tracked Files</div>
              <div className="text-slate-200">{lastBootstrapPreview.bootstrap_plan?.repo?.tracked_file_count ?? 0}</div>
            </div>
            <div className="rounded bg-slate-800/60 px-3 py-2">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">Initial Batches</div>
              <div className="text-slate-200">{lastBootstrapPreview.bootstrap_plan?.recommendations?.initial_run?.max_batches ?? 'n/a'}</div>
            </div>
            <div className="rounded bg-slate-800/60 px-3 py-2">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">Schedule</div>
              <div className="text-slate-200">{lastBootstrapPreview.schedule_preview?.name || 'Not planned'}</div>
            </div>
            <div className="rounded bg-slate-800/60 px-3 py-2">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">Proposals</div>
              <div className="text-slate-200">{lastBootstrapPreview.schedule_preview?.submit_proposals ? 'Enabled' : 'Off'}</div>
            </div>
          </div>
        </div>
      )}

      {lastBootstrapResult && (
        <div className="glass-card p-4 mb-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium mb-1">Latest Study Bootstrap</div>
              <h3 className="text-white font-semibold">{lastBootstrapResult.bootstrap_plan?.repo?.name || lastBootstrapResult.study_profile?.label || 'Study Bootstrap'}</h3>
              <p className="text-sm text-slate-400 mt-1">Profile: {lastBootstrapResult.study_profile?.label || lastBootstrapResult.study_profile?.id || 'Unknown'}</p>
            </div>
            {lastBootstrapResult.schedule?.schedule_id && (
              <button type="button" onClick={() => openDrawer(lastBootstrapResult.schedule.schedule_id)} className="px-3 py-1.5 rounded bg-cyan-600/20 text-cyan-300 hover:bg-cyan-600/40 text-sm transition-colors">
                Open Schedule
              </button>
            )}
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
            <div className="rounded bg-slate-800/60 px-3 py-2">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">Initial Run</div>
              <div className="text-slate-200">{lastBootstrapResult.initial_run?.task_status || lastBootstrapResult.initial_run?.reason || 'n/a'}</div>
            </div>
            <div className="rounded bg-slate-800/60 px-3 py-2">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">Pack Readiness</div>
              <div className="text-slate-200">{lastBootstrapResult.evaluation_grade || lastBootstrapResult.study_evaluation?.summary?.grade || 'n/a'} / {lastBootstrapResult.evaluation_readiness || lastBootstrapResult.study_evaluation?.summary?.readiness || 'n/a'}</div>
            </div>
            <div className="rounded bg-slate-800/60 px-3 py-2">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">Benchmark</div>
              <div className="text-slate-200">{lastBootstrapResult.benchmark_grade || lastBootstrapResult.study_benchmark?.summary?.grade || 'n/a'} ({lastBootstrapResult.benchmark_score ?? lastBootstrapResult.study_benchmark?.summary?.score ?? 0})</div>
            </div>
            <div className="rounded bg-slate-800/60 px-3 py-2">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">Schedule</div>
              <div className="text-slate-200">{lastBootstrapResult.schedule?.name || 'Not created'}</div>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="glass-card p-6 mb-6 space-y-4">
          <h3 className="text-lg font-semibold text-white mb-2">New Scheduled Task</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="schedule-name" className="block text-sm text-slate-400 mb-1">Name</label>
              <input id="schedule-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Nightly test run" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <p className="block text-sm text-slate-400 mb-1">Type</p>
              <div className="flex rounded-lg overflow-hidden border border-slate-700/50">
                <button type="button" onClick={() => setForm({ ...form, schedule_type: 'cron' })} className={`flex-1 px-4 py-2 text-sm transition-colors ${form.schedule_type === 'cron' ? 'bg-blue-600 text-white' : 'bg-slate-800/60 text-slate-400 hover:text-white'}`}>Cron</button>
                <button type="button" onClick={() => setForm({ ...form, schedule_type: 'once' })} className={`flex-1 px-4 py-2 text-sm transition-colors ${form.schedule_type === 'once' ? 'bg-blue-600 text-white' : 'bg-slate-800/60 text-slate-400 hover:text-white'}`}>One-Time</button>
              </div>
            </div>
            <div>
              <label htmlFor="schedule-execution-target" className="block text-sm text-slate-400 mb-1">Execution Target</label>
              <select
                id="schedule-execution-target"
                value={form.execution_target}
                onChange={(e) => setForm((prev) => ({
                  ...prev,
                  execution_target: e.target.value,
                  workflow_id: e.target.value === 'workflow' ? prev.workflow_id : '',
                  workflow_source_id: e.target.value === 'workflow_source' ? prev.workflow_source_id : '',
                  provider: e.target.value === 'task' ? prev.provider : '',
                  model: e.target.value === 'task' ? prev.model : '',
                }))}
                className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="task">Task Prompt</option>
                <option value="workflow">Existing Workflow</option>
                <option value="workflow_source">Clone Workflow Source</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {form.schedule_type === 'cron' ? (
              <div>
                <label htmlFor="schedule-cron-expression" className="block text-sm text-slate-400 mb-1">Cron Expression</label>
                <input id="schedule-cron-expression" type="text" value={form.cron_expression} onChange={(e) => setForm({ ...form, cron_expression: e.target.value })} placeholder="0 0 * * * (every midnight)" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500" />
              </div>
            ) : (
              <div>
                <label htmlFor="schedule-run-at" className="block text-sm text-slate-400 mb-1">Run At</label>
                <input id="schedule-run-at" type="datetime-local" value={form.run_at} onChange={(e) => setForm({ ...form, run_at: e.target.value })} min={new Date().toISOString().slice(0, 16)} className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500 [color-scheme:dark]" />
              </div>
            )}
          </div>
          {form.execution_target === 'workflow' && (
            <div>
              <label htmlFor="schedule-workflow-id" className="block text-sm text-slate-400 mb-1">Workflow ID</label>
              <input id="schedule-workflow-id" type="text" value={form.workflow_id} onChange={(e) => setForm({ ...form, workflow_id: e.target.value })} placeholder="e.g. b588fb4f-cece-44b4-8407-4cbaa18a524d" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500" />
            </div>
          )}
          {form.execution_target === 'workflow_source' && (
            <div>
              <label htmlFor="schedule-workflow-source-id" className="block text-sm text-slate-400 mb-1">Workflow Source ID</label>
              <input id="schedule-workflow-source-id" type="text" value={form.workflow_source_id} onChange={(e) => setForm({ ...form, workflow_source_id: e.target.value })} placeholder="e.g. b588fb4f-cece-44b4-8407-4cbaa18a524d" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500" />
            </div>
          )}
          <div>
            <label htmlFor="schedule-task-description" className="block text-sm text-slate-400 mb-1">{form.execution_target === 'task' ? 'Task Description' : 'Run Label (optional)'}</label>
            <textarea id="schedule-task-description" value={form.task_description} onChange={(e) => setForm({ ...form, task_description: e.target.value })} placeholder={form.execution_target === 'task' ? 'What should the task do?' : 'Optional label for the scheduled workflow run'} rows={3} className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-y" />
          </div>
          <div className={`grid grid-cols-1 ${form.execution_target === 'task' ? 'md:grid-cols-4' : 'md:grid-cols-2'} gap-4`}>
            {form.execution_target === 'task' && (
              <>
                <div>
                  <label htmlFor="schedule-provider" className="block text-sm text-slate-400 mb-1">Provider (optional)</label>
                  <select id="schedule-provider" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"><option value="">Auto</option><option value="codex">Codex</option><option value="claude-cli">Claude CLI</option><option value="ollama">Ollama</option></select>
                </div>
                <div>
                  <label htmlFor="schedule-model" className="block text-sm text-slate-400 mb-1">Model (optional)</label>
                  <input id="schedule-model" type="text" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="e.g. qwen3:8b" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500" />
                </div>
              </>
            )}
            <div>
              <label htmlFor="schedule-working-directory" className="block text-sm text-slate-400 mb-1">Working Directory (optional)</label>
              <input id="schedule-working-directory" type="text" value={form.working_directory} onChange={(e) => setForm({ ...form, working_directory: e.target.value })} placeholder="e.g. C:/Projects/MyApp" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label htmlFor="schedule-project" className="block text-sm text-slate-400 mb-1">Project (optional)</label>
              <input id="schedule-project" type="text" value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} placeholder="e.g. example-project-autodev" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500" />
            </div>
          </div>
          <div className="flex gap-3">
            <button type="submit" disabled={submitting} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg disabled:opacity-50 transition-colors">{submitting ? 'Creating...' : 'Create Schedule'}</button>
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors">Cancel</button>
          </div>
        </form>
      )}

      <div className="glass-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-700/50">
              <SortHeader column="name" label="Name" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <SortHeader column="cron_expression" label="Schedule" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <SortHeader column="next_run" label="Next Run" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <th scope="col" className="text-left p-4 heading-sm">Last Run</th>
              <SortHeader column="status" label="Status" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <th scope="col" className="text-left p-4 heading-sm">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.length === 0 ? (
              <tr><td colSpan={6} className="p-8 text-center text-slate-500">No scheduled tasks. Click "New Schedule" to create one.</td></tr>
            ) : (
              sortedItems.map((schedule) => {
                const isEnabled = schedule.enabled !== false && schedule.enabled !== 0;
                const schedType = schedule.schedule_type || 'cron';
                const isOnce = schedType === 'once';
                const isStudy = isStudySchedule(schedule);
                return (
                  <tr
                    key={schedule.id}
                    tabIndex={0}
                    role="button"
                    onClick={() => openDrawer(schedule.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openDrawer(schedule.id);
                      }
                    }}
                    className="border-b border-slate-700/30 hover:bg-slate-700/30 transition-colors cursor-pointer"
                  >
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <p className="text-white text-sm font-medium">{schedule.name}</p>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${isOnce ? 'bg-purple-600/20 text-purple-300' : 'bg-blue-600/20 text-blue-300'}`}>{isOnce ? 'One-time' : 'Recurring'}</span>
                        {isStudy && (
                          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-cyan-600/20 text-cyan-300">
                            Study
                          </span>
                        )}
                      </div>
                      <p className="text-slate-400 text-xs mt-0.5">
                        {isOnce ? (
                          <span className="text-purple-400">Fires: {formatDate(schedule.scheduled_time || schedule.next_run_at)}</span>
                        ) : (
                          <span className="text-blue-400">Next: {formatDate(schedule.next_run_at || schedule.next_run)}</span>
                        )}
                      </p>
                      <p className="text-slate-500 text-xs truncate max-w-xs mt-0.5" title={schedule.task_description}>{schedule.task_description?.substring(0, 60)}{schedule.task_description?.length > 60 ? '...' : ''}</p>
                      {isStudy && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <DeltaBadge level={schedule.delta_significance_level} score={schedule.delta_significance_score} />
                          <span className="text-[11px] text-slate-500">
                            {schedule.proposal_count ?? 0} proposals
                          </span>
                          <span className="text-[11px] text-slate-500">
                            {schedule.pending_count ?? 0} pending
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="p-4">
                      {isOnce ? (
                        <span className="text-sm text-purple-300">{formatDate(schedule.scheduled_time || schedule.next_run_at)}</span>
                      ) : (
                        <code className="text-sm text-blue-300 bg-blue-600/10 px-2 py-0.5 rounded">{schedule.cron_expression}</code>
                      )}
                    </td>
                    <td className="p-4 text-slate-300 text-sm">{formatDate(schedule.next_run_at || schedule.next_run)}</td>
                    <td className="p-4 text-slate-300 text-sm">{formatDate(schedule.last_run_at || schedule.last_run)}</td>
                    <td className="p-4"><StatusBadge enabled={isEnabled} /></td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRunNow(schedule.id);
                          }}
                          disabled={runningScheduleId === schedule.id}
                          className="text-xs px-3 py-1 rounded bg-blue-600/20 hover:bg-blue-600/40 text-blue-300 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {runningScheduleId === schedule.id ? 'Running...' : 'Run Now'}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleToggle(schedule.id, isEnabled); }} className={`text-xs px-3 py-1 rounded transition-colors ${isEnabled ? 'bg-slate-600/30 hover:bg-slate-600 text-slate-300 hover:text-white' : 'bg-green-600/30 hover:bg-green-600 text-green-300 hover:text-white'}`}>{isEnabled ? 'Disable' : 'Enable'}</button>
                        <button onClick={(e) => { e.stopPropagation(); handleDelete(schedule.id); }} className="text-xs px-3 py-1 rounded bg-red-600/30 hover:bg-red-600 text-red-300 hover:text-white transition-colors">Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={() => setShowConfirm(null)}>
          <div ref={confirmRef} className="bg-slate-800 border border-slate-700 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl" role="dialog" aria-modal="true" aria-label="Delete Schedule" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white font-semibold text-lg mb-2">Delete Schedule</h3>
            <p className="text-slate-300 text-sm mb-4">Delete this schedule? This action is irreversible.</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowConfirm(null)} className="px-4 py-2 text-sm text-slate-400 hover:text-white rounded-lg transition-colors">Cancel</button>
              <button onClick={confirmAction} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}

      {selectedScheduleId && (
        <ScheduleDetailDrawer
          scheduleId={selectedScheduleId}
          highlightedRunId={highlightedRunId}
          onClose={closeDrawer}
          onUpdated={refreshAfterDrawer}
        />
      )}
    </div>
  );
}