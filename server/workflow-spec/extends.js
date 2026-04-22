'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const MAX_DEPTH = 8;

function loadYaml(absPath) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`Cannot read template ${absPath}: file does not exist`);
  }

  const text = fs.readFileSync(absPath, 'utf8');
  try {
    return yaml.load(text);
  } catch (err) {
    throw new Error(`YAML parse error in ${absPath}: ${err.message}`);
  }
}

function mergeTasks(baseTasks, childTasks) {
  const mergedTasks = new Map((Array.isArray(baseTasks) ? baseTasks : []).map((task) => [task.node_id, task]));
  const childEntries = Array.isArray(childTasks) ? childTasks : [];

  for (const childTask of childEntries) {
    if (!childTask || typeof childTask !== 'object' || !childTask.node_id) {
      continue;
    }

    if (childTask.__remove === true) {
      mergedTasks.delete(childTask.node_id);
      continue;
    }

    if (mergedTasks.has(childTask.node_id)) {
      mergedTasks.set(childTask.node_id, {
        ...mergedTasks.get(childTask.node_id),
        ...childTask,
      });
      continue;
    }

    mergedTasks.set(childTask.node_id, childTask);
  }

  return [...mergedTasks.values()];
}

function shallowMergeTopLevel(base, child) {
  const merged = { ...base, ...child };
  delete merged.extends;
  merged.tasks = mergeTasks(base.tasks, child.tasks);
  return merged;
}

function resolveExtends(specPath) {
  const errors = [];
  const visited = new Set();

  function resolveOne(absPath, depth) {
    if (depth > MAX_DEPTH) {
      throw new Error(`Extends depth exceeded ${MAX_DEPTH} (likely cycle or runaway chain)`);
    }

    const normalized = path.resolve(absPath);
    if (visited.has(normalized)) {
      throw new Error(`Extends cycle detected at ${normalized}`);
    }

    visited.add(normalized);

    const raw = loadYaml(normalized);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${normalized} does not contain a YAML object`);
    }

    if (!raw.extends) {
      visited.delete(normalized);
      return raw;
    }

    const baseRef = raw.extends;
    const baseAbs = path.isAbsolute(baseRef)
      ? baseRef
      : path.join(path.dirname(normalized), baseRef);
    const baseSpec = resolveOne(baseAbs, depth + 1);

    visited.delete(normalized);
    return shallowMergeTopLevel(baseSpec, raw);
  }

  try {
    return { ok: true, spec: resolveOne(specPath, 0) };
  } catch (err) {
    errors.push(err.message);
    return { ok: false, errors };
  }
}

module.exports = {
  resolveExtends,
  MAX_DEPTH,
};
