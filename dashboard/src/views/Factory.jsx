import { useState, useEffect, useCallback } from 'react';
import { factory as factoryApi } from '../api';
import { useToast } from '../components/Toast';
import RadarChart from '../components/RadarChart';
import StatCard from '../components/StatCard';
import LoadingSkeleton from '../components/LoadingSkeleton';

const DIMENSION_LABELS = {
  structural: 'Structural',
  test_coverage: 'Test Coverage',
  security: 'Security',
  user_facing: 'User-Facing',
  api_completeness: 'API',
  documentation: 'Documentation',
  dependency_health: 'Dependencies',
  build_ci: 'Build/CI',
  performance: 'Performance',
  debt_ratio: 'Debt Ratio',
};

const DIMENSION_ORDER = [
  'structural',
  'test_coverage',
  'security',
  'user_facing',
  'api_completeness',
  'documentation',
  'dependency_health',
  'build_ci',
  'performance',
  'debt_ratio',
];

const TRUST_BADGE_STYLES = {
  supervised: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  guided: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  autonomous: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  dark: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
};

const STATUS_DOT_STYLES = {
  running: 'bg-emerald-400',
  paused: 'bg-amber-400',
  idle: 'bg-slate-500',
};

const BADGE_FALLBACK_STYLE = 'border-slate-500/30 bg-slate-500/10 text-slate-300';

const INTAKE_SOURCE_BADGE_STYLES = {
  conversation: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  github: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  scout: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  ci: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  webhook: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
  manual: 'border-slate-400/30 bg-slate-400/10 text-slate-300',
};

const INTAKE_STATUS_BADGE_STYLES = {
  pending: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  triaged: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  in_progress: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  completed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  rejected: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
};

