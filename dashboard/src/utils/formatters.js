import { format } from 'date-fns';

/**
 * Format a duration in seconds to human-readable string.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return 'N/A';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * Format a duration in milliseconds.
 * @param {number} ms
 * @returns {string}
 */
export function formatDurationMs(ms) {
  return formatDuration((ms || 0) / 1000);
}

/**
 * Format a date to a consistent datetime string using date-fns.
 * @param {string|Date} date
 * @returns {string}
 */
export function formatDate(date) {
  if (!date) return 'N/A';
  try {
    return format(new Date(date), 'MMM d, yyyy HH:mm');
  } catch {
    return String(date);
  }
}
