# Schedule Detail Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-side detail drawer to the Schedules dashboard view with inline-editable fields, backed by a new PUT endpoint for schedule updates.

**Architecture:** New `ScheduleDetailDrawer` component opened by clicking schedule rows. Backend adds PUT route + handler calling the existing `updateScheduledTask` (extended for run_at and partial task_config merge). Drawer state lives in Schedules.jsx, not App.jsx.

**Tech Stack:** React, date-fns, Node.js REST API, better-sqlite3

**Spec:** `docs/superpowers/specs/2026-04-01-schedule-detail-drawer-design.md`

---

## File Map

| File | Responsibility | Action |
|------|---------------|--------|
| `server/db/cron-scheduling.js` | Schedule CRUD + cron parsing | Modify: extend `updateScheduledTask` for run_at, task_description, partial task_config merge |
| `server/api/v2-governance-handlers.js` | REST handlers for schedules | Modify: add `handleUpdateSchedule` |
| `server/api/routes.js` | REST route definitions | Modify: add PUT route for schedules |
| `server/api-server.core.js` | Route handler lookup | Modify: register `handleV2CpUpdateSchedule` |
| `server/api/v2-dispatch.js` | V2 dispatch handler lookup | Modify: register `handleV2CpUpdateSchedule` |
| `dashboard/src/api.js` | Dashboard API client | Modify: add `schedules.get()` and `schedules.update()` |
| `dashboard/src/components/ScheduleDetailDrawer.jsx` | Schedule detail drawer component | Create: ~250 lines |
| `dashboard/src/views/Schedules.jsx` | Schedule list view | Modify: add selectedScheduleId state, row click, render drawer |

---

## Task 1: Extend `updateScheduledTask` for run_at and partial task_config merge

**Files:**
- Modify: `server/db/cron-scheduling.js:578-630`

- [ ] **Step 1: Read `updateScheduledTask`**

Read `server/db/cron-scheduling.js` lines 570-635 to see the current implementation.

- [ ] **Step 2: Add `run_at` handling**

In `server/db/cron-scheduling.js`, inside `updateScheduledTask`, after the `cron_expression` block (around line 607) and before the `task_config` block (around line 609), add:

```js
  if (updates.run_at !== undefined) {
    const runAt = new Date(updates.run_at);
    if (runAt.getTime() < Date.now() - 60000) {
      throw new Error('ONE_TIME_PAST: scheduled time must be in the future');
    }
    const runAtIso = runAt.toISOString();
    fields.push('scheduled_time = ?');
    params.push(runAtIso);
    fields.push('next_run_at = ?');
    params.push(runAtIso);
  }

  if (updates.task_description !== undefined) {
    fields.push('task_description = ?');
    params.push(updates.task_description);
  }
```

- [ ] **Step 3: Change task_config handling to support partial merge**

Replace the existing `task_config` block:

```js
  if (updates.task_config !== undefined) {
    fields.push('task_config = ?');
    params.push(JSON.stringify(updates.task_config));
  }
```

With:

```js
  if (updates.task_config !== undefined) {
    // Partial merge: merge caller's keys into existing task_config
    const existing = getScheduledTask(id);
    const merged = { ...(existing?.task_config || {}), ...updates.task_config };
    fields.push('task_config = ?');
    params.push(JSON.stringify(merged));
  }
```

- [ ] **Step 4: Commit**

```
git add server/db/cron-scheduling.js
git commit -m "feat: extend updateScheduledTask for run_at, task_description, partial task_config merge"
```

---

## Task 2: Add PUT REST Route and Handler

**Files:**
- Modify: `server/api/routes.js:455-463`
- Modify: `server/api/v2-governance-handlers.js:216-229`
- Modify: `server/api-server.core.js:207-209`
- Modify: `server/api/v2-dispatch.js:381-383`

- [ ] **Step 1: Add PUT route**

In `server/api/routes.js`, after the DELETE route for schedules (after line 463) and before the `// Policies` comment (line 465), insert:

```js
  {
    method: 'PUT',
    path: /^\/api\/v2\/schedules\/([^/]+)$/,
    handlerName: 'handleV2CpUpdateSchedule',
    mapParams: ['schedule_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('schedule_id', 'schedule id'),
    }),
  },
```

- [ ] **Step 2: Add handler in v2-governance-handlers.js**

