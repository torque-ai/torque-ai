'use strict';

const fs = require('fs');
const path = require('path');

const BUILTIN_TEMPLATES = new Map([
  ['nodejs', {
    markers: ['package.json'],
    priority: 50,
    agent_context: 'Node.js project. Use CommonJS require unless package.json has type:module.',
  }],
  ['typescript', {
    markers: ['tsconfig.json'],
    priority: 60,
    agent_context: 'TypeScript project. Use strict types. Run tsc --noEmit to type-check.',
  }],
  ['nextjs', {
    markers: ['package.json'],
    deps: { file: 'package.json', key: 'next' },
    priority: 110,
    agent_context: 'Next.js project using App Router. Pages in app/ directory. Server components by default.',
  }],
  ['react', {
    markers: ['package.json'],
    deps: { file: 'package.json', key: 'react' },
    priority: 100,
    agent_context: 'React project. Use functional components with hooks. JSX/TSX files.',
  }],
  ['python', {
    markers: ['requirements.txt', 'pyproject.toml', 'setup.py'],
    priority: 50,
    agent_context: 'Python project. Follow PEP 8. Use type hints.',
  }],
  ['django', {
    markers: ['manage.py'],
    deps: { file: 'requirements.txt', key: 'django' },
    priority: 110,
    agent_context: 'Django project. Follow Django conventions. Use class-based views where appropriate.',
  }],
  ['rust', {
    markers: ['Cargo.toml'],
    priority: 50,
    agent_context: 'Rust project. Follow Rust idioms. Use Result for error handling.',
  }],
  ['go', {
    markers: ['go.mod'],
    priority: 50,
    agent_context: 'Go project. Follow Go conventions. Use error returns, not panics.',
  }],
  ['csharp', {
    markers: ['*.csproj', '*.sln'],
    priority: 50,
    agent_context: 'C#/.NET project. Follow .NET conventions.',
  }],
  ['vue', {
    markers: ['package.json'],
    deps: { file: 'package.json', key: 'vue' },
    priority: 100,
    agent_context: 'Vue.js project. Use Composition API with script setup.',
  }],
]);

function cloneTemplate(id, definition) {
  const template = {
    id,
    markers: Array.isArray(definition.markers) ? [...definition.markers] : [],
    priority: Number.isFinite(definition.priority) ? definition.priority : 0,
    agent_context: definition.agent_context || '',
  };

  if (definition.deps) {
    template.deps = Array.isArray(definition.deps)
      ? definition.deps.map((rule) => ({ ...rule }))
      : { ...definition.deps };
  }

  return template;
}

function loadTemplates() {
  const loaded = new Map();
  for (const [id, definition] of BUILTIN_TEMPLATES.entries()) {
    loaded.set(id, cloneTemplate(id, definition));
  }
  return loaded;
}

function getTemplate(id) {
  if (typeof id !== 'string') {
    return null;
  }

  const definition = BUILTIN_TEMPLATES.get(id);
  return definition ? cloneTemplate(id, definition) : null;
}

function listTemplates() {
  return Array.from(loadTemplates().values());
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

  const textCache = new Map();
  const jsonCache = new Map();
  let bestMatch = null;

  for (const template of listTemplates()) {
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

module.exports = {
  loadTemplates,
  getTemplate,
  listTemplates,
  detectProjectType,
};