function formatLabel(value) {
  if (!value) return 'Unknown';
  const key = String(value);
  return DIMENSION_LABELS[key] || key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function orderScores(scores = {}) {
  const ordered = {};

  for (const dimension of DIMENSION_ORDER) {
    if (scores[dimension] !== undefined) {
      ordered[dimension] = Number(scores[dimension]) || 0;
    }
  }

  for (const [dimension, score] of Object.entries(scores)) {
    if (ordered[dimension] === undefined) {
      ordered[dimension] = Number(score) || 0;
    }
  }

  return ordered;
}

function resolveWeakestDimension(rawWeakest, scores = {}) {
  if (rawWeakest && typeof rawWeakest === 'object' && rawWeakest.dimension) {
    return {
      dimension: rawWeakest.dimension,
      score: Number.isFinite(Number(rawWeakest.score))
        ? Number(rawWeakest.score)
        : Number(scores[rawWeakest.dimension]) || 0,
    };
  }

  if (typeof rawWeakest === 'string' && rawWeakest) {
    return {
      dimension: rawWeakest,
      score: Number(scores[rawWeakest]) || 0,
    };
  }

  const entries = Object.entries(scores).sort((a, b) => a[1] - b[1]);
  if (entries.length === 0) {
    return null;
  }

  return { dimension: entries[0][0], score: Number(entries[0][1]) || 0 };
}

function normalizeProject(project = {}) {
  const scores = orderScores(project.scores || {});
  const balance = Number.isFinite(Number(project.balance)) ? Number(project.balance) : 0;

  return {
    ...project,
    scores,
    balance,
    weakest_dimension: resolveWeakestDimension(project.weakest_dimension, scores),
  };
}

function normalizeHealth(health) {
  if (!health || typeof health !== 'object') {
    return null;
  }

  const normalizedProject = normalizeProject({
    ...(health.project || {}),
    scores: health.scores || health.project?.scores,
    balance: health.balance ?? health.project?.balance,
    weakest_dimension: health.weakest_dimension ?? health.project?.weakest_dimension,
  });

  return {
    project: {
      id: normalizedProject.id,
      name: normalizedProject.name,
      path: normalizedProject.path,
      trust_level: normalizedProject.trust_level,
      status: normalizedProject.status,
    },
    scores: normalizedProject.scores,
    balance: normalizedProject.balance,
    weakest_dimension: normalizedProject.weakest_dimension,
  };
}

function getProjectsFromResponse(data) {
  if (Array.isArray(data)) {
    return data.map(normalizeProject);
  }

  if (Array.isArray(data?.projects)) {
    return data.projects.map(normalizeProject);
  }

  if (Array.isArray(data?.items)) {
    return data.items.map(normalizeProject);
  }

  return [];
}

function buildDetailFallback(project) {
  if (!project) {
    return null;
  }

  const normalized = normalizeProject(project);
  return {
    project: {
      id: normalized.id,
      name: normalized.name,
      path: normalized.path,
      trust_level: normalized.trust_level,
      status: normalized.status,
    },
    scores: normalized.scores,
    balance: normalized.balance,
    weakest_dimension: normalized.weakest_dimension,
  };
}

function normalizeIntakeSource(source) {
  const normalized = String(source || '').toLowerCase();

  if (normalized === 'conversation' || normalized === 'conversational') return 'conversation';
  if (normalized === 'github' || normalized === 'github_issue') return 'github';
  if (normalized === 'scout' || normalized === 'scheduled_scan') return 'scout';
  if (normalized === 'ci' || normalized === 'ci_failure') return 'ci';
  if (normalized === 'webhook') return 'webhook';
  if (normalized === 'manual' || normalized === 'api' || normalized === 'self_generated') return 'manual';

  return normalized || 'manual';
}

function normalizeIntakeStatus(status) {
  const normalized = String(status || '').toLowerCase();

  if (normalized === 'pending' || normalized === 'intake') return 'pending';
  if (normalized === 'triaged' || normalized === 'prioritized' || normalized === 'planned') return 'triaged';
  if (normalized === 'in_progress' || normalized === 'executing' || normalized === 'verifying') return 'in_progress';
  if (normalized === 'completed' || normalized === 'shipped') return 'completed';
  if (normalized === 'rejected') return 'rejected';

  return normalized || 'pending';
}

function normalizeIntakeItem(item = {}) {
  return {
    ...item,
    displaySource: normalizeIntakeSource(item.source),
    displayStatus: normalizeIntakeStatus(item.status),
  };
}

function getIntakeItemsFromResponse(data) {
  if (Array.isArray(data)) {
    return data.map(normalizeIntakeItem);
  }

  if (Array.isArray(data?.items)) {
    return data.items.map(normalizeIntakeItem);
  }

  return [];
}

function formatBalance(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00';
}

function formatTimestamp(value) {
  if (!value) {
    return 'Unknown';
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

function getScoreEntries(scores = {}) {
  return Object.entries(scores).sort((a, b) => a[1] - b[1]);
}

function getScoreBarClass(score) {
  if (score >= 70) return 'bg-emerald-400';
  if (score >= 40) return 'bg-amber-400';
  return 'bg-rose-400';
}

function StatusDot({ status }) {
  return (
    <span
      className={`inline-flex h-2.5 w-2.5 rounded-full ${STATUS_DOT_STYLES[status] || STATUS_DOT_STYLES.idle}`}
      aria-hidden="true"
    />
  );
}

function TrustBadge({ level }) {
  const normalized = String(level || 'supervised').toLowerCase();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${TRUST_BADGE_STYLES[normalized] || TRUST_BADGE_STYLES.dark}`}
    >
      {formatLabel(normalized)}
    </span>
  );
}

function DimensionBar({ dimension, score }) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-slate-200">{formatLabel(dimension)}</span>
        <span className="font-mono text-slate-400">{Math.round(value)}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-all ${getScoreBarClass(value)}`}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function ProjectCard({ project, selected, busy, onSelect, onToggle }) {
  const actionLabel = project.status === 'running' ? 'Pause' : 'Resume';
  const weakest = project.weakest_dimension;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(project.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(project.id);
        }
      }}
      className={`rounded-2xl border p-5 transition-all ${
        selected
          ? 'border-blue-500/50 bg-slate-800 shadow-lg shadow-blue-950/30'
          : 'border-slate-700 bg-slate-800/80 hover:border-slate-600 hover:bg-slate-800'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot status={project.status} />
            <h2 className="truncate text-lg font-semibold text-white">{project.name || 'Unnamed project'}</h2>
          </div>
          <div className="mt-3">
            <TrustBadge level={project.trust_level} />
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(project);
          }}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            project.status === 'running'
              ? 'bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
              : 'bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
          }`}
        >
          {busy ? 'Working...' : actionLabel}
        </button>
      </div>

      <p className="mt-4 break-all font-mono text-xs text-slate-400">{project.path || 'No path configured'}</p>

      <div className="mt-5 flex justify-center rounded-xl border border-slate-700/70 bg-slate-900/40 p-3">
        <RadarChart scores={project.scores} size={180} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-700/70 bg-slate-900/40 p-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Balance</p>
          <p className="mt-1 text-lg font-semibold text-white">{formatBalance(project.balance)}</p>
        </div>
        <div className="rounded-xl border border-slate-700/70 bg-slate-900/40 p-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Weakest</p>
          {weakest ? (
            <>
              <p className="mt-1 text-sm font-semibold text-white">{formatLabel(weakest.dimension)}</p>
              <p className="text-xs text-slate-400">{Math.round(weakest.score)}</p>
            </>
          ) : (
            <p className="mt-1 text-sm text-slate-400">No scores yet</p>
          )}
        </div>
      </div>
    </div>
  );
}