In `server/api/v2-governance-handlers.js`, after `handleDeleteSchedule` (around line 229) and before the `// ─── Policies` section, add:

```js
async function handleUpdateSchedule(req, res) {
  const requestId = resolveRequestId(req);
  const scheduleId = req.params?.schedule_id;
  const body = req.body || await parseBody(req);

  try {
    const existing = schedulingAutomation.getScheduledTask(scheduleId);
    if (!existing) {
      return sendError(res, requestId, 'schedule_not_found', `Schedule not found: ${scheduleId}`, 404, {}, req);
    }

    const updates = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.timezone !== undefined) updates.timezone = body.timezone;
    if (body.task_description !== undefined) updates.task_description = body.task_description;

    // Cron-specific
    if (body.cron_expression !== undefined) updates.cron_expression = body.cron_expression;

    // One-time-specific
    if (body.run_at !== undefined) updates.run_at = body.run_at;

    // Partial task_config merge for provider/model/working_directory
    const configUpdates = {};
    if (body.provider !== undefined) configUpdates.provider = body.provider || null;
    if (body.model !== undefined) configUpdates.model = body.model || null;
    if (body.working_directory !== undefined) configUpdates.working_directory = body.working_directory || null;
    if (body.task !== undefined) configUpdates.task = body.task;
    if (body.workflow_id !== undefined) configUpdates.workflow_id = body.workflow_id || null;
    if (Object.keys(configUpdates).length > 0) {
      updates.task_config = configUpdates;
    }

    if (body.enabled !== undefined) updates.enabled = body.enabled;

    const result = schedulingAutomation.updateScheduledTask(scheduleId, updates);
    if (!result) {
      return sendError(res, requestId, 'operation_failed', 'No fields to update', 400, {}, req);
    }

    sendSuccess(res, requestId, result, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}
```

- [ ] **Step 3: Register handler in exports**

In `server/api/v2-governance-handlers.js`, add `handleUpdateSchedule` to both `createV2GovernanceHandlers` return (around line 1238, after `handleDeleteSchedule`) and `module.exports` (around line 1260, after `handleDeleteSchedule`).

- [ ] **Step 4: Register in route handler lookups**

In `server/api-server.core.js`, after the `handleV2CpDeleteSchedule` line (line 209), add:

```js
  handleV2CpUpdateSchedule: v2GovernanceHandlers.handleUpdateSchedule,
```

In `server/api/v2-dispatch.js`, after the `handleV2CpDeleteSchedule` line (line 383), add:

```js
  handleV2CpUpdateSchedule: v2GovernanceHandlers.handleUpdateSchedule,
```

- [ ] **Step 5: Commit**

```
git add server/api/routes.js server/api/v2-governance-handlers.js server/api-server.core.js server/api/v2-dispatch.js
git commit -m "feat: add PUT /api/v2/schedules/:id route and handler"
```

---

## Task 3: Add Dashboard API Methods

**Files:**
- Modify: `dashboard/src/api.js:365-378`

- [ ] **Step 1: Add get and update methods**

In `dashboard/src/api.js`, inside the `schedules` object (after the `delete` method on line 377), add:

```js
  get: (id) => requestV2(`/schedules/${id}`),
  update: (id, data) => requestV2(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
```

The full schedules object should now be:

```js
export const schedules = {
  list: () => requestV2('/schedules').then((d) => {
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.items)) return d.items;
    if (Array.isArray(d?.schedules)) return d.schedules;
    return [];
  }),
  create: (data) => requestV2('/schedules', { method: 'POST', body: JSON.stringify(data) }),
  toggle: (id, enabled) => requestV2(`/schedules/${id}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  }),
  delete: (id) => requestV2(`/schedules/${id}`, { method: 'DELETE' }),
  get: (id) => requestV2(`/schedules/${id}`),
  update: (id, data) => requestV2(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
};
```

- [ ] **Step 2: Commit**

```
git add dashboard/src/api.js
git commit -m "feat: add schedules.get and schedules.update API methods"
```

---

## Task 4: Create ScheduleDetailDrawer Component

**Files:**
- Create: `dashboard/src/components/ScheduleDetailDrawer.jsx`

- [ ] **Step 1: Create the component**

Create `dashboard/src/components/ScheduleDetailDrawer.jsx` with the full implementation. The component:

- Accepts props: `scheduleId`, `onClose`, `onUpdated`
- Fetches schedule data via `schedules.get(scheduleId)` on mount/id change
- Renders a right-side slide-in drawer (fixed position, right:0)
- Has a semi-transparent backdrop that closes drawer on click
- Escape key closes drawer (when not editing a field)
- Sections: Header, Schedule, Execution, Task Description, Info, Actions
- Inline editable fields use an `EditableField` sub-component
- Save on blur/Enter via `schedules.update(id, { field: value })`
- Optimistic UI: update local state, revert on error
- Countdown timer for one-time schedules (updates every 60s)
- Enable/Disable button calls `schedules.toggle(id, !enabled)`
- Delete button with confirmation calls `schedules.delete(id)`

```jsx
import { useState, useEffect, useCallback, useRef } from 'react';
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

