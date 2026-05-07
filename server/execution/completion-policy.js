'use strict';

const { normalizeMetadata } = require('../utils/normalize-metadata');

const FACTORY_STRUCTURED_OUTPUT_KINDS = new Set([
  'architect_cycle',
  'plan_generation',
  'plan_quality_review',
  'scout',
  'verify_review',
]);

function isFactoryStructuredOutputTask(metadata) {
  const normalized = normalizeMetadata(metadata);
  return normalized.factory_internal === true
    && FACTORY_STRUCTURED_OUTPUT_KINDS.has(String(normalized.kind || '').trim());
}

function isScoutStructuredOutputTask(metadata) {
  const normalized = normalizeMetadata(metadata);
  const mode = String(normalized.mode || '').trim();
  const reason = String(normalized.reason || '').trim();
  return mode === 'scout'
    || reason === 'factory_starvation_recovery'
    || String(normalized.kind || '').trim() === 'scout';
}

function shouldUseOutputCompletionDetection(proc) {
  if (!proc) return false;
  return !isFactoryStructuredOutputTask(proc.metadata)
    && !isScoutStructuredOutputTask(proc.metadata);
}

module.exports = {
  FACTORY_STRUCTURED_OUTPUT_KINDS,
  isFactoryStructuredOutputTask,
  isScoutStructuredOutputTask,
  shouldUseOutputCompletionDetection,
};
