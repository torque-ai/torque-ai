import { useEffect, useState } from 'react';
import { workflowSpecs } from '../api';

function getTaskCountLabel(count) {
  const taskCount = Number.isFinite(Number(count)) ? Number(count) : 0;
  return `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;
}

export default function WorkflowSpecs() {
  const [specs, setSpecs] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState({});
  const [message, setMessage] = useState(null);

  async function load() {
    try {
      const res = await workflowSpecs.list();
      setSpecs(Array.isArray(res) ? res : res?.specs || []);
      setError(null);
    } catch (err) {
      setError(err?.message || 'Failed to load specs');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleRun(spec) {
    setRunning((current) => ({ ...current, [spec.relative_path]: true }));
    setMessage(null);

    try {
      const res = await workflowSpecs.run(spec.relative_path, {});
      setMessage({ type: 'success', text: `Workflow created: ${res?.workflow_id || 'unknown'}` });
    } catch (err) {
      setMessage({ type: 'error', text: `Failed: ${err?.message || 'Unable to run workflow spec'}` });
    } finally {
      setRunning((current) => ({ ...current, [spec.relative_path]: false }));
    }
  }

  if (error) {
    return <div className="p-4 text-red-400">Error: {error}</div>;
  }

  if (specs === null) {
    return <div className="p-4 text-slate-400">Loading...</div>;
  }

  if (specs.length === 0) {
    return (
      <div className="p-4 text-slate-400">
        <h1 className="text-xl text-white mb-2">Workflow Specs</h1>
        <p>
          No workflow specs found in <code>workflows/</code>. Create a YAML file there to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <h1 className="text-xl text-white mb-4">Workflow Specs</h1>

      {message && (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
            message.type === 'error'
              ? 'border-red-600/40 bg-red-900/20 text-red-200'
              : 'border-green-600/40 bg-green-900/20 text-green-200'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="space-y-3">
        {specs.map((spec) => (
          <div
            key={spec.relative_path}
            className={`border rounded-lg p-3 ${
              spec.valid
                ? 'border-slate-600/40 bg-slate-700/30'
                : 'border-red-600/40 bg-red-900/10'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="text-white font-semibold">{spec.name}</h2>
                <code className="block text-xs text-slate-500 break-all">{spec.relative_path}</code>
                {spec.description && (
                  <p className="text-sm text-slate-300 mt-1">{spec.description}</p>
                )}
                {spec.valid ? (
                  <p className="text-xs text-slate-400 mt-1">{getTaskCountLabel(spec.task_count)}</p>
                ) : (
                  <ul className="text-xs text-red-300 mt-1 list-disc list-inside">
                    {(spec.errors || ['Invalid workflow spec']).map((specError, index) => (
                      <li key={`${spec.relative_path}-${index}`}>{specError}</li>
                    ))}
                  </ul>
                )}
              </div>

              {spec.valid && (
                <button
                  type="button"
                  onClick={() => handleRun(spec)}
                  disabled={running[spec.relative_path]}
                  className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white text-sm rounded"
                >
                  {running[spec.relative_path] ? 'Running...' : 'Run'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
