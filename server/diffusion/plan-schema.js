'use strict';

const MAX_DIFFUSION_TASKS = 200;
const MAX_RECURSIVE_DEPTH = 2;

const REQUIRED_PLAN_FIELDS = ['summary', 'patterns', 'manifest'];
const REQUIRED_PATTERN_FIELDS = ['id', 'description', 'transformation', 'exemplar_files', 'exemplar_diff', 'file_count'];
const REQUIRED_MANIFEST_FIELDS = ['file', 'pattern'];

function validateDiffusionPlan(plan) {
  const errors = [];

  if (!plan || typeof plan !== 'object') {
    return { valid: false, errors: ['Plan must be a non-null object'] };
  }

  for (const field of REQUIRED_PLAN_FIELDS) {
    if (plan[field] === undefined || plan[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  if (typeof plan.summary === 'string' && plan.summary.trim() === '') {
    errors.push('summary must not be empty');
  }

  if (!Array.isArray(plan.patterns) || plan.patterns.length === 0) {
    errors.push('patterns must be a non-empty array');
  }

  const patternIds = new Set();
  if (Array.isArray(plan.patterns)) {
    for (const pattern of plan.patterns) {
      for (const field of REQUIRED_PATTERN_FIELDS) {
        if (pattern[field] === undefined || pattern[field] === null) {
          errors.push(`Pattern missing required field: ${field}`);
        }
      }
      if (pattern.id) patternIds.add(pattern.id);
    }
  }

  if (Array.isArray(plan.manifest)) {
    if (plan.manifest.length > MAX_DIFFUSION_TASKS) {
      errors.push(`Manifest has ${plan.manifest.length} entries, exceeds max of ${MAX_DIFFUSION_TASKS}. Narrow the scope.`);
    }
    for (const entry of plan.manifest) {
      for (const field of REQUIRED_MANIFEST_FIELDS) {
        if (!entry[field]) {
          errors.push(`Manifest entry missing required field: ${field}`);
        }
      }
      if (entry.pattern && !patternIds.has(entry.pattern)) {
        errors.push(`Manifest entry references nonexistent pattern: ${entry.pattern}`);
      }
    }
  }

  if (plan.isolation_confidence !== undefined) {
    if (typeof plan.isolation_confidence !== 'number' || plan.isolation_confidence < 0 || plan.isolation_confidence > 1) {
      errors.push('isolation_confidence must be a number between 0 and 1');
    }
  }

  if (Array.isArray(plan.shared_dependencies)) {
    for (const dep of plan.shared_dependencies) {
      if (!dep.file || typeof dep.file !== 'string') {
        errors.push('shared_dependencies entries must have a file field');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateDiffusionPlan,
  MAX_DIFFUSION_TASKS,
  MAX_RECURSIVE_DEPTH,
  REQUIRED_PLAN_FIELDS,
  REQUIRED_PATTERN_FIELDS,
  REQUIRED_MANIFEST_FIELDS,
};
