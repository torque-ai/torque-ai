'use strict';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  const result = {};
  for (const [key, entryValue] of Object.entries(value)) {
    result[key] = cloneValue(entryValue);
  }

  return result;
}

function mergeObjects(base, override) {
  const result = {};
  const baseObject = isRecord(base) ? base : {};
  const overrideObject = isRecord(override) ? override : {};
  const keys = new Set([
    ...Object.keys(baseObject),
    ...Object.keys(overrideObject),
  ]);

  for (const key of keys) {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrideObject, key);
    const baseValue = baseObject[key];
    const overrideValue = overrideObject[key];

    if (!hasOverride) {
      result[key] = cloneValue(baseValue);
      continue;
    }

    if (isRecord(baseValue) && isRecord(overrideValue)) {
      result[key] = mergeObjects(baseValue, overrideValue);
      continue;
    }

    result[key] = cloneValue(overrideValue);
  }

  return result;
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isHour(value) {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

function addArrayStringError(errors, value, fieldName) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    errors.push(`${fieldName} must be an array of strings`);
  }
}

function getCurrentHour(timezone) {
  if (typeof timezone !== 'string' || !timezone.trim()) {
    return new Date().getHours();
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: timezone.trim(),
    });
    const hourPart = formatter.formatToParts(new Date()).find((part) => part.type === 'hour');
    const hour = Number(hourPart && hourPart.value);

    return Number.isInteger(hour) ? hour : new Date().getHours();
  } catch {
    return new Date().getHours();
  }
}

function isHourAllowed(hour, start, end) {
  if (start === end) {
    return true;
  }

  if (start < end) {
    return hour >= start && hour < end;
  }

  return hour >= start || hour < end;
}

const DEFAULT_POLICY = Object.freeze({
  budget_ceiling: null,
  scope_ceiling: Object.freeze({ max_tasks: 20, max_files_per_task: 10 }),
  blast_radius_percent: 5,
  restricted_paths: Object.freeze([]),
  required_checks: Object.freeze([]),
  escalation_rules: Object.freeze({
    security_findings: true,
    health_drop_threshold: 10,
    breaking_changes: true,
    budget_warning_percent: 80,
  }),
  work_hours: null,
  provider_restrictions: Object.freeze([]),
});

function validatePolicy(policy) {
  if (!isRecord(policy)) {
    return {
      valid: false,
      errors: ['policy must be an object'],
    };
  }

  const errors = [];

  if (policy.budget_ceiling !== undefined && policy.budget_ceiling !== null && !isPositiveNumber(policy.budget_ceiling)) {
    errors.push('budget_ceiling must be null or a positive number');
  }

  if (policy.scope_ceiling !== undefined) {
    if (!isRecord(policy.scope_ceiling)) {
      errors.push('scope_ceiling must be an object');
    } else {
      if (policy.scope_ceiling.max_tasks !== undefined && !isPositiveInteger(policy.scope_ceiling.max_tasks)) {
        errors.push('scope_ceiling.max_tasks must be a positive integer');
      }

      if (policy.scope_ceiling.max_files_per_task !== undefined && !isPositiveInteger(policy.scope_ceiling.max_files_per_task)) {
        errors.push('scope_ceiling.max_files_per_task must be a positive integer');
      }
    }
  }

  if (policy.blast_radius_percent !== undefined) {
    const value = policy.blast_radius_percent;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 100) {
      errors.push('blast_radius_percent must be a number between 1 and 100');
    }
  }

  if (policy.restricted_paths !== undefined) {
    addArrayStringError(errors, policy.restricted_paths, 'restricted_paths');
  }

  if (policy.required_checks !== undefined) {
    addArrayStringError(errors, policy.required_checks, 'required_checks');
  }

  if (policy.escalation_rules !== undefined) {
    if (!isRecord(policy.escalation_rules)) {
      errors.push('escalation_rules must be an object');
    } else {
      const escalationRules = policy.escalation_rules;

      if (escalationRules.security_findings !== undefined && typeof escalationRules.security_findings !== 'boolean') {
        errors.push('escalation_rules.security_findings must be a boolean');
      }

      if (escalationRules.health_drop_threshold !== undefined
        && (typeof escalationRules.health_drop_threshold !== 'number' || !Number.isFinite(escalationRules.health_drop_threshold))) {
        errors.push('escalation_rules.health_drop_threshold must be a number');
      }

      if (escalationRules.breaking_changes !== undefined && typeof escalationRules.breaking_changes !== 'boolean') {
        errors.push('escalation_rules.breaking_changes must be a boolean');
      }

      if (escalationRules.budget_warning_percent !== undefined
        && (typeof escalationRules.budget_warning_percent !== 'number' || !Number.isFinite(escalationRules.budget_warning_percent))) {
        errors.push('escalation_rules.budget_warning_percent must be a number');
      }
    }
  }

  if (policy.work_hours !== undefined && policy.work_hours !== null) {
    if (!isRecord(policy.work_hours)) {
      errors.push('work_hours must be null or an object');
    } else {
      if (!Object.prototype.hasOwnProperty.call(policy.work_hours, 'start') || !isHour(policy.work_hours.start)) {
        errors.push('work_hours.start must be an integer between 0 and 23');
      }

      if (!Object.prototype.hasOwnProperty.call(policy.work_hours, 'end') || !isHour(policy.work_hours.end)) {
        errors.push('work_hours.end must be an integer between 0 and 23');
      }

      if (policy.work_hours.timezone !== undefined && typeof policy.work_hours.timezone !== 'string') {
        errors.push('work_hours.timezone must be a string');
      }
    }
  }

  if (policy.provider_restrictions !== undefined) {
    addArrayStringError(errors, policy.provider_restrictions, 'provider_restrictions');
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function mergeWithDefaults(policy) {
  return mergeObjects(DEFAULT_POLICY, policy);
}

function checkScopeAllowed(policy, taskCount) {
  const effectivePolicy = mergeWithDefaults(policy);
  const normalizedTaskCount = Number(taskCount);
  const maxTasks = effectivePolicy.scope_ceiling.max_tasks;

  if (normalizedTaskCount <= maxTasks) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Task count ${normalizedTaskCount} exceeds scope ceiling of ${maxTasks}`,
  };
}

function checkBlastRadius(policy, filesChanged, totalFiles) {
  const effectivePolicy = mergeWithDefaults(policy);
  const normalizedFilesChanged = Number(filesChanged);
  const normalizedTotalFiles = Number(totalFiles);
  let percent = 0;

  if (normalizedTotalFiles > 0) {
    percent = (normalizedFilesChanged / normalizedTotalFiles) * 100;
  } else if (normalizedFilesChanged > 0) {
    percent = 100;
  }

  if (percent <= effectivePolicy.blast_radius_percent) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Blast radius ${percent.toFixed(2)}% exceeds limit of ${effectivePolicy.blast_radius_percent}%`,
    percent,
  };
}

