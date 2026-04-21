'use strict';

const BASE_BACKOFF_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;

function nextBackoffMs(attempts) {
  const n = Number.isFinite(attempts) && attempts >= 0 ? attempts : 0;
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, n), BACKOFF_CAP_MS);
}

function isWithinCooldown(lastActionAt, attempts, nowMs = Date.now()) {
  if (!lastActionAt) return false;
  const lastMs = Date.parse(lastActionAt);
  if (!Number.isFinite(lastMs)) return false;
  return (nowMs - lastMs) < nextBackoffMs(attempts);
}

module.exports = { BASE_BACKOFF_MS, BACKOFF_CAP_MS, nextBackoffMs, isWithinCooldown };
