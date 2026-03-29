'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE_DEFINITIONS_DIR = path.join(__dirname, 'definitions');

function cloneTemplate(template) {
  if (template instanceof Map) {
    return new Map(Array.from(template.entries()).map(([id, value]) => [id, cloneTemplate(value)]));
  }

  if (Array.isArray(template)) {
    return template.map((value) => cloneTemplate(value));
  }

  if (!template || typeof template !== 'object') {
    return template;
  }

  return JSON.parse(JSON.stringify(template));
}

function isStringValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function normalizeDetection(value) {
  if (!value || typeof value !== 'object') {
    return { files: [], dependencies: [] };
  }

  const files = assertArray(value.files).map((entry) => isStringValue(entry) ? entry.trim() : '').filter(Boolean);
  let dependencies = [];

  if (value.dependencies !== undefined) {
    if (Array.isArray(value.dependencies)) {
      dependencies = value.dependencies
        .map((rule) => {
          if (!rule || typeof rule !== 'object') return null;
          const file = isStringValue(rule.file) ? rule.file.trim() : '';
          const key = isStringValue(rule.key) ? rule.key.trim() : '';
          if (!file || !key) return null;
          return { file, key };
        })
        .filter(Boolean);
    } else if (value.dependencies && typeof value.dependencies === 'object') {
      const file = isStringValue(value.dependencies.file) ? value.dependencies.file.trim() : '';
      const key = isStringValue(value.dependencies.key) ? value.dependencies.key.trim() : '';
      if (file && key) {
        dependencies = [{ file, key }];
      }
    }
  }

  return {
    files: [...new Set(files)],
    dependencies: [...new Set(dependencies.map((rule) => `${rule.file}::${rule.key}`))].map((entry) => {
      const [file, key] = entry.split('::');
      return { file, key };
    }),
  };
}

function normalizeTemplateDefinition(rawDefinition, sourceFile) {
  if (!rawDefinition || typeof rawDefinition !== 'object') {
    throw new Error(`Invalid template definition in ${sourceFile}: expected object`);
  }

  const id = isStringValue(rawDefinition.id) ? rawDefinition.id.trim() : '';
  const expectedId = path.basename(sourceFile, '.json');
  if (!id) {
    throw new Error(`Invalid template definition in ${sourceFile}: missing id`);
  }
  if (id !== expectedId) {
    throw new Error(`Invalid template definition in ${sourceFile}: id ${id} does not match filename ${expectedId}`);
  }

  if (!isStringValue(rawDefinition.name)) {
    throw new Error(`Invalid template definition for ${id}: missing name`);
  }

  if (!isStringValue(rawDefinition.category)) {
    throw new Error(`Invalid template definition for ${id}: missing category`);
  }

  if (!Number.isFinite(Number(rawDefinition.priority))) {
    throw new Error(`Invalid template definition for ${id}: priority must be numeric`);
  }

  if (!rawDefinition.detection || typeof rawDefinition.detection !== 'object') {
    throw new Error(`Invalid template definition for ${id}: missing detection`);
  }

  const detection = normalizeDetection(rawDefinition.detection, sourceFile);
  if (detection.files.length === 0 && detection.dependencies.length === 0) {
    throw new Error(`Invalid template definition for ${id}: detection must include files and/or dependencies`);
  }

  const extendsTemplate = isStringValue(rawDefinition.extends) ? rawDefinition.extends.trim() : null;
  const agentContext = isStringValue(rawDefinition.agent_context) ? rawDefinition.agent_context.trim() : '';
  const verifyCommandSuggestion = isStringValue(rawDefinition.verify_command_suggestion)
    ? rawDefinition.verify_command_suggestion.trim()
    : null;
  const criticalErrorPatterns = assertArray(rawDefinition.critical_error_patterns)
    .map((value) => isStringValue(value) ? value.trim() : '')
    .filter(Boolean);
  const worktreeSymlinks = assertArray(rawDefinition.worktree_symlinks)
    .map((value) => isStringValue(value) ? value.trim() : '')
    .filter(Boolean);

  return {
    id,
    name: rawDefinition.name.trim(),
    category: rawDefinition.category.trim(),
    priority: Number(rawDefinition.priority),
    extends: extendsTemplate,
    detection,
    agent_context: agentContext,
    verify_command_suggestion: verifyCommandSuggestion,
    critical_error_patterns: [...new Set(criticalErrorPatterns)],
    worktree_symlinks: [...new Set(worktreeSymlinks)],
  };
}

function mergeStringArrays(parent, child) {
  return [...new Set([...(parent || []), ...(child || [])])];
}

function mergeDependencyRules(parentDependencies, childDependencies) {
  return [...new Set([...(parentDependencies || []), ...(childDependencies || [])])];
}