function checkRestrictedPaths(policy, filePaths) {
  const effectivePolicy = mergeWithDefaults(policy);
  const files = Array.isArray(filePaths) ? filePaths : [];
  const restricted = files.filter((filePath) => (
    typeof filePath === 'string'
      && effectivePolicy.restricted_paths.some((restrictedPath) => filePath.startsWith(restrictedPath))
  ));

  return { restricted };
}

function checkWorkHours(policy) {
  const effectivePolicy = mergeWithDefaults(policy);
  const workHours = effectivePolicy.work_hours;

  if (workHours === null) {
    return { allowed: true };
  }

  const currentHour = getCurrentHour(workHours.timezone);
  if (isHourAllowed(currentHour, workHours.start, workHours.end)) {
    return { allowed: true };
  }

  const timezoneSuffix = typeof workHours.timezone === 'string' && workHours.timezone.trim()
    ? ` ${workHours.timezone.trim()}`
    : '';

  return {
    allowed: false,
    reason: `Current hour ${currentHour} is outside allowed work hours ${workHours.start}:00-${workHours.end}:00${timezoneSuffix}`,
    next_window: workHours.start,
  };
}

function checkProviderAllowed(policy, provider) {
  const effectivePolicy = mergeWithDefaults(policy);
  const restrictions = effectivePolicy.provider_restrictions;

  if (!restrictions.length || restrictions.includes(provider)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Provider "${provider}" is not allowed by policy`,
  };
}

function shouldEscalate(policy, event) {
  const effectivePolicy = mergeWithDefaults(policy);
  const normalizedEvent = isRecord(event) ? event : {};
  const escalationRules = effectivePolicy.escalation_rules;

  if (normalizedEvent.type === 'security_finding' && escalationRules.security_findings) {
    return {
      escalate: true,
      reason: 'Security finding requires escalation',
    };
  }

  if (normalizedEvent.type === 'health_drop'
    && Number(normalizedEvent.delta) >= escalationRules.health_drop_threshold) {
    return {
      escalate: true,
      reason: `Health dropped by ${Number(normalizedEvent.delta)} which meets or exceeds the threshold of ${escalationRules.health_drop_threshold}`,
    };
  }

  if (normalizedEvent.type === 'breaking_change' && escalationRules.breaking_changes) {
    return {
      escalate: true,
      reason: 'Breaking change requires escalation',
    };
  }

  if (normalizedEvent.type === 'budget_warning'
    && Number(normalizedEvent.percent) >= escalationRules.budget_warning_percent) {
    return {
      escalate: true,
      reason: `Budget warning at ${Number(normalizedEvent.percent)}% meets or exceeds the threshold of ${escalationRules.budget_warning_percent}%`,
    };
  }

  return { escalate: false };
}

module.exports = {
  DEFAULT_POLICY,
  validatePolicy,
  mergeWithDefaults,
  checkScopeAllowed,
  checkBlastRadius,
  checkRestrictedPaths,
  checkWorkHours,
  checkProviderAllowed,
  shouldEscalate,
};
