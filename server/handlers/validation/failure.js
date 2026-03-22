/**
 * Failure pattern and retry rule handlers
 * Extracted from validation-handlers.js
 */

const validationRules = require('../../db/validation-rules');
const { ErrorCodes, makeError } = require('../shared');

/**
 * Add a failure pattern
 */
function handleAddFailurePattern(args) {
  const { name, description, signature, provider, severity = 'medium' } = args;

  if (!name || !description || !signature) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name, description, and signature are required');
  }

  const id = `fp-${Date.now()}`;
  validationRules.saveFailurePattern({
    id,
    name,
    description,
    signature,
    provider: provider || null,
    severity
  });

  return {
    content: [{
      type: 'text',
      text: `## Failure Pattern Added\n\n- **ID:** ${id}\n- **Name:** ${name}\n- **Provider:** ${provider || 'all'}\n- **Severity:** ${severity}`
    }]
  };
}

/**
 * Get failure pattern matches for a task
 */
function handleGetFailureMatches(args) {
  const { task_id, pattern_id, limit = 50 } = args;

  if (!task_id) {
    return {
      content: [{
        type: 'text',
        text: `## Failure Matches\n\nPlease specify a task_id to view failure pattern matches.`
      }]
    };
  }

  let matches = validationRules.getFailureMatches(task_id);

  if (pattern_id) {
    matches = matches.filter(m => m.pattern_id === pattern_id);
  }

  if (matches.length > limit) {
    matches = matches.slice(0, limit);
  }

  if (matches.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Failure Matches\n\nNo failure pattern matches found for task ${task_id}.`
      }]
    };
  }

  let output = `## Failure Matches for ${task_id}\n\n`;
  matches.forEach(m => {
    output += `- **Pattern:** ${m.pattern_name} | **Severity:** ${m.severity || 'N/A'}\n`;
    output += `  Matched: ${m.matched_at}\n`;
  });

  return { content: [{ type: 'text', text: output }] };
}

/**
 * List adaptive retry rules
 */
function handleListRetryRules(args) {
  const { enabled_only = true } = args;
  const rules = validationRules.getRetryRules(enabled_only);

  if (rules.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Retry Rules\n\nNo retry rules found.`
      }]
    };
  }

  let output = `## Adaptive Retry Rules\n\n`;
  output += `| Name | Type | Fallback | Max Retries | Enabled |\n`;
  output += `|------|------|----------|-------------|----------|\n`;

  rules.forEach(r => {
    output += `| ${r.name} | ${r.rule_type} | ${r.fallback_provider} | ${r.max_retries} | ${r.enabled ? '\u2713' : '\u2717'} |\n`;
  });

  return { content: [{ type: 'text', text: output }] };
}

/**
 * Add an adaptive retry rule
 */
function handleAddRetryRule(args) {
  const { name, description, rule_type, trigger, fallback_provider = 'claude-cli', max_retries = 1 } = args;

  if (!name || !description || !rule_type || !trigger) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name, description, rule_type, and trigger are required');
  }

  const id = `retry-${Date.now()}`;
  validationRules.saveRetryRule({
    id,
    name,
    description,
    rule_type,
    trigger,
    fallback_provider,
    max_retries
  });

  return {
    content: [{
      type: 'text',
      text: `## Retry Rule Added\n\n- **ID:** ${id}\n- **Name:** ${name}\n- **Type:** ${rule_type}\n- **Fallback:** ${fallback_provider}\n- **Max Retries:** ${max_retries}`
    }]
  };
}

function createValidationFailureHandlers() {
  return {
    handleAddFailurePattern,
    handleGetFailureMatches,
    handleListRetryRules,
    handleAddRetryRule,
  };
}

module.exports = {
  handleAddFailurePattern,
  handleGetFailureMatches,
  handleListRetryRules,
  handleAddRetryRule,
  createValidationFailureHandlers,
};
