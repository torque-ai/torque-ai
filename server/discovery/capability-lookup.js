'use strict';

/**
 * Centralized capability lookup — queries the model_capabilities table.
 *
 * capColumn is NEVER user input — it is always a hardcoded column name passed
 * from calling code (e.g. 'cap_hashline', 'cap_agentic'). SQL interpolation
 * here is intentional and safe.
 */

function hasCapability(db, modelName, capColumn) {
  if (!db || !modelName) return false;
  try {
    const exact = db.prepare(
      `SELECT ${capColumn} FROM model_capabilities WHERE model_name = ?`
    ).get(modelName);
    if (exact) return exact[capColumn] === 1;

    // Base name match (strip :tag) — e.g., 'qwen3-coder:7b' matches 'qwen3-coder:30b'
    const baseName = modelName.split(':')[0];
    if (baseName !== modelName) {
      const base = db.prepare(
        `SELECT ${capColumn} FROM model_capabilities WHERE model_name LIKE ? AND ${capColumn} = 1 LIMIT 1`
      ).get(baseName + '%');
      if (base) return true;
    }
    return false;
  } catch { return false; }
}

function isHashlineCapable(db, modelName) {
  return hasCapability(db, modelName, 'cap_hashline');
}

function isAgenticCapable(db, modelName) {
  return hasCapability(db, modelName, 'cap_agentic');
}

function getModelCapabilities(db, modelName) {
  if (!db || !modelName) return null;
  try {
    return db.prepare(
      'SELECT cap_hashline, cap_agentic, cap_file_creation, cap_multi_file, capability_source FROM model_capabilities WHERE model_name = ?'
    ).get(modelName) || null;
  } catch { return null; }
}

module.exports = { isHashlineCapable, isAgenticCapable, getModelCapabilities, hasCapability };
