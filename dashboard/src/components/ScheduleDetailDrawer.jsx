import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { schedules as schedulesApi } from '../api';
import { useToast } from './Toast';
import { format } from 'date-fns';

function formatTime(iso) {
  if (!iso) return '-';
  try { return format(new Date(iso), 'MMM d, yyyy HH:mm:ss'); }
  catch { return String(iso); }
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

function EditableField({ value, onSave, type = 'text', options, placeholder, multiline, className = '' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const inputRef = useRef(null);

  useEffect(() => { setDraft(value ?? ''); }, [value]);
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

export default memo(function ScheduleDetailDrawer({ scheduleId, onClose, onUpdated }) {
  const [schedule, setSchedule] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [, setTick] = useState(0);
  const toast = useToast();

  const load = useCallback(async () => {
    if (!scheduleId) return;
    try {
      const data = await schedulesApi.get(scheduleId);
      const s = data?.data || data;
      setSchedule(s);
    } catch (err) {
      toast.error('Failed to load schedule');
      onClose();
    } finally {
      setLoading(false);
    }
  }, [scheduleId, toast, onClose]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  // Countdown ticker for one-time schedules
  useEffect(() => {
    if (schedule?.schedule_type !== 'once') return undefined;
    const interval = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, [schedule?.schedule_type]);

  // Escape to close (when not editing)
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape' && !e.target.closest('input, textarea, select')) onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  async function saveField(field, value) {
    const prev = { ...schedule };
    // Optimistic update
    if (['provider', 'model', 'working_directory', 'task'].includes(field)) {
      setSchedule((s) => ({ ...s, task_config: { ...s.task_config, [field]: value } }));
    } else {
      setSchedule((s) => ({ ...s, [field]: value }));
    }
    try {
      await schedulesApi.update(scheduleId, { [field]: value });
      toast.success('Schedule updated');
      onUpdated?.();
    } catch (err) {
      setSchedule(prev);
      if (err.message?.includes('not found') || err.status === 404) {
        toast.error('Schedule has already fired');
        onClose();
      } else {
        toast.error(`Update failed: ${err.message}`);
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

  if (!scheduleId) return null;

  const isOnce = schedule?.schedule_type === 'once';
  const borderColor = isOnce ? 'border-purple-500' : 'border-blue-500';

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      {/* Drawer */}
      <div className={`fixed top-0 right-0 h-full w-[400px] bg-slate-900 border-l-2 ${borderColor} z-50 overflow-y-auto shadow-2xl`}>
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
                  <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                    schedule.enabled ? 'bg-green-600/20 text-green-300' : 'bg-slate-600/20 text-slate-400'
                  }`}>
                    {schedule.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              </div>
              <button onClick={onClose} className="text-slate-500 hover:text-white text-xl p-1 transition-colors">&times;</button>
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

            {/* Actions */}
            <div className="flex gap-2 pt-2">
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
