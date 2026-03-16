import { useState, useEffect, useCallback } from 'react';
import { schedules as schedulesApi } from '../api';
import { useToast } from '../components/Toast';
import StatCard from '../components/StatCard';

function StatusBadge({ enabled }) {
  return (
    <span className={`px-2 py-1 rounded-full text-[11px] font-medium text-white ${enabled ? 'bg-green-500' : 'bg-slate-500'}`}>
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleString('en-US');
  } catch {
    return dateStr;
  }
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
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', cron_expression: '', task_description: '', provider: '', model: '', working_directory: '' });
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

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
    const interval = setInterval(loadSchedules, 15000);
    return () => clearInterval(interval);
  }, [loadSchedules]);

  async function handleToggle(id, currentEnabled) {
    try {
      await schedulesApi.toggle(id, !currentEnabled);
      toast.success(`Schedule ${currentEnabled ? 'disabled' : 'enabled'}`);
      loadSchedules();
    } catch (err) {
      toast.error(`Toggle failed: ${err.message}`);
    }
  }

  async function handleDelete(id) {
    try {
      await schedulesApi.delete(id);
      toast.success('Schedule deleted');
      loadSchedules();
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.name || !form.cron_expression || !form.task_description) {
      toast.error('Name, cron expression, and task description are required');
      return;
    }
    setSubmitting(true);
    try {
      const payload = { ...form };
      // Strip empty optional fields
      Object.keys(payload).forEach((k) => { if (!payload[k]) delete payload[k]; });
      await schedulesApi.create(payload);
      toast.success('Schedule created');
      setForm({ name: '', cron_expression: '', task_description: '', provider: '', model: '', working_directory: '' });
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
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-slate-400">Loading...</p>
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

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <StatCard label="Total Schedules" value={totalCount} gradient="blue" />
        <StatCard label="Active" value={enabledCount} gradient="green" />
        <StatCard label="Disabled" value={totalCount - enabledCount} gradient="slate" />
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="glass-card p-6 mb-6 space-y-4">
          <h3 className="text-lg font-semibold text-white mb-2">New Scheduled Task</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Nightly test run"
                className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Cron Expression</label>
              <input
                type="text"
                value={form.cron_expression}
                onChange={(e) => setForm({ ...form, cron_expression: e.target.value })}
                placeholder="0 0 * * * (every midnight)"
                className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Task Description</label>
            <textarea
              value={form.task_description}
              onChange={(e) => setForm({ ...form, task_description: e.target.value })}
              placeholder="What should the task do?"
              rows={3}
              className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-y"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Provider (optional)</label>
              <select
                value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.target.value })}
                className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="">Auto</option>
                <option value="codex">Codex</option>
                <option value="claude-cli">Claude CLI</option>
                <option value="ollama">Ollama</option>
                <option value="aider-ollama">Aider Ollama</option>
                <option value="hashline-ollama">Hashline Ollama</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Model (optional)</label>
              <input
                type="text"
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="e.g. qwen3:8b"
                className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Working Directory (optional)</label>
              <input
                type="text"
                value={form.working_directory}
                onChange={(e) => setForm({ ...form, working_directory: e.target.value })}
                placeholder="e.g. C:/Projects/MyApp"
                className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Creating...' : 'Create Schedule'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Table */}
      <div className="glass-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-700/50">
              <th className="text-left p-4 heading-sm">Name</th>
              <th className="text-left p-4 heading-sm">Cron</th>
              <th className="text-left p-4 heading-sm">Next Run</th>
              <th className="text-left p-4 heading-sm">Last Run</th>
              <th className="text-left p-4 heading-sm">Status</th>
              <th className="text-left p-4 heading-sm">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-slate-500">
                  No scheduled tasks. Click "New Schedule" to create one.
                </td>
              </tr>
            ) : (
              items.map((schedule) => {
                const isEnabled = schedule.enabled !== false && schedule.enabled !== 0;
                return (
                  <tr key={schedule.id} className="border-b border-slate-700/30 hover:bg-slate-700/30 transition-colors">
                    <td className="p-4">
                      <p className="text-white text-sm font-medium">{schedule.name}</p>
                      <p className="text-slate-400 text-xs truncate max-w-xs" title={schedule.task_description}>
                        {schedule.task_description?.substring(0, 60)}{schedule.task_description?.length > 60 ? '...' : ''}
                      </p>
                    </td>
                    <td className="p-4">
                      <code className="text-sm text-blue-300 bg-blue-600/10 px-2 py-0.5 rounded">
                        {schedule.cron_expression}
                      </code>
                    </td>
                    <td className="p-4 text-slate-300 text-sm">{formatDate(schedule.next_run)}</td>
                    <td className="p-4 text-slate-300 text-sm">{formatDate(schedule.last_run)}</td>
                    <td className="p-4"><StatusBadge enabled={isEnabled} /></td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleToggle(schedule.id, isEnabled)}
                          className={`text-xs px-3 py-1 rounded transition-colors ${
                            isEnabled
                              ? 'bg-slate-600/30 hover:bg-slate-600 text-slate-300 hover:text-white'
                              : 'bg-green-600/30 hover:bg-green-600 text-green-300 hover:text-white'
                          }`}
                        >
                          {isEnabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={() => handleDelete(schedule.id)}
                          className="text-xs px-3 py-1 rounded bg-red-600/30 hover:bg-red-600 text-red-300 hover:text-white transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
