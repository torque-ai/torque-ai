'use strict';

const fs = require('fs');
const path = require('path');
const { parseSpecString } = require('./parse');

function toRelativeSpecPath(projectRoot, absolutePath) {
  return path.relative(projectRoot, absolutePath).replace(/\\/g, '/');
}

function nameFromFile(entryName) {
  return entryName.replace(/\.(ya?ml)$/i, '');
}

/**
 * Scan <projectRoot>/workflows/ for .yaml/.yml files and return spec summaries.
 * @param {string} projectRoot - absolute path to the project working directory
 * @returns {Array<{
 *   name: string,
 *   relative_path: string,
 *   absolute_path: string,
 *   valid: boolean,
 *   errors: string[],
 *   description: string|null,
 *   task_count: number
 * }>}
 */
function discoverSpecs(projectRoot) {
  const workflowsDir = path.join(projectRoot, 'workflows');
  if (!fs.existsSync(workflowsDir)) {
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(workflowsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && /\.(ya?ml)$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const absolutePath = path.join(workflowsDir, entry.name);
      const relativePath = toRelativeSpecPath(projectRoot, absolutePath);

      let parsed;
      try {
        parsed = parseSpecString(fs.readFileSync(absolutePath, 'utf8'));
      } catch (error) {
        parsed = {
          ok: false,
          errors: [`Cannot read spec ${relativePath}: ${error.message}`],
        };
      }

      if (!parsed.ok) {
        return {
          name: nameFromFile(entry.name),
          relative_path: relativePath,
          absolute_path: absolutePath,
          valid: false,
          errors: parsed.errors,
          description: null,
          task_count: 0,
        };
      }

      return {
        name: parsed.spec.name,
        relative_path: relativePath,
        absolute_path: absolutePath,
        valid: true,
        errors: [],
        description: parsed.spec.description || null,
        task_count: parsed.spec.tasks.length,
      };
    });
}

module.exports = { discoverSpecs };
