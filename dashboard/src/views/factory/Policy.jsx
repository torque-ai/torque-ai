import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { factory as factoryApi, providers as providersApi } from '../../api';
import LoadingSkeleton from '../../components/LoadingSkeleton';
import StatCard from '../../components/StatCard';
import { useToast } from '../../components/Toast';
import { SelectProjectPrompt, StatusDot, TrustBadge } from './shared';
import { formatCurrency, formatLabel, normalizeCostMetrics } from './utils';

const GUARDRAIL_COLORS = { green: 'text-green-400', yellow: 'text-yellow-400', red: 'text-red-400' };
const GUARDRAIL_LABELS = { green: 'Pass', yellow: 'Warning', red: 'Fail' };
const PROVIDER_FALLBACK = ['codex', 'ollama', 'deepinfra', 'hyperbolic', 'groq', 'cerebras', 'google-ai', 'openrouter', 'claude-cli', 'anthropic'];

function GuardrailPanel({ project }) {
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const projectId = project?.id ?? null;

  const loadGuardrails = useCallback(async (projectId) => {
    if (!projectId) {
      return;
    }

    setLoading(true);
    try {
      const [statusResponse, eventsResponse] = await Promise.all([
        factoryApi.guardrailStatus(projectId),
        factoryApi.guardrailEvents(projectId, { limit: 20 }),
      ]);
      setStatus(statusResponse.status_map || {});
      setEvents(eventsResponse.events || []);
    } catch {
      setStatus(null);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!projectId) {
      return;
    }
    void loadGuardrails(projectId);
  }, [projectId, loadGuardrails]);

  const categories = ['scope', 'quality', 'resource', 'silent_failure', 'security', 'conflict', 'control'];

  return (
    <section className="mt-6 rounded-lg bg-slate-800 p-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          className="flex flex-1 items-center justify-between text-left"
          onClick={() => setExpanded((current) => !current)}
        >
          <h3 className="text-lg font-semibold text-slate-200">Guardrails</h3>
          <span className="text-sm text-slate-400">{expanded ? '▼' : '▶'}</span>
        </button>
        {expanded && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (projectId) {
                void loadGuardrails(projectId);
              }
            }}
            disabled={loading || !projectId}
            className="ml-2 shrink-0 rounded-lg border border-slate-600 bg-slate-900/70 px-3 py-1 text-xs font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-4">
          {loading ? (
            <p className="text-slate-400">Loading guardrails...</p>
          ) : !status ? (
            <p className="text-slate-500">No guardrail data yet.</p>
          ) : (
            <>
              <div className="mb-4 grid grid-cols-7 gap-2">
                {categories.map((category) => (
                  <div key={category} className="text-center">
                    <div className={`text-2xl font-bold ${GUARDRAIL_COLORS[status[category] || 'green']}`}>
                      ●
                    </div>
                    <div className="mt-1 text-xs text-slate-400">{category.replace('_', ' ')}</div>
                    <div className={`text-xs ${GUARDRAIL_COLORS[status[category] || 'green']}`}>
                      {GUARDRAIL_LABELS[status[category] || 'green']}
                    </div>
                  </div>
                ))}
              </div>

              {events.length > 0 && (
                <div className="mt-3">
                  <h4 className="mb-2 text-sm font-medium text-slate-300">Recent Events</h4>
                  <div className="max-h-48 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-slate-500">
                          <th className="pb-1">Category</th>
                          <th className="pb-1">Check</th>
                          <th className="pb-1">Status</th>
                          <th className="pb-1">Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {events.map((event, index) => (
                          <tr key={event.id || index} className="border-t border-slate-700">
                            <td className="py-1 text-slate-400">{event.category}</td>
                            <td className="py-1 text-slate-300">{event.check_name}</td>
                            <td className={`py-1 ${
                              GUARDRAIL_COLORS[event.status === 'pass' ? 'green' : event.status === 'warn' ? 'yellow' : 'red']
                            }`}
                            >
                              {event.status}
                            </td>
                            <td className="py-1 text-slate-500">
                              {event.created_at ? new Date(event.created_at).toLocaleString() : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function PolicyPanel({ project, onSave }) {
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [newCheck, setNewCheck] = useState('');
  const [availableProviders, setAvailableProviders] = useState(PROVIDER_FALLBACK);
  const toast = useToast();
  const projectId = project?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    providersApi.list()
      .then((items) => {
        if (cancelled) {
          return;
        }
        const names = Array.isArray(items)
          ? items.map((entry) => entry?.id || entry?.name || entry?.provider).filter(Boolean)
          : [];
        if (names.length > 0) {
          setAvailableProviders(names);
        }
      })
      .catch(() => {
        // Keep PROVIDER_FALLBACK if the fetch fails — user still gets a usable list.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectId) {
      return undefined;
    }

    let cancelled = false;
    setPolicy(null);
    setLoading(true);

    factoryApi.getPolicy(projectId)
      .then((response) => {
        if (!cancelled) {
          setPolicy(response.policy);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(error?.message ? `Failed to load policy: ${error.message}` : 'Failed to load policy');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, toast]);

  const update = (path, value) => {
    setPolicy((current) => {
      if (!current) {
        return current;
      }

      const next = JSON.parse(JSON.stringify(current));
      const parts = path.split('.');
      let target = next;

      for (let index = 0; index < parts.length - 1; index += 1) {
        if (!target[parts[index]] || typeof target[parts[index]] !== 'object') {
          target[parts[index]] = {};
        }
        target = target[parts[index]];
      }

      target[parts[parts.length - 1]] = value;
      return next;
    });
  };

  const save = async () => {
    if (!projectId || !policy) {
      return;
    }

    setSaving(true);
    try {
      const response = await factoryApi.setPolicy(projectId, policy);
      setPolicy(response.policy);
      toast.success('Policy saved');
      onSave?.();
    } catch (error) {
      toast.error(error?.message ? `Failed to save policy: ${error.message}` : 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <LoadingSkeleton lines={6} />;
  }
  if (!policy) {
    return null;
  }

  return (
    <section className="mt-6 rounded-lg border border-slate-700 bg-slate-800/50 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-slate-100">Policy Configuration</h3>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded bg-purple-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Policy'}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="factory-budget-ceiling" className="mb-1 block text-sm text-slate-400">Budget Ceiling (null = unlimited)</label>
          <input
            id="factory-budget-ceiling"
            type="number"
            value={policy.budget_ceiling ?? ''}
            onChange={(event) => update('budget_ceiling', event.target.value === '' ? null : Number(event.target.value))}
            placeholder="No limit"
            className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
          />
        </div>

        <div>
          <label htmlFor="factory-blast-radius" className="mb-1 block text-sm text-slate-400">Blast Radius % (max codebase change per batch)</label>
          <input
            id="factory-blast-radius"
            type="range"
            min="1"
            max="100"
            value={policy.blast_radius_percent}
            onChange={(event) => update('blast_radius_percent', Number(event.target.value))}
            className="w-full"
          />
          <span className="text-xs text-slate-500">{policy.blast_radius_percent}%</span>
        </div>

        <div>
          <label htmlFor="factory-max-task" className="mb-1 block text-sm text-slate-400">Max Tasks per Batch</label>
          <input
            id="factory-max-task"
            type="number"
            min="1"
            value={policy.scope_ceiling?.max_tasks ?? 20}
            onChange={(event) => update('scope_ceiling.max_tasks', Number(event.target.value))}
            className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
          />
        </div>

        <div>
          <label htmlFor="factory-max-file" className="mb-1 block text-sm text-slate-400">Max Files per Task</label>
          <input
            id="factory-max-file"
            type="number"
            min="1"
            value={policy.scope_ceiling?.max_files_per_task ?? 10}
            onChange={(event) => update('scope_ceiling.max_files_per_task', Number(event.target.value))}
            className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
          />
        </div>

        <div className="col-span-full">
          <label htmlFor="factory-work-hours-enabled" className="mb-1 flex items-center gap-2 text-sm text-slate-400">
            <input
              id="factory-work-hours-enabled"
              type="checkbox"
              checked={policy.work_hours !== null}
              onChange={(event) => update('work_hours', event.target.checked ? { start: 9, end: 17 } : null)}
              className="rounded border-slate-600"
            />
            Restrict Work Hours
          </label>
          {policy.work_hours && (
            <div className="mt-1 flex gap-3">
              <label htmlFor="factory-work-hours-start" className="sr-only">Work hours start</label>
              <input
                id="factory-work-hours-start"
                type="number"
                min="0"
                max="23"
                value={policy.work_hours.start}
                onChange={(event) => update('work_hours.start', Number(event.target.value))}
                className="w-20 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-200"
              />
              <span className="self-center text-slate-500">to</span>
              <label htmlFor="factory-work-hours-end" className="sr-only">Work hours end</label>
              <input
                id="factory-work-hours-end"
                type="number"
                min="0"
                max="23"
                value={policy.work_hours.end}
                onChange={(event) => update('work_hours.end', Number(event.target.value))}
                className="w-20 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-200"
              />
            </div>
          )}
        </div>

        <div className="col-span-full">
          <label htmlFor="factory-restricted-path" className="mb-1 block text-sm text-slate-400">Restricted Paths</label>
          <div className="mb-2 flex flex-wrap gap-2">
            {(policy.restricted_paths || []).map((path, index) => (
              <span key={index} className="inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-900/30 px-2 py-0.5 text-xs text-red-300">
                {path}
                <button
                  type="button"
                  aria-label="Remove restricted path"
                  onClick={() => update('restricted_paths', policy.restricted_paths.filter((_, itemIndex) => itemIndex !== index))}
                  className="text-red-400 hover:text-red-200"
                >
                  x
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              id="factory-restricted-path"
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newPath.trim()) {
                  update('restricted_paths', [...(policy.restricted_paths || []), newPath.trim()]);
                  setNewPath('');
                }
              }}
              placeholder="e.g. server/db/migrations.js"
              className="flex-1 rounded border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
            />
            <button
              type="button"
              onClick={() => {
                if (newPath.trim()) {
                  update('restricted_paths', [...(policy.restricted_paths || []), newPath.trim()]);
                  setNewPath('');
                }
              }}
              className="rounded bg-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-600"
            >
              Add
            </button>
          </div>
        </div>

        <div className="col-span-full">
          <label htmlFor="factory-required-check" className="mb-1 block text-sm text-slate-400">Required Checks</label>
          <div className="mb-2 flex flex-wrap gap-2">
            {(policy.required_checks || []).map((check, index) => (
              <span key={index} className="inline-flex items-center gap-1 rounded border border-blue-500/30 bg-blue-900/30 px-2 py-0.5 text-xs text-blue-300">
                {check}
                <button
                  type="button"
                  aria-label="Remove required check"
                  onClick={() => update('required_checks', policy.required_checks.filter((_, itemIndex) => itemIndex !== index))}
                  className="text-blue-400 hover:text-blue-200"
                >
                  x
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              id="factory-required-check"
              value={newCheck}
              onChange={(event) => setNewCheck(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newCheck.trim()) {
                  update('required_checks', [...(policy.required_checks || []), newCheck.trim()]);
                  setNewCheck('');
                }
              }}
              placeholder="e.g. npx vitest run"
              className="flex-1 rounded border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
            />
            <button
              type="button"
              onClick={() => {
                if (newCheck.trim()) {
                  update('required_checks', [...(policy.required_checks || []), newCheck.trim()]);
                  setNewCheck('');
                }
              }}
              className="rounded bg-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-600"
            >
              Add
            </button>
          </div>
        </div>

        <div className="col-span-full">
          <label className="mb-2 block text-sm text-slate-400">Escalation Rules</label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={policy.escalation_rules?.security_findings ?? true}
                onChange={(event) => update('escalation_rules.security_findings', event.target.checked)}
                className="rounded border-slate-600"
              />
              Escalate security findings
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={policy.escalation_rules?.breaking_changes ?? true}
                onChange={(event) => update('escalation_rules.breaking_changes', event.target.checked)}
                className="rounded border-slate-600"
              />
              Escalate breaking changes
            </label>
            <div className="flex items-center gap-2">
              <label htmlFor="factory-health-drop-threshold" className="text-sm text-slate-300">Health drop threshold:</label>
              <input
                id="factory-health-drop-threshold"
                type="number"
                min="1"
                max="100"
                value={policy.escalation_rules?.health_drop_threshold ?? 10}
                onChange={(event) => update('escalation_rules.health_drop_threshold', Number(event.target.value))}
                className="w-16 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-200"
              />
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="factory-budget-warning-threshold" className="text-sm text-slate-300">Budget warning at:</label>
              <input
                id="factory-budget-warning-threshold"
                type="number"
                min="1"
                max="100"
                value={policy.escalation_rules?.budget_warning_percent ?? 80}
                onChange={(event) => update('escalation_rules.budget_warning_percent', Number(event.target.value))}
                className="w-16 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-200"
              />
              <span className="text-xs text-slate-500">%</span>
            </div>
          </div>
        </div>

        <div className="col-span-full">
          <label className="mb-1 block text-sm text-slate-400">Provider Restrictions (empty = all allowed)</label>
          <div className="flex flex-wrap gap-3">
            {availableProviders.map((provider) => (
              <label key={provider} className="flex items-center gap-1.5 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={(policy.provider_restrictions || []).includes(provider)}
                  onChange={(event) => {
                    const current = policy.provider_restrictions || [];
                    update(
                      'provider_restrictions',
                      event.target.checked ? [...current, provider] : current.filter((item) => item !== provider),
                    );
                  }}
                  className="rounded border-slate-600"
                />
                {provider}
              </label>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Policy() {
  const { costMetrics, costMetricsLoading, refreshSelectedProject, selectedProject } = useOutletContext();

  if (!selectedProject) {
    return <SelectProjectPrompt message="Select a project above to view its policy, guardrails, and cost metrics." />;
  }

  const costMetricsData = costMetrics || normalizeCostMetrics();

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Policy</p>
            <h2 className="mt-1 text-2xl font-semibold text-white">{selectedProject.name || 'Selected project'}</h2>
            <p className="mt-2 break-all font-mono text-xs text-slate-400">{selectedProject.path || 'No path configured'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <TrustBadge level={selectedProject.trust_level} />
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
              <StatusDot status={selectedProject.status} />
              {formatLabel(selectedProject.status)}
            </span>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-white">Cost Metrics</h2>
            <p className="mt-2 text-sm text-slate-400">
              Spend tracked across analyzed factory batches for the selected project.
            </p>
          </div>
          {costMetricsLoading && (
            <span className="text-xs uppercase tracking-wide text-slate-500">Refreshing</span>
          )}
        </div>

        {costMetricsLoading && !costMetrics ? (
          <div className="mt-6">
            <LoadingSkeleton lines={4} height={18} />
          </div>
        ) : (
          <>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <StatCard
                label="Cost / Cycle"
                value={formatCurrency(costMetricsData.cost_per_cycle)}
                subtext="Average spend across tracked factory cycles"
                gradient="cyan"
              />
              <StatCard
                label="Cost / Health Point"
                value={formatCurrency(costMetricsData.cost_per_health_point)}
                subtext="Total spend divided by total positive health gains"
                gradient="purple"
              />
            </div>

            <div className="mt-6">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-white">Provider Efficiency</h3>
                <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
                  {costMetricsData.provider_efficiency.length} tracked
                </span>
              </div>

              {costMetricsData.provider_efficiency.length === 0 ? (
                <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-900/40 px-5 py-10 text-center text-sm text-slate-400">
                  No provider cost data is available for this project yet.
                </div>
              ) : (
                <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {costMetricsData.provider_efficiency.map((entry) => (
                    <StatCard
                      key={entry.provider}
                      label={formatLabel(entry.provider)}
                      value={formatCurrency(entry.cost_per_task)}
                      subtext={`${entry.task_count} task${entry.task_count === 1 ? '' : 's'} · ${formatCurrency(entry.total_cost)} total`}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      <GuardrailPanel project={selectedProject} />
      <PolicyPanel project={selectedProject} onSave={refreshSelectedProject} />
    </div>
  );
}
