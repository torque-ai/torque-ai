'use strict';

const logger = require('../logger').child({ component: 'compute-output-parser' });

function hasFileEdits(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, 'file_edits');
}

function normalizeOperationShape(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    return operation;
  }

  const normalized = { ...operation };
  if (normalized.old_text === undefined) {
    normalized.old_text = normalized.oldText
      ?? normalized.old
      ?? normalized.search
      ?? normalized.find;
  }
  if (normalized.new_text === undefined) {
    normalized.new_text = normalized.newText
      ?? normalized.new
      ?? normalized.replacement
      ?? normalized.replace;
  }
  if (String(normalized.type || '').trim().toLowerCase() === 'delete' && normalized.new_text === undefined) {
    normalized.new_text = '';
  }
  return normalized;
}

function normalizeComputeOutputShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }

  const normalized = { ...data };
  if (normalized.file_edits && !Array.isArray(normalized.file_edits) && typeof normalized.file_edits === 'object') {
    normalized.file_edits = [normalized.file_edits];
  }

  if (!Array.isArray(normalized.file_edits)) {
    return normalized;
  }

  normalized.file_edits = normalized.file_edits.map((edit) => {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
      return edit;
    }

    const normalizedEdit = { ...edit };
    if (!normalizedEdit.file) {
      normalizedEdit.file = normalizedEdit.path
        ?? normalizedEdit.file_path
        ?? normalizedEdit.filePath
        ?? normalizedEdit.filename;
    }

    if (!normalizedEdit.operations) {
      normalizedEdit.operations = normalizedEdit.operation
        ?? normalizedEdit.ops
        ?? normalizedEdit.edits
        ?? normalizedEdit.changes;
    }

    if (!normalizedEdit.operations && (normalizedEdit.old_text !== undefined || normalizedEdit.new_text !== undefined)) {
      normalizedEdit.operations = [{
        type: normalizedEdit.type || 'replace',
        old_text: normalizedEdit.old_text,
        new_text: normalizedEdit.new_text,
      }];
    }

    if (normalizedEdit.operations && !Array.isArray(normalizedEdit.operations) && typeof normalizedEdit.operations === 'object') {
      normalizedEdit.operations = [normalizedEdit.operations];
    }

    if (Array.isArray(normalizedEdit.operations)) {
      normalizedEdit.operations = normalizedEdit.operations.map(normalizeOperationShape);
    }

    return normalizedEdit;
  });

  return normalized;
}

function parseJsonCandidate(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    return hasFileEdits(parsed) ? normalizeComputeOutputShape(parsed) : null;
  } catch (_) {
    return null;
  }
}

function extractJsonObjectWithFileEdits(text) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (char !== '}') continue;

    depth -= 1;
    if (depth === 0 && start >= 0) {
      const parsed = parseJsonCandidate(text.slice(start, i + 1));
      if (parsed) return parsed;
      start = -1;
    } else if (depth < 0) {
      depth = 0;
      start = -1;
    }
  }

  return null;
}

function parseComputeOutput(output) {
  if (!output || typeof output !== 'string') return null;

  const trimmed = output.trim();
  if (!trimmed) return null;

  // Try 1: Direct JSON parse
  const direct = parseJsonCandidate(trimmed);
  if (direct) return direct;

  // Try 2: Extract from markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const fenced = parseJsonCandidate(fenceMatch[1].trim());
    if (fenced) return fenced;
  }

  // Try 3: Find a JSON object with file_edits anywhere in conversational output.
  const extracted = extractJsonObjectWithFileEdits(trimmed);
  if (!extracted && trimmed.includes('file_edits')) {
    logger.info('[ComputeOutputParser] Found file_edits marker but could not parse a valid JSON object');
  }
  return extracted;
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

module.exports = {
  parseComputeOutput,
  validateComputeSchema,
  semanticValidateEdits,
  normalizeComputeOutputShape,
};
