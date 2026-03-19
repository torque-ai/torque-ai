'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const logger = require('../logger').child({ component: 'strategic-config' });

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'default-config.json');
const TEMPLATES_DIR = path.join(__dirname, 'templates');

function loadJsonFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn(`Failed to load config file ${filePath}: ${err.message}`);
    }
    return null;
  }
}

function loadDefaultConfig() {
  const config = loadJsonFile(DEFAULT_CONFIG_PATH);
  if (!config) throw new Error('Default strategic config not found — installation may be corrupted');
  return JSON.parse(JSON.stringify(config)); // deep clone
}

function loadTemplate(name) {
  if (!name || typeof name !== 'string') return null;
  // Sanitize: prevent path traversal
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');

  // Check project-level templates first, then user, then built-in
  const locations = [
    path.join(TEMPLATES_DIR, `${safeName}.json`),
  ];

  // Add user templates dir
  const userTemplatesDir = path.join(os.homedir(), '.torque', 'templates');
  locations.unshift(path.join(userTemplatesDir, `${safeName}.json`));

  for (const loc of locations) {
    const template = loadJsonFile(loc);
    if (template) return template;
  }
  return null;
}

function listTemplates(workingDirectory) {
  const templates = [];
  const seen = new Set();

  // Project templates (highest precedence)
  if (workingDirectory) {
    const projDir = path.join(workingDirectory, '.torque', 'templates');
    if (fs.existsSync(projDir)) {
      for (const f of fs.readdirSync(projDir).filter(f => f.endsWith('.json'))) {
        const name = path.basename(f, '.json');
        const data = loadJsonFile(path.join(projDir, f));
        if (data) { templates.push({ name: data.name || name, source: 'project', ...data }); seen.add(name); }
      }
    }
  }

  // User templates
  const userDir = path.join(os.homedir(), '.torque', 'templates');
  if (fs.existsSync(userDir)) {
    for (const f of fs.readdirSync(userDir).filter(f => f.endsWith('.json'))) {
      const name = path.basename(f, '.json');
      if (seen.has(name)) continue;
      const data = loadJsonFile(path.join(userDir, f));
      if (data) { templates.push({ name: data.name || name, source: 'user', ...data }); seen.add(name); }
    }
  }

  // Built-in templates
  if (fs.existsSync(TEMPLATES_DIR)) {
    for (const f of fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'))) {
      const name = path.basename(f, '.json');
      if (seen.has(name)) continue;
      const data = loadJsonFile(path.join(TEMPLATES_DIR, f));
      if (data) { templates.push({ name: data.name || name, source: 'built-in', ...data }); seen.add(name); }
    }
  }

  return templates;
}

function loadProjectConfig(workingDirectory) {
  if (!workingDirectory) return null;
  return loadJsonFile(path.join(workingDirectory, '.torque', 'strategic.json'));
}

function loadUserConfig() {
  return loadJsonFile(path.join(os.homedir(), '.torque', 'strategic.json'));
}

function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return { valid: false, errors: ['Config must be an object'] };

  if (config.decompose) {
    if (config.decompose.steps !== undefined && (!Array.isArray(config.decompose.steps) || config.decompose.steps.some(s => typeof s !== 'string' || !s))) {
      errors.push('decompose.steps must be an array of non-empty strings');
    }
  }
  if (config.diagnose) {
    if (config.diagnose.recovery_actions !== undefined && !Array.isArray(config.diagnose.recovery_actions)) {
      errors.push('diagnose.recovery_actions must be an array');
    }
    if (config.diagnose.escalation_threshold !== undefined) {
      const t = config.diagnose.escalation_threshold;
      if (typeof t !== 'number' || t < 0 || t > 100) errors.push('diagnose.escalation_threshold must be 0-100');
    }
  }
  if (config.review) {
    if (config.review.criteria !== undefined && (!Array.isArray(config.review.criteria) || config.review.criteria.some(c => typeof c !== 'string' || !c))) {
      errors.push('review.criteria must be an array of non-empty strings');
    }
    if (config.review.auto_approve_threshold !== undefined) {
      const t = config.review.auto_approve_threshold;
      if (typeof t !== 'number' || t < 0 || t > 100) errors.push('review.auto_approve_threshold must be 0-100');
    }
    if (config.review.strict_mode !== undefined && typeof config.review.strict_mode !== 'boolean') {
      errors.push('review.strict_mode must be a boolean');
    }
  }
  if (config.confidence_threshold !== undefined) {
    const t = config.confidence_threshold;
    if (typeof t !== 'number' || t < 0 || t > 1) errors.push('confidence_threshold must be 0-1');
  }
  if (config.temperature !== undefined) {
    const t = config.temperature;
    if (typeof t !== 'number' || t < 0 || t > 2) errors.push('temperature must be 0-2');
  }
  if (config.provider !== undefined && config.provider !== null && typeof config.provider !== 'string') {
    errors.push('provider must be a string or null');
  }

  return { valid: errors.length === 0, errors };
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const val = source[key];
    if (val === null || val === undefined) continue; // skip nulls in higher layers
    if (Array.isArray(val)) {
      result[key] = [...val]; // arrays are replaced
    } else if (typeof val === 'object' && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], val); // objects are recursively merged
    } else {
      result[key] = val;
    }
  }
  return result;
}

function mergeConfig(project, user, defaults) {
  let merged = JSON.parse(JSON.stringify(defaults));
  if (user) merged = deepMerge(merged, user);
  if (project) merged = deepMerge(merged, project);
  return merged;
}

function resolveConfig(workingDirectory) {
  const defaults = loadDefaultConfig();
  const user = loadUserConfig();
  const project = loadProjectConfig(workingDirectory);
  return mergeConfig(project, user, defaults);
}

function substituteVariables(template, vars) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? String(vars[key]) : match;
  });
}

function saveProjectConfig(workingDirectory, config) {
  if (!workingDirectory) throw new Error('working_directory is required');
  const dir = path.join(workingDirectory, '.torque');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'strategic.json'), JSON.stringify(config, null, 2), 'utf8');
}

function deleteProjectConfig(workingDirectory) {
  if (!workingDirectory) return false;
  const filePath = path.join(workingDirectory, '.torque', 'strategic.json');
  try { fs.unlinkSync(filePath); return true; } catch { return false; }
}

module.exports = {
  loadDefaultConfig, loadTemplate, listTemplates,
  loadProjectConfig, loadUserConfig, saveProjectConfig, deleteProjectConfig,
  validateConfig, deepMerge, mergeConfig, resolveConfig,
  substituteVariables,
};
