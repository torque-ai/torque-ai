import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { budget as budgetApi, request, routingTemplates } from '../api';
import { useToast } from '../components/Toast';
import LoadingSkeleton from '../components/LoadingSkeleton';

const DEFAULT_FORM_STATE = {
  provider: '',
  model: '',
  verifyCommand: '',
  autoFix: false,
  timeout: '30',
};

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

function ToggleSwitch({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-10 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-slate-600'}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`}
        />
      </button>
      <span className="text-sm text-slate-300">{label}</span>
    </label>
  );
}

function FormField({ label, children, hint }) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1.5">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function extractObjectPayload(payload) {
  if (!isObject(payload)) return {};
  if (isObject(payload.data)) return payload.data;
  if (isObject(payload.config)) return payload.config;
  if (isObject(payload.projectConfig)) return payload.projectConfig;
  return payload;
}

function normalizeProjectConfig(payload) {
  const data = extractObjectPayload(payload);
  const timeoutValue = data.default_timeout ?? data.timeout ?? data.default_timeout_minutes ?? 30;

  return {
    provider: data.default_provider ?? data.provider ?? '',
    model: data.default_model ?? data.model ?? '',
    verifyCommand: data.verify_command ?? '',
    autoFix: toBoolean(data.auto_fix_enabled ?? data.auto_fix),
    timeout: String(timeoutValue ?? 30),
  };
}

function normalizeProviderScores(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.scores)) return payload.scores;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.providers)) return payload.providers;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  return [];
}

function normalizeBudgetStatus(payload) {
  if (Array.isArray(payload)) {
    return {
      limit: payload[0]?.budget_usd ?? 0,
      used: payload[0]?.current_spend ?? 0,
      budgets: payload,
    };
  }

  const data = extractObjectPayload(payload);
  const budgets = Array.isArray(data.budgets)
    ? data.budgets
    : Array.isArray(data.items)
      ? data.items
      : isObject(data) && data.budget_usd != null
        ? [data]
        : [];

  return {
    limit: data.limit ?? data.budget_usd ?? budgets[0]?.budget_usd ?? 0,
    used: data.used ?? data.current_spend ?? budgets[0]?.current_spend ?? 0,
    budgets,
  };
}

function getErrorMessage(error) {
  if (!error) return 'Unknown error';
  if (typeof error.message === 'string' && error.message.trim()) return error.message;
  return String(error);
}

function isMissingEndpointError(error) {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('http 404')
    || message.includes('not found')
    || message.includes('cannot get');
}

function formatCurrency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '$0.00';
  return currencyFormatter.format(numeric);
}

function formatScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';
  return numeric <= 1 ? numeric.toFixed(2) : `${numeric.toFixed(0)}%`;
}

function sortTemplates(templates) {
  return [...templates].sort((a, b) => {
    if (a?.preset && !b?.preset) return -1;
    if (!a?.preset && b?.preset) return 1;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });
}