function mergeTemplates(parent, child) {
  const merged = {
    id: child.id,
    name: child.name || parent.name,
    category: child.category || parent.category,
    priority: Number.isFinite(child.priority) ? child.priority : parent.priority,
    extends: child.extends || parent.extends,
    detection: {
      files: mergeStringArrays(parent.detection.files, child.detection.files),
      dependencies: mergeDependencyRules(parent.detection.dependencies, child.detection.dependencies),
    },
    agent_context: [parent.agent_context, child.agent_context].filter(Boolean).join('\n\n'),
    verify_command_suggestion: child.verify_command_suggestion || parent.verify_command_suggestion,
    critical_error_patterns: mergeStringArrays(parent.critical_error_patterns, child.critical_error_patterns),
    worktree_symlinks: mergeStringArrays(parent.worktree_symlinks, child.worktree_symlinks),
  };

  merged.extends = child.extends || parent.extends || null;
  return merged;
}

function resolveTemplate(templatesById, resolvedCache, id, inheritanceStack = new Set()) {
  if (resolvedCache.has(id)) {
    return resolvedCache.get(id);
  }

  const raw = templatesById.get(id);
  if (!raw) {
    throw new Error(`Unknown template id: ${id}`);
  }

  if (inheritanceStack.has(id)) {
    throw new Error(`Circular template inheritance detected: ${Array.from(inheritanceStack).concat([id]).join(' -> ')}`);
  }

  if (!raw.extends) {
    const base = {
      ...raw,
      detection: {
        files: [...raw.detection.files],
        dependencies: [...raw.detection.dependencies],
      },
      extends: null,
    };
    const normalizedBase = normalizeForDetectionCompatibility(base);
    resolvedCache.set(id, normalizedBase);
    return normalizedBase;
  }

  inheritanceStack.add(id);
  const parent = resolveTemplate(templatesById, resolvedCache, raw.extends, inheritanceStack);
  const merged = mergeTemplates(parent, raw);
  inheritanceStack.delete(id);
  const mergedWithCompatibility = normalizeForDetectionCompatibility(merged);
  resolvedCache.set(id, mergedWithCompatibility);
  return mergedWithCompatibility;
}

function normalizeForDetectionCompatibility(template) {
  return {
    ...template,
    markers: [...(template.detection?.files || [])],
    deps: [...(template.detection?.dependencies || [])],
  };
}

function createTemplateRegistry() {
  const cache = {
    compiled: null,
  };

  function readDefinitions() {
    if (!fs.existsSync(TEMPLATE_DEFINITIONS_DIR)) {
      throw new Error(`Template definitions directory not found: ${TEMPLATE_DEFINITIONS_DIR}`);
    }

    const files = fs.readdirSync(TEMPLATE_DEFINITIONS_DIR)
      .filter((fileName) => fileName.toLowerCase().endsWith('.json'))
      .sort((a, b) => a.localeCompare(b));

    const templatesById = new Map();
    for (const fileName of files) {
      const filePath = path.join(TEMPLATE_DEFINITIONS_DIR, fileName);
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (error) {
        throw new Error(`Invalid JSON in ${fileName}: ${error.message}`);
      }

      const parsed = normalizeTemplateDefinition(raw, fileName);
      if (templatesById.has(parsed.id)) {
        throw new Error(`Duplicate template id: ${parsed.id}`);
      }
      templatesById.set(parsed.id, parsed);
    }

    return templatesById;
  }

  function loadTemplates() {
    if (cache.compiled) {
      return cloneTemplate(cache.compiled);
    }

    const definitions = readDefinitions();
    const resolved = new Map();

    for (const id of definitions.keys()) {
      const template = resolveTemplate(definitions, resolved, id);
      resolved.set(id, template);
    }

    cache.compiled = new Map();
    for (const [id, template] of resolved.entries()) {
      cache.compiled.set(id, cloneTemplate(template));
    }

    return cloneTemplate(cache.compiled);
  }

  function getTemplate(id) {
    if (!isStringValue(id)) {
      return null;
    }

    const loaded = loadTemplates();
    return loaded.get(id) ? cloneTemplate(loaded.get(id)) : null;
  }

  function getAllTemplates() {
    return Array.from(loadTemplates().values()).sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.id.localeCompare(b.id);
    }).map((template) => cloneTemplate(template));
  }

  function getTemplatesForCategory(category) {
    const normalizedCategory = isStringValue(category) ? category.trim() : '';
    if (!normalizedCategory) {
      return [];
    }

    return getAllTemplates().filter((template) => template.category === normalizedCategory);
  }

  return {
    loadTemplates,
    getTemplate,
    getAllTemplates,
    getTemplatesForCategory,
  };
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function getFileText(workingDir, relativePath, cache) {
  const filePath = path.join(workingDir, relativePath);
  if (cache.has(filePath)) {
    return cache.get(filePath);
  }

  let content = null;
  try {
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8');
    }
  } catch {
    content = null;
  }

  cache.set(filePath, content);
  return content;
}

