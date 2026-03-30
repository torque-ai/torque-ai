'use strict';

/**
 * Score a peek investigation bundle's evidence quality on a 0-100 scale.
 * Used to establish baseline quality metrics before sensor fusion.
 */

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

const MAX_SCORE = Object.values(EVIDENCE_WEIGHTS).reduce((total, weight) => total + weight, 0);

function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function isImageBlobPresent(blob) {
  return blob && typeof blob === 'object' && blob.present === true;
}

function scoreBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    return {
      score: 0,
      max_score: MAX_SCORE,
      breakdown: {},
      missing: Object.keys(EVIDENCE_WEIGHTS),
    };
  }

  const evidence = bundle.evidence || {};
  const breakdown = {};
  const missing = [];

  if (isImageBlobPresent(evidence.screenshot)) {
    breakdown.screenshot = EVIDENCE_WEIGHTS.screenshot;
  } else {
    missing.push('screenshot');
    breakdown.screenshot = 0;
  }

  if (isImageBlobPresent(evidence.annotated_screenshot)) {
    breakdown.annotated_screenshot = EVIDENCE_WEIGHTS.annotated_screenshot;
  } else {
    missing.push('annotated_screenshot');
    breakdown.annotated_screenshot = 0;
  }

  const elements = evidence.elements;
  if (elements && typeof elements === 'object' && Array.isArray(elements.tree) && elements.tree.length > 0) {
    breakdown.elements_tree = EVIDENCE_WEIGHTS.elements_tree;
  } else {
    missing.push('elements_tree');
    breakdown.elements_tree = 0;
  }

  if (isPresent(evidence.measurements)) {
    breakdown.measurements = EVIDENCE_WEIGHTS.measurements;
  } else {
    missing.push('measurements');
    breakdown.measurements = 0;
  }

  if (isPresent(evidence.text_content)) {
    breakdown.text_content = EVIDENCE_WEIGHTS.text_content;
  } else {
    missing.push('text_content');
    breakdown.text_content = 0;
  }

  if (Array.isArray(evidence.annotation_index) && evidence.annotation_index.length > 0) {
    breakdown.annotation_index = EVIDENCE_WEIGHTS.annotation_index;
  } else {
    missing.push('annotation_index');
    breakdown.annotation_index = 0;
  }

  if (isPresent(bundle.capture_data) && bundle.capture_data.host && bundle.capture_data.process_name) {
    breakdown.capture_data = EVIDENCE_WEIGHTS.capture_data;
  } else {
    missing.push('capture_data');
    breakdown.capture_data = 0;
  }

  if (isPresent(bundle.metadata) && bundle.metadata.framework) {
    breakdown.metadata = EVIDENCE_WEIGHTS.metadata;
  } else {
    missing.push('metadata');
    breakdown.metadata = 0;
  }

  const appType = bundle.app_type || '';
  let hasExtras = false;

  if (appType === 'wpf' && isPresent(bundle.visual_tree)) hasExtras = true;
  if (appType === 'win32' && isPresent(bundle.hwnd_metadata)) hasExtras = true;
  if (appType.startsWith('electron') && isPresent(bundle.devtools_protocol)) hasExtras = true;
  if (appType === 'winforms' && isPresent(bundle.component_model)) hasExtras = true;
  if (appType === 'qt' && isPresent(bundle.qt_object_tree)) hasExtras = true;
  if (isPresent(bundle.performance_counters)) hasExtras = true;

  if (hasExtras) {
    breakdown.app_type_extras = EVIDENCE_WEIGHTS.app_type_extras;
  } else {
    missing.push('app_type_extras');
    breakdown.app_type_extras = 0;
  }

  const score = Object.values(breakdown).reduce((total, value) => total + value, 0);

  return {
    score,
    max_score: MAX_SCORE,
    percentage: Math.round((score / MAX_SCORE) * 100),
    grade: score >= 90 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : score >= 30 ? 'D' : 'F',
    breakdown,
    missing,
    app_type: appType || 'unknown',
  };
}

module.exports = {
  EVIDENCE_WEIGHTS,
  MAX_SCORE,
  scoreBundle,
};
