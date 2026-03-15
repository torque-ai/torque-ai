/**
 * Shared utility functions for task handler sub-modules.
 * Extracted from task-handlers.js during decomposition.
 */

function formatTime(isoString) {
  if (!isoString) return 'N/A';
  const date = new Date(isoString);
  return date.toLocaleString('en-US');
}

function calculateDuration(start, end) {
  if (!start || !end) return 'N/A';
  const ms = new Date(end) - new Date(start);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

module.exports = { formatTime, calculateDuration };
