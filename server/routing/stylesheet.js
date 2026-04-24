'use strict';

const ALLOWED_PROVIDERS = new Set([
  'codex',
  'claude-cli',
  'ollama',
  'ollama-cloud',
  'anthropic',
  'cerebras',
  'deepinfra',
  'google-ai',
  'groq',
  'hyperbolic',
  'openrouter',
]);

const ALLOWED_REASONING = new Set(['low', 'medium', 'high']);
const ALLOWED_PROPS = new Set(['provider', 'model', 'reasoning_effort', 'routing_template']);
const RULE_REGEX = /([^{}]+)\{([^{}]*)\}/g;

function stripComments(css) {
  return String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseSelector(raw) {
  const selector = String(raw || '').trim();

  if (selector === '*') {
    return { selector: { type: 'universal' }, specificity: 0 };
  }

  if (selector.startsWith('.') && /^\.[\w-]+$/.test(selector)) {
    return { selector: { type: 'tag', value: selector.slice(1) }, specificity: 1 };
  }

  if (selector.startsWith('#') && /^#[\w-]+$/.test(selector)) {
    return { selector: { type: 'id', value: selector.slice(1) }, specificity: 2 };
  }

  return null;
}

function parseProps(body, errors) {
  const props = {};
  const declarations = String(body || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);

  for (const declaration of declarations) {
    const separatorIndex = declaration.indexOf(':');
    if (separatorIndex < 0) {
      errors.push(`Missing ':' in declaration "${declaration}"`);
      continue;
    }

    const key = declaration.slice(0, separatorIndex).trim();
    const value = declaration.slice(separatorIndex + 1).trim();

    if (!ALLOWED_PROPS.has(key)) {
      errors.push(`Unknown property "${key}" (allowed: ${Array.from(ALLOWED_PROPS).join(', ')})`);
      continue;
    }

    if (key === 'provider' && !ALLOWED_PROVIDERS.has(value)) {
      errors.push(`Invalid provider "${value}" in declaration "${declaration}"`);
      continue;
    }

    if (key === 'reasoning_effort' && !ALLOWED_REASONING.has(value)) {
      errors.push(`Invalid reasoning_effort "${value}" (allowed: low/medium/high)`);
      continue;
    }

    props[key] = value;
  }

  return props;
}

/**
 * Parse a stylesheet into a list of rules.
 * @param {string} css
 * @returns {{ ok: true, rules: Array } | { ok: false, errors: string[] }}
 */
function parseStylesheet(css) {
  const errors = [];
  const rules = [];
  const source = stripComments(css);
  let match;
  let order = 0;

  RULE_REGEX.lastIndex = 0;
  while ((match = RULE_REGEX.exec(source)) !== null) {
    const [, selectorPart, bodyPart] = match;
    const parsedSelector = parseSelector(selectorPart);

    if (!parsedSelector) {
      errors.push(`Unsupported selector "${selectorPart.trim()}" - use *, .tag, or #node_id`);
      continue;
    }

    rules.push({
      selector: parsedSelector.selector,
      specificity: parsedSelector.specificity,
      order: order++,
      props: parseProps(bodyPart, errors),
    });
  }

  RULE_REGEX.lastIndex = 0;
  const residue = source.replace(RULE_REGEX, '').replace(/\s/g, '');
  if (residue.length > 0) {
    errors.push(`Unparsed content: "${residue.slice(0, 40)}..."`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, rules };
}

function matchesSelector(selector, task) {
  if (!selector || !task) {
    return false;
  }

  if (selector.type === 'universal') {
    return true;
  }

  if (selector.type === 'tag') {
    return Array.isArray(task.tags) && task.tags.includes(selector.value);
  }

  if (selector.type === 'id') {
    return task.node_id === selector.value;
  }

  return false;
}

/**
 * Resolve the effective stylesheet props for a single task.
 * @param {Array} rules
 * @param {{node_id?: string, tags?: string[]}} task
 * @returns {object}
 */
function resolveTaskProps(rules, task) {
  const candidates = Array.isArray(rules)
    ? rules.filter((rule) => matchesSelector(rule.selector, task))
    : [];

  if (candidates.length === 0) {
    return {};
  }

  candidates.sort((a, b) => a.specificity - b.specificity || a.order - b.order);

  const merged = {};
  for (const candidate of candidates) {
    Object.assign(merged, candidate.props);
  }

  return merged;
}

module.exports = {
  parseStylesheet,
  resolveTaskProps,
};
