'use strict';

const packageInfo = require('../package.json');
const { checkDependencies } = require('./platform/detect');

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeDependencyReport(report) {
  const normalized = report && typeof report === 'object' ? report : {};

  return {
    platform: normalized.platform || process.platform,
    supported: Boolean(normalized.supported),
    adapter: normalized.adapter || null,
    ok: Boolean(normalized.ok),
    available: toArray(normalized.available),
    missing: toArray(normalized.missing),
    checks: toArray(normalized.checks),
    capabilities: toArray(normalized.capabilities),
    error: normalized.error,
  };
}

function createHealthReporter(options = {}) {
  const dependencyChecker = options.checkDependencies || checkDependencies;
  const startedAt = Number.isFinite(options.startedAt) ? options.startedAt : Date.now();
  const version = options.version || packageInfo.version;
  const platformOptions = options.platformOptions || {};
  let cachedReport = null;

  function getDependencyReport() {
    if (cachedReport) return cachedReport;

    try {
      cachedReport = normalizeDependencyReport(dependencyChecker(platformOptions));
    } catch (error) {
      cachedReport = normalizeDependencyReport({
        platform: process.platform,
        supported: false,
        ok: false,
        available: [],
        missing: [],
        checks: [],
        capabilities: [],
        error: error && error.message ? error.message : String(error),
      });
    }

    return cachedReport;
  }

  return function reportHealth() {
    const dependencyReport = getDependencyReport();
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    const uptimeSeconds = Math.max(0, (now - startedAt) / 1000);

    const dependencies = {
      ok: dependencyReport.ok,
      available: dependencyReport.available,
      missing: dependencyReport.missing,
      checks: dependencyReport.checks,
    };

    if (dependencyReport.error) {
      dependencies.error = dependencyReport.error;
    }

    return {
      success: true,
      status: dependencyReport.ok ? 'healthy' : 'degraded',
      platform: dependencyReport.platform,
      supported: dependencyReport.supported,
      adapter: dependencyReport.adapter,
      capabilities: dependencyReport.capabilities,
      version,
      uptime_seconds: uptimeSeconds,
      dependencies,
    };
  };
}

function createHealthHandler(options = {}) {
  const reportHealth = createHealthReporter(options);

  return async function healthHandler(ctx) {
    return ctx.json(200, reportHealth());
  };
}

module.exports = {
  createHealthHandler,
  createHealthReporter,
  normalizeDependencyReport,
};
