/**
 * Shared color constants for the TORQUE dashboard.
 * Import from here instead of hardcoding status colors in individual views.
 */

/** Text color classes for task statuses */
export const STATUS_COLORS = {
  completed: 'text-green-400',
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
  running: 'bg-blue-400',
  queued: 'bg-slate-400',
  failed: 'bg-red-400',
  cancelled: 'bg-amber-400',
  pending: 'bg-orange-400',
  pending_provider_switch: 'bg-orange-400',
};

/** Recharts hex colors for chart series */
export const CHART_COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#fb923c'];