export default function ScheduleDetailDrawer({ scheduleId, onClose, onUpdated }) {
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
}
```

- [ ] **Step 2: Commit**

```
git add dashboard/src/components/ScheduleDetailDrawer.jsx
git commit -m "feat: create ScheduleDetailDrawer component with inline editing"
```

---

## Task 5: Wire Drawer into Schedules.jsx

**Files:**
- Modify: `dashboard/src/views/Schedules.jsx`

- [ ] **Step 1: Read current Schedules.jsx**

Read `dashboard/src/views/Schedules.jsx` (full file, ~370 lines after previous changes).

- [ ] **Step 2: Add import and state**

At the top of `dashboard/src/views/Schedules.jsx`, add the import after the existing imports:

```jsx
import ScheduleDetailDrawer from '../components/ScheduleDetailDrawer';
```

Inside the `Schedules` function, after the `submitting` state line (around line 48), add:

```jsx
  const [selectedScheduleId, setSelectedScheduleId] = useState(null);
```

- [ ] **Step 3: Add row click handler**

Find each `<tr key={schedule.id}` row element in the table body. Add an `onClick` handler and `cursor-pointer` class:

Change:
```jsx
<tr key={schedule.id} className="border-b border-slate-700/30 hover:bg-slate-700/30 transition-colors">
```

To:
```jsx
<tr key={schedule.id} onClick={() => setSelectedScheduleId(schedule.id)} className="border-b border-slate-700/30 hover:bg-slate-700/30 transition-colors cursor-pointer">
```

- [ ] **Step 4: Add stopPropagation to action buttons**

Find the toggle and delete buttons inside each row. Wrap their onClick handlers with `e.stopPropagation()`:

Change toggle button:
```jsx
onClick={() => handleToggle(schedule.id, isEnabled)}
```

To:
```jsx
onClick={(e) => { e.stopPropagation(); handleToggle(schedule.id, isEnabled); }}
```

Change delete button:
```jsx
onClick={() => handleDelete(schedule.id)}
```

To:
```jsx
onClick={(e) => { e.stopPropagation(); handleDelete(schedule.id); }}
```

- [ ] **Step 5: Render the drawer**

At the end of the component's JSX, just before the final closing `</div>`, add:

```jsx
      {selectedScheduleId && (
        <ScheduleDetailDrawer
          scheduleId={selectedScheduleId}
          onClose={() => setSelectedScheduleId(null)}
          onUpdated={loadSchedules}
        />
      )}
```

- [ ] **Step 6: Verify dashboard builds**

Run: `cd dashboard && npm run build 2>&1 | tail -10`

Expected: Build succeeds.

- [ ] **Step 7: Commit**

```
git add dashboard/src/views/Schedules.jsx
git commit -m "feat: wire ScheduleDetailDrawer into Schedules view"
```

---

## Task 6: Run Full Test Suite

- [ ] **Step 1: Run server tests**

```
npx vitest run server/tests/handler-adv-scheduling.test.js server/tests/task-operations-handlers.test.js server/tests/maintenance-scheduler.test.js --reporter=verbose 2>&1 | tail -20
```

Expected: All tests pass.

- [ ] **Step 2: Run dashboard build**

```
cd dashboard && npm run build 2>&1 | tail -10
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Fix regressions if any, commit**

Only if needed:
```
git add -A
git commit -m "fix: address regressions from schedule detail drawer"
```
