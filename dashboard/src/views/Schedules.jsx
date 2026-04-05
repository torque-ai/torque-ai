import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { schedules as schedulesApi } from '../api';
import { useToast } from '../components/Toast';
import StatCard from '../components/StatCard';
import { formatDate } from '../utils/formatters';
import LoadingSkeleton from '../components/LoadingSkeleton';
import ScheduleDetailDrawer from '../components/ScheduleDetailDrawer';

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

export default function Schedules() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [showForm, setShowForm] = useState(false);
  const [showConfirm, setShowConfirm] = useState(null);
  const confirmRef = useRef(null);
  const [form, setForm] = useState({ name: '', schedule_type: 'cron', cron_expression: '', run_at: '', task_description: '', provider: '', model: '', working_directory: '' });
  const [submitting, setSubmitting] = useState(false);
  const [selectedScheduleId, setSelectedScheduleId] = useState(null);
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

  const closeDrawer = useCallback(() => setSelectedScheduleId(null), []);
  const refreshAfterDrawer = useCallback(() => loadSchedules(), [loadSchedules]);

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
      loadSchedules();
    } catch (err) {
      toast.error(`Toggle failed: ${err.message}`);
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
    if (!form.name || !form.task_description) {
      toast.error('Name and task description are required');
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
    setSubmitting(true);
    try {
      const payload = {
        name: form.name,
        task_description: form.task_description,
        schedule_type: form.schedule_type,
        provider: form.provider || undefined,
        model: form.model || undefined,
        working_directory: form.working_directory || undefined,
      };
      if (form.schedule_type === 'cron') {
        payload.cron_expression = form.cron_expression;
      } else {
        payload.run_at = new Date(form.run_at).toISOString();
      }
      Object.keys(payload).forEach((k) => { if (payload[k] === undefined) delete payload[k]; });
      await schedulesApi.create(payload);
      toast.success('Schedule created');
      setForm({ name: '', schedule_type: 'cron', cron_expression: '', run_at: '', task_description: '', provider: '', model: '', working_directory: '' });
      setShowForm(false);
      loadSchedules();
    } catch (err) {
      toast.error(`Create failed: ${err.message}`);
    } finally {
      setSubmitting(false);
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <StatCard label="Total Schedules" value={totalCount} gradient="blue" />
        <StatCard label="Active" value={enabledCount} gradient="green" />
        <StatCard label="Disabled" value={totalCount - enabledCount} gradient="blue" />
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="glass-card p-6 mb-6 space-y-4">
          <h3 className="text-lg font-semibold text-white mb-2">New Scheduled Task</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
          <div>
            <label htmlFor="schedule-task-description" className="block text-sm text-slate-400 mb-1">Task Description</label>
            <textarea id="schedule-task-description" value={form.task_description} onChange={(e) => setForm({ ...form, task_description: e.target.value })} placeholder="What should the task do?" rows={3} className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-y" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="schedule-provider" className="block text-sm text-slate-400 mb-1">Provider (optional)</label>
              <select id="schedule-provider" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"><option value="">Auto</option><option value="codex">Codex</option><option value="claude-cli">Claude CLI</option><option value="ollama">Ollama</option></select>
            </div>
            <div>
              <label htmlFor="schedule-model" className="block text-sm text-slate-400 mb-1">Model (optional)</label>
              <input id="schedule-model" type="text" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="e.g. qwen3:8b" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label htmlFor="schedule-working-directory" className="block text-sm text-slate-400 mb-1">Working Directory (optional)</label>
              <input id="schedule-working-directory" type="text" value={form.working_directory} onChange={(e) => setForm({ ...form, working_directory: e.target.value })} placeholder="e.g. C:/Projects/MyApp" className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500" />
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
                return (
                  <tr key={schedule.id} onClick={() => setSelectedScheduleId(schedule.id)} className="border-b border-slate-700/30 hover:bg-slate-700/30 transition-colors cursor-pointer">
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <p className="text-white text-sm font-medium">{schedule.name}</p>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${isOnce ? 'bg-purple-600/20 text-purple-300' : 'bg-blue-600/20 text-blue-300'}`}>{isOnce ? 'One-time' : 'Recurring'}</span>
                      </div>
                      <p className="text-slate-400 text-xs mt-0.5">
                        {isOnce ? (
                          <span className="text-purple-400">Fires: {formatDate(schedule.scheduled_time || schedule.next_run_at)}</span>
                        ) : (
                          <span className="text-blue-400">Next: {formatDate(schedule.next_run_at || schedule.next_run)}</span>
                        )}
                      </p>
                      <p className="text-slate-500 text-xs truncate max-w-xs mt-0.5" title={schedule.task_description}>{schedule.task_description?.substring(0, 60)}{schedule.task_description?.length > 60 ? '...' : ''}</p>
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
          <div ref={confirmRef} className="bg-slate-800 border border-slate-700 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
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
          onClose={closeDrawer}
          onUpdated={refreshAfterDrawer}
        />
      )}
    </div>
  );
}
