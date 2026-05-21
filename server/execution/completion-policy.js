'use strict';

const { normalizeMetadata } = require('../utils/normalize-metadata');

const FACTORY_STRUCTURED_OUTPUT_KINDS = new Set([
  'architect_cycle',
  'architect_json',
  'plan_generation',
  'plan_quality_review',
  'replan_decompose',
  'replan_rewrite',
  'retrospective_generation',
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

function isFactoryPlanExecutionTask(metadata) {
  const normalized = normalizeMetadata(metadata);
  return Boolean(
    normalized.plan_path
    && (
      normalized.plan_task_number !== undefined
      || normalized.plan_task_title
      || Array.isArray(normalized.file_paths)
    )
  );
}

function shouldUseOutputCompletionDetection(proc) {
  if (!proc) return false;
  return !isFactoryStructuredOutputTask(proc.metadata)
    && !isScoutStructuredOutputTask(proc.metadata)
    && !isFactoryPlanExecutionTask(proc.metadata);
}

module.exports = {
  FACTORY_STRUCTURED_OUTPUT_KINDS,
  isFactoryStructuredOutputTask,
  isScoutStructuredOutputTask,
  isFactoryPlanExecutionTask,
  shouldUseOutputCompletionDetection,
};
