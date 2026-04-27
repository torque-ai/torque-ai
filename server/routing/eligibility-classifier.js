'use strict';

const CODEX_ONLY_CATEGORIES = new Set([
  'architectural',
  'large_code_gen',
  'xaml_wpf',
  'security',
  'reasoning',
]);

const FREE_ELIGIBLE_CATEGORIES = new Set([
  'simple_generation',
  'targeted_file_edit',
  'documentation',
  'default',
]);

const SIZE_CAP_FILES = 3;
const SIZE_CAP_LINES = 200;

function estimateSize(plan) {
  if (!plan || !Array.isArray(plan.tasks)) return { files: 0, lines: 0 };
  const fileSet = new Set();
  let lines = 0;
  for (const task of plan.tasks) {
    if (Array.isArray(task.files_touched)) {
      for (const f of task.files_touched) fileSet.add(f);
    }
    if (Number.isFinite(task.estimated_lines)) lines += task.estimated_lines;
  }
  return { files: fileSet.size, lines };
}

function classify(workItem, plan, projectConfig = {}) {
  const policy = projectConfig.codex_fallback_policy;
  if (policy === 'wait_for_codex') {
    return { eligibility: 'codex_only', reason: 'project_policy:wait_for_codex' };
  }

  const category = workItem?.category || 'default';

  if (CODEX_ONLY_CATEGORIES.has(category)) {
    return { eligibility: 'codex_only', reason: `category_codex_only:${category}` };
  }

  if (!FREE_ELIGIBLE_CATEGORIES.has(category)) {
    // Unknown category — treat as codex_only conservatively.
    return { eligibility: 'codex_only', reason: `category_unknown:${category}` };
  }

  const { files, lines } = estimateSize(plan);
  if (files > SIZE_CAP_FILES) {
    return { eligibility: 'codex_only', reason: `size_cap_exceeded:files=${files}` };
  }
  if (lines > SIZE_CAP_LINES) {
    return { eligibility: 'codex_only', reason: `size_cap_exceeded:lines=${lines}` };
  }

  return { eligibility: 'free', reason: `size_within_cap:files=${files},lines=${lines}` };
}

module.exports = {
  classify,
  CODEX_ONLY_CATEGORIES,
  FREE_ELIGIBLE_CATEGORIES,
  SIZE_CAP_FILES,
  SIZE_CAP_LINES,
};
