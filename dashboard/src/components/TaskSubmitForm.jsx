import { useState, useEffect, useCallback, useRef } from 'react';
import { tasks as tasksApi, providers as providersApi, hosts as hostsApi } from '../api';
import { useToast } from './Toast';
import ProjectSelector from './ProjectSelector';

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
const OLLAMA_PROVIDERS = new Set(['ollama']);

export default function TaskSubmitForm({ onClose, onSubmitted }) {
  const [task, setTask] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [provider, setProvider] = useState('auto');
  const [model, setModel] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [studyContextEnabled, setStudyContextEnabled] = useState(true);
  const [studyPreview, setStudyPreview] = useState(null);
  const [previewingStudy, setPreviewingStudy] = useState(false);
  const [studyPreviewError, setStudyPreviewError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [providerList, setProviderList] = useState([]);
  const [availableModels, setAvailableModels] = useState([]);
  const [ollamaModels, setOllamaModels] = useState([]);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const resolvedProject = newProjectName.trim() || selectedProject.trim();

  // Load providers on mount
  useEffect(() => {
    let cancelled = false;
    providersApi.list()
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : [];
        setProviderList(list);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load providers:', err);
        toastRef.current.error('Failed to load providers');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load Ollama host models on mount
  useEffect(() => {
    let cancelled = false;
    hostsApi.list()
      .then((data) => {
        if (cancelled) return;
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
        if (cancelled) return;
        console.error('Failed to load host models:', err);
        toastRef.current.error('Failed to load host models');
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  useEffect(() => {
    const trimmedWorkingDirectory = workingDirectory.trim();
    const trimmedTask = task.trim();
    if (!trimmedWorkingDirectory || !trimmedTask) {
      setStudyPreview(null);
      setStudyPreviewError('');
      setPreviewingStudy(false);
      return undefined;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      setPreviewingStudy(true);
      tasksApi.previewStudyContext({
        working_directory: trimmedWorkingDirectory,
        task: trimmedTask,
      }, { signal: controller.signal })
        .then((result) => {
          if (cancelled) return;
          setStudyPreview(result);
          setStudyPreviewError(result?.available ? '' : (result?.reason || 'No study context is available for this repository yet.'));
        })
        .catch((err) => {
          if (cancelled || err?.name === 'AbortError') return;
          setStudyPreview(null);
          setStudyPreviewError(err.message || 'Failed to preview study context');
        })
        .finally(() => {
          if (!cancelled) {
            setPreviewingStudy(false);
          }
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [task, workingDirectory]);

  const submitTask = useCallback(async (mode = 'single') => {
    if (!task.trim()) {
      toast.error('Task description is required');
      return;
    }
    if (!resolvedProject) {
      toast.error('Project is required');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        task: task.trim(),
        project: resolvedProject,
        study_context: studyContextEnabled,
      };
      if (provider !== 'auto') payload.provider = provider;
      if (model) payload.model = model;
      if (workingDirectory.trim()) payload.working_directory = workingDirectory.trim();
      if (mode === 'comparison') {
        if (!studyPreview?.available) {
          toast.error('A/B submit requires an available study context preview for this repository');
          return;
        }
        const withContext = await tasksApi.submit({
          ...payload,
          study_context: true,
        });
        const withoutContext = await tasksApi.submit({
          ...payload,
          study_context: false,
        });
        toast.success(
          `A/B pair submitted${withContext?.task_id && withoutContext?.task_id ? ` (${withContext.task_id.substring(0, 8)} / ${withoutContext.task_id.substring(0, 8)})` : ''}`
        );
      } else {
        const result = await tasksApi.submit(payload);
        toast.success(`Task submitted${result.task_id ? ` (${result.task_id.substring(0, 8)})` : ''}`);
      }
      setTask('');
      setSelectedProject('');
      setNewProjectName('');
      setProvider('auto');
      setModel('');
      setWorkingDirectory('');
      setStudyContextEnabled(true);
      setStudyPreview(null);
      setStudyPreviewError('');
      onSubmitted?.();
      onClose?.();
    } catch (err) {
      toast.error(`${mode === 'comparison' ? 'A/B submit' : 'Submit'} failed: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  }, [task, resolvedProject, provider, model, workingDirectory, studyContextEnabled, studyPreview?.available, toast, onSubmitted, onClose]);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    await submitTask('single');
  }, [submitTask]);

  const previewSubsystems = Array.isArray(studyPreview?.study_context?.relevant_subsystems)
    ? studyPreview.study_context.relevant_subsystems
    : [];
  const previewFlows = Array.isArray(studyPreview?.study_context?.relevant_flows)
    ? studyPreview.study_context.relevant_flows
    : [];
  const previewTests = Array.isArray(studyPreview?.study_context?.representative_tests)
    ? studyPreview.study_context.representative_tests
    : [];
  const canSubmitComparisonPair = Boolean(studyPreview?.available && task.trim() && resolvedProject && !submitting);

  // Build provider options from the live list, falling back to a static list
  const providerOptions = providerList.length > 0
    ? providerList.map((p) => ({
      value: p.provider,
      label: p.provider,
      enabled: p.enabled,
    }))
    : [
      'codex', 'claude-cli', 'ollama',
      'anthropic', 'groq', 'deepinfra', 'hyperbolic',
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor="task-project-selector" className="block text-sm text-slate-400 mb-1">
            Project <span className="text-red-400">*</span>
          </label>
          <ProjectSelector
            id="task-project-selector"
            aria-label="Project"
            value={selectedProject}
            onChange={(value) => {
              setSelectedProject(value || '');
              if (value) setNewProjectName('');
            }}
            placeholder="Select an existing project"
            className="w-full"
          />
          <p className="text-xs text-slate-500 mt-1">
            Choose a registered project or type a new one.
          </p>
        </div>

        <div>
          <label htmlFor="task-project-new" className="block text-sm text-slate-400 mb-1">
            New Project
          </label>
          <input
            id="task-project-new"
            type="text"
            value={newProjectName}
            onChange={(e) => {
              const nextValue = e.target.value;
              setNewProjectName(nextValue);
              if (nextValue.trim()) setSelectedProject('');
            }}
            placeholder="Type a new project name"
            className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-slate-500 mt-1">
            New projects auto-register after the first task submission.
          </p>
        </div>
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

      <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm text-slate-300 font-medium">Study Context</div>
            <p className="text-xs text-slate-500 mt-1">
              Attach a compact repo brief from the current knowledge pack, delta, and benchmark when study artifacts are available.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={studyContextEnabled}
              onChange={(e) => setStudyContextEnabled(e.target.checked)}
            />
            Attach study context
          </label>
        </div>

        {!workingDirectory.trim() || !task.trim() ? (
          <p className="text-xs text-slate-500">
            Set a working directory and describe the task to preview the study context that TORQUE will attach.
          </p>
        ) : previewingStudy ? (
          <p className="text-xs text-cyan-300">Refreshing study preview...</p>
        ) : studyPreview?.available ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="rounded bg-slate-900/60 px-3 py-2">
                <div className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">Repo</div>
                <div className="text-slate-200">{studyPreview.study_context?.repo_name || 'Unknown'}</div>
              </div>
              <div className="rounded bg-slate-900/60 px-3 py-2">
                <div className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">Pack Readiness</div>
                <div className="text-slate-200">
                  {studyPreview.study_context?.readiness || 'map_only'} / {studyPreview.study_context?.grade || 'n/a'}
                </div>
              </div>
            </div>

            {previewSubsystems.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Likely Subsystems</div>
                <div className="flex flex-wrap gap-1">
                  {previewSubsystems.slice(0, 3).map((item) => (
                    <span key={item.id} className="rounded bg-blue-600/20 px-2 py-0.5 text-xs text-blue-200">
                      {item.label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {previewFlows.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Likely Flows</div>
                <div className="flex flex-wrap gap-1">
                  {previewFlows.slice(0, 2).map((item) => (
                    <span key={item.id} className="rounded bg-cyan-600/20 px-2 py-0.5 text-xs text-cyan-200">
                      {item.label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {previewTests.length > 0 && (
              <div className="text-xs text-slate-400">
                Representative tests: {previewTests.slice(0, 2).map((item) => item.label).join(', ')}
              </div>
            )}

            <p className="text-xs text-slate-500">
              Use <span className="text-slate-300">Submit A/B Pair</span> to send the same task once with study context and once without, so the Study Impact panel can compare real outcomes.
            </p>
            {!studyContextEnabled && (
              <p className="text-xs text-amber-300">
                Study context is currently disabled for the normal submit path. The comparison submit will still send one task with context and one without.
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-amber-300">{studyPreviewError || 'No study context is available for this repository yet.'}</p>
        )}
      </div>

      {/* Submit buttons */}
      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={submitting || !task.trim() || !resolvedProject}
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
        <button
          type="button"
          disabled={!canSubmitComparisonPair}
          onClick={() => submitTask('comparison')}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Submit A/B Pair
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
