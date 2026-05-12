import { remoteConfigFormToPayload } from '../utils/remoteHostLocalConfigForm';

export default function RemoteHostLocalConfigPanel({
  config,
  form,
  onChange,
  onSave,
  onClear,
  onTest,
  saving,
  clearing,
  testing,
  testResult,
  loading,
}) {
  const hasStoredKeyPath = Boolean(config?.has_key_path);
  const canSubmit = Boolean(
    form.host.trim() &&
    form.user.trim() &&
    (form.key_path.trim() || hasStoredKeyPath)
  );
  const keyPathPlaceholder = hasStoredKeyPath
    ? 'Stored key path; leave blank to keep'
    : 'C:\\Users\\you\\.ssh\\id_ed25519_torque_remote';
  const testProbe = testResult?.probe || null;
  const canTest = Boolean(config?.exists && config?.valid !== false && !loading && !saving && !clearing);

  function updateField(field, value) {
    onChange({ ...form, [field]: value });
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmit || saving) return;
    onSave(remoteConfigFormToPayload(form));
  }

  return (
    <form onSubmit={handleSubmit} className="glass-card p-5 mb-6 border border-slate-700/80">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-white">Remote Execution Host</h3>
          <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
            <span className={`px-2 py-1 rounded-md ${config?.exists ? 'bg-green-600/20 text-green-300' : 'bg-slate-700 text-slate-300'}`}>
              {config?.exists ? 'Configured' : 'Not configured'}
            </span>
            <span className={`px-2 py-1 rounded-md ${config?.git_ignored === true ? 'bg-green-600/20 text-green-300' : 'bg-red-600/20 text-red-300'}`}>
              {config?.git_ignored === true ? 'Git ignored' : 'Git ignore unknown'}
            </span>
            <span className="px-2 py-1 rounded-md bg-slate-800 text-slate-300">
              {hasStoredKeyPath
                ? `Key saved${config?.key_path_hint ? `: ${config.key_path_hint}` : ''}`
                : 'No key saved'}
            </span>
          </div>
        </div>
        <code className="text-[11px] text-slate-400 bg-slate-900/70 border border-slate-700 rounded-md px-2 py-1 break-all">
          {config?.path || 'infrastructure/hosts/torque-remote.local.json'}
        </code>
      </div>

      {config?.valid === false && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-sm text-red-200">
          Invalid local config: {config.error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <div>
          <label htmlFor="remote-host-local-host" className="text-xs text-slate-400 block mb-1">Remote host *</label>
          <input
            id="remote-host-local-host"
            value={form.host}
            onChange={(event) => updateField('host', event.target.value)}
            placeholder="192.0.2.10"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="remote-host-local-user" className="text-xs text-slate-400 block mb-1">SSH user *</label>
          <input
            id="remote-host-local-user"
            value={form.user}
            onChange={(event) => updateField('user', event.target.value)}
            placeholder="remote-user"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="remote-host-local-key-path" className="text-xs text-slate-400 block mb-1">SSH key path</label>
          <input
            id="remote-host-local-key-path"
            value={form.key_path}
            onChange={(event) => updateField('key_path', event.target.value)}
            placeholder={keyPathPlaceholder}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="remote-host-local-project" className="text-xs text-slate-400 block mb-1">Remote project path</label>
          <input
            id="remote-host-local-project"
            value={form.remote_project_path}
            onChange={(event) => updateField('remote_project_path', event.target.value)}
            placeholder="C:\\trt\\torque-public"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="remote-host-local-worktree-root" className="text-xs text-slate-400 block mb-1">Remote worktree root</label>
          <input
            id="remote-host-local-worktree-root"
            value={form.remote_test_worktree_root}
            onChange={(event) => updateField('remote_test_worktree_root', event.target.value)}
            placeholder="C:\\trt"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="remote-host-local-worktree-subdir" className="text-xs text-slate-400 block mb-1">Worktree subdir</label>
            <input
              id="remote-host-local-worktree-subdir"
              value={form.remote_test_worktree_subdir}
              onChange={(event) => updateField('remote_test_worktree_subdir', event.target.value)}
              placeholder=".remote"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="remote-host-local-lanes" className="text-xs text-slate-400 block mb-1">Lanes</label>
            <input
              id="remote-host-local-lanes"
              type="number"
              min={1}
              value={form.lane_count}
              onChange={(event) => updateField('lane_count', event.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button
          type="button"
          onClick={onClear}
          disabled={loading || clearing || !config?.exists}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg disabled:opacity-50 transition-colors"
        >
          {clearing ? 'Clearing...' : 'Clear Remote Host'}
        </button>
        <button
          type="button"
          onClick={onTest}
          disabled={!canTest || testing}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm rounded-lg disabled:opacity-50 transition-colors"
        >
          {testing ? 'Testing...' : 'Test Remote Host'}
        </button>
        <button
          type="submit"
          disabled={loading || saving || !canSubmit}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : 'Save Remote Host'}
        </button>
      </div>

      {testProbe && (
        <div className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
          testProbe.available
            ? 'border-green-500/30 bg-green-950/30 text-green-200'
            : 'border-red-500/30 bg-red-950/30 text-red-200'
        }`}>
          <span className="font-medium">
            {testProbe.available ? 'Reachable' : 'Unavailable'}
          </span>
          <span className="text-slate-300"> - {testProbe.message}</span>
          {Number.isFinite(testProbe.elapsed_ms) && (
            <span className="text-slate-400"> ({testProbe.elapsed_ms}ms)</span>
          )}
        </div>
      )}
    </form>
  );
}
