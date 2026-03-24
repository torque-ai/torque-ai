import { useState, useEffect, useCallback, useRef } from 'react';
import { tasks as tasksApi, providers as providersApi, hosts as hostsApi } from '../api';
import { useToast } from './Toast';

/**
 * Known models for cloud/API providers that don't expose a model list via hosts.
 */
const PROVIDER_KNOWN_MODELS = {
  codex: ['gpt-5.3-codex-spark'],
  'claude-cli': ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
  groq: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
  deepinfra: [
    'Qwen/Qwen2.5-72B-Instruct',
    'meta-llama/Llama-3.1-70B-Instruct',
    'meta-llama/Llama-3.1-405B-Instruct',
    'deepseek-ai/DeepSeek-R1',
  ],
  hyperbolic: [
    'Qwen/Qwen2.5-72B-Instruct',
    'meta-llama/Llama-3.1-70B-Instruct',
    'meta-llama/Llama-3.1-405B-Instruct',
    'deepseek-ai/DeepSeek-R1',
  ],
};

/** Providers that use Ollama hosts and pull models from the hosts list */
const OLLAMA_PROVIDERS = new Set(['ollama', 'hashline-ollama']);

export default function TaskSubmitForm({ onClose, onSubmitted }) {
  const [task, setTask] = useState('');
  const [provider, setProvider] = useState('auto');
  const [model, setModel] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [providerList, setProviderList] = useState([]);
  const [availableModels, setAvailableModels] = useState([]);
  const [ollamaModels, setOllamaModels] = useState([]);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Load providers on mount
  useEffect(() => {
    providersApi.list()
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setProviderList(list);
      })
      .catch((err) => {
        console.error('Failed to load providers:', err);
        toastRef.current.error('Failed to load providers');
      });
  }, []);

  // Load Ollama host models on mount
  useEffect(() => {
    hostsApi.list()
      .then((data) => {
        const hostList = Array.isArray(data) ? data : [];
        // Collect all unique model names across enabled hosts
        const models = new Set();
        for (const host of hostList) {
          if (host.enabled && Array.isArray(host.models)) {
            for (const m of host.models) {
              models.add(typeof m === 'string' ? m : m.name || m.model || '');
            }
          }
        }
        setOllamaModels([...models].filter(Boolean).sort());
      })
      .catch((err) => {
        console.error('Failed to load host models:', err);
        toast.error('Failed to load host models');
      });
  }, [toast]);

  // Update available models when provider changes
  useEffect(() => {
    if (provider === 'auto') {
      setAvailableModels([]);
      setModel('');
      return;
    }

    if (OLLAMA_PROVIDERS.has(provider)) {
      setAvailableModels(ollamaModels);
    } else if (PROVIDER_KNOWN_MODELS[provider]) {
      setAvailableModels(PROVIDER_KNOWN_MODELS[provider]);
    } else {
      setAvailableModels([]);
    }
    setModel('');
  }, [provider, ollamaModels]);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!task.trim()) {
      toast.error('Task description is required');
      return;
    }

    setSubmitting(true);
    try {
      const payload = { task: task.trim() };
      if (provider !== 'auto') payload.provider = provider;
      if (model) payload.model = model;
      if (workingDirectory.trim()) payload.working_directory = workingDirectory.trim();

      const result = await tasksApi.submit(payload);
      toast.success(`Task submitted${result.task_id ? ` (${result.task_id.substring(0, 8)})` : ''}`);
      setTask('');
      setProvider('auto');
      setModel('');
      setWorkingDirectory('');
      onSubmitted?.();
      onClose?.();
    } catch (err) {
      toast.error(`Submit failed: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  }, [task, provider, model, workingDirectory, toast, onSubmitted, onClose]);

  // Build provider options from the live list, falling back to a static list
  const providerOptions = providerList.length > 0
    ? providerList.map((p) => ({
      value: p.provider,
      label: p.provider,
      enabled: p.enabled,
    }))
    : [
      'codex', 'claude-cli', 'ollama', 'hashline-ollama',
      'hashline-openai', 'anthropic', 'groq', 'deepinfra', 'hyperbolic',
    ].map((p) => ({ value: p, label: p, enabled: true }));

  return (
    <form onSubmit={handleSubmit} className="glass-card p-6 mb-6 space-y-4" data-testid="task-submit-form">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold text-white">Submit Task</h3>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
            aria-label="Close submit form"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Task description */}
      <div>
        <label htmlFor="task-description" className="block text-sm text-slate-400 mb-1">
          Task Description <span className="text-red-400">*</span>
        </label>
        <textarea
          id="task-description"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Describe what the task should do. Be specific with file paths and concrete instructions for best results."
          rows={4}
          className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-y"
          required
        />
        <p className="text-xs text-slate-500 mt-1">{task.length} characters</p>
      </div>

      {/* Provider + Model + Working Directory row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label htmlFor="task-provider" className="block text-sm text-slate-400 mb-1">Provider</label>
          <select
            id="task-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="auto">Auto (smart routing)</option>
            {providerOptions.map((p) => (
              <option key={p.value} value={p.value} disabled={!p.enabled}>
                {p.label}{!p.enabled ? ' (disabled)' : ''}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1">
            {provider === 'auto' ? 'Automatically selects the best provider' : `Using ${provider}`}
          </p>
        </div>

        <div>
          <label htmlFor="task-model" className="block text-sm text-slate-400 mb-1">Model</label>
          {availableModels.length > 0 ? (
            <select
              id="task-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              disabled={provider === 'auto'}
            >
              <option value="">Default</option>
              {availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <input
              id="task-model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={provider === 'auto' ? 'Auto-selected' : 'e.g. qwen2.5-coder:32b'}
              disabled={provider === 'auto'}
              className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
          )}
          <p className="text-xs text-slate-500 mt-1">
            {provider === 'auto' ? 'Model chosen by smart routing' : 'Leave empty for provider default'}
          </p>
        </div>

        <div>
          <label htmlFor="task-working-dir" className="block text-sm text-slate-400 mb-1">Working Directory</label>
          <input
            id="task-working-dir"
            type="text"
            value={workingDirectory}
            onChange={(e) => setWorkingDirectory(e.target.value)}
            placeholder="e.g. C:/Projects/MyApp"
            className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-slate-500 mt-1">
            Optional project path for the task
          </p>
        </div>
      </div>

      {/* Submit buttons */}
      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={submitting || !task.trim()}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
        >
          {submitting ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Submitting...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Submit Task
            </>
          )}
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
