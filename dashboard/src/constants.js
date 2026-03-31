/**
 * Shared color constants for the TORQUE dashboard.
 * Import from here instead of hardcoding status colors in individual views.
 */

/** Text color classes for task statuses */
export const STATUS_COLORS = {
  completed: 'text-green-400',
  completed_with_errors: 'text-yellow-400',
  running: 'text-blue-400',
  queued: 'text-yellow-400',
  failed: 'text-red-400',
  cancelled: 'text-slate-400',
  pending: 'text-orange-400',
  pending_provider_switch: 'text-orange-400',
};

/** Background color classes for task statuses (badge backgrounds) */
export const STATUS_BG_COLORS = {
  completed: 'bg-green-500',
  completed_with_errors: 'bg-yellow-600',
  running: 'bg-blue-500',
  queued: 'bg-slate-500',
  failed: 'bg-red-500',
  cancelled: 'bg-amber-500',
  pending: 'bg-orange-500',
  pending_provider_switch: 'bg-orange-500',
};

/** Dot/indicator color classes for task statuses */
export const STATUS_DOT_COLORS = {
  completed: 'bg-green-400',
  completed_with_errors: 'bg-yellow-400',
  running: 'bg-blue-400',
  queued: 'bg-slate-400',
  failed: 'bg-red-400',
  cancelled: 'bg-amber-400',
  pending: 'bg-orange-400',
  pending_provider_switch: 'bg-orange-400',
};

/** Unicode symbol icons for task statuses — secondary visual indicator for colorblind accessibility */
export const STATUS_ICONS = {
  completed: '✓',
  completed_with_errors: '\u26A0',
  failed: '✗',
  running: '◉',
  queued: '◌',
  cancelled: '⊘',
  pending: '○',
  blocked: '⊞',
  skipped: '–',
};

export const PROVIDER_COLORS = {
  codex: 'text-green-400',
  'claude-cli': 'text-purple-400',
  ollama: 'text-blue-400',
  anthropic: 'text-violet-400',
  deepinfra: 'text-orange-400',
  hyperbolic: 'text-amber-400',
  groq: 'text-lime-400',
  cerebras: 'text-emerald-400',
  'google-ai': 'text-red-400',
  openrouter: 'text-pink-400',
  'ollama-cloud': 'text-sky-400',
  local: 'text-blue-400',
};

export const PROVIDER_HEX_COLORS = {
  codex: '#3b82f6',
  'claude-cli': '#8b5cf6',
  ollama: '#22c55e',
  anthropic: '#f59e0b',
  groq: '#ec4899',
  deepinfra: '#f97316',
  hyperbolic: '#a855f7',
  cerebras: '#06b6d4',
  'google-ai': '#4ade80',
  openrouter: '#fb923c',
  'ollama-cloud': '#34d399',
  local: '#22c55e',
};

/** Recharts hex colors for chart series */
export const CHART_COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#fb923c'];
