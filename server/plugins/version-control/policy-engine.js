'use strict';

const { execFileSync } = require('child_process');

const CHECK_TIMEOUT_MS = 60_000;

function requireConfigResolver(configResolver) {
  if (!configResolver || typeof configResolver.getEffectiveConfig !== 'function') {
    throw new Error('createPolicyEngine requires configResolver.getEffectiveConfig(repoPath)');
  }
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function normalizeBranchName(value) {
  return requireString(value, 'branch').replace(/^refs\/heads\//, '');
}

function getArrayValue(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.trim()) : [];
}

function ensureTrailingSlash(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return '';
  }

  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function slugifyBranchPart(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, '')
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-')
    .replace(/\/-/g, '/')
    .replace(/-\//g, '/')
    .replace(/^[-/]+|[-/]+$/g, '');

  return normalized || 'branch';
}

function getProtectedBranches(config) {
  return getArrayValue(
    config?.branch_policy?.protected_branches
      ?? config?.protected_branches,
  );
}

function getBranchPrefixes(config) {
  return getArrayValue(
    config?.branch_policy?.branch_prefix
      ?? config?.branch_prefix,
  );
}

function getRequiredChecks(config) {
  return getArrayValue(
    config?.merge?.required_checks
      ?? config?.merge?.require_before_merge
      ?? config?.required_checks
      ?? config?.require_before_merge,
  );
}

function getPolicyMode(config, policyKey, fallbackMode) {
  const nestedMode = policyKey === 'protected_branches'
    ? config?.branch_policy?.policy_modes?.protected_branches
    : config?.merge?.policy_modes?.required_checks;
  const flatMode = config?.policy_modes?.[policyKey];
  const mode = typeof nestedMode === 'string' && nestedMode.trim()
    ? nestedMode.trim().toLowerCase()
    : (typeof flatMode === 'string' && flatMode.trim() ? flatMode.trim().toLowerCase() : fallbackMode);

  return mode === 'block' ? 'block' : 'warn';
}

function extractBranchNamePattern(config) {
  return config?.branch_policy?.branch_name_pattern
    ?? config?.branch_policy?.branch_name_regex
    ?? config?.branch_policy?.naming_regex
    ?? config?.branch_name_pattern
    ?? config?.branch_name_regex
    ?? config?.naming_regex
    ?? null;
}

function toRegExp(pattern) {
  if (pattern instanceof RegExp) {
    return pattern;
  }

  if (typeof pattern !== 'string' || !pattern.trim()) {
    return null;
  }

  const trimmed = pattern.trim();
  const match = /^\/(.+)\/([a-z]*)$/i.exec(trimmed);
  if (match) {
    return new RegExp(match[1], match[2]);
  }

  return new RegExp(trimmed);
}

function buildBranchSuggestion(branchName, config) {
  const normalized = normalizeBranchName(branchName);
  const prefixes = getBranchPrefixes(config).map(ensureTrailingSlash).filter(Boolean);
  const primaryPrefix = prefixes[0] || '';
  const subject = normalized.includes('/') ? normalized.split('/').pop() : normalized;
  const slug = slugifyBranchPart(subject);

  return primaryPrefix ? `${primaryPrefix}${slug}` : slug;
}

function formatCheckOutput(result, error) {
  if (typeof result === 'string' && result.trim()) {
    return result.trim();
  }

  const outputParts = [];
  for (const value of [error?.stdout, error?.stderr, error?.message]) {
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    if (typeof text === 'string' && text.trim()) {
      outputParts.push(text.trim());
    }
  }

  return outputParts.join('\n').trim();
}

function createPolicyEngine({ configResolver }) {
  requireConfigResolver(configResolver);

  function getEffectiveConfig(repoPath) {
    return configResolver.getEffectiveConfig(requireString(repoPath, 'repoPath')) || {};
  }

  function runRequiredChecks({ repoPath, checks }) {
    const repositoryPath = requireString(repoPath, 'repoPath');
    const normalizedChecks = getArrayValue(checks);

    return normalizedChecks.map((check) => {
      try {
        const output = execFileSync(check, {
          cwd: repositoryPath,
          encoding: 'utf8',
          timeout: CHECK_TIMEOUT_MS,
          windowsHide: true,
          shell: true,
        });

        return {
          check,
          passed: true,
          output: formatCheckOutput(output),
        };
      } catch (error) {
        return {
          check,
          passed: false,
          output: formatCheckOutput(null, error),
        };
      }
    });
  }

  function validateBeforeCommit({ repoPath, branch }) {
    const config = getEffectiveConfig(repoPath);
    const branchName = normalizeBranchName(branch);
    const protectedBranches = getProtectedBranches(config);
    const violations = protectedBranches.includes(branchName)
      ? [{
        type: 'protected_branch',
        branch: branchName,
        message: `Branch "${branchName}" is protected and cannot be committed to directly.`,
      }]
      : [];
    const mode = getPolicyMode(config, 'protected_branches', 'block');

    return {
      allowed: mode !== 'block' || violations.length === 0,
      violations,
    };
  }

  function validateBranchName({ repoPath, branchName }) {
    const config = getEffectiveConfig(repoPath);
    const normalizedBranchName = normalizeBranchName(branchName);
    const pattern = extractBranchNamePattern(config);

    if (!pattern) {
      return {
        valid: true,
        suggestion: null,
      };
    }

    let regex = null;
    try {
      regex = toRegExp(pattern);
    } catch {
      regex = null;
    }

    if (!regex || regex.test(normalizedBranchName)) {
      return {
        valid: true,
        suggestion: null,
      };
    }

    return {
      valid: false,
      suggestion: buildBranchSuggestion(normalizedBranchName, config),
    };
  }

  function validateBeforeMerge({ repoPath, branch, targetBranch }) {
    const config = getEffectiveConfig(repoPath);
    const sourceBranch = normalizeBranchName(branch);
    const destinationBranch = normalizeBranchName(targetBranch);
    const checks = getRequiredChecks(config);
    const checkResults = runRequiredChecks({
      repoPath,
      checks,
    });
    const violations = checkResults
      .filter((result) => !result.passed)
      .map((result) => ({
        type: 'required_check_failed',
        branch: sourceBranch,
        targetBranch: destinationBranch,
        check: result.check,
        message: `Required check failed before merging "${sourceBranch}" into "${destinationBranch}": ${result.check}`,
      }));
    const mode = getPolicyMode(config, 'required_checks', 'block');

    return {
      allowed: mode !== 'block' || violations.length === 0,
      violations,
      checkResults,
    };
  }

  return {
    validateBeforeCommit,
    validateBranchName,
    validateBeforeMerge,
    runRequiredChecks,
  };
}

module.exports = { createPolicyEngine };
