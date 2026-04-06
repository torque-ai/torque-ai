'use strict';

const EVIDENCE_WEIGHTS = Object.freeze({
  screenshot: 15,
  annotated_screenshot: 10,
  elements_tree: 20,
  measurements: 10,
  text_content: 10,
  annotation_index: 5,
  capture_data: 10,
  metadata: 10,
  app_type_extras: 10,
});

const MAX_SCORE = Object.values(EVIDENCE_WEIGHTS).reduce((total, value) => total + value, 0);

function isPresent(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return true;
}

function isImageBlobPresent(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return value.present === true;
}

function hasElementsTree(bundle) {
  return Array.isArray(bundle?.evidence?.elements?.tree) && bundle.evidence.elements.tree.length > 0;
}

function hasCaptureData(bundle) {
  return isPresent(bundle?.capture_data?.host) && isPresent(bundle?.capture_data?.process_name);
}

function hasMetadata(bundle) {
  return isPresent(bundle?.metadata?.framework);
}

function hasAppTypeExtras(bundle, appType) {
  if (appType === 'wpf') {
    return isPresent(bundle?.visual_tree);
  }
  if (appType === 'win32') {
    return isPresent(bundle?.hwnd_metadata);
  }
  if (appType.startsWith('electron')) {
    return isPresent(bundle?.devtools_protocol);
  }
  return isPresent(bundle?.performance_counters);
}

function toGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 70) return 'B';
  if (score >= 50) return 'C';
  if (score >= 30) return 'D';
  return 'F';
}

function scoreBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return {
      score: 0,
      max_score: MAX_SCORE,
      breakdown: {},
      missing: Object.keys(EVIDENCE_WEIGHTS),
    };
  }

  const appType = typeof bundle.app_type === 'string' && bundle.app_type.trim()
    ? bundle.app_type.trim()
    : 'unknown';

  const checks = {
    screenshot: isImageBlobPresent(bundle?.evidence?.screenshot),
    annotated_screenshot: isImageBlobPresent(bundle?.evidence?.annotated_screenshot),
    elements_tree: hasElementsTree(bundle),
    measurements: isPresent(bundle?.evidence?.measurements),
    text_content: isPresent(bundle?.evidence?.text_content),
    annotation_index: Array.isArray(bundle?.evidence?.annotation_index) && bundle.evidence.annotation_index.length > 0,
    capture_data: hasCaptureData(bundle),
    metadata: hasMetadata(bundle),
    app_type_extras: hasAppTypeExtras(bundle, appType),
  };

  const breakdown = {};
  const missing = [];
  let score = 0;

  for (const [key, weight] of Object.entries(EVIDENCE_WEIGHTS)) {
    if (checks[key]) {
      breakdown[key] = weight;
      score += weight;
    } else {
      breakdown[key] = 0;
      missing.push(key);
    }
  }

  const percentage = Math.round((score / MAX_SCORE) * 100);
  return {
    score,
    max_score: MAX_SCORE,
    percentage,
    grade: toGrade(score),
    breakdown,
    missing,
    app_type: appType,
  };
}

module.exports = {
  EVIDENCE_WEIGHTS,
  MAX_SCORE,
  scoreBundle,
};
