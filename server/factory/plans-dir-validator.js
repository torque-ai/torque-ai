'use strict';

const path = require('path');

const FORBIDDEN_SEGMENT = 'auto-generated';

function validatePlansDir({ projectPath, plansDir }) {
  if (!plansDir || typeof plansDir !== 'string') {
    return { ok: false, error: 'plans_dir must be a non-empty string' };
  }
  if (!projectPath || typeof projectPath !== 'string') {
    return { ok: false, error: 'projectPath must be a non-empty string' };
  }

  const absProject = path.resolve(projectPath);
  const absPlans = path.resolve(plansDir);

  // Boundary check: plansDir must be inside (or equal to) projectPath.
  // Use path.sep + path.relative semantics: if relative starts with ".."
  // (or is absolute on a different drive on Windows), it's outside.
  const rel = path.relative(absProject, absPlans);
  const isOutside = rel === '' ? false : (rel.startsWith('..') || path.isAbsolute(rel));
  if (isOutside) {
    return { ok: false, error: `plans_dir is outside project: ${absPlans}` };
  }

  // Segment check: reject if any path segment equals "auto-generated".
  // path.sep handles cross-platform separators; split-and-scan catches
  // both terminal and intermediate occurrences.
  const segments = absPlans.split(path.sep).filter(Boolean);
  if (segments.includes(FORBIDDEN_SEGMENT)) {
    return { ok: false, error: "plans_dir must not point at the factory's auto-generated output directory" };
  }

  return { ok: true };
}

module.exports = { validatePlansDir };
