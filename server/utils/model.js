/**
 * Model classification utilities for TORQUE
 *
 * Replaces fragile regexes scattered across task-manager.js with
 * properly anchored parsers and consistent size classification.
 */

/**
 * Extract parameter count in billions from a model name.
 * Handles patterns like :32b, -7b, _14b, and decimals like :1.5b
 * @param {string} modelName - e.g. "some-model:32b", "gemma3:4b"
 * @returns {number} Size in billions, or 0 if unparseable
 */
function parseModelSizeB(modelName) {
  if (!modelName) return 0;
  const match = modelName.toLowerCase().match(/[:\-_](\d+(?:\.\d+)?)b/i);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * Classify a model into size categories.
 * @param {string} model
 * @returns {'small'|'medium'|'large'|'unknown'}
 */
function getModelSizeCategory(model) {
  const sizeB = parseModelSizeB(model);
  if (sizeB === 0) return 'unknown';
  if (sizeB <= 8) return 'small';
  if (sizeB <= 20) return 'medium';
  return 'large';
}

/**
 * Check if a model is "small" (<=8B or has mini/tiny in name).
 * @param {string} model
 * @returns {boolean}
 */
function isSmallModel(model) {
  if (!model) return false;
  const lower = model.toLowerCase();
  if (lower.includes('mini') || lower.includes('tiny')) return true;
  const sizeB = parseModelSizeB(model);
  return sizeB > 0 && sizeB <= 8;
}

/**
 * Check if a model is a "thinking" model that produces <think> tags.
 * @param {string} model
 * @returns {boolean}
 */
function isThinkingModel(model) {
  if (!model) return false;
  const lower = model.toLowerCase();
  return lower.includes('deepseek-r1') || lower.includes('qwq') ||
         lower.includes('deepseek-r2') || lower.includes('/r1');
}

module.exports = {
  parseModelSizeB,
  getModelSizeCategory,
  isSmallModel,
  isThinkingModel,
};
