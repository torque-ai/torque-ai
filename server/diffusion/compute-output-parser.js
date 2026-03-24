'use strict';

const logger = require('../logger').child({ component: 'compute-output-parser' });

function parseComputeOutput(output) {
  if (!output || typeof output !== 'string') return null;

  const trimmed = output.trim();
  if (!trimmed) return null;

  // Try 1: Direct JSON parse
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && parsed.file_edits) return parsed;
  } catch (_) { /* not clean JSON */ }

  // Try 2: Extract from markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && parsed.file_edits) return parsed;
    } catch (_) { /* fence content not valid JSON */ }
  }

  // Try 3: Find JSON object with file_edits key anywhere in output
  const jsonStart = trimmed.indexOf('{"file_edits"');
  if (jsonStart === -1) {
    const altStart = trimmed.indexOf('{\n');
    if (altStart >= 0) {
      try {
        const candidate = trimmed.slice(altStart);
        let depth = 0;
        let end = -1;
        for (let i = 0; i < candidate.length; i++) {
          if (candidate[i] === '{') depth++;
          if (candidate[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        if (end > 0) {
          const parsed = JSON.parse(candidate.slice(0, end));
          if (parsed && parsed.file_edits) return parsed;
        }
      } catch (_) { /* not valid */ }
    }
    return null;
  }

  try {
    const candidate = trimmed.slice(jsonStart);
    let depth = 0;
    let end = -1;
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] === '{') depth++;
      if (candidate[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end > 0) {
      const parsed = JSON.parse(candidate.slice(0, end));
      if (parsed && parsed.file_edits) return parsed;
    }
  } catch (err) {
    logger.info(`[ComputeOutputParser] JSON extraction failed: ${err.message}`);
  }

  return null;
}

function validateComputeSchema(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Compute output must be a non-null object'] };
  }

  if (!Array.isArray(data.file_edits)) {
    errors.push('Missing required field: file_edits (must be an array)');
    return { valid: false, errors };
  }

  if (data.file_edits.length === 0) {
    errors.push('file_edits must not be empty');
    return { valid: false, errors };
  }

  for (let i = 0; i < data.file_edits.length; i++) {
    const edit = data.file_edits[i];
    if (!edit.file || typeof edit.file !== 'string') {
      errors.push(`file_edits[${i}]: missing or invalid file path`);
    }
    if (!Array.isArray(edit.operations) || edit.operations.length === 0) {
      errors.push(`file_edits[${i}]: missing or empty operations array`);
      continue;
    }
    for (let j = 0; j < edit.operations.length; j++) {
      const op = edit.operations[j];
      if (op.old_text === undefined || op.old_text === null) {
        errors.push(`file_edits[${i}].operations[${j}]: missing old_text`);
      }
      if (op.new_text === undefined && op.type !== 'delete') {
        errors.push(`file_edits[${i}].operations[${j}]: missing new_text`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { parseComputeOutput, validateComputeSchema };
