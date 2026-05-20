// Project-config accessors. Pure unpackers over the project row's
// `config` object (parsed if it arrived as JSON in `config_json`).
//
// Extracted from server/factory/loop-controller.js as the final Phase 1a-prep
// step before plan-builders themselves move. No behavior change.

function parseProjectConfigObject(project) {
  if (project?.config && typeof project.config === 'object') {
    return project.config;
  }
  try {
    return project?.config_json ? JSON.parse(project.config_json) : {};
  } catch (_err) {
    void _err;
    return {};
  }
}

function getProjectConfigForPlanGate(project) {
  return parseProjectConfigObject(project);
}

function isRemoteVerificationDisabled(projectOrConfig) {
  const cfg = projectOrConfig && (
    projectOrConfig.config || projectOrConfig.config_json
      ? parseProjectConfigObject(projectOrConfig)
      : projectOrConfig
  );
  return cfg?.prefer_remote_tests === false || cfg?.remote_tests === false;
}

function getProjectVerifyCommand(projectOrConfig) {
  const cfg = projectOrConfig && (
    projectOrConfig.config || projectOrConfig.config_json
      ? parseProjectConfigObject(projectOrConfig)
      : projectOrConfig
  );
  return typeof cfg?.verify_command === 'string' && cfg.verify_command.trim()
    ? cfg.verify_command.trim()
    : null;
}

/**
 * Resolve the project's "expected" provider as declared in its lane policy.
 * Returns the lowercased provider name (e.g. "ollama", "codex") or null when
 * no policy is configured. Callers use this to short-circuit smart-routing
 * defaults onto a project-pinned lane — typically when a project has a known
 * small local model on the `ollama` lane.
 */
function getEffectiveProjectProvider(project) {
  try {
    const cfg = parseProjectConfigObject(project);
    const policy = cfg?.provider_lane_policy || cfg?.provider_lane;
    const expected = policy && typeof policy === 'object' ? policy.expected_provider : null;
    return typeof expected === 'string' && expected.trim() ? expected.trim().toLowerCase() : null;
  } catch (_err) {
    void _err;
    return null;
  }
}

module.exports = {
  parseProjectConfigObject,
  getProjectConfigForPlanGate,
  getEffectiveProjectProvider,
  getProjectVerifyCommand,
  isRemoteVerificationDisabled,
};
