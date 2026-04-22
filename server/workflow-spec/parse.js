'use strict';

const Ajv = require('ajv');
const yaml = require('js-yaml');
const { WORKFLOW_SPEC_SCHEMA } = require('./schema');
const { resolveExtends } = require('./extends');

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(WORKFLOW_SPEC_SCHEMA);

function formatValidationErrors(errors) {
  return (errors || []).map((error) => {
    const path = error.instancePath || error.dataPath || '(root)';
    const params = error.params ? ` (${JSON.stringify(error.params)})` : '';
    return `${path}: ${error.message}${params}`;
  });
}

function normalizeSpec(raw) {
  return {
    ...raw,
    tasks: raw.tasks.map((task) => {
      const normalizedTask = { ...task };
      if (typeof task.task === 'string') {
        normalizedTask.task_description = task.task;
      }
      if (task.__remove !== true) {
        delete normalizedTask.__remove;
      }
      return normalizedTask;
    }),
  };
}

function parseSpecString(yamlContent) {
  let raw;
  try {
    raw = yaml.load(yamlContent);
  } catch (error) {
    return { ok: false, errors: [`YAML parse error: ${error.message}`] };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Spec must be a YAML object'] };
  }

  if (!validate(raw)) {
    return { ok: false, errors: formatValidationErrors(validate.errors) };
  }

  return { ok: true, spec: normalizeSpec(raw) };
}

function parseSpec(filePath) {
  const resolved = resolveExtends(filePath);
  if (!resolved.ok) {
    return resolved;
  }

  // Re-parse the merged YAML so file-based specs share the same validation path.
  const yamlText = yaml.dump(resolved.spec);
  return parseSpecString(yamlText);
}

module.exports = {
  parseSpec,
  parseSpecString,
};
