// Work-item detail builders. Each produces a short human-readable string
// that ends up embedded in the plan prompt or evidence trail. Pure helpers
// over already-extracted accessor and scope-search modules.
//
// Extracted from server/factory/loop-controller.js as part of Phase 1a of
// the god-object refactor. Behavior preserved; no signature changes.

const {
  getWorkItemConstraintsObject,
  getWorkItemOriginObject,
  extractWorkItemAcceptanceCriteria,
  getWorkItemDetail,
} = require('../shared/workitem-accessors');
const {
  collectArchitectHardScopeFiles,
  collectArchitectScopeFiles,
} = require('../shared/scope-search');

function buildWorkItemValidationDetail(workItem) {
  return getWorkItemDetail(workItem, [
    'validation',
    'verification',
    'validation_command',
    'verify_command',
    'validation_steps',
    'test_command',
  ]);
}

function buildWorkItemSuccessDetail(workItem) {
  return extractWorkItemAcceptanceCriteria(workItem)
    || getWorkItemDetail(workItem, [
      'acceptance_criteria',
      'success_criteria',
      'done_when',
      'expected_result',
    ])
    || `work item #${workItem?.id || 'current'} is satisfied using the scoped files and unrelated files are left unchanged`;
}

function buildWorkItemScopeDetail(workItem) {
  const constraints = getWorkItemConstraintsObject(workItem);
  const origin = getWorkItemOriginObject(workItem);
  const hardScopeFiles = collectArchitectHardScopeFiles(workItem);
  const scopeFiles = collectArchitectScopeFiles(workItem);
  const allowedFiles = hardScopeFiles.length > 0 ? hardScopeFiles : scopeFiles;
  const maxFiles = Number(constraints.max_files || origin.max_files);

  if (allowedFiles.length > 0) {
    const fileList = allowedFiles.map((file) => `\`${file}\``).join(', ');
    const fileCount = Number.isFinite(maxFiles) && maxFiles > 0
      ? `up to ${maxFiles} file${maxFiles === 1 ? '' : 's'}`
      : `${allowedFiles.length} file${allowedFiles.length === 1 ? '' : 's'}`;
    const qualifier = hardScopeFiles.length > 0 ? 'limited to' : 'centered on';
    return `${fileCount}, ${qualifier} ${fileList}`;
  }

  if (Number.isFinite(maxFiles) && maxFiles > 0) {
    return `up to ${maxFiles} file${maxFiles === 1 ? '' : 's'}`;
  }

  return null;
}

module.exports = {
  buildWorkItemValidationDetail,
  buildWorkItemSuccessDetail,
  buildWorkItemScopeDetail,
};
