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

/**
 * Semantic validation of compute edits against the actual file content.
 * Catches issues that schema validation can't: orphaned references,
 * incomplete removals, base class conflicts.
 *
 * @param {object} computeOutput - Parsed compute output with file_edits
 * @param {function} readFile - Function that reads file content: (path) => string
 * @returns {{ warnings: string[], file_edits: object[] }} - Filtered edits + warnings
 */
function semanticValidateEdits(computeOutput, readFile) {
  const warnings = [];
  const filteredEdits = [];

  for (const edit of computeOutput.file_edits) {
    let content;
    try {
      content = readFile(edit.file);
    } catch {
      warnings.push(`${edit.file}: could not read file for semantic validation`);
      filteredEdits.push(edit);
      continue;
    }

    // Check 1: Skip files where class extends a concrete base class (Window, UserControl, etc.)
    const baseClassMatch = content.match(/class\s+\w+\s*:\s*(Window|UserControl|Page|Control|ContentControl)\b/);
    if (baseClassMatch) {
      const hasBindableBaseEdit = edit.operations.some(op =>
        op.new_text && op.new_text.includes('BindableBase')
      );
      if (hasBindableBaseEdit) {
        warnings.push(`${edit.file}: SKIPPED — class extends ${baseClassMatch[1]}, cannot also inherit BindableBase (C# single inheritance)`);
        continue; // Drop this file's edits entirely
      }
    }

    // Check 2: If removing PropertyChanged event, verify using System.ComponentModel is also handled
    const removesEvent = edit.operations.some(op =>
      op.old_text && op.old_text.includes('PropertyChangedEventHandler') && op.new_text === ''
    );
    const removesUsing = edit.operations.some(op =>
      op.old_text && op.old_text.includes('using System.ComponentModel')
    );
    if (removesEvent && !removesUsing) {
      // Check if PropertyChangedEventHandler is still used elsewhere
      const eventRefCount = (content.match(/PropertyChangedEventHandler/g) || []).length;
      if (eventRefCount <= 1) {
        // Only reference is the one being removed — safe to also remove the using
        warnings.push(`${edit.file}: NOTE — may need using System.ComponentModel removed (only reference was the event being deleted)`);
      }
    }

    // Check 3: Warn about custom SetProperty logic
    const setPropertyMatch = content.match(/(?:private|protected)\s+(?:bool|void)\s+SetProperty<T>\s*\([^)]*\)\s*\{([\s\S]*?)^\s{4}\}/m);
    if (setPropertyMatch) {
      const body = setPropertyMatch[1];
      // Standard patterns: Equals check, field assignment, OnPropertyChanged/PropertyChanged.Invoke, return
      const hasExtraLogic = /nameof\s*\(\s*(?!IsValid\b)\w+\s*\)|markUnsaved|HasUnsavedChanges|_disposed|InvokeOnUi/.test(body);
      if (hasExtraLogic) {
        warnings.push(`${edit.file}: WARNING — SetProperty has custom side-effect logic that may be lost during migration. Review manually.`);
      }
    }

    filteredEdits.push(edit);
  }

  return { warnings, file_edits: filteredEdits };
}

module.exports = { parseComputeOutput, validateComputeSchema, semanticValidateEdits };
