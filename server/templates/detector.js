'use strict';

const fs = require('fs');
const path = require('path');
const minimatch = require('minimatch');

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function isRuleList(value) {
  return Array.isArray(value) ? value : [];
}

function isString(value) {
  return typeof value === 'string' && value.length > 0;
}

function normalizeWorkingDir(workingDir) {
  if (!isString(workingDir)) {
    return null;
  }
  return path.resolve(workingDir);
}

function escapeForRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function hasGlobPattern(pattern) {
  return typeof pattern === 'string' && /[*?[\]]/.test(pattern);
}

function findWithGlob(rootDir, pattern) {
  const stack = [rootDir];
  const seen = new Set();
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build']);

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (seen.has(currentDir)) {
      continue;
    }
    seen.add(currentDir);

    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (ignored.has(entry.name)) {
        continue;
      }

      const candidate = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, candidate).replace(/\\/g, '/');
      if (minimatch(relativePath, pattern)) {
        return true;
      }

      if (entry.isDirectory()) {
        stack.push(candidate);
      }
    }
  }

  return false;
}

function matchesFileMarker(workingDir, marker) {
  if (!isString(marker)) {
    return false;
  }

  if (hasGlobPattern(marker)) {
    return findWithGlob(workingDir, marker);
  }

  try {
    return fs.existsSync(path.join(workingDir, marker));
  } catch {
    return false;
  }
}

function detectDependency(filePath, key) {
  if (!isString(filePath) || !isString(key)) {
    return false;
  }

  const fileText = readTextFile(filePath);
  if (typeof fileText !== 'string') {
    return false;
  }

  const normalizedKey = key.trim();
  if (!normalizedKey) {
    return false;
  }

  const baseName = path.basename(filePath).toLowerCase();

  if (baseName === 'package.json') {
    let parsed;
    try {
      parsed = JSON.parse(fileText);
    } catch {
      return false;
    }

    if (!parsed || typeof parsed !== 'object') {
      return false;
    }

    const dependencies = parsed.dependencies && typeof parsed.dependencies === 'object'
      ? parsed.dependencies
      : {};
    const devDependencies = parsed.devDependencies && typeof parsed.devDependencies === 'object'
      ? parsed.devDependencies
      : {};
    return Object.prototype.hasOwnProperty.call(dependencies, normalizedKey)
      || Object.prototype.hasOwnProperty.call(devDependencies, normalizedKey);
  }

  if (baseName === 'requirements.txt') {
    const lines = fileText.split(/\r?\n/);
    for (const rawLine of lines) {
      let line = rawLine.split('#')[0].trim();
      if (!line) {
        continue;
      }

      line = line.split(/[\s;]+/)[0].trim();
      if (!line) {
        continue;
      }

      let name = line.split(/[=<>~!]/)[0].trim();
      if (!name) {
        continue;
      }

      name = name.split('[')[0];
      if (!name) {
        continue;
      }

      if (name.toLowerCase() === normalizedKey.toLowerCase()) {
        return true;
      }
    }
    return false;
  }

  if (baseName === 'cargo.toml') {
    const lines = fileText.split(/\r?\n/);
    let inDependencies = false;
    const sectionHeader = /^\s*\[([^\]]+)\]\s*$/;
    const escapedKey = escapeForRegExp(normalizedKey);
    const keyRule = new RegExp(`^\\s*${escapedKey}(?:\\s*=|\\s+\\{|\\s+|$)`, 'i');

    for (const rawLine of lines) {
      const lineWithoutComment = rawLine.split('#')[0];
      const line = lineWithoutComment.trim();
      if (!line) {
        continue;
      }

      const sectionMatch = line.match(sectionHeader);
      if (sectionMatch) {
        inDependencies = sectionMatch[1].trim() === 'dependencies';
        continue;
      }

      if (!inDependencies) {
        continue;
      }

      if (keyRule.test(line)) {
        return true;
      }
    }
    return false;
  }

  if (baseName === 'go.mod') {
    const lines = fileText.split(/\r?\n/);
    let inRequireBlock = false;
    const trimmedKey = normalizedKey.trim();

    for (const rawLine of lines) {
      const lineWithoutComment = rawLine.split('//')[0];
      const line = lineWithoutComment.trim();
      if (!line) {
        continue;
      }

      if (line === 'require (') {
        inRequireBlock = true;
        continue;
      }

      if (line === ')') {
        inRequireBlock = false;
        continue;
      }

      if (inRequireBlock) {
        const firstToken = line.split(/\s+/)[0];
        if (firstToken === trimmedKey) {
          return true;
        }
        continue;
      }

      if (line.startsWith('require ')) {
        const requireBody = line.slice(7).trim();
        if (requireBody.startsWith('(')) {
          inRequireBlock = true;
          continue;
        }

        const firstToken = requireBody.split(/\s+/)[0];
        if (firstToken === trimmedKey) {
          return true;
        }
      }
    }
    return false;
  }

  return false;
}

function createProjectDetector({ templateRegistry }) {
  if (!templateRegistry || typeof templateRegistry.getAllTemplates !== 'function') {
    throw new TypeError('createProjectDetector requires a templateRegistry with getAllTemplates()');
  }

  function detectProjectType(workingDir) {
    const normalizedWorkingDir = normalizeWorkingDir(workingDir);
    if (!normalizedWorkingDir || !fs.existsSync(normalizedWorkingDir)) {
      return null;
    }

    const templates = isRuleList(templateRegistry.getAllTemplates()).sort((first, second) => {
      const firstPriority = isFiniteNumber(first?.priority) ? Number(first.priority) : 0;
      const secondPriority = isFiniteNumber(second?.priority) ? Number(second.priority) : 0;
      if (secondPriority !== firstPriority) {
        return secondPriority - firstPriority;
      }
      return 0;
    });

    let bestMatch = null;

    for (const template of templates) {
      if (!template || typeof template !== 'object') {
        continue;
      }

      const detection = template.detection && typeof template.detection === 'object'
        ? template.detection
        : {};
      const fileRules = isRuleList(detection.files);
      const dependencyRules = isRuleList(detection.dependencies);
      const matchedRules = [];

      for (const fileRule of fileRules) {
        if (isString(fileRule) && matchesFileMarker(normalizedWorkingDir, fileRule)) {
          matchedRules.push({ type: 'file', rule: fileRule });
        }
      }

      for (const dependencyRule of dependencyRules) {
        if (!dependencyRule || typeof dependencyRule !== 'object') {
          continue;
        }
        const dependencyFile = path.resolve(normalizedWorkingDir, dependencyRule.file || '');
        const dependencyKey = dependencyRule.key;
        if (detectDependency(dependencyFile, dependencyKey)) {
          matchedRules.push({
            type: 'dependency',
            rule: {
              file: dependencyRule.file,
              key: dependencyRule.key,
            },
          });
        }
      }

      if (matchedRules.length === 0) {
        continue;
      }

      const priority = isFiniteNumber(template.priority) ? Number(template.priority) : 0;
      const score = priority + (matchedRules.length * 10);
      const candidate = {
        template,
        score,
        matchedRules,
      };

      if (!bestMatch || candidate.score > bestMatch.score) {
        bestMatch = candidate;
      }
    }

    return bestMatch;
  }

  return {
    detectProjectType,
    detectDependency,
  };
}

module.exports = {
  createProjectDetector,
};