export default function ProjectSettings({ project: projectProp = '' }) {
  const initialProject = projectProp || '';
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const mountedRef = useRef(true);
  const [projectInput, setProjectInput] = useState(() => initialProject || searchParams.get('project') || '');
  const [activeProject, setActiveProject] = useState(() => initialProject || searchParams.get('project') || '');
  const [form, setForm] = useState(DEFAULT_FORM_STATE);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [activeTemplateName, setActiveTemplateName] = useState('System Default');
  const [providerScores, setProviderScores] = useState([]);
  const [hasProviderScores, setHasProviderScores] = useState(false);
  const [budgetStatus, setBudgetStatus] = useState(null);
  const [hasBudgetStatus, setHasBudgetStatus] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [savingRouting, setSavingRouting] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    if (!projectProp) return;
    setProjectInput(projectProp);
    setActiveProject(projectProp);
  }, [projectProp]);

  const loadOptionalProviderScores = useCallback(async () => {
    try {
      const scores = normalizeProviderScores(await request('/provider-scores'));
      if (!mountedRef.current) return;
      setProviderScores(scores);
      setHasProviderScores(true);
    } catch (error) {
      if (!mountedRef.current) return;
      if (!isMissingEndpointError(error)) {
        console.warn('Failed to load provider scores:', error);
      }
      setProviderScores([]);
      setHasProviderScores(false);
    }
  }, []);

  const loadOptionalBudgetStatus = useCallback(async () => {
    try {
      const data = normalizeBudgetStatus(await request('/cost-budgets'));
      if (!mountedRef.current) return;
      setBudgetStatus(data);
      setHasBudgetStatus(true);
    } catch (legacyError) {
      if (isMissingEndpointError(legacyError)) {
        try {
          const fallback = normalizeBudgetStatus(await budgetApi.status());
          if (!mountedRef.current) return;
          setBudgetStatus(fallback);
          setHasBudgetStatus(true);
          return;
        } catch (fallbackError) {
          if (!mountedRef.current) return;
          if (!isMissingEndpointError(fallbackError)) {
            console.warn('Failed to load fallback budget status:', fallbackError);
          }
        }
      } else if (mountedRef.current) {
        console.warn('Failed to load budget status:', legacyError);
      }

      if (!mountedRef.current) return;
      setBudgetStatus(null);
      setHasBudgetStatus(false);
    }
  }, []);

  const loadData = useCallback(async (projectName) => {
    if (!projectName) return;

    setLoading(true);
    setLoadError('');

    const results = await Promise.allSettled([
      request(`/project-config?project=${encodeURIComponent(projectName)}`),
      routingTemplates.list(),
      routingTemplates.getActive(),
      loadOptionalProviderScores(),
      loadOptionalBudgetStatus(),
    ]);

    if (!mountedRef.current) return;

    const [configResult, templatesResult, activeTemplateResult] = results;

    if (configResult.status === 'fulfilled') {
      setForm(normalizeProjectConfig(configResult.value));
    } else {
      setForm(DEFAULT_FORM_STATE);
      setLoadError(getErrorMessage(configResult.reason));
    }

    if (templatesResult.status === 'fulfilled') {
      const templateList = sortTemplates(
        Array.isArray(templatesResult.value)
          ? templatesResult.value
          : templatesResult.value?.items || []
      );
      setTemplates(templateList);
    } else {
      setTemplates([]);
    }

    if (activeTemplateResult.status === 'fulfilled') {
      const explicit = Boolean(activeTemplateResult.value?.explicit);
      const template = activeTemplateResult.value?.template || null;
      setSelectedTemplateId(explicit ? template?.id || '' : '');
      setActiveTemplateName(template?.name || 'System Default');
    } else {
      setSelectedTemplateId('');
      setActiveTemplateName('System Default');
    }

    setLoading(false);
  }, [loadOptionalBudgetStatus, loadOptionalProviderScores]);

  useEffect(() => {
    if (!activeProject) return;
    loadData(activeProject);
  }, [activeProject, loadData]);

  const budgetSummary = useMemo(() => {
    if (!hasBudgetStatus || !budgetStatus) return null;
    const limit = Number(budgetStatus.limit || 0);
    const used = Number(budgetStatus.used || 0);
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    return {
      limit,
      used,
      percent,
    };
  }, [budgetStatus, hasBudgetStatus]);

  const handleLoadProject = useCallback(() => {
    const nextProject = projectInput.trim();
    if (!nextProject) {
      toast.warning('Enter a project name to load settings');
      return;
    }

    setSearchParams({ project: nextProject }, { replace: true });
    if (nextProject === activeProject) {
      loadData(nextProject);
      return;
    }
    setActiveProject(nextProject);
  }, [activeProject, loadData, projectInput, setSearchParams, toast]);

  const handleConfigSave = useCallback(async () => {
    const timeoutValue = Number.parseInt(form.timeout, 10);
    if (!activeProject) {
      toast.warning('Load a project before saving settings');
      return;
    }
    if (!Number.isFinite(timeoutValue) || timeoutValue < 1) {
      toast.error('Timeout must be a positive number');
      return;
    }

    setSavingConfig(true);
    try {
      await request('/project-config', {
        method: 'POST',
        body: JSON.stringify({
          project: activeProject,
          default_provider: form.provider.trim() || null,
          default_model: form.model.trim() || null,
          verify_command: form.verifyCommand.trim() || null,
          auto_fix_enabled: form.autoFix,
          default_timeout: timeoutValue,
        }),
      });

      toast.success(`Saved project settings for ${activeProject}`);
      await loadData(activeProject);
    } catch (error) {
      toast.error(`Failed to save project settings: ${getErrorMessage(error)}`);
    } finally {
      if (mountedRef.current) setSavingConfig(false);
    }
  }, [activeProject, form, loadData, toast]);

  const handleRoutingSave = useCallback(async () => {
    setSavingRouting(true);
    try {
      await routingTemplates.setActive({ template_id: selectedTemplateId || null });
      toast.success(selectedTemplateId ? 'Routing template updated' : 'Routing template reset to System Default');
      const activeData = await routingTemplates.getActive();
      if (!mountedRef.current) return;
      setActiveTemplateName(activeData?.template?.name || 'System Default');
      setSelectedTemplateId(activeData?.explicit ? activeData?.template?.id || '' : '');
    } catch (error) {
      toast.error(`Failed to save routing template: ${getErrorMessage(error)}`);
    } finally {
      if (mountedRef.current) setSavingRouting(false);
    }
  }, [selectedTemplateId, toast]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="heading-lg text-white">Project Settings</h1>
        <p className="mt-1 text-sm text-slate-400">
          View and edit project defaults, optional provider budget data, and the active routing template.
        </p>
      </div>

      <div className="glass-card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="flex-1">
            <label className="block text-xs text-slate-400 mb-1.5">Project Name</label>
            <input
              type="text"
              value={projectInput}
              onChange={(event) => setProjectInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleLoadProject();
                }
              }}
              placeholder="e.g. torque-public"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            type="button"
            onClick={handleLoadProject}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-500"
          >
            Load Settings
          </button>
        </div>
      </div>

      {!activeProject && (
        <div className="glass-card p-8 text-center">
          <p className="text-sm text-slate-400">Enter a project name above to load project-level settings.</p>
        </div>
      )}

      {activeProject && loading && (
        <div className="glass-card p-6">
          <LoadingSkeleton lines={6} />
        </div>
      )}

      {activeProject && !loading && (
        <>
          {loadError ? (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
              Failed to load project settings: {loadError}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <div className="glass-card p-5 xl:col-span-2">
              <div className="flex items-center justify-between gap-4 mb-5">
                <div>
                  <h2 className="text-lg font-semibold text-white">Current Project Defaults</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Settings saved for <span className="text-slate-300">{activeProject}</span>.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleConfigSave}
                  disabled={savingConfig}
                  className="rounded-lg bg-indigo-600/90 px-4 py-2 text-sm text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingConfig ? 'Saving...' : 'Save Defaults'}
                </button>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <FormField label="Provider">
                  <input
                    type="text"
                    value={form.provider}
                    onChange={(event) => setForm((prev) => ({ ...prev, provider: event.target.value }))}
                    placeholder="codex"
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
                  />
                </FormField>

                <FormField label="Model">
                  <input
                    type="text"
                    value={form.model}
                    onChange={(event) => setForm((prev) => ({ ...prev, model: event.target.value }))}
                    placeholder="gpt-5.3-codex-spark"
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
                  />
                </FormField>

                <div className="md:col-span-2">
                  <FormField label="Verify Command">
                    <textarea
                      value={form.verifyCommand}
                      onChange={(event) => setForm((prev) => ({ ...prev, verifyCommand: event.target.value }))}
                      rows={4}
                      placeholder="npm run build && npm test"
                      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
                    />
                  </FormField>
                </div>

                <FormField label="Timeout (minutes)">
                  <input
                    type="number"
                    min={1}
                    value={form.timeout}
                    onChange={(event) => setForm((prev) => ({ ...prev, timeout: event.target.value }))}
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                </FormField>

                <div className="flex items-end">
                  <div className="rounded-lg border border-slate-700/60 bg-slate-800/60 px-4 py-3">
                    <ToggleSwitch
                      checked={form.autoFix}
                      onChange={(value) => setForm((prev) => ({ ...prev, autoFix: value }))}
                      label="Auto-fix after verification"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="glass-card p-5">
              <div className="mb-5">
                <h2 className="text-lg font-semibold text-white">Routing Template</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Active now: <span className="text-slate-300">{activeTemplateName}</span>
                </p>
              </div>

              <FormField
                label="Template"
                hint="Choose a template to explicitly activate, or use System Default to clear the override."
              >
                <select
                  value={selectedTemplateId}
                  onChange={(event) => setSelectedTemplateId(event.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="">System Default</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}{template.preset ? ' (preset)' : ''}
                    </option>
                  ))}
                </select>
              </FormField>

              <button
                type="button"
                onClick={handleRoutingSave}
                disabled={savingRouting}
                className="mt-4 w-full rounded-lg bg-cyan-600/90 px-4 py-2 text-sm text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {savingRouting ? 'Saving...' : 'Save Routing Template'}
              </button>
            </div>
          </div>

          {hasBudgetStatus && budgetSummary ? (
            <div className="glass-card p-5">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-white">Budget Status</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {formatCurrency(budgetSummary.used)} used of {formatCurrency(budgetSummary.limit)}.
                  </p>
                </div>
                <div className="w-full max-w-sm">
                  <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
                    <span>Usage</span>
                    <span>{budgetSummary.percent}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-700">
                    <div
                      className={`h-full rounded-full ${budgetSummary.percent >= 90 ? 'bg-red-500' : budgetSummary.percent >= 70 ? 'bg-amber-500' : 'bg-green-500'}`}
                      style={{ width: `${budgetSummary.percent}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className="mt-5 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700 text-left text-xs uppercase tracking-wider text-slate-500">
                      <th className="px-3 py-2 font-medium">Budget</th>
                      <th className="px-3 py-2 font-medium">Provider</th>
                      <th className="px-3 py-2 font-medium">Spend</th>
                      <th className="px-3 py-2 font-medium">Limit</th>
                      <th className="px-3 py-2 font-medium">Period</th>
                    </tr>
                  </thead>
                  <tbody>
                    {budgetStatus?.budgets?.length ? budgetStatus.budgets.map((item) => (
                      <tr key={item.id || item.name} className="border-b border-slate-800/80 text-slate-300 last:border-0">
                        <td className="px-3 py-2">{item.name || item.id || 'Unnamed budget'}</td>
                        <td className="px-3 py-2 text-slate-400">{item.provider || 'All providers'}</td>
                        <td className="px-3 py-2">{formatCurrency(item.current_spend)}</td>
                        <td className="px-3 py-2">{formatCurrency(item.budget_usd)}</td>
                        <td className="px-3 py-2 text-slate-400">{item.period || '-'}</td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                          No budgets configured.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {hasProviderScores ? (
            <div className="glass-card p-5">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-white">Provider Scores</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Historical provider performance, if the endpoint is available.
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700 text-left text-xs uppercase tracking-wider text-slate-500">
                      <th className="px-3 py-2 font-medium">Provider</th>
                      <th className="px-3 py-2 font-medium">Composite</th>
                      <th className="px-3 py-2 font-medium">Reliability</th>
                      <th className="px-3 py-2 font-medium">Quality</th>
                      <th className="px-3 py-2 font-medium">Speed</th>
                      <th className="px-3 py-2 font-medium">Avg Cost</th>
                      <th className="px-3 py-2 font-medium">Trusted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providerScores.length ? providerScores.map((score) => (
                      <tr key={score.provider} className="border-b border-slate-800/80 text-slate-300 last:border-0">
                        <td className="px-3 py-2 font-medium text-white">{score.provider}</td>
                        <td className="px-3 py-2">{formatScore(score.composite_score)}</td>
                        <td className="px-3 py-2">{formatScore(score.reliability_score)}</td>
                        <td className="px-3 py-2">{formatScore(score.quality_score)}</td>
                        <td className="px-3 py-2">{formatScore(score.speed_score)}</td>
                        <td className="px-3 py-2">{formatCurrency(score.avg_cost_usd)}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${score.trusted ? 'bg-green-500/15 text-green-300' : 'bg-slate-700 text-slate-400'}`}>
                            {score.trusted ? 'Trusted' : 'Learning'}
                          </span>
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                          No provider scores recorded yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