function PolicyPanel({ project, onSave }) {
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [newCheck, setNewCheck] = useState('');
  const toast = useToast();

  useEffect(() => {
    if (!project) {
      return undefined;
    }

    let cancelled = false;
    setPolicy(null);
    setLoading(true);

    factoryApi.getPolicy(project.id)
      .then((res) => {
        if (!cancelled) {
          setPolicy(res.policy);
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
  }, [project?.id, toast]);

  const update = (path, value) => {
    setPolicy((prev) => {
      if (!prev) {
        return prev;
      }

      const next = JSON.parse(JSON.stringify(prev));
      const parts = path.split('.');
      let obj = next;

      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') {
          obj[parts[i]] = {};
        }
        obj = obj[parts[i]];
      }

      obj[parts[parts.length - 1]] = value;
      return next;
    });
  };

  const save = async () => {
    if (!project || !policy) {
      return;
    }

    setSaving(true);
    try {
      const res = await factoryApi.setPolicy(project.id, policy);
      setPolicy(res.policy);
      toast.success('Policy saved');
      onSave?.();
    } catch (error) {
      toast.error(error?.message ? `Failed to save policy: ${error.message}` : 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSkeleton lines={6} />;
  if (!policy) return null;

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
          <label className="mb-1 block text-sm text-slate-400">Budget Ceiling (null = unlimited)</label>
          <input
            type="number"
            value={policy.budget_ceiling ?? ''}
            onChange={(e) => update('budget_ceiling', e.target.value === '' ? null : Number(e.target.value))}
            placeholder="No limit"
            className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-slate-400">Blast Radius % (max codebase change per batch)</label>
          <input
            type="range"
            min="1"
            max="100"
            value={policy.blast_radius_percent}
            onChange={(e) => update('blast_radius_percent', Number(e.target.value))}
            className="w-full"
          />
          <span className="text-xs text-slate-500">{policy.blast_radius_percent}%</span>
        </div>

        <div>
          <label className="mb-1 block text-sm text-slate-400">Max Tasks per Batch</label>
          <input
            type="number"
            min="1"
            value={policy.scope_ceiling?.max_tasks ?? 20}
            onChange={(e) => update('scope_ceiling.max_tasks', Number(e.target.value))}
            className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-slate-400">Max Files per Task</label>
          <input
            type="number"
            min="1"
            value={policy.scope_ceiling?.max_files_per_task ?? 10}
            onChange={(e) => update('scope_ceiling.max_files_per_task', Number(e.target.value))}
            className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
          />
        </div>

        <div className="col-span-full">
          <label className="mb-1 flex items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={policy.work_hours !== null}
              onChange={(e) => update('work_hours', e.target.checked ? { start: 9, end: 17 } : null)}
              className="rounded border-slate-600"
            />
            Restrict Work Hours
          </label>
          {policy.work_hours && (
            <div className="mt-1 flex gap-3">
              <input
                type="number"
                min="0"
                max="23"
                value={policy.work_hours.start}
                onChange={(e) => update('work_hours.start', Number(e.target.value))}
                className="w-20 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-200"
              />
              <span className="self-center text-slate-500">to</span>
              <input
                type="number"
                min="0"
                max="23"
                value={policy.work_hours.end}
                onChange={(e) => update('work_hours.end', Number(e.target.value))}
                className="w-20 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-200"
              />
            </div>
          )}
        </div>

        <div className="col-span-full">
          <label className="mb-1 block text-sm text-slate-400">Restricted Paths</label>
          <div className="mb-2 flex flex-wrap gap-2">
            {(policy.restricted_paths || []).map((p, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-900/30 px-2 py-0.5 text-xs text-red-300">
                {p}
                <button
                  type="button"
                  onClick={() => update('restricted_paths', policy.restricted_paths.filter((_, j) => j !== i))}
                  className="text-red-400 hover:text-red-200"
                >
                  x
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newPath.trim()) {
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
          <label className="mb-1 block text-sm text-slate-400">Required Checks</label>
          <div className="mb-2 flex flex-wrap gap-2">
            {(policy.required_checks || []).map((c, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded border border-blue-500/30 bg-blue-900/30 px-2 py-0.5 text-xs text-blue-300">
                {c}
                <button
                  type="button"
                  onClick={() => update('required_checks', policy.required_checks.filter((_, j) => j !== i))}
                  className="text-blue-400 hover:text-blue-200"
                >
                  x
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newCheck}
              onChange={(e) => setNewCheck(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newCheck.trim()) {
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
                onChange={(e) => update('escalation_rules.security_findings', e.target.checked)}
                className="rounded border-slate-600"
              />
              Escalate security findings
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={policy.escalation_rules?.breaking_changes ?? true}
                onChange={(e) => update('escalation_rules.breaking_changes', e.target.checked)}
                className="rounded border-slate-600"
              />
              Escalate breaking changes
            </label>
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-300">Health drop threshold:</label>
              <input
                type="number"
                min="1"
                max="100"
                value={policy.escalation_rules?.health_drop_threshold ?? 10}
                onChange={(e) => update('escalation_rules.health_drop_threshold', Number(e.target.value))}
                className="w-16 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-200"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-300">Budget warning at:</label>
              <input
                type="number"
                min="1"
                max="100"
                value={policy.escalation_rules?.budget_warning_percent ?? 80}
                onChange={(e) => update('escalation_rules.budget_warning_percent', Number(e.target.value))}
                className="w-16 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-200"
              />
              <span className="text-xs text-slate-500">%</span>
            </div>
          </div>
        </div>

        <div className="col-span-full">
          <label className="mb-1 block text-sm text-slate-400">Provider Restrictions (empty = all allowed)</label>
          <div className="flex flex-wrap gap-3">
            {['codex', 'ollama', 'deepinfra', 'hyperbolic', 'groq', 'cerebras', 'google-ai', 'openrouter', 'claude-cli', 'anthropic'].map((prov) => (
              <label key={prov} className="flex items-center gap-1.5 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={(policy.provider_restrictions || []).includes(prov)}
                  onChange={(e) => {
                    const current = policy.provider_restrictions || [];
                    update(
                      'provider_restrictions',
                      e.target.checked ? [...current, prov] : current.filter((p) => p !== prov),
                    );
                  }}
                  className="rounded border-slate-600"
                />
                {prov}
              </label>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Factory() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [selectedHealth, setSelectedHealth] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [intakeItems, setIntakeItems] = useState([]);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [backlog, setBacklog] = useState([]);
  const [backlogReasoning, setBacklogReasoning] = useState(null);
  const [backlogFlags, setBacklogFlags] = useState([]);
  const [architectLoading, setArchitectLoading] = useState(false);
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const [activeProjectAction, setActiveProjectAction] = useState(null);
  const [rejectingItemId, setRejectingItemId] = useState(null);
  const [pauseAllBusy, setPauseAllBusy] = useState(false);
  const toast = useToast();

  const loadProjects = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
    }

    try {
      const response = await factoryApi.projects();
      const nextProjects = getProjectsFromResponse(response);
      setProjects(nextProjects);
      setSelectedProjectId((current) => (
        nextProjects.some((project) => project.id === current) ? current : null
      ));
    } catch (error) {
      toast.error(`Failed to load factory projects: ${error.message}`);
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [toast]);

  const loadProject = useCallback(async (projectId, { fallbackProject = null, isCancelled = () => false } = {}) => {
    if (!projectId) {
      if (!isCancelled()) {
        setSelectedHealth(null);
      }
      return;
    }

    if (!isCancelled()) {
      setSelectedHealth(buildDetailFallback(fallbackProject));
      setDetailLoading(true);
    }

    try {
      const response = await factoryApi.health(projectId);
      if (!isCancelled()) {
        setSelectedHealth(normalizeHealth(response));
      }
    } catch (error) {
      if (!isCancelled()) {
        toast.error(`Failed to load project health: ${error.message}`);
      }
    } finally {
      if (!isCancelled()) {
        setDetailLoading(false);
      }
    }
  }, [toast]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedHealth(null);
      return undefined;
    }

    const fallback = projects.find((project) => project.id === selectedProjectId);
    let cancelled = false;
    loadProject(selectedProjectId, { fallbackProject: fallback, isCancelled: () => cancelled });

    return () => {
      cancelled = true;
    };
  }, [loadProject, projects, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setIntakeItems([]);
      setIntakeLoading(false);
      return undefined;
    }

    let cancelled = false;
    setIntakeLoading(true);

    factoryApi.intake(selectedProjectId)
      .then((response) => {
        if (!cancelled) {
          setIntakeItems(getIntakeItemsFromResponse(response));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setIntakeItems([]);
          toast.error(`Failed to load intake queue: ${error.message}`);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIntakeLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, toast]);

  useEffect(() => {
    if (!selectedProjectId) {
      setBacklog([]);
      setBacklogReasoning(null);
      setBacklogFlags([]);
      return;
    }
    factoryApi.backlog(selectedProjectId)
      .then((response) => {
        setBacklog(response?.backlog || []);
        setBacklogReasoning(response?.reasoning_summary || null);
      })
      .catch(() => setBacklog([]));
  }, [selectedProjectId]);

  const handleSelectProject = useCallback((projectId) => {
    setSelectedProjectId(projectId);
  }, []);

  const handleToggleProject = useCallback(async (project) => {
    const shouldPause = project.status === 'running';
    const action = shouldPause ? 'pause' : 'resume';
    setActiveProjectAction(project.id);

    try {
      if (shouldPause) {
        await factoryApi.pause(project.id);
      } else {
        await factoryApi.resume(project.id);
      }

      toast.success(`Project ${action}d`);
      await loadProjects({ silent: true });
    } catch (error) {
      toast.error(`Failed to ${action} project: ${error.message}`);
    } finally {
      setActiveProjectAction(null);
    }
  }, [loadProjects, toast]);

  const handlePauseAll = useCallback(async () => {
    setPauseAllBusy(true);

    try {
      await factoryApi.pauseAll();
      toast.success('All factory projects paused');
      await loadProjects({ silent: true });
    } catch (error) {
      toast.error(`Failed to pause all projects: ${error.message}`);
    } finally {
      setPauseAllBusy(false);
    }
  }, [loadProjects, toast]);

  const handleRejectWorkItem = useCallback(async (itemId) => {
    setRejectingItemId(itemId);

    try {
      const response = await factoryApi.rejectWorkItem(itemId, 'Rejected from dashboard');
      const rejectedItem = normalizeIntakeItem(response?.item || { id: itemId, status: 'rejected' });

      setIntakeItems((current) => current.map((item) => (
        item.id === itemId
          ? { ...item, ...rejectedItem }
          : item
      )));
      toast.success('Work item rejected');
    } catch (error) {
      toast.error(`Failed to reject work item: ${error.message}`);
    } finally {
      setRejectingItemId(null);
    }
  }, [toast]);

  const totalProjects = projects.length;
  const runningProjects = projects.filter((project) => project.status === 'running').length;
  const pausedProjects = projects.filter((project) => project.status === 'paused').length;
  const detail = selectedHealth || buildDetailFallback(projects.find((project) => project.id === selectedProjectId));
  const selectedProject = detail?.project || null;
  const detailEntries = getScoreEntries(detail?.scores || {});

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Software Factory</h1>
          <p className="mt-1 text-sm text-slate-400">Health, trust, and runtime state across registered factory projects.</p>
        </div>
        {totalProjects > 0 && (
          <button
            type="button"
            disabled={pauseAllBusy}
            onClick={handlePauseAll}
            className="inline-flex items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pauseAllBusy ? 'Pausing...' : 'Pause All'}
          </button>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Total Projects" value={totalProjects} gradient="blue" />
        <StatCard label="Running" value={runningProjects} gradient="green" />
        <StatCard label="Paused" value={pausedProjects} gradient="orange" />
      </div>

      {loading ? (
        <div className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
          <LoadingSkeleton lines={6} height={18} />
        </div>
      ) : totalProjects === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/70 px-6 py-16 text-center">
          <h2 className="text-xl font-semibold text-white">No projects registered</h2>
          <p className="mt-2 text-sm text-slate-400">
            Use <code className="rounded bg-slate-900 px-1.5 py-0.5 text-slate-200">register_factory_project</code> to add one.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                selected={selectedProjectId === project.id}
                busy={activeProjectAction === project.id}
                onSelect={handleSelectProject}
                onToggle={handleToggleProject}
              />
            ))}
          </div>

          {selectedProjectId && detail && (
            <section className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Project Detail</p>
                  <h2 className="mt-1 text-2xl font-semibold text-white">{detail.project?.name || 'Selected project'}</h2>
                  <p className="mt-2 break-all font-mono text-xs text-slate-400">{detail.project?.path || 'No path configured'}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <TrustBadge level={detail.project?.trust_level} />
                  <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
                    <StatusDot status={detail.project?.status} />
                    {formatLabel(detail.project?.status)}
                  </span>
                  <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
                    Balance {formatBalance(detail.balance)}
                  </span>
                </div>
              </div>

              {detailLoading && !detail.scores ? (
                <div className="mt-6">
                  <LoadingSkeleton lines={5} height={18} />
                </div>
              ) : (
                <div className="mt-6 grid gap-8 xl:grid-cols-[360px,1fr]">
                  <div className="rounded-2xl border border-slate-700 bg-slate-900/40 p-5">
                    <div className="flex justify-center">
                      <RadarChart scores={detail.scores} size={320} showValues />
                    </div>
                    <div className="mt-4 rounded-xl border border-slate-700/70 bg-slate-900/60 p-4">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Balance Score</p>
                      <p className="mt-1 text-2xl font-semibold text-white">{formatBalance(detail.balance)}</p>
                      <p className="mt-1 text-sm text-slate-400">Lower is more even across dimensions.</p>
                      {detail.weakest_dimension && (
                        <p className="mt-3 text-sm text-slate-300">
                          Weakest: <span className="font-medium text-white">{formatLabel(detail.weakest_dimension.dimension)}</span>{' '}
                          <span className="text-slate-400">({Math.round(detail.weakest_dimension.score)})</span>
                        </p>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-lg font-semibold text-white">Dimension Scores</h3>
                      {detailLoading && <span className="text-xs uppercase tracking-wide text-slate-500">Refreshing</span>}
                    </div>

                    {detailEntries.length === 0 ? (
                      <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-900/40 px-5 py-10 text-center text-sm text-slate-400">
                        No health scores have been captured for this project yet.
                      </div>
                    ) : (
                      <div className="mt-4 space-y-3">
                        {detailEntries.map(([dimension, score]) => (
                          <DimensionBar key={dimension} dimension={dimension} score={score} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          {selectedProjectId && (
            <section className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-xl font-semibold text-white">Intake Queue</h2>
                  <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-sm text-slate-300">
                    {intakeItems.length}
                  </span>
                </div>
                {intakeLoading && <span className="text-xs uppercase tracking-wide text-slate-500">Refreshing</span>}
              </div>

              {intakeLoading && intakeItems.length === 0 ? (
                <div className="mt-6">
                  <LoadingSkeleton lines={4} height={18} />
                </div>
              ) : intakeItems.length === 0 ? (
                <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-900/40 px-5 py-10 text-center text-sm text-slate-400">
                  No work items in the intake queue
                </div>
              ) : (
                <div className="mt-6 overflow-x-auto">
                  <table className="min-w-full divide-y divide-slate-700 text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-3 font-medium">Title</th>
                        <th className="px-4 py-3 font-medium">Source</th>
                        <th className="px-4 py-3 font-medium">Priority</th>
                        <th className="px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium">Created At</th>
                        <th className="px-4 py-3 text-right font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/70">
                      {intakeItems.map((item) => {
                        const sourceStyle = INTAKE_SOURCE_BADGE_STYLES[item.displaySource] || BADGE_FALLBACK_STYLE;
                        const statusStyle = INTAKE_STATUS_BADGE_STYLES[item.displayStatus] || BADGE_FALLBACK_STYLE;
                        const isRejected = item.displayStatus === 'rejected';
                        const isRejecting = rejectingItemId === item.id;

                        return (
                          <tr key={item.id} className="align-top">
                            <td className="px-4 py-4">
                              <p className="font-medium text-white">{item.title || 'Untitled work item'}</p>
                              {item.description && (
                                <p className="mt-1 max-w-xl text-xs text-slate-400">{item.description}</p>
                              )}
                            </td>
                            <td className="px-4 py-4">
                              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${sourceStyle}`}>
                                {formatLabel(item.displaySource)}
                              </span>
                            </td>
                            <td className="px-4 py-4 text-slate-300">{formatLabel(item.priority || 'default')}</td>
                            <td className="px-4 py-4">
                              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyle}`}>
                                {formatLabel(item.displayStatus)}
                              </span>
                            </td>
                            <td className="px-4 py-4 text-slate-300">{formatTimestamp(item.created_at)}</td>
                            <td className="px-4 py-4 text-right">
                              <button
                                type="button"
                                disabled={isRejected || isRejecting}
                                onClick={() => handleRejectWorkItem(item.id)}
                                className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-sm font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {isRejecting ? 'Rejecting...' : isRejected ? 'Rejected' : 'Reject'}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {selectedProjectId && (
            <section className="mt-8">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-white">Architect Backlog</h2>
                <button
                  onClick={() => {
                    setArchitectLoading(true);
                    factoryApi.triggerArchitect(selectedProjectId)
                      .then((response) => {
                        setBacklog(response?.backlog || []);
                        setBacklogReasoning(response?.reasoning || null);
                        setBacklogFlags(response?.flags || []);
                        toast.success('Architect cycle completed');
                      })
                      .catch((err) => toast.error(`Architect failed: ${err.message}`))
                      .finally(() => setArchitectLoading(false));
                  }}
                  disabled={architectLoading}
                  className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm font-medium rounded"
                >
                  {architectLoading ? 'Running...' : 'Run Architect'}
                </button>
              </div>

              {backlogReasoning && (
                <div className="mb-4">
                  <button
                    onClick={() => setReasoningExpanded(!reasoningExpanded)}
                    className="text-sm text-slate-400 hover:text-white flex items-center gap-1"
                  >
                    <span>{reasoningExpanded ? '▼' : '▶'}</span>
                    <span>Reasoning</span>
                  </button>
                  {reasoningExpanded && (
                    <pre className="mt-2 p-3 bg-slate-800 rounded text-sm text-slate-300 whitespace-pre-wrap">{backlogReasoning}</pre>
                  )}
                </div>
              )}

              {backlogFlags.length > 0 && (
                <div className="mb-4 flex flex-wrap gap-2">
                  {backlogFlags.map((flag, i) => (
                    <span key={i} className="px-2 py-1 bg-yellow-900/50 text-yellow-300 text-xs rounded">
                      ⚠ {flag.item}: {flag.reason}
                    </span>
                  ))}
                </div>
              )}

              {backlog.length === 0 ? (
                <p className="text-slate-500 text-sm">No backlog items. Run the architect to prioritize intake.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-400 border-b border-slate-700">
                        <th className="py-2 pr-4">Rank</th>
                        <th className="py-2 pr-4">Title</th>
                        <th className="py-2 pr-4">Why</th>
                        <th className="py-2 pr-4">Scope</th>
                        <th className="py-2">Impact</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backlog.map((item, i) => (
                        <tr key={item.work_item_id || i} className="border-b border-slate-800 text-slate-300">
                          <td className="py-2 pr-4 font-mono text-purple-400">{item.priority_rank || i + 1}</td>
                          <td className="py-2 pr-4">{item.title}</td>
                          <td className="py-2 pr-4 text-slate-400">{item.why}</td>
                          <td className="py-2 pr-4 font-mono">{item.scope_budget}</td>
                          <td className="py-2">
                            {item.expected_impact
                              ? Object.entries(item.expected_impact).map(([dim, delta]) => (
                                <span key={dim} className="text-xs mr-2">{dim}: {delta > 0 ? '+' : ''}{delta}</span>
                              ))
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {selectedProject && (
            <PolicyPanel
              project={selectedProject}
              onSave={() => loadProject(selectedProject.id, { fallbackProject: selectedProject })}
            />
          )}
        </>
      )}
    </div>
  );
}
