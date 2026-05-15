// Pure accessor helpers for factory work items. Reads structured fields
// (constraints, origin, acceptance criteria, detail keys) off a work-item
// row without touching the DB or any shared state.
//
// Extracted from server/factory/loop-controller.js as Phase 1a-prep of the
// god-object refactor. Behavior preserved; no signature changes.
//
// Note: `parseJsonObject` is duplicated locally rather than cross-imported.
// A repo-wide consolidation of the ~10 existing copies is out of scope for
// this phase.

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getWorkItemConstraintsObject(workItem) {
  if (workItem?.constraints && typeof workItem.constraints === 'object') {
    return workItem.constraints;
  }
  return parseJsonObject(workItem?.constraints_json) || {};
}

function getWorkItemOriginObject(workItem) {
  if (workItem?.origin && typeof workItem.origin === 'object') {
    return { ...workItem.origin };
  }
  return { ...(parseJsonObject(workItem?.origin_json) || {}) };
}

function extractWorkItemAcceptanceCriteria(workItem) {
  const description = String(workItem?.description || '');
  const match = description.match(/\bAcceptance criteria:\s*([\s\S]+)$/i);
  if (!match) return null;
  const firstBlock = String(match[1] || '').split(/\r?\n\s*\r?\n/)[0].trim();
  if (!firstBlock) return null;
  return firstBlock.replace(/\s+/g, ' ').slice(0, 800);
}

function normalizeWorkItemDetail(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
    return parts.length > 0 ? parts.join('; ') : null;
  }
  return null;
}

function getWorkItemDetail(workItem, keys) {
  const origin = getWorkItemOriginObject(workItem);
  const constraints = getWorkItemConstraintsObject(workItem);
  for (const source of [constraints, origin]) {
    for (const key of keys) {
      const detail = normalizeWorkItemDetail(source?.[key]);
      if (detail) return detail;
    }
  }
  return null;
}

module.exports = {
  getWorkItemConstraintsObject,
  getWorkItemOriginObject,
  extractWorkItemAcceptanceCriteria,
  normalizeWorkItemDetail,
  getWorkItemDetail,
};
