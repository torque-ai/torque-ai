'use strict';

function escapeRegex(ch) {
  return /[\\^$+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

function globToRegex(glob) {
  const normalized = String(glob || '**/*').replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

function normalizePatterns(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return ['**/*'];
}

function ruleMatches(rule, context = {}) {
  const files = Array.isArray(context.files) ? context.files.map((f) => String(f).replace(/\\/g, '/')) : [];
  const tags = new Set(Array.isArray(context.tags) ? context.tags : []);
  if (Array.isArray(rule.tags) && rule.tags.length > 0 && rule.tags.some((tag) => tags.has(tag))) {
    return true;
  }
  if (files.length === 0) return true;

  const regexes = normalizePatterns(rule.applies_to).map(globToRegex);
  return files.some((file) => regexes.some((regex) => regex.test(file)));
}

function selectRules(rules = [], context = {}) {
  return rules.filter((rule) => rule && rule.enabled !== false && ruleMatches(rule, context));
}

module.exports = {
  globToRegex,
  ruleMatches,
  selectRules,
};
