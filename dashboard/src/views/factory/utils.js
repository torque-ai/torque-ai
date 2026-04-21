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

export const DIMENSION_ORDER = [
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

export const TRUST_BADGE_STYLES = {
  supervised: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  guided: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  autonomous: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  dark: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
};

export const STATUS_DOT_STYLES = {
  running: 'bg-emerald-400',
  paused: 'bg-amber-400',
  idle: 'bg-slate-500',
};

export const BADGE_FALLBACK_STYLE = 'border-slate-500/30 bg-slate-500/10 text-slate-300';

export const LOOP_STAGES = ['SENSE', 'PRIORITIZE', 'PLAN', 'EXECUTE', 'VERIFY', 'LEARN'];

export const LOOP_STAGE_COLORS = {
  SENSE: 'bg-cyan-500',
  PRIORITIZE: 'bg-amber-500',
  PLAN: 'bg-blue-500',
  EXECUTE: 'bg-purple-500',
  VERIFY: 'bg-emerald-500',
  LEARN: 'bg-pink-500',
  IDLE: 'bg-slate-600',
  PAUSED: 'bg-amber-400',
};

export const INTAKE_SOURCE_BADGE_STYLES = {
  conversation: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  github: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  scout: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  ci: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  webhook: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
  manual: 'border-slate-400/30 bg-slate-400/10 text-slate-300',
};

export const INTAKE_STATUS_BADGE_STYLES = {
  pending: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  triaged: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  in_progress: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  completed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  rejected: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
};

export const DECISION_STAGE_OPTIONS = ['sense', 'prioritize', 'plan', 'execute', 'verify', 'learn'];
export const DECISION_ACTOR_OPTIONS = ['health_model', 'architect', 'planner', 'executor', 'verifier', 'human'];

export const DECISION_STAGE_BADGE_STYLES = {
  sense: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  prioritize: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  plan: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  execute: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  verify: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  learn: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
};

export const DECISION_ACTOR_BADGE_STYLES = {
  health_model: 'border-blue-500/20 bg-blue-500/5 text-blue-200',
  architect: 'border-purple-500/20 bg-purple-500/5 text-purple-200',
  planner: 'border-orange-500/20 bg-orange-500/5 text-orange-200',
  executor: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200',
  verifier: 'border-teal-500/20 bg-teal-500/5 text-teal-200',
  human: 'border-rose-500/20 bg-rose-500/5 text-rose-200',
};

export const INTAKE_SUMMARY_ORDER = ['pending', 'prioritized', 'planned', 'executing', 'verifying', 'shipped', 'rejected'];

const USD_FORMATTER = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatLabel(value) {
  if (!value) return 'Unknown';
  const key = String(value);
  return DIMENSION_LABELS[key] || key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function orderScores(scores = {}) {
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

export function resolveWeakestDimension(rawWeakest, scores = {}) {
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

export function normalizeProject(project = {}) {
  const scores = orderScores(project.scores || {});
  const balance = Number.isFinite(Number(project.balance)) ? Number(project.balance) : 0;

  return {
    ...project,
    auto_recovery_attempts: Number(project.auto_recovery_attempts) || 0,
    auto_recovery_exhausted: Number(project.auto_recovery_exhausted) || 0,
    auto_recovery_last_strategy: project.auto_recovery_last_strategy || null,
    scores,
    balance,
    weakest_dimension: resolveWeakestDimension(project.weakest_dimension, scores),
  };
}

export function mergeLoopState(project = {}, loopState = {}) {
  if (!loopState || typeof loopState !== 'object') {
    return project;
  }

  return {
    ...project,
    loop_state: loopState.loop_state ?? project.loop_state,
    loop_batch_id: loopState.loop_batch_id ?? project.loop_batch_id,
    loop_last_action_at: loopState.loop_last_action_at ?? project.loop_last_action_at,
    loop_paused_at_stage: loopState.loop_paused_at_stage ?? project.loop_paused_at_stage,
  };
}

export function buildProjectDetail(project = {}) {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    trust_level: project.trust_level,
    status: project.status,
    loop_state: project.loop_state,
    loop_batch_id: project.loop_batch_id,
    loop_last_action_at: project.loop_last_action_at,
    loop_paused_at_stage: project.loop_paused_at_stage,
    auto_recovery_attempts: Number(project.auto_recovery_attempts) || 0,
    auto_recovery_exhausted: Number(project.auto_recovery_exhausted) || 0,
    auto_recovery_last_strategy: project.auto_recovery_last_strategy || null,
  };
}

export function normalizeHealth(health) {
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
    project: buildProjectDetail(normalizedProject),
    scores: normalizedProject.scores,
    balance: normalizedProject.balance,
    weakest_dimension: normalizedProject.weakest_dimension,
  };
}

export function getProjectsFromResponse(data) {
  if (Array.isArray(data)) {
    return data.map(normalizeProject);
  }

  if (Array.isArray(data?.data)) {
    return data.data.map(normalizeProject);
  }

  if (Array.isArray(data?.projects)) {
    return data.projects.map(normalizeProject);
  }

  if (Array.isArray(data?.data?.projects)) {
    return data.data.projects.map(normalizeProject);
  }

  if (Array.isArray(data?.items)) {
    return data.items.map(normalizeProject);
  }

  if (Array.isArray(data?.data?.items)) {
    return data.data.items.map(normalizeProject);
  }

  return [];
}

export function buildDetailFallback(project) {
  if (!project) {
    return null;
  }

  const normalized = normalizeProject(project);
  return {
    project: buildProjectDetail(normalized),
    scores: normalized.scores,
    balance: normalized.balance,
    weakest_dimension: normalized.weakest_dimension,
  };
}

export function normalizeIntakeSource(source) {
  const normalized = String(source || '').trim().toLowerCase();

  if (normalized === 'conversation' || normalized === 'conversational') return 'conversation';
  if (normalized === 'github' || normalized === 'github_issue') return 'github';
  if (normalized === 'scout' || normalized === 'scheduled_scan') return 'scout';
  if (normalized === 'ci' || normalized === 'ci_failure') return 'ci';
  if (normalized === 'webhook') return 'webhook';
  if (normalized === 'manual' || normalized === 'api' || normalized === 'self_generated') return 'manual';

  return normalized || 'manual';
}

export function normalizeIntakeStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();

  if (normalized === 'pending' || normalized === 'intake') return 'pending';
  if (normalized === 'triaged' || normalized === 'prioritized' || normalized === 'planned') return 'triaged';
  if (normalized === 'in_progress' || normalized === 'in-progress' || normalized === 'executing' || normalized === 'verifying') return 'in_progress';
  if (normalized === 'completed' || normalized === 'shipped') return 'completed';
  if (normalized === 'rejected') return 'rejected';

  return normalized || 'pending';
}

export function normalizeIntakeItem(item = {}) {
  return {
    ...item,
    displaySource: normalizeIntakeSource(item.source),
    displayStatus: normalizeIntakeStatus(item.status),
  };
}

const INTAKE_CLOSED_STATUSES = new Set(['completed', 'shipped', 'rejected']);

function isOpenIntakeItem(item) {
  return !INTAKE_CLOSED_STATUSES.has(String(item?.status || '').toLowerCase());
}

export function getIntakeItemsFromResponse(data) {
  let raw = [];
  if (Array.isArray(data)) {
    raw = data;
  } else if (Array.isArray(data?.items)) {
    raw = data.items;
  } else if (Array.isArray(data?.data?.items)) {
    raw = data.data.items;
  }

  return raw.filter(isOpenIntakeItem).map(normalizeIntakeItem);
}

export function formatBalance(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00';
}

export function formatCurrency(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? USD_FORMATTER.format(numeric) : USD_FORMATTER.format(0);
}

export function formatTimestamp(value) {
  if (!value) {
    return 'Unknown';
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

export function formatRelativeTime(value, now = Date.now()) {
  if (!value) {
    return 'Unknown';
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return 'Unknown';
  }

  const diffMs = Math.max(0, now - timestamp.getTime());
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function truncateText(value, maxLength = 96) {
  if (!value) {
    return '';
  }

  const text = String(value).trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export function normalizeDecisionStage(stage) {
  const normalized = String(stage || '').trim().toLowerCase();

  if (!normalized) {
    return '';
  }

  if (normalized === 'ship') {
    return 'learn';
  }

  return normalized;
}

export function toConfidencePercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const percent = numeric > 1 ? numeric : numeric * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function getDecisionSinceParam(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeDecisionStats(stats = {}) {
  const byStage = Object.fromEntries(DECISION_STAGE_OPTIONS.map((stage) => [stage, 0]));

  for (const [stage, count] of Object.entries(stats?.by_stage || {})) {
    const normalizedStage = normalizeDecisionStage(stage);
    if (byStage[normalizedStage] !== undefined) {
      byStage[normalizedStage] = Number(count) || 0;
    }
  }

  return {
    total: Number(stats?.total) || 0,
    by_stage: byStage,
    avg_confidence: stats?.avg_confidence === null || stats?.avg_confidence === undefined
      ? null
      : Number(stats.avg_confidence),
  };
}

export function buildDecisionSummary(decisions = []) {
  const summary = normalizeDecisionStats();
  let confidenceCount = 0;
  let confidenceTotal = 0;

  for (const decision of decisions) {
    summary.total += 1;
    const normalizedStage = normalizeDecisionStage(decision?.stage);
    if (summary.by_stage[normalizedStage] !== undefined) {
      summary.by_stage[normalizedStage] += 1;
    }

    const numericConfidence = Number(decision?.confidence);
    if (Number.isFinite(numericConfidence)) {
      confidenceTotal += numericConfidence;
      confidenceCount += 1;
    }
  }

  summary.avg_confidence = confidenceCount > 0 ? confidenceTotal / confidenceCount : null;
  return summary;
}

export function getDigestEventCounts(events = []) {
  const counts = new Map();

  for (const event of events) {
    const eventType = event?.event_type || 'unknown';
    counts.set(eventType, (counts.get(eventType) || 0) + 1);
  }

  return Array.from(counts.entries()).map(([eventType, count]) => ({ eventType, count }));
}

export function normalizeIntakeSummaryStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();

  if (!normalized) {
    return 'pending';
  }

  if (normalized === 'pending' || normalized === 'intake') return 'pending';
  if (normalized === 'prioritized' || normalized === 'triaged') return 'prioritized';
  if (normalized === 'planned') return 'planned';
  if (normalized === 'executing' || normalized === 'in_progress') return 'executing';
  if (normalized === 'verifying') return 'verifying';
  if (normalized === 'shipped' || normalized === 'completed') return 'shipped';
  if (normalized === 'rejected') return 'rejected';

  return normalized;
}

export function getIntakeSummary(items = []) {
  const counts = Object.fromEntries(INTAKE_SUMMARY_ORDER.map((status) => [status, 0]));
  let other = 0;

  for (const item of items) {
    const status = normalizeIntakeSummaryStatus(item?.status || item?.displayStatus);
    if (counts[status] !== undefined) {
      counts[status] += 1;
    } else {
      other += 1;
    }
  }

  return { counts, other };
}

export function getScoreEntries(scores = {}) {
  return Object.entries(scores).sort((a, b) => a[1] - b[1]);
}

export function normalizeCostMetrics(metrics = {}) {
  return {
    cost_per_cycle: Number.isFinite(Number(metrics?.cost_per_cycle))
      ? Number(metrics.cost_per_cycle)
      : 0,
    cost_per_health_point: Number.isFinite(Number(metrics?.cost_per_health_point))
      ? Number(metrics.cost_per_health_point)
      : 0,
    provider_efficiency: Array.isArray(metrics?.provider_efficiency)
      ? metrics.provider_efficiency.map((entry) => ({
        provider: entry?.provider || 'unknown',
        total_cost: Number.isFinite(Number(entry?.total_cost)) ? Number(entry.total_cost) : 0,
        task_count: Number.isFinite(Number(entry?.task_count)) ? Number(entry.task_count) : 0,
        cost_per_task: Number.isFinite(Number(entry?.cost_per_task)) ? Number(entry.cost_per_task) : 0,
      }))
      : [],
  };
}

export function getScoreBarClass(score) {
  if (score >= 70) return 'bg-emerald-400';
  if (score >= 40) return 'bg-amber-400';
  return 'bg-rose-400';
}

export function normalizeBacklogItem(item = {}, index = 0) {
  return {
    work_item_id: item?.work_item_id ?? null,
    title: item?.title || 'Untitled work item',
    why: typeof item?.why === 'string' ? item.why.trim() : '',
    expected_impact: item?.expected_impact && typeof item.expected_impact === 'object' && !Array.isArray(item.expected_impact)
      ? item.expected_impact
      : {},
    scope_budget: item?.scope_budget ?? null,
    priority_rank: Number.isFinite(Number(item?.priority_rank)) ? Number(item.priority_rank) : index + 1,
  };
}

export function normalizeBacklogResponse(response = {}) {
  return {
    items: Array.isArray(response?.backlog)
      ? response.backlog.slice(0, 10).map((item, index) => normalizeBacklogItem(item, index))
      : [],
    reasoning_summary: response?.reasoning_summary || response?.reasoning || null,
    cycle_id: response?.cycle_id ?? null,
  };
}

export function formatCycleLabel(cycleId) {
  if (cycleId === null || cycleId === undefined || cycleId === '') {
    return 'No cycle yet';
  }

  const raw = String(cycleId).trim();
  return /^cycle\b/i.test(raw) ? raw : `Cycle #${raw}`;
}

export function formatScopeBudget(value) {
  if (value === null || value === undefined || value === '') {
    return 'Scope n/a';
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? `Scope ${numeric}` : `Scope ${String(value)}`;
}

export function formatImpactValue(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return `${numeric > 0 ? '+' : ''}${numeric}`;
  }

  return String(value || 'n/a');
}