function getParsedJson(workingDir, relativePath, textCache, jsonCache) {
  const filePath = path.join(workingDir, relativePath);
  if (jsonCache.has(filePath)) {
    return jsonCache.get(filePath);
  }

  const text = getFileText(workingDir, relativePath, textCache);
  if (typeof text !== 'string') {
    jsonCache.set(filePath, null);
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    jsonCache.set(filePath, parsed);
    return parsed;
  } catch {
    jsonCache.set(filePath, null);
    return null;
  }
}

function globToRegExp(pattern) {
  return new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`, 'i');
}

function directoryContainsGlob(workingDir, pattern) {
  const matcher = globToRegExp(pattern);
  const pending = [workingDir];
  const ignored = new Set(['.git', 'node_modules']);

  while (pending.length > 0) {
    const currentDir = pending.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && matcher.test(entry.name)) {
        return true;
      }

      if (entry.isDirectory() && !ignored.has(entry.name)) {
        pending.push(path.join(currentDir, entry.name));
      }
    }
  }

  return false;
}

function markerExists(workingDir, marker) {
  if (typeof marker !== 'string' || marker.length === 0) {
    return false;
  }

  if (marker.includes('*')) {
    return directoryContainsGlob(workingDir, marker);
  }

  try {
    return fs.existsSync(path.join(workingDir, marker));
  } catch {
    return false;
  }
}

function textDependencyExists(text, dependencyKey) {
  if (typeof text !== 'string' || typeof dependencyKey !== 'string' || !dependencyKey) {
    return false;
  }

  const expression = new RegExp(`(^|\\r?\\n)\\s*${escapeRegex(dependencyKey)}(?:\\[[^\\]]+\\])?\\s*(?:[=<>!~]|$)`, 'im');
  return expression.test(text);
}

function dependencyRuleExists(workingDir, rule, textCache, jsonCache) {
  if (!rule || typeof rule !== 'object' || typeof rule.file !== 'string' || typeof rule.key !== 'string') {
    return false;
  }

  if (rule.file.endsWith('.json')) {
    const parsed = getParsedJson(workingDir, rule.file, textCache, jsonCache);
    if (!parsed || typeof parsed !== 'object') {
      return false;
    }

    const dependencies = parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : {};
    const devDependencies = parsed.devDependencies && typeof parsed.devDependencies === 'object' ? parsed.devDependencies : {};
    return Object.prototype.hasOwnProperty.call(dependencies, rule.key)
      || Object.prototype.hasOwnProperty.call(devDependencies, rule.key);
  }

  const text = getFileText(workingDir, rule.file, textCache);
  return textDependencyExists(text, rule.key);
}

function detectProjectType(workingDir) {
  if (typeof workingDir !== 'string' || workingDir.trim().length === 0) {
    return null;
  }

  const templates = listTemplates();
  const textCache = new Map();
  const jsonCache = new Map();
  let bestMatch = null;

  for (const template of templates) {
    const matchedMarkers = [];
    for (const marker of template.markers) {
      if (markerExists(workingDir, marker)) {
        matchedMarkers.push(marker);
      }
    }

    const dependencyRules = template.deps
      ? (Array.isArray(template.deps) ? template.deps : [template.deps])
      : [];
    const matchedDependencies = [];
    for (const rule of dependencyRules) {
      if (dependencyRuleExists(workingDir, rule, textCache, jsonCache)) {
        matchedDependencies.push(rule.key);
      }
    }

    if (dependencyRules.length > 0 && matchedDependencies.length === 0) {
      continue;
    }

    const score = matchedMarkers.length + matchedDependencies.length;
    if (score === 0) {
      continue;
    }

    const totalRules = template.markers.length + dependencyRules.length;
    const candidate = {
      ...template,
      score,
      confidence: totalRules > 0 ? score / totalRules : 0,
      matched_markers: matchedMarkers,
      matched_dependencies: matchedDependencies,
    };

    if (!bestMatch
      || candidate.score > bestMatch.score
      || (candidate.score === bestMatch.score && candidate.priority > bestMatch.priority)) {
      bestMatch = candidate;
    }
  }

  return bestMatch;
}

const templateRegistry = createTemplateRegistry();

function loadTemplates() {
  const templates = templateRegistry.loadTemplates();
  return new Map(Array.from(templates.entries()).map(([id, template]) => [id, cloneTemplate(template)]));
}

function getTemplate(id) {
  return templateRegistry.getTemplate(id);
}

function listTemplates() {
  return templateRegistry.getAllTemplates();
}

module.exports = {
  createTemplateRegistry,
  loadTemplates,
  getTemplate,
  listTemplates,
  getAllTemplates: (...args) => templateRegistry.getAllTemplates(...args),
  getTemplatesForCategory: (...args) => templateRegistry.getTemplatesForCategory(...args),
  detectProjectType,
  escapeRegex,
  markerExists,
  textDependencyExists,
  dependencyRuleExists,
  getFileText,
  getParsedJson,
  globToRegExp,
  directoryContainsGlob,
  cloneTemplate,
};
