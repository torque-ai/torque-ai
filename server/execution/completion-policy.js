'use strict';

const { normalizeMetadata } = require('../utils/normalize-metadata');

const FACTORY_STRUCTURED_OUTPUT_KINDS = new Set([
  'architect_cycle',
  'plan_generation',
  'plan_quality_review',
  'verify_review',
]);

function isFactoryStructuredOutputTask(metadata) {
  const normalized = normalizeMetadata(metadata);
  return normalized.factory_internal === true
    && FACTORY_STRUCTURED_OUTPUT_KINDS.has(String(normalized.kind || '').trim());
}

function shouldUseOutputCompletionDetection(proc) {
  if (!proc) return false;
  return !isFactoryStructuredOutputTask(proc.metadata);
}

module.exports = {
  FACTORY_STRUCTURED_OUTPUT_KINDS,
  isFactoryStructuredOutputTask,
  shouldUseOutputCompletionDetection,
};
